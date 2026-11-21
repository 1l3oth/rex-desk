// Worktrees are removed once their branch is merged and nothing in them is unsaved. Used by the desk on a timer (only the
// work folder's own worktrees) and by scripts/tidy-worktrees.mjs (the loose sibling folders made before the work folder).
import { execFile } from 'node:child_process';
import { lstatSync, readdirSync, rmdirSync, unlinkSync, existsSync, statSync, rmSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = async (cwd, args) => (await run('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 2 ** 20 })).stdout.trim();

export async function worktreeList(repository) {
  const items = [];
  let item = null;
  for (const line of (await git(repository, ['worktree', 'list', '--porcelain'])).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { item = { path: path.resolve(line.slice(9)) }; items.push(item); }
    else if (item && line.startsWith('branch ')) item.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (item && line.startsWith('HEAD ')) item.head = line.slice(5);
  }
  return items.slice(1); // the first is the project folder itself
}
// Whether a worktree can go: its branch is merged into base (and has moved past where it started, so a fresh worktree with
// no work yet stays) and nothing is uncommitted, untracked or ignored: ignored files (.env, local data, build output) are
// never in git, so removing the folder would lose them for good.
export async function canRemove(directory, base) {
  if (!existsSync(directory)) return { ok: false, reason: 'the folder is missing' };
  const dirty = await git(directory, ['status', '--porcelain', '--ignored', '--untracked-files=all']).catch(() => null);
  if (dirty === null) return { ok: false, reason: 'not a readable git worktree' };
  if (dirty) return { ok: false, reason: dirty.split(/\r?\n/).every(line => line.startsWith('!!')) ? 'has ignored local files' : 'has uncommitted or untracked files' };
  const head = await git(directory, ['rev-parse', 'HEAD']), tip = await git(directory, ['rev-parse', base]).catch(() => '');
  if (!tip) return { ok: false, reason: `${base} not found` };
  if (head === tip) return { ok: false, reason: `same commit as ${base}, no work merged yet` };
  // A branch nobody committed on (its reflog holds only its creation) is a fresh worktree, even once base moved past it.
  const branch = await git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
  const log = branch === 'HEAD' ? '' : await git(directory, ['reflog', 'show', '--format=%gs', branch]).catch(() => '');
  if (!log.split(/\r?\n/).some(line => /^(commit|merge|cherry-pick|rebase|pull|reset)/.test(line))) return { ok: false, reason: 'no work committed on this branch yet' };
  const merged = await git(directory, ['merge-base', '--is-ancestor', head, base]).then(() => true, () => false);
  return merged ? { ok: true } : { ok: false, reason: `branch not merged into ${base}` };
}
// git worktree remove follows a node_modules junction and deletes the packages it points to: unlink links first.
function unlinkLinks(directory) {
  for (const name of readdirSync(directory)) {
    const item = path.join(directory, name);
    try { if (lstatSync(item).isSymbolicLink()) { try { unlinkSync(item); } catch { rmdirSync(item); } } } catch { /* gone */ }
  }
}
export async function removeWorktree(repository, directory) {
  unlinkLinks(directory);
  await git(repository, ['worktree', 'remove', directory]);
}
// Removes the merged, clean worktrees among `candidates` (worktreeList items); returns what went and what stayed, with why.
// `keep` is asked before the Git checks and again under the lock right before removal, so it must read the live state each time.
// The lock closes the race with an agent starting: the desk marks a run live before it waits for the lock (see waitUnlocked),
// and cleanup takes the lock before its last live check, so one of the two always sees the other.
export async function removeMerged(repository, candidates, { base = 'origin/master', keep = () => false, dryRun = false } = {}) {
  const removed = [], kept = [], busy = 'an agent is still working in it';
  for (const item of candidates) {
    if (await keep(item)) { kept.push({ ...item, reason: busy }); continue; }
    const check = await canRemove(item.path, base);
    if (!check.ok) { kept.push({ ...item, reason: check.reason }); continue; }
    if (dryRun) { if (await keep(item)) kept.push({ ...item, reason: busy }); else removed.push(item); continue; }
    const release = takeLock(item.path);
    if (!release) { kept.push({ ...item, reason: 'another cleanup is removing it' }); continue; }
    try {
      if (await keep(item)) { kept.push({ ...item, reason: busy }); continue; }
      await removeWorktree(repository, item.path); removed.push(item);
    } catch (error) { kept.push({ ...item, reason: String(error.message).split('\n')[0] }); } finally { release(); }
  }
  return { removed, kept };
}
// While a worktree is being removed a marker sits beside it (<folder>.removing, outside the worktree so Git never sees it).
// A marker older than 15 minutes is left from a crash and is cleared.
export const lockFile = directory => `${path.resolve(directory)}.removing`;
const STALE_LOCK_MS = 15 * 60000;
export function takeLock(directory) {
  const file = lockFile(directory);
  try { if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) rmSync(file, { force: true }); } catch { /* no marker */ }
  try { closeSync(openSync(file, 'wx')); return () => rmSync(file, { force: true }); } catch { return null; }
}
// The locked worktree that holds `folder` (the folder itself or one above it), or ''.
export function lockedFolder(folder) {
  for (let current = path.resolve(folder); ;) {
    if (existsSync(lockFile(current))) return current;
    const parent = path.dirname(current); if (parent === current) return ''; current = parent;
  }
}
// An agent about to start in these folders waits while one is being removed; afterwards the folder is either still there
// or gone, and the caller falls back to another folder.
export async function waitUnlocked(folders, { timeoutMs = STALE_LOCK_MS, everyMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  while (folders.some(folder => folder && lockedFolder(folder)) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, everyMs));
}
export const inside = (folder, item) => { const relative = path.relative(path.resolve(folder), path.resolve(item)); return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative); };

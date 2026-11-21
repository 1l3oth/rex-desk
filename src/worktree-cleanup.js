// Worktrees are removed once their branch is merged and nothing in them is unsaved. Used by the desk on a timer (only the
// work folder's own worktrees) and by scripts/tidy-worktrees.mjs (the loose sibling folders made before the work folder).
import { execFile } from 'node:child_process';
import { lstatSync, readdirSync, rmdirSync, unlinkSync, existsSync } from 'node:fs';
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
export async function removeMerged(repository, candidates, { base = 'origin/master', keep = () => false, dryRun = false } = {}) {
  const removed = [], kept = [];
  for (const item of candidates) {
    if (keep(item)) { kept.push({ ...item, reason: 'an agent is still working in it' }); continue; }
    const check = await canRemove(item.path, base);
    if (!check.ok) { kept.push({ ...item, reason: check.reason }); continue; }
    if (dryRun) { removed.push(item); continue; }
    try { await removeWorktree(repository, item.path); removed.push(item); } catch (error) { kept.push({ ...item, reason: String(error.message).split('\n')[0] }); }
  }
  return { removed, kept };
}
export const inside = (folder, item) => { const relative = path.relative(path.resolve(folder), path.resolve(item)); return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative); };

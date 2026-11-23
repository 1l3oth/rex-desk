// Moving an agent to another computer without losing its work (L57). The computer it moves to asks the one it leaves (through
// Rex Desk's shared database, never GitHub) to save the work: uncommitted changes in the agent's own worktree become a WIP
// commit on its own branch, and that branch travels as a git bundle. The new computer unpacks it into a worktree of its own and
// the agent carries on there. Each step is an event in the agent's chat ("move-step": saved, committed, moved, picked-up; or
// failed); when a step fails the agent stays where it is.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { workFolder } from './work-folder.js';
import path from 'node:path';
import { git as runGit, slug } from './processes.js';
import { diffLine } from './runners.js';

// Branches work is never committed on.
const PROTECTED = /^(master|main|develop|trunk|release\/.+|global\/.+)$/i;
export const BUNDLE_LIMIT = 15 * 1024 * 1024;
const same = (left, right) => Boolean(left && right) && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

// On the computer the agent leaves: save its work and pack its branch.
// ownFiles: the files this agent's own chats edited or wrote (their tool events), used only when it has no worktree of its own.
export async function saveWork({ worktree = '', project = '', agentName = 'The agent', to = 'the other computer', ownFiles = [] } = {}, git = runGit) {
  const own = worktree && existsSync(worktree) && !same(worktree, project) ? worktree : '';
  if (!own) return saveShared({ project, agentName, to, ownFiles }, git);
  const branch = await git(own, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = Boolean(await git(own, ['status', '--porcelain']));
  if (dirty && (branch === 'HEAD' || PROTECTED.test(branch))) throw new Error(`${agentName}'s worktree is on ${branch === 'HEAD' ? 'no branch' : branch}, where work is never committed, so its unsaved changes stayed. Put them on a branch of its own first.`);
  if (branch === 'HEAD' || PROTECTED.test(branch)) return { nothing: true, worktree: own };
  let committed = '';
  if (dirty) {
    await git(own, ['add', '-A']);
    await git(own, ['commit', '-m', `WIP: ${agentName} moves to ${to} (saved by Rex Desk)`]);
    committed = await git(own, ['rev-parse', 'HEAD']);
  }
  return { ...await pack(own, branch, agentName, git), committed, worktree: own };
}

// No worktree of its own: the shared project folder is never committed in and its state never changes, since other changes
// there may be someone else's and stay on this computer. Only the changed files this agent itself edited or wrote travel: they
// go into a commit on a branch of its own, built in a separate index, so the folder's files, index and branch stay as they were.
async function saveShared({ project, agentName, to, ownFiles }, git) {
  if (!project || !existsSync(project)) return { nothing: true };
  // Changed tracked files (deleted ones too) and new untracked ones, NUL-separated so odd names stay whole.
  const list = async args => (await git(project, args).catch(() => '')).split(String.fromCharCode(0)).filter(Boolean);
  // The commit sits on the remote's main line, not on this folder's branch, so commits made here by others (not pushed
  // yet) never travel in the bundle. Changes are read against that line too, so the agent's own committed files still go, whole.
  let base = '';
  for (const main of ['origin/HEAD', 'origin/master', 'origin/main']) { base = await git(project, ['merge-base', 'HEAD', main]).catch(() => ''); if (base) break; }
  base ||= 'HEAD';
  const changed = [...new Set([...await list(['diff', '--name-only', '--no-renames', '-z', base]), ...await list(['ls-files', '--others', '--exclude-standard', '-z'])])];
  if (!changed.length) return { nothing: true };
  // ownFiles: names, or { file, lines, complete } with every line the agent's own edits added (+) or removed (-). A file it
  // edited travels only when each changed line in it (against the main line) is one of those: a line someone else added or
  // removed, before or after the agent, means the file holds their work too, so it stays here and the move says so.
  const key = file => path.resolve(project, file).toLowerCase();
  const mine = new Map(ownFiles.map(item => typeof item === 'string' ? { file: item } : item).map(item => [key(String(item.file)), item]));
  const onlyMine = async file => {
    const own = mine.get(key(file)); if (!own.lines) return true;
    if (!own.complete) return false;
    const tracked = Boolean(await git(project, ['ls-files', '--', file]).catch(() => ''));
    let changedLines;
    if (tracked) changedLines = (await git(project, ['diff', '-U0', '--no-color', '--no-ext-diff', base, '--', file]).catch(() => '')).split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
    else { try { changedLines = readFileSync(path.resolve(project, file), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map(line => `+${line}`); } catch { return false; } }
    // No readable line changes (a binary file, a mode change) cannot be checked, so it stays.
    if (!changedLines.length) return false;
    const owned = new Set(own.lines);
    return changedLines.every(line => owned.has(diffLine(line.replace(/\r$/, ''))));
  };
  const files = [], mixed = [];
  for (const file of changed) if (mine.has(key(file))) (await onlyMine(file) ? files : mixed).push(file);
  const others = changed.length - files.length;
  if (!files.length) return { nothing: true, others, ...(mixed.length ? { mixed } : {}) };
  const branch = `rex-handover/${slug(agentName, 40)}`, index = path.join(os.tmpdir(), `rex-handover-${randomUUID()}.index`), env = { GIT_INDEX_FILE: index };
  try {
    await git(project, ['read-tree', base], { env });
    await git(project, ['add', '-A', '--', ...files], { env });
    const tree = await git(project, ['write-tree'], { env });
    const who = await git(project, ['config', 'user.email']).catch(() => '') ? {} : { GIT_AUTHOR_NAME: 'Rex Desk', GIT_AUTHOR_EMAIL: 'desk@rexdesk.invalid', GIT_COMMITTER_NAME: 'Rex Desk', GIT_COMMITTER_EMAIL: 'desk@rexdesk.invalid' };
    const committed = await git(project, ['commit-tree', tree, '-p', base, '-m', `WIP: ${agentName} moves to ${to} (saved by Rex Desk, its own ${files.length === 1 ? 'file' : 'files'} only)`], { env: who });
    await git(project, ['update-ref', `refs/heads/${branch}`, committed]);
    return { ...await pack(project, branch, agentName, git), committed, files, others, ...(mixed.length ? { mixed } : {}) };
  } finally { rmSync(index, { force: true }); }
}

// The branch packed for the other computer: only the commits since it left its remote's main line.
async function pack(cwd, branch, agentName, git) {
  const own = cwd, ref = `refs/heads/${branch}`;
  const head = await git(own, ['rev-parse', ref]);
  let base = '';
  for (const main of ['origin/HEAD', 'origin/master', 'origin/main']) { try { base = await git(own, ['merge-base', ref, main]); if (base) break; } catch { /* no such remote branch */ } }
  if (base === head) return { branch, head, bundle: '' };
  const file = path.join(os.tmpdir(), `rex-handover-${randomUUID()}.bundle`);
  try {
    await git(own, ['bundle', 'create', file, base ? `${base}..${branch}` : branch]);
    const bytes = readFileSync(file);
    if (bytes.length > BUNDLE_LIMIT) throw new Error(`${agentName}'s branch ${branch} is ${Math.round(bytes.length / 1048576)} MB to carry over, more than ${BUNDLE_LIMIT / 1048576} MB, so it stayed. Push it, then move the agent.`);
    return { branch, head, base, bundle: bytes.toString('base64') };
  } finally { rmSync(file, { force: true }); }
}

// On the computer the agent moves to: unpack the branch into a worktree of the agent's own, before anything is moved.
export async function pickUp({ project, branch, head = '', bundle = '', directory }, git = runGit) {
  if (!branch) return {};
  if (!project || !existsSync(project)) throw new Error('The project is not on this computer, so the work could not be picked up.');
  let source = head;
  if (bundle) {
    const file = path.join(os.tmpdir(), `rex-handover-${randomUUID()}.bundle`); writeFileSync(file, Buffer.from(bundle, 'base64'));
    try { await git(project, ['bundle', 'verify', file]); await git(project, ['fetch', '--no-tags', file, `+refs/heads/${branch}:refs/rex-handover/${branch}`]); source = `refs/rex-handover/${branch}`; }
    catch (error) { throw new Error(`The work on ${branch} could not be unpacked here: ${String(error.message || error).split('\n')[0].slice(0, 200)}`); }
    finally { rmSync(file, { force: true }); }
  } else {
    try { await git(project, ['cat-file', '-e', `${head}^{commit}`]); } catch { throw new Error(`Branch ${branch} is not on this computer yet (its last commit ${head.slice(0, 8)} is missing). Fetch it, then move the agent.`); }
  }
  if (existsSync(directory)) {
    if (await git(directory, ['status', '--porcelain']).catch(() => 'x')) throw new Error(`The worktree ${directory} already has changes here, so the moved work was not put over them.`);
    await git(directory, ['checkout', '-B', branch, source]);
  } else {
    mkdirSync(path.dirname(directory), { recursive: true });
    await git(project, ['worktree', 'add', '-B', branch, directory, source]);
  }
  return { worktree: directory, branch, head: await git(directory, ['rev-parse', 'HEAD']) };
}

export class Handover {
  constructor(desk) { this.desk = desk; this.store = desk.store; }
  // Asked by the other computer (a "handover-save" command): save this agent's work here and leave it in the shared database.
  async serve(command) {
    const desk = this.desk, agent = desk.specialists.get(command.agentId), run = agent.runId ? this.store.get('run', agent.runId) : null;
    if (run && ['starting', 'running', 'queued', 'verifying'].includes(run.state)) throw new Error(`${agent.name} is still working here.`);
    const saved = await saveWork({ worktree: run?.worktree || '', project: desk.specialists.folder(agent) || run?.projectPath || '', agentName: agent.name, to: command.input?.to || 'the other computer', ownFiles: this.ownFiles(agent) });
    const { worktree, ...shared } = saved;
    this.store.put('handover', command.id, { id: command.id, agentId: agent.id, ...shared, from: worktree || '', at: new Date().toISOString() });
    return { saved: true };
  }
  // On the computer the agent moves to: ask the one it is on to save its work, and wait for the answer.
  async request(agent, { to, timeout = 120000 } = {}) {
    const peers = this.desk.peers, id = randomUUID();
    this.store.put('peercmd', id, { id, target: agent.node, action: 'handover-save', agentId: agent.id, input: { to }, at: new Date().toISOString(), done: false });
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const command = this.store.get('peercmd', id), saved = this.store.get('handover', id);
      if (command?.done && command.error) throw new Error(`${peers.deviceName(agent.node)} could not save ${agent.name}'s work: ${command.error}`);
      if (saved) { this.store.delete('handover', id); return saved; }
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    throw new Error(`${peers.deviceName(agent.node)} did not answer in time, so ${agent.name}'s work was not saved and it stayed there.`);
  }
  // The files this agent's own chats (personal and room sessions) edited or wrote here, from their tool events.
  ownFiles(agent) {
    const files = new Map();
    for (const runId of [agent.runId, ...Object.values(agent.roomRuns || {})].filter(Boolean)) {
      for (const event of this.store.events(runId, { limit: 100000 })) {
        const change = event.kind === 'agent-tool' ? event.change : null; if (!change?.file) continue;
        const file = String(change.file), own = files.get(file) || { file, lines: [], complete: true };
        // A secret file or a cut-off diff leaves lines unknown, so that file cannot be shown to be the agent's alone.
        if (change.hidden || change.more || !Array.isArray(change.diff)) own.complete = false;
        else own.lines.push(...change.diff.filter(line => /^[+-]/.test(line)));
        files.set(file, own);
      }
    }
    return [...files.values()];
  }
  pickUp(input) { return pickUp(input); }
  directoryFor(agent, branch, project = '') { return path.join(workFolder(project, this.store.directory, this.store.config?.().repositories || []), 'worktrees', `${slug(agent.slug || agent.name, 40)}-${slug(branch, 60)}`); }
}

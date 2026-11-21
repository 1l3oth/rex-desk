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

// Branches work is never committed on.
const PROTECTED = /^(master|main|develop|trunk|release\/.+|global\/.+)$/i;
export const BUNDLE_LIMIT = 15 * 1024 * 1024;
const same = (left, right) => Boolean(left && right) && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

// On the computer the agent leaves: save its work and pack its branch.
export async function saveWork({ worktree = '', project = '', agentName = 'The agent', to = 'the other computer' } = {}, git = runGit) {
  const own = worktree && existsSync(worktree) && !same(worktree, project) ? worktree : '';
  if (!own) {
    // No worktree of its own: the shared project folder is never committed in (the changes there may be someone else's).
    if (project && existsSync(project) && await git(project, ['status', '--porcelain']).catch(() => '')) throw new Error(`${agentName} has no worktree of its own, and the project folder ${project} has changes that may be someone else's, so nothing was committed. Commit or set them aside there first.`);
    return { nothing: true };
  }
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
  const head = await git(own, ['rev-parse', 'HEAD']);
  // Only what the other computer may not have yet: the commits since the branch left its remote's main line.
  let base = '';
  for (const ref of ['origin/HEAD', 'origin/master', 'origin/main']) { try { base = await git(own, ['merge-base', 'HEAD', ref]); if (base) break; } catch { /* no such remote branch */ } }
  if (base === head) return { branch, head, committed, bundle: '', worktree: own };
  const file = path.join(os.tmpdir(), `rex-handover-${randomUUID()}.bundle`);
  try {
    await git(own, ['bundle', 'create', file, base ? `${base}..${branch}` : branch]);
    const bytes = readFileSync(file);
    if (bytes.length > BUNDLE_LIMIT) throw new Error(`${agentName}'s branch ${branch} is ${Math.round(bytes.length / 1048576)} MB to carry over, more than ${BUNDLE_LIMIT / 1048576} MB, so it stayed. Push it, then move the agent.`);
    return { branch, head, committed, base, bundle: bytes.toString('base64'), worktree: own };
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
    const saved = await saveWork({ worktree: run?.worktree || '', project: desk.specialists.folder(agent) || run?.projectPath || '', agentName: agent.name, to: command.input?.to || 'the other computer' });
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
  pickUp(input) { return pickUp(input); }
  directoryFor(agent, branch, project = '') { return path.join(workFolder(project, this.store.directory), 'worktrees', `${slug(agent.slug || agent.name, 40)}-${slug(branch, 60)}`); }
}

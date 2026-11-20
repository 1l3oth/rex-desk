import path from 'node:path';
import { existsSync } from 'node:fs';
import { now } from './store.js';

// Two rules a person sets on a project, for every agent in it:
//   pinned:  "Runs only on this computer". Its agents never move to another computer and never start a session elsewhere.
//            The person still chats with them from any computer: the message travels to the agent's computer.
//   noCloud: "Keep out of the cloud". Their chats, runs, evidence and files are not written to the cloud database; they travel
//            only straight between the person's computers. Turning it on deletes what the cloud already holds; turning it
//            off sends everything back up.
// The rules ride on each agent's card, which every computer shares, so all of them follow the same rule. A new agent takes
// the rules of the agents already in its project.
const WORKING = ['starting', 'running', 'queued', 'waiting', 'verifying'];

export class ProjectRules {
  constructor(desk) { this.desk = desk; this.store = desk.store; }
  agents(slug) { const name = String(slug || '').toLowerCase(); return this.store.list('specialist').filter(agent => agent.kind !== 'main' && String(agent.projectSlug || '').toLowerCase() === name); }
  of(slug) { const agents = this.agents(slug); return { pinned: agents.some(agent => agent.pinned), noCloud: agents.some(agent => agent.noCloud) }; }
  // Every project that has agents, with its rules and the computers its agents work on.
  list() {
    const peers = this.desk.peers, found = new Map();
    for (const agent of this.store.list('specialist')) {
      if (agent.kind === 'main' || !agent.projectSlug) continue;
      const item = found.get(agent.projectSlug) || { slug: agent.projectSlug, agents: 0, pinned: false, noCloud: false, computers: [] };
      item.agents += 1; item.pinned ||= Boolean(agent.pinned); item.noCloud ||= Boolean(agent.noCloud);
      const computer = peers.deviceName(agent.node); if (!item.computers.includes(computer)) item.computers.push(computer);
      found.set(agent.projectSlug, item);
    }
    return [...found.values()].map(item => ({ ...item, here: Boolean(this.folderHere(item.slug)) })).sort((left, right) => left.slug.localeCompare(right.slug));
  }
  // The project's folder on this computer, or '' when the project is not here.
  folderHere(slug) {
    const project = this.desk.memory.list().find(item => item.slug === String(slug || '').toLowerCase());
    return project?.path && existsSync(project.path) ? project.path : '';
  }
  set(slug, { pinned, noCloud } = {}) {
    const agents = this.agents(slug);
    if (!agents.length) throw new Error(`No agents in the project "${slug}" yet. Create one first.`);
    const before = this.of(slug), next = { pinned: pinned === undefined ? before.pinned : Boolean(pinned), noCloud: noCloud === undefined ? before.noCloud : Boolean(noCloud) };
    for (const agent of agents) if (Boolean(agent.pinned) !== next.pinned || Boolean(agent.noCloud) !== next.noCloud) this.store.put('specialist', agent.id, { ...agent, pinned: next.pinned, noCloud: next.noCloud, updatedAt: now() });
    this.sweep();
    return { slug, ...next, agents: agents.length };
  }
  // A new agent in a project takes the project's rules.
  inherit(agent) {
    const rules = this.of(agent.projectSlug);
    if (!rules.pinned && !rules.noCloud) return agent;
    return this.store.put('specialist', agent.id, { ...agent, pinned: rules.pinned, noCloud: rules.noCloud });
  }
  // Every computer keeps its own cloud copy in line with the rule on each agent: deleted when the rule turned on, sent back
  // when it turned off. What was done is remembered per agent, so it happens once.
  sweep() {
    // An agent that moved to another computer (Follow me) stops here: only one computer runs it, and its chat goes on there.
    for (const agent of this.store.list('specialist')) {
      if (agent.kind === 'main' || !agent.runId || !this.desk.peers.isRemote(agent) || !this.desk.live?.has(agent.runId)) continue;
      const to = this.desk.peers.deviceName(agent.node);
      void this.desk.stop(agent.runId).then(() => this.store.event(agent.runId, 'notice', { text: `${agent.name} moved to ${to} and carries on there in this same chat.` }, true)).catch(() => {});
    }
    const cloud = this.store.cloud; if (!cloud?.enabled) return;
    for (const agent of this.store.list('specialist')) {
      if (agent.kind === 'main') continue;
      const done = this.store.get('cloudkept', agent.id);
      if (agent.noCloud && !done) { const result = cloud.forget(agent.id); this.store.put('cloudkept', agent.id, { id: agent.id, at: now(), removed: result.removed }); }
      else if (!agent.noCloud && done) { this.store.delete('cloudkept', agent.id); cloud.restoreAgent(agent.id); }
    }
  }
  watch() {
    if (this.watching) return; this.watching = true;
    let timer = null;
    this.store.on?.('change', event => {
      if (event.kind !== 'specialist' || timer) return;
      timer = setTimeout(() => { timer = null; try { this.sweep(); } catch { /* the next change tries again */ } }, 1500); timer.unref?.();
    });
    try { this.sweep(); } catch { /* the cloud is not ready yet */ }
  }
  // Whether an agent may start a session on this computer: its project is not held on another computer, and its folder is here.
  guard(agent) {
    if (!agent || agent.kind === 'main') return;
    if (agent.pinned && this.desk.peers.isRemote(agent)) throw new Error(`${agent.name}'s project (${agent.projectSlug}) runs only on ${this.desk.peers.deviceName(agent.node)}. Your message is sent there when that computer is on.`);
    if (this.desk.peers.isRemote(agent)) return;
    const folder = this.desk.specialists.folder(agent);
    if (agent.projectPath && !folder) throw new Error(`${agent.name}'s project (${agent.projectSlug || agent.projectPath}) is not on this computer, so it cannot work here. Add its folder in Settings, Projects.`);
  }
  // Move an agent from another computer to this one. Its personal chat comes along: the messages this computer has of it become
  // the chat here, and the agent starts a fresh session that first reads a handoff of that chat (an AI session cannot travel).
  async move(agentId, { wait = 180000 } = {}) {
    const desk = this.desk, peers = desk.peers, agent = desk.specialists.get(agentId);
    if (agent.kind === 'main') throw new Error('Every computer has its own Rex Agent.');
    if (!peers.isRemote(agent)) throw new Error(`${agent.name} already works on this computer.`);
    const from = peers.deviceName(agent.node);
    if (agent.pinned) throw new Error(`${agent.name}'s project (${agent.projectSlug}) is set to run only on ${from}. Turn that off in Settings, Projects first.`);
    const folder = agent.projectSlug ? this.folderHere(agent.projectSlug) : '';
    if (agent.projectSlug && !folder) throw new Error(`The project "${agent.projectSlug}" is not on this computer. Add its folder in Settings, Projects, then move ${agent.name}.`);
    const runId = agent.runId || '';
    // Each step shows in the agent's chat as it happens (the profile's chips read them): saved, committed, moved, picked up.
    // Steps before the chat is here wait until it is (so they come after its earlier messages); a failure is written at once.
    const steps = [], write = (name, text, extra) => this.store.event(runId, 'move-step', { step: name, text, agentId: agent.id, from, to: peers.self.name, ...extra }, true);
    let arrived = false;
    const step = (name, text, extra = {}) => { if (!runId) return; if (arrived || name === 'failed') write(name, text, extra); else steps.push([name, text, extra]); };
    // 1. A reply in progress on the other computer is waited for (up to `wait`), not cut off.
    const until = Date.now() + wait;
    while (['busy', 'replying', 'waiting'].includes(peers.statusOf(this.store.get('specialist', agent.id) || agent).state)) {
      if (Date.now() > until) { step('failed', `${agent.name} is still working on ${from}, so it stayed there.`); throw new Error(`${agent.name} is working on ${from} right now. Move it when it is done.`); }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // 2. Its work is saved there first (a WIP commit on its own branch, packed for this computer). A computer that is off cannot
    // save anything: the agent still moves, and the chat says plainly that the unsaved work stays there until it is back.
    let saved = { nothing: true }, picked = {};
    try {
      if (peers.online(agent.node)) {
        saved = await desk.handover.request(agent, { to: peers.self.name });
        step('saved', saved.branch ? `Work saved on ${from}.` : `Nothing unsaved on ${from}.`);
        if (saved.committed) step('committed', `Uncommitted changes committed on ${saved.branch} (WIP).`, { branch: saved.branch, commit: saved.committed });
      } else step('saved', `${from} is off, so work not committed there stays on it until it is back.`, { skipped: true });
      // 3. The branch is unpacked here into a worktree of the agent's own before anything moves, so a failure leaves it where it was.
      if (saved.branch) picked = await desk.handover.pickUp({ project: folder, branch: saved.branch, head: saved.head, bundle: saved.bundle, directory: desk.handover.directoryFor(agent, saved.branch) });
    } catch (error) {
      const why = String(error.message || error).split('\n')[0];
      step('failed', `${agent.name} stayed on ${from}: ${why}`);
      throw new Error(why);
    }
    const repository = this.store.config().repositories.find(item => path.resolve(item.path).toLowerCase() === path.resolve(folder).toLowerCase());
    const copy = runId ? this.store.get('chatcopy', runId) : null, local = runId ? this.store.get('run', runId) : null;
    let carried = 0;
    if (local && WORKING.includes(local.state)) throw new Error(`${agent.name} is still working in its chat here. Stop it first.`);
    if (copy?.run && copy.node !== peers.self.id) {
      // Only what this computer does not have yet is added: nothing when the chat is new here, the newer part when it was here before.
      const last = local ? this.store.events(runId, { visible: true, limit: 1 }).at(-1)?.createdAt || '' : '';
      const events = (copy.events || []).filter(event => !last || String(event.createdAt || '') > last);
      const { remote, cloudCopy, host, reattach, queued, ...kept } = copy.run;
      this.store.put('run', runId, { ...(local || {}), ...kept, state: 'finished', endedAt: kept.endedAt || now(), cwd: desk.specialists.homeDirectory(agent), projectPath: folder, repositoryId: repository?.id || '', worktree: local?.worktree || '', error: '' });
      if (events.length) this.store.importEvents(runId, events);
      carried = events.length;
    }
    const moved = this.store.put('specialist', agent.id, { ...this.store.get('specialist', agent.id), node: peers.self.id, projectPath: folder, repositoryId: repository?.id || '', roomRuns: {}, movedAt: now(), movedFrom: agent.node });
    if (this.store.get('run', runId)) await desk.freshStart(runId, { reason: `because ${agent.name} moved here from ${from}`, notice: `${agent.name} moved here from ${from}. It starts a fresh session with your next message and reads a handoff of this chat first.` });
    arrived = true; for (const [name, text, extra] of steps.splice(0)) write(name, text, extra);
    step('moved', `${agent.name} moved here from ${from}.`);
    // 4. It carries on in the worktree its work came in.
    if (picked.worktree && this.store.get('run', runId)) {
      this.store.put('run', runId, { ...this.store.get('run', runId), worktree: picked.worktree, branch: picked.branch });
      step('picked-up', `Carrying on in ${picked.worktree} on ${picked.branch}.`, { worktree: picked.worktree, branch: picked.branch });
    } else step('picked-up', saved.branch ? `Carrying on on ${saved.branch}.` : `${agent.name} carries on here.`);
    return { moved: true, agent: moved.name, from, to: peers.self.name, folder, messages: carried, chat: Boolean(this.store.get('run', runId)), branch: picked.branch || saved.branch || '', worktree: picked.worktree || '' };
  }
}

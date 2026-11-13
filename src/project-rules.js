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
    const folder = agent.projectPath || '';
    if (folder && !existsSync(folder)) throw new Error(`${agent.name}'s project folder (${folder}) is not on this computer, so it cannot work here.${this.folderHere(agent.projectSlug) ? ' Use "Move to this computer" on its card to point it at the folder here.' : ''}`);
  }
  // Move an agent from another computer to this one. Its personal chat comes along: the messages this computer has of it become
  // the chat here, and the agent starts a fresh session that first reads a handoff of that chat (an AI session cannot travel).
  async move(agentId) {
    const desk = this.desk, peers = desk.peers, agent = desk.specialists.get(agentId);
    if (agent.kind === 'main') throw new Error('Every computer has its own Rex Agent.');
    if (!peers.isRemote(agent)) throw new Error(`${agent.name} already works on this computer.`);
    const from = peers.deviceName(agent.node);
    if (agent.pinned) throw new Error(`${agent.name}'s project (${agent.projectSlug}) is set to run only on ${from}. Turn that off in Settings, Projects first.`);
    const folder = this.folderHere(agent.projectSlug);
    if (!folder) throw new Error(`The project "${agent.projectSlug}" is not on this computer. Add its folder in Settings, Projects, then move ${agent.name}.`);
    const status = peers.statusOf(agent);
    if (['busy', 'replying', 'waiting'].includes(status.state)) throw new Error(`${agent.name} is working on ${from} right now. Move it when it is done.`);
    const repository = this.store.config().repositories.find(item => path.resolve(item.path).toLowerCase() === path.resolve(folder).toLowerCase());
    const runId = agent.runId || '', copy = runId ? this.store.get('chatcopy', runId) : null, local = runId ? this.store.get('run', runId) : null;
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
    return { moved: true, agent: moved.name, from, to: peers.self.name, folder, messages: carried, chat: Boolean(this.store.get('run', runId)) };
  }
}

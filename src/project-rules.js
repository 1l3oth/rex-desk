import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { now, keepLines } from './store.js';

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
    try { this.recoverSends(); } catch { /* tried at the next start */ }
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
    // The same steps live on the agent's own record too (shared with every computer), for the profile's chips (L57 UI):
    // move = { id, from, to, state: running | done | failed, steps: { saved, committed, moved, pickedUp } (true once done), error (one line, when failed), at (last change) }.
    const moveId = randomUUID(), keys = { saved: 'saved', committed: 'committed', moved: 'moved', 'picked-up': 'pickedUp' };
    const mark = (name, text) => {
      const current = this.store.get('specialist', agent.id); if (!current) return;
      const move = current.move?.id === moveId ? current.move : { id: moveId, from: agent.node, to: peers.self.id, state: 'running', steps: { saved: false, committed: false, moved: false, pickedUp: false }, error: '', at: now() };
      const next = { ...move, at: now(), steps: { ...move.steps, ...(keys[name] ? { [keys[name]]: true } : {}) }, ...(name === 'failed' ? { state: 'failed', error: text } : name === 'picked-up' ? { state: 'done' } : {}) };
      this.store.put('specialist', agent.id, { ...current, move: next });
    };
    mark('start');
    const step = (name, text, extra = {}) => { mark(name, text); if (!runId) return; if (arrived || name === 'failed') write(name, text, extra); else steps.push([name, text, extra]); };
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
        // Changes in the shared folder that are not this agent's never block the move; they stay where they are.
        if (saved.others) step('saved', saved.others === 1 ? `1 other change in the folder stays on ${from}, untouched.` : `${saved.others} other changes in the folder stay on ${from}, untouched.`, { others: saved.others });
        if (saved.mixed?.length) step('saved', `${saved.mixed.length === 1 ? '1 file' : `${saved.mixed.length} files`} ${agent.name} edited also ${saved.mixed.length === 1 ? 'holds' : 'hold'} someone else's changes, so ${saved.mixed.length === 1 ? 'it stays' : 'they stay'} on ${from}: ${saved.mixed.join(', ')}.`, { mixed: saved.mixed });
        if (saved.committed) step('committed', `Uncommitted changes committed on ${saved.branch} (WIP).`, { branch: saved.branch, commit: saved.committed });
      } else step('saved', `${from} is off, so work not committed there stays on it until it is back.`, { skipped: true });
      // 3. The branch is unpacked here into a worktree of the agent's own before anything moves, so a failure leaves it where it was.
      if (saved.branch) picked = await desk.handover.pickUp({ project: folder, branch: saved.branch, head: saved.head, bundle: saved.bundle, directory: desk.handover.directoryFor(agent, saved.branch, folder) });
    } catch (error) {
      const why = String(error.message || error).split('\n')[0];
      step('failed', `${agent.name} stayed on ${from}: ${why}`);
      throw new Error(why);
    }
    const repository = this.store.config().repositories.find(item => path.resolve(item.path).toLowerCase() === path.resolve(folder).toLowerCase());
    const copy = runId ? this.store.get('chatcopy', runId) : null, local = runId ? this.store.get('run', runId) : null;
    let carried = 0;
    if (local && WORKING.includes(local.state)) { step('failed', `${agent.name} is still working in its chat here.`); throw new Error(`${agent.name} is still working in its chat here. Stop it first.`); }
    if (copy?.run && copy.node !== peers.self.id) {
      // Only what this computer does not have yet is added: nothing when the chat is new here, the newer part when it was here before.
      // (A message saved here while the move ran, sendHere below, is newer than the copy's part and does not count.)
      const last = local ? this.store.events(runId, { visible: true, limit: 20 }).filter(event => !event.moving).at(-1)?.createdAt || '' : '';
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
  // The person writes to an agent that moves here first (L114). The message is saved and shown at once; the move, which can
  // wait minutes on the other computer and the cloud, runs after it, and the message goes to the agent when the move is done
  // (or to the other computer when the move fails). Messages sent meanwhile wait in order behind the same move, so the agent
  // moves once and starts once, and none is lost. Each one is kept on this computer (movesend) until it is passed on, so a
  // Rex Desk that closes during the move passes it on when it opens again (recoverSends), once.
  sendHere(runId, agent, action, input = {}) {
    const store = this.store, text = String((action === 'say' ? input.text : input.prompt) || '').trim();
    if (!text) throw new Error('Write a message first.');
    store.event(runId, 'human-message', { text: keepLines(text), via: input.voice ? 'voice' : 'rex', moving: true }, true);
    const shown = store.db.prepare('SELECT uid, kind, visible, value, created_at FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT 1').get(runId);
    const id = randomUUID(), pending = { id, runId, agentId: agent.id, action, input, text, shown: shown ? { ...shown } : null, at: now(), order: Date.now() * 1000 + ((this.sent = ((this.sent || 0) + 1) % 1000)) };
    store.put('movesend', id, pending);
    this.queueSend(pending);
    return { queued: true, moving: true };
  }
  // One kept message waits behind its agent's move (one move per agent), then goes to the agent. Its record goes in the same
  // step as it is passed on, so it is passed on once: never again after a restart.
  queueSend(pending) {
    const store = this.store, agentId = pending.agentId;
    this.moving ||= new Map();
    const agent = store.get('specialist', agentId);
    const before = this.moving.get(agentId) || (agent && this.desk.peers.isRemote(agent) ? this.move(agentId).catch(error => ({ failed: String(error.message || error) })) : Promise.resolve());
    const after = before.then(() => {
      if (!store.get('movesend', pending.id)) return null;
      store.delete('movesend', pending.id);
      return this.deliver(pending.runId, agentId, pending.action, pending.input || {}, pending.text, pending.shown);
    }).catch(error => { store.event(pending.runId, 'error', { message: error.message }, true); });
    this.moving.set(agentId, after);
    void after.finally(() => { if (this.moving.get(agentId) === after) this.moving.delete(agentId); });
    return after;
  }
  // Messages kept when Rex Desk closed during a move: passed on now, oldest first, behind a move when the agent is still away.
  recoverSends() {
    if (this.recovered) return; this.recovered = true;
    const waiting = this.store.list('movesend').sort((left, right) => (left.order || 0) - (right.order || 0) || String(left.at).localeCompare(String(right.at)));
    for (const pending of waiting) {
      if (!this.store.get('specialist', pending.agentId)) { this.store.delete('movesend', pending.id); continue; }
      void this.queueSend(pending);
    }
  }
  // Whether an agent is on its way here (a message to it waits for the move).
  movingHere(agentId) { return Boolean(this.moving?.has(agentId)); }
  async deliver(runId, agentId, action, input, text, shown) {
    const desk = this.desk, peers = desk.peers, agent = this.store.get('specialist', agentId), run = this.store.get('run', runId);
    const picked = { model: input.model, effort: input.effort, permissionMode: input.permissionMode, provider: input.provider, voice: input.voice };
    // Still on the other computer (the move failed or was refused): the message goes there, shown here once already.
    if (!run || peers.isRemote(agent)) return peers.chatAction({ id: runId, node: agent?.node || peers.chatCopy(runId)?.node, agentId }, action, input, { shown });
    if (desk.live.has(runId) || WORKING.includes(run.state)) return desk.say(runId, text, { ...picked, echoed: true });
    return desk.resume(runId, { ...picked, prompt: text, silent: true });
  }
}

// One person, many computers. Each computer runs its own Rex Desk and is the workspace of its own agents: their projects,
// worktrees and sessions stay there. Rooms, messages, agent cards, what the agents learned, and commands for an agent on
// another computer are copied between the person's computers over their private network (Tailscale), so every computer
// and the phone shows the same chats. A computer that is off only takes its own agents offline; messages for them wait.
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { HUMAN } from './rooms.js';

const now = () => new Date().toISOString();
const ONLINE_MS = 15000, CLOUD_MS = 90000, PAGE = 400, QUEUE_DAYS = 7, COPY_EVENTS = 400, COPY_KEEP = 160, COPY_TEXT = 6000, COPY_TOOL = 1500, REPEAT_MS = 10 * 60000;
// Tailscale gives every device an address in 100.64.0.0/10.
export const tailscaleAddresses = (interfaces = os.networkInterfaces()) => Object.values(interfaces).flat().filter(item => item && item.family === 'IPv4' && !item.internal)
  .map(item => item.address).filter(address => { const [first, second] = address.split('.').map(Number); return first === 100 && second >= 64 && second <= 127; });
const same = (left, right) => { const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || '')); return a.length === b.length && a.length > 0 && timingSafeEqual(a, b); };
const cleanUrl = value => { const text = String(value || '').trim().replace(/\/+$/, ''); const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`); if (!url.port) url.port = '4317'; return `${url.protocol}//${url.host}`; };

export class Peers {
  constructor(desk, { transport } = {}) {
    this.desk = desk; this.store = desk.store; this.live = new Map(); this.timers = new Map(); this.notes = new Map();
    this.transport = transport || ((peer, method, route, data) => this.http(peer, method, route, data));
  }
  get self() { return { id: this.store.nodeId, name: this.settings().name || os.hostname() }; }
  settings() { return this.store.get('peers', 'main') || { name: '', remote: false, peers: [], cursors: {}, files: {} }; }
  save(patch) { return this.store.put('peers', 'main', { ...this.settings(), ...patch }); }
  key() {
    let sealed = this.store.get('secret', 'peer-key');
    if (!sealed) { sealed = this.store.encrypt(randomBytes(24).toString('base64url')); this.store.put('secret', 'peer-key', sealed); }
    return this.store.decrypt(sealed);
  }
  checkKey(value) { return same(value, this.key()); }
  session() { return createHmac('sha256', this.key()).update('rex-desk-session').digest('base64url'); }
  checkSession(cookie) { const value = /(?:^|;\s*)rexdesk=([^;]+)/.exec(String(cookie || ''))?.[1]; return same(value, this.session()); }
  addresses(port) { return tailscaleAddresses().map(address => `http://${address}:${port}`); }

  // ---------- what the screen shows ----------
  byNode(nodeId) { return this.settings().peers.find(peer => peer.id === nodeId); }
  // Reached directly over Tailscale.
  direct(nodeId) { const live = this.live.get(nodeId); return Boolean(live && Date.now() - live.at < ONLINE_MS); }
  // On: reached directly, or it said so in the shared Turso database in the last 90 seconds.
  seen(nodeId) { const seen = this.cloudSeen?.get(nodeId); return Boolean(seen && Date.now() - seen.at < CLOUD_MS); }
  online(nodeId) { return this.direct(nodeId) || this.seen(nodeId); }
  deviceName(nodeId) { if (!nodeId || nodeId === this.self.id) return this.self.name; return this.byNode(nodeId)?.name || this.cloudSeen?.get(nodeId)?.name || 'another computer'; }
  isRemote(agent) { return Boolean(agent && agent.kind !== 'main' && agent.node && agent.node !== this.self.id); }
  statusOf(agent) {
    if (this.direct(agent.node)) return this.live.get(agent.node).agents?.[agent.id] || { state: 'idle', label: 'Idle' };
    if (this.seen(agent.node)) return this.cloudSeen.get(agent.node).agents?.[agent.id] || { state: 'idle', label: 'Idle' };
    return { state: 'offline', label: this.cloudSeen?.has(agent.node) || this.byNode(agent.node) ? `Offline · ${this.deviceName(agent.node)} is off` : `Offline · ${this.deviceName(agent.node)} has not checked in` };
  }
  // Runs and questions of agents on the other computers, shown as if they were here.
  remoteRuns() { return [...this.live].filter(([node]) => this.direct(node)).flatMap(([node, live]) => (live.runs || []).map(run => ({ ...run, remote: node }))); }
  remoteInteractions() { return [...this.live].filter(([node]) => this.direct(node)).flatMap(([node, live]) => (live.interactions || []).map(item => ({ ...item, remote: node }))); }
  runOwner(runId) { return [...this.live].find(([, live]) => (live.runs || []).some(run => run.id === runId))?.[0] || ''; }
  interactionOwner(id) { return [...this.live].find(([, live]) => (live.interactions || []).some(item => item.id === id))?.[0] || ''; }
  status(port) {
    const settings = this.settings();
    return { self: { ...this.self, addresses: port ? this.addresses(port) : [] }, remote: Boolean(settings.remote), key: this.key(), tailscale: tailscaleAddresses().length > 0,
      peers: [...settings.peers.map(peer => ({ id: peer.id, name: peer.name, url: peer.url, online: this.online(peer.id), via: this.direct(peer.id) ? 'tailscale' : this.seen(peer.id) ? 'turso' : '', lastSeen: this.live.get(peer.id)?.at ? new Date(this.live.get(peer.id).at).toISOString() : peer.lastSeen || '', error: peer.error || '' })),
        ...[...(this.cloudSeen || new Map()).values()].filter(row => !settings.peers.some(peer => peer.id === row.node)).map(row => ({ id: row.node, name: row.name, url: 'through Turso', online: this.seen(row.node), via: 'turso', lastSeen: new Date(row.at).toISOString(), error: '' }))] };
  }

  // ---------- settings the person changes ----------
  rename(name) { const text = String(name || '').trim().slice(0, 40); if (!text) throw new Error('Name this computer.'); this.save({ name: text }); return this.status(); }
  setRemote(on) { this.save({ remote: Boolean(on) }); this.onRemoteChange?.(); return this.status(); }
  // Every computer of the person uses the same key. Joining copies the key from the first computer.
  join(key) { const text = String(key || '').trim(); if (text.length < 16) throw new Error('Paste the whole key from your other computer.'); this.store.put('secret', 'peer-key', this.store.encrypt(text)); return this.status(); }
  async add(url) {
    const target = cleanUrl(url), peer = { id: '', name: '', url: target };
    const answer = await this.transport(peer, 'GET', '/api/peer/hello');
    if (answer.id === this.self.id) throw new Error('That address is this computer.');
    this.remember({ id: answer.id, name: answer.name, url: target }); void this.pullFrom(this.byNode(answer.id)).catch(() => {});
    return this.status();
  }
  remove(nodeId) { this.save({ peers: this.settings().peers.filter(peer => peer.id !== nodeId) }); this.live.delete(nodeId); return this.status(); }
  remember({ id, name, url }) {
    if (!id || id === this.self.id) return;
    const peers = this.settings().peers, known = peers.find(peer => peer.id === id);
    if (known && known.url === url && (!name || known.name === name)) return;
    this.save({ peers: known ? peers.map(peer => peer.id === id ? { ...peer, url: url || peer.url, name: name || peer.name } : peer) : [...peers, { id, name: name || 'Computer', url }] });
  }

  // ---------- the copy that goes out ----------
  // Changed records since a cursor, plus what is happening right now on this computer, and the shared memory files.
  serve({ since = 0, filesSince = 0 } = {}) {
    const max = Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS max FROM changes').get().max);
    const from = Number(since) > max ? 0 : Number(since) || 0;
    const rows = this.store.db.prepare('SELECT seq, kind, id, deleted FROM changes WHERE seq > ? ORDER BY seq LIMIT ?').all(from, PAGE);
    const changes = rows.map(row => ({ kind: row.kind, id: row.id, deleted: Boolean(row.deleted), value: row.deleted ? null : this.store.get(row.kind, row.id) })).filter(item => item.deleted || item.value);
    return { node: this.self, cursor: rows.length ? rows.at(-1).seq : from, more: rows.length === PAGE, changes, live: this.liveNow(), ...this.filesSince(Number(filesSince) || 0) };
  }
  liveNow() {
    const mine = this.desk.specialists.list().filter(agent => !this.isRemote(agent)), ids = new Set(mine.map(agent => agent.id));
    const runs = this.store.list('run').filter(run => ids.has(run.specialistId) || ids.has(run.roomAgent)).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 60);
    const runIds = new Set(runs.map(run => run.id));
    return { agents: Object.fromEntries(mine.map(agent => [agent.id, this.desk.specialists.status(agent)])), runs,
      interactions: this.store.list('interaction').filter(item => item.state === 'pending' && runIds.has(item.runId)) };
  }
  // What the agents learned about the person and how each project is worked on, shared by every computer.
  sharedFiles() {
    const memory = this.desk.memory, names = ['user.md', 'chat-style.md'];
    try { for (const name of readdirSync(memory.file('workflows'))) if (name.endsWith('.md')) names.push(`workflows/${name}`); } catch { /* none yet */ }
    return names;
  }
  filesSince(since) {
    const files = [];
    let cursor = since;
    for (const name of this.sharedFiles()) {
      const file = this.desk.memory.file(...name.split('/'));
      if (!existsSync(file)) continue;
      const mtime = Math.floor(statSync(file).mtimeMs);
      cursor = Math.max(cursor, mtime);
      if (mtime > since) files.push({ name, mtime, text: readFileSync(file, 'utf8') });
    }
    return { files, filesCursor: cursor };
  }

  // ---------- the copy that comes in ----------
  async pullFrom(peer) {
    if (!peer) return;
    const settings = this.settings(); let cursor = settings.cursors?.[peer.id] || 0, filesCursor = settings.files?.[peer.id] || 0, page;
    try {
      do {
        page = await this.transport(peer, 'GET', `/api/peer/pull?since=${cursor}&files=${filesCursor}`);
        if (page.node?.id && peer.id && page.node.id !== peer.id) throw new Error('A different computer answers at that address now.');
        this.applyAll(page.changes || []); this.applyFiles(page.files || []);
        cursor = page.cursor; filesCursor = page.filesCursor || filesCursor;
      } while (page.more);
      const fresh = this.settings();
      this.store.put('peers', 'main', { ...fresh, cursors: { ...fresh.cursors, [peer.id]: cursor }, files: { ...fresh.files, [peer.id]: filesCursor },
        peers: fresh.peers.map(item => item.id === peer.id ? { ...item, name: page.node?.name || item.name, lastSeen: now(), error: '' } : item) });
      const was = this.online(peer.id);
      this.live.set(peer.id, { at: Date.now(), ...page.live });
      if (!was) this.store.emit('change', { kind: 'peers' });
    } catch (error) {
      const was = this.online(peer.id);
      if (was) { this.live.set(peer.id, { ...this.live.get(peer.id), at: 0 }); this.store.emit('change', { kind: 'peers' }); }
      const fresh = this.settings();
      if (fresh.peers.find(item => item.id === peer.id)?.error !== error.message) this.store.put('peers', 'main', { ...fresh, peers: fresh.peers.map(item => item.id === peer.id ? { ...item, error: error.message } : item) });
    }
  }
  applyAll(changes) {
    const delivered = [];
    for (const change of changes) {
      const value = change.kind === 'roommsg' && change.value ? { ...change.value, tasks: this.desk.rooms.tasksIn(change.value.text) } : change.value;
      const result = this.store.applyRemote(change.kind, change.id, value, change.deleted);
      if (result.isNew && change.kind === 'roommsg') delivered.push(value);
      if (result.changed && change.kind === 'peercmd') void this.runCommand(this.store.get('peercmd', change.id));
    }
    // A message for one of this computer's agents is answered here, also after this computer was off for a while.
    for (const message of delivered) {
      if (Date.now() - Date.parse(message.at) > QUEUE_DAYS * 86400000 || message.paused) continue;
      const room = this.store.get('room', message.roomId); if (!room) continue;
      const mine = message.to.filter(target => target !== HUMAN && this.owns(target, message));
      if (mine.length) void this.desk.rooms.deliver(room, message, mine).catch(() => {});
    }
  }
  applyFiles(files) {
    for (const item of files) {
      if (!this.sharedFiles().includes(item.name) && !/^workflows\/[a-z0-9._-]+\.md$/.test(item.name)) continue;
      const file = this.desk.memory.file(...item.name.split('/'));
      const local = existsSync(file) ? Math.floor(statSync(file).mtimeMs) : 0;
      if (item.mtime <= local) continue;
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, item.text); const at = new Date(item.mtime); utimesSync(file, at, at);
    }
  }
  // Whether this computer answers for an agent in a message: its own agents, and its Rex Agent for messages written here.
  owns(agentId, message = {}) {
    if (agentId === 'main') return (message.node || this.self.id) === this.self.id;
    const agent = this.store.get('specialist', agentId);
    return Boolean(agent) && !this.isRemote(agent);
  }
  // Said once in a while, not on every message: the agent's computer is off, and the message waits for it.
  offlineNote(roomId, agent) {
    const key = `${roomId}:${agent.id}`; if (Date.now() - (this.notes.get(key) || 0) < 10 * 60000) return;
    this.notes.set(key, Date.now());
    const known = this.cloudSeen?.has(agent.node) || this.byNode(agent.node);
    this.desk.rooms.system(roomId, known ? `${agent.name} is offline: ${this.deviceName(agent.node)} is off. The message waits, and ${agent.name} answers when it is back.`
      : `${agent.name} works on another computer that has not checked in here yet. The message waits in the shared chat. If that computer is on, update Rex Desk there and use the same Turso database (or add it under Devices).`);
  }

  // ---------- doing something with an agent on another computer ----------
  async forward(nodeId, method, route, data) {
    const peer = this.byNode(nodeId);
    if (!peer || !this.direct(nodeId)) throw new Error(`${this.deviceName(nodeId)} is off. Try again when it is on.`);
    return this.transport(peer, method, route, data);
  }
  // A message or a task for an agent whose computer is off waits as a command; that computer runs it when it is back.
  async command(agent, action, input) {
    // The same words to the same agent a moment ago are not sent again (a screen that kept retrying sent one greeting 100 times).
    const text = String(input?.text || '');
    const repeat = action === 'say' && text && this.store.list('peercmd').find(item => item.agentId === agent.id && item.action === 'say' && String(item.input?.text || '') === text && Date.now() - Date.parse(item.at || 0) < REPEAT_MS);
    if (repeat) return { queued: true, repeat: true, message: `${agent.name} already has this message.` };
    if (this.direct(agent.node) && this.byNode(agent.node)) {
      const route = action === 'say' ? `/api/specialists/${agent.id}/say` : `/api/specialists/${agent.id}/assign`;
      return this.forward(agent.node, 'POST', route, input);
    }
    const id = randomUUID();
    this.store.put('peercmd', id, { id, target: agent.node, action, agentId: agent.id, input, at: now(), done: false });
    return { queued: true, message: this.seen(agent.node) ? `Sent to ${agent.name} on ${this.deviceName(agent.node)} through the shared database. It starts in a few seconds.` : `${agent.name} is offline: ${this.deviceName(agent.node)} is off. It gets this when it is back.` };
  }
  async runCommand(command) {
    if (!command || command.done || command.target !== this.self.id || this.running?.has(command.id)) return;
    (this.running ||= new Set()).add(command.id);
    let result = {}, error = '';
    try {
      if (command.action === 'say') result = await this.desk.specialistTurn(command.agentId, { prompt: String(command.input?.text || '').slice(0, 4000) });
      else if (command.action === 'assign') result = await this.desk.assignTask({ specialistId: command.agentId, ...this.localTask(command.input) });
      else if (command.action === 'chat-stop') result = await this.desk.stop(command.runId);
      else if (command.action === 'answer') result = this.desk.answer(command.input?.interactionId, command.input?.answer || {});
      else if (command.action === 'chat-say') {
        // Written on another computer in this agent's personal chat: said to the agent while it works, or it picks the chat up again.
        const run = this.store.get('run', command.runId), text = String(command.input?.text || '');
        if (!run) throw new Error('That chat is no longer on this computer.');
        result = ['starting', 'running', 'queued', 'waiting', 'verifying'].includes(run.state) ? await this.desk.say(run.id, text, {}) : await this.desk.resume(run.id, { prompt: text });
      }
    } catch (failure) { error = failure.message; }
    this.store.put('peercmd', command.id, { ...this.store.get('peercmd', command.id), done: true, doneAt: now(), error, runId: result?.id || '' });
    this.running.delete(command.id);
  }
  // A task is known by its number on every computer; its id can differ between them.
  localTask(input = {}) {
    if (this.store.get('task', input.taskId)) return input;
    const number = String(input.taskNumber || ''), task = number && this.store.list('task').find(item => String(item.taskNumber || '') === number || String(item.externalId || '') === number);
    if (!task) throw new Error(`Task #${number || input.taskId} is not on this computer yet. Sync its tracker here first.`);
    return { ...input, taskId: task.id };
  }
  pendingCommands() { for (const command of this.store.list('peercmd').filter(item => !item.done && item.target === this.self.id)) void this.runCommand(command); }

  // With the same Turso database on every computer, the chats also arrive from there, even while the other computer is off.
  async pullTurso() {
    if (!this.store.cloud?.ready) return;
    const settings = this.settings(), from = Math.max(0, (settings.tursoAt || 0) - 120000), since = `${from.toString(36).padStart(9, '0')}`;
    try {
      const rows = await this.store.cloud.pullShared(since); if (!rows?.length) return;
      this.applyAll(rows);
      const newest = Math.max(...rows.map(row => parseInt(String(row.v).split('.')[0], 36) || 0));
      if (newest > (settings.tursoAt || 0)) this.save({ tursoAt: newest });
    } catch { /* Turso shows its own state in Settings */ }
  }
  async presence() {
    if (!this.store.cloud?.ready) return;
    try {
      const mine = this.store.list('specialist').filter(agent => agent.kind !== 'main' && !this.isRemote(agent));
      const rows = await this.store.cloud.presence(this.self.name, Object.fromEntries(mine.map(agent => [agent.id, this.desk.specialists.status(agent)])));
      const before = new Set([...(this.cloudSeen || new Map())].filter(([node]) => this.seen(node)).map(([node]) => node));
      this.cloudSeen = new Map((rows || []).map(row => [row.node, row]));
      if ([...this.cloudSeen.keys()].some(node => this.seen(node) !== before.has(node))) this.store.emit?.('change', { kind: 'peers' });
    } catch { /* Turso shows its own state in Settings */ }
  }
  // ---------- personal chats through the shared database ----------
  // A personal chat lives on the computer its agent works on. That computer keeps a copy of each of its agents' personal chats
  // (the last messages and the chat's state) in the shared database, so the person's other computers and the phone can read
  // it and write to it even without a direct Tailscale link. What they write is sent back as a command and answered here.
  copies(run) {
    if (!run || run.roomAgent || run.roomId || !run.specialistId) return false;
    const agent = this.store.get('specialist', run.specialistId);
    return Boolean(agent) && agent.kind !== 'main' && !this.isRemote(agent);
  }
  copyChat(runId) {
    const run = this.store.get('run', runId); if (!this.copies(run)) return;
    const trim = (value, max) => typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value;
    // The same message said again right after itself is shown once; tool output is shortened. The newest messages are kept.
    const events = [];
    for (const event of this.store.events(runId, { visible: true, limit: COPY_EVENTS })) {
      const last = events.at(-1);
      if (event.kind === 'human-message' && last?.kind === 'human-message' && last.text === trim(event.text, COPY_TEXT)) continue;
      const max = /tool/.test(event.kind) ? COPY_TOOL : COPY_TEXT;
      events.push(Object.fromEntries(Object.entries(event).map(([key, value]) => [key, trim(value, max)])));
    }
    events.splice(0, Math.max(0, events.length - COPY_KEEP));
    const slim = Object.fromEntries(Object.entries(run).filter(([key, value]) => !['queued', 'mirror', 'prompt'].includes(key) && JSON.stringify(value ?? '').length < 4000));
    // Questions and approvals waiting for the person travel with the chat, so they can be answered from any computer.
    const asks = this.store.list('interaction').filter(item => item.runId === runId && item.state === 'pending')
      .map(item => Object.fromEntries(Object.entries(item).filter(([, value]) => JSON.stringify(value ?? '').length < 20000)));
    this.store.put('chatcopy', runId, { id: runId, agentId: run.specialistId, run: slim, events, asks, at: now() });
  }
  watchChats() {
    if (this.watching) return; this.watching = true;
    const waiting = new Map();
    this.store.on?.('change', event => {
      const runId = event.kind === 'event' ? event.runId : event.kind === 'run' ? event.id : event.kind === 'interaction' ? this.store.get('interaction', event.id)?.runId || '' : '';
      if (!runId || waiting.has(runId)) return;
      const timer = setTimeout(() => { waiting.delete(runId); try { this.copyChat(runId); } catch { /* the next change tries again */ } }, 1500);
      timer.unref?.(); waiting.set(runId, timer);
    });
    // The chats that were there before this computer started sharing them.
    // Every personal chat of the last 30 days, not only the one each agent is in now, so older conversations show too.
    const since = Date.now() - 30 * 86400000;
    for (const run of this.store.list('run')) if (this.copies(run) && Date.parse(run.updatedAt || run.createdAt || 0) > since) { try { this.copyChat(run.id); } catch { /* not a personal chat */ } }
  }
  // Another computer's chat, read from its copy: only when it is not here and not reached directly.
  chatCopy(runId) {
    if (this.store.get('run', runId) || this.runOwner(runId)) return null;
    const copy = this.store.get('chatcopy', runId);
    return copy && copy.node && copy.node !== this.self.id ? copy : null;
  }
  cloudRuns() {
    const direct = new Set(this.remoteRuns().map(run => run.id));
    return this.store.list('chatcopy').filter(copy => copy.node && copy.node !== this.self.id && copy.run && !direct.has(copy.id) && !this.store.get('run', copy.id))
      .map(copy => ({ ...copy.run, remote: copy.node, cloudCopy: true }));
  }
  cloudInteractions() {
    const direct = new Set(this.remoteInteractions().map(item => item.id));
    return this.store.list('chatcopy').filter(copy => copy.node && copy.node !== this.self.id && !this.store.get('run', copy.id) && !this.runOwner(copy.id))
      .flatMap(copy => (copy.asks || []).filter(item => !direct.has(item.id) && !(this.answered ||= new Set()).has(item.id)).map(item => ({ ...item, remote: copy.node, cloudCopy: true })));
  }
  askCopy(interactionId) {
    if (this.store.get('interaction', interactionId) || this.interactionOwner(interactionId)) return null;
    return this.store.list('chatcopy').find(copy => copy.node && copy.node !== this.self.id && (copy.asks || []).some(item => item.id === interactionId)) || null;
  }
  answerAsk(copy, interactionId, answer) {
    const id = randomUUID();
    this.store.put('peercmd', id, { id, target: copy.node, action: 'answer', runId: copy.id, agentId: copy.agentId, input: { interactionId, answer }, at: now(), done: false });
    (this.answered ||= new Set()).add(interactionId);
    return { queued: true, message: this.online(copy.node) ? `Answer sent to ${this.deviceName(copy.node)}.` : `${this.deviceName(copy.node)} is off. The answer reaches it when it is back on.` };
  }
  // The person writes in a chat whose agent is on another computer: straight there when it is reached directly, otherwise
  // as a command in the shared database that the agent's computer runs within seconds (or when it is back on).
  async chatAction(copy, action, input = {}) {
    if (!['say', 'resume', 'stop'].includes(action)) throw new Error(`Open this chat on ${this.deviceName(copy.node)} to do that.`);
    const text = String(input.text || input.prompt || '').slice(0, 20000);
    if (action !== 'stop' && !text.trim()) throw new Error('Write a message first.');
    const id = randomUUID();
    this.store.put('peercmd', id, { id, target: copy.node, action: `chat-${action === 'stop' ? 'stop' : 'say'}`, runId: copy.id, agentId: copy.agentId, input: { text }, at: now(), done: false });
    const name = this.store.get('specialist', copy.agentId)?.name || 'The agent';
    return { queued: true, message: this.online(copy.node) ? `Sent to ${name} on ${this.deviceName(copy.node)}. The reply shows here in a few seconds.` : `${this.deviceName(copy.node)} is off. ${name} gets this when it is back on.` };
  }

  // ---------- the loop ----------
  start() {
    this.pendingCommands(); this.watchChats();
    const tick = async () => {
      for (const peer of this.settings().peers) {
        if (this.timers.get(peer.id) > Date.now()) continue;
        await this.pullFrom(peer);
        this.timers.set(peer.id, Date.now() + (this.direct(peer.id) ? 2500 : 10000));
      }
      if ((this.timers.get('turso') || 0) <= Date.now()) { await this.pullTurso(); this.timers.set('turso', Date.now() + 5000); }
      if ((this.timers.get('presence') || 0) <= Date.now()) { this.timers.set('presence', Date.now() + 30000); await this.presence(); }
    };
    this.loop = setInterval(() => { if (!this.ticking) { this.ticking = true; void tick().finally(() => { this.ticking = false; }); } }, 1000);
    this.loop.unref?.();
  }
  stop() { clearInterval(this.loop); }
  selfUrl() { return this.port ? this.addresses(this.port)[0] || '' : ''; }
  async http(peer, method, route, data) {
    const response = await fetch(`${peer.url}${route}`, { method, signal: AbortSignal.timeout(6000),
      headers: { 'content-type': 'application/json', 'x-rex-desk': '1', 'x-rex-peer-key': this.key(), 'x-rex-peer-node': this.self.id, 'x-rex-peer-name': encodeURIComponent(this.self.name), 'x-rex-peer-url': this.selfUrl() },
      body: data === undefined || method === 'GET' ? undefined : JSON.stringify(data) });
    const text = await response.text(); let answer = {}; try { answer = text ? JSON.parse(text) : {}; } catch { throw new Error(`${peer.url} is not a Rex Desk.`); }
    if (response.status === 401) throw new Error('That computer has a different key. Copy the key from it and press Join.');
    if (!response.ok) throw new Error(answer.error || `${peer.url} answered ${response.status}.`);
    return answer;
  }
}

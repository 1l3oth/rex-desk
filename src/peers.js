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
const ONLINE_MS = 15000, PAGE = 400, QUEUE_DAYS = 7;
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
  online(nodeId) { const live = this.live.get(nodeId); return Boolean(live && Date.now() - live.at < ONLINE_MS); }
  deviceName(nodeId) { if (!nodeId || nodeId === this.self.id) return this.self.name; return this.byNode(nodeId)?.name || 'another computer'; }
  isRemote(agent) { return Boolean(agent && agent.kind !== 'main' && agent.node && agent.node !== this.self.id); }
  statusOf(agent) {
    if (!this.online(agent.node)) return { state: 'offline', label: `Offline · ${this.deviceName(agent.node)} is off` };
    return this.live.get(agent.node).agents?.[agent.id] || { state: 'idle', label: 'Idle' };
  }
  // Runs and questions of agents on the other computers, shown as if they were here.
  remoteRuns() { return [...this.live].filter(([node]) => this.online(node)).flatMap(([node, live]) => (live.runs || []).map(run => ({ ...run, remote: node }))); }
  remoteInteractions() { return [...this.live].filter(([node]) => this.online(node)).flatMap(([node, live]) => (live.interactions || []).map(item => ({ ...item, remote: node }))); }
  runOwner(runId) { return [...this.live].find(([, live]) => (live.runs || []).some(run => run.id === runId))?.[0] || ''; }
  interactionOwner(id) { return [...this.live].find(([, live]) => (live.interactions || []).some(item => item.id === id))?.[0] || ''; }
  status(port) {
    const settings = this.settings();
    return { self: { ...this.self, addresses: port ? this.addresses(port) : [] }, remote: Boolean(settings.remote), key: this.key(), tailscale: tailscaleAddresses().length > 0,
      peers: settings.peers.map(peer => ({ id: peer.id, name: peer.name, url: peer.url, online: this.online(peer.id), lastSeen: this.live.get(peer.id)?.at ? new Date(this.live.get(peer.id).at).toISOString() : peer.lastSeen || '', error: peer.error || '' })) };
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
    this.desk.rooms.system(roomId, `${agent.name} is offline: ${this.deviceName(agent.node)} is off. The message waits, and ${agent.name} answers when it is back.`);
  }

  // ---------- doing something with an agent on another computer ----------
  async forward(nodeId, method, route, data) {
    const peer = this.byNode(nodeId);
    if (!peer || !this.online(nodeId)) throw new Error(`${this.deviceName(nodeId)} is off. Try again when it is on.`);
    return this.transport(peer, method, route, data);
  }
  // A message or a task for an agent whose computer is off waits as a command; that computer runs it when it is back.
  async command(agent, action, input) {
    if (this.online(agent.node)) {
      const route = action === 'say' ? `/api/specialists/${agent.id}/say` : `/api/specialists/${agent.id}/assign`;
      return this.forward(agent.node, 'POST', route, input);
    }
    const id = randomUUID();
    this.store.put('peercmd', id, { id, target: agent.node, action, agentId: agent.id, input, at: now(), done: false });
    return { queued: true, message: `${agent.name} is offline: ${this.deviceName(agent.node)} is off. It gets this when it is back.` };
  }
  async runCommand(command) {
    if (!command || command.done || command.target !== this.self.id || this.running?.has(command.id)) return;
    (this.running ||= new Set()).add(command.id);
    let result = {}, error = '';
    try {
      if (command.action === 'say') result = await this.desk.specialistTurn(command.agentId, { prompt: String(command.input?.text || '').slice(0, 4000) });
      else if (command.action === 'assign') result = await this.desk.assignTask({ specialistId: command.agentId, ...this.localTask(command.input) });
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
  // ---------- the loop ----------
  start() {
    this.pendingCommands();
    const tick = async () => {
      for (const peer of this.settings().peers) {
        if (this.timers.get(peer.id) > Date.now()) continue;
        await this.pullFrom(peer);
        this.timers.set(peer.id, Date.now() + (this.online(peer.id) ? 2500 : 10000));
      }
      if ((this.timers.get('turso') || 0) <= Date.now()) { await this.pullTurso(); this.timers.set('turso', Date.now() + 5000); }
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

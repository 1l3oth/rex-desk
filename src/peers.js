// One person, many computers. Each computer runs its own Rex Desk and is the workspace of its own agents: their projects,
// worktrees and sessions stay there. Rooms, messages, agent cards, what the agents learned, and commands for an agent on
// another computer are copied between the person's computers over their private network (Tailscale), so every computer
// and the phone shows the same chats. A computer that is off only takes its own agents offline; messages for them wait.
import { seal } from './sealed.js';
import { doing, step, waitStep } from './stall-watch.js';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { HUMAN } from './rooms.js';
import { keepLines } from './store.js';
import { MERGED_FILES, mergeNotes, mergeForgotten, parseNotes, noteKey } from './notes-merge.js';
// Whether a notes page holds a note that matches.
const parseNotesHas = (text, match) => [...parseNotes(text).sections.values()].some(items => items.some(line => match(noteKey(line))));
import { execFile } from 'node:child_process';

const now = () => new Date().toISOString();
const STALE_CHAT_MS = 24 * 3600000;
// The second look at the last day of chat messages, done by a safety look at most this often (Peers.pullChats).
const CHAT_DEEP_MS = 6 * 3600000, CHAT_DEEP_SPAN = 24 * 3600000;
// Sync by note, not by polling (L88). Each change saved here is uploaded, then a small sealed note goes to the account's other
// computers through the relay line; they read the cloud only then, and only the rows after the ones they have. Small changes
// ride inside the note, so nothing is read for them at all. The cloud database stays the backup:
// SAFETY_MS: with the line up, one safety look at the cloud this often (and once each time the line comes back).
// FALLBACK_MS: with the line down (or another computer still on a version without notes), the cloud is looked at this often.
// BEAT_MS: the note that says this computer is on, with what its agents do; a change goes at once.
// CLOUD_BEAT_MS: this computer's heartbeat row in the cloud, for computers without the line; a change is written at once too.
// NOTE_BYTES: a note bigger than this leaves its records and messages out, and the other computers read them instead.
// SETTLE_MS: a safety look this long past the overlap after the newest row read settles it (see pullChats).
// MORE_MS: a look that stopped at its page limit goes on from where it stopped this much later, not in a tight loop.
const SAFETY_MS = 5 * 60000, SETTLE_MS = 60000, MORE_MS = 2000, FALLBACK_MS = 20000, BEAT_MS = 60000, CLOUD_BEAT_MS = 5 * 60000, NOTE_BYTES = 16000;
// How often the other computers' agent states are read while one of them is on but sends no notes.
const LOOK_MS = FALLBACK_MS;
const older = (left, right) => !left ? right || '' : !right ? left : left < right ? left : right;
// The cursor just below a version, so a look "after" it brings that version too.
const justBelow = version => Math.max(0, (parseInt(String(version).split('.')[0], 36) || 0) - 1).toString(36).padStart(9, '0');
// What an agent is doing, without what changes on its own (warm-cache times), so only a real change counts.
const statusKey = agents => JSON.stringify(Object.entries(agents || {}).sort(([left], [right]) => left.localeCompare(right)).map(([id, item]) => [id, item?.state || '', item?.label || '', item?.runId || '', item?.taskId || '']));
const STEP_MS = 30000, ONLINE_MS = 15000, CLOUD_MS = 90000, PAGE = 400, QUEUE_DAYS = 7, COPY_EVENTS = 400, COPY_KEEP = 160, COPY_TEXT = 6000, COPY_TOOL = 1500, REPEAT_MS = 10 * 60000, PICTURE_BYTES = 2 * 1024 * 1024, CARRY_BYTES = 8 * 1024 * 1024;
const isPageArtifact = item => Boolean(item.page) || /\.html?$/i.test(item.file);
const PICTURE = /\.(png|jpe?g|gif|webp|bmp)$/i;
// A picture is known by its path on the computer that has it.
// An attached file is known by its upload folder and name (uploads/<id>/<name>), the same on Windows and macOS: hashing the
// whole path gave each computer its own id for one file (L27). legacyFileId is the id files shared before had.
const legacyFileId = file => createHash('sha1').update(path.resolve(String(file)).toLowerCase()).digest('hex');
export const chatFileId = file => {
  const upload = /[\\/]uploads[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(String(file || ''));
  return upload ? createHash('sha1').update(`upload:${upload[1].toLowerCase()}/${upload[2].toLowerCase()}`).digest('hex') : legacyFileId(file);
};
export const evidenceId = (runId, file) => createHash('sha1').update(`evidence:${runId}/${path.basename(String(file))}`).digest('hex');
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
  // The private https address "tailscale serve" gives this computer comes first: phones need https for the microphone.
  addresses(port) { return [...(this.secure ? [this.secure] : []), ...tailscaleAddresses().map(address => `http://${address}:${port}`)]; }
  refreshSecure() {
    const command = process.platform === 'win32' && existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
    execFile(command, ['serve', 'status', '--json'], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      let found = '';
      try { const web = JSON.parse(String(stdout || '{}')).Web || {}; const host = Object.keys(web).find(key => this.port && JSON.stringify(web[key]).includes(`:${this.port}`)); found = host ? `https://${host.replace(/:443$/, '')}` : ''; } catch { found = ''; }
      if (!error || found !== this.secure) this.secure = found;
    });
  }

  // ---------- what the screen shows ----------
  byNode(nodeId) { return this.settings().peers.find(peer => peer.id === nodeId); }
  // Reached directly over Tailscale.
  direct(nodeId) { const live = this.live.get(nodeId); return Boolean(live && Date.now() - live.at < ONLINE_MS); }
  // On: reached directly, or it said so in the shared Turso database in the last 90 seconds.
  seen(nodeId) { const heard = this.heard?.get(nodeId); return Boolean(heard && Date.now() - heard < CLOUD_MS); }
  // When this computer last heard from another one, by its own clock: a changed heartbeat, or new data from it.
  hear(nodeId) { if (!nodeId || nodeId === this.self.id) return; (this.heard ||= new Map()).set(nodeId, Date.now()); }
  lastHeard(nodeId) { return this.heard?.get(nodeId) || 0; }
  online(nodeId) { return this.direct(nodeId) || this.seen(nodeId); }
  deviceName(nodeId) { if (!nodeId || nodeId === this.self.id) return this.self.name; return this.byNode(nodeId)?.name || this.cloudSeen?.get(nodeId)?.name || 'another computer'; }
  // An agent follows the person by default: a message from this computer brings it here, unless "Works where you are" is
  // off, its project runs only on its own computer or is not on this one, or it is busy over there.
  followsHere(agent) {
    return Boolean(agent && this.isRemote(agent) && agent.follows !== false && !agent.pinned
      && !(agent.projectSlug && !this.desk.projectRules.folderHere(agent.projectSlug))
      && !['busy', 'replying', 'waiting'].includes(this.statusOf(agent).state));
  }
  isRemote(agent) { return Boolean(agent && agent.kind !== 'main' && agent.node && agent.node !== this.self.id); }
  statusOf(agent) {
    if (this.direct(agent.node)) return this.live.get(agent.node).agents?.[agent.id] || { state: 'idle', label: 'Idle' };
    if (this.seen(agent.node)) return this.cloudSeen.get(agent.node).agents?.[agent.id] || { state: 'idle', label: 'Idle' };
    return { state: 'offline', label: this.cloudSeen?.has(agent.node) || this.byNode(agent.node) ? `Offline Â· ${this.deviceName(agent.node)} is off` : `Offline Â· ${this.deviceName(agent.node)} has not checked in` };
  }
  // Runs and questions of agents on the other computers, shown as if they were here.
  remoteRuns() { return [...this.live].filter(([node]) => this.direct(node)).flatMap(([node, live]) => (live.runs || []).map(run => ({ ...run, remote: node }))); }
  remoteInteractions() { return [...this.live].filter(([node]) => this.direct(node)).flatMap(([node, live]) => (live.interactions || []).map(item => ({ ...item, remote: node }))); }
  runOwner(runId) { return [...this.live].find(([, live]) => (live.runs || []).some(run => run.id === runId))?.[0] || ''; }
  interactionOwner(id) { return [...this.live].find(([, live]) => (live.interactions || []).some(item => item.id === id))?.[0] || ''; }
  status(port) {
    const settings = this.settings();
    // named: the person gave this computer a name. A new computer has none yet and asks for one (Home, Work...).
    return { self: { ...this.self, named: Boolean(settings.name), addresses: port ? this.addresses(port) : [] }, remote: Boolean(settings.remote), key: this.key(), tailscale: tailscaleAddresses().length > 0,
      peers: [...settings.peers.map(peer => ({ id: peer.id, name: peer.name, url: peer.url, online: this.online(peer.id), via: this.direct(peer.id) ? 'tailscale' : this.seen(peer.id) ? 'turso' : '', lastSeen: this.live.get(peer.id)?.at ? new Date(this.live.get(peer.id).at).toISOString() : peer.lastSeen || '', error: peer.error || '' })),
        ...[...(this.cloudSeen || new Map()).values()].filter(row => !settings.peers.some(peer => peer.id === row.node)).map(row => ({ id: row.node, name: row.name, url: 'through Turso', online: this.seen(row.node), via: 'turso', lastSeen: new Date(this.lastHeard(row.node) || row.at).toISOString(), error: '' }))],
      // Whether this computer joined the account's shared space when the person signed in, and why not if it did not.
      join: this.store.get('meta', 'account-join') || null };
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
    const memory = this.desk.memory, names = ['forgotten.json', 'user.md', 'chat-style.md'];
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
    doing('sync: reading another computer');
    if (!peer) return;
    // The first sync after this update reads all of the other computer's learned notes once, so notes it saved before the
    // merge existed (and that an older newest-wins copy skipped) are joined in too.
    const settings = this.settings(), merged = Boolean(settings.notesMerged?.[peer.id]);
    let cursor = settings.cursors?.[peer.id] || 0, filesCursor = merged ? settings.files?.[peer.id] || 0 : 0, page;
    try {
      do {
        page = await this.transport(peer, 'GET', `/api/peer/pull?since=${cursor}&files=${filesCursor}`);
        if (page.node?.id && peer.id && page.node.id !== peer.id) throw new Error('A different computer answers at that address now.');
        this.applyAll(page.changes || []); this.applyFiles(page.files || []);
        cursor = page.cursor; filesCursor = page.filesCursor || filesCursor;
      } while (page.more);
      const fresh = this.settings();
      this.store.put('peers', 'main', { ...fresh, cursors: { ...fresh.cursors, [peer.id]: cursor }, files: { ...fresh.files, [peer.id]: filesCursor }, notesMerged: { ...fresh.notesMerged, [peer.id]: true },
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
      if (result.changed && change.kind === 'task') this.tasksArrived = true;
      if (result.changed && change.kind === 'chatfile' && value?.data) this.saveUpload(value);
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
    // Removed notes first, so the notes merged after them leave those out.
    const ordered = [...files].sort((left, right) => Number(right.name === 'forgotten.json') - Number(left.name === 'forgotten.json'));
    for (const item of ordered) {
      if (!this.sharedFiles().includes(item.name) && !/^workflows\/[a-z0-9._-]+\.md$/.test(item.name)) continue;
      const file = this.desk.memory.file(...item.name.split('/'));
      // Learned notes are joined line by line, whichever side is newer: a note saved on either computer is kept on both.
      if (item.name === 'forgotten.json' || MERGED_FILES(item.name)) { this.mergeFile(file, item); continue; }
      const local = existsSync(file) ? Math.floor(statSync(file).mtimeMs) : 0;
      if (item.mtime <= local) continue;
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, item.text); const at = new Date(item.mtime); utimesSync(file, at, at);
    }
  }
  mergeFile(file, item) {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    let text;
    if (item.name === 'forgotten.json') {
      const parse = value => { try { return JSON.parse(value) || {}; } catch { return {}; } };
      const forgotten = mergeForgotten(parse(before), parse(item.text));
      text = JSON.stringify(forgotten, null, 1);
      if (JSON.stringify(parse(before)) !== JSON.stringify(parse(text))) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
      // A removal that comes without the notes file is applied to the notes here at once, so the note leaves active memory now.
      this.dropForgotten(forgotten);
      return;
    } else {
      text = mergeNotes(before, item.text, this.desk.memory.forgotten()[item.name] || {});
      const flat = value => value.replace(/\r\n/g, '\n').trim();
      if (flat(text) === flat(before)) return;
    }
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text);
  }
  dropForgotten(forgotten) {
    for (const [name, notes] of Object.entries(forgotten || {})) {
      if (!MERGED_FILES(name)) continue;
      const file = this.desk.memory.file(...name.split('/')); if (!existsSync(file)) continue;
      const before = readFileSync(file, 'utf8');
      if (!parseNotesHas(before, key => notes[key]?.gone === true)) continue;
      // Only the removed note lines go; every other byte of the page (text under headings, spacing, line ends) stays.
      const after = before.split(/(?<=\n)/).filter(line => !(/^-\s+/.test(line) && notes[noteKey(line.trimEnd())]?.gone === true)).join('');
      if (after !== before) writeFileSync(file, after);
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
    const id = randomUUID(), packed = action === 'say' ? { ...input, ...this.packFiles(String(input?.text || ''), agent.node, agent.id) } : input;
    this.store.put('peercmd', id, { id, target: agent.node, action, agentId: agent.id, input: packed, at: now(), done: false });
    return { queued: true, message: this.seen(agent.node) ? `Sent to ${agent.name} on ${this.deviceName(agent.node)} through the shared database. It starts in a few seconds.` : `${agent.name} is offline: ${this.deviceName(agent.node)} is off. It gets this when it is back.` };
  }
  async runCommand(command) {
    if (!command || command.done || command.target !== this.self.id || this.running?.has(command.id)) return;
    (this.running ||= new Set()).add(command.id);
    let result = {}, error = '';
    try {
      if (command.action === 'say') result = await this.desk.specialistTurn(command.agentId, { prompt: (await this.unpackFiles(command.input)).slice(0, 8000) });
      else if (command.action === 'assign') result = await this.desk.assignTask({ specialistId: command.agentId, ...this.localTask(command.input) });
      else if (command.action === 'chat-stop') result = await this.desk.stop(command.runId);
      // The other computer is taking this agent over: save its work here first (L57).
      else if (command.action === 'handover-save') result = await this.desk.handover.serve(command);
      // A team task, its result, an answer or a cancel, from an agent that manages work on the other computer.
      else if (String(command.action).startsWith('team-')) result = await this.desk.team.remote(command.action, command.input);
      else if (command.action === 'answer' && command.input?.answer?.sealed) result = this.desk.saveSealedFile(command.input.interactionId, command.input.answer.sealed);
      else if (command.action === 'answer') result = this.desk.answer(command.input?.interactionId, command.input?.answer || {});
      else if (command.action === 'chat-say') {
        // Written on another computer in this agent's personal chat: said to the agent while it works, or it picks the chat up again.
        // A message that waited more than a day (this computer was off) is not acted on late; the chat says so instead.
        if (Date.now() - Date.parse(command.at || 0) > STALE_CHAT_MS) throw new Error('it waited more than a day while this computer was off, so it was not passed to the agent. Send it again if it still matters.');
        const run = this.store.get('run', command.runId), text = await this.unpackFiles(command.input);
        if (!run) throw new Error('That chat is no longer on this computer.');
        // The message is already in the shared chat (written on the computer it was typed on): only the agent gets it.
        const echoed = Boolean(command.input?.uid);
        if (command.input?.echo?.uid) this.store.applyChatEvents([{ ...command.input.echo, run_id: run.id, deleted: 0 }]);
        // The command's id goes on the run in the same write that queues the message (L114). When this computer restarted after
        // that write but before the command was marked done, the id is already there: the command is only marked done now.
        if (run.sentIds?.includes(command.id)) result = run;
        else result = ['starting', 'running', 'queued', 'waiting', 'verifying'].includes(run.state) ? await this.desk.say(run.id, text, { echoed, sendId: command.id }) : await this.desk.resume(run.id, { prompt: text, silent: echoed, sendId: command.id });
      }
    } catch (failure) { error = failure.message; }
    // A message that could not be delivered must never just vanish: show it in the chat so the person sees it failed,
    // instead of silently marking the command done. The error also travels back on the command record below.
    if (error) { const runId = command.runId || result?.id; if (runId && this.store.get('run', runId)) this.store.event(runId, 'error', { message: `A message from ${this.deviceName(command.node) || 'your other computer'} could not be delivered: ${error}` }, true); }
    // A locked file answer is not kept once it is used: only its question id stays.
    const sealed = command.action === 'answer' && command.input?.answer?.sealed;
    this.store.put('peercmd', command.id, { ...this.store.get('peercmd', command.id), ...(sealed ? { input: { interactionId: command.input.interactionId } } : {}), done: true, doneAt: now(), error, runId: result?.id || '' });
    this.running.delete(command.id);
  }
  // A task is known by its number on every computer; its id can differ between them.
  localTask(input = {}) {
    if (this.store.get('task', input.taskId)) return input;
    const number = String(input.taskNumber || ''), task = number && this.store.list('task').find(item => String(item.taskNumber || '') === number || String(item.externalId || '') === number);
    if (!task) throw new Error(`Task #${number || input.taskId} is not on this computer yet. Sync its tracker here first.`);
    return { ...input, taskId: task.id };
  }
  // Every tick, not only at start: a command can also arrive with the start-up copy of the cloud (TursoSync.pullLatest),
  // which writes records without going through applyAll.
  pendingCommands() { for (const command of this.store.list('peercmd').filter(item => !item.done && item.target === this.self.id)) void this.runCommand(command); }

  // ---------- agents' chats, the same on every computer (docs/design/cross-device-chat.md) ----------
  // Messages the other computers wrote, brought in by their ids. A short overlap re-reads what clocks that differ may
  // have stamped a little in the past; reading a message twice changes nothing.
  // A safety look (no arguments) starts two minutes back, and now and then a day back. from: a note said messages from this
  // version on were uploaded; the look then starts there (or at the last one read, if that is older) and reads nothing twice.
  // after: the exact last version a look that stopped at its page limit read; the look goes on strictly after it (no rewind).
  async pullChats({ from = '', after = '', overlap = 120000 } = {}) {
    // What a look answers (the tick keeps a note's hint until one says done): false when the cloud could not be read (nothing
    // is saved then), { done: false, next } when it stopped at its page limit at next, { done: true } once it read to the end.
    if (!this.store.cloud?.ready || !this.store.cloud.pullChat) return false;
    // Each database call is named while it runs (step), so the freeze log names the one that is really running.
    // chatRead 2: read everything once more, so messages dropped by an id clash (see Store.applyChatEvents) come in.
    const settings = step('sync chat: read peer settings', () => this.settings()), again = settings.chatNode !== this.self.id || settings.chatRead !== 2;
    let since = again ? '' : String(settings.chatAt || ''), newest = since, total = 0; const read = String(settings.chatAt || '');
    // Once an hour the last day is read again: a message stamped below what was already read (the writer's clock was behind,
    // or it uploaded late) would otherwise stay missing on this computer for good. Reading a message twice changes nothing.
    // A second look longer than one pull's 40 pages keeps its place (chatDeepFrom) and goes on from there next pull, until it
    // reaches the newest row; only then is it done for the hour, so rows past the page limit are never skipped.
    const safety = overlap > 0, going = safety && !again && settings.chatDeepFrom ? String(settings.chatDeepFrom) : '';
    const deep = safety && !again && (Boolean(going) || Date.now() - (Number(settings.chatDeepAt) || 0) > CHAT_DEEP_MS);
    // The overlap is read again only until one safety look ran a minute past it after the newest row read (chatSettled): by
    // then a row from a clock up to the overlap behind is uploaded and was read, so the looks after it start at the last row
    // read. Measured from the last row, not from now, the overlap read an idle computer's own last rows on every look (L88).
    const settled = safety && !again && !deep && Boolean(since) && String(settings.chatSettled || '') === since;
    if (going) since = going;
    else if (since && !settled) { const time = parseInt(since.split('.')[0], 36) || 0; since = Math.max(0, time - (deep ? CHAT_DEEP_SPAN : overlap)).toString(36).padStart(9, '0'); }
    // Uploaded late, or by a computer whose clock is behind: the note names the oldest one, so it is read now, not lost.
    if (from && since && from <= since) since = justBelow(from);
    // Going on after a page limit: from the exact row it stopped at. Back to the start of that millisecond, more rows than one
    // look reads sharing it (a clock that moved back) were read again on every look and the rest never came.
    if (after) since = String(after);
    let finished = false;
    for (let page = 0; page < 40; page++) {
      const rows = await waitStep(`sync chat: cloud page ${page + 1}`, () => this.store.cloud.pullChat(since));
      // No answer (the cloud closed or not reached) is not an empty page: nothing is saved, and the hint stays for the next look.
      if (!Array.isArray(rows)) return false;
      // scanned and last count this computer's own rows too (TursoSync.pullChat), so the read position moves past them and
      // they are read once, not on every look (L88). The overlap, the note's from and the daily look still catch a late row.
      const count = rows?.scanned ?? rows?.length ?? 0, last = rows?.last || (rows?.length ? String(rows.at(-1).v) : '');
      if (!count) { finished = true; break; }
      if (rows.length) total += step(`sync chat: applyChatEvents (${rows.length} rows, page ${page + 1})`, () => this.store.applyChatEvents(rows));
      // Only a message newer than the last one read is a sign of life: the overlap reads the same last rows on every pull,
      // and counting those kept a computer that went off "online" forever (L26). An old message read for the first time is not either.
      step('sync chat: mark computers heard', () => { for (const row of rows) { const [time, , ...node] = String(row.v).split('.'); if (String(row.v) <= read || Date.now() - (parseInt(time, 36) || 0) > CLOUD_MS) continue; this.hear(node.join('.')); } });
      newest = last > newest ? last : newest; since = last;
      if (count < 500) { finished = true; break; }
    }
    // A look from a note that went on from the second look's place (chatDeepFrom) to the newest row finished that one too.
    const start = after || from, through = !deep && finished && start && settings.chatDeepFrom && start <= String(settings.chatDeepFrom);
    const look = deep && !finished ? { chatDeepFrom: since } : again || deep || through ? { chatDeepAt: Date.now(), chatDeepFrom: '' } : {};
    const calm = safety ? { chatSettled: newest && Date.now() >= (parseInt(newest.split('.')[0], 36) || 0) + overlap + SETTLE_MS ? newest : '' } : {};
    if (again || deep || newest !== String(settings.chatAt || '') || (safety && calm.chatSettled !== String(settings.chatSettled || ''))) step('sync chat: save read position', () => this.save({ chatAt: newest, chatNode: this.self.id, chatRead: 2, ...look, ...calm }));
    return finished ? { done: true, total } : { done: false, next: since, total };
  }
  // Messages written here before chats were shared (or while offline with nothing queued) go up once.
  // Only the computer running the agent: another computer's own unsent messages of that chat are a story of their own,
  // which the person settles by picking one chat (src/chat-split.js), never by mixing them in.
  pushChats() {
    const cloud = this.store.cloud; if (!cloud?.ready || !cloud.chatEvent) return 0;
    let sent = 0;
    for (const agent of this.store.list('specialist')) {
      if (!agent.runId || agent.node !== this.self.id || !this.store.syncedChat(agent.runId) || this.store.get('chatsplit', agent.id)?.open) continue;
      const rows = this.store.unsentEvents(agent.runId);
      if (!rows.length) continue;
      this.store.transaction(() => { for (const row of rows) cloud.chatEvent(row); });
      sent += rows.length;
    }
    if (sent) cloud.schedule();
    return sent;
  }

  // With the same Turso database on every computer, the chats also arrive from there, even while the other computer is off.
  // Like pullChats: a safety look starts two minutes back; one after a note starts where the note says (or at the last one read).
  // Answers like pullChats: false when the cloud could not be read, { done: false, next } at the page limit, true at the end.
  async pullTurso({ from = '', after = '', overlap = 120000 } = {}) {
    if (!this.store.cloud?.ready) return false;
    // Under another computer id (a restore that got its own), what was skipped as "this computer's own" is read again from the start.
    const settings = step('sync shared: read peer settings', () => this.settings()), again = settings.tursoNode !== this.self.id, at = again ? 0 : settings.tursoAt || 0;
    // Settled like pullChats: once a safety look ran a minute past the overlap after the newest row, the looks after it start at
    // that row's whole version (tursoSettled). tursoAt keeps only the time, and rows stamped in its last millisecond came back each look.
    const settled = overlap > 0 && !again && at > 0 && Boolean(settings.tursoSettled) && (parseInt(String(settings.tursoSettled).split('.')[0], 36) || 0) === at;
    let since = settled ? String(settings.tursoSettled) : `${Math.max(0, at - overlap).toString(36).padStart(9, '0')}`, newest = at, newestV = settled ? since : '';
    if (from && !again && from <= since) since = justBelow(from);
    if (after) since = String(after); // on after a page limit, from the exact row it stopped at (see pullChats)
    let finished = false;
    try {
      // Page by the last version read: more than one page of changes inside the 2-minute overlap (a first upload stamps
      // everything at once) would otherwise re-read the same first page on every poll and never get past it.
      for (let page = 0; page < 50; page++) {
        const rows = await waitStep(`sync shared: cloud page ${page + 1}`, () => this.store.cloud.pullShared(since));
        if (!Array.isArray(rows)) return false; // not reached: nothing saved, the hint stays
        if (rows?.length) step(`sync shared: applyAll (${rows.length} rows, page ${page + 1})`, () => this.applyAll(rows));
        // Anything new from a computer means it is on (its own stamp is only used to tell new from already seen).
        for (const row of rows || []) { const [time, , ...node] = String(row.v).split('.'), stamp = parseInt(time, 36) || 0, from = node.join('.'); if (from && stamp > ((this.newestFrom ||= new Map()).get(from) || 0)) { if (this.newestFrom.has(from)) this.hear(from); this.newestFrom.set(from, stamp); } }
        // Past this computer's own rows too (TursoSync.pullShared counts them in scanned and last), so they are read once (L88).
        const count = rows?.scanned ?? rows?.length ?? 0, last = rows?.last || (rows?.length ? String(rows.at(-1).v) : '');
        if (last) { newest = Math.max(newest, parseInt(last.split('.')[0], 36) || 0); if (last > newestV) newestV = last; }
        if (count < 400) { finished = true; break; }
        since = last;
      }
      const calm = overlap > 0 ? { tursoSettled: newestV && Date.now() >= (parseInt(newestV.split('.')[0], 36) || 0) + overlap + SETTLE_MS ? newestV : '' } : {};
      if (again || newest > at || (overlap > 0 && calm.tursoSettled !== String(settings.tursoSettled || ''))) step('sync shared: save read position', () => this.save({ tursoAt: newest, tursoNode: this.self.id, ...calm }));
      return finished ? true : { done: false, next: since };
    } catch { /* Turso shows its own state in Settings */ return false; }
  }
  // What this computer's agents are doing, as the other computers show it in their sidebar.
  mineStatus() {
    const mine = this.store.list('specialist').filter(agent => agent.kind !== 'main' && !this.isRemote(agent));
    return Object.fromEntries(mine.map(agent => [agent.id, this.desk.specialists.status(agent)]));
  }
  // write: this computer's heartbeat and agents go up too (every 30 s, and at once when an agent starts or stops working).
  // Without it only the other computers' rows are read, which is how a reply starting over there shows here within seconds.
  // read: false writes this computer's row only; the other computers' rows then come with their notes (L88).
  async presence({ write = true, read = true } = {}) {
    if (!this.store.cloud?.ready) return;
    try {
      const agents = write ? this.mineStatus() : null;
      const rows = write ? await this.store.cloud.presence(this.self.name, agents, { read }) : await this.store.cloud.readPresence?.();
      if (write) this.sentStatus = statusKey(agents);
      if (!rows || (write && !read)) return;
      const before = new Set([...(this.cloudSeen || new Map())].filter(([node]) => this.seen(node)).map(([node]) => node));
      const was = new Map([...(this.cloudSeen || new Map())].map(([node, row]) => [node, statusKey(row.agents)]));
      // A heartbeat that changed since the last look means that computer is on now, whatever its clock says.
      // One that said it is closing (at 0) is off now.
      for (const row of rows || []) { const before = this.cloudSeen?.get(row.node); if (!Number(row.at)) { this.heard?.delete(row.node); continue; } if (before ? before.at !== row.at : Math.abs(Date.now() - row.at) < CLOUD_MS) this.hear(row.node); }
      // What a note said a moment ago is newer than the cloud row it also wrote: the note's copy stays.
      this.cloudSeen = new Map((rows || []).map(row => { const noted = this.cloudSeen?.get(row.node); return [row.node, noted?.noted && noted.at >= Number(row.at) ? noted : row]; }));
      if ([...this.cloudSeen.keys()].some(node => this.seen(node) !== before.has(node)) || rows.some(row => was.get(row.node) !== statusKey(row.agents))) this.store.emit?.('change', { kind: 'peers' });
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
  // `artifacts`: the chat's artifact records when the caller already has them (the start-up pass reads them all once).
  copyChat(runId, artifacts = null) {
    const run = this.store.get('run', runId); if (!this.copies(run)) return;
    const trim = (value, max) => typeof value === 'string' && value.length > max ? `${value.slice(0, max)}â€¦` : value;
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
    const asks = this.store.listBy('interaction', 'runId', runId).filter(item => item.state === 'pending')
      .map(item => Object.fromEntries(Object.entries(item).filter(([, value]) => JSON.stringify(value ?? '').length < 20000)));
    // Saved (and sent to the cloud) only when the chat changed: saving the same copy again every few seconds kept the server busy.
    const body = JSON.stringify({ slim, events, asks });
    if ((this.copied ||= new Map()).get(runId) !== body) { this.copied.set(runId, body); this.store.put('chatcopy', runId, { id: runId, agentId: run.specialistId, run: slim, events, asks, at: now() }); }
    this.sharePictures(events, run.specialistId); this.shareEvidence(runId, run.specialistId, artifacts);
  }
  // Pictures and files the person attached in a shared chat or a room travel with it (up to 2 MB each), so they open on the
  // other computers too (L27: room files did not).
  sharePictures(events, agentId = '') {
    const uploads = path.resolve(this.store.media('uploads')).toLowerCase();
    for (const event of events) {
      for (const match of String(event.text || '').matchAll(/^- (.+)$/gm)) {
        const file = path.resolve(match[1].trim());
        if (!file.toLowerCase().startsWith(uploads + path.sep) || !existsSync(file)) continue;
        const id = chatFileId(file), size = statSync(file).size;
        if (size > PICTURE_BYTES || this.store.field('chatfile', id, 'size') === size) continue;
        this.store.put('chatfile', id, { id, path: file, name: path.basename(file), size, data: readFileSync(file).toString('base64'), agentId, at: now() });
      }
    }
  }
  // Files the person attached here, for an agent on another computer: each travels in the shared database, and that computer
  // saves its own copy and tells the agent where it is. A file over 8 MB stays here and the message says so.
  packFiles(text, target, agentId = '') {
    const uploads = path.resolve(this.store.media('uploads')).toLowerCase(), files = [];
    let note = '';
    for (const match of String(text).matchAll(/^- (.+)$/gm)) {
      const file = path.resolve(match[1].trim());
      if (!file.toLowerCase().startsWith(uploads + path.sep) || !existsSync(file)) continue;
      const size = statSync(file).size;
      if (size > CARRY_BYTES) { note += `\n(${path.basename(file)} is ${Math.round(size / 1048576)} MB, too big to send to another computer; it stays on ${this.self.name}.)`; continue; }
      const id = chatFileId(file);
      if (this.store.field('chatfile', id, 'size') !== size) this.store.put('chatfile', id, { id, path: file, name: path.basename(file), size, data: readFileSync(file).toString('base64'), for: target, agentId, at: now() });
      files.push({ id, path: match[1].trim(), name: path.basename(file) });
    }
    return { text: text + note, files };
  }
  // The files arrive with the command, or a few seconds after it; each is saved in this computer's uploads and the message
  // gets this computer's paths.
  async unpackFiles(input = {}) {
    let text = String(input.text || '');
    for (const file of input.files || []) {
      let item;
      for (let attempt = 0; attempt < 40 && !(item = this.store.get('chatfile', file.id))?.data; attempt++) await new Promise(resolve => setTimeout(resolve, 750));
      if (!item?.data) { text = text.split(file.path).join(`${file.path} (this file did not arrive from the other computer)`); continue; }
      // Saved under the same upload folder name as on the sending computer: the shared chat then names one file that both computers
      // find in their own uploads (L27: the sender's own picture turned into this computer's path and broke there).
      const sent = /[\\/]uploads[\\/]([0-9a-f-]{36})[\\/][^\\/]+$/i.exec(String(file.path || ''));
      const folder = path.join(this.store.media('uploads'), sent ? sent[1] : randomUUID()), target = path.join(folder, path.basename(file.name).replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'file');
      // The same file already here (sent before, or it came back) is used as it is; a different one under that name is never
      // overwritten: the incoming one gets a folder of its own.
      const data = Buffer.from(item.data, 'base64'); let saved = target;
      if (existsSync(target) && !readFileSync(target).equals(data)) saved = path.join(this.store.media('uploads'), randomUUID(), path.basename(target));
      if (!existsSync(saved)) { mkdirSync(path.dirname(saved), { recursive: true }); writeFileSync(saved, data, { flag: 'wx' }); }
      text = text.split(file.path).join(saved);
    }
    return text;
  }
  // A file attached on another computer gets a copy of its own here, in this computer's uploads under the same folder name,
  // as soon as it arrives in the shared database, so an agent here can open it (L27: only the other computer's F: path was known).
  // failed (optional): gets the reason when no copy could be saved.
  saveUpload(item, failed = {}) {
    const sent = /[\\/]uploads[\\/]([0-9a-f-]{36})[\\/][^\\/]+$/i.exec(String(item?.path || ''));
    if (!sent || !item.data) return '';
    const name = path.basename(String(item.name || '')).replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'file', data = Buffer.from(item.data, 'base64');
    // A different file already under that name is never handed out as this one: the incoming bytes get a folder of their own,
    // named by their content, so asking again finds the same copy.
    const same = file => { try { return readFileSync(file).equals(data); } catch { return false; } };
    let target = path.join(this.store.media('uploads'), sent[1], name);
    if (existsSync(target) && !same(target)) target = path.join(this.store.media('uploads'), `${sent[1]}-${createHash('sha256').update(data).digest('hex').slice(0, 12)}`, name);
    if (existsSync(target)) { if (same(target)) return target; failed.error = 'a different file is already in its place'; return ''; }
    try { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, data, { flag: 'wx' }); return target; } catch (error) { if (same(target)) return target; failed.error = error.code || error.message; return ''; }
  }
  // A room message and its attached files sync as separate rows: before an agent here starts on it, the files that are not here
  // yet are waited for (one shared deadline for all of them), so the agent never starts with the other computer's path only.
  // One that still has not come (over 2 MB, or the other computer went away) is said so in the prompt.
  // remote: the message came from another computer. Its files are waited for by their synced bytes only: a file under that name
  // here may be a different one, so a path is never trusted by name alone (localFiles).
  async arrivedFiles(text, { wait = 15000, step = 500, remote = false } = {}) {
    const missing = () => [...String(text ?? '').matchAll(/^- (.+)$/gm)].map(match => match[1].trim())
      .filter(file => /[\\/]uploads[\\/][0-9a-f-]{36}[\\/][^\\/]+$/i.test(file) && (remote || !existsSync(file)) && ![chatFileId(file), legacyFileId(file)].some(id => this.store.get('chatfile', id)?.data));
    for (const until = Date.now() + wait; missing().length && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, step));
    const late = new Set(missing());
    return this.localFiles(text, { remote }).replace(/^- (.+)$/gm, (line, named) => late.has(named.trim()) ? `${line} (this file did not arrive from the other computer)` : line);
  }
  // What an agent here reads names this computer's copy of each attached file, not the path on the computer it was attached on.
  // A path that also exists here is used only when its bytes are the ones that arrived (saveUpload compares them); a file that
  // arrived but could not be saved here is said so, never left as the other computer's path. A file with no copy in the shared
  // database is one attached here, or one not arrived yet (arrivedFiles says so), and stays as it is.
  // In a message from another computer (remote), a file whose bytes are not here is named without its path, so the agent never
  // opens whatever file sits at that path here.
  localFiles(text, { remote = false } = {}) {
    return String(text ?? '').replace(/^- (.+)$/gm, (line, named) => {
      const file = named.trim();
      if (!/[\\/]uploads[\\/][0-9a-f-]{36}[\\/][^\\/]+$/i.test(file)) return line;
      const item = [chatFileId(file), legacyFileId(file)].map(id => this.store.get('chatfile', id)).find(found => found?.data);
      if (!item) return remote ? `- ${file.split(/[\\/]/).pop()} (this file did not arrive from the other computer; it is not on this one)` : line;
      // A copy that could not be saved is named only by its file name and the reason: the path may hold other bytes here.
      const failed = {}, saved = this.saveUpload({ ...item, path: file }, failed);
      return saved ? `- ${saved}` : `- ${file.split(/[\\/]/).pop()} (this file came from the other computer but could not be saved on this one: ${failed.error || 'unknown error'})`;
    });
  }
  // Screenshots an agent saved as evidence in the chat travel with it too (up to 2 MB each).
  shareEvidence(runId, agentId = '', artifacts = null) {
    for (const artifact of (artifacts || this.store.listBy('artifact', 'runId', runId)).filter(item => PICTURE.test(item.file) || isPageArtifact(item))) {
      const file = path.join(this.store.media('artifacts'), runId, path.basename(artifact.file));
      if (!existsSync(file)) continue;
      const id = evidenceId(runId, artifact.file), size = statSync(file).size;
      if (size > PICTURE_BYTES || this.store.field('chatfile', id, 'size') === size) continue;
      this.store.put('chatfile', id, { id, path: `evidence:${runId}/${artifact.file}`, name: path.basename(artifact.file), size, data: readFileSync(file).toString('base64'), agentId, at: now() });
    }
  }
  // A page or file an agent shared on another computer: written here from the shared copy of the chat, so it opens like any local file.
  restoreEvidence(runId, file) {
    const item = this.store.get('chatfile', evidenceId(runId, file)); if (!item?.data) return false;
    const folder = path.join(this.store.media('artifacts'), runId), target = path.join(folder, path.basename(file));
    mkdirSync(folder, { recursive: true }); writeFileSync(target, Buffer.from(item.data, 'base64')); return true;
  }
  evidencePicture(runId, file) {
    const item = this.store.get('chatfile', evidenceId(runId, file));
    return item?.data && PICTURE.test(item.name) ? { name: item.name, data: Buffer.from(item.data, 'base64') } : null;
  }
  // One picture or file from another computer's chat or room, when it is not on this one.
  chatPicture(file) {
    const item = [chatFileId(file), legacyFileId(file)].map(id => this.store.get('chatfile', id)).find(found => found?.data);
    return item?.data ? { name: item.name, data: Buffer.from(item.data, 'base64'), picture: PICTURE.test(item.name) } : null;
  }
  watchChats() {
    if (this.watching) return; this.watching = true;
    const waiting = new Map();
    this.store.on?.('change', event => {
      const runId = event.kind === 'event' ? event.runId : event.kind === 'run' ? event.id : event.kind === 'interaction' ? this.store.get('interaction', event.id)?.runId || '' : '';
      if (!runId || waiting.has(runId)) return;
      const timer = setTimeout(() => { waiting.delete(runId); try { this.copyChat(runId); } catch { /* the next change tries again */ } }, 4000);
      timer.unref?.(); waiting.set(runId, timer);
    });
    // The chats that were there before this computer started sharing them.
    // Every personal chat of the last 30 days, not only the one each agent is in now, so older conversations show too.
    // It runs in the background, one chat at a time with a pause between them, and reads the artifact list once: done in
    // one go (and reading every artifact again for each chat) it held the server for minutes on a large workspace on a hard
    // disk, so nothing answered and the window stayed black.
    const since = Date.now() - 30 * 86400000;
    const runs = this.store.list('run').filter(run => this.copies(run) && Date.parse(run.updatedAt || run.createdAt || 0) > since).map(run => run.id);
    if (!runs.length) return;
    const byRun = new Map();
    for (const artifact of this.store.list('artifact')) { if (!byRun.has(artifact.runId)) byRun.set(artifact.runId, []); byRun.get(artifact.runId).push(artifact); }
    this.sharing = (async () => {
      for (const runId of runs) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (this.stopped) return;
        try { this.copyChat(runId, byRun.get(runId) || []); } catch { /* not a personal chat */ }
      }
    })();
  }
  // When this computer still has an old local run for a chat whose agent now lives on another computer, that other
  // computer's copy is the live one and wins: the chat then shows the real state and messages forward to where the agent
  // is, instead of getting stuck on the stale copy left here. A chat whose agent lives here keeps using the local run.
  copyWins(copy) {
    if (!copy || !copy.node || copy.node === this.self.id) return false;
    const local = this.store.get('run', copy.id);
    if (!local) return true;
    const agent = local.specialistId ? this.store.get('specialist', local.specialistId) : null;
    return Boolean(agent && this.isRemote(agent) && copy.node === agent.node);
  }
  // Another computer's chat, read from its copy: only when it is not here and not reached directly.
  chatCopy(runId) {
    if (this.runOwner(runId)) return null;
    const copy = this.store.get('chatcopy', runId);
    return this.copyWins(copy) ? copy : null;
  }
  cloudRuns() {
    const direct = new Set(this.remoteRuns().map(run => run.id));
    return this.store.list('chatcopy').filter(copy => copy.run && !direct.has(copy.id) && this.copyWins(copy))
      .map(copy => ({ ...copy.run, remote: copy.node, cloudCopy: true }));
  }
  cloudInteractions() {
    const direct = new Set(this.remoteInteractions().map(item => item.id));
    return this.store.list('chatcopy').filter(copy => !direct.has(copy.id) && !this.runOwner(copy.id) && this.copyWins(copy))
      .flatMap(copy => (copy.asks || []).filter(item => !direct.has(item.id) && !(this.answered ||= new Set()).has(item.id)).map(item => ({ ...item, remote: copy.node, cloudCopy: true })));
  }
  askCopy(interactionId) {
    if (this.store.get('interaction', interactionId) || this.interactionOwner(interactionId)) return null;
    return this.store.list('chatcopy').find(copy => copy.node && copy.node !== this.self.id && (copy.asks || []).some(item => item.id === interactionId)) || null;
  }
  // Keys for a file on the computer the agent works on, typed here: locked with that request's one-time lock before they leave.
  sealFileAnswer(copy, interactionId, values = {}) {
    const ask = (copy.asks || []).find(item => item.id === interactionId);
    if (!ask || ask.kind !== 'file' || !ask.request?.lockKey) throw new Error(`Open this file on ${this.deviceName(copy.node)} to fill it in.`);
    const wanted = new Set(ask.request.keys || []), chosen = Object.fromEntries(Object.entries(values || {}).filter(([key, value]) => wanted.has(key) && typeof value === 'string' && value.trim()).map(([key, value]) => [key, value.trim()]));
    if (!Object.keys(chosen).length) throw new Error('Fill in at least one value first.');
    return this.answerAsk(copy, interactionId, { action: 'accept', sealed: seal(ask.request.lockKey, chosen) });
  }
  answerAsk(copy, interactionId, answer) {
    const id = randomUUID();
    this.store.put('peercmd', id, { id, target: copy.node, action: 'answer', runId: copy.id, agentId: copy.agentId, input: { interactionId, answer }, at: now(), done: false });
    (this.answered ||= new Set()).add(interactionId);
    return { queued: true, message: this.online(copy.node) ? `Answer sent to ${this.deviceName(copy.node)}.` : `${this.deviceName(copy.node)} is off. The answer reaches it when it is back on.` };
  }
  // The person writes in a chat whose agent is on another computer: straight there when it is reached directly, otherwise
  // as a command in the shared database that the agent's computer runs within seconds (or when it is back on).
  // sendId: a message kept while its agent moved here (L114) keeps its own id as the command's id, so passing it on again after a
  // crash finds the command already written and does not send it twice.
  async chatAction(copy, action, input = {}, { shown = null, sendId = '' } = {}) {
    if (!['say', 'resume', 'stop'].includes(action)) throw new Error(`Open this chat on ${this.deviceName(copy.node)} to do that.`);
    const text = String(input.text || input.prompt || '').slice(0, 20000);
    if (action !== 'stop' && !text.trim()) throw new Error('Write a message first.');
    if (sendId && this.store.get('peercmd', `send-${sendId}`)) return { queued: true };
    if (action !== 'stop' && this.store.get('chatsplit', copy.agentId)?.open) throw new Error('This agent has two different chats on your computers. Pick the one to keep first.');
    const id = sendId ? `send-${sendId}` : randomUUID(), packed = action === 'stop' ? { text, files: [] } : this.packFiles(text, copy.node, copy.agentId);
    // The message shows in this computer's copy of the shared chat at once and reaches the others with its own id; the
    // computer running the agent passes it on without writing it again.
    if (action !== 'stop' && this.store.syncedChat(copy.id)) {
      if (!shown?.uid) this.store.event(copy.id, 'human-message', { text: keepLines(text), via: 'rex', from: this.self.id }, true);
      const row = shown?.uid ? shown : this.store.db.prepare('SELECT uid, kind, visible, value, created_at FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT 1').get(copy.id);
      // The message itself travels with the command, so the agent's computer shows it before the answer to it.
      if (row?.uid) { packed.uid = row.uid; packed.echo = { ...row }; }
    }
    this.store.put('peercmd', id, { id, target: copy.node, action: `chat-${action === 'stop' ? 'stop' : 'say'}`, runId: copy.id, agentId: copy.agentId, input: packed, at: now(), done: false });
    const name = this.store.get('specialist', copy.agentId)?.name || 'The agent';
    return { queued: true, message: this.online(copy.node) ? `Sent to ${name} on ${this.deviceName(copy.node)}. The reply shows here in a few seconds.` : `${this.deviceName(copy.node)} is off. ${name} gets this when it is back on.` };
  }

  // ---------- notes between this account's computers, through the relay line (L88) ----------
  // The line is up and the cloud database is in use: changes are told by note, and the cloud is only looked at now and then.
  linked() { return Boolean(this.store.cloud?.ready && this.desk.phoneRelay?.online); }
  // A note is sealed with the account's own key, so the relay and anyone else on the way can only pass it on.
  note(extra = {}) {
    const cloud = this.store.cloud; if (!cloud?.ready || !this.desk.phoneRelay?.online) return false;
    const body = { w: cloud.workspace, n: this.self.id, at: Date.now(), ...extra };
    let text = JSON.stringify(body);
    if (text.length > NOTE_BYTES) { delete body.rows; delete body.records; body.more = true; text = JSON.stringify(body); }
    return this.desk.phoneRelay.sync(this.store.encrypt(text));
  }
  // An upload went through: the other computers hear what it carried. With the line down, the oldest versions are kept and told
  // when it is back, so the other computers still read rows that were uploaded late.
  uploaded({ shared = '', chat = '', rows = [], records = [] } = {}) {
    if (!shared && !chat) return;
    if (this.note({ shared, chat, rows, records })) return;
    const kept = this.unsent || {};
    this.unsent = { shared: older(kept.shared, shared), chat: older(kept.chat, chat) };
  }
  // The line came up (again): the other computers hear this one is on, with anything uploaded while it was down, and this one
  // looks at the cloud once for what it missed meanwhile.
  relayUp() {
    const kept = this.unsent || {}; this.unsent = null;
    this.note({ shared: kept.shared || '', chat: kept.chat || '', p: { name: this.self.name, agents: this.mineStatus() } });
    this.catchUp = true; this.kick?.();
  }
  // Rex Desk is closing: the other computers show this one as off at once.
  goodbye() { try { this.note({ bye: true }); } catch { /* closing anyway */ } }
  // A note from another computer of this account.
  onSync(text) {
    let body; try { body = JSON.parse(this.store.decrypt(String(text))); } catch { return; }
    if (!body || body.w !== this.store.cloud?.workspace || !body.n || body.n === this.self.id) return;
    const node = String(body.n);
    (this.noted ||= new Map()).set(node, Date.now());
    if (body.bye) { this.heard?.delete(node); this.store.emit?.('change', { kind: 'peers' }); return; }
    const was = this.seen(node); this.hear(node);
    if (body.p) {
      const before = this.cloudSeen?.get(node);
      (this.cloudSeen ||= new Map()).set(node, { node, name: String(body.p.name || before?.name || ''), at: Date.now(), agents: body.p.agents || {}, noted: true });
      if (!was || statusKey(before?.agents) !== statusKey(body.p.agents)) this.store.emit?.('change', { kind: 'peers' });
    } else if (!was) this.store.emit?.('change', { kind: 'peers' });
    // What rode inside the note is applied as it is: nothing is read from the cloud for it.
    const due = this.due ||= {};
    if (Array.isArray(body.records) && body.records.length) {
      step('sync note: records', () => this.applyAll(body.records));
      const seen = this.store.cloud?.pulled; if (seen) for (const item of body.records) seen.set(`${item.kind}\u001f${item.id}`, item.v);
    }
    if (Array.isArray(body.rows) && body.rows.length) step('sync note: chat messages', () => this.store.applyChatEvents(body.rows));
    // Each hint goes through hint(): a look's exact place stays apart from it, and one that comes during a look outlives that look.
    if (body.shared && (body.more || !Array.isArray(body.records))) this.hint('shared', String(body.shared));
    if (body.chat && (body.more || !Array.isArray(body.rows))) this.hint('chat', String(body.chat));
    if ('shared' in due || 'chat' in due) this.kick?.();
  }
  // A note's rewind hint (the oldest row it uploaded). A look going on after its page limit keeps its exact place (cursor);
  // only a hint below that place rewinds it, and then the look starts at the hint (rows from there on were not all read yet).
  // A hint at or past the place changes nothing: the look reaches it anyway (the row at the place itself was read). During a
  // look the hint waits in lateHint, and is applied the same way once the look is over, whatever it answered (see start).
  hint(part, at) {
    if ((this.reading || {})[part]) { const late = this.lateHint ||= {}; late[part] = older(late[part], at); return; }
    const due = this.due ||= {}, cursor = this.cursor ||= {};
    if (cursor[part]) { if (at < cursor[part]) { delete cursor[part]; due[part] = at; } else due[part] ||= at; return; }
    due[part] = older(due[part], at);
  }
  // Another computer that is on but sends no notes (its line is down, or it runs a version without them): it is still looked
  // for in the cloud every FALLBACK_MS.
  quietPeer() {
    const noted = this.noted || new Map();
    return [...(this.cloudSeen?.keys() || [])].some(node => this.seen(node) && Date.now() - (noted.get(node) || 0) > 3 * BEAT_MS);
  }

  // ---------- the loop ----------
  start() {
    this.pendingCommands(); this.watchChats(); this.refreshSecure();
    // Each step gets at most this long. A cloud call that never answers (a dropped connection, a laptop waking from sleep)
    // used to hold the loop for good: nothing new arrived from the other computers until Rex Desk was restarted.
    const bounded = (step, ms = this.stepMs ?? STEP_MS) => Promise.race([Promise.resolve().then(step).catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); })]);
    const tick = async () => {
      for (const peer of this.settings().peers) {
        if (this.timers.get(peer.id) > Date.now()) continue;
        await bounded(() => this.pullFrom(peer));
        this.timers.set(peer.id, Date.now() + (this.direct(peer.id) ? 2500 : 10000));
      }
      // The cloud is read when a note says something new is there (only from there on), and otherwise only for a safety look:
      // every SAFETY_MS with the relay line up, every FALLBACK_MS without it (L88). Nothing polls it every second any more.
      this.desk.phoneRelay?.ensure?.();
      const linked = this.linked(), safety = linked && !this.quietPeer() ? SAFETY_MS : FALLBACK_MS, due = this.due ||= {}, catchUp = this.catchUp; this.catchUp = false;
      for (const [part, pull] of [['shared', options => this.pullTurso(options)], ['chat', options => this.pullChats(options)]]) {
        // A note's hint (where its rows start) goes with the safety look too, and stays until a look read to the end: dropped at
        // the start, a look that failed or timed out lost a late row stamped below the settled read position (L88 review).
        // The hint is cleared only by a look that says it read to the end. One that failed, timed out or found the cloud not there
        // leaves it as it was; one that stopped at its page limit leaves where it stopped instead (rows below that are read), and
        // the next look goes on from there MORE_MS later. A note that came during the look keeps its own hint.
        const timer = part === 'shared' ? 'turso' : 'chat', from = due[part], more = this.more ||= {}, cursor = this.cursor ||= {}, after = cursor[part];
        const read = async options => {
          const reading = this.reading ||= {}, late = this.lateHint ||= {};
          reading[part] = true; delete late[part];
          let result;
          try { result = await bounded(async () => { const answer = await pull(options); return answer === false ? null : answer && typeof answer === 'object' ? answer : { done: true }; }); }
          finally { reading[part] = false; doing(''); }
          const later = late[part]; delete late[part];
          // Read to the end: the hint and the place are done. Stopped at its page limit: the exact place is kept apart from the
          // hints, and the look goes on strictly after it. Failed, timed out or the cloud not there: both stay as they were.
          if (result?.done) { delete cursor[part]; if (due[part] === from) delete due[part]; }
          else if (result?.next) { cursor[part] = String(result.next); due[part] ||= String(result.next); more[part] = Date.now() + (this.moreMs ?? MORE_MS); }
          // A note that came during the look, after any of these: a hint below the place rewinds the next look to it (L88 review).
          if (later) this.hint(part, later);
        };
        const options = after ? { after } : from ? { from } : undefined;
        if (catchUp || (this.timers.get(timer) || 0) <= Date.now()) { this.timers.set(timer, Date.now() + safety); await read(options); }
        else if ((part in due || after) && (more[part] || 0) <= Date.now()) await read({ ...options, overlap: 0 });
        else if ((this.timers.get(timer) || 0) > Date.now() + safety) this.timers.set(timer, Date.now() + safety);
      }
      if ((this.timers.get('chatpush') || 0) <= Date.now()) { this.timers.set('chatpush', Date.now() + 60000); try { step('sync: settling split chats', () => this.desk.chatSplits?.settleAll()); step('sync: detecting split chats', () => this.desk.chatSplits?.detect()); step('sync: pushing chat messages', () => this.pushChats()); } catch { /* tried again in a minute */ } finally { doing(''); } }
      // Rex Desk tasks from another computer: a number both computers gave out is settled (LocalTasks.settle).
      if (this.tasksArrived || (this.timers.get('tasks') || 0) <= Date.now()) { this.tasksArrived = false; this.timers.set('tasks', Date.now() + 60000); await bounded(() => this.desk.localTasks?.settle()); }
      if ((this.timers.get('commands') || 0) <= Date.now()) { this.timers.set('commands', Date.now() + 3000); this.pendingCommands(); }
      // An agent here started or stopped working: the other computers hear it now, by note, and the cloud row is written too.
      const cloud = this.store.cloud?.ready, changed = cloud && this.sentStatus !== undefined && statusKey(this.mineStatus()) !== this.sentStatus;
      if (linked && (changed || (this.timers.get('beat') || 0) <= Date.now())) { this.timers.set('beat', Date.now() + BEAT_MS); const agents = this.mineStatus(); if (this.note({ p: { name: this.self.name, agents } })) this.sentStatus = statusKey(agents); }
      // The cloud row: every CLOUD_BEAT_MS with the line up (written only, unless a computer without notes is on or it is the
      // safety look), every 30 s without it.
      if (changed || catchUp || (this.timers.get('presence') || 0) <= Date.now()) {
        const read = !linked || catchUp || this.quietPeer() || (this.timers.get('presence') || 0) <= Date.now();
        this.timers.set('presence', Date.now() + (linked ? CLOUD_BEAT_MS : 30000)); this.timers.set('look', Date.now() + LOOK_MS); await bounded(() => this.presence({ read }));
      }
      // While another computer is on that sends no notes, its agents' state is read every LOOK_MS (one small row per computer).
      else if (cloud && (this.timers.get('look') || 0) <= Date.now() && (linked ? this.quietPeer() : [...(this.cloudSeen?.keys() || [])].some(node => this.seen(node)))) { this.timers.set('look', Date.now() + LOOK_MS); await bounded(() => this.presence({ write: false })); }
      if ((this.timers.get('secure') || 0) <= Date.now()) { this.timers.set('secure', Date.now() + 300000); this.refreshSecure(); }
    };
    // A note runs the next tick at once, so a change from another computer shows here within a moment, not at the next second.
    const run = () => { if (this.ticking) { this.again = true; return; } this.ticking = true; void tick().finally(() => { this.ticking = false; if (this.again) { this.again = false; run(); } }); };
    this.kick = () => { if (!this.stopped) run(); };
    // Uploads done here are told to the other computers.
    if (this.store.cloud) this.store.cloud.onUploaded = info => this.uploaded(info);
    this.loop = setInterval(run, 1000);
    this.loop.unref?.();
  }
  stop() { clearInterval(this.loop); this.stopped = true; if (this.store.cloud?.onUploaded) this.store.cloud.onUploaded = null; }
  selfUrl() { return this.port ? this.addresses(this.port).find(address => address.startsWith('http://')) || '' : ''; }
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

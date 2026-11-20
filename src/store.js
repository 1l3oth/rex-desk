import { aiProvider } from './codex.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { issueBranch } from './branches.js';
import { validateFlowRuntime } from './flow-runtime.js';
import { validateElectronRuntime } from './electron-runtime.js';
import { TursoSync } from './turso.js';

// Where an issue stands in Rex Desk itself. The tracker keeps its own status; this one is for the people and agents
// working here, and anyone may change it.
export const deskStatuses = [['new', 'New'], ['investigating', 'Investigating'], ['waiting', 'Waiting'], ['ready', 'Ready to fix'],
  ['fixing', 'Fixing'], ['review', 'In review'], ['done', 'Done here'], ['parked', 'Parked']];
export const deskStatusLabels = Object.fromEntries(deskStatuses);
export const deskStatus = value => (deskStatusLabels[String(value || '').trim().toLowerCase()] ? String(value).trim().toLowerCase() : '');
export const now = () => new Date().toISOString();
// Records sync between computers through Turso, but each computer has its own main agent: its runs carry this computer's name.
export const thisComputer = () => process.env.REX_COMPUTER_NAME || os.hostname();
export const isLocalMain = run => run?.role === 'coordinator' && Boolean(run.main) && !run.roomAgent && run.computer === thisComputer();
export const latestLocalMain = runs => runs.filter(isLocalMain).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
// Records every computer of the person shares (see peers.js). The Rex Agent record is each computer's own.
// Rex Desk's own tasks (ids "local:...") are shared too; tasks from Flow, Morningmate or Orbit come from their tracker on
// each computer and stay out.
export const SHARED = new Set(['room', 'roommsg', 'specialist', 'peercmd', 'chatcopy', 'chatfile', 'chatsplit', 'task', 'pin', 'agentnote', 'agentnotehist']);
// What the person can leave out of the cloud backup (Settings, Backup and updates). Agents, rooms, projects and settings
// always go up: they are what makes the desk follow the person to another computer.
export const BACKUP_PARTS = { chats: true, rooms: true, tasks: true, files: true };
const BACKUP_PART = { roommsg: 'rooms', task: 'tasks', priority: 'tasks', chatfile: 'files', artifact: 'files' };
export const shared = (kind, key) => SHARED.has(kind) && !(kind === 'specialist' && key === 'main') && !(kind === 'task' && !String(key).startsWith('local:')) && !(kind.startsWith('agentnote') && String(key).startsWith('main:'));
export const id = () => randomUUID();
// A task's comments from two computers, each once, oldest first; null when `other` adds nothing to `base`.
const commentKey = item => `${item?.at}\u001f${item?.by}\u001f${item?.text}`;
function mergeComments(base, other) {
  const known = new Set((base.comments || []).map(commentKey)), extra = (other.comments || []).filter(item => !known.has(commentKey(item)));
  if (!extra.length) return null;
  return [...(base.comments || []), ...extra].sort((left, right) => String(left.at).localeCompare(String(right.at))).slice(-200);
}
export const defaults = {
  name: 'Rex', notify: true, provider: 'claude', concurrency: 2, branchPrefix: 'rex-desk',
  syncMinutes: 5, reportToOrbit: false, autoPrLowRisk: false, sources: [], repositories: [],
  models: { claude: '' }, agentProfiles: { claude: null }, tourDismissed: false, execution: 'headless', defaultMode: 'bypassPermissions',
  schedule: { enabled: false, time: '09:00', days: [1, 2, 3, 4, 5], fix: true, maxRuns: 6 }, jev: { model: '', auto: true, versions: '' }, testAccounts: [],
  // Computer control: on for the person here, with a yes asked before shutdown-like actions; agents only when allowed.
  // allow: actions that run without asking even though they normally ask (the person chose "Yes, always"). Closing an app is simple and asks no more.
  control: { enabled: true, confirm: true, agents: false, language: 'en', allow: ['quit_app'] },
  // Agents act on their own: start work and open draft pull requests without asking. Nothing is ever merged.
  autonomy: true,
};
// Claude Code accepts family aliases (opus, sonnet, haiku, fable) or full IDs such as claude-opus-5-5. Typed shorthand is normalized.
export function modelName(provider, value) {
  const text = String(value || '').trim();
  if (!text || provider !== 'claude') return text;
  const shorthand = text.toLowerCase().match(/^(?:claude[\s-]*)?(opus|sonnet|haiku|fable)(?:[\s-]*(\d+)(?:[.\s-]+(\d+))?)?$/);
  if (!shorthand) return text;
  const [, family, major, minor] = shorthand;
  return major ? `claude-${family}-${major}${minor ? `-${minor}` : ''}` : family;
}
function scheduleSettings(input = {}) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ? input.time : defaults.schedule.time;
  const days = [...new Set((Array.isArray(input.days) ? input.days : defaults.schedule.days).map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
  const maxRuns = Number.isInteger(Number(input.maxRuns)) ? Math.min(20, Math.max(1, Number(input.maxRuns))) : defaults.schedule.maxRuns;
  return { enabled: Boolean(input.enabled), time, days, fix: input.fix !== false, maxRuns };
}
// null keeps the profile inherited from the launching terminal; '' selects the CLI's default home folder.
function agentProfile(value, name) {
  if (value === undefined || value === null) return null;
  const folder = String(value).trim();
  if (!folder) return '';
  if (!path.isAbsolute(folder)) throw new Error(`${name} profile must be an absolute folder.`);
  try { if (!statSync(folder).isDirectory()) throw new Error(); } catch { throw new Error(`${name} profile folder does not exist: ${folder}`); }
  return path.resolve(folder);
}

// A counted or limited token is a size, not a credential, so a name such as max_tokens or token_count keeps its value.
const sizeWords = new Set(['max', 'min', 'num', 'count', 'total', 'used', 'usage', 'budget', 'limit', 'remaining', 'input', 'output', 'cache', 'per', 'size', 'length']);
const keyWords = key => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const secretKey = key => /api.?key|secret|password|passphrase|authorization|credential|token/i.test(key)
  && !keyWords(key).some(word => sizeWords.has(word));
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, secretKey(key) ? '[redacted]' : redact(item)]));
}

export class Store extends EventEmitter {
  // A workspace opened through an account passes its unsealed key; a plain data folder keeps vault.key beside the database.
  constructor(directory, { key, auth, cloud } = {}) {
    super();
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.directory, 'artifacts'), { recursive: true });
    if (key) this.key = Buffer.from(key);
    else {
      const keyPath = path.join(this.directory, 'vault.key');
      if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
      this.key = readFileSync(keyPath);
    }
    this.auth = auth;
    this.db = new DatabaseSync(path.join(this.directory, 'desk.sqlite'));
    // On a busy hard disk every save waited for the disk to confirm it (synchronous FULL), and with SQLite's 2 MB cache almost
    // every read went to the disk too, so the server stopped answering for minutes. In WAL mode NORMAL is still safe from
    // corruption (a power cut can lose only the last moments); the 64 MB cache keeps the pages in use in memory.
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT, visible INTEGER, value TEXT, created_at TEXT);
      CREATE INDEX IF NOT EXISTS event_run ON events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS event_run_time ON events(run_id, created_at);`);
    this.fresh = !this.get('config', 'main');
    if (this.fresh) this.put('config', 'main', defaults);
    let token = this.get('secret', 'mcp-token');
    if (!token) { token = this.encrypt(randomBytes(32).toString('base64url')); this.put('secret', 'mcp-token', token); }
    this.token = this.decrypt(token);
    this.migrateConfig();
    this.cloud = new TursoSync(this, cloud);
    // This computer's id, and a log of changed shared records that the person's other computers read from.
    // A data folder from before node.id existed keeps the workspace id it always used. A new folder gets its own id, so two
    // computers that restored the same account never speak for each other (a restore may take over the old id, see turso.js).
    const nodeFile = path.join(this.directory, 'node.id');
    if (!existsSync(nodeFile)) writeFileSync(nodeFile, this.fresh ? randomUUID() : this.cloud.workspace, { mode: 0o600 });
    this.nodeId = readFileSync(nodeFile, 'utf8').trim() || this.cloud.workspace; this.clock = 0;
    this.db.exec('CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)');
    // Every message has one id on every computer: <computer id>.<its number on that computer>. A message from another
    // computer keeps its id, so bringing it in twice changes nothing (docs/design/cross-device-chat.md).
    const columns = this.db.prepare('PRAGMA table_info(events)').all().map(column => column.name);
    if (!columns.includes('uid')) this.db.exec('ALTER TABLE events ADD COLUMN uid TEXT');
    // pushed: this computer's message is on its way to the others (in the cloud outbox).
    if (!columns.includes('pushed')) this.db.exec('ALTER TABLE events ADD COLUMN pushed INTEGER');
    this.db.prepare("UPDATE events SET uid = ? || '.' || sequence WHERE uid IS NULL").run(this.nodeId);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS event_uid ON events(uid)');
    if (!this.get('meta', 'changes-backfilled')) {
      this.transaction(() => {
        for (const kind of SHARED) for (const row of this.db.prepare('SELECT id, value FROM records WHERE kind=?').all(kind)) {
          if (!shared(kind, row.id)) continue;
          const value = JSON.parse(row.value);
          this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify({ ...value, node: value.node || this.nodeId, _v: value._v || this.stamp() }), kind, row.id);
          this.db.prepare('INSERT INTO changes(kind,id) VALUES(?,?)').run(kind, row.id);
        }
        this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)').run('meta', 'changes-backfilled', JSON.stringify({ at: now() }));
      });
    }
    // Rex Desk tasks joined the shared records later: the ones already here get a version and go to the other computers once.
    // Without node they count as made here, so a number two computers both gave out is settled by its date (LocalTasks.settle).
    if (!this.get('meta', 'tasks-shared')) {
      this.transaction(() => {
        for (const task of this.list('task')) if (shared('task', task.id)) this.put('task', task.id, task);
        this.put('meta', 'tasks-shared', { at: now() });
      });
    }
    // Running processes cannot be resurrected after a crash. Keep their history and make recovery explicit.
    const reattached = new Set();
    for (const run of this.list('run')) {
      if (!['running', 'queued', 'waiting', 'verifying', 'starting'].includes(run.state)) continue;
      // An agent in its own process (src/agent-host.js) keeps working through a restart; Rex Desk follows it again.
      if (run.host && ['running', 'waiting', 'starting'].includes(run.state)) { this.put('run', run.id, { ...run, state: 'running', reattach: 'host' }); reattached.add(run.id); }
      else this.put('run', run.id, { ...run, state: 'interrupted', endedAt: now(), error: 'Server restarted. Resume this run to continue.' });
    }
    for (const key of this.list('token')) if (!reattached.has(key.runId)) this.delete('token', key.id);
    for (const prompt of this.list('interaction')) {
      if (prompt.state === 'pending') this.put('interaction', prompt.id, { ...prompt, state: 'expired' });
    }
  }

  get(kind, key) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, key);
    return row ? JSON.parse(row.value) : undefined;
  }
  // Parsed rows are cached per kind: /state rebuilds a dozen lists on every refresh, and re-reading and re-parsing every
  // record each time was the main cost that grew with use. The cache is dropped for a kind whenever one of its records is
  // written or removed (put/delete, including changes pulled from another computer, which go through them). A copy is
  // returned so a caller that sorts or trims the list in place can never disturb the cache.
  list(kind) {
    this.lists ??= new Map();
    let cached = this.lists.get(kind);
    if (!cached) { cached = this.db.prepare('SELECT value FROM records WHERE kind=?').all(kind).map(row => JSON.parse(row.value)); this.lists.set(kind, cached); }
    return cached.slice();
  }
  // Drop the whole list cache. Code that writes records with raw SQL instead of put/delete (a cloud restore loading many
  // records at once) must call this after, so a later list() does not read a stale copy.
  clearListCache() { this.lists?.clear(); }
  // Only the records whose field has this value, filtered by the database: no need to read and parse every record of the kind.
  listBy(kind, field, value) { return this.db.prepare(`SELECT value FROM records WHERE kind=? AND json_extract(value, '$.' || ?)=?`).all(kind, field, value).map(row => JSON.parse(row.value)); }
  // One field of one record, without reading the rest (a shared file's size, without its data).
  field(kind, key, field) { return this.db.prepare(`SELECT json_extract(value, '$.' || ?) AS field FROM records WHERE kind=? AND id=?`).get(field, kind, key)?.field; }
  // Nested calls join the open transaction, so many saves can share one write to disk.
  transaction(callback) {
    if (this.inTransaction) return callback();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = callback(); this.inTransaction = false; this.db.exec('COMMIT'); return result; }
    catch (error) { this.inTransaction = false; this.db.exec('ROLLBACK'); throw error; }
  }
  // A version that sorts by time, then by computer, so the newest change wins on every computer.
  stamp() { this.clock = (this.clock + 1) % 1679616; return `${Date.now().toString(36).padStart(9, '0')}.${this.clock.toString(36).padStart(4, '0')}.${this.nodeId}`; }
  logChange(kind, key, deleted = false) {
    if (!shared(kind, key) || !this.nodeId) return;
    this.db.prepare('DELETE FROM changes WHERE kind=? AND id=?').run(kind, key);
    this.db.prepare('INSERT INTO changes(kind,id,deleted) VALUES(?,?,?)').run(kind, key, deleted ? 1 : 0);
  }
  // A shared record from another computer is kept when it is newer than the copy here.
  applyRemote(kind, key, value, deleted = false) {
    if (!shared(kind, key)) return { changed: false };
    const local = this.get(kind, key);
    this.remote = true;
    try {
      if (deleted) { if (local) this.delete(kind, key); return { changed: Boolean(local) }; }
      if (!value) return { changed: false };
      if (local && String(local._v || '') >= String(value._v || '')) {
        // An older copy can still carry a comment written there at the same time as a change here: it is added, not lost.
        const merged = kind === 'task' && mergeComments(local, value);
        if (!merged) return { changed: false };
        this.remote = false; this.put(kind, key, { ...local, comments: merged }); return { changed: true };
      }
      const merged = kind === 'task' && local && mergeComments(value, local);
      this.put(kind, key, merged ? { ...value, comments: merged } : value);
      // This computer had comments the newer copy lacked: the joined list goes back out with a new version.
      if (merged) { this.remote = false; this.put(kind, key, this.get(kind, key)); }
      return { changed: true, isNew: !local };
    } finally { this.remote = false; }
  }
  // "Keep out of the cloud" is set on a project and carried by each of its agents (noCloud on the agent's card). Their chats,
  // runs, questions, evidence and files then skip the cloud database; they still travel straight between the person's computers.
  // The agent's card itself stays shared, so every computer knows the rule.
  privateAgent(agentId) {
    if (!agentId || agentId === 'main') return false;
    if (!this.privateAgents) this.privateAgents = new Set(this.list('specialist').filter(agent => agent.noCloud).map(agent => agent.id));
    return this.privateAgents.has(agentId);
  }
  // The one chat of an agent (its card's runId), which every computer of the account shares. Not Rex Agent's, not an
  // agent kept out of the cloud, not when chats are left out of the backup, and not while its chats are split between
  // computers and the person has not picked one yet.
  syncedChat(runId) {
    if (!runId || this.backupOff('chats')) return false;
    const run = this.get('run', runId);
    const agent = run?.specialistId ? this.get('specialist', run.specialistId) : this.list('specialist').find(item => item.runId === runId);
    return Boolean(agent && agent.kind !== 'main' && agent.id !== 'main' && agent.runId === runId && !agent.noCloud);
  }
  // Only the computer running the agent writes its chat; another computer adds only what the person typed there. Anything
  // else written here in that chat (an old story from before chats were shared, a note) stays here (src/chat-split.js).
  sharesEvent(row) {
    // Only what the chat shows travels: the hidden records (raw agent output, sessions) were three quarters of the rows and
    // 200 MB on one laptop, enough to fill the account's cloud database on the first upload.
    if (!row?.uid || !Number(row.visible) || !this.syncedChat(row.run_id)) return false;
    const run = this.get('run', row.run_id), agent = run?.specialistId ? this.get('specialist', run.specialistId) : this.list('specialist').find(item => item.runId === row.run_id);
    if (agent?.node === this.nodeId) return true;
    try { return JSON.parse(row.value || '{}').from === this.nodeId; } catch { return false; }
  }
  mainRun(runId) { const run = runId ? this.get('run', runId) : null; return Boolean(run && run.role === 'coordinator' && run.main && !run.roomAgent); }
  privateRun(runId) {
    if (!runId) return false;
    const run = this.get('run', runId);
    return Boolean(run) && (this.privateAgent(run.specialistId) || this.privateAgent(run.roomAgent));
  }
  // A part of the backup the person turned off (kept in the record backup/parts, so it is the same on every computer).
  backupOff(part) { return this.get('backup', 'parts')?.[part] === false; }
  isPrivate(kind, value) {
    if (!value) return false;
    if (BACKUP_PART[kind] && this.backupOff(BACKUP_PART[kind])) return true;
    if (kind === 'run') return this.privateAgent(value.specialistId) || this.privateAgent(value.roomAgent);
    if (kind === 'chatcopy' || kind === 'peercmd' || kind === 'chatfile') return this.privateAgent(value.agentId);
    if (kind === 'pin') return Boolean(value.agentId) && this.privateAgent(value.agentId);
    // Rex Agent's soul and memory stay on this computer: every computer has its own Rex Agent (L49).
    if (kind === 'agentnote' || kind === 'agentnotehist') return value.agentId === 'main' || this.privateAgent(value.agentId);
    if (kind === 'interaction' || kind === 'artifact') return this.privateRun(value.runId);
    return false;
  }
  put(kind, key, value) {
    if (kind === 'specialist') this.privateAgents = null;
    if (shared(kind, key) && !this.remote && this.nodeId) value = { ...value, node: value.node || this.nodeId, _v: this.stamp() };
    this.transaction(() => {
      this.logChange(kind, key);
      this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, key, JSON.stringify(value));
      this.cloud?.record(kind, key, value);
    });
    this.lists?.delete(kind);
    this.cloud?.schedule();
    this.emit('change', { kind, id: key });
    return value;
  }
  delete(kind, key) { if (kind === 'specialist') this.privateAgents = null; this.transaction(() => { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, key); this.logChange(kind, key, true); this.cloud?.remove(kind, key); }); this.lists?.delete(kind); this.cloud?.schedule(); this.emit('change', { kind, id: key }); }
  // A message id: this computer, its number here, and a random part, so two computers that once numbered alike under one
  // id (a restored copy) can never write the same id again.
  newUid(sequence) { return `${this.nodeId}.${sequence}.${randomBytes(4).toString('hex')}`; }
  event(runId, kind, value, visible = false) {
    this.transaction(() => {
      const result = this.db.prepare('INSERT INTO events(run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?)').run(runId ?? '', kind, visible ? 1 : 0, JSON.stringify(redact(value)), now());
      this.db.prepare('UPDATE events SET uid=? WHERE sequence=?').run(this.newUid(result.lastInsertRowid), result.lastInsertRowid);
      const row = this.db.prepare('SELECT * FROM events WHERE sequence=?').get(result.lastInsertRowid);
      this.cloud?.event(row); this.cloud?.chatEvent?.(row);
    });
    this.cloud?.schedule();
    this.emit('change', { kind: 'event', runId });
  }
  // A chat that moved here from another computer keeps its messages with the times they were written.
  importEvents(runId, events) {
    this.transaction(() => {
      for (const event of events) {
        const { sequence, kind, visible, createdAt, uid, ...value } = event;
        if (uid && this.db.prepare('SELECT 1 FROM events WHERE uid=?').get(uid)) continue;
        const result = this.db.prepare('INSERT INTO events(run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?)').run(runId, kind, visible === false ? 0 : 1, JSON.stringify(value), createdAt || now());
        this.db.prepare('UPDATE events SET uid=? WHERE sequence=?').run(uid || this.newUid(result.lastInsertRowid), result.lastInsertRowid);
        const row = this.db.prepare('SELECT * FROM events WHERE sequence=?').get(result.lastInsertRowid);
        this.cloud?.event(row); if (!uid) this.cloud?.chatEvent?.(row);
      }
    });
    this.cloud?.schedule();
    this.emit('change', { kind: 'event', runId });
  }
  // The person unsends one of their own messages in a personal chat.
  unsendEvent(runId, sequence) {
    const row = this.db.prepare("SELECT value, uid FROM events WHERE run_id=? AND sequence=? AND kind='human-message'").get(runId, Number(sequence));
    if (!row) return null;
    this.transaction(() => { this.db.prepare('DELETE FROM events WHERE run_id=? AND sequence=?').run(runId, Number(sequence)); this.cloud?.removeEvent(sequence); if (row.uid) this.cloud?.removeChatEvent?.(row.uid, runId); });
    this.cloud?.schedule();
    this.emit('change', { kind: 'event', runId });
    return JSON.parse(row.value);
  }
  events(runId, { visible = false, after = 0, limit = 500 } = {}) {
    return this.db.prepare(`SELECT * FROM events WHERE run_id=? AND sequence>? ${visible ? 'AND visible=1' : ''} ORDER BY sequence DESC LIMIT ?`)
      .all(runId, after, limit).reverse().map(row => ({ sequence: row.sequence, uid: row.uid, kind: row.kind, visible: Boolean(row.visible), ...JSON.parse(row.value), createdAt: row.created_at }));
  }
  // Messages from another computer's copy of a shared chat, each once (by its id); a removed one goes here too.
  // This computer shared its id with another one (src/turso.js presence). It takes a new id; its own messages take new ids
  // and go up again, and what the other computer wrote, skipped until now as this computer's own, is read from the start.
  reidentify() {
    const old = this.nodeId, fresh = randomUUID();
    this.transaction(() => { this.db.prepare("UPDATE events SET uid = ? || '.' || sequence, pushed = NULL WHERE uid LIKE ? || '.%'").run(fresh, old); });
    writeFileSync(path.join(this.directory, 'node.id'), fresh, { mode: 0o600 });
    this.nodeId = fresh;
    return fresh;
  }
  applyChatEvents(rows) {
    const touched = new Set();
    this.transaction(() => {
      // A message this computer already has under another id (both computers once wrote under one id) is not added twice.
      const known = this.db.prepare('SELECT 1 FROM events WHERE run_id=? AND created_at=? AND kind=? AND value=? LIMIT 1');
      const add = this.db.prepare('INSERT OR IGNORE INTO events(run_id,kind,visible,value,created_at,uid) VALUES(?,?,?,?,?,?)');
      // Two computers that shared one id numbered their messages alike, so one id can name two different messages. The
      // second one gets an id of its own here instead of being dropped (a reply that never showed).
      const taken = this.db.prepare('SELECT run_id, created_at, kind FROM events WHERE uid=?');
      const ownId = (runId, kind, createdAt, uid) => { const other = taken.get(uid); return other && (other.run_id !== runId || other.created_at !== createdAt || other.kind !== kind) ? `${uid}~${createHash('sha1').update(`${runId}|${createdAt}|${kind}`).digest('hex').slice(0, 10)}` : uid; };
      const insert = { run: (runId, kind, visible, value, createdAt, uid) => known.get(runId, createdAt, kind, value) ? { changes: 0 } : add.run(runId, kind, visible, value, createdAt, ownId(runId, kind, createdAt, uid)) };
      const remove = this.db.prepare('DELETE FROM events WHERE uid=?');
      for (const row of rows) {
        const result = Number(row.deleted) ? remove.run(row.uid) : insert.run(row.run_id, row.kind, Number(row.visible) ? 1 : 0, row.value, row.created_at, row.uid);
        if (result.changes) touched.add(row.run_id);
      }
    });
    for (const runId of touched) this.emit('change', { kind: 'event', runId });
    return touched.size;
  }
  // This computer's own messages of a chat that have not gone to the other computers yet.
  unsentEvents(runId, limit = 2000) {
    return this.db.prepare("SELECT * FROM events WHERE run_id=? AND visible=1 AND pushed IS NULL AND uid LIKE ? || '.%' ORDER BY sequence LIMIT ?").all(runId, this.nodeId, limit);
  }
  encrypt(text) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [nonce, cipher.getAuthTag(), encrypted].map(item => item.toString('base64')).join('.');
  }
  decrypt(text) {
    const [nonce, tag, data] = text.split('.').map(item => Buffer.from(item, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
  }
  // Files in the cloud backup are sealed with the same vault key.
  encryptBytes(bytes) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decryptBytes(text) {
    const data = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
  }
  // Every saved sign-in with its password. Only the recorded browser calls this; the dashboard sees publicConfig.
  testAccounts() {
    return (this.config().testAccounts || []).map(account => {
      const saved = this.get('secret', `test-account:${account.id}`);
      return { ...account, password: saved ? this.decrypt(saved) : '' };
    });
  }
  // Settings once held one test account and one local-preview account, and a choice between headless and Orca runs.
  // The accounts become the first entries of the sign-in list, and nothing runs headless any more.
  migrateConfig() {
    const config = this.get('config', 'main');
    if (!config) return;
    if (config.execution !== 'headless') this.put('config', 'main', { ...config, execution: 'headless' });
    if (Array.isArray(config.testAccounts)) return;
    const legacy = config.testAccount || {}, accounts = [];
    const carry = (from, to) => { const saved = this.get('secret', from); if (saved) this.put('secret', `test-account:${to}`, saved); };
    if (legacy.username) { accounts.push({ id: 'site', site: '', username: legacy.username }); carry('test-account-password', 'site'); }
    if (legacy.localUsername) { accounts.push({ id: 'local', site: '127.0.0.1', username: legacy.localUsername }); carry('test-account-local-password', 'local'); }
    const { testAccount, ...rest } = this.get('config', 'main');
    this.put('config', 'main', { ...rest, testAccounts: accounts });
  }
  credential(sourceId) {
    const saved = this.get('secret', `source:${sourceId}`);
    return saved ? this.decrypt(saved) : '';
  }
  // Files from agents and chats (screenshots, recordings, attachments, room pictures) live in the files folder the person chose,
  // or inside the data folder when none is set (every workspace made before the choice existed).
  media(folder) { const full = path.join(this.filesFolder(), folder); mkdirSync(full, { recursive: true }); return full; }
  // The files folder is this computer's own choice. It used to sit in the shared settings (config/main), which every computer
  // of the account downloads, so one laptop's D:\Rex Desk reached a laptop without a D: drive and every message failed there.
  // It lives in a file in the data folder now; the old setting is taken over once, only where that folder exists.
  filesFolder() {
    if (this.filesRoot === undefined) {
      const file = path.join(this.directory, 'files-folder.txt');
      let chosen = '';
      try { chosen = readFileSync(file, 'utf8').trim(); } catch {
        const legacy = this.get('config', 'main')?.mediaDirectory;
        if (legacy && existsSync(legacy)) { chosen = path.resolve(legacy); writeFileSync(file, chosen); }
      }
      this.filesRoot = chosen && existsSync(chosen) ? chosen : '';
    }
    return this.filesRoot || this.directory;
  }
  setFilesFolder(folder) {
    const chosen = folder && path.resolve(folder).toLowerCase() !== this.directory.toLowerCase() ? path.resolve(folder) : '';
    writeFileSync(path.join(this.directory, 'files-folder.txt'), chosen);
    this.filesRoot = chosen;
  }
  config() { const saved = this.get('config', 'main') || {}; return { ...defaults, ...saved, control: { ...defaults.control, ...(saved.control || {}) } }; }
  publicConfig() {
    const config = this.config();
    return { ...config, sources: config.sources.map(source => ({ ...source, hasKey: Boolean(this.credential(source.id)) })), jev: { ...defaults.jev, ...config.jev, hasKey: Boolean(this.get('secret', 'openrouter')) }, testAccounts: (config.testAccounts || []).map(account => ({ ...account, hasPassword: Boolean(this.get('secret', `test-account:${account.id}`)) })) };
  }
  saveConnection(source) {
    const config = this.publicConfig();
    const connection = { ...source, id: source.id || id() };
    return this.saveConfig({ ...config, sources: [...config.sources.filter(item => item.id !== connection.id), connection] }).sources.find(item => item.id === connection.id);
  }
  saveConfig(input) {
    const secretUpdates = [];
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 6) throw new Error('Concurrency must be 1–6.');
    if (!Number.isFinite(input.syncMinutes) || input.syncMinutes < 0 || input.syncMinutes > 1440) throw new Error('Sync interval must be 0–1440 minutes.');
    if (!Array.isArray(input.sources) || !Array.isArray(input.repositories)) throw new Error('Sources and repositories must be lists.');
    const sources = input.sources.map(source => {
      const sourceId = source.id || id();
      const base = new URL(source.baseUrl || (source.type === 'orbit' ? 'https://orbitkh.vercel.app' : ''));
      if (base.protocol !== 'https:') throw new Error('Source APIs must use HTTPS.');
      if (!['flow', 'morningmate', 'orbit'].includes(source.type)) throw new Error('Unknown source type.');
      if (source.apiKey?.trim()) secretUpdates.push({ id: sourceId, value: this.encrypt(source.apiKey.trim()) });
      if (source.clearKey) secretUpdates.push({ id: sourceId, remove: true });
      return { id: sourceId, name: source.name || source.type, type: source.type, baseUrl: base.origin,
        userId: [...new Set(String(source.userId || '').split(/[,;\n]/).map(value => value.trim()).filter(Boolean))].join(', '), projectIds: [...new Set((source.projectIds || []).map(String).filter(Boolean))],
        repositoryId: source.repositoryId || (input.repositories.length === 1 ? input.repositories[0].id || '' : ''), statusFilter: ['active', 'unfinished', 'all'].includes(source.statusFilter) ? source.statusFilter : 'active', statuses: [...new Set((Array.isArray(source.statuses) ? source.statuses : String(source.statuses || '').split('\n')).map(name => String(name).trim()).filter(Boolean))].slice(0, 100), statusMap: source.statusMap || {} };
    });
    const repositories = input.repositories.map(repository => {
      if (!path.isAbsolute(repository.path || '')) throw new Error('Give the full path of the project folder.');
      const commands = ['setupCommand', 'devCommand', 'testCommand'].reduce((result, key) => ({ ...result, [key]: String(repository[key] || '') }), {});
      if (repository.devCommand && !repository.devCommand.includes('{port}')) throw new Error('Dev command must contain {port}, so concurrent runs use separate ports.');
      const branchPattern = String(repository.branchPattern || '').trim();
      issueBranch(branchPattern, { prefix: String(input.branchPrefix || 'rex-desk').replace(/^\/+|\/+$/g, '') });
      return { id: repository.id || id(), name: repository.name || path.basename(repository.path), path: path.resolve(repository.path),
        baseBranch: repository.baseBranch || 'develop', targetBranch: repository.targetBranch || repository.baseBranch || 'develop',
        branchPattern, flowRuntime: validateFlowRuntime(repository.flowRuntime), electronRuntime: validateElectronRuntime(repository.electronRuntime), ...commands, browserPath: repository.browserPath || '/', push: repository.push === 'direct' ? 'direct' : 'pr' };
    });
    // One sign-in per site. A blank site is the fallback used wherever no site matches.
    const accounts = (Array.isArray(input.testAccounts) ? input.testAccounts : []).map(account => ({
      id: String(account.id || id()), site: String(account.site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 200),
      username: String(account.username || '').trim().slice(0, 200) })).filter(account => account.username);
    const config = { ...defaults, name: String(input.name || 'Rex'), notify: input.notify !== false, autonomy: input.autonomy !== false, provider: aiProvider(input.provider || 'claude'),
      concurrency: input.concurrency, branchPrefix: String(input.branchPrefix || 'rex-desk').replace(/^\/+|\/+$/g, ''),
      syncMinutes: input.syncMinutes, reportToOrbit: Boolean(input.reportToOrbit), autoPrLowRisk: Boolean(input.autoPrLowRisk), saver: input.saver !== false, autoFree: input.autoFree !== false, models: { claude: modelName('claude', input.models?.claude), codex: modelName('codex', input.models?.codex), gemini: modelName('gemini', input.models?.gemini) }, sources, repositories,
      agentProfiles: { claude: agentProfile(input.agentProfiles?.claude, 'Claude Code'), codex: agentProfile(input.agentProfiles?.codex, 'Codex'), gemini: agentProfile(input.agentProfiles?.gemini, 'Gemini') },
      tourDismissed: Boolean(input.tourDismissed), execution: 'headless', testAccounts: accounts,
      // The permission mode a new agent or chat starts in.
      defaultMode: ['bypassPermissions', 'auto', 'acceptEdits', 'manual', 'plan'].includes(input.defaultMode) ? input.defaultMode : 'bypassPermissions',
      // How full a chat's context may get before it hands over to a fresh session by itself (false: never).
      autoHandoff: input.autoHandoff === false ? false : Math.min(0.98, Math.max(0.5, Number(input.autoHandoff) || 0.85)),
      // After such a handoff the fresh session carries on by itself (false: it waits for the person's next message).
      autoContinue: input.autoContinue !== false,
      schedule: scheduleSettings(input.schedule), jev: { model: String(input.jev?.model || '').trim().slice(0, 120), auto: input.jev?.auto !== false, versions: String(input.jev?.versions || '').trim().slice(0, 300) },
      control: { enabled: input.control?.enabled !== false, confirm: input.control?.confirm !== false, agents: input.control?.agents === true, language: ['km', 'en', 'ko'].includes(input.control?.language) ? input.control.language : 'en', allow: Array.isArray(input.control?.allow) ? [...new Set(input.control.allow.map(String).filter(item => /^[a-z_]{2,40}$/.test(item)))].slice(0, 60) : defaults.control.allow } };
    for (const account of accounts) {
      const password = String((input.testAccounts || []).find(item => item.id === account.id)?.password || '');
      if (password) this.put('secret', `test-account:${account.id}`, this.encrypt(password));
    }
    // A sign-in removed in Settings takes its password with it; secrets are stored as plain strings, so ids come from the table.
    for (const row of this.db.prepare("SELECT id FROM records WHERE kind='secret' AND id LIKE 'test-account:%'").all())
      if (!accounts.some(account => `test-account:${account.id}` === row.id)) this.delete('secret', row.id);
    // The OpenRouter key for Jev is write-only from the dashboard: a new value replaces it, clearKey removes it.
    if (String(input.jev?.apiKey || '').trim()) this.put('secret', 'openrouter', this.encrypt(String(input.jev.apiKey).trim()));
    else if (input.jev?.clearKey) this.delete('secret', 'openrouter');
    for (const update of secretUpdates) {
      if (update.remove) this.delete('secret', `source:${update.id}`);
      else this.put('secret', `source:${update.id}`, update.value);
      this.delete('directory', update.id);
    }
    for (const source of this.config().sources) if (!sources.some(item => item.id === source.id)) {
      this.delete('secret', `source:${source.id}`);
      this.delete('directory', source.id);
      this.delete('sync', source.id);
      for (const task of this.list('task').filter(task => task.sourceId === source.id)) this.put('task', task.id, { ...task, active: false });
    }
    // Turning the schedule on after today's time passed starts tomorrow, not immediately.
    if (config.schedule.enabled && !this.config().schedule?.enabled) {
      const date = new Date(), [hour, minute] = config.schedule.time.split(':').map(Number);
      const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      if (date.getHours() * 60 + date.getMinutes() >= hour * 60 + minute) this.put('schedule', 'last', { date: today, at: now(), state: 'armed' });
    }
    this.put('config', 'main', config);
    return this.publicConfig();
  }
  authenticate(token) {
    if (typeof token !== 'string') return false;
    const left = Buffer.from(token), right = Buffer.from(this.token);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  close() { this.db.close(); }
}

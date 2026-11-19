import { doing } from './stall-watch.js';
import { createClient } from '@libsql/client/web';
import { backup } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { SHARED, BACKUP_PARTS } from './store.js';
import { FileBackup } from './file-backup.js';
import { AccountLink, accountMe } from './rexdesk-account.js';
// A cloud database that hit its size limit answers with words like these.
export const FULL = /size limit|SQLITE_FULL|database or disk is full|storage (quota|limit)|exceeded.*(storage|size)/i;
export const SPACE_MS = 30 * 60000;
import { development } from './folders.js';

// A development copy (npm start) never writes to a cloud database unless asked with REX_DEV_CLOUD=1: the same database may
// hold the real Rex Desk's backup, and a schema change in code being written would reach it too.
const DEV_CLOUD_OFF = 'This is a development copy of Rex Desk, so cloud backup is off. Start it with REX_DEV_CLOUD=1 to use a cloud database.';
const cloudAllowed = () => !development() || process.env.REX_DEV_CLOUD === '1';

// Local transactions and their cloud outbox commit together. Failed uploads can be retried without losing work.
export class TursoSync {
  constructor(store, { clientFactory = createClient, retryMs = 30000, accountFetcher, accountApi } = {}) {
    this.store = store; this.clientFactory = clientFactory; this.retryMs = retryMs; this.state = 'local'; this.error = ''; this.ready = false;
    // Set when the person turned cloud backup on with their Rex Desk account instead of their own Turso account.
    this.account = new AccountLink(store, { ...(accountFetcher ? { fetcher: accountFetcher } : {}), ...(accountApi ? { base: accountApi } : {}) });
    this.connectionFile = path.join(store.directory, 'turso.connection');
    this.marker = path.join(store.directory, 'turso.migrated');
    const workspaceFile = path.join(store.directory, 'workspace.id');
    if (!existsSync(workspaceFile)) writeFileSync(workspaceFile, randomUUID(), { flag: 'wx', mode: 0o600 });
    this.workspace = readFileSync(workspaceFile, 'utf8').trim();
    this.files = new FileBackup(this);
    store.db.exec('CREATE TABLE IF NOT EXISTS cloud_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, destination TEXT NOT NULL, sql TEXT NOT NULL, args TEXT NOT NULL)');
    if (existsSync(this.connectionFile) && !cloudAllowed()) this.error = DEV_CLOUD_OFF;
    else if (existsSync(this.connectionFile)) {
      try { this.connection = JSON.parse(store.decrypt(readFileSync(this.connectionFile, 'utf8'))); }
      catch { this.state = 'error'; this.error = 'Database connection cannot be decrypted with this local vault key.'; }
    }
  }
  get enabled() { return Boolean(this.connection); }
  status() {
    return { configured: this.enabled, url: this.connection?.url || '', state: this.state, error: this.error,
      pending: this.enabled ? Number(this.store.db.prepare('SELECT COUNT(*) AS total FROM cloud_outbox WHERE destination=?').get(this.connection.url).total) : 0,
      account: this.account.summary(), accountNote: this.account.ended || '',
      lastSyncedAt: this.lastSyncedAt || '', workspace: this.workspace, parts: this.parts(), files: { error: this.files.error || '', restored: this.files.lastRestored || 0, full: Boolean(this.files.full) }, space: this.space || null };
  }
  enqueue(sql, args) {
    if (!this.enabled) return;
    this.store.db.prepare('INSERT INTO cloud_outbox(destination,sql,args) VALUES(?,?,?)').run(this.connection.url, sql, JSON.stringify(args));
  }
  // Shared records (rooms, messages, agents) also go to one table that every computer of the person reads, so the same
  // Turso database gives each of them the same chats, also while another computer is off. The newest version wins.
  shared(kind, id, value, deleted = false) {
    if (!SHARED.has(kind) || (kind === 'specialist' && id === 'main') || !value?._v && !deleted) return;
    // workspace: only this account's computers read it (another account, or a development copy, in the same database does not).
    this.enqueue('INSERT INTO rex_shared(kind,id,value,deleted,v,node,workspace) VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,deleted=excluded.deleted,v=excluded.v,node=excluded.node,workspace=excluded.workspace WHERE excluded.v > rex_shared.v',
      [kind, id, deleted ? '' : JSON.stringify(value), deleted ? 1 : 0, deleted ? this.store.stamp() : value._v, this.store.nodeId, this.workspace]);
  }
  // Each computer says it is on, every half minute, with how its agents are doing. A computer that cannot reach another one
  // directly (no Tailscale) still knows it is on, and messages for its agents go through this database.
  async presence(name, agents) {
    if (!this.ready || this.closed) return null;
    await this.client.execute({ sql: 'INSERT INTO rex_presence(node,name,at,agents,host,workspace) VALUES(?,?,?,?,?,?) ON CONFLICT(node) DO UPDATE SET name=excluded.name,at=excluded.at,agents=excluded.agents,host=excluded.host,workspace=excluded.workspace', args: [this.store.nodeId, name, Date.now(), JSON.stringify(agents), os.hostname(), this.workspace] });
    const result = await this.client.execute({ sql: 'SELECT node,name,at,agents FROM rex_presence WHERE node != ? AND workspace = ?', args: [this.store.nodeId, this.workspace] });
    return result.rows.map(row => ({ node: row.node, name: row.name, at: Number(row.at), agents: JSON.parse(row.agents || '{}') }));
  }
  async pullShared(since, limit = 400) {
    if (!this.ready || this.closed) return null;
    // Each look re-reads a short overlap (for clocks that differ), so the versions come first and only the records not read
    // before are downloaded. Downloading every record of the overlap on every look moved tens of GB a month and crowded out
    // the account service on the same Turso servers.
    const heads = await this.client.execute({ sql: 'SELECT kind,id,deleted,v FROM rex_shared WHERE v > ? AND node != ? AND workspace = ? ORDER BY v LIMIT ?', args: [since, this.store.nodeId, this.workspace, limit] });
    const seen = this.pulled ||= new Map(), key = row => `${row.kind}\u001f${row.id}`;
    if (seen.size > 50000) seen.clear();
    const wanted = heads.rows.filter(row => !Number(row.deleted) && seen.get(key(row)) !== row.v);
    const values = new Map();
    if (wanted.length) {
      const found = await this.client.execute({ sql: `SELECT kind,id,value,v FROM rex_shared WHERE workspace = ? AND (kind || char(31) || id) IN (${wanted.map(() => '?').join(',')})`, args: [this.workspace, ...wanted.map(key)] });
      for (const row of found.rows) values.set(key(row), row);
    }
    return heads.rows.map(row => {
      const deleted = Boolean(Number(row.deleted)), full = values.get(key(row));
      if (full) seen.set(key(row), full.v); else if (deleted) seen.set(key(row), row.v);
      // A record read before comes back without its value: applying it changes nothing, and it still counts for paging.
      return { kind: row.kind, id: row.id, deleted, value: deleted || !full ? null : JSON.parse(full.value), v: row.v };
    });
  }
  // What belongs to a project kept out of the cloud is never written there (see Store.isPrivate): not by a change, not by the
  // first upload of a workspace. Deleting still reaches the cloud, so an older copy there goes away.
  record(kind, id, value) { if (this.store.isPrivate(kind, value)) return; this.shared(kind, id, value); this.enqueue('INSERT INTO rex_records(workspace,kind,id,value) VALUES(?,?,?,?) ON CONFLICT(workspace,kind,id) DO UPDATE SET value=excluded.value', [this.workspace, kind, id, JSON.stringify(value)]); }
  remove(kind, id) { this.shared(kind, id, null, true); this.enqueue('DELETE FROM rex_records WHERE workspace=? AND kind=? AND id=?', [this.workspace, kind, id]); }
  removeEvent(sequence) { this.enqueue('DELETE FROM rex_events WHERE workspace=? AND sequence=?', [this.workspace, Number(sequence)]); }
  // A message of an agent's chat goes to every computer of the account; a removed one is marked removed for them.
  chatEvent(row) {
    if (!this.store.sharesEvent(row)) return;
    this.enqueue('INSERT INTO rex_chat(workspace,uid,run_id,kind,visible,value,created_at,v,node,deleted) VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(workspace,uid) DO UPDATE SET value=excluded.value,visible=excluded.visible,v=excluded.v,deleted=0',
      [this.workspace, row.uid, row.run_id, row.kind, Number(row.visible) ? 1 : 0, row.value, row.created_at, this.store.stamp(), this.store.nodeId]);
    if (this.enabled) this.store.db.prepare('UPDATE events SET pushed=1 WHERE uid=?').run(row.uid);
  }
  removeChatEvent(uid, runId) {
    if (!this.store.syncedChat(runId)) return;
    this.enqueue('INSERT INTO rex_chat(workspace,uid,run_id,v,node,deleted) VALUES(?,?,?,?,?,1) ON CONFLICT(workspace,uid) DO UPDATE SET deleted=1,v=excluded.v,value=NULL', [this.workspace, uid, runId, this.store.stamp(), this.store.nodeId]);
  }
  // Messages other computers wrote since a version, oldest first.
  async pullChat(since, limit = 500) {
    if (!this.ready || this.closed) return null;
    const result = await this.client.execute({ sql: 'SELECT uid,run_id,kind,visible,value,created_at,v,deleted FROM rex_chat WHERE workspace=? AND v>? AND node!=? ORDER BY v LIMIT ?', args: [this.workspace, since, this.store.nodeId, limit] });
    return result.rows.map(row => ({ ...row }));
  }
  // Rex Agent's chats belong to this computer alone and never go to the cloud.
  event(row) { if (this.store.privateRun(row.run_id) || this.store.backupOff('chats') || this.store.mainRun(row.run_id)) return; this.enqueue('INSERT INTO rex_events(workspace,sequence,run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace,sequence) DO UPDATE SET run_id=excluded.run_id,kind=excluded.kind,visible=excluded.visible,value=excluded.value,created_at=excluded.created_at', [this.workspace, Number(row.sequence), row.run_id, row.kind, row.visible, row.value, row.created_at]); }
  // A project was set to stay out of the cloud: what the cloud holds of one of its agents is deleted there. The copies in the
  // shared table are removed outright (not marked deleted), so the other computers keep their own copy of the chat.
  forget(agentId) {
    if (!this.enabled) return { removed: 0 };
    let removed = 0;
    const drop = (kind, id) => { removed += 1; this.enqueue('DELETE FROM rex_records WHERE workspace=? AND kind=? AND id=?', [this.workspace, kind, id]); if (SHARED.has(kind)) this.enqueue('DELETE FROM rex_shared WHERE (workspace=? OR workspace IS NULL) AND kind=? AND id=?', [this.workspace, kind, id]); };
    const runs = this.store.list('run').filter(run => run.specialistId === agentId || run.roomAgent === agentId), runIds = new Set(runs.map(run => run.id));
    this.store.transaction(() => {
      for (const kind of ['chatcopy', 'peercmd', 'chatfile']) for (const item of this.store.list(kind)) if (item.agentId === agentId) drop(kind, item.id);
      for (const kind of ['interaction', 'artifact']) for (const item of this.store.list(kind)) if (runIds.has(item.runId)) drop(kind, item.id);
      for (const run of runs) {
        drop('run', run.id); this.enqueue('DELETE FROM rex_events WHERE workspace=? AND run_id=?', [this.workspace, run.id]);
        this.enqueue('DELETE FROM rex_files WHERE workspace=? AND path LIKE ?', [this.workspace, `data/artifacts/${run.id}/%`]);
      }
      this.enqueue('DELETE FROM rex_files WHERE workspace=? AND path LIKE ?', [this.workspace, `memory/agents/home/${agentId}/%`]);
    });
    this.files.forget([...[...runIds].map(id => `data/artifacts/${id}/`), `memory/agents/home/${agentId}/`]);
    this.schedule(); return { removed };
  }
  // What goes to the cloud: chat history, group chat messages, tasks, pictures and files. Turning a part off deletes its
  // cloud copy (from this account's backup, for every computer); turning it on sends this computer's copy back up.
  parts() { return { ...BACKUP_PARTS, ...(this.store.get('backup', 'parts') || {}) }; }
  setParts(next = {}) {
    const before = this.parts(), after = { ...before };
    for (const part of Object.keys(BACKUP_PARTS)) if (typeof next[part] === 'boolean') after[part] = next[part];
    this.store.put('backup', 'parts', after);
    if (this.enabled) for (const part of Object.keys(BACKUP_PARTS)) if (before[part] !== after[part]) (after[part] ? this.sendPart(part) : this.dropPart(part));
    this.schedule(); return after;
  }
  static PART_KINDS = { rooms: ['roommsg'], tasks: ['task', 'priority'], files: ['chatfile', 'artifact'], chats: [] };
  dropPart(part) {
    this.store.transaction(() => {
      if (part === 'chats') this.enqueue('DELETE FROM rex_events WHERE workspace=?', [this.workspace]);
      for (const kind of TursoSync.PART_KINDS[part]) {
        this.enqueue('DELETE FROM rex_records WHERE workspace=? AND kind=?', [this.workspace, kind]);
        if (SHARED.has(kind)) this.enqueue('DELETE FROM rex_shared WHERE (workspace=? OR workspace IS NULL) AND kind=?', [this.workspace, kind]);
      }
      if (part === 'files') this.enqueue("DELETE FROM rex_files WHERE workspace=? AND path LIKE 'data/%'", [this.workspace]);
    });
    if (part === 'files') this.files.forget(['data/']);
  }
  sendPart(part) {
    doing(`cloud sync: uploading ${part}`);
    this.store.transaction(() => {
      if (part === 'chats') for (const row of this.store.db.prepare('SELECT * FROM events ORDER BY sequence').all()) this.event(row);
      for (const kind of TursoSync.PART_KINDS[part]) for (const item of this.store.list(kind)) this.record(kind, item.id, item);
    });
    if (part === 'files') void this.files.run?.();
  }
  // The project may use the cloud again: everything of the agent that is here goes back up.
  restoreAgent(agentId) {
    if (!this.enabled) return { sent: 0 };
    let sent = 0;
    const runs = this.store.list('run').filter(run => run.specialistId === agentId || run.roomAgent === agentId), runIds = new Set(runs.map(run => run.id));
    this.store.transaction(() => {
      for (const run of runs) { this.record('run', run.id, run); sent += 1; for (const row of this.store.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY sequence').all(run.id)) this.event(row); }
      for (const kind of ['chatcopy', 'peercmd', 'chatfile']) for (const item of this.store.list(kind)) if (item.agentId === agentId) { this.record(kind, item.id, item); sent += 1; }
      for (const kind of ['interaction', 'artifact']) for (const item of this.store.list(kind)) if (runIds.has(item.runId)) { this.record(kind, item.id, item); sent += 1; }
    });
    this.schedule(); void this.files.run?.(); return { sent };
  }
  schedule() {
    if (!this.ready || this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 350);
    this.files.soon();
    this.timer.unref();
  }
  notify() { this.store.emit('change', { kind: 'database' }); }
  // How full the account's cloud space is, asked of the account service now and then. At 80% and at 95% the person is told
  // once (onSpace); when it goes back under, the next crossing tells them again.
  async checkSpace(now = Date.now()) {
    if (!this.account?.signedIn || this.closed || now - (this.spaceAt || 0) < SPACE_MS) return this.space || null;
    this.spaceAt = now;
    try {
      const me = await accountMe(this.account.saved.token, this.account);
      this.space = me.space ? { ...me.space, plan: me.plan, at: new Date(now).toISOString() } : null;
      const files = this.space?.files || {}, share = files.limit ? files.used / files.limit : 0;
      const level = share >= 0.95 ? 95 : share >= 0.8 ? 80 : 0, before = this.store.get('meta', 'cloud-space-level')?.level || 0;
      if (level !== before) this.store.put('meta', 'cloud-space-level', { level });
      if (level > before) this.onSpace?.(level, this.space);
      // Room again: file uploads go on.
      if (share < 1 && this.files.full) { this.files.full = false; void this.files.run?.(); }
      this.notify();
    } catch { /* asked again later */ }
    return this.space;
  }
  fail(error) {
    if (FULL.test(String(error?.message || error))) { this.state = 'full'; this.error = 'Your cloud space is full. Everything stays on this computer, and the changes upload by themselves once there is room. Add space on rexdesk.app.'; this.notify(); return; }
    this.state = 'offline';
    this.error = String(error.message || error).replaceAll(this.connection?.authToken || '\0', '[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
    this.notify();
  }
  // One connection attempt at a time: a second caller waits instead of replacing the client during a flush.
  open() {
    if (!this.enabled || this.closed) return Promise.resolve(this.status());
    this.opening ||= this.connectNow().finally(() => { this.opening = null; });
    return this.opening;
  }
  retry() { return this.ready && !this.account.due(this.connection) ? this.flush() : this.open(); }
  async connectNow() {
    if (this.flushing) await this.flushing;
    // A Rex Desk account's key lasts about a month: take a fresh one before it runs out, or when the old one stopped working.
    if (this.account.due(this.connection, { failing: this.state === 'offline' && !this.ready })) {
      const authToken = await this.account.freshKey();
      if (authToken) { this.connection = { ...this.connection, authToken }; writeFileSync(this.connectionFile, this.store.encrypt(JSON.stringify(this.connection)), { mode: 0o600 }); }
    }
    this.state = 'connecting'; this.notify();
    try {
      this.client?.close();
      this.client = this.clientFactory({ ...this.connection, fetch: (input, options = {}) => fetch(input, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }) });
      await this.client.batch([
        'CREATE TABLE IF NOT EXISTS rex_records (workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace,kind,id))',
        'CREATE TABLE IF NOT EXISTS rex_shared (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, v TEXT NOT NULL, node TEXT NOT NULL, PRIMARY KEY(kind,id))',
        'CREATE INDEX IF NOT EXISTS rex_shared_v ON rex_shared(v)',
        'CREATE TABLE IF NOT EXISTS rex_presence (node TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL, agents TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS rex_events (workspace TEXT NOT NULL, sequence INTEGER NOT NULL, run_id TEXT, kind TEXT, visible INTEGER, value TEXT, created_at TEXT, PRIMARY KEY(workspace,sequence))',
        // One row per chat message of an agent's chat, the same id on every computer (docs/design/cross-device-chat.md).
        'CREATE TABLE IF NOT EXISTS rex_chat (workspace TEXT NOT NULL, uid TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT, visible INTEGER, value TEXT, created_at TEXT, v TEXT NOT NULL, node TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace,uid))',
        'CREATE INDEX IF NOT EXISTS rex_chat_v ON rex_chat(workspace, v)',
        'CREATE TABLE IF NOT EXISTS rex_files (workspace TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(workspace,path))',
        'CREATE TABLE IF NOT EXISTS rex_workspaces (workspace TEXT PRIMARY KEY, name TEXT NOT NULL, kdf TEXT NOT NULL, sealed_key TEXT NOT NULL, updated_at TEXT)',
      ], 'write');
      // Which machine each computer id runs on, so a restore can tell a reinstall here from a second computer.
      await this.client.execute({ sql: 'ALTER TABLE rex_presence ADD COLUMN host TEXT', args: [] }).catch(() => {});
      // Shared agents and computers belong to one account (workspace). Rows from before the column existed are claimed by the
      // computer that wrote them: this one, or the account's first computer (its id is the workspace id). Anything else in the
      // same database (another account, a development copy) stays out of this account's view.
      for (const table of ['rex_shared', 'rex_presence']) await this.client.execute({ sql: `ALTER TABLE ${table} ADD COLUMN workspace TEXT`, args: [] }).catch(() => {});
      await this.client.execute({ sql: 'CREATE INDEX IF NOT EXISTS rex_shared_workspace_v ON rex_shared(workspace, v)', args: [] }).catch(() => {});
      for (const table of ['rex_shared', 'rex_presence']) await this.client.execute({ sql: `UPDATE ${table} SET workspace=? WHERE workspace IS NULL AND node IN (?, ?)`, args: [this.workspace, this.store.nodeId, this.workspace] }).catch(() => {});
      // Another computer finds this workspace by name; only the passphrase unseals its key.
      if (this.store.auth?.kdf) await this.client.batch([{ sql: 'INSERT INTO rex_workspaces(workspace,name,kdf,sealed_key,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace) DO UPDATE SET name=excluded.name,kdf=excluded.kdf,sealed_key=excluded.sealed_key,updated_at=excluded.updated_at',
        args: [this.workspace, this.store.auth.name, JSON.stringify(this.store.auth.kdf), this.store.auth.sealedKey, new Date().toISOString()] }], 'write');
      if (this.store.fresh && !existsSync(this.marker)) await this.restoreIfAvailable();
      const marker = existsSync(this.marker) ? JSON.parse(readFileSync(this.marker, 'utf8')) : null;
      if (marker?.url !== this.connection.url || marker?.workspace !== this.workspace) this.seed();
      this.ready = true; this.error = '';
      await this.flush();
      if (this.state === 'connected') writeFileSync(this.marker, JSON.stringify({ url: this.connection.url, workspace: this.workspace }), { mode: 0o600 });
      // Then the files the chats point to. A new device does not wait for them: chats, agents and tasks open at once, the files
      // come down behind, and one that is opened first is fetched right then (FileBackup.fetchOne). New ones go up after.
      if (this.state === 'connected' && this.restoring) { this.restoring = false; void this.files.restoreMissing().then(result => { this.files.lastRestored = result.restored; if (result.restored) this.notify?.(); }, error => { this.files.error = String(error.message || error); }).finally(() => { if (this.state === 'connected') void this.files.run(); }); }
      else if (this.state === 'connected') void this.files.run();
    } catch (error) { this.ready = false; this.fail(error); }
    // Retry even when the first connection fails, so an offline start catches up without a restart.
    if (!this.retryTimer && !this.closed) { this.retryTimer = setInterval(() => void this.retry(), this.retryMs); this.retryTimer.unref(); }
    void this.checkSpace();
    if (!this.spaceTimer && !this.closed) { this.spaceTimer = setInterval(() => void this.checkSpace(), SPACE_MS); this.spaceTimer.unref(); }
    if (!this.filesTimer && !this.closed) { this.filesTimer = setInterval(() => void this.files.run(), Math.max(this.retryMs, 120000)); this.filesTimer.unref(); }
    return this.status();
  }
  seed() {
    doing('cloud sync: uploading everything');
    this.store.transaction(() => {
      for (const row of this.store.db.prepare('SELECT * FROM records').all()) this.record(row.kind, row.id, JSON.parse(row.value));
      for (const row of this.store.db.prepare('SELECT * FROM events ORDER BY sequence').all()) this.event(row);
    });
  }
  // Signing in on a computer that already has this workspace: upload anything left from its last session, then take the
  // cloud copy, which holds whatever another computer did since. Sequential use is safe; simultaneous use keeps the last write.
  // A backup can hold tens of thousands of messages: it comes down in pages, each well inside the request time limit.
  async cloudRecords() {
    const rows = []; let kind = '', id = '';
    for (;;) {
      const page = await this.client.execute({ sql: 'SELECT kind,id,value FROM rex_records WHERE workspace=? AND (kind>? OR (kind=? AND id>?)) ORDER BY kind,id LIMIT 1000', args: [this.workspace, kind, kind, id] });
      rows.push(...page.rows); if (page.rows.length < 1000) return rows;
      ({ kind, id } = page.rows.at(-1));
    }
  }
  async cloudEvents() {
    const rows = []; let after = -1;
    for (;;) {
      const page = await this.client.execute({ sql: 'SELECT * FROM rex_events WHERE workspace=? AND sequence>? ORDER BY sequence LIMIT 2000', args: [this.workspace, after] });
      rows.push(...page.rows); if (page.rows.length < 2000) return rows;
      after = Number(page.rows.at(-1).sequence);
    }
  }
  // Brings this computer up to date with the cloud copy (the same account works on other computers too). Only what differs
  // moves: records are compared, and only the messages this computer does not have yet are downloaded, so opening Rex Desk
  // does not fetch the whole history every time. What is kept out of the cloud (Store.isPrivate) is never deleted here,
  // because the cloud never had it. This computer's own name, links and read positions (peers/main) stay as they are.
  async pullLatest({ live = new Set() } = {}) {
    doing('cloud sync: catching up at start');
    await this.flush();
    if (this.state !== 'connected' || this.status().pending) return { pulled: false, reason: this.error || 'Local changes are still uploading.' };
    const remote = await this.cloudRecords();
    if (!remote.length) return { pulled: false, reason: 'The cloud copy is empty.' };
    const db = this.store.db, key = (kind, id) => `${kind}\u0000${id}`, own = row => row.kind === 'peers' && row.id === 'main';
    const arrived = [];
    // Something changed here while the cloud copy was downloading: it uploads first, and the next pull takes the rest.
    if (this.status().pending) return { pulled: false, reason: 'Local changes arrived while pulling; they upload first.' };
    const local = new Map(db.prepare('SELECT kind,id,value FROM records').all().map(row => [key(row.kind, row.id), row]));
    const remoteKeys = new Set(remote.map(row => key(row.kind, row.id)));
    const changed = remote.filter(row => !own(row) && local.get(key(row.kind, row.id))?.value !== row.value);
    const gone = [...local.values()].filter(row => !own(row) && !remoteKeys.has(key(row.kind, row.id)) && !this.store.isPrivate(row.kind, JSON.parse(row.value)));
    this.store.transaction(() => {
      const put = db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value');
      for (const row of changed) put.run(row.kind, row.id, row.value);
      const drop = db.prepare('DELETE FROM records WHERE kind=? AND id=?');
      for (const row of gone) drop.run(row.kind, row.id);
      this.store.privateAgents = null;
      // Messages are not taken from the backup by their number here: every computer numbers its own, so that overwrote one
      // computer's messages with another's. Agents' chats arrive through rex_chat by their own ids (Peers.pullChats).
    });
    this.store.clearListCache();
    const records = { rows: remote }, events = { rows: arrived };
    this.store.token = this.store.decrypt(this.store.get('secret', 'mcp-token'));
    // A chat still working on this computer (its agent process is alive) keeps going; only what stopped elsewhere is interrupted.
    const alive = pid => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } };
    for (const run of this.store.list('run')) if (['running', 'queued', 'waiting', 'starting', 'verifying'].includes(run.state) && !live.has(run.id) && !alive(run.host?.pid)) this.store.put('run', run.id, { ...run, state: 'interrupted', error: 'Opened on another computer. Resume this run explicitly.' });
    this.notify(); return { pulled: true, records: records.rows.length, events: events.rows.length };
  }
  async restoreIfAvailable() {
    const records = { rows: await this.cloudRecords() };
    if (!records.rows.length) return;
    this.restoring = true;
    const token = records.rows.find(row => row.kind === 'secret' && row.id === 'mcp-token');
    if (token) this.store.decrypt(JSON.parse(token.value));
    const events = { rows: await this.cloudEvents() };
    this.store.transaction(() => {
      const insert = this.store.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value');
      for (const row of records.rows) insert.run(row.kind, row.id, row.value);
      const event = this.store.db.prepare('INSERT OR REPLACE INTO events(sequence,run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?,?)');
      for (const row of events.rows) event.run(Number(row.sequence), row.run_id, row.kind, Number(row.visible), row.value, row.created_at);
    });
    this.store.clearListCache();
    this.store.token = this.store.decrypt(this.store.get('secret', 'mcp-token'));
    await this.adoptIdentity(events.rows);
    for (const run of this.store.list('run')) if (['running', 'queued', 'waiting', 'starting', 'verifying'].includes(run.state)) this.store.put('run', run.id, { ...run, state: 'interrupted', error: 'Restored from Turso. Resume this run explicitly.' });
    for (const item of this.store.list('interaction')) if (item.state === 'pending') this.store.put('interaction', item.id, { ...item, state: 'expired' });
    this.store.fresh = false; this.notify();
  }
  // After a restore: the same machine (a reinstall, a cleared data folder) takes back its old computer id, so its agents stay
  // its own. A different machine whose old computer is still in use keeps its new id, calls itself by its own name, and numbers
  // its messages far above the other computer's, so the two never overwrite each other's chats in the backup.
  async adoptIdentity(events = []) {
    const counts = new Map();
    for (const agent of this.store.list('specialist')) if (agent.node) counts.set(agent.node, (counts.get(agent.node) || 0) + 1);
    const old = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || this.workspace;
    if (old === this.store.nodeId) return { node: old, own: true };
    const row = (await this.client.execute({ sql: 'SELECT host,at FROM rex_presence WHERE node=?', args: [old] }).catch(() => ({ rows: [] }))).rows[0];
    const elsewhere = row && (row.host ? row.host !== os.hostname() : Date.now() - Number(row.at) < 10 * 60000);
    if (!elsewhere) {
      writeFileSync(path.join(this.store.directory, 'node.id'), old, { mode: 0o600 }); this.store.nodeId = old;
      return { node: old, own: true };
    }
    const peers = this.store.get('peers', 'main');
    if (peers?.name) this.store.put('peers', 'main', { ...peers, name: '' });
    const top = events.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0);
    if (top) this.store.db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='events'").run((Math.floor(top / 1e9) + 1) * 1e9);
    return { node: this.store.nodeId, own: false };
  }
  async connect({ url, authToken }) {
    if (!cloudAllowed()) throw new Error(DEV_CLOUD_OFF);
    const parsed = new URL(url);
    if (!['libsql:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use a libsql:// or HTTPS Turso database URL without credentials in the URL.');
    const token = String(authToken || (this.connection?.url === url ? this.connection.authToken : '') || '').trim();
    if (!token) throw new Error('Enter the Turso database key.');
    const backups = path.join(this.store.directory, 'backups'); mkdirSync(backups, { recursive: true, mode: 0o700 });
    await backup(this.store.db, path.join(backups, `before-turso-${Date.now()}.sqlite`));
    this.connection = { url, authToken: token }; this.ready = false;
    writeFileSync(this.connectionFile, this.store.encrypt(JSON.stringify(this.connection)), { mode: 0o600 });
    // Changing destinations gets a complete snapshot; pending writes for an older destination remain durable.
    // A fresh workspace (a reinstall, a cleared data folder, a new computer) first takes its backup, so its empty defaults never overwrite it.
    if (!this.store.fresh) this.seed();
    return this.open();
  }
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.ready || this.closed) return this.status();
    this.flushing = (async () => {
      // Yield before the finally block clears this.flushing, including when the outbox is already empty.
      await Promise.resolve();
      try {
        this.state = 'syncing';
        while (!this.closed) {
          const pending = this.store.db.prepare('SELECT * FROM cloud_outbox WHERE destination=? ORDER BY sequence LIMIT 50').all(this.connection.url);
          if (!pending.length) break;
          // A cloud call that never answers would hold every later upload until a restart: it gives up after a minute and is tried again.
          await Promise.race([this.client.batch(pending.map(row => ({ sql: row.sql, args: JSON.parse(row.args) })), 'write'), new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('The cloud did not answer in time; the changes are kept and sent again.')), 60000); timer.unref?.(); })]);
          this.store.transaction(() => { const remove = this.store.db.prepare('DELETE FROM cloud_outbox WHERE sequence=?'); for (const row of pending) remove.run(row.sequence); });
        }
        this.state = 'connected'; this.error = ''; this.lastSyncedAt = new Date().toISOString();
      } catch (error) { this.fail(error); }
      finally { this.flushing = null; this.notify(); }
      return this.status();
    })();
    return this.flushing;
  }
  async verify({ repaired = false } = {}) {
    doing('cloud sync: checking the cloud copy');
    await this.flush();
    if (this.state !== 'connected') throw new Error('Turso is offline. Pending writes are safe in the local outbox.');
    // The question is whether everything on this computer is in the cloud. The same account on another computer adds its own
    // chats and records there too, so the cloud copy may hold more than this computer, and that is fine.
    const local = this.store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all().filter(row => !this.store.isPrivate(row.kind, JSON.parse(row.value)));
    const privateRuns = new Set(this.store.list('run').filter(run => this.store.isPrivate('run', run)).map(run => run.id));
    const localEvents = this.store.backupOff('chats') ? [] : this.store.db.prepare('SELECT sequence,run_id FROM events').all().filter(row => !privateRuns.has(row.run_id));
    const remoteKeys = new Set(); let kind = '', id = '';
    for (;;) {
      const page = await this.client.execute({ sql: 'SELECT kind,id FROM rex_records WHERE workspace=? AND (kind>? OR (kind=? AND id>?)) ORDER BY kind,id LIMIT 5000', args: [this.workspace, kind, kind, id] });
      for (const row of page.rows) remoteKeys.add(`${row.kind}\u0000${row.id}`);
      if (page.rows.length < 5000) break; ({ kind, id } = page.rows.at(-1));
    }
    const remoteSequences = new Set(); let after = -1;
    for (;;) {
      const page = await this.client.execute({ sql: 'SELECT sequence FROM rex_events WHERE workspace=? AND sequence>? ORDER BY sequence LIMIT 20000', args: [this.workspace, after] });
      for (const row of page.rows) remoteSequences.add(Number(row.sequence));
      if (page.rows.length < 20000) break; after = Number(page.rows.at(-1).sequence);
    }
    const lostRecords = local.filter(row => !remoteKeys.has(`${row.kind}\u0000${row.id}`)), lostEvents = localEvents.filter(row => !remoteSequences.has(Number(row.sequence)));
    // Anything missing is uploaded again once, then checked again.
    if (!repaired && (lostRecords.length || lostEvents.length)) {
      const event = this.store.db.prepare('SELECT * FROM events WHERE sequence=?');
      this.store.transaction(() => { for (const row of lostRecords) this.record(row.kind, row.id, JSON.parse(row.value)); for (const row of lostEvents) this.event(event.get(row.sequence)); });
      return this.verify({ repaired: true });
    }
    const missingRecords = lostRecords.length, missingEvents = lostEvents.length;
    return { matched: missingRecords === 0 && missingEvents === 0, missingRecords, missingEvents, localRecords: local.length, remoteRecords: remoteKeys.size, localEvents: localEvents.length, remoteEvents: remoteSequences.size };
  }
  // Stops using the cloud database this computer copies to (for example to move to the Rex Desk account backup). Everything
  // stays on this computer; nothing is deleted in the cloud. The next database it connects to gets a complete copy.
  async disconnect() {
    if (this.opening) await this.opening.catch(() => {});
    clearTimeout(this.timer); clearInterval(this.retryTimer); clearInterval(this.spaceTimer); clearInterval(this.filesTimer); clearTimeout(this.files.soonTimer);
    this.timer = null; this.retryTimer = null; this.spaceTimer = null; this.filesTimer = null;
    const old = this.connection?.url || '';
    try { this.client?.close(); } catch { /* already closed */ }
    this.client = null; this.connection = null; this.ready = false; this.state = 'local'; this.error = ''; this.space = null;
    rmSync(this.connectionFile, { force: true }); rmSync(this.marker, { force: true });
    if (old) this.store.db.prepare('DELETE FROM cloud_outbox WHERE destination=?').run(old);
    if (this.account.saved?.url) this.account.save({ token: this.account.saved.token, expiresAt: this.account.saved.expiresAt, user: this.account.saved.user }, {});
    this.notify();
    return this.status();
  }
  async close() {
    clearTimeout(this.timer); clearInterval(this.retryTimer); clearInterval(this.filesTimer); clearTimeout(this.files.soonTimer);
    if (this.files.running) await this.files.running.catch(() => {});
    if (this.opening) await this.opening;
    if (this.ready) await this.flush();
    // Closing Rex Desk (or the computer going to sleep or shutting down) says so at once: the other computers show it
    // offline now instead of after 90 seconds without a heartbeat.
    if (this.ready && this.client) await Promise.race([this.client.execute({ sql: 'UPDATE rex_presence SET at=0 WHERE node=? AND workspace=?', args: [this.store.nodeId, this.workspace] }).catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
    this.closed = true; this.client?.close();
  }
}

// Sign-in from a new computer: find a published workspace by name in the person's own Turso database.
export async function findCloudWorkspace({ url, authToken, name }, clientFactory = createClient) {
  const parsed = new URL(url);
  if (!['libsql:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use a libsql:// or HTTPS Turso database URL without credentials in the URL.');
  const client = clientFactory({ url, authToken });
  const hide = message => String(message).replaceAll(authToken || '\0', '[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  try {
    const result = await client.execute({ sql: 'SELECT workspace,name,kdf,sealed_key FROM rex_workspaces WHERE lower(name)=lower(?)', args: [String(name || '').trim()] })
      .catch(error => { if (/no such table/i.test(error.message)) return { rows: [] }; throw new Error(hide(error.message)); });
    const row = result.rows[0];
    if (!row) throw new Error('No desk with that name is in this backup. On your first computer, sign in and turn on Cloud backup.');
    return { id: row.workspace, name: row.name, sealed: { kdf: JSON.parse(row.kdf), sealedKey: row.sealed_key } };
  } finally { client.close(); }
}

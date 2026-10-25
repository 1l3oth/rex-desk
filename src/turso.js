import { createClient } from '@libsql/client/web';
import { backup } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// Local transactions and their cloud outbox commit together. Failed uploads can be retried without losing work.
export class TursoSync {
  constructor(store, { clientFactory = createClient, retryMs = 30000 } = {}) {
    this.store = store; this.clientFactory = clientFactory; this.retryMs = retryMs; this.state = 'local'; this.error = ''; this.ready = false;
    this.connectionFile = path.join(store.directory, 'turso.connection');
    this.marker = path.join(store.directory, 'turso.migrated');
    const workspaceFile = path.join(store.directory, 'workspace.id');
    if (!existsSync(workspaceFile)) writeFileSync(workspaceFile, randomUUID(), { flag: 'wx', mode: 0o600 });
    this.workspace = readFileSync(workspaceFile, 'utf8').trim();
    store.db.exec('CREATE TABLE IF NOT EXISTS cloud_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, destination TEXT NOT NULL, sql TEXT NOT NULL, args TEXT NOT NULL)');
    if (existsSync(this.connectionFile)) {
      try { this.connection = JSON.parse(store.decrypt(readFileSync(this.connectionFile, 'utf8'))); }
      catch { this.state = 'error'; this.error = 'Database connection cannot be decrypted with this local vault key.'; }
    }
  }
  get enabled() { return Boolean(this.connection); }
  status() {
    return { configured: this.enabled, url: this.connection?.url || '', state: this.state, error: this.error,
      pending: this.enabled ? Number(this.store.db.prepare('SELECT COUNT(*) AS total FROM cloud_outbox WHERE destination=?').get(this.connection.url).total) : 0,
      lastSyncedAt: this.lastSyncedAt || '', workspace: this.workspace };
  }
  enqueue(sql, args) {
    if (!this.enabled) return;
    this.store.db.prepare('INSERT INTO cloud_outbox(destination,sql,args) VALUES(?,?,?)').run(this.connection.url, sql, JSON.stringify(args));
  }
  record(kind, id, value) { this.enqueue('INSERT INTO rex_records(workspace,kind,id,value) VALUES(?,?,?,?) ON CONFLICT(workspace,kind,id) DO UPDATE SET value=excluded.value', [this.workspace, kind, id, JSON.stringify(value)]); }
  remove(kind, id) { this.enqueue('DELETE FROM rex_records WHERE workspace=? AND kind=? AND id=?', [this.workspace, kind, id]); }
  event(row) { this.enqueue('INSERT INTO rex_events(workspace,sequence,run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace,sequence) DO UPDATE SET run_id=excluded.run_id,kind=excluded.kind,visible=excluded.visible,value=excluded.value,created_at=excluded.created_at', [this.workspace, Number(row.sequence), row.run_id, row.kind, row.visible, row.value, row.created_at]); }
  schedule() {
    if (!this.ready || this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 350);
    this.timer.unref();
  }
  notify() { this.store.emit('change', { kind: 'database' }); }
  fail(error) {
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
  retry() { return this.ready ? this.flush() : this.open(); }
  async connectNow() {
    if (this.flushing) await this.flushing;
    this.state = 'connecting'; this.notify();
    try {
      this.client?.close();
      this.client = this.clientFactory({ ...this.connection, fetch: (input, options = {}) => fetch(input, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }) });
      await this.client.batch([
        'CREATE TABLE IF NOT EXISTS rex_records (workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace,kind,id))',
        'CREATE TABLE IF NOT EXISTS rex_events (workspace TEXT NOT NULL, sequence INTEGER NOT NULL, run_id TEXT, kind TEXT, visible INTEGER, value TEXT, created_at TEXT, PRIMARY KEY(workspace,sequence))',
        'CREATE TABLE IF NOT EXISTS rex_workspaces (workspace TEXT PRIMARY KEY, name TEXT NOT NULL, kdf TEXT NOT NULL, sealed_key TEXT NOT NULL, updated_at TEXT)',
      ], 'write');
      // Another computer finds this workspace by name; only the passphrase unseals its key.
      if (this.store.auth?.kdf) await this.client.batch([{ sql: 'INSERT INTO rex_workspaces(workspace,name,kdf,sealed_key,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace) DO UPDATE SET name=excluded.name,kdf=excluded.kdf,sealed_key=excluded.sealed_key,updated_at=excluded.updated_at',
        args: [this.workspace, this.store.auth.name, JSON.stringify(this.store.auth.kdf), this.store.auth.sealedKey, new Date().toISOString()] }], 'write');
      if (this.store.fresh && !existsSync(this.marker)) await this.restoreIfAvailable();
      const marker = existsSync(this.marker) ? JSON.parse(readFileSync(this.marker, 'utf8')) : null;
      if (marker?.url !== this.connection.url || marker?.workspace !== this.workspace) this.seed();
      this.ready = true; this.error = '';
      await this.flush();
      if (this.state === 'connected') writeFileSync(this.marker, JSON.stringify({ url: this.connection.url, workspace: this.workspace }), { mode: 0o600 });
    } catch (error) { this.ready = false; this.fail(error); }
    // Retry even when the first connection fails, so an offline start catches up without a restart.
    if (!this.retryTimer && !this.closed) { this.retryTimer = setInterval(() => void this.retry(), this.retryMs); this.retryTimer.unref(); }
    return this.status();
  }
  seed() {
    this.store.transaction(() => {
      for (const row of this.store.db.prepare('SELECT * FROM records').all()) this.record(row.kind, row.id, JSON.parse(row.value));
      for (const row of this.store.db.prepare('SELECT * FROM events ORDER BY sequence').all()) this.event(row);
    });
  }
  // Signing in on a computer that already has this workspace: upload anything left from its last session, then take the
  // cloud copy, which holds whatever another computer did since. Sequential use is safe; simultaneous use keeps the last write.
  async pullLatest() {
    await this.flush();
    if (this.state !== 'connected' || this.status().pending) return { pulled: false, reason: this.error || 'Local changes are still uploading.' };
    const records = await this.client.execute({ sql: 'SELECT kind,id,value FROM rex_records WHERE workspace=?', args: [this.workspace] });
    if (!records.rows.length) return { pulled: false, reason: 'The cloud copy is empty.' };
    const events = await this.client.execute({ sql: 'SELECT * FROM rex_events WHERE workspace=? ORDER BY sequence', args: [this.workspace] });
    this.store.transaction(() => {
      this.store.db.exec('DELETE FROM records; DELETE FROM events;');
      const insert = this.store.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)');
      for (const row of records.rows) insert.run(row.kind, row.id, row.value);
      const event = this.store.db.prepare('INSERT INTO events(sequence,run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?,?)');
      for (const row of events.rows) event.run(Number(row.sequence), row.run_id, row.kind, Number(row.visible), row.value, row.created_at);
    });
    this.store.token = this.store.decrypt(this.store.get('secret', 'mcp-token'));
    for (const run of this.store.list('run')) if (['running', 'queued', 'waiting', 'starting', 'verifying'].includes(run.state)) this.store.put('run', run.id, { ...run, state: 'interrupted', error: 'Opened on another computer. Resume this run explicitly.' });
    this.notify(); return { pulled: true, records: records.rows.length, events: events.rows.length };
  }
  async restoreIfAvailable() {
    const records = await this.client.execute({ sql: 'SELECT kind,id,value FROM rex_records WHERE workspace=?', args: [this.workspace] });
    if (!records.rows.length) return;
    const token = records.rows.find(row => row.kind === 'secret' && row.id === 'mcp-token');
    if (token) this.store.decrypt(JSON.parse(token.value));
    const events = await this.client.execute({ sql: 'SELECT * FROM rex_events WHERE workspace=? ORDER BY sequence', args: [this.workspace] });
    this.store.transaction(() => {
      const insert = this.store.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value');
      for (const row of records.rows) insert.run(row.kind, row.id, row.value);
      const event = this.store.db.prepare('INSERT OR REPLACE INTO events(sequence,run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?,?)');
      for (const row of events.rows) event.run(Number(row.sequence), row.run_id, row.kind, Number(row.visible), row.value, row.created_at);
    });
    this.store.token = this.store.decrypt(this.store.get('secret', 'mcp-token'));
    for (const run of this.store.list('run')) if (['running', 'queued', 'waiting', 'starting', 'verifying'].includes(run.state)) this.store.put('run', run.id, { ...run, state: 'interrupted', error: 'Restored from Turso. Resume this run explicitly.' });
    for (const item of this.store.list('interaction')) if (item.state === 'pending') this.store.put('interaction', item.id, { ...item, state: 'expired' });
    this.store.fresh = false; this.notify();
  }
  async connect({ url, authToken }) {
    const parsed = new URL(url);
    if (!['libsql:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use a libsql:// or HTTPS Turso database URL without credentials in the URL.');
    const token = String(authToken || (this.connection?.url === url ? this.connection.authToken : '') || '').trim();
    if (!token) throw new Error('Enter the Turso database token.');
    const backups = path.join(this.store.directory, 'backups'); mkdirSync(backups, { recursive: true, mode: 0o700 });
    await backup(this.store.db, path.join(backups, `before-turso-${Date.now()}.sqlite`));
    this.connection = { url, authToken: token }; this.ready = false;
    writeFileSync(this.connectionFile, this.store.encrypt(JSON.stringify(this.connection)), { mode: 0o600 });
    // Changing destinations gets a complete snapshot; pending writes for an older destination remain durable.
    this.seed();
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
          await this.client.batch(pending.map(row => ({ sql: row.sql, args: JSON.parse(row.args) })), 'write');
          this.store.transaction(() => { const remove = this.store.db.prepare('DELETE FROM cloud_outbox WHERE sequence=?'); for (const row of pending) remove.run(row.sequence); });
        }
        this.state = 'connected'; this.error = ''; this.lastSyncedAt = new Date().toISOString();
      } catch (error) { this.fail(error); }
      finally { this.flushing = null; this.notify(); }
      return this.status();
    })();
    return this.flushing;
  }
  async verify() {
    await this.flush();
    if (this.state !== 'connected') throw new Error('Turso is offline. Pending writes are safe in the local outbox.');
    const local = this.store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all();
    const remote = await this.client.execute({ sql: 'SELECT kind,id,value FROM rex_records WHERE workspace=? ORDER BY kind,id', args: [this.workspace] });
    const hash = rows => createHash('sha256').update(JSON.stringify(rows.map(row => [row.kind, row.id, row.value]))).digest('hex');
    const localEvents = Number(this.store.db.prepare('SELECT COUNT(*) AS total FROM events').get().total);
    const remoteEvents = Number((await this.client.execute({ sql: 'SELECT COUNT(*) AS total FROM rex_events WHERE workspace=?', args: [this.workspace] })).rows[0].total);
    return { matched: hash(local) === hash(remote.rows) && localEvents === remoteEvents, localRecords: local.length, remoteRecords: remote.rows.length, localEvents, remoteEvents };
  }
  async close() {
    clearTimeout(this.timer); clearInterval(this.retryTimer);
    if (this.opening) await this.opening;
    if (this.ready) await this.flush();
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
    if (!row) throw new Error('No workspace with that name is published in this database. On the first computer, sign in with a passphrase and connect Cloud backup.');
    return { id: row.workspace, name: row.name, sealed: { kdf: JSON.parse(row.kdf), sealedKey: row.sealed_key } };
  } finally { client.close(); }
}

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { issueBranch } from './branches.js';
import { validateFlowRuntime } from './flow-runtime.js';
import { TursoSync } from './turso.js';

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const defaults = {
  name: 'Rex', provider: 'claude', concurrency: 2, branchPrefix: 'temp/rex',
  syncMinutes: 5, requireVideo: true, reportToOrbit: false, autoPrLowRisk: false, sources: [], repositories: [],
  models: { claude: '', codex: '' },
};

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /api.?key|token|secret|password|authorization/i.test(key) ? '[redacted]' : redact(item)]));
}

export class Store extends EventEmitter {
  constructor(directory) {
    super();
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.directory, 'artifacts'), { recursive: true });
    const keyPath = path.join(this.directory, 'vault.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(path.join(this.directory, 'desk.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT, visible INTEGER, value TEXT, created_at TEXT);
      CREATE INDEX IF NOT EXISTS event_run ON events(run_id, sequence);`);
    this.fresh = !this.get('config', 'main');
    if (this.fresh) this.put('config', 'main', defaults);
    let token = this.get('secret', 'mcp-token');
    if (!token) { token = this.encrypt(randomBytes(32).toString('base64url')); this.put('secret', 'mcp-token', token); }
    this.token = this.decrypt(token);
    this.cloud = new TursoSync(this);
    // Running processes cannot be resurrected after a crash. Keep their history and make recovery explicit.
    for (const run of this.list('run')) {
      if (['running', 'queued', 'waiting', 'verifying', 'starting'].includes(run.state)) {
        this.put('run', run.id, { ...run, state: 'interrupted', endedAt: now(), error: 'Server restarted. Resume this run to continue.' });
      }
    }
    for (const prompt of this.list('interaction')) {
      if (prompt.state === 'pending') this.put('interaction', prompt.id, { ...prompt, state: 'expired' });
    }
  }

  get(kind, key) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, key);
    return row ? JSON.parse(row.value) : undefined;
  }
  list(kind) { return this.db.prepare('SELECT value FROM records WHERE kind=?').all(kind).map(row => JSON.parse(row.value)); }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  put(kind, key, value) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, key, JSON.stringify(value));
      this.cloud?.record(kind, key, value);
    });
    this.cloud?.schedule();
    this.emit('change', { kind, id: key });
    return value;
  }
  delete(kind, key) { this.transaction(() => { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, key); this.cloud?.remove(kind, key); }); this.cloud?.schedule(); this.emit('change', { kind, id: key }); }
  event(runId, kind, value, visible = false) {
    this.transaction(() => {
      const result = this.db.prepare('INSERT INTO events(run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?)').run(runId ?? '', kind, visible ? 1 : 0, JSON.stringify(redact(value)), now());
      this.cloud?.event(this.db.prepare('SELECT * FROM events WHERE sequence=?').get(result.lastInsertRowid));
    });
    this.cloud?.schedule();
    this.emit('change', { kind: 'event', runId });
  }
  events(runId, { visible = false, after = 0, limit = 500 } = {}) {
    return this.db.prepare(`SELECT * FROM events WHERE run_id=? AND sequence>? ${visible ? 'AND visible=1' : ''} ORDER BY sequence DESC LIMIT ?`)
      .all(runId, after, limit).reverse().map(row => ({ sequence: row.sequence, kind: row.kind, visible: Boolean(row.visible), ...JSON.parse(row.value), createdAt: row.created_at }));
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
  credential(sourceId) {
    const saved = this.get('secret', `source:${sourceId}`);
    return saved ? this.decrypt(saved) : '';
  }
  config() { return { ...defaults, ...this.get('config', 'main') }; }
  publicConfig() {
    const config = this.config();
    return { ...config, sources: config.sources.map(source => ({ ...source, hasKey: Boolean(this.credential(source.id)) })) };
  }
  saveConnection(source) {
    const config = this.publicConfig();
    const connection = { ...source, id: source.id || id() };
    return this.saveConfig({ ...config, sources: [...config.sources.filter(item => item.id !== connection.id), connection] }).sources.find(item => item.id === connection.id);
  }
  saveConfig(input) {
    const secretUpdates = [];
    if (!['claude', 'codex'].includes(input.provider)) throw new Error('Choose Claude Code or Codex.');
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 6) throw new Error('Concurrency must be 1–6.');
    if (!Number.isFinite(input.syncMinutes) || input.syncMinutes < 0 || input.syncMinutes > 1440) throw new Error('Sync interval must be 0–1440 minutes.');
    if (!Array.isArray(input.sources) || !Array.isArray(input.repositories)) throw new Error('Sources and repositories must be lists.');
    const sources = input.sources.map(source => {
      const sourceId = source.id || id();
      const base = new URL(source.baseUrl);
      if (base.protocol !== 'https:') throw new Error('Source APIs must use HTTPS.');
      if (!['flow', 'morningmate'].includes(source.type)) throw new Error('Unknown source type.');
      if (source.apiKey?.trim()) secretUpdates.push({ id: sourceId, value: this.encrypt(source.apiKey.trim()) });
      if (source.clearKey) secretUpdates.push({ id: sourceId, remove: true });
      return { id: sourceId, name: source.name || source.type, type: source.type, baseUrl: base.origin,
        userId: String(source.userId || '').trim(), projectIds: [...new Set((source.projectIds || []).map(String).filter(Boolean))],
        repositoryId: source.repositoryId || '', statusFilter: ['active', 'unfinished', 'all'].includes(source.statusFilter) ? source.statusFilter : 'active', statusMap: source.statusMap || {} };
    });
    const repositories = input.repositories.map(repository => {
      if (!path.isAbsolute(repository.path || '')) throw new Error('Repository path must be absolute.');
      const commands = ['setupCommand', 'devCommand', 'testCommand'].reduce((result, key) => ({ ...result, [key]: String(repository[key] || '') }), {});
      if (repository.devCommand && !repository.devCommand.includes('{port}')) throw new Error('Dev command must contain {port}, so concurrent runs use separate ports.');
      const branchPattern = String(repository.branchPattern || '').trim();
      issueBranch(branchPattern, { prefix: String(input.branchPrefix || 'temp/rex').replace(/^\/+|\/+$/g, '') });
      return { id: repository.id || id(), name: repository.name || path.basename(repository.path), path: path.resolve(repository.path),
        baseBranch: repository.baseBranch || 'develop', targetBranch: repository.targetBranch || repository.baseBranch || 'develop',
        branchPattern, flowRuntime: validateFlowRuntime(repository.flowRuntime), ...commands, browserPath: repository.browserPath || '/' };
    });
    const config = { ...defaults, name: String(input.name || 'Rex'), provider: input.provider,
      concurrency: input.concurrency, branchPrefix: String(input.branchPrefix || 'temp/rex').replace(/^\/+|\/+$/g, ''),
      syncMinutes: input.syncMinutes, requireVideo: input.requireVideo !== false, reportToOrbit: Boolean(input.reportToOrbit), autoPrLowRisk: Boolean(input.autoPrLowRisk), models: input.models || defaults.models, sources, repositories };
    for (const update of secretUpdates) {
      if (update.remove) this.delete('secret', `source:${update.id}`);
      else this.put('secret', `source:${update.id}`, update.value);
      this.delete('directory', update.id);
    }
    for (const source of this.config().sources) if (!sources.some(item => item.id === source.id)) {
      this.delete('secret', `source:${source.id}`);
      this.delete('directory', source.id);
      for (const task of this.list('task').filter(task => task.sourceId === source.id)) this.put('task', task.id, { ...task, active: false });
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

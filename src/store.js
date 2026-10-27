import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { issueBranch } from './branches.js';
import { validateFlowRuntime } from './flow-runtime.js';
import { validateElectronRuntime } from './electron-runtime.js';
import { TursoSync } from './turso.js';

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const defaults = {
  name: 'Rex', provider: 'claude', concurrency: 2, branchPrefix: 'temp/rex',
  syncMinutes: 5, requireVideo: true, reportToOrbit: false, autoPrLowRisk: false, sources: [], repositories: [],
  models: { claude: '', codex: '' }, agentProfiles: { claude: null, codex: null }, tourDismissed: false, execution: 'orca',
  schedule: { enabled: false, time: '09:00', days: [1, 2, 3, 4, 5], verify: true, fix: false, maxRuns: 6 }, jev: { model: '', auto: true }, testAccounts: [],
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
  return { enabled: Boolean(input.enabled), time, days, verify: input.verify !== false, fix: Boolean(input.fix), maxRuns };
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
    this.migrateConfig();
    this.cloud = new TursoSync(this);
    // Running processes cannot be resurrected after a crash. Keep their history and make recovery explicit.
    // An agent in an Orca terminal keeps running through a restart, so its run is reattached instead of interrupted.
    const reattached = new Set();
    for (const run of this.list('run')) {
      if (!['running', 'queued', 'waiting', 'verifying', 'starting'].includes(run.state)) continue;
      if (run.execution === 'orca' && String(run.sessionId || '').startsWith('orca:') && ['running', 'waiting'].includes(run.state)) { this.put('run', run.id, { ...run, state: 'running', reattach: true }); reattached.add(run.id); }
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
    if (config.execution !== 'orca') this.put('config', 'main', { ...config, execution: 'orca' });
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
  config() { return { ...defaults, ...this.get('config', 'main') }; }
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
        userId: [...new Set(String(source.userId || '').split(/[,;\n]/).map(value => value.trim()).filter(Boolean))].join(', '), projectIds: [...new Set((source.projectIds || []).map(String).filter(Boolean))],
        repositoryId: source.repositoryId || (input.repositories.length === 1 ? input.repositories[0].id || '' : ''), statusFilter: ['active', 'unfinished', 'all'].includes(source.statusFilter) ? source.statusFilter : 'active', statuses: [...new Set((Array.isArray(source.statuses) ? source.statuses : String(source.statuses || '').split('\n')).map(name => String(name).trim()).filter(Boolean))].slice(0, 100), statusMap: source.statusMap || {} };
    });
    const repositories = input.repositories.map(repository => {
      if (!path.isAbsolute(repository.path || '')) throw new Error('Repository path must be absolute.');
      const commands = ['setupCommand', 'devCommand', 'testCommand'].reduce((result, key) => ({ ...result, [key]: String(repository[key] || '') }), {});
      if (repository.devCommand && !repository.devCommand.includes('{port}')) throw new Error('Dev command must contain {port}, so concurrent runs use separate ports.');
      const branchPattern = String(repository.branchPattern || '').trim();
      issueBranch(branchPattern, { prefix: String(input.branchPrefix || 'temp/rex').replace(/^\/+|\/+$/g, '') });
      return { id: repository.id || id(), name: repository.name || path.basename(repository.path), path: path.resolve(repository.path),
        baseBranch: repository.baseBranch || 'develop', targetBranch: repository.targetBranch || repository.baseBranch || 'develop',
        branchPattern, flowRuntime: validateFlowRuntime(repository.flowRuntime), electronRuntime: validateElectronRuntime(repository.electronRuntime), ...commands, browserPath: repository.browserPath || '/' };
    });
    // One sign-in per site. A blank site is the fallback used wherever no site matches.
    const accounts = (Array.isArray(input.testAccounts) ? input.testAccounts : []).map(account => ({
      id: String(account.id || id()), site: String(account.site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 200),
      username: String(account.username || '').trim().slice(0, 200) })).filter(account => account.username);
    const config = { ...defaults, name: String(input.name || 'Rex'), provider: input.provider,
      concurrency: input.concurrency, branchPrefix: String(input.branchPrefix || 'temp/rex').replace(/^\/+|\/+$/g, ''),
      syncMinutes: input.syncMinutes, requireVideo: input.requireVideo !== false, reportToOrbit: Boolean(input.reportToOrbit), autoPrLowRisk: Boolean(input.autoPrLowRisk), models: { claude: modelName('claude', input.models?.claude), codex: modelName('codex', input.models?.codex) }, sources, repositories,
      agentProfiles: { claude: agentProfile(input.agentProfiles?.claude, 'Claude Code'), codex: agentProfile(input.agentProfiles?.codex, 'Codex') },
      tourDismissed: Boolean(input.tourDismissed), execution: 'orca', testAccounts: accounts,
      schedule: scheduleSettings(input.schedule), jev: { model: String(input.jev?.model || '').trim().slice(0, 120), auto: input.jev?.auto !== false } };
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

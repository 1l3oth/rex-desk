import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveCommand } from './processes.js';

// Agent sign-in lives in each CLI profile. Rex Desk only reads status; it never reads or copies credentials.
const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
const canonical = value => path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const directory = value => { try { return statSync(value).isDirectory(); } catch { return false; } };
const tilde = value => canonical(value).startsWith(canonical(home) + '/') ? `~${path.resolve(value).slice(path.resolve(home).length).replaceAll('\\', '/')}` : path.resolve(value);

export function inheritedProfile(provider, env = process.env) {
  return env.CLAUDE_CONFIG_DIR || '';
}
export function profileEnvironment(provider, profile, env = process.env) {
  const result = { ...env }, key = 'CLAUDE_CONFIG_DIR';
  const selected = profile === undefined ? inheritedProfile(provider, env) : profile;
  if (selected) result[key] = path.resolve(selected); else delete result[key];
  return result;
}
export function profileLabel(provider, profile) {
  if (!profile) return 'Default (~/.claude)';
  const orca = canonical(profile).match(/\/orca\/claude-profiles\/([^/]+)\/home$/);
  return orca ? `Orca profile ${orca[1].slice(0, 8)}` : tilde(profile);
}
export function discoverProfiles(provider, { configured = '', env = process.env, roots = { home, appData } } = {}) {
  const found = new Map();
  const add = (value, origin) => {
    const key = value ? canonical(value) : '';
    if (value && !directory(value)) return;
    if (!found.has(key)) found.set(key, { profile: value ? path.resolve(value) : '', label: profileLabel(provider, value), origin });
  };
  const name = '.claude';
  add('', 'default');
  if (inheritedProfile(provider, env)) add(inheritedProfile(provider, env), 'launch');
  try {
    for (const entry of readdirSync(roots.home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`${name}-`)) add(path.join(roots.home, entry.name), 'home');
    }
  } catch {}
  try {
    const config = path.join(roots.home, '.config');
    for (const entry of readdirSync(config, { withFileTypes: true })) if (entry.isDirectory() && /^claude/i.test(entry.name) && !/shared-history|\s$/i.test(entry.name)) add(path.join(config, entry.name), 'config');
  } catch {}
  const orca = path.join(roots.appData, 'orca', `${provider}-profiles`);
  try { for (const entry of readdirSync(orca, { withFileTypes: true })) if (entry.isDirectory()) add(path.join(orca, entry.name, 'home'), 'orca'); } catch {}
  if (configured) add(configured, 'saved');
  return [...found.values()];
}

// Each Claude account (profile folder) keeps its own conversations. When an agent moves to another account (the first one hit its
// usage limit, or the person switched), its conversation is copied into that account first, so it carries on instead of failing
// with "No conversation found". Only the conversation is copied, never a sign-in.
export function carrySession(sessionId, cwd, profile, { roots = { home, appData }, profiles } = {}) {
  if (!sessionId || !cwd) return false;
  const projects = value => path.join(value || path.join(roots.home, '.claude'), 'projects');
  const folder = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const target = path.join(projects(profile), folder, `${sessionId}.jsonl`);
  if (existsSync(target)) return false;
  for (const item of profiles || discoverProfiles('claude', { roots })) {
    const source = path.join(projects(item.profile), folder, `${sessionId}.jsonl`);
    if (!existsSync(source) || canonical(source) === canonical(target)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
    const extras = source.slice(0, -'.jsonl'.length);
    if (directory(extras)) cpSync(extras, target.slice(0, -'.jsonl'.length), { recursive: true });
    return true;
  }
  return false;
}

function capture(command, args, env, timeout) {
  return new Promise(resolve => {
    execFile(command, args, { env, windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error }));
  });
}
export function parseClaudeStatus(output) {
  const start = output.indexOf('{');
  if (start < 0) return null;
  try {
    const data = JSON.parse(output.slice(start));
    return { loggedIn: Boolean(data.loggedIn), method: String(data.authMethod || ''), account: String(data.email || ''),
      organization: String(data.orgName || ''), plan: String(data.subscriptionType || '') };
  } catch { return null; }
}

export class AgentProfiles {
  constructor(store, { run = capture, ttl = 120000 } = {}) { this.store = store; this.run = run; this.ttl = ttl; this.cache = new Map(); this.pending = new Map(); }
  selected(provider) {
    const saved = this.store.config().agentProfiles?.[provider];
    return saved === undefined || saved === null ? inheritedProfile(provider) : saved;
  }
  environment(provider, env = process.env) { return profileEnvironment(provider, this.selected(provider), env); }
  // An agent can be pinned to one Claude account; otherwise it uses the one chosen for everyone.
  environmentFor(provider, profile, env = process.env) { return profileEnvironment(provider, profile || this.selected(provider), env); }
  // Another signed-in account to move to when this one hits its usage limit. Accounts that hit theirs recently are skipped.
  async alternative(provider, current) {
    const limited = this.store.get('accounts', 'limited')?.until || {}, key = value => canonical(value || '');
    for (const item of discoverProfiles(provider, { configured: current })) {
      if (key(item.profile) === key(current) || (limited[key(item.profile)] || 0) > Date.now()) continue;
      const status = await this.status(provider, item.profile, { refresh: true }).catch(() => null);
      if (status?.loggedIn) return { profile: item.profile, label: status.label, account: status.account, plan: status.plan };
    }
    return null;
  }
  markLimited(profile, hours = 5) {
    const record = this.store.get('accounts', 'limited') || { id: 'limited', until: {} };
    this.store.put('accounts', 'limited', { ...record, until: { ...record.until, [canonical(profile || '')]: Date.now() + hours * 3600000 } });
  }
  async status(provider, profile = this.selected(provider), { refresh = false } = {}) {
    const key = `${provider}:${profile ? canonical(profile) : ''}`, cached = this.cache.get(key);
    if (!refresh && cached && Date.now() - cached.checkedAtMs < this.ttl) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const check = (async () => {
      const executable = resolveCommand(provider), env = profileEnvironment(provider, profile);
      const args = [...executable.args, 'auth', 'status', '--json'];
      const result = await this.run(executable.command, args, env, 20000);
      const parsed = parseClaudeStatus(result.stdout);
      const status = { provider, profile, label: profileLabel(provider, profile), checkedAt: new Date().toISOString(), checkedAtMs: Date.now(),
        installed: !(result.error?.code === 'ENOENT'), loggedIn: Boolean(parsed?.loggedIn), method: parsed?.method || '', account: parsed?.account || '',
        organization: parsed?.organization || '', plan: parsed?.plan || '',
        error: parsed ? '' : result.error?.code === 'ENOENT' ? 'Claude Code CLI is not installed.' : (result.stderr || result.stdout || 'Sign-in status unavailable.').trim().slice(0, 300) };
      this.cache.set(key, status); return status;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, check); return check;
  }
  async overview({ refresh = false } = {}) {
    const providers = await Promise.all(['claude'].map(async provider => {
      const selected = this.selected(provider), profiles = discoverProfiles(provider, { configured: selected });
      const statuses = await Promise.all(profiles.map(item => this.status(provider, item.profile, { refresh })));
      return [provider, { selected, saved: this.store.config().agentProfiles?.[provider] ?? null, inherited: inheritedProfile(provider), mcp: this.mcpInstalled(provider, selected),
        mcpEverywhere: profiles.every(item => this.mcpInstalled(provider, item.profile)),
        profiles: profiles.map((item, index) => ({ ...item, ...publicStatus(statuses[index]), mcp: this.mcpInstalled(provider, item.profile) })) }];
    }));
    return Object.fromEntries(providers);
  }
  async ensureSignedIn(provider) {
    const profile = this.selected(provider), status = await this.status(provider, profile);
    if (status.loggedIn) return status;
    const fresh = await this.status(provider, profile, { refresh: true });
    if (fresh.loggedIn) return fresh;
    const name = 'Claude Code';
    throw new Error(fresh.error && !fresh.installed ? fresh.error
      : `${name} profile ${fresh.label} is not signed in. Open Setup and choose a signed-in ${name} profile, then continue this run. No agent turn was started.`);
  }
  // Signs a profile in to a Claude account: Claude Code opens the browser, the person signs in, and the profile is ready.
  login(provider, profile) {
    const executable = resolveCommand(provider), env = profileEnvironment(provider, profile);
    const child = spawn(executable.command, [...executable.args, 'auth', 'login'], { env, windowsHide: false, detached: true, stdio: 'ignore' });
    child.unref(); this.invalidate(provider);
    return { started: true, profile, label: profileLabel(provider, profile) };
  }
  // A new profile folder for another Claude account. It shares the conversation history folder with the others when there is
  // one, so an agent keeps its conversation when it moves between accounts.
  addProfile(provider, name, { roots = { home } } = {}) {
    const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (!slug) throw new Error('Give the account a short name, like work or personal.');
    const folder = path.join(roots.home, '.config', `claude-${slug}`);
    if (existsSync(folder)) throw new Error(`There is already a profile called ${slug}.`);
    mkdirSync(folder, { recursive: true });
    const shared = path.join(roots.home, '.config', 'claude-code-shared-history');
    if (existsSync(shared)) { try { symlinkSync(shared, path.join(folder, 'projects'), 'junction'); } catch {} }
    return { profile: folder, label: profileLabel(provider, folder) };
  }
  invalidate(provider) { for (const key of this.cache.keys()) if (!provider || key.startsWith(`${provider}:`)) this.cache.delete(key); }
  mcpInstalled(provider, profile = this.selected(provider)) {
    try {
      const file = profile ? path.join(profile, '.claude.json') : path.join(home, '.claude.json');
      return existsSync(file) && Boolean(JSON.parse(readFileSync(file, 'utf8')).mcpServers?.rex_desk);
    } catch { return false; }
  }
}
export function publicStatus(status) {
  const { checkedAtMs, ...rest } = status;
  return rest;
}

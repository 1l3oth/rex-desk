import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  return provider === 'claude' ? env.CLAUDE_CONFIG_DIR || '' : env.CODEX_HOME || '';
}
export function profileEnvironment(provider, profile, env = process.env) {
  const result = { ...env }, key = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const selected = profile === undefined ? inheritedProfile(provider, env) : profile;
  if (selected) result[key] = path.resolve(selected); else delete result[key];
  return result;
}
export function profileLabel(provider, profile) {
  if (!profile) return provider === 'claude' ? 'Default (~/.claude)' : 'Default (~/.codex)';
  const orca = canonical(profile).match(/\/orca\/(?:claude|codex)-profiles\/([^/]+)\/home$/);
  return orca ? `Orca profile ${orca[1].slice(0, 8)}` : tilde(profile);
}
export function discoverProfiles(provider, { configured = '', env = process.env, roots = { home, appData } } = {}) {
  const found = new Map();
  const add = (value, origin) => {
    const key = value ? canonical(value) : '';
    if (value && !directory(value)) return;
    if (!found.has(key)) found.set(key, { profile: value ? path.resolve(value) : '', label: profileLabel(provider, value), origin });
  };
  const name = provider === 'claude' ? '.claude' : '.codex';
  add('', 'default');
  if (inheritedProfile(provider, env)) add(inheritedProfile(provider, env), 'launch');
  try {
    for (const entry of readdirSync(roots.home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`${name}-`)) add(path.join(roots.home, entry.name), 'home');
    }
  } catch {}
  const orca = path.join(roots.appData, 'orca', `${provider}-profiles`);
  try { for (const entry of readdirSync(orca, { withFileTypes: true })) if (entry.isDirectory()) add(path.join(orca, entry.name, 'home'), 'orca'); } catch {}
  if (configured) add(configured, 'saved');
  return [...found.values()];
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
export function parseCodexStatus(output, code) {
  const text = output.trim();
  if (/not logged in/i.test(text)) return { loggedIn: false, method: '', account: '', organization: '', plan: '' };
  const method = text.match(/logged in using (.+)$/im)?.[1]?.trim() || '';
  return { loggedIn: code === 0 && /logged in/i.test(text), method, account: '', organization: '', plan: '' };
}

export class AgentProfiles {
  constructor(store, { run = capture, ttl = 120000 } = {}) { this.store = store; this.run = run; this.ttl = ttl; this.cache = new Map(); this.pending = new Map(); }
  selected(provider) {
    const saved = this.store.config().agentProfiles?.[provider];
    return saved === undefined || saved === null ? inheritedProfile(provider) : saved;
  }
  environment(provider, env = process.env) { return profileEnvironment(provider, this.selected(provider), env); }
  async status(provider, profile = this.selected(provider), { refresh = false } = {}) {
    const key = `${provider}:${profile ? canonical(profile) : ''}`, cached = this.cache.get(key);
    if (!refresh && cached && Date.now() - cached.checkedAtMs < this.ttl) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const check = (async () => {
      const executable = resolveCommand(provider), env = profileEnvironment(provider, profile);
      const args = provider === 'claude' ? [...executable.args, 'auth', 'status', '--json'] : [...executable.args, 'login', 'status'];
      const result = await this.run(executable.command, args, env, 20000);
      const parsed = provider === 'claude' ? parseClaudeStatus(result.stdout) : parseCodexStatus(`${result.stdout}\n${result.stderr}`, result.code);
      const status = { provider, profile, label: profileLabel(provider, profile), checkedAt: new Date().toISOString(), checkedAtMs: Date.now(),
        installed: !(result.error?.code === 'ENOENT'), loggedIn: Boolean(parsed?.loggedIn), method: parsed?.method || '', account: parsed?.account || '',
        organization: parsed?.organization || '', plan: parsed?.plan || '',
        error: parsed ? '' : result.error?.code === 'ENOENT' ? `${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI is not installed.` : (result.stderr || result.stdout || 'Sign-in status unavailable.').trim().slice(0, 300) };
      this.cache.set(key, status); return status;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, check); return check;
  }
  async overview({ refresh = false } = {}) {
    const providers = await Promise.all(['claude', 'codex'].map(async provider => {
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
    const name = provider === 'claude' ? 'Claude Code' : 'Codex';
    throw new Error(fresh.error && !fresh.installed ? fresh.error
      : `${name} profile ${fresh.label} is not signed in. Open Setup and choose a signed-in ${name} profile, then continue this run. No agent turn was started.`);
  }
  invalidate(provider) { for (const key of this.cache.keys()) if (!provider || key.startsWith(`${provider}:`)) this.cache.delete(key); }
  mcpInstalled(provider, profile = this.selected(provider)) {
    try {
      if (provider === 'claude') {
        const file = profile ? path.join(profile, '.claude.json') : path.join(home, '.claude.json');
        return existsSync(file) && Boolean(JSON.parse(readFileSync(file, 'utf8')).mcpServers?.rex_desk);
      }
      const file = path.join(profile || path.join(home, '.codex'), 'config.toml');
      return existsSync(file) && /^\[mcp_servers\.rex_desk\]/m.test(readFileSync(file, 'utf8'));
    } catch { return false; }
  }
}
export function publicStatus(status) {
  const { checkedAtMs, ...rest } = status;
  return rest;
}

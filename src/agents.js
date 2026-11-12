import { AI_PROVIDERS, aiProvider, providerTitle, profileKey } from './codex.js';
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveCommand } from './processes.js';
import { agyCommand, antigravityMcpInstalled, parseAgyModels } from './antigravity.js';

// The command and arguments that check, and start, a provider's sign-in. Antigravity has no status command: listing the
// account's models only works when it is signed in. Its sign-in is `agy acp --login`, which opens Google sign-in and exits.
const cli = provider => provider === 'gemini' ? { command: agyCommand(), args: [] } : resolveCommand(provider);
const statusArgs = { claude: ['auth', 'status', '--json'], codex: ['login', 'status'], gemini: ['models'] };
const loginArgs = { claude: ['auth', 'login'], codex: ['login'], gemini: ['acp', '--login'] };

// Agent sign-in lives in each CLI profile. Rex Desk only reads status; it never reads or copies credentials.
const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
const canonical = value => path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const directory = value => { try { return statSync(value).isDirectory(); } catch { return false; } };
const tilde = value => canonical(value).startsWith(canonical(home) + '/') ? `~${path.resolve(value).slice(path.resolve(home).length).replaceAll('\\', '/')}` : path.resolve(value);

export function inheritedProfile(provider, env = process.env) {
  return env[profileKey(aiProvider(provider))] || '';
}
export function profileEnvironment(provider, profile, env = process.env) {
  const result = { ...env, REX_AI_PROVIDER: aiProvider(provider) }, key = profileKey(aiProvider(provider));
  const selected = profile === undefined ? inheritedProfile(provider, env) : profile;
  if (selected) result[key] = path.resolve(selected); else delete result[key];
  return result;
}
export function profileLabel(provider, profile) {
  if (!profile) return `Default (~/.${aiProvider(provider)})`;
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
  const name = `.${aiProvider(provider)}`;
  add('', 'default');
  if (inheritedProfile(provider, env)) add(inheritedProfile(provider, env), 'launch');
  try {
    for (const entry of readdirSync(roots.home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`${name}-`)) add(path.join(roots.home, entry.name), 'home');
    }
  } catch {}
  try {
    const config = path.join(roots.home, '.config');
    for (const entry of readdirSync(config, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith(provider) && !/shared-history|\s$/i.test(entry.name)) add(path.join(config, entry.name), 'config');
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

// Whether a Claude conversation is on this computer, in any profile. A conversation started on another computer is not.
export function conversationHere(sessionId, { roots = { home, appData }, profiles } = {}) {
  if (!sessionId) return false;
  for (const item of profiles || discoverProfiles('claude', { roots })) {
    const projects = path.join(item.profile || path.join(roots.home, '.claude'), 'projects');
    let folders = []; try { folders = readdirSync(projects, { withFileTypes: true }); } catch { continue; }
    if (folders.some(folder => folder.isDirectory() && existsSync(path.join(projects, folder.name, `${sessionId}.jsonl`)))) return true;
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
  constructor(store, { run = capture, ttl = 120000 } = {}) { this.store = store; this.run = run; this.ttl = ttl; this.cache = new Map(); this.pending = new Map(); this.standIn = new Map(); }
  // Agents and settings travel between computers (the shared database, a restore from backup), but a profile folder is only on the
  // computer that made it. A folder that is not here counts as not chosen.
  here(profile) { return profile && directory(profile) ? profile : ''; }
  selected(provider) {
    const saved = this.store.config().agentProfiles?.[provider];
    const chosen = saved === undefined || saved === null ? inheritedProfile(provider) : saved;
    return chosen && !directory(chosen) ? inheritedProfile(provider) : chosen;
  }
  // The profile a turn really uses: the chosen one, or the signed-in one standing in for it (see ensureSignedIn).
  use(provider, profile) { const chosen = this.here(profile) || this.selected(provider); return this.standIn.get(`${provider}:${canonical(chosen || '')}`) ?? chosen; }
  environment(provider, env = process.env) { return profileEnvironment(provider, this.use(provider), env); }
  // An agent can be pinned to one Claude account; otherwise it uses the one chosen for everyone.
  environmentFor(provider, profile, env = process.env) { return profileEnvironment(provider, this.use(provider, profile), env); }
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
      const executable = cli(provider), env = profileEnvironment(provider, profile);
      const args = [...executable.args, ...statusArgs[provider]];
      const result = await this.run(executable.command, args, env, 30000);
      const parsed = provider === 'gemini' ? { loggedIn: result.code === 0 && parseAgyModels(result.stdout).length > 0, method: 'Google', account: '', plan: '' } : provider === 'codex' ? { loggedIn: result.code === 0 && /Logged in using ChatGPT/i.test(result.stdout + result.stderr), method: /ChatGPT/i.test(result.stdout + result.stderr) ? 'ChatGPT' : '', account: '', plan: '' } : parseClaudeStatus(result.stdout);
      const status = { provider, profile, label: profileLabel(provider, profile), checkedAt: new Date().toISOString(), checkedAtMs: Date.now(),
        installed: !(result.error?.code === 'ENOENT'), loggedIn: Boolean(parsed?.loggedIn), method: parsed?.method || '', account: parsed?.account || '',
        organization: parsed?.organization || '', plan: parsed?.plan || '',
        error: parsed ? '' : result.error?.code === 'ENOENT' ? `${providerTitle(provider)} CLI is not installed.` : (result.stderr || result.stdout || 'Sign-in status unavailable.').trim().slice(0, 300) };
      this.cache.set(key, status); return status;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, check); return check;
  }
  async overview({ refresh = false } = {}) {
    const providers = await Promise.all(AI_PROVIDERS.map(async provider => {
      const selected = this.selected(provider), profiles = discoverProfiles(provider, { configured: selected });
      const statuses = await Promise.all(profiles.map(item => this.status(provider, item.profile, { refresh })));
      return [provider, { selected, saved: this.store.config().agentProfiles?.[provider] ?? null, inherited: inheritedProfile(provider), mcp: this.mcpInstalled(provider, selected),
        mcpEverywhere: profiles.every(item => this.mcpInstalled(provider, item.profile)),
        profiles: profiles.map((item, index) => ({ ...item, ...publicStatus(statuses[index]), mcp: this.mcpInstalled(provider, item.profile) })) }];
    }));
    return Object.fromEntries(providers);
  }
  async ensureSignedIn(provider, requested = this.selected(provider)) {
    const profile = this.here(requested) || this.selected(provider), key = `${provider}:${canonical(profile || '')}`;
    const status = await this.status(provider, profile);
    if (status.loggedIn) { this.standIn.delete(key); return status; }
    const fresh = await this.status(provider, profile, { refresh: true });
    if (fresh.loggedIn) { this.standIn.delete(key); return fresh; }
    // Not signed in here (often a profile chosen on another computer): another signed-in account on this computer stands in.
    const other = await this.alternative(provider, profile).catch(() => null);
    if (other) { this.standIn.set(key, other.profile); return this.status(provider, other.profile); }
    const name = providerTitle(provider);
    throw new Error(fresh.error && !fresh.installed ? fresh.error
      : `${name} profile ${fresh.label} is not signed in. Open Setup and choose a signed-in ${name} profile, then continue this run. No agent turn was started.`);
  }
  // Signs a profile in to a Claude account: Claude Code opens the browser, the person signs in, and the profile is ready.
  login(provider, profile) {
    const executable = cli(provider), env = profileEnvironment(provider, profile);
    if (provider === 'gemini' && executable.command === 'agy' && process.platform === 'win32') throw new Error('The Antigravity CLI (agy) is not installed on this computer. Install it with: winget install Google.AntigravityCLI');
    const child = spawn(executable.command, [...executable.args, ...loginArgs[provider]], { env, windowsHide: false, detached: true, stdio: 'ignore' });
    // A sign-in program that is not installed must never stop Rex Desk: the failure is only remembered for the status.
    child.on('error', error => { this.loginError = { provider, message: error.code === 'ENOENT' ? `${executable.command} is not installed on this computer.` : error.message, at: Date.now() }; this.invalidate(provider); });
    child.unref(); this.invalidate(provider);
    return { started: true, profile, label: profileLabel(provider, profile) };
  }
  // A new profile folder for another Claude account. It shares the conversation history folder with the others when there is
  // one, so an agent keeps its conversation when it moves between accounts.
  addProfile(provider, name, { roots = { home } } = {}) {
    const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (!slug) throw new Error('Give the account a short name, like work or personal.');
    const folder = path.join(roots.home, '.config', `${aiProvider(provider)}-${slug}`);
    if (existsSync(folder)) throw new Error(`There is already a profile called ${slug}.`);
    mkdirSync(folder, { recursive: true });
    const shared = path.join(roots.home, '.config', 'claude-code-shared-history');
    if (provider === 'claude' && existsSync(shared)) { try { symlinkSync(shared, path.join(folder, 'projects'), 'junction'); } catch {} }
    return { profile: folder, label: profileLabel(provider, folder) };
  }
  invalidate(provider) { for (const key of this.cache.keys()) if (!provider || key.startsWith(`${provider}:`)) this.cache.delete(key); }
  mcpInstalled(provider, profile = this.selected(provider)) {
    try {
      if (provider === 'gemini') return antigravityMcpInstalled();
      if (provider === 'codex') { const config = path.join(profile || path.join(home, '.codex'), 'config.toml'); return existsSync(config) && /\[mcp_servers\.rex_desk\]/.test(readFileSync(config, 'utf8')); }
      const file = profile ? path.join(profile, '.claude.json') : path.join(home, '.claude.json');
      return existsSync(file) && Boolean(JSON.parse(readFileSync(file, 'utf8')).mcpServers?.rex_desk);
    } catch { return false; }
  }
}
export function publicStatus(status) {
  const { checkedAtMs, ...rest } = status;
  return rest;
}

import { AI_PROVIDERS, aiProvider, providerTitle, profileKey } from './codex.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveCommand } from './processes.js';
import { agyCommand, antigravityMcpInstalled, parseAgyModels } from './antigravity.js';
import { checkOpenRouterKey, openrouterEnvironment, openrouterHome } from './openrouter.js';

// The command and arguments that check, and start, a provider's sign-in. Antigravity has no status command: listing the
// account's models only works when it is signed in. Its sign-in is `agy acp --login`, which opens Google sign-in and exits.
const cli = provider => provider === 'gemini' ? { command: agyCommand(), args: [] } : resolveCommand(provider);
const statusArgs = { claude: ['auth', 'status', '--json'], codex: ['login', 'status'], gemini: ['models'] };
const loginArgs = { claude: ['auth', 'login'], codex: ['login'], gemini: ['acp', '--login'] };
// What the sign-in window runs first when the CLI is not on this computer yet.
export const CODEX_WINDOWS_INSTALL = "$rexArch = if (($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -contains 'ARM64') { 'Arm64' } else { 'X64' }; "
  + "iex ([string](irm https://chatgpt.com/codex/install.ps1)).Replace('[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture', \"'$rexArch'\")";
const installCommands = {
  // Each tool's own installer, using only what Windows (PowerShell) and macOS (curl, bash) already have: no Node, npm, winget
  // or Homebrew, so a computer never set up for coding can install them too. On a Mac all three go to ~/.local/bin.
  // OpenAI's Codex script reads RuntimeInformation.OSArchitecture under strict mode, which Windows PowerShell 5.1 on an older
  // .NET Framework does not have ("property 'OSArchitecture' cannot be found"). The script is fetched and that one read is
  // replaced by the architecture from the environment, as the Claude and Antigravity scripts already do.
  win32: { claude: 'irm https://claude.ai/install.ps1 | iex', codex: CODEX_WINDOWS_INSTALL, gemini: 'irm https://antigravity.google/cli/install.ps1 | iex' },
  other: { claude: 'curl -fsSL https://claude.ai/install.sh | bash', codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', gemini: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' }
};
// `codex login status`: a ChatGPT account ("Logged in using ChatGPT") or an API key ("API key configured - sk-…", older
// versions "Logged in using an API key"). The key itself is never kept or shown.
export function codexStatus({ code = 0, stdout = '', stderr = '' } = {}) {
  const text = `${stdout}
${stderr}`, out = /not logged in/i.test(text);
  const chatgpt = !out && /Logged in using ChatGPT/i.test(text), apiKey = !out && /API key configured|Logged in using an API key/i.test(text);
  return { loggedIn: code === 0 && (chatgpt || apiKey), method: chatgpt ? 'ChatGPT' : apiKey ? 'API key' : '', account: '', plan: '' };
}
const bareName = { claude: 'claude', codex: 'codex', gemini: 'agy' };
// A CLI run as a script by Rex Desk's own node.exe (npm's codex.js) is only there when that script still is: node.exe always is.
export const cliFound = ({ command, args = [] }, exists = existsSync) => {
  const script = args.find(arg => /\.(c|m)?js$/i.test(String(arg)));
  if (script && !exists(script)) return false;
  if (path.isAbsolute(command)) return exists(command);
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; }
};
// The person's own terminal for a sign-in: without the markers of an AI agent, which make CLIs refuse to ask questions.
const terminalEnvironment = (env, keep) => Object.fromEntries(Object.entries(env).filter(([key]) => key === keep || !/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT.*|ANTHROPIC_.*|REX_.*|AI_AGENT|AGENT|CI|NODE_TEST_CONTEXT)$/i.test(key)));
const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
const shQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const signedInLine = 'When the browser says you are signed in, close this window and go back to Rex Desk.';
const notFoundLine = name => `${name} sign-in failed: ${name} was not found. Press Set up or Sign in in Rex Desk again to install it.`;
const exitLine = name => `${name} sign-in failed. Read the message above, then press Sign in again in Rex Desk.`;
// The file a found CLI really runs: npm's script for a node.exe launch, else the binary. Checked again in the window, since it can
// be gone by then (an nvm4w switch or an npm uninstall), and a run that never started must not say the browser is next.
const runFile = ({ command, args = [] }) => args.find(arg => /\.(c|m)?js$/i.test(String(arg))) || command;

// The PowerShell sign-in window. Says "close this window" only when the CLI exited 0; a missing CLI or a failed run says so, with
// the official installer, instead.
export function signInWindowScript({ name, found, install, executable, bare, args }) {
  const call = found ? `& ${[executable.command, ...executable.args, ...args].map(psQuote).join(' ')}` : `& ${psQuote(bare)} ${args.map(psQuote).join(' ')}`;
  const file = found && runFile(executable), checked = file && path.isAbsolute(file);
  const run = checked
    ? `if (Test-Path -LiteralPath ${psQuote(file)}) { ${call}; $rexCode = $LASTEXITCODE } else { $rexCode = 127 }`
    : `try { ${call}; $rexCode = $LASTEXITCODE } catch { $rexCode = 127 }`;
  return [
    "$Host.UI.RawUI.WindowTitle = 'Rex Desk sign-in'",
    `Write-Host ${psQuote(`Rex Desk: signing in to ${name}. Your browser opens next.`)}`, "Write-Host ''",
    ...(found ? [] : [`Write-Host ${psQuote(`${name} is not on this computer yet. Installing it first...`)}`, install,
      "$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + $env:Path",
      "$env:Path = (Join-Path $HOME '.local\\bin') + ';' + (Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin') + ';' + (Join-Path $env:LOCALAPPDATA 'agy\\bin') + ';' + (Join-Path $env:APPDATA 'npm') + ';' + $env:Path"]),
    run, "Write-Host ''",
    `if ($rexCode -eq 0) { Write-Host ${psQuote(signedInLine)} }`,
    `elseif ($rexCode -eq 127) { Write-Host ${psQuote(notFoundLine(name))}; Write-Host 'Or run its official installer in PowerShell:'; Write-Host ${psQuote(install)} }`,
    `else { Write-Host ${psQuote(exitLine(name))} }`
  ].join('\n');
}
// The same for the Mac and Linux terminal: one shell line.
export function signInShellLine({ name, found, install, executable, bare, args }) {
  const call = (found ? [executable.command, ...executable.args, ...args] : [bare, ...args]).map(shQuote).join(' ');
  const file = found && runFile(executable);
  const run = file && file.startsWith('/') ? `if [ -e ${shQuote(file)} ]; then ${call}; rc=$?; else rc=127; fi` : `${call}; rc=$?`;
  return `echo ${shQuote(`Rex Desk: signing in to ${name}.`)}; ${found ? '' : `${install}; export PATH="$HOME/.local/bin:$PATH"; `}${run}; echo; `
    + `if [ $rc -eq 0 ]; then echo ${shQuote(signedInLine)}; elif [ $rc -eq 127 ]; then echo ${shQuote(notFoundLine(name))}; echo 'Or run its official installer:'; echo ${shQuote(install)}; else echo ${shQuote(exitLine(name))}; fi`;
}

// Agent sign-in lives in each CLI profile. Rex Desk only reads status; it never reads or copies credentials.
const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
export const canonical = value => path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
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
    for (const entry of readdirSync(config, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith(provider) && !/shared-history|\.lock$|\s$/i.test(entry.name)) add(path.join(config, entry.name), 'config');
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

// Where each AI program sends people to sign in.
const SIGN_IN_HOSTS = { codex: ['openai.com', 'chatgpt.com'], claude: ['anthropic.com', 'claude.ai', 'claude.com'], gemini: ['google.com'] };

export class AgentProfiles {
  constructor(store, { run = capture, ttl = 120000, spawnHidden = spawn, checkKey = checkOpenRouterKey } = {}) { this.store = store; this.run = run; this.spawnHidden = spawnHidden; this.checkKey = checkKey; this.ttl = ttl; this.cache = new Map(); this.pending = new Map(); this.standIn = new Map(); }
  // The OpenRouter key: the one saved in Settings (encrypted, shared with Jev), else OPENROUTER_API_KEY from the launch environment.
  openrouterKey() { const saved = this.store.get?.('secret', 'openrouter'); try { return saved ? this.store.decrypt(saved) : process.env.OPENROUTER_API_KEY || ''; } catch { return ''; } }
  withKey(provider, env) { return provider === 'openrouter' ? openrouterEnvironment(env, this.openrouterKey(), this.store.directory ? openrouterHome(this.store.directory) : '') : env; }
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
  environment(provider, env = process.env) { return this.withKey(provider, profileEnvironment(provider, this.use(provider), env)); }
  // An agent can be pinned to one Claude account; otherwise it uses the one chosen for everyone.
  environmentFor(provider, profile, env = process.env) { return this.withKey(provider, profileEnvironment(provider, this.use(provider, profile), env)); }
  // Another signed-in account to move to when this one hits its usage limit. Accounts that hit theirs recently are skipped.
  async alternative(provider, current) {
    if (provider === 'openrouter') return null;
    const limited = this.store.get('accounts', 'limited')?.until || {}, key = value => canonical(value || '');
    for (const item of discoverProfiles(provider, { configured: current })) {
      if (key(item.profile) === key(current) || (limited[key(item.profile)] || 0) > Date.now()) continue;
      const status = await this.status(provider, item.profile, { refresh: true }).catch(() => null);
      if (status?.loggedIn) return { profile: item.profile, label: status.label, account: status.account, plan: status.plan };
    }
    return null;
  }
  // until: when the account's limit resets (from Claude's own usage report); 5 hours when that is not known.
  markLimited(profile, until = 0) {
    const record = this.store.get('accounts', 'limited') || { id: 'limited', until: {} };
    this.store.put('accounts', 'limited', { ...record, until: { ...record.until, [canonical(profile || '')]: until > Date.now() ? until : Date.now() + 5 * 3600000 } });
  }
  // The person chose this account: an earlier "limited" mark no longer keeps it out of the automatic switch.
  clearLimited(profile) {
    const record = this.store.get('accounts', 'limited'), key = canonical(profile || ''); if (!record?.until?.[key]) return;
    const { [key]: _gone, ...rest } = record.until; this.store.put('accounts', 'limited', { ...record, until: rest });
  }
  async status(provider, profile = this.selected(provider), { refresh = false } = {}) {
    const key = `${provider}:${profile ? canonical(profile) : ''}`, cached = this.cache.get(key);
    if (!refresh && cached && Date.now() - cached.checkedAtMs < this.ttl) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const check = (async () => {
      if (provider === 'openrouter') {
        const key = this.openrouterKey(), result = key ? await this.checkKey(key) : { ok: false, error: '' };
        const status = { provider, profile: '', label: 'OpenRouter key', checkedAt: new Date().toISOString(), checkedAtMs: Date.now(), installed: true, hasKey: Boolean(key), loggedIn: Boolean(result.ok),
          method: 'API key', account: result.label || '', organization: '', plan: result.ok ? (result.freeTier ? 'Free tier' : 'Pay as you go') : '', error: key && !result.ok ? result.error : '' };
        this.cache.set(`${provider}:`, status); return status;
      }
      const executable = cli(provider), env = profileEnvironment(provider, profile);
      const args = [...executable.args, ...statusArgs[provider]];
      const result = await this.run(executable.command, args, env, 30000);
      const parsed = provider === 'gemini' ? { loggedIn: result.code === 0 && parseAgyModels(result.stdout).length > 0, method: 'Google', account: '', plan: '' } : provider === 'codex' ? codexStatus(result) : parseClaudeStatus(result.stdout);
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
      // The same account signed in in two folders (Orca keeps its own copy of each sign-in) is one account: it shows once,
      // as the folder in use, otherwise the first one found (the person's own folders come before Orca's).
      const accountOf = index => statuses[index]?.loggedIn && statuses[index].account ? `${statuses[index].account.toLowerCase()}|${statuses[index].organization || ''}` : '';
      const inUse = canonical(this.use(provider, selected) || ''), shown = new Map();
      profiles.forEach((item, index) => { const key = accountOf(index); if (key && (!shown.has(key) || canonical(item.profile || '') === inUse)) shown.set(key, index); });
      const keep = profiles.map((item, index) => !accountOf(index) || shown.get(accountOf(index)) === index);
      const saved = this.store.config().agentProfiles?.[provider] ?? null;
      // A profile the person once saved whose folder has since disappeared: kept in the config, but agents fall back to the
      // default, so the tab says so (L119) instead of letting the account look chosen.
      const savedMissing = Boolean(saved && typeof saved === 'string' && !directory(saved));
      return [provider, { selected, saved, savedMissing, inherited: inheritedProfile(provider), mcp: this.mcpInstalled(provider, selected),
        mcpEverywhere: profiles.every(item => this.mcpInstalled(provider, item.profile)),
        profiles: profiles.map((item, index) => ({ ...item, ...publicStatus(statuses[index]), mcp: this.mcpInstalled(provider, item.profile) })).filter((item, index) => keep[index]) }];
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
    if (provider === 'openrouter') throw new Error(fresh.error || 'Add your OpenRouter key in Setup (AI accounts) first. No agent turn was started.');
    throw new Error(fresh.error && !fresh.installed ? fresh.error
      : `${name} profile ${fresh.label} is not signed in. Open Setup and choose a signed-in ${name} profile, then continue this run. No agent turn was started.`);
  }
  // Signs a profile in to a Claude account: Claude Code opens the browser, the person signs in, and the profile is ready.
  // background: no window at all. The install and the sign-in run hidden, the CLI opens the browser, and loginJob() tells the
  // page how far it got (installing, waiting for the browser, failed with a plain reason). The first-run screen uses it.
  login(provider, profile, { background = false } = {}) {
    if (provider === 'openrouter') throw new Error('OpenRouter has no sign-in: add your OpenRouter key instead.');
    const executable = cli(provider), env = profileEnvironment(provider, profile), found = cliFound(executable), name = providerTitle(provider);
    const install = (installCommands[process.platform === 'win32' ? 'win32' : 'other'] || {})[provider] || '';
    if (!found && !install) throw new Error(`${name} is not installed on this computer, and Rex Desk cannot install it here. Install it, then press Sign in again.`);
    // Codex keeps the saved account when it is asked to log in again, so a person who changed plan or account must be signed out first.
    if (provider === 'codex' && found) { try { execFileSync(executable.command, [...executable.args, 'logout'], { env, windowsHide: true, timeout: 15000, stdio: 'ignore' }); } catch {} }
    // The sign-in runs in a window the person can see: the CLI opens the browser, and anything it asks or any error shows there.
    // A missing CLI is installed first in the same window.
    const terminalEnv = terminalEnvironment(env, profileKey(aiProvider(provider))), args = loginArgs[provider];
    if (background) return this.loginHidden({ provider, profile, executable, found, install, name, env: terminalEnv, args });
    let child;
    if (process.platform === 'win32') {
      const script = signInWindowScript({ name, found, install, executable, bare: bareName[provider], args });
      // `start` gives it a window of its own (a console started straight from Rex Desk closes at once), and the encoded script
      // passes through cmd untouched, so `|`, `&` and quotes in it are not read by cmd.
      child = spawn('cmd.exe', ['/c', 'start', 'Rex Desk sign-in', 'powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: terminalEnv, windowsHide: false, detached: true, stdio: 'ignore' });
    } else {
      const key = profileKey(aiProvider(provider)), profileSet = env[key] ? `export ${key}=${shQuote(env[key])}; ` : '';
      const line = profileSet + signInShellLine({ name, found, install, executable, bare: bareName[provider], args });
      child = process.platform === 'darwin'
        ? spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'], { env: terminalEnv, detached: true, stdio: 'ignore' })
        : spawn('x-terminal-emulator', ['-e', 'bash', '-lc', `${line}; exec bash`], { env: terminalEnv, detached: true, stdio: 'ignore' });
    }
    // A sign-in window that cannot open must never stop Rex Desk: the failure is only remembered for the status.
    child.on('error', error => { this.loginError = { provider, message: `Rex Desk could not open the sign-in window: ${error.message}`, at: Date.now() }; this.invalidate(provider); });
    child.unref(); this.invalidate(provider);
    return { started: true, installing: !found, profile, label: profileLabel(provider, profile) };
  }
  loginHidden({ provider, profile, executable, found, install, name, env, args }) {
    this.jobs ||= new Map();
    const old = this.jobs.get(provider); if (old?.child && !old.done) { old.done = true; clearTimeout(old.timer); try { old.child.kill(); } catch {} }
    const MARK = 'REXDESK-SIGNIN-STARTS';
    let command, commandArgs;
    if (process.platform === 'win32') {
      const run = found ? `& ${[executable.command, ...executable.args, ...args].map(psQuote).join(' ')}` : `& ${psQuote(bareName[provider])} ${args.map(psQuote).join(' ')}`;
      const script = ["$ErrorActionPreference = 'Continue'", "$ProgressPreference = 'SilentlyContinue'",
        ...(found ? [] : [install,
          "$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + $env:Path",
          "$env:Path = (Join-Path $HOME '.local\\bin') + ';' + (Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin') + ';' + (Join-Path $env:LOCALAPPDATA 'agy\\bin') + ';' + (Join-Path $env:APPDATA 'npm') + ';' + $env:Path",
          `if (-not (Get-Command ${psQuote(bareName[provider])} -ErrorAction SilentlyContinue)) { Write-Output 'REXDESK-INSTALL-FAILED'; exit 3 }`]),
        `Write-Output '${MARK}'`, run, 'exit $LASTEXITCODE'].join('\n');
      [command, commandArgs] = ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
    } else {
      const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
      const run = found ? [executable.command, ...executable.args, ...args].map(quote).join(' ') : [bareName[provider], ...args].map(quote).join(' ');
      const line = `${found ? '' : `${install} || { echo REXDESK-INSTALL-FAILED; exit 3; }; export PATH="$HOME/.local/bin:$PATH"; `}echo ${MARK}; ${run}`;
      [command, commandArgs] = ['bash', ['-lc', line]];
    }
    const job = { provider, profile, state: found ? 'signing-in' : 'installing', url: '', error: '', at: Date.now(), output: '' };
    this.jobs.set(provider, job);
    const fail = message => { if (job.done) return; job.done = true; job.state = 'failed'; job.error = message; clearTimeout(job.timer); this.invalidate(provider); };
    let child;
    // stdin stays open: a CLI that cannot open the browser waits for a pasted code instead of quitting at once.
    try { child = this.spawnHidden(command, commandArgs, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (error) { fail(`Rex Desk could not start the ${name} sign-in: ${error.message}`); return { started: false, background: true, profile, ...this.loginJob(provider) }; }
    job.child = child;
    const read = chunk => {
      job.output = (job.output + String(chunk)).slice(-6000);
      if (job.state === 'installing' && job.output.includes(MARK)) job.state = 'signing-in';
      // The sign-in page, for when the browser did not open by itself. Only what the CLI prints after the install.
      const after = job.output.split(MARK)[1];
      // Only a page on this AI's own sign-in hosts, never any other link the output holds.
      if (after !== undefined && !job.url) {
        for (const [found] of after.matchAll(/https:\/\/[^\s"'<>]+/g)) {
          const link = found.replace(/[).,]+$/, '');
          let host = ''; try { host = new URL(link).hostname.toLowerCase(); } catch {}
          if ((SIGN_IN_HOSTS[provider] || []).some(known => host === known || host.endsWith(`.${known}`))) { job.url = link; break; }
        }
      }
    };
    child.stdout?.on('data', read); child.stderr?.on('data', read);
    child.on('error', error => fail(`Rex Desk could not start the ${name} sign-in: ${error.message}`));
    child.on('exit', code => {
      if (job.done) return;
      if (code === 0) { job.done = true; job.state = 'finished'; clearTimeout(job.timer); this.invalidate(provider); return; }
      if (job.output.includes('REXDESK-INSTALL-FAILED') || job.state === 'installing') fail(`${name} could not be installed. Check that this computer is online, then try again.`);
      else fail(`The ${name} sign-in did not finish. Try again, and finish it in the browser page that opens.`);
    });
    // Nobody finished it in fifteen minutes: stop waiting.
    job.timer = setTimeout(() => { if (!job.done) { try { child.kill(); } catch {} fail(`The ${name} sign-in waited too long. Try again when you are ready.`); } }, 15 * 60000);
    job.timer.unref?.();
    this.invalidate(provider);
    return { started: true, installing: !found, background: true, profile, label: profileLabel(provider, profile) };
  }
  // How far the hidden sign-in of one AI got, without its output (it can hold an account name or a code).
  loginJob(provider) {
    const job = this.jobs?.get(provider);
    return job ? { provider, state: job.state, url: job.url, error: job.error, at: job.at } : { provider, state: 'none' };
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
      if (provider === 'openrouter') return true;
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

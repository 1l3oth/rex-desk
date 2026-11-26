import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stopTree } from './processes.js';

// This Rex Desk, for the stdio proxy agy runs to reach the desk tools.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Gemini through Google's own Antigravity CLI (agy), signed in with the person's Google account. Rex Desk talks to it over the
// Agent Client Protocol (agy acp: JSON-RPC on stdio) and never reads, copies or stores the Google sign-in.

// Where agy lives: the REX_AGY_PATH override, any PATH folder, or the folders its installers use. A Rex Desk server started
// before agy was installed has an older PATH, so the install folders are searched directly too.
export function agyCommand(env = process.env) {
  if (env.REX_AGY_PATH) return env.REX_AGY_PATH;
  if (process.platform !== 'win32') return 'agy';
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const folders = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  try { for (const entry of readdirSync(packages)) if (/^Google\.AntigravityCLI/i.test(entry)) folders.push(path.join(packages, entry)); } catch {}
  folders.push(path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(local, 'Programs', 'Antigravity', 'bin'), path.join(local, 'agy'), path.join(local, 'agy', 'bin'), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin'));
  return folders.map(folder => path.join(folder, 'agy.exe')).find(file => existsSync(file)) || 'agy';
}

// The Rex Desk tools reach agy through its own MCP list (it ignores servers handed over in the session). agy reads it from
// its global file, the same on Windows and Mac: ~/.gemini/config/mcp_config.json (antigravity.google/docs/mcp). An entry is
// { command, args } for a stdio server, under the mcpServers map.
export function antigravityMcpPath(home = os.homedir()) { return path.join(home, '.gemini', 'config', 'mcp_config.json'); }
export function antigravityMcpInstalled(home = os.homedir()) {
  try { return Boolean(JSON.parse(readFileSync(antigravityMcpPath(home), 'utf8')).mcpServers?.rex_desk); } catch { return false; }
}
// The installed app's own payload. Its path stays put across updates (the Windows installer and the Mac in-place swap keep
// the same folder), while the agents' private runtime copy this server may be running from lives in a version-named folder
// that is removed after the next update. So the persistent entry must point at the installed payload, not that copy, or a
// standalone agy run breaks the moment the copy is cleaned up. Returns the stable node binary and payload root only when
// both are really on disk, so a wrong guess never writes a dead path; otherwise the caller keeps the running copy's paths,
// which Rex Desk rewrites on the next Gemini run anyway.
export function installedPayload(env = process.env, execPath = process.execPath) {
  const exe = env.REX_DESK_EXE;
  if (!exe) return null;
  let install = path.dirname(path.resolve(exe));
  if (path.basename(install) === 'MacOS' && path.basename(path.dirname(install)) === 'Contents') install = path.dirname(path.dirname(install));
  const base = path.basename(execPath);
  // The real shipped layout is payload/app (the app root) beside payload/node/<node> (desktop/src-tauri/src/main.rs:407-410),
  // Windows as install/payload and Mac as install/Contents/Resources/payload. The flatter guesses stay as a fallback.
  const roots = [path.join(install, 'payload', 'app'), path.join(install, 'Contents', 'Resources', 'payload', 'app'),
    install, path.join(install, 'app'), path.join(install, 'resources', 'app'), path.join(install, 'Contents', 'Resources', 'app')];
  for (const root of roots) {
    if (!existsSync(path.join(root, 'src', 'stdio.js'))) continue;
    // node sits in a sibling node/ folder under the same payload, or beside the app, or in install/node.
    const node = [path.join(path.dirname(root), 'node', base), path.join(root, base), path.join(install, base), path.join(install, 'node', base)].find(existsSync);
    if (node) return { node, root };
  }
  return null;
}
// The rex_desk stdio entry: run this Rex Desk's proxy. No token is written here (the proxy reads the encrypted vault at run
// time); the stable data folder is carried so the proxy still finds the local sign-in key when agy runs the entry on its own,
// and this desk's real address is carried so a standalone run reaches the port it actually listens on, not stdio.js's 4317
// default (the installed app moves off 4317 when it is taken). With Rex Desk closed nothing answers there, so the proxy fails
// with a plain connection error instead of talking to a stranger on 4317.
export function antigravityMcpEntry({ node = process.execPath, root = packageRoot, env = process.env } = {}) {
  const stable = installedPayload(env, node);
  const entry = { command: stable ? stable.node : node, args: [path.join(stable ? stable.root : root, 'src', 'stdio.js')] };
  const carried = {};
  if (env.REX_DATA_DIR) carried.REX_DATA_DIR = env.REX_DATA_DIR;
  if (env.REX_DESK_URL) carried.REX_DESK_URL = env.REX_DESK_URL;
  if (Object.keys(carried).length) entry.env = carried;
  return entry;
}
// A pid is still running (EPERM means it exists but is another user's), so its lock is live, not stale.
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const lockSleep = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* sleep best effort */ } };
// A short cross-process lock, so two writers (two Gemini runs, or another Rex Desk) never read one file and then both replace
// it, losing one's entry. pid-based like the server's runtime.lock: a lock whose owner is gone is stale and cleared. Returns a
// release function, or null when a live writer still holds it (the caller then leaves the file untouched).
function lockMcpFile(file, { tries = 40, waitMs = 25 } = {}) {
  const lockPath = `${file}.lock`;
  for (let attempt = 0; attempt < tries; attempt++) {
    try { writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } }; }
    catch (error) {
      if (error.code !== 'EEXIST') return null;
      let stale = false;
      try { const owner = Number(readFileSync(lockPath, 'utf8')); stale = !(Number.isInteger(owner) && owner > 0) || !pidAlive(owner); } catch { stale = false; }
      if (stale) { try { unlinkSync(lockPath); continue; } catch { /* someone else took it */ } }
      lockSleep(waitMs);
    }
  }
  return null;
}

// Put the rex_desk entry into agy's own MCP list, so a Gemini run has the desk tools instead of none (the agent then tells
// the person to switch to Claude). It is merged in, keeping every other server and every other key. The person's file is
// never destroyed: the read and the replace happen under a lock so two writers cannot overwrite each other; an unreadable or
// unparseable file is left exactly as it is (never treated as empty and overwritten); a rex_desk entry the person owns (one
// that does not run this proxy's stdio.js) is kept untouched; a valid file is backed up to mcp_config.json.bak, created
// exclusively so it is written once and an existing recovery copy is never clobbered, and if that backup cannot be written
// the original is kept untouched. The replacement is written to a temp file and renamed into place, so agy never reads a
// half-written file. Returns whether the entry is in place afterwards.
export function ensureAntigravityMcp({ home = os.homedir(), node = process.execPath, root = packageRoot, env = process.env } = {}) {
  const file = antigravityMcpPath(home), entry = antigravityMcpEntry({ node, root, env });
  try { mkdirSync(path.dirname(file), { recursive: true }); } catch { return false; }
  const release = lockMcpFile(file);
  if (!release) return false; // a live writer holds it: leave the file untouched rather than risk overwriting it
  try {
    const exists = existsSync(file);
    let raw = null;
    if (exists) { try { raw = readFileSync(file, 'utf8'); } catch { return false; } } // unreadable: never wipe what we cannot read
    let data = {};
    if (raw !== null && raw.trim()) {
      try { data = JSON.parse(raw); } catch { return false; } // broken JSON: not empty; keep the user's file, do not overwrite
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    }
    if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) data.mcpServers = {};
    const current = data.mcpServers.rex_desk, isObject = Boolean(current) && typeof current === 'object' && !Array.isArray(current);
    // Ours runs this Rex Desk's stdio proxy; a rex_desk entry pointing anywhere else is the person's own, left as it is.
    const ours = isObject && Array.isArray(current.args) && typeof current.args[0] === 'string' && /(^|[\\/])src[\\/]stdio\.js$/.test(current.args[0]);
    if (isObject && !ours) return true;
    if (ours && current.command === entry.command && current.args[0] === entry.args[0] && JSON.stringify(current.env ?? null) === JSON.stringify(entry.env ?? null)) return true;
    // Keep any extra fields on our own entry (cwd, timeout), only set command, args and our carried env.
    data.mcpServers.rex_desk = { ...(ours ? current : {}), ...entry };
    if (exists && raw && raw.trim()) { try { writeFileSync(`${file}.bak`, raw, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') return false; } }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, file);
    return antigravityMcpInstalled(home);
  } catch { return false; } finally { release(); }
}

// Signed in when agy can list the account's models; the list is the proof, nothing is read from the sign-in itself.
export function parseAgyModels(output = '') {
  return String(output).split(/\r?\n/).map(line => line.split('\t')).filter(parts => parts.length >= 2 && /^[\w.-]+$/.test(parts[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim(), hint: '' }));
}

export class AcpClient {
  constructor({ env = process.env, cwd, args = [], spawnProcess = spawn, onNotification = () => {}, onRequest, onError = () => {}, timeoutMs = 60000 } = {}) {
    Object.assign(this, { env, cwd, args, spawnProcess, onNotification, onRequest, onError, timeoutMs });
    this.pending = new Map(); this.nextId = 0; this.closed = false;
  }
  async open() {
    if (this.cwd && !existsSync(this.cwd)) throw new Error(`The agent's folder does not exist: ${this.cwd}`);
    this.child = this.spawnProcess(agyCommand(this.env), ['acp', ...this.args],{ env: this.env, cwd: this.cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.once('error', error => this.fail(error.code === 'ENOENT' ? new Error(`The Antigravity CLI (agy) is not installed. Install it with: ${process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex (in PowerShell)' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash'}`) : error));
    this.child.once('exit', code => { if (!this.closed) this.fail(new Error(`Antigravity CLI exited (${code}).`)); });
    this.child.stdin.on('error', error => { if (!this.closed) this.fail(error); });
    this.child.stderr.resume();
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        Promise.resolve().then(() => {
          if (!this.onRequest) throw new Error('This Antigravity request needs an interactive Rex Desk run.');
          return this.onRequest(message.method, message.params || {});
        }).then(result => this.send({ jsonrpc: '2.0', id: message.id, result }), error => this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } })).catch(() => {});
      } else if (message.method) {
        try { this.onNotification(message.method, message.params || {}); } catch (error) { this.fail(error); }
      } else {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'Antigravity request failed.')); else pending.resolve(message.result);
      }
    });
    this.info = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'rex_desk', title: 'Rex Desk', version: '0.1.0' } });
    return this;
  }
  send(message) { if (this.closed) throw new Error('Antigravity connection closed.'); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  notify(method, params = {}) { try { this.send({ jsonrpc: '2.0', method, params }); } catch {} }
  // A prompt turn can run for as long as the agent works, so it has no time limit.
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Antigravity ${method} timed out.`)); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) { if (this.closed) return; this.onError(error); this.close(error); }
  close(error = new Error('Antigravity connection closed.')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.lines?.close(); this.child?.stdin.end(); stopTree(this.child);
  }
}

// Rex Desk's permission modes in Antigravity's words. Dangerous approves every tool call; the others are agy's own modes.
export const antigravityMode = mode => ({ manual: 'default', acceptEdits: 'accept-edits', auto: 'auto', plan: 'plan' })[mode] || '';
const thought = effort => effort ? (['xhigh', 'max'].includes(effort) ? 'high' : effort) : '';
const resultText = output => typeof output === 'string' ? output : output?.output ?? (output && Object.keys(output).length ? JSON.stringify(output) : '');

// No mode set means Dangerous, the mode Rex Desk agents start with, the same as for Claude.
const dangerous = mode => !mode || mode === 'bypassPermissions';

// Antigravity's own tools under the names the chat knows, so a command shows what it ran (and its output in the terminal
// panel) and a file read says which file, instead of a bare "Uses run command". The original input is kept too.
export function antigravityTool(name, input = {}, platform = process.platform) {
  const file = input.Path || input.AbsolutePath || input.TargetFile || input.FilePath || input.File || '';
  const as = (tool, extra) => ({ tool, input: { ...input, ...extra } });
  switch (name) {
    case 'run_command': return as(platform === 'win32' ? 'PowerShell' : 'Bash', { command: input.CommandLine || input.Command || '', description: input.toolSummary || '' });
    case 'read_file': case 'view_file': case 'view_file_outline': return as('Read', { file_path: file });
    case 'write_to_file': return as('Write', { file_path: file });
    case 'replace_file_content': case 'multi_replace_file_content': case 'edit_file': return as('Edit', { file_path: file });
    case 'grep_search': return as('Grep', { pattern: input.Query || input.Pattern || '' });
    case 'find_by_name': case 'list_dir': return as('Glob', { pattern: input.Pattern || input.DirectoryPath || input.SearchDirectory || '' });
    case 'search_web': return as('WebSearch', { query: input.query || input.Query || '' });
    case 'read_url_content': return as('WebFetch', { url: input.Url || input.url || '' });
    default: return { tool: name, input };
  }
}

export class AntigravityRunner {
  constructor(options) { Object.assign(this, options); this.event ||= () => {}; this.text = ''; this.pendingText = ''; }
  flush() { if (!this.pendingText.trim()) { this.pendingText = ''; return; } this.event('agent-text', { text: this.pendingText.trim() }); this.pendingText = ''; }
  async request(method, params) {
    if (method !== 'session/request_permission') throw new Error(`Unsupported Antigravity request: ${method}`);
    const allow = params.options?.find(option => /^allow/.test(option.kind)) || params.options?.[0], deny = params.options?.find(option => /^reject/.test(option.kind));
    // Rex Desk's own tools (desk_message, desk_memory...) run without asking, the same as for Claude.
    const input = params.toolCall?.rawInput || params.toolCall?.args || {};
    const rexTool = input.ServerName === 'rex_desk' && /^desk_/.test(String(input.ToolName || ''));
    if (dangerous(this.run.permissionMode) || (rexTool && this.ask)) return { outcome: { outcome: 'selected', optionId: allow?.optionId } };
    // A one-shot text answer (naming, a query) has nobody to ask, so it never runs a tool.
    if (!this.ask) return { outcome: deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
    const call = params.toolCall || {};
    const answer = await this.ask({ kind: 'approval', title: call.title ? `Antigravity: ${call.title}` : 'Approve an Antigravity action', request: { tool: call.name, input: call.rawInput || call.args || {} }, method: 'antigravity-permission' });
    return { outcome: answer.action === 'accept' ? { outcome: 'selected', optionId: allow?.optionId } : deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
  }
  notification(method, params) {
    if (method !== 'session/update' || (this.sessionId && params.sessionId !== this.sessionId) || !this.live) return;
    const update = params.update || {};
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      this.text += update.content.text; this.pendingText += update.content.text;
      // The words so far, for read-aloud to speak while Gemini is still writing (as Claude's do).
      if (Date.now() - (this.partialAt || 0) > 120) { this.partialAt = Date.now(); this.event('agent-text-partial', { text: this.pendingText }); }
    }
    if (update.sessionUpdate === 'tool_call') {
      this.flush();
      this.event('agent-tool', { id: update.toolCallId, ...antigravityTool(update.name || update.kind || 'tool', update.rawInput || update.args || {}) });
    }
    if (update.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) {
      this.event('agent-tool-result', { id: update.toolCallId, text: String(resultText(update.rawOutput)).slice(-6000), failed: update.status === 'failed' || Boolean(update.rawOutput?.exit_code) });
    }
  }
  async start(prompt) {
    if (this.signal?.aborted) throw new Error('Antigravity was stopped.');
    // Gemini's CLI reads only its own MCP list, so put the Rex Desk tools in it before agy starts, or the agent has none of
    // the desk_ tools and tells the person to switch to Claude. Merged in, keeping every other server (#a93b8959). Not in a
    // test run, which must not write the real home folder.
    const rexToolsReady = process.env.NODE_TEST_CONTEXT ? true : ensureAntigravityMcp({ node: process.execPath, env: { ...process.env, REX_DESK_URL: this.mcpUrl || '' } });
    const env = { ...this.agentEnv, REX_DESK_TOKEN: this.token || '', REX_AGENT_TOKEN: this.token || '', REX_DESK_URL: this.mcpUrl || '' };
    let failed; const broken = new Promise((resolve, reject) => { failed = reject; }); broken.catch(() => {});
    this.client = (this.clientFactory || (options => new AcpClient(options)))({ env, cwd: this.cwd, args: dangerous(this.run.permissionMode) ? ['--dangerously-skip-permissions'] : [],
      onNotification: (method, params) => this.notification(method, params), onRequest: (method, params) => this.request(method, params), onError: error => failed(error) });
    const abort = () => { if (this.sessionId) this.client.notify('session/cancel', { sessionId: this.sessionId }); failed(new Error('Antigravity was stopped.')); setTimeout(() => this.client.close(), 500); };
    this.signal?.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([this.client.open(), broken]);
      const extra = [this.projectDirectory, this.artifactDirectory, this.uploadsDirectory].filter(folder => folder && folder !== this.cwd);
      const base = { cwd: this.cwd, mcpServers: [], ...(extra.length ? { additionalDirectories: extra } : {}) };
      let session;
      if (this.run.sessionId) session = await this.client.request('session/resume', { ...base, sessionId: this.run.sessionId }).catch(() => null);
      this.sessionId = session ? this.run.sessionId : (await Promise.race([this.client.request('session/new', base), broken])).sessionId;
      this.event('session', { sessionId: this.sessionId, apiKeySource: 'subscription' });
      const set = (configId, value) => value ? this.client.request('session/set_config_option', { sessionId: this.sessionId, configId, value }) : null;
      await set('model', this.model);
      await set('thought_level', thought(this.run.effort))?.catch(() => {});
      await this.setMode(set);
      this.live = true;
      // If the entry still could not be written, say so in one line with the one place that fixes it, instead of leaving the
      // agent to tell the person to switch to Claude.
      if (!rexToolsReady && this.ask) {
        const id = 'rex-tools-missing';
        this.event('agent-tool', { id, tool: 'Rex Desk tools', input: { description: 'Rex Desk could not add its tools to Gemini on this computer. Open Settings, AI connection, choose Gemini and press Add tools, then send your message again.' } });
        this.event('agent-tool-result', { id, text: `Could not write ${antigravityMcpPath()}.`, failed: true });
      }
      const result = await Promise.race([this.client.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] }, 0), broken]);
      this.flush();
      if (result.stopReason === 'cancelled') throw new Error('Antigravity was stopped.');
      const usage = result.usage || {};
      this.tokens = { input: usage.inputTokens || 0, output: usage.outputTokens || 0, cacheRead: usage.cachedReadTokens || 0, cacheWrite: usage.cachedWriteTokens || 0 };
      this.event('context', { used: (usage.inputTokens || 0) + (usage.cachedReadTokens || 0), window: /claude/i.test(this.model || '') ? 200000 : 1000000 });
      this.event('agent-result', { result: this.text, tokens: this.tokens, billedToApiKey: false });
      return { status: 'completed' };
    } finally { this.signal?.removeEventListener('abort', abort); this.client.close(); }
  }
  // Auto needs agy's OS terminal sandbox, which is not on every computer yet. When agy refuses it, the turn goes on in
  // Accept edits (agy's next safest mode) with one quiet step line, and later turns go straight to Accept edits.
  async setMode(set) {
    const mode = antigravityMode(this.run.permissionMode);
    if (mode !== 'auto') return set('mode', mode);
    if (AntigravityRunner.autoRefused) return set('mode', 'accept-edits');
    try { return await set('mode', 'auto'); } catch (error) {
      // Only agy's own "Auto is not available" answer is remembered; a timeout or other hiccup tries Auto again next turn.
      if (autoUnsupported(error)) AntigravityRunner.autoRefused = true;
      await set('mode', 'accept-edits');
      const id = 'auto-mode-fallback', reason = String(error?.message || error).slice(0, 300);
      this.event('agent-tool', { id, tool: 'Mode', input: { description: 'Auto mode is not available on this computer, so Gemini uses Accept edits', reason } });
      this.event('agent-tool-result', { id, text: reason, failed: false });
    }
  }
  async interrupt() { if (this.sessionId) this.client?.notify('session/cancel', { sessionId: this.sessionId }); setTimeout(() => this.client?.close(), 500); }
  close() { this.client?.close(); }
}

// agy's refusal reads like "Auto mode is not available: it needs the OS terminal sandbox...". Only a plain refusal counts:
// a passing failure ("Auto sandbox initialization failed") leaves Auto on for the next turn.
export const autoUnsupported = error => {
  const text = String(error?.message || error || '');
  return !/timed out|stopped|closed|exited/i.test(text) && /\bauto\b/i.test(text) && /not (available|supported|enabled|(yet )?rolled out)|unsupported|unavailable|unknown mode|invalid mode/i.test(text);
};

export async function antigravityModels({ env = process.env, cwd, clientFactory = options => new AcpClient(options) } = {}) {
  const client = clientFactory({ env, cwd: cwd || os.homedir() });
  try {
    await client.open();
    const session = await client.request('session/new', { cwd: cwd || os.homedir(), mcpServers: [] });
    const options = session.configOptions?.find(item => item.id === 'model')?.options || [];
    return options.map(item => ({ id: item.value, label: item.name || item.value, hint: item.description || '', efforts: ['low', 'medium', 'high'] }));
  } finally { client.close(); }
}

export async function antigravityText(prompt, { env, cwd, timeoutMs = 90000 } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const runner = new AntigravityRunner({ run: { permissionMode: 'manual' }, agentEnv: env, cwd: cwd || os.homedir(), signal: controller.signal });
  try { await runner.start(prompt); return runner.text || ''; } finally { clearTimeout(timer); }
}

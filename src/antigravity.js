import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stopTree } from './processes.js';

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
  folders.push(path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(local, 'Programs', 'Antigravity', 'bin'), path.join(local, 'agy'), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin'));
  return folders.map(folder => path.join(folder, 'agy.exe')).find(file => existsSync(file)) || 'agy';
}

// The Rex Desk tools reach agy through its own MCP list (it ignores servers handed over in the session), installed once from Setup.
export function antigravityMcpInstalled(home = os.homedir()) {
  try { return Boolean(JSON.parse(readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers?.rex_desk); } catch { return false; }
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
    this.child.once('error', error => this.fail(error.code === 'ENOENT' ? new Error('The Antigravity CLI (agy) is not installed. Install it with: winget install Google.AntigravityCLI') : error));
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
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') { this.text += update.content.text; this.pendingText += update.content.text; }
    if (update.sessionUpdate === 'tool_call') {
      this.flush();
      this.event('agent-tool', { id: update.toolCallId, tool: update.name || update.kind || 'tool', input: update.rawInput || update.args || {} });
    }
    if (update.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) {
      this.event('agent-tool-result', { id: update.toolCallId, text: String(resultText(update.rawOutput)).slice(-6000), failed: update.status === 'failed' || Boolean(update.rawOutput?.exit_code) });
    }
  }
  async start(prompt) {
    if (this.signal?.aborted) throw new Error('Antigravity run interrupted.');
    const env = { ...this.agentEnv, REX_DESK_TOKEN: this.token || '', REX_AGENT_TOKEN: this.token || '', REX_DESK_URL: this.mcpUrl || '' };
    let failed; const broken = new Promise((resolve, reject) => { failed = reject; }); broken.catch(() => {});
    this.client = (this.clientFactory || (options => new AcpClient(options)))({ env, cwd: this.cwd, args: dangerous(this.run.permissionMode) ? ['--dangerously-skip-permissions'] : [],
      onNotification: (method, params) => this.notification(method, params), onRequest: (method, params) => this.request(method, params), onError: error => failed(error) });
    const abort = () => { if (this.sessionId) this.client.notify('session/cancel', { sessionId: this.sessionId }); failed(new Error('Antigravity run interrupted.')); setTimeout(() => this.client.close(), 500); };
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
      await set('mode', antigravityMode(this.run.permissionMode));
      this.live = true;
      const result = await Promise.race([this.client.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] }, 0), broken]);
      this.flush();
      if (result.stopReason === 'cancelled') throw new Error('Antigravity run interrupted.');
      const usage = result.usage || {};
      this.tokens = { input: usage.inputTokens || 0, output: usage.outputTokens || 0, cacheRead: usage.cachedReadTokens || 0, cacheWrite: usage.cachedWriteTokens || 0 };
      this.event('context', { used: (usage.inputTokens || 0) + (usage.cachedReadTokens || 0), window: /claude/i.test(this.model || '') ? 200000 : 1000000 });
      this.event('agent-result', { result: this.text, tokens: this.tokens, billedToApiKey: false });
      return { status: 'completed' };
    } finally { this.signal?.removeEventListener('abort', abort); this.client.close(); }
  }
  async interrupt() { if (this.sessionId) this.client?.notify('session/cancel', { sessionId: this.sessionId }); setTimeout(() => this.client?.close(), 500); }
  close() { this.client?.close(); }
}

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

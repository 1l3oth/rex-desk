import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCommand, stopTree } from './processes.js';

export const AI_PROVIDERS = ['claude', 'codex', 'gemini'];
export function aiProvider(value = 'claude') {
  if (!AI_PROVIDERS.includes(value)) throw new Error('Choose Claude Code, Codex or Gemini.');
  return value;
}
export const providerTitle = value => value === 'codex' ? 'Codex' : value === 'gemini' ? 'Gemini (Antigravity)' : 'Claude Code';
// Antigravity keeps one Google sign-in per computer for now, so its "profile" variable is only Rex Desk's own marker.
export const profileKey = value => value === 'codex' ? 'CODEX_HOME' : value === 'gemini' ? 'REX_GEMINI_HOME' : 'CLAUDE_CONFIG_DIR';

export function codexEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']) delete clean[key];
  return clean;
}

// One app-server per caller keeps account, MCP credentials, and pending approvals isolated.
export class CodexClient {
  constructor({ env = process.env, cwd, spawnProcess = spawn, onNotification = () => {}, onRequest, onError = () => {}, timeoutMs = 30000 } = {}) {
    Object.assign(this, { env, cwd, spawnProcess, onNotification, onRequest, onError, timeoutMs });
    this.pending = new Map(); this.nextId = 0; this.closed = false;
  }
  async open() {
    const executable = resolveCommand('codex');
    this.child = this.spawnProcess(executable.command, [...executable.args, 'app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"'],
      { env: codexEnvironment(this.env), cwd: this.cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', code => { if (!this.closed) this.fail(new Error(`Codex app-server exited (${code}).`)); });
    this.child.stdin.on('error', error => { if (!this.closed) this.fail(error); });
    // stderr may contain account or MCP details; errors shown to the person come from protocol responses.
    this.child.stderr.resume();
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error('Codex returned an invalid protocol message.')); }
      if (message.method && message.id !== undefined) {
        Promise.resolve().then(() => {
          if (!this.onRequest) throw new Error('This Codex operation needs an interactive Rex Desk run.');
          return this.onRequest(message.method, message.params || {});
        }).then(result => this.send({ id: message.id, result }), error => this.send({ id: message.id, error: { code: -32603, message: error.message } })).catch(() => {});
      } else if (message.method) {
        try { this.onNotification(message.method, message.params || {}); } catch (error) { this.fail(error); }
      } else {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed.')); else pending.resolve(message.result);
      }
    });
    await this.request('initialize', { clientInfo: { name: 'rex_desk', title: 'Rex Desk', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    return this;
  }
  send(message) { if (this.closed) throw new Error('Codex connection closed.'); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) { if (this.closed) return; this.onError(error); this.close(error); }
  close(error = new Error('Codex connection closed.')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.lines?.close(); this.child?.stdin.end(); stopTree(this.child);
  }
}

export function codexPermissions(mode = 'bypassPermissions', roots = []) {
  if (mode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
  if (mode === 'plan') return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } };
  if (['manual', 'auto', 'acceptEdits'].includes(mode)) return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: roots, networkAccess: false } };
  throw new Error('Choose Dangerous, Manual, Plan or Workspace mode for Codex.');
}

export async function codexModels({ env, cwd, clientFactory = options => new CodexClient(options) } = {}) {
  const client = clientFactory({ env, cwd });
  try {
    await client.open();
    const items = []; let cursor;
    do {
      const page = await client.request('model/list', { ...(cursor ? { cursor } : {}) });
      items.push(...(page.data || []).filter(item => !item.hidden).map(item => ({ id: item.model || item.id, label: item.displayName || item.model || item.id, hint: item.description || '', efforts: (item.supportedReasoningEfforts || []).map(value => value.reasoningEffort) })));
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  } finally { client.close(); }
}

export class CodexRunner {
  constructor(options) { Object.assign(this, options); this.event ||= () => {}; }
  async approve(method, params) {
    if (/requestApproval$/.test(method)) {
      const answer = await this.ask({ kind: 'approval', title: params.command ? `Run ${params.command}` : 'Approve Codex file change', request: params, method: 'codex-permission' });
      return { decision: answer.action === 'accept' ? 'accept' : 'decline' };
    }
    if (/requestUserInput$/.test(method)) {
      const answers = {};
      for (const question of params.questions || []) {
        const answer = await this.ask({ kind: 'question', title: question.question, request: { ...question, options: question.options }, method: 'codex-question' });
        answers[question.id] = { answers: answer.action === 'accept' ? [String(answer.content?.answer || answer.content?.text || '')] : [] };
      }
      return { answers };
    }
    if (/elicitation\/request$|elicitationRequest$/.test(method)) {
      const answer = await this.ask({ kind: 'question', title: params.message || 'Codex needs your input', request: params, method: 'elicitation' });
      return { action: answer.action, ...(answer.content ? { content: answer.content } : {}) };
    }
    throw new Error(`Unsupported Codex request: ${method}`);
  }
  notification(method, params) {
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (method === 'turn/started') this.turnId = params.turn.id;
    if (method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall'].includes(params.item?.type)) {
      const item = params.item;
      this.event('agent-tool', { id: item.id, tool: item.tool || item.type, input: item.command ? { command: item.command } : {} });
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage' && item.text) { this.text = `${this.text || ''}${item.text}\n`; this.event('agent-text', { text: item.text }); }
      if (item.type === 'commandExecution') this.event('agent-tool-result', { id: item.id, text: String(item.aggregatedOutput || '').slice(-6000), failed: item.status === 'failed' || Boolean(item.exitCode) });
      if (item.type === 'mcpToolCall' && item.status === 'failed') this.event('agent-tool-result', { id: item.id, text: item.error?.message || 'MCP tool failed.', failed: true });
      const news = this.inbox?.();
      if (news && this.turnId) void this.client.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: news }] }).catch(error => this.event('error', { message: error.message }));
    }
    if (method === 'account/rateLimits/updated' && params?.rateLimits) this.event('rate-limit', { codex: params.rateLimits });
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last || {};
      this.event('context', { used: usage.inputTokens || 0, window: params.tokenUsage?.modelContextWindow || 0 });
      this.tokens = { input: usage.inputTokens || 0, output: usage.outputTokens || 0, cacheRead: usage.cachedInputTokens || 0, cacheWrite: 0 };
    }
    if (method === 'turn/completed') {
      const turn = params.turn;
      if (turn.status === 'completed') { this.event('agent-result', { result: this.text || '', tokens: this.tokens, billedToApiKey: false }); this.resolveTurn({ status: 'completed' }); }
      else this.rejectTurn(new Error(turn.error?.message || `Codex turn ${turn.status}.`));
    }
    if (method === 'error' && !params.willRetry) this.rejectTurn?.(new Error(params.error?.message || 'Codex failed.'));
  }
  async start(prompt) {
    if (this.signal?.aborted) throw new Error('Codex run interrupted.');
    const env = { ...codexEnvironment(this.agentEnv), REX_DESK_TOKEN: this.token || '', REX_AGENT_TOKEN: this.token || '', REX_DESK_URL: this.mcpUrl || '' };
    const servers = {};
    if (this.mcpUrl) servers.rex_desk = { url: this.mcpUrl, bearer_token_env_var: 'REX_DESK_TOKEN', required: true };
    for (const [name, server] of Object.entries(this.extraMcp || {})) {
      if (server.url) {
        const headers = {};
        for (const [header, value] of Object.entries(server.headers || {})) { const key = `REX_CODEX_MCP_${Object.keys(env).length}`; env[key] = value; headers[header] = key; }
        servers[name] = { url: server.url, env_http_headers: headers };
      } else if (server.command) servers[name] = { command: server.command, args: server.args || [], env: server.env || {} };
    }
    const permissions = codexPermissions(this.run.permissionMode, [this.cwd, this.projectDirectory, this.artifactDirectory, this.uploadsDirectory].filter(Boolean));
    const completed = new Promise((resolve, reject) => { this.resolveTurn = resolve; this.rejectTurn = reject; });
    completed.catch(() => {});
    this.client = (this.clientFactory || (options => new CodexClient(options)))({ env, cwd: this.cwd, onNotification: (method, params) => this.notification(method, params), onRequest: (method, params) => this.approve(method, params), onError: error => this.rejectTurn(error) });
    const abort = () => { this.rejectTurn(new Error('Codex run interrupted.')); this.client.close(); };
    this.signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.client.open();
      const auth = await this.client.request('account/read', { refreshToken: false });
      if (auth.account?.type !== 'chatgpt') throw new Error('Codex needs a ChatGPT subscription sign-in. Connect Codex in Settings.');
      const config = { model_provider: 'openai', forced_login_method: 'chatgpt', mcp_servers: servers };
      const common = { cwd: this.cwd, approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user', sandbox: permissions.sandbox, config, ...(this.model ? { model: this.model } : {}) };
      const session = this.run.sessionId;
      const result = await this.client.request(session ? 'thread/resume' : 'thread/start', { ...common, ...(session ? { threadId: session, excludeTurns: true } : {}) });
      this.threadId = result.thread.id; this.event('session', { sessionId: this.threadId, apiKeySource: 'subscription' });
      const started = await this.client.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt }], approvalPolicy: permissions.approvalPolicy, sandboxPolicy: permissions.sandboxPolicy,
        ...(this.model ? { model: this.model } : {}), ...(this.run.effort ? { effort: this.run.effort === 'max' ? 'xhigh' : this.run.effort } : {}) });
      this.turnId = started.turn.id;
      return await completed;
    } finally { this.signal?.removeEventListener('abort', abort); this.client.close(); }
  }
  async interrupt() { this.rejectTurn?.(new Error('Codex run interrupted.')); this.client?.close(); }
  close() { this.client?.close(); }
}

export async function codexText(prompt, { env, cwd, timeoutMs = 90000 } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const runner = new CodexRunner({ run: { permissionMode: 'plan' }, agentEnv: env, cwd, signal: controller.signal });
  try { await runner.start(prompt); return runner.text || ''; } finally { clearTimeout(timer); }
}

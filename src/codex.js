import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCommand, stopTree } from './processes.js';

// This Rex Desk, for the stdio proxy Codex runs to reach the desk tools.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const AI_PROVIDERS = ['claude', 'codex', 'gemini', 'openrouter'];
export function aiProvider(value = 'claude') {
  if (!AI_PROVIDERS.includes(value)) throw new Error('Choose Claude Code, Codex, Gemini or OpenRouter.');
  return value;
}
export const providerTitle = value => value === 'codex' ? 'Codex' : value === 'gemini' ? 'Gemini (Antigravity)' : value === 'openrouter' ? 'OpenRouter' : 'Claude Code';
// Antigravity keeps one Google sign-in per computer for now, so its "profile" variable is only Rex Desk's own marker.
// OpenRouter runs through Claude Code with an OpenRouter key (see openrouter.js); it has no profile folders of its own.
export const profileKey = value => value === 'codex' ? 'CODEX_HOME' : value === 'gemini' ? 'REX_GEMINI_HOME' : value === 'openrouter' ? 'REX_OPENROUTER_HOME' : 'CLAUDE_CONFIG_DIR';

export function codexEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']) delete clean[key];
  return clean;
}

// Codex reads MCP servers from its own config.toml and deep-merges any passed for the session by name.
// Rex Desk's Setup writes a stdio entry (codex mcp add rex_desk -- node stdio.js), so the session entry
// must be stdio too: a url entry merged onto the stdio one makes an invalid command+url table that Codex
// rejects with "url is not supported for stdio". If a profile already carries its own url-type rex_desk,
// a command entry clashes the same way, so that one is left alone (its proxy reads REX_DESK_TOKEN from the
// run env). No token is ever written to the config, a log or a command line.
export function codexRexDeskIsUrl(home = path.join(os.homedir(), '.codex')) {
  try {
    const section = readFileSync(path.join(home, 'config.toml'), 'utf8').match(/\[mcp_servers\.rex_desk\]([\s\S]*?)(?=\n\s*\[|$)/);
    return Boolean(section) && /^\s*url\s*=/m.test(section[1]);
  } catch { return false; }
}
export function codexDeskServer({ home = path.join(os.homedir(), '.codex'), mcpUrl, token = '', node = process.execPath, root = packageRoot } = {}) {
  if (!mcpUrl || codexRexDeskIsUrl(home)) return null;
  return { command: node, args: [path.join(root, 'src', 'stdio.js')], env: { REX_DESK_URL: mcpUrl, REX_DESK_TOKEN: token }, required: true };
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

// Codex tends to end a turn with "I'll do it now" and no tool call, then sits idle. The rule asks it not to; the nudge
// catches the turns where it still does, once per message from the person, so it can never loop.
export const CODEX_RULE = 'Never promise later work. Do it now, finish, then reply. Reply only with the result or a question.';
export const CODEX_NUDGE = "You said you'd do it. Do it now, don't reply until it's done.";
export const CODEX_NUDGE_LIMIT = 1;
// A promise is the last sentence opening with "I'll", "I'm working on it" and the like, so a word inside an instruction or a
// UI label ("Click Continue to finish") is not one. A question or a request for the person's choice is never nudged.
const PROMISE = /^(?:(?:ok(?:ay)?|sure|great|got it|alright|right)[,.!]?\s+)?(?:i(?:'|’)ll|i will|i(?:'|’)m going to|i am going to|i(?:'|’)m (?:now |still )?(?:working on it|on it)|i am (?:now |still )?working on it|(?:still |now )?working on it|next,? i(?:'|’)ll|next,? i will)\b/i;
const ASKS = /\?|\b(?:let me know|tell me|please (?:confirm|choose|pick|tell|send|share|say)|do you want|would you like|can you|could you|which (?:one|file|option|of)|confirm (?:which|whether|if))\b/i;
// Not work the agent can do now: a closing offer ("I'll be here if you need anything else"), or work that waits on the person
// ("I'll fix it once you send the file", "I'll continue after you confirm").
const OFFER = /\b(?:if you need|if you want|if you(?:'|’)d like|whenever you(?:'|’)re ready|anything else|any(?:thing| other) (?:questions?|help)|i(?:'|’)ll be (?:here|around|happy|glad))\b/i;
const WAITS = /\b(?:once|after|when|as soon as|if|until)\s+(?:you|you(?:'|’)ve|you(?:'|’)re|your|i (?:get|have|hear|receive))\b/i;
// Waiting on the person is not a promise either: "I'll wait for approval", "I'll hold until I hear from you".
const WAITS_ON = /\b(?:wait(?:ing)?|hold(?:ing)?(?: off)?|stand(?:ing)? by|pause)\b.*\b(?:you|your|approval|approve|input|confirm(?:ation)?|reply|answer|response|go-ahead|ok(?:ay)?)\b/i;
export function isPromise(text) {
  const value = String(text || '').trim();
  if (!value || ASKS.test(value)) return false;
  const last = value.split(/\n+|(?<=[.!])\s+/).map(part => part.trim().replace(/^[-*>\s]+/, '')).filter(Boolean).at(-1) || '';
  return PROMISE.test(last) && !OFFER.test(last) && !WAITS.test(last) && !WAITS_ON.test(last);
}
const TOOL_ITEMS = ['commandExecution', 'fileChange', 'mcpToolCall'];

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
    if (method === 'turn/started') { this.turnId = params.turn.id; this.turnTools = 0; this.lastMessage = ''; }
    if (method === 'item/started' && TOOL_ITEMS.includes(params.item?.type)) {
      this.turnTools = (this.turnTools || 0) + 1;
      const item = params.item;
      this.event('agent-tool', { id: item.id, tool: item.tool || item.type, input: item.command ? { command: item.command } : {} });
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage' && item.text) { this.text = `${this.text || ''}${item.text}\n`; this.lastMessage = item.text; this.event('agent-text', { text: item.text }); }
      if (item.type === 'commandExecution') this.event('agent-tool-result', { id: item.id, text: String(item.aggregatedOutput || '').slice(-6000), failed: item.status === 'failed' || Boolean(item.exitCode) });
      if (item.type === 'mcpToolCall' && item.status === 'failed') this.event('agent-tool-result', { id: item.id, text: item.error?.message || 'MCP tool failed.', failed: true });
      // One hand-over, with its handover: taken only once Codex accepts this steer; a refused one goes back to the queue for the next turn.
      const got = this.inbox?.({ withId: true }), news = typeof got === 'string' ? got : got?.text || '', handover = typeof got === 'string' ? null : got?.handover ?? null;
      if (news && this.turnId) void this.client.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: news }] })
        .then(() => this.event('prompt-accepted', { steer: true, handover }), error => { this.requeue?.(news, handover); this.event('error', { message: error.message }); });
      else if (news) this.requeue?.(news, handover);
    }
    if (method === 'account/rateLimits/updated' && params?.rateLimits) this.event('rate-limit', { codex: params.rateLimits });
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last || {};
      this.event('context', { used: usage.inputTokens || 0, window: params.tokenUsage?.modelContextWindow || 0 });
      this.tokens = { input: usage.inputTokens || 0, output: usage.outputTokens || 0, cacheRead: usage.cachedInputTokens || 0, cacheWrite: 0 };
    }
    if (method === 'turn/completed') {
      const turn = params.turn;
      if (turn.status === 'completed' && this.shouldNudge()) return void this.nudge();
      if (turn.status === 'completed') { this.event('agent-result', { result: this.text || '', tokens: this.tokens, billedToApiKey: false }); this.resolveTurn({ status: 'completed' }); }
      else this.rejectTurn(new Error(turn.error?.message || `Codex turn ${turn.status}.`));
    }
    if (method === 'error' && !params.willRetry) this.rejectTurn?.(new Error(params.error?.message || 'Codex failed.'));
  }
  // The turn ended on a promise with no tool used: one more turn on the same thread instead of going idle.
  shouldNudge() { return !this.turnTools && (this.nudges || 0) < CODEX_NUDGE_LIMIT && isPromise(this.lastMessage) && !this.signal?.aborted; }
  nudge() {
    this.nudges = (this.nudges || 0) + 1;
    void this.client.request('turn/start', { ...this.turnOptions, threadId: this.threadId, input: [{ type: 'text', text: CODEX_NUDGE }] })
      .then(started => { this.turnId = started.turn.id; }, error => this.rejectTurn(error));
  }
  async start(prompt) {
    this.nudges = 0; this.turnTools = 0; this.lastMessage = '';
    if (this.signal?.aborted) throw new Error('Codex was stopped.');
    const env = { ...codexEnvironment(this.agentEnv), REX_DESK_TOKEN: this.token || '', REX_AGENT_TOKEN: this.token || '', REX_DESK_URL: this.mcpUrl || '' };
    const servers = {};
    const deskServer = codexDeskServer({ home: this.agentEnv?.CODEX_HOME || undefined, mcpUrl: this.mcpUrl, token: this.token });
    if (deskServer) servers.rex_desk = deskServer;
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
    const abort = () => { this.rejectTurn(new Error('Codex was stopped.')); this.client.close(); };
    this.signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.client.open();
      const auth = await this.client.request('account/read', { refreshToken: false });
      if (auth.account?.type !== 'chatgpt') throw new Error('Codex needs you to sign in with your ChatGPT plan. Connect Codex in Settings.');
      const config = { model_provider: 'openai', forced_login_method: 'chatgpt', mcp_servers: servers };
      const common = { cwd: this.cwd, approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user', sandbox: permissions.sandbox, config, developerInstructions: CODEX_RULE, ...(this.model ? { model: this.model } : {}) };
      const session = this.run.sessionId;
      const result = await this.client.request(session ? 'thread/resume' : 'thread/start', { ...common, ...(session ? { threadId: session, excludeTurns: true } : {}) });
      this.threadId = result.thread.id; this.event('session', { sessionId: this.threadId, apiKeySource: 'subscription' });
      this.turnOptions = { approvalPolicy: permissions.approvalPolicy, sandboxPolicy: permissions.sandboxPolicy, ...(this.model ? { model: this.model } : {}), ...(this.run.effort ? { effort: this.run.effort === 'max' ? 'xhigh' : this.run.effort } : {}) };
      // A new thread also gets the rule at the top of its first message, in case this Codex version ignores developerInstructions.
      const text = session ? prompt : `${CODEX_RULE}\n\n${prompt}`;
      const started = await this.client.request('turn/start', { ...this.turnOptions, threadId: this.threadId, input: [{ type: 'text', text }] });
      this.turnId = started.turn.id;
      // Only now is the prompt really submitted: the session above opened before it, and a failed submit throws before this.
      this.event('prompt-accepted', { turnId: this.turnId });
      return await completed;
    } finally { this.signal?.removeEventListener('abort', abort); this.client.close(); }
  }
  async interrupt() { this.rejectTurn?.(new Error('Codex was stopped.')); this.client?.close(); }
  close() { this.client?.close(); }
}

export async function codexText(prompt, { env, cwd, timeoutMs = 90000 } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const runner = new CodexRunner({ run: { permissionMode: 'plan' }, agentEnv: env, cwd, signal: controller.signal });
  try { await runner.start(prompt); return runner.text || ''; } finally { clearTimeout(timer); }
}

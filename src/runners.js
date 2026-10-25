import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveCommand, stopTree } from './processes.js';

export function existingMcpConnections(sourcePath, configDirectory = process.env.CLAUDE_CONFIG_DIR) {
  let connections = {};
  const configs = [...new Set([path.join(os.homedir(), '.claude.json'), configDirectory ? path.join(configDirectory, '.claude.json') : ''].filter(Boolean))];
  for (const config of configs) if (existsSync(config)) {
    const data = JSON.parse(readFileSync(config, 'utf8'));
    connections = { ...connections, ...data.mcpServers };
    const canonical = value => String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
    const project = Object.entries(data.projects || {}).find(([key]) => canonical(key) === canonical(sourcePath));
    if (project) connections = { ...connections, ...project[1].mcpServers };
  }
  if (sourcePath && existsSync(path.join(sourcePath, '.mcp.json'))) {
    const data = JSON.parse(readFileSync(path.join(sourcePath, '.mcp.json'), 'utf8'));
    connections = { ...connections, ...data.mcpServers };
  }
  return connections;
}

export function codexAnswer(method, request, answer) {
  const accepted = answer.action === 'accept';
  if (method === 'mcpServer/elicitation/request') return { action: answer.action, content: accepted ? answer.content || {} : null, _meta: null };
  if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
    return { answers: Object.fromEntries((request.questions || []).map(question => [question.id,
      { answers: accepted ? [String(answer.content?.[question.id] ?? '')] : [] }])) };
  }
  if (method === 'item/permissions/requestApproval') return { permissions: accepted ? request.permissions : {}, scope: 'turn' };
  return { decision: accepted ? 'accept' : answer.action === 'cancel' ? 'cancel' : 'decline' };
}

export class CodexRunner {
  constructor({ run, cwd, token, mcpUrl, model, ask, event, signal, sourcePath, agentEnv }) {
    Object.assign(this, { run, cwd, token, mcpUrl, model, ask, event, signal, sourcePath, agentEnv });
    this.pending = new Map(); this.sequence = 0; this.closed = false;
  }
  async start(prompt) {
    const executable = resolveCommand('codex');
    const args = [...executable.args, 'app-server', '--listen', 'stdio://',
      '-c', 'mcp_servers.rex_desk.enabled=false',
      '-c', `mcp_servers.rex_desk_run.url=${JSON.stringify(this.mcpUrl)}`,
      '-c', 'mcp_servers.rex_desk_run.bearer_token_env_var="REX_AGENT_TOKEN"',
      '-c', 'mcp_servers.rex_desk_run.tool_timeout_sec=86400'];
    this.child = spawn(executable.command, args, { cwd: this.cwd, env: { ...(this.agentEnv || process.env), REX_AGENT_TOKEN: this.token, REX_DESK_TOKEN: this.token, REX_DESK_URL: this.mcpUrl },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const completed = new Promise((resolve, reject) => { this.resolveTurn = resolve; this.rejectTurn = reject; });
    // Attach immediately, so early process errors never become unhandled rejections.
    completed.catch(() => {});
    this.child.once('error', error => this.rejectTurn(error));
    this.child.once('close', code => {
      this.closed = true;
      const error = new Error(`Codex process exited (${code ?? 'signal'}).`);
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear(); this.rejectTurn(error);
    });
    this.child.stderr.on('data', data => this.event('process', { text: data.toString().slice(-10000) }));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch (error) { this.event('protocol-error', { message: error.message }); }
    });
    this.abort = () => this.close();
    this.signal.addEventListener('abort', this.abort, { once: true });
    try {
      await this.request('initialize', { clientInfo: { name: 'rex_desk', title: 'Rex Desk', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized', params: {} });
      const params = { cwd: this.cwd, approvalPolicy: 'on-request', sandbox: this.run.role === 'worker' ? 'workspace-write' : 'read-only',
        ...(this.model ? { model: this.model } : {}) };
      const response = this.run.sessionId
        ? await this.request('thread/resume', { ...params, threadId: this.run.sessionId })
        : await this.request('thread/start', params);
      this.threadId = response.thread.id;
      this.event('session', { sessionId: this.threadId });
      const result = await this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      this.turnId = result.turn.id;
      return await completed;
    } finally { this.signal.removeEventListener('abort', this.abort); this.close(); }
  }
  send(value) { if (!this.closed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(method, params) {
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Codex ${method} timed out.`)); }, 90000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ id: requestId, method, params });
    });
  }
  receive(message) {
    if (message.id !== undefined && !message.method) {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) { void this.serverRequest(message); return; }
    const { method, params = {} } = message;
    if (method === 'turn/completed') {
      if (params.turn?.status === 'failed') this.rejectTurn(new Error(params.turn.error?.message || 'Codex turn failed.'));
      else this.resolveTurn({ status: params.turn?.status || 'completed' });
    }
    if (method === 'serverRequest/resolved') this.event('request-resolved', { requestId: params.requestId });
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {};
      if (item.type !== 'reasoning') this.event('agent-operation', { method, item });
    }
    if (method === 'item/commandExecution/outputDelta') this.event('command-output', { text: params.delta?.slice(-20000) });
  }
  async serverRequest(message) {
    const { method, params, id: requestId } = message;
    const recognized = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
      'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!recognized.includes(method)) { this.send({ id: requestId, error: { code: -32601, message: `Rex Desk does not handle ${method}.` } }); return; }
    try {
      const answer = await this.ask({ kind: /Approval/.test(method) ? 'approval' : 'question',
        title: params.message || params.reason || (params.command ? 'Approve command' : 'Agent needs your input'),
        request: params, method, nativeId: requestId });
      this.send({ id: requestId, result: codexAnswer(method, params, answer) });
    } catch (error) { this.send({ id: requestId, result: codexAnswer(method, params, { action: 'cancel' }) }); }
  }
  async interrupt() {
    if (this.threadId && this.turnId) await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    this.close();
  }
  close() { if (!this.closed) { this.closed = true; stopTree(this.child); } }
}

// Rex Desk's own tools read tasks, label them, message the dashboard, or act inside the run's worktree. desk_status and
// desk_publish carry their own dashboard approval. Only desk_dispatch starts new work, so it alone keeps the permission prompt.
const quietRexTool = name => name.startsWith('mcp__rex_desk__desk_') && name !== 'mcp__rex_desk__desk_dispatch';

// Agents run on the Claude Code profile's claude.ai sign-in, so they use the person's Claude subscription. An API key
// left in the environment would quietly switch every run to pay-per-token billing, so it is removed unless asked for.
export const apiKeyVariables = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export function subscriptionEnv(env) {
  const result = { ...env };
  if (result.REX_AGENT_API_KEY !== '1') for (const name of apiKeyVariables) delete result[name];
  return result;
}

export class ClaudeRunner {
  constructor(options) { Object.assign(this, options); }
  async start(prompt) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const env = { ...subscriptionEnv(this.agentEnv || process.env), REX_AGENT_TOKEN: this.token, REX_DESK_TOKEN: this.token, REX_DESK_URL: this.mcpUrl, MCP_TOOL_TIMEOUT: '86400000' };
    delete env.CLAUDECODE;
    const executable = resolveCommand('claude');
    const connections = existingMcpConnections(this.sourcePath, env.CLAUDE_CONFIG_DIR), allowedTools = new Set();
    delete connections.rex_desk;
    const options = { cwd: this.cwd, env, abortController: this.controller,
      permissionMode: this.run.role === 'worker' ? 'acceptEdits' : 'default',
      settingSources: ['user', 'project', 'local'],
      ...(executable.command.includes('/') || executable.command.includes('\\') ? { pathToClaudeCodeExecutable: executable.command } : {}),
      ...(this.model ? { model: this.model } : {}), ...(this.run.sessionId ? { resume: this.run.sessionId } : {}),
      strictMcpConfig: true,
      mcpServers: { ...connections, rex_desk: { type: 'http', url: this.mcpUrl, headers: { Authorization: `Bearer ${this.token}` }, alwaysLoad: true } },
      onElicitation: async request => {
        const answer = await this.ask({ kind: 'question', title: request.message, request, method: 'elicitation' });
        return { action: answer.action, ...(answer.action === 'accept' ? { content: answer.content || {} } : {}) };
      },
      canUseTool: async (name, input, context) => {
        if (name === 'AskUserQuestion') {
          const answer = await this.ask({ kind: 'question', title: 'Claude needs your input', request: input, method: 'claude-question' });
          if (answer.action !== 'accept') return { behavior: 'deny', message: 'User declined the question.' };
          return { behavior: 'allow', updatedInput: { ...input, answers: answer.content || {} } };
        }
        if (quietRexTool(name) || allowedTools.has(name)) return { behavior: 'allow', updatedInput: input };
        const answer = await this.ask({ kind: 'approval', title: `Approve ${name}`, request: { tool: name, input, suggestions: context.suggestions, allowAlways: true }, method: 'claude-permission' });
        if (answer.action === 'accept' && answer.content?.always) allowedTools.add(name);
        return answer.action === 'accept' ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'User declined this action.' };
      },
    };
    this.query = query({ prompt, options });
    for await (const message of this.query) {
      if (message.type === 'system' && message.subtype === 'init') { this.apiKeySource = message.apiKeySource; this.event('session', { sessionId: message.session_id, apiKeySource: message.apiKeySource }); }
      if (message.type === 'assistant') {
        const content = message.message?.content?.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking');
        this.event('agent-operation', { type: 'assistant', content });
      }
      if (message.type === 'user') this.event('agent-operation', { type: 'tool-result', content: message.message?.content });
      if (message.type === 'result') {
        this.event('agent-result', { result: message.result, errors: message.errors, subtype: message.subtype, cost: message.total_cost_usd, billedToApiKey: ['user', 'project', 'org', 'temporary'].includes(this.apiKeySource) });
        // The CLI reports a signed-out profile as an ordinary result. Surface it as a setup problem, not agent output.
        if (/not logged in|please run \/login/i.test(String(message.result || ''))) throw new Error(`Claude Code profile ${env.CLAUDE_CONFIG_DIR || '~/.claude'} is not signed in. Open Setup, choose a signed-in Claude Code profile, then continue this run.`);
        if (message.is_error) throw new Error(message.errors?.join('\n') || message.result || `Claude ended with ${message.subtype}.`);
      }
    }
    return { status: 'completed' };
  }
  async interrupt() { await this.query?.interrupt(); this.query?.close(); }
  close() { this.query?.close(); }
}

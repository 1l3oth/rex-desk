import { apiKeyVariables } from './runners.js';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCommand } from './processes.js';

const launcher = fileURLToPath(new URL('../scripts/orca-agent.mjs', import.meta.url));
const canonical = value => path.resolve(String(value || '')).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();

export function orcaJson(args, { run = execFile, timeout = 30000 } = {}) {
  const command = process.env.REX_ORCA_PATH || 'orca';
  return new Promise((resolve, reject) => run(command, [...args, '--json'], { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    let data;
    try { data = JSON.parse(String(stdout || '')); }
    catch { reject(new Error(error?.code === 'ENOENT' ? 'Orca CLI is not installed or not on PATH.' : `Orca CLI returned no JSON: ${String(error?.message || stdout).slice(0, 300)}`)); return; }
    if (data.ok === false) { const failure = new Error(data.error?.data?.nextSteps?.[0] || data.error?.message || 'Orca command failed.'); failure.code = data.error?.code; failure.data = data.error?.data; reject(failure); return; }
    resolve(data.result ?? data);
  }));
}
// What the run's Orca terminal shows right now, read through the Orca CLI. Nothing is stored; the dashboard polls while the run is open.
export async function readOrcaTerminal(run, options) {
  const handle = String(run.sessionId || '').startsWith('orca:') ? run.sessionId.slice(5) : '';
  if (!handle) throw new Error('This run has no Orca terminal.');
  const result = await orcaJson(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '400'], options);
  const terminal = result.terminal || result;
  return { handle, status: terminal.status || '', source: terminal.source || '', lines: Array.isArray(terminal.tail) ? terminal.tail : String(terminal.tail || '').split('\n') };
}
// Rex Desk creates its own worktrees (branch pattern, port, runtime seed). Orca shows them only when the repo shows external worktrees.
export async function orcaRepository(repositoryPath, options) {
  const result = await orcaJson(['repo', 'list'], options);
  const repos = result.repos || result;
  const repo = (Array.isArray(repos) ? repos : []).find(item => canonical(item.path) === canonical(repositoryPath));
  if (!repo) return { registered: false };
  const detail = await orcaJson(['repo', 'show', '--repo', `id:${repo.id}`], options);
  const shown = detail.repo || detail;
  return { registered: true, id: repo.id, name: repo.displayName || repo.name, visibility: shown.externalWorktreeVisibility || 'inherit' };
}
// A run must never fall back to an invisible agent, so a closed Orca is opened and waited for instead.
// A CLI that is missing altogether raises its own error; any other unreadable status is left to the call that follows.
export async function ensureOrcaRunning(options = {}) {
  let status;
  try { status = await orcaJson(['status'], { ...options, timeout: 30000 }); }
  catch (error) { if (/not installed or not on PATH/i.test(error.message)) throw error; return; }
  if (status?.app?.running !== false && status?.runtime?.reachable !== false) return;
  await orcaJson(['open'], { ...options, timeout: 180000 });
}
export async function orcaStatus(repositoryPath, options) {
  try {
    const repository = repositoryPath ? await orcaRepository(repositoryPath, options) : null;
    return { available: true, repository, ready: Boolean(repository?.registered && repository.visibility === 'show') };
  } catch (error) { return { available: false, error: error.message }; }
}
export async function showWorktreesInOrca(repositoryPath, options) {
  let repository = await orcaRepository(repositoryPath, options);
  if (!repository.registered) { await orcaJson(['repo', 'add', '--path', repositoryPath], options); repository = await orcaRepository(repositoryPath, options); }
  if (repository.visibility !== 'show') await orcaJson(['repo', 'set', '--repo', `id:${repository.id}`, '--external-worktree-visibility', 'show'], options);
  return orcaRepository(repositoryPath, options);
}
export async function openInOrca(run, options) {
  const result = await orcaJson(['terminal', 'create', '--worktree', `path:${run.worktree}`, '--title', `Rex · ${String(run.title || run.id).slice(0, 40)}`], options);
  const handle = result.terminal?.handle || result.handle;
  await orcaJson(['terminal', 'switch', '--terminal', handle], options).catch(() => {});
  return { handle };
}

// An agent in a visible Orca terminal. Questions, evidence, and finish still flow through the run-scoped Rex Desk MCP.
export class OrcaRunner {
  constructor(options) { Object.assign(this, options); this.orca = options.orcaOptions || {}; }
  async start(prompt) {
    await ensureOrcaRunning(this.orca);
    const status = await orcaStatus(this.sourcePath, this.orca);
    if (!status.available) throw new Error(`Orca is unavailable: ${status.error}`);
    if (!status.ready) throw new Error('Orca does not show Rex Desk worktrees for this repository yet. Choose "Show Rex worktrees in Orca" in the run dialog or Settings, then continue this run.');
    const directory = path.join(this.dataDirectory, 'runtimes', this.run.id, 'orca');
    mkdirSync(directory, { recursive: true });
    const spec = path.join(directory, `agent-${Date.now()}.json`);
    const env = this.agentEnv || process.env, key = this.run.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    writeFileSync(spec, JSON.stringify({ runId: this.run.id, provider: this.run.provider, cwd: this.cwd, prompt, token: this.token, mcpUrl: this.mcpUrl, model: this.model, addDir: this.artifactDirectory || '', resumeSessionId: this.resumeSessionId || '',
      executable: this.executable || resolveCommand(this.run.provider), env: { ...(env[key] ? { [key]: env[key] } : {}), ...(this.javaEnv || {}) }, unset: [...(env[key] ? [] : [key]), ...(this.run.provider === 'claude' && env.REX_AGENT_API_KEY !== '1' ? apiKeyVariables : [])] }), { mode: 0o600 });
    const command = `node "${launcher}" "${spec}"`;
    let terminal;
    try { terminal = await orcaJson(['terminal', 'create', '--worktree', `path:${this.cwd}`, '--title', `Rex · ${String(this.run.title).slice(0, 40)}`, '--command', command], this.orca); }
    catch (error) { rmSync(spec, { force: true }); throw error; }
    this.handle = terminal.terminal?.handle || terminal.handle;
    this.event('orca-terminal', { handle: this.handle, worktree: this.cwd, note: 'Tool approvals appear in the Orca terminal. Questions sent with desk_ask appear in Rex Desk.' });
    this.event('session', { sessionId: `orca:${this.handle}` });
    return this.watch(this.handle);
  }
  // The agent stays open after its turn; the run ends when it finishes through MCP, the terminal closes, or the user stops it.
  // After a Rex Desk restart the same watch resumes; a terminal that is already gone means the run was interrupted.
  async watch(handle, { reattached = false } = {}) {
    this.handle = handle;
    if (reattached) {
      const shown = await orcaJson(['terminal', 'show', '--terminal', handle], this.orca).catch(() => null);
      if (!shown || (shown.terminal || shown).connected === false) throw new Error('The Orca terminal closed while Rex Desk restarted. Resume this run to continue.');
    }
    while (!this.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, this.pollMs || 2500));
      try { this.mirror?.pump(); } catch (error) { this.event?.('mirror-error', { message: error.message }); }
      if (this.isDone?.()) return { status: 'completed' };
      let shown;
      try { shown = await orcaJson(['terminal', 'show', '--terminal', this.handle], this.orca); }
      catch (error) { if (/not_found|stale|closed/i.test(`${error.code} ${error.message}`)) return { status: 'completed' }; continue; }
      const state = shown.terminal || shown;
      if (state.connected === false || /Rex Desk agent exited \(code/.test(String(state.preview || ''))) return { status: 'completed' };
    }
    throw new Error('Run stopped.');
  }
  async interrupt() { if (this.handle) await orcaJson(['terminal', 'close', '--terminal', this.handle], this.orca).catch(() => {}); }
  close() {}
}

// Reads the session log an Orca agent writes (Claude Code: <config>/projects/<cwd>/<id>.jsonl; Codex: <home>/sessions/.../rollout-*.jsonl)
// and turns each new line into the same events a headless run produces, so the run page shows a chat instead of a terminal.
export class SessionMirror {
  constructor({ provider, cwd, configDirectory, since, state = {}, emit, persist = () => {} }) {
    Object.assign(this, { provider, cwd, configDirectory, since: Date.parse(since || 0) || 0, emit, persist });
    this.file = state.file || ''; this.offset = state.offset || 0; this.rest = '';
  }
  locate() {
    const recent = file => { try { return statSync(file).mtimeMs >= this.since - 60000; } catch { return false; } };
    if (this.provider === 'claude') {
      const folder = path.join(this.configDirectory || path.join(os.homedir(), '.claude'), 'projects', this.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      const files = existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.jsonl')).map(name => path.join(folder, name)).filter(recent) : [];
      return files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || '';
    }
    const root = path.join(this.configDirectory || path.join(os.homedir(), '.codex'), 'sessions');
    const days = [0, 1].map(back => { const day = new Date(Date.now() - back * 86400000); return path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')); });
    for (const folder of days.filter(existsSync)) for (const name of readdirSync(folder).filter(item => item.endsWith('.jsonl')).sort().reverse()) {
      const file = path.join(folder, name);
      if (!recent(file)) continue;
      const head = readFirstLine(file);
      try { if (path.resolve(JSON.parse(head).payload?.cwd || '') === path.resolve(this.cwd)) return file; } catch {}
    }
    return '';
  }
  pump() {
    if (!this.file) { this.file = this.locate(); this.offset = 0; if (!this.file) return; }
    let size; try { size = statSync(this.file).size; } catch { return; }
    if (size <= this.offset) return;
    const handle = openSync(this.file, 'r'), buffer = Buffer.alloc(Math.min(size - this.offset, 8 * 1024 * 1024));
    try { readSync(handle, buffer, 0, buffer.length, this.offset); } finally { closeSync(handle); }
    this.offset += buffer.length;
    const lines = (this.rest + buffer.toString('utf8')).split('\n'); this.rest = lines.pop();
    for (const line of lines) { let entry; try { entry = JSON.parse(line); } catch { continue; } for (const [kind, data] of sessionEvents(this.provider, entry)) this.emit(kind, data); }
    this.persist({ file: this.file, offset: this.offset - Buffer.byteLength(this.rest) });
  }
}
function readFirstLine(file) {
  const handle = openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024);
  try { const read = readSync(handle, buffer, 0, buffer.length, 0); return buffer.subarray(0, read).toString('utf8').split('\n')[0]; } finally { closeSync(handle); }
}
const rexInstructions = text => /^You are running inside Rex Desk/.test(String(text).trim());
// One session line becomes zero or more Rex events: the human's words, the agent's text and tool calls, and tool results.
export function sessionEvents(provider, entry) {
  if (provider === 'claude') {
    const content = entry.message?.content;
    if (entry.type === 'assistant') { const blocks = (content || []).filter(block => block.type === 'text' || block.type === 'tool_use'); return blocks.length ? [['agent-operation', { type: 'assistant', content: blocks }]] : []; }
    if (entry.type !== 'user' || entry.isMeta) return [];
    if (typeof content === 'string') return content.trim() && !content.startsWith('<') ? [rexInstructions(content) ? ['phase', { text: 'The agent received its instructions from Rex Desk' }] : ['human-message', { text: content }]] : [];
    const results = (content || []).filter(block => block.type === 'tool_result'), text = (content || []).filter(block => block.type === 'text' && !block.text.startsWith('<')).map(block => block.text).join('\n');
    return [...(results.length ? [['agent-operation', { type: 'tool-result', content: results }]] : []), ...(text.trim() ? [rexInstructions(text) ? ['phase', { text: 'The agent received its instructions from Rex Desk' }] : ['human-message', { text }]] : [])];
  }
  const payload = entry.payload || {};
  if (entry.type === 'event_msg' && payload.type === 'agent_message' && payload.message) return [['agent-operation', { type: 'assistant', content: [{ type: 'text', text: payload.message }] }]];
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    const text = (payload.content || []).map(item => item.text || '').join('\n');
    return text.trim() && !text.trim().startsWith('<') ? [rexInstructions(text) ? ['phase', { text: 'The agent received its instructions from Rex Desk' }] : ['human-message', { text }]] : [];
  }
  if (entry.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload.type)) {
    let input = payload.arguments ?? payload.input; try { input = JSON.parse(input); } catch {}
    return [['agent-operation', { type: 'assistant', content: [{ type: 'tool_use', id: payload.call_id, name: payload.name, input }] }]];
  }
  if (entry.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
    let output = payload.output; try { output = JSON.parse(output).output ?? output; } catch {}
    return [['agent-operation', { type: 'tool-result', content: [{ tool_use_id: payload.call_id, content: typeof output === 'string' ? output : JSON.stringify(output) }] }]];
  }
  return [];
}
// A message typed in Rex Desk goes into the agent's terminal as if typed there; Enter submits it, and a busy agent queues it.
export async function sendToOrca(run, text, options) {
  const handle = String(run.sessionId || '').startsWith('orca:') ? run.sessionId.slice(5) : '';
  if (!handle) throw new Error('This run has no Orca terminal to message.');
  const line = String(text || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!line) throw new Error('Write a message first.');
  const args = ['terminal', 'send', '--terminal', handle, '--text', line, '--enter'];
  try { return await orcaJson(args, options); }
  catch (error) {
    // Orca answers an ambiguous send with a request ID bound to this exact text. Only that ID may be sent again:
    // a plain retry would type the message twice, so without an ID the failure is passed on unchanged.
    const id = requestId(error);
    if (!id) throw error;
    return orcaJson([...args, '--retry-request', id, '--wait-submit', '10'], options);
  }
}
const requestPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
function requestId(error) {
  const data = error?.data || {};
  const named = data.requestId || data.retryRequestId || data.promptRequestId || data.request?.id;
  if (typeof named === 'string' && requestPattern.test(named)) return named;
  return requestPattern.exec(`${error?.message || ''} ${JSON.stringify(data)}`)?.[0] || '';
}

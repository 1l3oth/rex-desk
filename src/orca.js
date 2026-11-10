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
    const env = this.agentEnv || process.env, key = 'CLAUDE_CONFIG_DIR';
    writeFileSync(spec, JSON.stringify({ runId: this.run.id, provider: this.run.provider, cwd: this.cwd, prompt, token: this.token, mcpUrl: this.mcpUrl, model: this.model, addDir: this.artifactDirectory || '', resumeSessionId: this.resumeSessionId || '',
      executable: this.executable || resolveCommand(this.run.provider), env: { ...(env[key] ? { [key]: env[key] } : {}), ...(this.javaEnv || {}) }, unset: env[key] ? [] : [key] }), { mode: 0o600 });
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
      try { this.session?.track(); for (const text of this.session?.texts() || []) this.event('agent-text', { text }); } catch { /* the session file appears a moment after the terminal starts */ }
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

// Finds the session log an Orca agent writes (Claude Code: <config>/projects/<cwd>/<id>.jsonl).
// Rex Desk does not read what is in it: the file name carries the session id, which is what reopens that session for a follow-up.
export class AgentSession {
  constructor({ provider, cwd, configDirectory, since, state = {}, persist = () => {} }) {
    Object.assign(this, { provider, cwd, configDirectory, since: Date.parse(since || 0) || 0, persist });
    this.file = state.file || ''; this.offset = Number.isFinite(state.offset) ? state.offset : undefined;
  }
  locate() {
    const recent = file => { try { return statSync(file).mtimeMs >= this.since - 60000; } catch { return false; } };
    if (this.provider === 'claude') {
      const folder = path.join(this.configDirectory || path.join(os.homedir(), '.claude'), 'projects', this.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      const files = existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.jsonl')).map(name => path.join(folder, name)).filter(recent) : [];
      return files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || '';
    }
    return '';
  }
  // Called while the run is alive: the log appears a moment after the terminal starts.
  track() {
    if (this.file && existsSync(this.file)) return this.file;
    const found = this.locate();
    if (found && found !== this.file) { this.file = found; this.offset = undefined; this.persist({ file: found }); }
    return this.file;
  }
  // The text the agent wrote since the last call, from its own session log. A log that began with this turn is read from its start;
  // a reopened session starts at its current end, so earlier turns are not replayed. Only whole lines are consumed.
  texts() {
    if (!this.file) return [];
    let info; try { info = statSync(this.file); } catch { return []; }
    if (this.offset === undefined) { this.offset = info.birthtimeMs >= this.since - 60000 ? 0 : info.size; this.persist({ file: this.file, offset: this.offset }); }
    if (info.size <= this.offset) return [];
    const handle = openSync(this.file, 'r'); let chunk;
    try { chunk = Buffer.alloc(info.size - this.offset); readSync(handle, chunk, 0, chunk.length, this.offset); } finally { closeSync(handle); }
    const end = chunk.lastIndexOf(10); if (end < 0) return [];
    this.offset += end + 1; this.persist({ file: this.file, offset: this.offset });
    const found = [];
    for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
      let item; try { item = JSON.parse(line); } catch { continue; }
      const parts = item.type === 'assistant' && Array.isArray(item.message?.content) ? item.message.content.filter(block => block.type === 'text').map(block => block.text)
        : [];
      const text = parts.join('\n').trim(); if (text) found.push(text);
    }
    return found;
  }
}
function readFirstLine(file) {
  const handle = openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024);
  try { const read = readSync(handle, buffer, 0, buffer.length, 0); return buffer.subarray(0, read).toString('utf8').split('\n')[0]; } finally { closeSync(handle); }
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
    try { return await orcaJson([...args, '--retry-request', id, '--wait-submit', '10'], options); }
    catch (again) {
      // Still blocked after the retry: the agent is stopped at a permission or trust prompt in its terminal, and typing a message there would answer the prompt.
      if (/agent_prompt_blocked/.test(`${again?.code} ${again?.message}`)) throw new Error('The agent is waiting for a permission in its Orca terminal, so it cannot take a message yet. Open its terminal tab, answer the prompt (press 2 to allow for this session), then send again.');
      throw again;
    }
  }
}
const requestPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
function requestId(error) {
  const data = error?.data || {};
  const named = data.requestId || data.retryRequestId || data.promptRequestId || data.request?.id;
  if (typeof named === 'string' && requestPattern.test(named)) return named;
  return requestPattern.exec(`${error?.message || ''} ${JSON.stringify(data)}`)?.[0] || '';
}

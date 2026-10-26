import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
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
    if (data.ok === false) { const failure = new Error(data.error?.data?.nextSteps?.[0] || data.error?.message || 'Orca command failed.'); failure.code = data.error?.code; reject(failure); return; }
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
    const status = await orcaStatus(this.sourcePath, this.orca);
    if (!status.available) throw new Error(`Orca is unavailable: ${status.error}`);
    if (!status.ready) throw new Error('Orca does not show Rex Desk worktrees for this repository yet. Choose "Show Rex worktrees in Orca" in the run dialog or Settings, then continue this run.');
    const directory = path.join(this.dataDirectory, 'runtimes', this.run.id, 'orca');
    mkdirSync(directory, { recursive: true });
    const spec = path.join(directory, `agent-${Date.now()}.json`);
    const env = this.agentEnv || process.env, key = this.run.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    writeFileSync(spec, JSON.stringify({ runId: this.run.id, provider: this.run.provider, cwd: this.cwd, prompt, token: this.token, mcpUrl: this.mcpUrl, model: this.model,
      executable: this.executable || resolveCommand(this.run.provider), env: env[key] ? { [key]: env[key] } : {}, unset: env[key] ? [] : [key] }), { mode: 0o600 });
    const command = `node "${launcher}" "${spec}"`;
    let terminal;
    try { terminal = await orcaJson(['terminal', 'create', '--worktree', `path:${this.cwd}`, '--title', `Rex · ${String(this.run.title).slice(0, 40)}`, '--command', command], this.orca); }
    catch (error) { rmSync(spec, { force: true }); throw error; }
    this.handle = terminal.terminal?.handle || terminal.handle;
    this.event('orca-terminal', { handle: this.handle, worktree: this.cwd, note: 'Tool approvals appear in the Orca terminal. Questions sent with desk_ask appear in Rex Desk.' });
    this.event('session', { sessionId: `orca:${this.handle}` });
    // The agent stays open after its turn; the run ends when it finishes through MCP, the terminal closes, or the user stops it.
    while (!this.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, this.pollMs || 5000));
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

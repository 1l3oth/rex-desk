import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orcaStatus, OrcaRunner, showWorktreesInOrca } from '../src/orca.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
// A scripted Orca CLI: each call receives argv and returns the JSON envelope the real CLI prints.
function fakeOrca(responses) {
  const calls = [];
  const run = (command, args, options, callback) => {
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    const response = typeof responses[key] === 'function' ? responses[key](args) : responses[key];
    if (!response) callback(new Error('unexpected'), JSON.stringify({ ok: false, error: { code: 'unexpected', message: key } }));
    else callback(response.ok === false ? new Error('failed') : null, JSON.stringify(response));
  };
  return { calls, options: { run } };
}

test('Orca readiness requires the repository to show external worktrees, and setup turns it on', async () => {
  let visibility = 'hide';
  const orca = fakeOrca({
    'repo list': { ok: true, result: { repos: [{ id: 'repo-1', path: 'F:/flow-was', displayName: 'flow-was' }] } },
    'repo show': () => ({ ok: true, result: { repo: { externalWorktreeVisibility: visibility } } }),
    'repo set': args => { visibility = args[args.indexOf('--external-worktree-visibility') + 1]; return { ok: true, result: {} }; },
  });
  assert.equal((await orcaStatus('F:\\flow-was', orca.options)).ready, false);
  assert.equal((await orcaStatus('F:\\other', orca.options)).repository.registered, false);
  const shown = await showWorktreesInOrca('F:\\flow-was', orca.options);
  assert.equal(shown.visibility, 'show');
  assert.ok(orca.calls.some(args => args.includes('--external-worktree-visibility') && args.includes('show')));
});

test('an Orca run opens a terminal with a one-time spec and ends when the agent exits', async () => {
  const data = temporary('orca-data'), worktree = temporary('orca-worktree'), events = [];
  let created, polls = 0;
  const orca = fakeOrca({
    'repo list': { ok: true, result: { repos: [{ id: 'repo-1', path: 'F:/flow-was' }] } },
    'repo show': { ok: true, result: { repo: { externalWorktreeVisibility: 'show' } } },
    'terminal create': args => { created = args; return { ok: true, result: { terminal: { handle: 'term_1' } } }; },
    'terminal show': () => ({ ok: true, result: { terminal: { connected: true, preview: ++polls > 1 ? 'Rex Desk agent exited (code 0). Run run-1.' : 'working' } } }),
  });
  const runner = new OrcaRunner({ run: { id: 'run-1', title: 'Fix preview', provider: 'claude' }, cwd: worktree, token: 'run-scoped-token', mcpUrl: 'http://127.0.0.1:4317/mcp',
    sourcePath: 'F:\\flow-was', dataDirectory: data, agentEnv: { CLAUDE_CONFIG_DIR: 'C:\\profiles\\signed-in' }, signal: new AbortController().signal,
    event: (kind, value) => events.push([kind, value]), orcaOptions: orca.options, pollMs: 5 });
  assert.deepEqual(await runner.start('Fix the issue.'), { status: 'completed' });
  const command = created[created.indexOf('--command') + 1];
  assert.equal(created[created.indexOf('--worktree') + 1], `path:${worktree}`);
  assert.doesNotMatch(command, /run-scoped-token/, 'The token never appears in the typed terminal command');
  const spec = JSON.parse(readFileSync(command.match(/"([^"]+\.json)"/)[1], 'utf8'));
  assert.equal(spec.token, 'run-scoped-token');
  assert.deepEqual(spec.env, { CLAUDE_CONFIG_DIR: 'C:\\profiles\\signed-in' });
  assert.ok(events.some(([kind, value]) => kind === 'orca-terminal' && value.handle === 'term_1'));

  const hidden = fakeOrca({ 'repo list': { ok: true, result: { repos: [] } } });
  await assert.rejects(new OrcaRunner({ run: { id: 'run-2', title: 'x', provider: 'codex' }, cwd: worktree, sourcePath: 'F:\\flow-was', dataDirectory: data, signal: new AbortController().signal, event() {}, orcaOptions: hidden.options }).start('x'), /does not show Rex Desk worktrees/);
});

test('the Orca launcher deletes its spec, passes the token only to the agent, and reports the exit code', () => {
  const directory = temporary('orca-launcher'), spec = path.join(directory, 'agent.json');
  const probe = 'console.log(process.env.REX_AGENT_TOKEN === "run-scoped-token" ? "token-present" : "token-missing"); console.log("config=" + (process.env.CODEX_HOME || "unset")); process.exit(3)';
  writeFileSync(spec, JSON.stringify({ runId: 'run-1', provider: 'codex', cwd: directory, prompt: 'Fix it', token: 'run-scoped-token', mcpUrl: 'http://127.0.0.1:4317/mcp',
    executable: { command: process.execPath, args: ['-e', probe, '--'] }, env: { CODEX_HOME: directory }, unset: [] }));
  const result = spawnSync(process.execPath, [path.resolve('scripts/orca-agent.mjs'), spec], { encoding: 'utf8', env: { ...process.env, REX_AGENT_TOKEN: '' } });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /token-present/);
  assert.match(result.stdout, new RegExp(`config=${directory.replaceAll('\\', '\\\\')}`));
  assert.match(result.stdout, /Rex Desk agent exited \(code 3\)\. Run run-1\./);
  assert.equal(existsSync(spec), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orcaStatus, OrcaRunner, showWorktreesInOrca, ensureOrcaRunning, sendToOrca } from '../src/orca.js';

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

test('an Orca run survives a Rex Desk restart: its key still works and its terminal is watched again', async () => {
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os'), path = await import('node:path');
  const { Store, now } = await import('../src/store.js');
  const { Desk } = await import('../src/coordinator.js');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-reattach-'));
  let store = new Store(directory), desk = new Desk(store, { root: directory, runnerFactory: () => ({}) });
  store.put('run', 'orca-run', { id: 'orca-run', role: 'worker', title: 'Live in Orca', state: 'running', execution: 'orca', sessionId: 'orca:term_live', createdAt: now() });
  store.put('run', 'headless', { id: 'headless', role: 'worker', title: 'Headless', state: 'running', createdAt: now() });
  const orcaKey = desk.scopeToken('orca-run'), headlessKey = desk.scopeToken('headless');
  store.close();
  store = new Store(directory); desk = new Desk(store, { root: directory, runnerFactory: () => ({}) });
  assert.equal(store.get('run', 'orca-run').state, 'running', 'The agent still works in its Orca terminal');
  assert.equal(store.get('run', 'headless').state, 'interrupted');
  assert.deepEqual(desk.scope(orcaKey), { role: 'worker', runId: 'orca-run' }, 'Its MCP key survives the restart');
  assert.equal(desk.scope(headlessKey), null, 'An interrupted run’s key is dropped');
  let open = true;
  desk.reattachOrca({ pollMs: 10, orcaOptions: { run: (command, args, options, callback) => callback(null, JSON.stringify(open ? { ok: true, result: { terminal: { connected: true, preview: '' } } } : { ok: false, error: { code: 'terminal_not_found', message: 'not found' } })) } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.get('run', 'orca-run').state, 'running');
  open = false;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(store.get('run', 'orca-run').state, 'needs_evidence', 'When the terminal ends, the run settles as usual');
  assert.equal(desk.scope(orcaKey), null, 'and its key is removed');
  for (const live of desk.live.values()) live.controller.abort();
  store.close();
});

test('a reattached Orca run whose terminal closed during the restart is interrupted', async () => {
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os'), path = await import('node:path');
  const { Store, now } = await import('../src/store.js');
  const { Desk } = await import('../src/coordinator.js');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-reattach-closed-'));
  let store = new Store(directory);
  store.put('run', 'gone', { id: 'gone', role: 'worker', title: 'Gone', state: 'running', execution: 'orca', sessionId: 'orca:term_gone', createdAt: now() });
  store.close(); store = new Store(directory);
  const desk = new Desk(store, { root: directory, runnerFactory: () => ({}) });
  desk.reattachOrca({ pollMs: 10, orcaOptions: { run: (command, args, options, callback) => callback(null, JSON.stringify({ ok: false, error: { code: 'terminal_not_found', message: 'not found' } })) } });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(store.get('run', 'gone').state, 'interrupted');
  assert.match(store.get('run', 'gone').error, /closed while Rex Desk restarted/);
  store.close();
});

test('an Orca agent’s own session log becomes the chat, and Rex Desk messages are typed into its terminal', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { SessionMirror, sessionEvents } = await import('../src/orca.js');
  const { Store, now } = await import('../src/store.js');
  const { Desk } = await import('../src/coordinator.js');
  const line = value => JSON.stringify(value) + '\n';
  assert.deepEqual(sessionEvents('claude', { type: 'user', message: { content: 'You are running inside Rex Desk. Use the rex_desk MCP tools.' } }), [['phase', { text: 'The agent received its instructions from Rex Desk' }]]);
  assert.deepEqual(sessionEvents('claude', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Found the cause.' }] } }), [['agent-operation', { type: 'assistant', content: [{ type: 'text', text: 'Found the cause.' }] }]]);
  assert.deepEqual(sessionEvents('codex', { type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } })[0][1].content[0].text, 'Done.');

  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-desk-mirror-')), worktree = path.join(config, 'trees', 'temp-rex-fix-views');
  const folder = path.join(config, 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(folder, { recursive: true });
  const log = path.join(folder, 'session.jsonl');
  fs.writeFileSync(log, line({ type: 'user', message: { content: 'You are running inside Rex Desk.' } }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the issue.' }, { type: 'tool_use', id: 't1', name: 'mcp__rex_desk_run__desk_task', input: {} }] } }) + '{"type":"user","mess');
  const seen = [];
  const mirror = new SessionMirror({ provider: 'claude', cwd: worktree, configDirectory: config, since: new Date(Date.now() - 1000).toISOString(), emit: (kind, data) => seen.push([kind, data]) });
  mirror.pump();
  assert.deepEqual(seen.map(([kind]) => kind), ['phase', 'agent-operation'], 'A half-written line waits for the rest');
  fs.appendFileSync(log, 'age":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}\n' + line({ type: 'user', message: { content: 'please also check Japanese' } }));
  mirror.pump();
  assert.deepEqual(seen.slice(2).map(([kind]) => kind), ['agent-operation', 'human-message']);
  mirror.pump(); assert.equal(seen.length, 4, 'Nothing is read twice');

  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rex-desk-say-')));
  const sent = [];
  const desk = new Desk(store, { root: config, runnerFactory: () => ({}), orcaOptions: { run: (command, args, options, callback) => { sent.push(args); callback(null, JSON.stringify({ ok: true, result: { accepted: true } })); } } });
  store.put('run', 'r1', { id: 'r1', role: 'worker', provider: 'claude', execution: 'orca', sessionId: 'orca:term_1', worktree, state: 'running', createdAt: now() });
  await assert.rejects(desk.say('r1', 'hello'), /Only a running Orca agent/);
  desk.live.set('r1', { controller: new AbortController() });
  await desk.say('r1', 'please also\ncheck Japanese');
  assert.deepEqual(sent[0].slice(0, 7), ['terminal', 'send', '--terminal', 'term_1', '--text', 'please also check Japanese', '--enter']);
  const echo = desk.mirror(store.get('run', 'r1'));
  echo.emit('human-message', { text: 'please also check Japanese' });
  assert.equal(store.events('r1').filter(event => event.kind === 'human-message').length, 1, 'The log’s echo of a Rex Desk message is not shown twice');
  store.close();
});

test('a closed Orca is opened rather than letting a run go headless', async () => {
  const running = fakeOrca({ 'status --json': { ok: true, result: { app: { running: true }, runtime: { reachable: true } } } });
  await ensureOrcaRunning(running.options);
  assert.deepEqual(running.calls.map(args => args[0]), ['status'], 'A reachable Orca is left alone');

  const closed = fakeOrca({
    'status --json': { ok: true, result: { app: { running: false }, runtime: { reachable: false } } },
    'open --json': { ok: true, result: {} },
  });
  await ensureOrcaRunning(closed.options);
  assert.deepEqual(closed.calls.map(args => args[0]), ['status', 'open'], 'A closed Orca is started first');
});

test('a blocked terminal message is sent again with the request ID Orca gave, never as a plain retry', async () => {
  const run = { sessionId: 'orca:term_7' };
  const blocked = {
    ok: false,
    error: { code: 'agent_prompt_blocked', message: 'agent_prompt_blocked Terminal prompt request ID: 7c3a8d71-d78d-409a-9a84-91fb162c1be3.',
      data: { nextSteps: ['Re-issue the exact command with --retry-request 7c3a8d71-d78d-409a-9a84-91fb162c1be3 --wait-submit <seconds>; do not retry it without that ID.'] } },
  };
  let attempt = 0;
  const orca = fakeOrca({ 'terminal send': () => (++attempt === 1 ? blocked : { ok: true, result: { submitted: true } }) });
  assert.deepEqual(await sendToOrca(run, 'try the dev server', orca.options), { submitted: true });
  assert.equal(orca.calls.length, 2);
  assert.deepEqual(orca.calls[1].slice(-5, -1), ['--retry-request', '7c3a8d71-d78d-409a-9a84-91fb162c1be3', '--wait-submit', '10']);
  assert.deepEqual(orca.calls[1].slice(0, 7), orca.calls[0].slice(0, 7), 'The retry repeats the exact command');

  const other = fakeOrca({ 'terminal send': { ok: false, error: { code: 'not_found', message: 'terminal closed' } } });
  await assert.rejects(sendToOrca(run, 'hello', other.options), /terminal closed/);
  assert.equal(other.calls.length, 1, 'A failure without an ID is never typed twice');
});

test('Claude Code in an Orca terminal cannot use its own question prompt', () => {
  const directory = temporary('orca-ask'), spec = path.join(directory, 'agent.json');
  const probe = 'console.log("args=" + process.argv.slice(2).join(" ")); process.exit(0)';
  writeFileSync(spec, JSON.stringify({ runId: 'run-2', provider: 'claude', cwd: directory, prompt: 'Fix it', token: 'run-scoped-token', mcpUrl: 'http://127.0.0.1:4317/mcp',
    executable: { command: process.execPath, args: ['-e', probe, '--'] }, env: {}, unset: [] }));
  const result = spawnSync(process.execPath, [path.resolve('scripts/orca-agent.mjs'), spec], { encoding: 'utf8' });
  assert.match(result.stdout, /--disallowed-tools AskUserQuestion/, 'The native question prompt is turned off; desk_ask reaches the dashboard');
});

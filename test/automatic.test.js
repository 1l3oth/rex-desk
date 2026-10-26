import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now, modelName } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { CodexRunner } from '../src/runners.js';
import { issueBranch, provisionalTitle, defaultBranchPattern } from '../src/branches.js';
import { detectProject, effectiveRepository } from '../src/project-detect.js';
import { readOrcaTerminal } from '../src/orca.js';
import { git, createWorktree } from '../src/processes.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const idle = () => ({ start: async () => ({ status: 'completed' }), interrupt: async () => {}, close() {} });
async function repository() {
  const directory = temporary('auto'), original = path.join(directory, 'repo'), trees = path.join(directory, 'trees');
  mkdirSync(original); mkdirSync(trees);
  await git(original, ['init', '-b', 'develop']);
  await git(original, ['config', 'user.name', 'Rex Desk Test']); await git(original, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(original, 'README.md'), 'fixture\n'); await git(original, ['add', '.']); await git(original, ['commit', '-m', 'Initial test fixture']);
  return { original, trees };
}
function workspace(original) {
  const store = new Store(temporary('auto-store'));
  store.saveConfig({ ...defaults, repositories: [{ id: 'repo', name: 'repo', path: original, baseBranch: 'develop', targetBranch: 'develop' }] });
  store.put('task', 'task-1', { id: 'task-1', title: '파일 미리보기 화면에서 다운로드 버튼 클릭 시 빈 화면', taskNumber: '38464', externalId: '1076020', source: 'morningmate', active: true, createdAt: now() });
  return { store, desk: new Desk(store, { root: temporary('auto-root'), runnerFactory: idle }) };
}

test('typed model shorthand becomes a real Claude model ID, and family names stay CLI aliases', () => {
  assert.equal(modelName('claude', 'opus5.5'), 'claude-opus-5-5');
  assert.equal(modelName('claude', 'Opus 5.5'), 'claude-opus-5-5');
  assert.equal(modelName('claude', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(modelName('claude', 'sonnet'), 'sonnet');
  assert.equal(modelName('claude', ''), '');
  assert.equal(modelName('codex', 'gpt-5.5'), 'gpt-5.5', 'Codex names are passed through');
  const store = new Store(temporary('model'));
  store.saveConfig({ ...defaults, models: { claude: 'opus5.5', codex: '' } });
  assert.equal(store.config().models.claude, 'claude-opus-5-5'); store.close();
});

test('Codex runs Rex Desk tools without a prompt, except starting new work and other servers', async () => {
  const sent = [], asked = [];
  const runner = new CodexRunner({ run: { role: 'coordinator' }, ask: async request => { asked.push(request); return { action: 'accept' }; }, event() {}, signal: new AbortController().signal });
  runner.send = value => sent.push(value);
  const approval = (tool, serverName = 'rex_desk_run') => ({ method: 'mcpServer/elicitation/request', id: 7,
    params: { serverName, message: `Allow the ${serverName} MCP server to run tool "${tool}"?`, _meta: { codex_approval_kind: 'mcp_tool_call' } } });
  await runner.serverRequest(approval('desk_message'));
  assert.deepEqual(sent.at(-1), { id: 7, result: { action: 'accept', content: {}, _meta: null } });
  assert.equal(asked.length, 0);
  await runner.serverRequest(approval('desk_dispatch'));
  assert.equal(asked.length, 1, 'Starting new work still asks');
  await runner.serverRequest(approval('desk_message', 'another_server'));
  assert.equal(asked.length, 2, 'Another server’s tools still ask');
});

test('branches read as English summaries, never internal IDs, and a taken name gets a suffix', async () => {
  assert.equal(defaultBranchPattern, '{prefix}/{type}/{title}');
  assert.equal(issueBranch('', { prefix: 'temp/rex', title: 'download button blank preview' }), 'temp/rex/fix/download-button-blank-preview');
  assert.equal(provisionalTitle({ title: '업무 매니저 > 프로젝트 생성', taskNumber: '38464', externalId: '1076020' }), 'issue 38464', 'Non-Latin titles use the tracker number until the worker names the branch');
  assert.equal(provisionalTitle({ title: 'Safari list view broken', taskNumber: '1' }), 'Safari list view broken');
  const { original, trees } = await repository(), { store, desk } = workspace(original);
  await git(original, ['branch', 'temp/rex/fix/download-button-blank-preview']);
  const worktree = await createWorktree({ path: original, baseBranch: 'develop' }, trees, 'temp/rex/fix/issue-38464');
  store.put('run', 'run-1', { id: 'run-1', role: 'worker', taskId: 'task-1', repositoryId: 'repo', worktree: worktree.directory, branch: 'temp/rex/fix/issue-38464', state: 'running', createdAt: now() });
  const renamed = await desk.renameBranch('run-1', { title: 'Download button blank preview', type: 'fix' });
  assert.equal(renamed.branch, 'temp/rex/fix/download-button-blank-preview-2');
  assert.equal(await git(worktree.directory, ['branch', '--show-current']), renamed.branch);
  assert.equal(store.get('run', 'run-1').branch, renamed.branch);
  await assert.rejects(desk.renameBranch('run-1', { title: '다운로드 버튼' }), /English words/);
  store.put('run', 'run-1', { ...store.get('run', 'run-1'), prUrl: 'https://github.com/example/pull/1' });
  await assert.rejects(desk.renameBranch('run-1', { title: 'another name here' }), /already pushed/);
  assert.match(desk.prompt({ id: 'worker', role: 'worker', taskId: 'task-1', worktree: 'x', branch: 'y', baseBranch: 'develop', port: 1 }), /desk_branch once with 2 to 8 English words/);
  store.close();
});

test('commands come from the project files, and Settings values override them', () => {
  const node = temporary('node');
  writeFileSync(path.join(node, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', dev: 'vite' } })); writeFileSync(path.join(node, 'package-lock.json'), '{}');
  const found = detectProject(node);
  assert.deepEqual([found.setupCommand, found.testCommand, found.devCommand], ['npm ci', 'npm test', 'npm run dev -- --port {port}']);
  assert.equal(found.from.testCommand, 'package.json "test" script');
  const effective = effectiveRepository({ path: node, setupCommand: '', devCommand: '', testCommand: 'npm run test:unit' });
  assert.equal(effective.testCommand, 'npm run test:unit'); assert.equal(effective.setupCommand, 'npm ci');
  const maven = temporary('maven'); writeFileSync(path.join(maven, 'pom.xml'), '<project/>');
  assert.equal(detectProject(maven).testCommand, 'mvn -q test');
  const war = temporary('war'); mkdirSync(path.join(war, 'src', 'WEB-INF'), { recursive: true }); writeFileSync(path.join(war, 'run-tests.sh'), '#!/bin/bash\n');
  const flow = detectProject(war);
  assert.equal(flow.flowRuntime, null, 'No Tomcat template beside the checkout, so no preset');
  if (process.platform === 'win32') assert.equal(flow.testCommand, '', 'Shell test scripts are not guessed on Windows');
});

test('with nothing set or detected, the worker proposes a test command that the human approves once', async () => {
  const { original } = await repository(), { store, desk } = workspace(original);
  store.put('run', 'run-v', { id: 'run-v', role: 'worker', taskId: 'task-1', repositoryId: 'repo', worktree: original, port: 1, state: 'running', createdAt: now() });
  await assert.rejects(desk.verify('run-v'), /No test command is set or detected/);
  const command = 'node -e "process.exit(0)"', pending = desk.verify('run-v', { command });
  let request;
  for (let attempt = 0; attempt < 50 && !request; attempt++) { request = store.list('interaction').find(item => item.state === 'pending' && item.method === 'test-command'); if (!request) await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(request.request.command, command);
  desk.answer(request.id, { action: 'accept' });
  const verification = await pending;
  assert.equal(verification.passed, true); assert.equal(verification.source, 'approved');
  assert.equal(store.config().repositories[0].testCommand, command, 'Saved for later runs');
  assert.equal((await desk.verify('run-v')).source, 'settings', 'The next verification does not ask again');
  store.close();
});

test('the Orca terminal screen is read through the CLI for a run that owns one', async () => {
  let args;
  const fake = (command, input, options, callback) => { args = input; callback(null, JSON.stringify({ ok: true, result: { terminal: { handle: 'term_1', status: 'running', source: 'screen', tail: ['❯ go', '● Working'] } } })); };
  assert.deepEqual(await readOrcaTerminal({ sessionId: 'orca:term_1' }, { run: fake }), { handle: 'term_1', status: 'running', source: 'screen', lines: ['❯ go', '● Working'] });
  assert.ok(args.includes('--screen') && args.includes('term_1'));
  await assert.rejects(readOrcaTerminal({ sessionId: 'session-1' }, { run: fake }), /no Orca terminal/);
});

test('every agent writes to the human in English', () => {
  const store = new Store(temporary('english')), desk = new Desk(store, { root: temporary('english-root'), runnerFactory: idle });
  store.put('task', 'task-1', { id: 'task-1', title: '빈 화면', active: true });
  for (const run of [{ id: 'c', role: 'coordinator', taskIds: ['task-1'] }, { id: 'v', role: 'verifier', taskId: 'task-1' }, { id: 'w', role: 'worker', taskId: 'task-1', branch: 'b', worktree: 'w', baseBranch: 'develop', port: 1 }]) {
    assert.match(desk.prompt(run), /Write everything for the human in English/);
  }
  store.close();
});

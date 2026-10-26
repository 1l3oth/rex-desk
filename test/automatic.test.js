import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now, modelName } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { CodexRunner } from '../src/runners.js';
import { issueBranch, provisionalTitle, defaultBranchPattern } from '../src/branches.js';
import { detectProject, effectiveRepository, findJava8 } from '../src/project-detect.js';
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

test('Codex runs Rex Desk tools without its own prompt, while other servers still ask', async () => {
  const sent = [], asked = [];
  const runner = new CodexRunner({ run: { role: 'coordinator' }, ask: async request => { asked.push(request); return { action: 'accept' }; }, event() {}, signal: new AbortController().signal });
  runner.send = value => sent.push(value);
  const approval = (tool, serverName = 'rex_desk_run') => ({ method: 'mcpServer/elicitation/request', id: 7,
    params: { serverName, message: `Allow the ${serverName} MCP server to run tool "${tool}"?`, _meta: { codex_approval_kind: 'mcp_tool_call' } } });
  await runner.serverRequest(approval('desk_message'));
  assert.deepEqual(sent.at(-1), { id: 7, result: { action: 'accept', content: {}, _meta: null } });
  assert.equal(asked.length, 0);
  await runner.serverRequest(approval('desk_dispatch'));
  assert.equal(asked.length, 0, 'Rex Desk asks about dispatches itself, with the issue named');
  await runner.serverRequest(approval('desk_message', 'another_server'));
  assert.equal(asked.length, 1, 'Another server’s tools still ask');
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
  assert.match(desk.prompt({ id: 'worker', role: 'worker', taskId: 'task-1', worktree: 'x', branch: 'y', baseBranch: 'develop', port: 1 }), /call desk_branch with 3 to 6 English words/);
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
  if (findJava8()) assert.match(flow.testCommand, /war-check.mjs/, 'A WAR layout is verified by compiling its changed classes with JDK 8, not by its shell scripts');
  else if (process.platform === 'win32') assert.equal(flow.testCommand, '', 'Shell test scripts are not guessed on Windows');
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

test('messages to the human that are mostly Korean or Japanese go back to the agent, quoted titles do not', async () => {
  const { requireEnglish } = await import('../src/mcp.js');
  for (const text of ['debugging-investigate-first 절차를 적용합니다. AGENTS.md는 없고 CLAUDE.md와 빌드 지침을 읽었습니다.', 'ビューの名前を修正しました。新しいプロジェクトで正しく表示されます。'])
    assert.throws(() => requireEnglish(text, 'this message'), /Rewrite this message in English/);
  for (const text of ['Issue #38464 “설치형, 파일, 미리보기 - 미리보기 화면에서 다운로드 버튼 클릭 시 빈 화면” is fixed and verified in the recorded browser.', 'The 全体タスク view now shows the right name in Japanese projects.', '확인'])
    assert.doesNotThrow(() => requireEnglish(text, 'this message'));
});

test('workers start with the lessons earlier runs learned', async () => {
  const { original } = await repository(), { store, desk } = workspace(original);
  const prompt = desk.prompt({ id: 'w', role: 'worker', taskId: 'task-1', repositoryId: 'repo', worktree: original, branch: 'b', baseBranch: 'develop', port: 1 });
  assert.match(prompt, /Never change the working directory of your shell session/);
  assert.match(prompt, /two or three plain English sentences/);
  assert.match(prompt, /Reminder: every desk_message, desk_ask, summary, and report to the human is in English\.$/);
  assert.doesNotMatch(prompt, /flow-was Java/, 'Flow lessons only for the Flow repository');
  store.close();
});

test('a new run gets an English branch name that describes the QA issue, or the tracker number without a key', async () => {
  const { parseBranchName, branchName } = await import('../src/naming.js');
  assert.deepEqual(parseBranchName('```json\n{"type":"fix","name":"project-view-names-ignore-language"}\n```'), { type: 'fix', title: 'project view names ignore language' });
  assert.equal(parseBranchName('{"type":"fix","name":"fix issue"}'), null, 'Generic words are rejected');
  assert.equal(parseBranchName('not json'), null);
  let request;
  const fetcher = async (url, options) => { request = { url, body: JSON.parse(options.body), auth: options.headers.Authorization };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"fix","name":"project view names ignore language"}' } }] })); };
  assert.deepEqual(await branchName({ title: '업무 매니저 > 프로젝트 생성 > 업무 탭 뷰명 영어·한국어 표시' }, { apiKey: 'or-key', fetcher }), { type: 'fix', title: 'project view names ignore language' });
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(request.auth, 'Bearer or-key');
  assert.match(request.body.messages[1].content, /업무 매니저/);

  const { original } = await repository();
  // Without a key the signed-in Claude Code names it; when that fails too, the tracker number.
  const cli = answer => (command, args, options, callback) => { assert.ok(args.includes('haiku') && args.at(-1).includes('업무 매니저')); callback(answer ? null : new Error('not signed in'), answer); };
  for (const [key, expected, namingCommand] of [['or-key', 'temp/rex/fix/project-view-names-ignore-language'], ['', 'temp/rex/fix/views-keep-english-names', cli('{"type":"fix","name":"views keep english names"}')], ['', 'temp/rex/fix/issue-38464', cli('')]]) {
    const store = new Store(path.join(temporary('naming'), 'data')); // its own worktrees folder beside it
    store.saveConfig({ ...defaults, repositories: [{ id: 'repo', name: 'repo', path: original, baseBranch: 'develop', targetBranch: 'develop' }], jev: { apiKey: key } });
    store.put('task', 'task-1', { id: 'task-1', title: '업무 매니저 > 프로젝트 생성 > 업무 탭 뷰명 영어·한국어 표시', taskNumber: '38464', externalId: '1076020', source: 'morningmate', active: true, createdAt: now() });
    const desk = new Desk(store, { root: temporary('naming-root'), runnerFactory: idle, namingFetcher: fetcher, namingCommand });
    const run = await desk.startTask({ taskId: 'task-1', repositoryId: 'repo' });
    for (let attempt = 0; attempt < 100 && !store.get('run', run.id).branch; attempt++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(store.get('run', run.id).branch, expected);
    await new Promise(resolve => setTimeout(resolve, 100)); store.close();
  }
});

test('an agent cannot start a run on an issue until the human approves the card that names it', async () => {
  const { original } = await repository(), { store, desk } = workspace(original);
  store.put('run', 'agent', { id: 'agent', role: 'coordinator', title: 'External AI', state: 'running', createdAt: now() });
  const pending = desk.dispatch('agent', { taskId: 'task-1', repositoryId: 'repo' });
  let card;
  for (let attempt = 0; attempt < 50 && !card; attempt++) { card = store.list('interaction').find(item => item.state === 'pending' && item.method === 'dispatch'); if (!card) await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.match(card.title, /Start a fix on “파일 미리보기/);
  assert.equal(store.list('run').filter(run => run.role === 'worker').length, 0, 'Nothing starts while the card waits');
  desk.answer(card.id, { action: 'decline' });
  await assert.rejects(pending, /did not approve/);
  assert.equal(store.list('run').filter(run => run.role === 'worker').length, 0);
  store.close();
});

test('desk_attachment saves an issue screenshot into the run folder for the agent to read', async () => {
  const { createApp } = await import('../src/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { existsSync } = await import('node:fs');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNgYGD4z8DAwMDAAAAEBQEAr8Q+0wAAAABJRU5ErkJggg==', 'base64');
  const shot = 'https://morningmate.invalid/flowImg/shot.png';
  const app = await createApp({ dataDirectory: temporary('attachment'), port: 0, imageFetcher: async url => String(url) === shot ? new Response(png) : new Response('', { status: 404 }) });
  try {
    app.store.put('task', 'task-a', { id: 'task-a', title: 'Blank preview', active: true, images: [{ url: shot, name: 'shot.png' }] });
    app.store.put('run', 'worker-a', { id: 'worker-a', role: 'worker', taskId: 'task-a', state: 'running', createdAt: now() });
    const client = new Client({ name: 'attachment-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.address + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${app.desk.scopeToken('worker-a')}` } } }));
    try {
      const saved = JSON.parse((await client.callTool({ name: 'desk_attachment', arguments: { url: shot } })).content[0].text);
      assert.equal(saved.type, 'png'); assert.ok(existsSync(saved.path)); assert.match(saved.path, /worker-a[\\/]attachments/);
      assert.equal((await client.callTool({ name: 'desk_attachment', arguments: { url: 'https://example.invalid/other.png' } })).isError, true, 'Only files of the run’s own issue');
    } finally { await client.close(); }
  } finally { await app.close(); }
});

test('a QA check signs in with the saved test account on test servers, never on production', () => {
  const store = new Store(temporary('qa-login')), desk = new Desk(store, { root: temporary('qa-login-root'), runnerFactory: idle });
  store.put('task', 't', { id: 't', title: 'Task form fields', active: true });
  const verifier = { id: 'v', role: 'verifier', taskId: 't' };
  assert.match(desk.prompt(verifier), /no test account is saved .* report blocked/);
  store.saveConfig({ ...defaults, testAccounts: [{ id: 'any', site: '', username: 'qa@example.invalid', password: 'secret-for-test' }] });
  const prompt = desk.prompt(verifier);
  assert.match(prompt, /If you land on a login page on a test server, sign in with desk_browser fill: the Flow and Morningmate sign-in form/);
  assert.match(prompt, /On production that account does not apply/);
  assert.doesNotMatch(prompt, /the human has no saved sign-in for this site/);
  store.close();
});

test('agents may not write the person’s Claude memory or settings, from any profile folder', async () => {
  const { writesClaudeHome } = await import('../src/runners.js');
  const orcaMemory = 'C:/Users/flow/AppData/Roaming/orca/claude-profiles/6090b7ff/home/projects/F--flow-was/memory/feedback.md';
  assert.equal(writesClaudeHome('Write', { file_path: 'C:\\Users\\flow\\.claude\\projects\\F--flow-was\\memory\\note.md' }), true);
  assert.equal(writesClaudeHome('Edit', { file_path: 'C:/Users/flow/.claude-third-profile/CLAUDE.md' }), true);
  assert.equal(writesClaudeHome('Bash', { command: `M="${orcaMemory.replace('/feedback.md', '')}"; cat > "$M/feedback.md" <<'EOF'` }), true);
  assert.equal(writesClaudeHome('Bash', { command: 'cat C:/Users/flow/.claude/settings.json' }), false, 'Reading is fine');
  assert.equal(writesClaudeHome('Write', { file_path: 'F:/rex-desk/worktrees/temp-rex-fix-views/src/app.js' }), false, 'The worktree is fine');
  const store = new Store(temporary('memory-guard')), desk = new Desk(store, { root: temporary('memory-guard-root'), runnerFactory: idle });
  store.put('task', 't', { id: 't', title: 'Views', active: true });
  assert.match(desk.prompt({ id: 'w', role: 'worker', taskId: 't', worktree: 'w', branch: 'b', baseBranch: 'develop', port: 1 }), /Never write to Claude memory, CLAUDE\.md, agent settings/);
  store.close();
});

test('a pull request opened outside Rex Desk is found by the run branch and settles the run', async () => {
  const { original } = await repository(), { store, desk } = workspace(original);
  store.put('run', 'r', { id: 'r', role: 'worker', taskId: 'task-1', repositoryId: 'repo', branch: 'temp/rex/fix/views-keep-english-names', state: 'interrupted', createdAt: now() });
  let asked;
  await desk.findPullRequests({ run: async (command, args, options) => { asked = { command, args, cwd: options.cwd }; return { stdout: JSON.stringify([{ url: 'https://github.com/example/app/pull/2247', number: 2247, state: 'OPEN', baseRefName: 'global/release' }]) }; } });
  assert.deepEqual(asked.args.slice(0, 4), ['pr', 'list', '--head', 'temp/rex/fix/views-keep-english-names']);
  const run = store.get('run', 'r');
  assert.equal(run.state, 'published'); assert.equal(run.prNumber, 2247); assert.equal(run.targetBranch, 'global/release');
  store.close();
});

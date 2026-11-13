import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now } from '../src/store.js';
import { Sources, normalizeTask, taskAssignees, postContent, matchesTaskStatus, accountList } from '../src/providers.js';
import { Desk, validateAnswer } from '../src/coordinator.js';
import { git, createWorktree, slug, fingerprint } from '../src/processes.js';
import { createApp } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const source = { id: 'source-1', name: 'Morningmate', type: 'morningmate', baseUrl: 'https://api.morningmate.com', projectIds: ['317938'], repositoryId: 'repository-1', userId: 'rex@example.com', statusMap: {} };
const jsonResponse = data => new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });

test('Morningmate rich-text JSON becomes readable paragraphs and image references', () => {
  const content = JSON.stringify({ COMPS: [
    { COMP_TYPE: 'TEXT', COMP_DETAIL: { CONTENTS: 'Preview issue\nKeep the selected project.<br>Expected: image opens.' } },
    { COMP_TYPE: 'IMAGE', COMP_DETAIL: { ATCH_URL: 'https://morningmate.com/flowImg/example.png', ORCP_FILE_NM: 'preview.png' } },
  ] });
  const parsed = postContent({ content });
  assert.equal(parsed.description, 'Preview issue\nKeep the selected project.\nExpected: image opens.');
  assert.deepEqual(parsed.contentImages, [{ url: 'https://morningmate.com/flowImg/example.png', name: 'preview.png' }]);
  assert.ok(!parsed.description.includes('COMP_TYPE'));
});

test('sync defaults to request and progress, with explicit unfinished and all-status options', () => {
  assert.equal(matchesTaskStatus({ status: '0', statusName: 'Request' }), true);
  assert.equal(matchesTaskStatus({ status: '1', statusName: 'Progress' }), true);
  assert.equal(matchesTaskStatus({ status: '2', statusName: 'Completed' }), false);
  assert.equal(matchesTaskStatus({ status: '4', statusName: 'Feedback' }), false);
  assert.equal(matchesTaskStatus({ status: '4', statusName: 'Feedback' }, 'unfinished'), true);
  assert.equal(matchesTaskStatus({ status: '2', statusName: 'Completed' }, 'all'), true);
});

test('settings encrypt API keys, mask responses, rotate keys, and persist across restarts', () => {
  const directory = temporary('vault'); let store = new Store(directory);
  store.saveConfig({ ...defaults, sources: [{ ...source, apiKey: 'test-key-please-never-return' }], repositories: [] });
  assert.equal(store.credential(source.id), 'test-key-please-never-return');
  assert.ok(!JSON.stringify(store.publicConfig()).includes('test-key-please-never-return'));
  assert.ok(!readFileSync(path.join(directory, 'desk.sqlite')).includes(Buffer.from('test-key-please-never-return')));
  store.saveConfig({ ...store.publicConfig(), sources: [{ ...source, apiKey: '' }] });
  assert.equal(store.credential(source.id), 'test-key-please-never-return');
  const token = store.token; store.close(); store = new Store(directory);
  assert.equal(store.credential(source.id), 'test-key-please-never-return'); assert.equal(store.token, token);
  store.saveConfig({ ...store.publicConfig(), sources: [{ ...source, clearKey: true }] });
  assert.equal(store.credential(source.id), ''); store.close();
});

test('assignment filtering recognizes task workers and worker columns, but never the author or unrelated user columns', () => {
  const post = { registerId: 'rex@example.com', tasks: [{ taskId: '101', columns: [
    { defaultColumnType: 'WORKER', columnData: [{ customColumnData: 'rex@example.com', userName: 'Rex' }] },
    { defaultColumnType: '', columnType: 'USER', columnData: [{ customColumnData: 'someone@example.com' }] },
  ] }] };
  assert.deepEqual(taskAssignees(post), ['rex@example.com']);
  assert.deepEqual(taskAssignees({ registerId: 'rex@example.com' }), []);
  const task = normalizeTask(source, '317938', { postId: '42', taskStatus: 'PROGRESS', title: 'Timezone issue' }, post);
  assert.equal(task.externalId, '101'); assert.equal(task.postId, '42'); assert.equal(task.status, 'PROGRESS');
});

test('sync follows API cursors, isolates assignments, preserves categories, and retires tasks only after a successful complete sync', async () => {
  const store = new Store(temporary('sync')); const calls = [];
  store.saveConfig({ ...defaults, sources: [{ ...source, apiKey: 'fixture-key' }], repositories: [] });
  const fetcher = async (value, options) => {
    const url = new URL(value); calls.push(url.pathname + url.search);
    assert.equal(options.headers['x-flow-api-key'], 'fixture-key');
    if (url.pathname.endsWith('/columns/status')) return jsonResponse({ options: [{ id: '1', name: 'In progress' }] });
    if (url.pathname.endsWith('/projects/317938')) {
      if (url.searchParams.get('cursor') === '0') return jsonResponse({ posts: [{ postId: '10', title: 'My issue', taskStatus: 'REQUEST' }], hasNext: true, lastCursor: 1 });
      return jsonResponse({ posts: [{ postId: '11', title: 'Other issue', taskStatus: 'PROGRESS' }], hasNext: false, lastCursor: -1 });
    }
    return jsonResponse({ taskId: url.pathname.endsWith('/10') ? '100' : '101', workers: [{ workerId: url.pathname.endsWith('/10') ? 'rex@example.com' : 'other@example.com' }] });
  };
  const sources = new Sources(store, { fetcher });
  const result = await sources.sync(); assert.equal(result[0].count, 1);
  const task = store.list('task')[0]; assert.equal(task.title, 'My issue');
  store.put('task', task.id, { ...task, category: 'Regression', titleEn: 'My issue in English' });
  await sources.sync(); assert.equal(store.get('task', task.id).category, 'Regression');
  assert.equal(store.get('task', task.id).titleEn, 'My issue in English', 'a sync keeps the English name while the title is the same');
  const failedSources = new Sources(store, { fetcher: async () => new Response('{}', { status: 403 }) });
  const failed = await failedSources.sync(); assert.match(failed[0].error, /403/);
  assert.equal(store.get('task', task.id).active, true);
  assert.ok(calls.some(value => value.includes('cursor=1'))); store.close();
});

test('dashboard answers are validated, single-use, and restore review state after approval', async () => {
  const store = new Store(temporary('answers')); const desk = new Desk(store, { root: temporary('root') });
  store.put('run', 'run-1', { id: 'run-1', title: 'Fixture', role: 'worker', state: 'ready_for_review', createdAt: now() });
  const interaction = desk.beginAsk('run-1', { kind: 'approval', request: { requestedSchema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3 } } } } });
  assert.equal(desk.run('run-1').state, 'waiting');
  assert.throws(() => desk.answer(interaction.id, { action: 'accept', content: { reason: 'x' } }), /too short/);
  desk.answer(interaction.id, { action: 'accept', content: { reason: 'Looks correct' } });
  assert.equal((await interaction.promise).action, 'accept'); assert.equal(desk.run('run-1').state, 'ready_for_review');
  assert.throws(() => desk.answer(interaction.id, { action: 'accept' }), /no longer/); store.close();
});

test('MCP scopes prevent workers reading or dispatching unrelated work', async () => {
  const app = await createApp({ dataDirectory: temporary('scope'), port: 0 });
  try {
    app.store.put('task', 'task-a', { id: 'task-a', title: 'Assigned', active: true });
    app.store.put('task', 'task-b', { id: 'task-b', title: 'Unrelated', active: true });
    app.store.put('run', 'worker-a', { id: 'worker-a', role: 'worker', taskId: 'task-a', state: 'running', createdAt: now() });
    const token = app.desk.scopeToken('worker-a');
    const client = new Client({ name: 'scope-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.address + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      const tasks = JSON.parse((await client.callTool({ name: 'desk_tasks', arguments: {} })).content[0].text);
      assert.deepEqual(tasks.map(task => task.id), ['task-a']);
      assert.notEqual((await client.callTool({ name: 'desk_task', arguments: { taskId: 'task-b' } })).isError, true, 'an agent may read any task');
      assert.equal((await client.callTool({ name: 'desk_dispatch', arguments: { taskId: 'task-b' } })).isError, true);
      const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'desk_elicit'));
    } finally { await client.close(); }
  } finally { await app.close(); }
});

test('HTTP protects mutations and MCP credentials and never serves runtime database files', async () => {
  const app = await createApp({ dataDirectory: temporary('http'), port: 0 });
  try {
    assert.equal((await fetch(app.address + '/api/demo', { method: 'POST' })).status, 403);
    assert.equal((await fetch(app.address + '/api/state', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(app.address + '/mcp', { method: 'POST' })).status, 401);
    assert.equal((await fetch(app.address + '/.local/desk.sqlite')).status, 404);
    assert.equal((await fetch(app.address + '/api/mcp-config')).status, 404);
    const state = await (await fetch(app.address + '/api/state')).json();
    assert.ok(!JSON.stringify(state).includes(app.store.token));
  } finally { await app.close(); }
});

test('worktrees start from the selected branch without switching or copying dirty source files', async () => {
  const directory = temporary('git'), original = path.join(directory, 'repo'), worktrees = path.join(directory, 'trees');
  mkdirSync(original); mkdirSync(worktrees);
  await git(original, ['init', '-b', 'develop']);
  await git(original, ['config', 'user.name', 'Rex Desk Test']); await git(original, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(original, 'app.txt'), 'committed\n'); await git(original, ['add', '.']); await git(original, ['commit', '-m', 'Initial test fixture']);
  await git(original, ['switch', '-c', 'existing-work']); writeFileSync(path.join(original, 'app.txt'), 'unsaved original\n');
  const result = await createWorktree({ path: original, baseBranch: 'develop' }, worktrees, 'temp/rex/qa-42/fixture');
  assert.equal(readFileSync(path.join(result.directory, 'app.txt'), 'utf8').replaceAll('\r\n', '\n'), 'committed\n');
  assert.equal(await git(original, ['branch', '--show-current']), 'existing-work');
  assert.equal(readFileSync(path.join(original, 'app.txt'), 'utf8'), 'unsaved original\n');
  assert.ok(!slug('invalid/../branch').includes('/'));
});

test('restart expires questions and marks active runs interrupted rather than claiming completion', () => {
  const directory = temporary('restart'); let store = new Store(directory);
  store.put('run', 'run-1', { id: 'run-1', state: 'running' }); store.put('interaction', 'question-1', { id: 'question-1', state: 'pending' }); store.close();
  store = new Store(directory); assert.equal(store.get('run', 'run-1').state, 'interrupted'); assert.equal(store.get('interaction', 'question-1').state, 'expired'); store.close();
});

test('publish needs the yes: from the person, or from autonomy', async () => {
  const store = new Store(temporary('proof')); const desk = new Desk(store, { root: temporary('root') });
  store.put('run', 'run-1', { id: 'run-1', state: 'needs_evidence', title: 'Unverified task' });
  await assert.rejects(desk.publish('run-1', { approved: false }), /approval/); store.close();
});

test('the queue enforces concurrency across both providers and switching preserves the isolated worktree', async () => {
  const directory = temporary('queue'), repository = path.join(directory, 'source'); mkdirSync(repository);
  await git(repository, ['init', '-b', 'develop']); await git(repository, ['config', 'user.name', 'Test']); await git(repository, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(repository, 'source.txt'), 'fixture'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'Fixture']);
  const store = new Store(path.join(directory, 'data'));
  store.saveConfig({ ...defaults, concurrency: 2, repositories: [{ id: 'repository-1', name: 'Fixture', path: repository, baseBranch: 'develop', targetBranch: 'develop' }], sources: [] });
  const starts = [];
  const desk = new Desk(store, { root: directory, runnerFactory: options => {
    let release;
    return { async start() { starts.push({ ...options, release: () => release() }); await new Promise(resolve => { release = resolve; }); }, async interrupt() { release?.(); } };
  } });
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Queue condition did not complete.');
  };
  try {
    for (let index = 1; index <= 3; index++) store.put('task', `task-${index}`, { id: `task-${index}`, title: `Issue ${index}`, source: 'flow', externalId: String(index), repositoryId: 'repository-1', active: true });
    const first = await desk.startTask({ taskId: 'task-1', provider: 'claude' });
    await desk.startTask({ taskId: 'task-2', provider: 'claude' });
    const third = await desk.startTask({ taskId: 'task-3', provider: 'claude' });
    await waitFor(() => starts.length === 2);
    assert.deepEqual(starts.map(item => item.run.provider).sort(), ['claude', 'claude']);
    assert.equal(desk.run(third.id).state, 'queued');
    assert.notEqual(starts[0].cwd, starts[1].cwd); assert.notEqual(starts[0].run.port, starts[1].run.port);
    const originalWorktree = desk.run(first.id).worktree;
    starts.find(item => item.run.id === first.id).release(); await waitFor(() => starts.length === 3);
    for (const runId of [...desk.live.keys()]) await desk.stop(runId);
    await waitFor(() => desk.live.size === 0);
    await desk.resume(first.id, { prompt: 'Continue the same issue.' });
    await waitFor(() => starts.length === 4);
    assert.equal(starts[3].run.provider, 'claude'); assert.equal(starts[3].cwd, originalWorktree); assert.equal(starts[3].run.sessionId, undefined);
  } finally { await desk.shutdown(); store.close(); }
});

test('a second server cannot reset active runs in the same data directory', async () => {
  const directory = temporary('lock'), app = await createApp({ dataDirectory: directory, port: 0 });
  try {
    app.store.put('run', 'active', { id: 'active', state: 'running' });
    await assert.rejects(createApp({ dataDirectory: directory, port: 0 }), /already running/);
    assert.equal(app.store.get('run', 'active').state, 'running');
  } finally { await app.close(); }
});

test('native elicitation survives HTTP sessions and the installed stdio proxy', async () => {
  const directory = temporary('elicitation'), app = await createApp({ dataDirectory: directory, port: 0 });
  const clients = [];
  try {
    // An agent running the tests has its own Rex Desk token in its environment; the proxy must read this test server's token instead.
    const transports = [
      new StreamableHTTPClientTransport(new URL(app.address + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${app.store.token}` } } }),
      new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/stdio.js')], env: { ...process.env, REX_DESK_TOKEN: '', REX_AGENT_TOKEN: '', REX_DATA_DIR: directory, REX_DESK_URL: app.address + '/mcp' }, stderr: 'pipe' }),
    ];
    for (const transport of transports) {
      const client = new Client({ name: 'elicitation-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
      client.setRequestHandler(ElicitRequestSchema, async request => {
        assert.equal(request.params.message, 'Choose a base branch.');
        return { action: 'accept', content: { answer: 'develop' } };
      });
      clients.push(client); await client.connect(transport);
      const conversation = JSON.parse((await client.callTool({ name: 'desk_connect', arguments: { name: 'Synthetic external conversation' } })).content[0].text);
      const externalRunId = conversation.runId;
      assert.equal(app.desk.run(externalRunId).external, true);
      await client.callTool({ name: 'desk_message', arguments: { runId: externalRunId, text: 'External conversation is connected.' } });
      const question = JSON.parse((await client.callTool({ name: 'desk_ask', arguments: { runId: externalRunId, message: 'Choose the target.', wait: false } })).content[0].text);
      app.desk.answer(question.questionId, { action: 'accept', content: { answer: 'release' } });
      const answer = JSON.parse((await client.callTool({ name: 'desk_question', arguments: { questionId: question.questionId } })).content[0].text);
      assert.equal(answer.answer.content.answer, 'release');
      await client.callTool({ name: 'desk_disconnect', arguments: { runId: externalRunId } });
      assert.equal(app.desk.run(externalRunId).state, 'finished');
      const result = await client.callTool({ name: 'desk_elicit', arguments: { message: 'Choose a base branch.' } });
      assert.equal(result.isError, undefined, result.content[0].text);
      assert.deepEqual(JSON.parse(result.content[0].text), { action: 'accept', content: { answer: 'develop' } });
    }
  } finally { for (const client of clients) await client.close(); await app.close(); }
});

test('missing evidence or a target of master is told, never refused', async () => {
  const store = new Store(temporary('publish')); const desk = new Desk(store, { root: temporary('publish-root') });
  const notes = []; desk.missingEvidence = () => 'a browser recording';
  for (const state of ['needs_evidence', 'running']) {
    const run = { id: 'pub-1', state, worktree: '', targetBranch: 'global/develop', baseCommit: 'abc' };
    desk.pullRequests = () => []; desk.targetHolder = async () => true;
    await desk.publishChecks(run, 'master').catch(error => notes.push(error.message));
  }
  assert.ok(!notes.some(note => /cannot open a pull request yet|Finish verified work|never opens a pull request/.test(note)), notes.join('\n'));
  store.close();
});

test('a run opens a pull request into a second branch, built from that branch', async () => {
  const directory = temporary('release'), origin = path.join(directory, 'origin.git'), repository = path.join(directory, 'repo'), tree = path.join(directory, 'tree');
  mkdirSync(repository); mkdirSync(origin);
  await git(repository, ['init', '-b', 'global/develop']);
  await git(repository, ['config', 'user.name', 'Test']); await git(repository, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(repository, 'app.txt'), 'first\n'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'First']);
  await git(repository, ['branch', 'global/release']);
  writeFileSync(path.join(repository, 'app.txt'), 'second\n'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'Second']);
  await git(origin, ['init', '--bare', '-b', 'global/develop']);
  await git(repository, ['remote', 'add', 'origin', origin]);
  await git(repository, ['push', '-q', 'origin', 'global/develop', 'global/release']);
  await git(repository, ['worktree', 'add', '-q', '-b', 'temp/rex/fix/search', tree, 'HEAD']);
  const baseCommit = await git(tree, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(tree, 'fix.txt'), 'the fix\n'); await git(tree, ['add', '.']); await git(tree, ['commit', '-m', 'fix(search): limit the period']);

  const store = new Store(temporary('release-store'));
  store.saveConfig({ ...defaults, repositories: [{ id: 'repository-1', name: 'flow-was', path: repository, baseBranch: 'global/develop', targetBranch: 'global/develop' }] });
  const desk = new Desk(store, { root: temporary('release-root') }), created = [];
  desk.gh = async args => { created.push(args); return { stdout: `https://github.com/x/y/pull/${created.length}\n` }; };
  store.put('task', 'task-1', { id: 'task-1', title: 'Search limit', active: true, sourceName: 'Morningmate', externalId: '32099' });
  store.put('run', 'run-1', { id: 'run-1', role: 'worker', state: 'ready_for_review', taskId: 'task-1', repositoryId: 'repository-1',
    branch: 'temp/rex/fix/search', worktree: tree, baseCommit, targetBranch: 'global/develop', title: 'fix(search): limit the period',
    verification: { passed: true, command: 'npm test', fingerprint: await fingerprint(tree) }, createdAt: now() });

  const develop = await desk.publish('run-1', { approved: true });
  assert.equal(develop.url, 'https://github.com/x/y/pull/1');
  assert.equal(created[0][created[0].indexOf('--head') + 1], 'temp/rex/fix/search', 'a pull request into develop comes straight from the run branch');

  // Rex asks in chat for a release pull request. The browser proof is incomplete, but he already approved these exact
  // commits into develop, so the second pull request is not refused. develop is ahead of release, so the branch is rebuilt.
  store.put('run', 'run-1', { ...store.get('run', 'run-1'), state: 'needs_evidence', checks: { testsPassed: true, recordedVideo: false, browserAssertionPassed: false } });
  const release = await desk.publish('run-1', { approved: true, targetBranch: 'global/release' });
  const head = created[1][created[1].indexOf('--head') + 1];
  assert.equal(head, 'temp/rex/fix/search-for-release');
  assert.equal(created[1][created[1].indexOf('--base') + 1], 'global/release');
  assert.equal(await git(origin, ['rev-list', '--count', `global/release..${head}`]), '1', 'only the commit of this run reaches release');
  assert.deepEqual(store.get('run', 'run-1').pullRequests.map(item => item.target), ['global/develop', 'global/release']);
  assert.equal(store.get('run', 'run-1').prUrl, release.url);
  assert.ok(!existsSync(path.join(store.directory, 'publish', slug(head, 120))), 'the branch Rex Desk built is removed once the pull request exists');
  await assert.rejects(desk.publish('run-1', { approved: true, targetBranch: 'global/release' }), /already open/);
  writeFileSync(path.join(tree, 'fix.txt'), 'edited after the pull requests\n');
  await assert.rejects(desk.publish('run-1', { approved: true, targetBranch: 'global/hotfix' }), /not committed yet/, 'uncommitted edits are the one thing that waits');
  store.close();
});

test('work done in a group chat publishes: its worktree becomes a run, and the person telling the agent to open the PR is the yes', async () => {
  const directory = temporary('room-pr'), origin = path.join(directory, 'origin.git'), repository = path.join(directory, 'repo'), tree = path.join(directory, 'repo-worktrees', '49760');
  mkdirSync(repository); mkdirSync(origin);
  await git(repository, ['init', '-b', 'global/release']);
  await git(repository, ['config', 'user.name', 'Test']); await git(repository, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(repository, 'app.txt'), 'first\n'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'First']);
  await git(origin, ['init', '--bare', '-b', 'global/release']);
  await git(repository, ['branch', 'global/develop']);
  await git(repository, ['remote', 'add', 'origin', origin]); await git(repository, ['push', '-q', 'origin', 'global/release', 'global/develop']);
  await git(repository, ['worktree', 'add', '-q', '-b', 'temp/rex/49760-subtask', tree, 'HEAD']);
  writeFileSync(path.join(tree, 'fix.txt'), 'the fix\n'); await git(tree, ['add', '.']); await git(tree, ['commit', '-m', 'fix: keep the parent link']);
  const store = new Store(temporary('room-pr-store'));
  store.saveConfig({ ...defaults, repositories: [{ id: 'repository-1', name: 'flow-was', path: repository, baseBranch: 'global/release', targetBranch: 'global/release' }] });
  const desk = new Desk(store, { root: temporary('room-pr-root') }), created = [];
  desk.gh = async args => { created.push(args); return { stdout: 'https://github.com/x/y/pull/7\n' }; };
  store.put('task', 'task-1', { id: 'task-1', title: 'Subtask parent link disappears', active: true, sourceName: 'Morningmate', externalId: '49760', roomWork: { agentId: 'bot', roomId: 'room-1', at: now() } });
  store.put('run', 'room-session', { id: 'room-session', role: 'specialist', specialistId: 'bot', roomAgent: 'bot', roomOf: 'room-1', state: 'running', createdAt: now() });
  desk.personAskedToPublish = () => true;
  const result = await desk.requestPublish('room-session', { worktree: tree });
  assert.equal(result.url, 'https://github.com/x/y/pull/7');
  assert.equal(created[0][created[0].indexOf('--head') + 1], 'temp/rex/49760-subtask');
  assert.equal(created[0][created[0].indexOf('--base') + 1], 'global/release');
  const adopted = store.list('run').find(item => item.adoptedFrom === path.resolve(tree));
  assert.equal(adopted.taskId, 'task-1', 'the task given in the room'); assert.equal(adopted.state, 'published');
  desk.personAskedToPublish = () => false; let asked = false;
  store.saveConfig({ ...store.config(), autonomy: false });
  desk.ask = async () => { asked = true; return { action: 'decline' }; };
  assert.deepEqual(await desk.requestPublish('room-session', { worktree: tree, targetBranch: 'global/develop' }), { declined: true });
  assert.ok(asked, 'without the person asking in the room, the dashboard asks');
  store.close();
});

test('a connection syncs the issues of every account it watches, not only the first', async () => {
  const store = new Store(temporary('accounts')), filters = [];
  store.saveConfig({ ...defaults, repositories: [], sources: [{ ...source, apiKey: 'fixture-key', userId: ' 1l3oth@flow.team , globalDev@flow.team ,1l3oth@flow.team ' }] });
  assert.equal(store.config().sources[0].userId, '1l3oth@flow.team, globalDev@flow.team', 'the saved list is trimmed and deduplicated');
  assert.deepEqual(accountList('A@flow.team, b@flow.team;a@flow.team'), ['A@flow.team', 'b@flow.team'], 'the tracker spelling is kept; only the comparison ignores case');

  const assignees = { 10: '1l3oth@flow.team', 11: 'globalDev@flow.team', 12: 'someone@flow.team' };
  const fetcher = async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('/columns/status')) return jsonResponse({ options: [{ id: '1', name: 'In progress' }] });
    if (url.pathname.endsWith('/columns')) return jsonResponse({ columns: [{ columnSrno: '7', defaultColumnType: 'WORKER', columnName: 'Assignee' }] });
    if (url.pathname.endsWith('/tasks/filter')) {
      const wanted = JSON.parse(url.searchParams.get('filterRecords'))[0].FILTER_DATA;
      filters.push(wanted);
      const posts = Object.entries(assignees).filter(([, owner]) => owner === wanted)
        .map(([postId]) => ({ postId, taskId: `10${postId}`, taskStatus: 'REQUEST', title: `Issue ${postId}`, workers: [{ workerId: assignees[postId] }] }));
      return jsonResponse({ tasks: posts, hasNext: false, lastCursor: -1 });
    }
    return jsonResponse({});
  };
  const result = await new Sources(store, { fetcher }).sync();
  assert.deepEqual(filters, ['1l3oth@flow.team', 'globalDev@flow.team'], 'each account is filtered for on its own');
  assert.equal(result[0].count, 2, 'both accounts bring in their issues');
  assert.equal(result[0].verified, 2);
  assert.equal(result[0].account, '1l3oth@flow.team, globalDev@flow.team');
  assert.deepEqual(store.list('task').map(task => task.title).sort(), ['Issue 10', 'Issue 11']);
  store.close();
});

test('account usage is kept per account from what Claude Code and Codex report', async () => {
  const store = new Store(temporary('usage')); const desk = new Desk(store, { root: temporary('usage-root') });
  desk.recordUsage('claude', 'third', { rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1794400000, status: 'allowed' });
  desk.recordUsage('claude', 'third', { rateLimitType: 'seven_day', utilization: 0.1, resetsAt: 1794900000 });
  desk.recordUsage('codex', 'main', { codex: { primary: { usedPercent: 63, windowDurationMins: 300, resetsAt: 1794401000 }, secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1794950000 } } });
  const claude = store.get('usage', 'claude:third'), codex = store.get('usage', 'codex:main');
  assert.equal(claude.windows.five_hour.used, 42); assert.equal(claude.windows.five_hour.resetsAt, 1794400000000);
  assert.equal(claude.windows.seven_day.used, 10);
  assert.equal(codex.windows.five_hour.used, 63); assert.equal(codex.windows.seven_day.used, 20);
  assert.ok(desk.snapshot().usage.length === 2);
  store.close();
});

test('the person unsends their own message in a personal chat; a queued one is never seen', async () => {
  const store = new Store(temporary('unsend')); const desk = new Desk(store, { root: temporary('unsend-root') });
  store.put('run', 'chat-1', { id: 'chat-1', role: 'specialist', state: 'queued', queued: ['typo message'], createdAt: now() });
  store.event('chat-1', 'human-message', { text: 'typo message' }, true);
  store.event('chat-1', 'agent-text', { text: 'an agent reply' }, true);
  const [mine, theirs] = store.events('chat-1', { visible: true });
  assert.throws(() => desk.unsend('chat-1', theirs.sequence), /Only your own messages/);
  assert.deepEqual(desk.unsend('chat-1', mine.sequence), { unsent: true, seen: false });
  assert.deepEqual(store.get('run', 'chat-1').queued, []);
  assert.deepEqual(store.events('chat-1', { visible: true }).map(event => event.kind), ['agent-text']);
  store.close();
});

test('a /skill typed in a chat asks the agent to run that skill; Rex Desk commands and plain text pass through', async () => {
  const { skillCall } = await import('../src/coordinator.js');
  assert.match(skillCall('/teach sql injection in my company'), /The person ran \/teach with: sql injection in my company\.\nRun it now: if a skill has that name, use the Skill tool \(skill "teach"[\s\S]*find teach\.md/);
  assert.equal(skillCall('/clear'), '/clear');
  assert.equal(skillCall('hello /teach'), 'hello /teach');
  assert.equal(skillCall('/'), '/');
});

test('a project set to push straight, or the person saying "no PR", pushes the commits onto the branch without a pull request', async () => {
  const directory = temporary('direct'), origin = path.join(directory, 'origin.git'), repository = path.join(directory, 'repo'), tree = path.join(directory, 'tree');
  mkdirSync(repository); mkdirSync(origin);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Test']); await git(repository, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(repository, 'app.txt'), 'first\n'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'First']);
  await git(origin, ['init', '--bare', '-b', 'main']);
  await git(repository, ['remote', 'add', 'origin', origin]); await git(repository, ['push', '-q', 'origin', 'main']);
  await git(repository, ['worktree', 'add', '-q', '-b', 'temp/rex/fix', tree, 'HEAD']);
  const baseCommit = await git(tree, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(tree, 'fix.txt'), 'fix\n'); await git(tree, ['add', '.']); await git(tree, ['commit', '-m', 'fix: it']);
  const store = new Store(temporary('direct-store'));
  store.saveConfig({ ...defaults, repositories: [{ id: 'repo-1', name: 'studybook', path: repository, baseBranch: 'main', targetBranch: 'main', push: 'direct' }] });
  const desk = new Desk(store, { root: temporary('direct-root') }); let prs = 0;
  desk.gh = async () => { prs += 1; return { stdout: 'https://github.com/x/y/pull/1\n' }; };
  store.put('task', 'task-1', { id: 'task-1', title: 'Fix', active: true, sourceName: 'Rex Desk', externalId: '1' });
  store.put('run', 'run-1', { id: 'run-1', role: 'worker', state: 'ready_for_review', taskId: 'task-1', repositoryId: 'repo-1', branch: 'temp/rex/fix', worktree: tree, baseCommit, targetBranch: 'main', createdAt: now() });
  const result = await desk.requestPublish('run-1', {});
  assert.deepEqual(result, { pushed: true, target: 'main', commits: 1 });
  assert.equal(prs, 0, 'no pull request');
  assert.equal(await git(origin, ['log', '-1', '--format=%s', 'main']), 'fix: it');
  assert.equal(store.get('run', 'run-1').state, 'published');
  store.saveConfig({ ...store.config(), repositories: [{ ...store.config().repositories[0], push: 'pr' }] });
  assert.equal(store.config().repositories[0].push, 'pr');
  await assert.rejects(desk.requestPublish('run-1', { direct: true }), /needs the person to say so/);
  store.close();
});

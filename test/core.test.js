import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now } from '../src/store.js';
import { Sources, normalizeTask, taskAssignees, postContent, matchesTaskStatus } from '../src/providers.js';
import { Desk, validateAnswer } from '../src/coordinator.js';
import { codexAnswer } from '../src/runners.js';
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
  store.put('task', task.id, { ...task, category: 'Regression' });
  await sources.sync(); assert.equal(store.get('task', task.id).category, 'Regression');
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

test('Codex approval, native elicitation, and question responses preserve wire schemas', () => {
  assert.deepEqual(codexAnswer('item/commandExecution/requestApproval', {}, { action: 'decline' }), { decision: 'decline' });
  assert.deepEqual(codexAnswer('mcpServer/elicitation/request', {}, { action: 'accept', content: { answer: 'release' } }), { action: 'accept', content: { answer: 'release' }, _meta: null });
  assert.deepEqual(codexAnswer('item/tool/requestUserInput', { questions: [{ id: 'base' }] }, { action: 'accept', content: { base: 'develop' } }), { answers: { base: { answers: ['develop'] } } });
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
      assert.equal((await client.callTool({ name: 'desk_task', arguments: { taskId: 'task-b' } })).isError, true);
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

test('a worker cannot finish or publish without test proof', async () => {
  const store = new Store(temporary('proof')); const desk = new Desk(store, { root: temporary('root') });
  store.put('run', 'run-1', { id: 'run-1', state: 'needs_evidence', title: 'Unverified task' });
  await assert.rejects(desk.publish('run-1', { approved: true }), /cannot open a pull request yet/);
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
    await desk.startTask({ taskId: 'task-2', provider: 'codex' });
    const third = await desk.startTask({ taskId: 'task-3', provider: 'claude' });
    await waitFor(() => starts.length === 2);
    assert.deepEqual(starts.map(item => item.run.provider).sort(), ['claude', 'codex']);
    assert.equal(desk.run(third.id).state, 'queued');
    assert.notEqual(starts[0].cwd, starts[1].cwd); assert.notEqual(starts[0].run.port, starts[1].run.port);
    const originalWorktree = desk.run(first.id).worktree;
    starts.find(item => item.run.id === first.id).release(); await waitFor(() => starts.length === 3);
    for (const runId of [...desk.live.keys()]) await desk.stop(runId);
    await waitFor(() => desk.live.size === 0);
    await desk.resume(first.id, { provider: 'codex', prompt: 'Continue the same issue.' });
    await waitFor(() => starts.length === 4);
    assert.equal(starts[3].run.provider, 'codex'); assert.equal(starts[3].cwd, originalWorktree); assert.equal(starts[3].run.sessionId, undefined);
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
    const transports = [
      new StreamableHTTPClientTransport(new URL(app.address + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${app.store.token}` } } }),
      new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/stdio.js')], env: { ...process.env, REX_DATA_DIR: directory, REX_DESK_URL: app.address + '/mcp' }, stderr: 'pipe' }),
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

test('a pull request is refused before the human is asked, not after they approve', async () => {
  const store = new Store(temporary('publish')), asked = [];
  const desk = new Desk(store, { root: temporary('publish-root') });
  store.put('task', 'task-1', { id: 'task-1', title: 'Search limit', active: true, sourceName: 'Morningmate', externalId: '32099' });
  const base = { id: 'pub-1', role: 'worker', taskId: 'task-1', branch: 'temp/rex/fix/search', worktree: temporary('publish-tree'), targetBranch: 'global/develop', baseCommit: 'abc', createdAt: now() };
  desk.ask = async request => { asked.push(request); return { action: 'accept' }; };

  store.put('run', 'pub-1', { ...base, state: 'needs_evidence', checks: { testsPassed: true, recordedVideo: false, browserAssertionPassed: false } });
  await assert.rejects(desk.requestPublish('pub-1', {}), /no browser recording was made, no browser assertion matches the current files/);
  assert.equal(asked.length, 0, 'The human is never asked to approve a pull request that would then be refused');

  store.put('run', 'pub-1', { ...base, state: 'running' });
  await assert.rejects(desk.requestPublish('pub-1', {}), /This run is running; commit the fix, run desk_verify/);
  assert.equal(asked.length, 0);

  store.close();
});

test('the session a follow-up reopens comes from the provider log, and a provider switch drops it', async () => {
  const store = new Store(temporary('resume')), directory = temporary('resume-logs');
  const desk = new Desk(store, { root: temporary('resume-root'), runnerFactory: () => ({ start: async () => ({ status: 'completed' }), interrupt: async () => {}, close() {} }) });
  const file = path.join(directory, '7c3a8d71-d78d-409a-9a84-91fb162c1be3.jsonl');
  writeFileSync(file, '{}\n');
  const run = { id: 'r1', role: 'worker', provider: 'claude', state: 'needs_evidence', worktree: directory, mirror: { file, offset: 2 } };

  assert.equal(desk.agentSessionId(run), '7c3a8d71-d78d-409a-9a84-91fb162c1be3');
  assert.equal(desk.agentSessionId({ ...run, mirror: { file: path.join(directory, 'rollout-2026-10-26T07-12-33-7c3a8d71-d78d-409a-9a84-91fb162c1be3.jsonl') } }), '', 'A log that is gone cannot be reopened');
  writeFileSync(path.join(directory, 'rollout-2026-10-26T07-12-33-7c3a8d71-d78d-409a-9a84-91fb162c1be3.jsonl'), '{}\n');
  assert.equal(desk.agentSessionId({ ...run, provider: 'codex', mirror: { file: path.join(directory, 'rollout-2026-10-26T07-12-33-7c3a8d71-d78d-409a-9a84-91fb162c1be3.jsonl') } }), '7c3a8d71-d78d-409a-9a84-91fb162c1be3');
  assert.equal(desk.agentSessionId({ ...run, mirror: undefined }), '', 'A run with no recorded log starts fresh');

  store.put('run', 'r1', run);
  await desk.resume('r1', { prompt: 'try the dev server' });
  assert.deepEqual(store.get('run', 'r1').mirror, { file, offset: 2 }, 'The same provider keeps its session');
  await settle();
  store.put('run', 'r1', { ...run, state: 'needs_evidence' });
  await desk.resume('r1', { provider: 'codex', prompt: 'try again' });
  assert.equal(store.get('run', 'r1').mirror, undefined, 'The other CLI cannot reopen it');
  await settle(); await desk.shutdown(); store.close();
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

  // Rex asks in chat for a release pull request. develop sits ahead of release, so the branch is rebuilt on release itself.
  const release = await desk.publish('run-1', { approved: true, targetBranch: 'global/release' });
  const head = created[1][created[1].indexOf('--head') + 1];
  assert.equal(head, 'temp/rex/fix/search-for-release');
  assert.equal(created[1][created[1].indexOf('--base') + 1], 'global/release');
  assert.equal(await git(origin, ['rev-list', '--count', `global/release..${head}`]), '1', 'only the commit of this run reaches release');
  assert.deepEqual(store.get('run', 'run-1').pullRequests.map(item => item.target), ['global/develop', 'global/release']);
  assert.equal(store.get('run', 'run-1').prUrl, release.url);
  assert.ok(!existsSync(path.join(store.directory, 'publish', slug(head, 120))), 'the branch Rex Desk built is removed once the pull request exists');
  await assert.rejects(desk.publish('run-1', { approved: true, targetBranch: 'global/release' }), /already open/);
  store.close();
});

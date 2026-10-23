import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { AgentProfiles, discoverProfiles, parseClaudeStatus, parseCodexStatus, profileEnvironment } from '../src/agents.js';
import { normalizeTask, subtaskRecord, taskComments, uniqueImages, Sources } from '../src/providers.js';
import { cachedTaskImage } from '../src/images.js';
import { setupPrompt } from '../src/setup-prompt.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const signedIn = folder => async (command, args, env) => ({ code: 0, stderr: '',
  stdout: JSON.stringify({ loggedIn: env.CLAUDE_CONFIG_DIR === folder, authMethod: 'claude.ai', email: 'rex@example.invalid', subscriptionType: 'max' }) });

test('agent profiles are discovered from home and Orca folders and selected per provider', () => {
  const home = temporary('home'), appData = temporary('appdata');
  mkdirSync(path.join(home, '.claude-third-profile')); mkdirSync(path.join(home, '.codex-work'));
  mkdirSync(path.join(appData, 'orca', 'claude-profiles', '6090b7ff-test', 'home'), { recursive: true });
  const claude = discoverProfiles('claude', { env: {}, roots: { home, appData } });
  assert.deepEqual(claude.map(item => item.origin), ['default', 'home', 'orca']);
  assert.match(claude[2].label, /^Orca profile 6090b7ff/);
  assert.deepEqual(discoverProfiles('codex', { env: {}, roots: { home, appData } }).map(item => item.origin), ['default', 'home']);
  assert.equal(profileEnvironment('claude', 'C:\\profile', { CLAUDE_CONFIG_DIR: 'C:\\other' }).CLAUDE_CONFIG_DIR, path.resolve('C:\\profile'));
  assert.equal(profileEnvironment('claude', '', { CLAUDE_CONFIG_DIR: 'C:\\other' }).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(parseClaudeStatus('{"loggedIn":false}').loggedIn, false);
  assert.equal(parseCodexStatus('Logged in using ChatGPT', 0).method, 'ChatGPT');
  assert.equal(parseCodexStatus('Not logged in', 1).loggedIn, false);
});

test('profile choice persists, and a signed-out profile fails before any worktree or agent turn', async () => {
  const directory = temporary('profiles'), signed = temporary('signed'), signedOut = temporary('signed-out');
  const store = new Store(directory);
  const repository = temporary('repository');
  store.saveConfig({ ...defaults, sources: [], repositories: [{ id: 'repo', name: 'repo', path: repository, baseBranch: 'develop' }], agentProfiles: { claude: signedOut, codex: null } });
  const agents = new AgentProfiles(store, { run: signedIn(signed) });
  await assert.rejects(agents.ensureSignedIn('claude'), /is not signed in\. Open Setup/);
  store.saveConfig({ ...store.publicConfig(), agentProfiles: { claude: signed, codex: null } });
  agents.invalidate();
  assert.equal((await agents.ensureSignedIn('claude')).account, 'rex@example.invalid');
  assert.throws(() => store.saveConfig({ ...store.publicConfig(), agentProfiles: { claude: path.join(signed, 'missing') } }), /does not exist/);
  store.close();

  const deskStore = new Store(temporary('preflight'));
  deskStore.saveConfig({ ...defaults, sources: [], repositories: [{ id: 'repo', name: 'repo', path: repository, baseBranch: 'develop' }], agentProfiles: { claude: signedOut, codex: null } });
  deskStore.put('task', 'task-1', { id: 'task-1', externalId: '1', title: 'Issue', source: 'morningmate', active: true, repositoryId: 'repo' });
  const desk = new Desk(deskStore, { root: process.cwd(), agentCommand: signedIn(signed) });
  const run = await desk.startTask({ taskId: 'task-1' });
  for (let attempt = 0; attempt < 50 && !['failed', 'stopped'].includes(deskStore.get('run', run.id).state); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const failed = deskStore.get('run', run.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /not signed in.*No agent turn was started/);
  assert.equal(failed.worktree, undefined);
  assert.deepEqual(readdirSync(desk.worktreeRoot).filter(name => name.includes('task')), []);
  await desk.shutdown(); deskStore.close();
});

test('task columns give readable titles, properties, comments, and one copy of each screenshot', () => {
  const source = { id: 'source', type: 'morningmate', name: 'Morningmate' };
  const row = { taskId: '663654', postId: '1434439', upTaskId: '-1', content: '', projectTitle: '[QA] Morningmate', columns: [
    { columnId: '12', columnType: 'STATUS', defaultColumnType: 'STATUS', columnData: [{ optionName: 'Request', customColumnData: '5576', optionCategory: '0' }] },
    { columnId: '985', columnType: 'OPTION', defaultColumnType: '', columnData: [{ optionName: 'Language' }] },
    { columnId: '1', columnType: 'USER', defaultColumnType: 'WORKER_ID', columnData: [{ userName: 'Rex', customColumnData: 'rex@example.invalid' }] },
    { columnId: '6', columnType: 'TEXT', defaultColumnType: 'TASK_NM', columnData: [{ customColumnData: 'Rename the bulk upload button' }] },
    { columnId: '2', columnType: 'USER', defaultColumnType: 'RGSR_ID', columnData: [{ userName: 'Reporter Name' }] },
    { columnId: '3', columnType: 'DATE', defaultColumnType: 'RGSN_DTTM', columnData: [{ optionName: 'PAST', customColumnData: '20260219024251' }] },
    { columnId: '5', columnType: 'NUMBER', defaultColumnType: 'TASK_NUM', columnData: [{ customColumnData: '39349' }] }] };
  const task = normalizeTask(source, '257572', row, { ...row, title: '', content: '' }, { names: { 985: 'Issue Type' } });
  assert.equal(task.title, 'Rename the bulk upload button');
  assert.equal(task.taskNumber, '39349');
  assert.equal(task.reporter, 'Reporter Name');
  assert.equal(task.createdAt, '2026-02-19 02:42');
  assert.deepEqual(task.fields, [{ name: 'Issue Type', value: 'Language' }]);
  assert.deepEqual(task.assignees, ['rex@example.invalid']);

  const comps = text => JSON.stringify({ COMPS: [{ COMP_TYPE: 'TEXT', COMP_DETAIL: { CONTENTS: text } },
    { COMP_TYPE: 'IMAGE', COMP_DETAIL: { ATCH_URL: 'https://morningmate.com/flowImg/a.png', THUM_IMG_PATH: 'https://morningmate.com/flowImg/a_thumb.png', WIDTH: '450' } }] });
  const nested = subtaskRecord({ taskId: '9', taskName: 'Child', content: comps('- OS: Mac app 3.0.1\\n- Account test@example.invalid') }, { title: 'Parent issue', content: comps('Parent body') });
  assert.ok(!nested.content.description.includes('COMPS'));
  assert.match(nested.content.description, /^- OS: Mac app 3\.0\.1\n- Account test@example\.invalid\n\nParent issue: Parent issue\nParent body$/);
  assert.equal(nested.content.contentImages.length, 1);
  assert.equal(uniqueImages([{ url: 'https://x/a.png?1', name: 'Issue screenshot' }], [{ url: 'https://x/a.png?2', name: 'image.png' }])[0].name, 'image.png');
  const comments = taskComments([
    { RGSR_NM: 'QA', RGSN_DTTM: '20260914014141', SYSTEM_REMARK_YN: 'N', CNTN: comps('Still happens on 3.0.2'), REMARK_IMG_ATCH_REC: [] },
    { RGSR_NM: 'Lead', SYSTEM_REMARK_YN: 'Y', REMARK_CNTN: "'A' → 'B' Assignee has been updated.", CNTN: "''A'' → ''B''" },
    { RGSR_NM: 'Gone', DELETE_YN: 'Y', CNTN: 'deleted' }]);
  assert.deepEqual(comments.map(comment => [comment.author, comment.system, comment.text]), [['QA', false, 'Still happens on 3.0.2'], ['Lead', true, "'A' → 'B' Assignee has been updated."]]);
});

test('sync keeps loaded issue details until the tracker reports a newer edit', async () => {
  const store = new Store(temporary('detail-cache'));
  const source = { id: 'source', name: 'Morningmate', type: 'morningmate', baseUrl: 'https://api.morningmate.com', projectIds: ['1'], userId: 'rex@example.invalid', statusMap: {} };
  store.saveConfig({ ...defaults, sources: [{ ...source, apiKey: 'key' }], repositories: [] });
  let edited = '20260101010101', detailCalls = 0;
  const row = () => ({ taskId: '7', postId: '70', upTaskId: '-1', content: '', columns: [
    { columnId: '1', columnType: 'USER', defaultColumnType: 'WORKER_ID', columnData: [{ customColumnData: 'rex@example.invalid' }] },
    { columnId: '12', columnType: 'STATUS', defaultColumnType: 'STATUS', columnData: [{ optionName: 'Request', optionCategory: '0' }] },
    { columnId: '6', columnType: 'TEXT', defaultColumnType: 'TASK_NM', columnData: [{ customColumnData: 'Preview is blank' }] },
    { columnId: '4', columnType: 'DATE', defaultColumnType: 'EDTR_DTTM', columnData: [{ customColumnData: edited }] }] });
  const fetcher = async value => {
    const url = new URL(value);
    let data;
    if (url.pathname.endsWith('/columns/status')) data = { columns: [] };
    else if (url.pathname.endsWith('/columns')) data = { columns: [{ columnSrno: '1', defaultColumnType: 'WORKER_ID', columnName: '' }] };
    else if (url.pathname.endsWith('/tasks/filter')) data = { tasks: [row()], hasNext: false };
    else if (url.pathname.endsWith('/posts/70')) { detailCalls++; data = { post: { postId: '70', title: 'Preview is blank', content: JSON.stringify({ COMPS: [{ COMP_TYPE: 'TEXT', COMP_DETAIL: { CONTENTS: `Body ${detailCalls}` } }] }), remarks: [], imageAttachments: [] } }; }
    else return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });
  };
  const sources = new Sources(store, { fetcher });
  await sources.sync();
  const id = 'source:1:7';
  assert.equal(store.get('task', id).title, 'Preview is blank');
  assert.equal((await sources.taskDetail(id)).description, 'Body 1');
  await sources.sync();
  assert.equal(store.get('task', id).detailLoaded, true);
  assert.equal(store.get('task', id).description, 'Body 1');
  edited = '20260202020202';
  await sources.sync();
  assert.equal(store.get('task', id).detailLoaded, false);
  assert.equal((await sources.taskDetail(id)).description, 'Body 2');
  assert.equal(detailCalls, 2);
  store.close();
});

test('task images are fetched only for addresses stored on that task and cached as verified images', async () => {
  const store = new Store(temporary('images'));
  const address = 'https://morningmate.com/flowImg/a.png';
  store.put('task', 'task', { id: 'task', images: [{ url: address, name: 'a.png' }] });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  let requests = 0;
  const fetcher = async url => {
    requests++;
    if (String(url) === address) return new Response(null, { status: 302, headers: { location: 'https://bucket.example.invalid/a.png?signature=x' } });
    return new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } });
  };
  await assert.rejects(cachedTaskImage(store, 'task', 'https://169.254.169.254/latest', { fetcher }), /not part of the selected task/);
  const file = await cachedTaskImage(store, 'task', address, { fetcher });
  assert.match(file, /\.png$/);
  await cachedTaskImage(store, 'task', address, { fetcher });
  assert.equal(requests, 2);
  store.put('task', 'html', { id: 'html', images: [{ url: 'https://morningmate.com/flowImg/b.png' }] });
  await assert.rejects(cachedTaskImage(store, 'html', 'https://morningmate.com/flowImg/b.png', { fetcher: async () => new Response('<html>') }), /not a supported image/);
  store.close();
});

test('AI setup prompts configure local stdio without credentials and use a placeholder for cloud clients', () => {
  const local = setupPrompt({ root: 'F:\\rex-desk', dataDirectory: 'F:\\rex-desk\\.local', mcpUrl: 'http://127.0.0.1:4317/mcp', profiles: { claude: 'C:\\Users\\rex\\.claude-third-profile' }, node: 'C:\\node\\node.exe' });
  assert.ok(local.includes('claude mcp add --scope user rex_desk -- "C:\\node\\node.exe" "F:\\rex-desk\\src\\stdio.js"'));
  assert.ok(local.includes('CLAUDE_CONFIG_DIR="C:\\Users\\rex\\.claude-third-profile"'));
  assert.match(local, /No API key or token is needed/);
  const remote = setupPrompt({ target: 'remote', root: 'F:\\rex-desk', dataDirectory: 'F:\\rex-desk\\.local', mcpUrl: 'http://127.0.0.1:4317/mcp' });
  assert.match(remote, /Bearer \$\{REX_DESK_TOKEN\}/);
  assert.doesNotMatch(remote + local, /[A-Za-z0-9_-]{43}/);
});

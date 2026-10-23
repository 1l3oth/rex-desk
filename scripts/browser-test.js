import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server.js';
import { git } from '../src/processes.js';

const workspace = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-acceptance-'));
const repository = path.join(workspace, 'source'); mkdirSync(repository);
const screenshots = path.resolve('.impeccable/review'); mkdirSync(screenshots, { recursive: true });
const qa = path.resolve('.local/qa'); mkdirSync(qa, { recursive: true });
writeFileSync(path.join(repository, 'page.html'), '<!doctype html><html><title>QA fixture</title><h1>Preview is blank</h1><p id="result">Not fixed</p></html>');
writeFileSync(path.join(repository, 'preview.cjs'), `const http=require('http'),fs=require('fs');http.createServer((q,s)=>{s.setHeader('Content-Type','text/html');s.end(fs.readFileSync('page.html'))}).listen(Number(process.argv[2]),'127.0.0.1');`);
writeFileSync(path.join(repository, 'verify.cjs'), `const assert=require('assert/strict'),fs=require('fs');assert.ok(fs.readFileSync('page.html','utf8').includes('Preview works'));console.log('Regression assertion passed: preview content is visible.');`);
await git(repository, ['init', '-b', 'develop']);
await git(repository, ['config', 'user.name', 'Rex Desk Test']); await git(repository, ['config', 'user.email', 'qa@example.invalid']);
await git(repository, ['config', 'core.autocrlf', 'false']); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'Create synthetic QA fixture']);

const posts = [
  { postId: '40001', taskId: '4821', title: 'File preview stays blank after switching projects', taskStatus: 'REQUEST', category: 'Frontend' },
  { postId: '40002', taskId: '4822', title: 'Assignee filter resets when returning from a task', taskStatus: 'PROGRESS', category: 'Frontend' },
  { postId: '40003', taskId: '4823', title: 'Task due date shifts one day for overseas accounts', taskStatus: 'FEEDBACK', category: 'Backend' },
  { postId: '40004', taskId: '4824', title: 'Duplicate notifications after reconnecting chat', taskStatus: 'REQUEST', category: 'Realtime' },
];
// Synthetic tracker responses follow the live Morningmate shapes: filtered task rows, task columns, and COMPS rich text.
const keys = new Set(['synthetic-key-for-test-only', 'synthetic-key-typed-during-discovery']);
const image = 'https://morningmate.invalid/flowImg/preview.png';
const employees = [{ userId: 'rex@example.invalid', fullname: 'Rex Tester', email: 'rex@example.invalid', divisionName: 'QA' },
  ...Array.from({ length: 60 }, (_, index) => ({ userId: `person${index}@example.invalid`, fullname: `Synthetic Person ${index}`, email: `person${index}@example.invalid`, divisionName: index % 2 ? 'Platform' : 'Design' })),
  { userId: 'mina@example.invalid', fullname: 'Mina Park', email: 'mina@example.invalid', divisionName: 'Mobile' }];
const status = { REQUEST: ['Request', '0'], PROGRESS: ['Progress', '1'], FEEDBACK: ['Feedback', '4'] };
const row = post => ({ taskId: post.taskId, postId: post.postId, upTaskId: '-1', content: '', projectTitle: 'Synthetic QA acceptance project', columns: [
  { columnId: '12', columnType: 'STATUS', defaultColumnType: 'STATUS', columnData: [{ optionName: status[post.taskStatus][0], optionCategory: status[post.taskStatus][1] }] },
  { columnId: '1', columnType: 'USER', defaultColumnType: 'WORKER_ID', columnData: [{ userName: 'Rex Tester', customColumnData: 'rex@example.invalid' }] },
  { columnId: '6', columnType: 'TEXT', defaultColumnType: 'TASK_NM', columnData: [{ customColumnData: post.title }] },
  { columnId: '985', columnType: 'OPTION', defaultColumnType: '', columnData: [{ optionName: post.category }] },
  { columnId: '5', columnType: 'NUMBER', defaultColumnType: 'TASK_NUM', columnData: [{ customColumnData: post.taskId }] }] });
let releaseDirectory;
const fetcher = async (value, options = {}) => {
  const url = new URL(value);
  if (!keys.has(options.headers?.['x-flow-api-key'])) return new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unknown key' } }), { status: 401 });
  let data;
  if (url.pathname.endsWith('/employees/me')) data = { employee: employees[0] };
  else if (url.pathname.endsWith('/projects/participants')) { await new Promise(resolve => { releaseDirectory = resolve; setTimeout(resolve, 4000); }); data = { projects: [{ projectId: '317938', title: 'Synthetic QA acceptance project' }, { projectId: '500001', title: 'Unrelated synthetic project' }], hasNext: false }; }
  else if (url.pathname.endsWith('/user/employees')) data = { employees, hasNext: false };
  else if (url.pathname.endsWith('/columns/status')) data = { columns: [] };
  else if (url.pathname.endsWith('/projects/317938/columns')) data = { columns: [{ columnSrno: '1', defaultColumnType: 'WORKER_ID', columnName: '' }, { columnSrno: '985', defaultColumnType: '', columnName: 'Issue Type' }] };
  else if (url.pathname.endsWith('/projects/317938/tasks/filter')) data = { tasks: posts.map(row), hasNext: false };
  else {
    const post = posts.find(item => url.pathname.endsWith('/' + item.postId));
    if (!post) return new Response('{}', { status: 404 });
    data = { post: { postId: post.postId, projectId: '317938', title: post.title, connectUrl: 'https://morningmate.invalid/l/synthetic',
      content: JSON.stringify({ COMPS: [{ COMP_TYPE: 'TEXT', COMP_DETAIL: { CONTENTS: 'Synthetic acceptance-test issue.\nReproduce the blank preview, fix its content, and verify the result.' } },
        { COMP_TYPE: 'IMAGE', COMP_DETAIL: { ATCH_URL: image, ORCP_FILE_NM: 'preview.png', WIDTH: '2', HEIGHT: '2' } }] }),
      imageAttachments: [{ ATCH_URL: image, ORCP_FILE_NM: 'preview.png' }],
      remarks: [{ RGSR_NM: 'QA Lead', RGSN_DTTM: '20261020093000', SYSTEM_REMARK_YN: 'N', CNTN: 'Keep the selected project after switching.' },
        { RGSR_NM: 'QA Lead', RGSN_DTTM: '20261020090000', SYSTEM_REMARK_YN: 'Y', REMARK_CNTN: "'Team' → 'Rex Tester' Assignee has been updated." }],
      tasks: [{ TASK_SRNO: post.taskId, TASK_NM: post.title, STTS: status[post.taskStatus][1], TASK_COLUMN_REC: [] }] } };
  }
  return new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNgYGD4z8DAwMDAAAAEBQEAr8Q+0wAAAABJRU5ErkJggg==', 'base64');
const imageFetcher = async value => String(value) === image ? new Response(png) : new Response('', { status: 404 });
const agentCommand = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ loggedIn: true, authMethod: 'synthetic', email: 'agent@example.invalid' }) });

let app;
const failures = [];
const runnerFactory = options => ({
  async start() {
    const client = new Client({ name: 'synthetic-agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(options.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${options.token}` } } }));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
      const data = JSON.parse(result.content[0].text);
      if (result.isError) throw new Error(data.error); return data;
    };
    try {
      if (options.run.role === 'coordinator') {
        const tasks = await call('desk_tasks');
        await call('desk_categorize', { taskId: tasks[0].id, category: 'Frontend' });
        await call('desk_message', { text: 'Synthetic acceptance run: grouped the preview issue under Frontend and queued an isolated Claude worker.' });
        await call('desk_dispatch', { taskId: tasks[0].id, provider: 'claude' });
        return;
      }
      const task = (await call('desk_task', { taskId: options.run.taskId })).task;
      await call('desk_message', { text: 'Synthetic acceptance run: the preview issue is reproducible. I need one detail before changing the fixture.' });
      const question = await call('desk_ask', { message: 'Which behavior should this preview preserve?', fields: { answer: { type: 'string', title: 'Expected behavior' } }, required: ['answer'], wait: false });
      let response;
      for (let attempt = 0; attempt < 120; attempt++) {
        response = await call('desk_question', { questionId: question.questionId });
        if (response.state === 'answered') break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(response.answer.content.answer, 'Keep the current project selected');
      await call('desk_browser', { action: 'open' });
      await call('desk_browser', { action: 'assertText', selector: '#result', expected: 'Not fixed' });
      writeFileSync(path.join(options.cwd, 'page.html'), '<!doctype html><html><title>QA fixture</title><h1>Preview works</h1><p id="result">Fixed and verified</p></html>');
      await git(options.cwd, ['add', 'page.html']); await git(options.cwd, ['commit', '-m', 'Fix synthetic preview fixture']);
      await call('desk_browser', { action: 'navigate', url: '/' });
      await call('desk_browser', { action: 'assertText', selector: '#result', expected: 'Fixed and verified' });
      await call('desk_browser', { action: 'screenshot', value: 'Verified preview fixture' });
      const verification = await call('desk_verify'); assert.equal(verification.passed, true);
      const finished = await call('desk_finish', { summary: `Synthetic test only: reproduced and fixed ${task.title}. Regression test and recorded browser assertion passed.`,
        risk: { score: 2, requiresHumanReview: false, reason: 'One static fixture line changed; the regression command and browser assertion cover it.' } });
      assert.equal(finished.readyForReview, true);
    } catch (error) { failures.push(error); throw error; }
    finally { await client.close(); }
  },
  async interrupt() {}, close() {},
});

let browser, context;
try {
  app = await createApp({ dataDirectory: path.join(workspace, 'data'), port: 0, fetcher, runnerFactory, agentCommand, imageFetcher });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: qa, size: { width: 1440, height: 1000 } } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.address);
  // A new workspace opens the guided setup; the agent step reads the injected sign-in status.
  await page.getByRole('heading', { name: 'Set up Rex Desk', exact: true }).waitFor();
  await page.locator('.setup-step[data-step="agent"].done').waitFor();
  await page.screenshot({ path: path.join(screenshots, 'setup-desktop.png'), fullPage: true });
  // The first unfinished step opens automatically.
  await page.locator('.setup-step[data-step="connection"].open').waitFor();
  await page.getByRole('button', { name: 'Add a connection', exact: true }).click();
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  await page.getByRole('textbox', { name: 'Repository name', exact: true }).fill('Synthetic QA repository');
  await page.getByRole('textbox', { name: 'Local repository path', exact: true }).fill(repository);
  await page.getByRole('textbox', { name: 'Local repository path', exact: true }).press('Tab');
  // Branch choices come from Git inspection and are searchable with the keyboard.
  const base = page.getByRole('combobox', { name: 'Start from branch for Synthetic QA repository' });
  await base.waitFor({ timeout: 30000 });
  await base.click(); await base.fill('dev'); await base.press('ArrowDown'); await base.press('Enter');
  assert.equal(await page.locator('input[type=hidden][name$=".baseBranch"]').inputValue(), 'develop');
  await page.getByRole('textbox', { name: 'Dev server command', exact: true }).fill('node preview.cjs {port}');
  await page.getByRole('textbox', { name: 'Verification command', exact: true }).fill('node verify.cjs');
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByRole('textbox', { name: 'Connection name', exact: true }).fill('Morningmate · synthetic QA');
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('synthetic-key-for-test-only');
  await page.getByRole('button', { name: 'Connect & load projects / people', exact: true }).click();
  // A key typed while discovery is in flight must survive the discovery result.
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('synthetic-key-typed-during-discovery');
  await page.getByRole('textbox', { name: 'Repository name', exact: true }).focus();
  releaseDirectory?.();
  await page.getByRole('checkbox', { name: /Synthetic QA acceptance project/ }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('input[name$=".apiKey"]').inputValue(), 'synthetic-key-typed-during-discovery');
  assert.equal(await page.getByRole('textbox', { name: 'Repository name', exact: true }).evaluate(element => element === document.activeElement), true, 'Discovery must not steal focus');
  await page.getByRole('checkbox', { name: /Synthetic QA acceptance project/ }).check();
  const employee = page.getByRole('combobox', { name: 'Assigned employee for Morningmate · synthetic QA' });
  await employee.click(); await employee.fill('mina mobile');
  assert.equal(await page.locator('.picker.open [role=option]:not([hidden])').count(), 1, 'Employee search matches name and team');
  await employee.press('Enter');
  assert.equal(await page.locator('input[name$=".userId"]').inputValue(), 'mina@example.invalid');
  await employee.click(); await employee.fill('rex tester'); await employee.press('Enter');
  assert.equal(await page.locator('input[name$=".userId"]').inputValue(), 'rex@example.invalid');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  assert.ok(!(await page.content()).includes('synthetic-key-'));
  assert.equal(app.store.credential(app.store.config().sources[0].id), 'synthetic-key-typed-during-discovery');
  assert.equal(app.store.config().sources[0].repositoryId, app.store.config().repositories[0].id, 'A single repository becomes the source default');
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(screenshots, 'settings-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'My issues', exact: true }).click();
  await page.getByRole('button', { name: 'Sync tasks', exact: true }).first().click();
  await page.getByText(posts[0].title, { exact: true }).first().waitFor();
  assert.equal(await page.locator('.task-row').count(), 3, 'Feedback tasks stay out of the default Request + In progress sync');
  await page.getByRole('button', { name: new RegExp(posts[0].title) }).first().click();
  await page.getByText('Keep the selected project after switching.', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.issue-images img').evaluate(element => element.complete && element.naturalWidth), 2, 'Issue screenshot loads through the local cache');
  assert.equal(/COMP_TYPE|COMPS/.test(await page.locator('.detail-pane').innerText()), false);
  assert.ok((await page.locator('.issue-properties').innerText()).includes('Issue Type'));
  await page.locator('#task-search').fill('due date overseas');
  assert.equal(await page.locator('.task-row').count(), 0, 'Feedback task is filtered out by default');
  await page.locator('#task-search').fill('notifications');
  assert.equal(await page.locator('.task-row').count(), 1);
  assert.equal(await page.locator('#task-search').evaluate(element => element === document.activeElement), true, 'Search keeps focus');
  await page.locator('#task-search').fill('');
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(screenshots, 'desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Kanban', exact: true }).first().click();
  await page.getByRole('heading', { name: /^Inbox/ }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'board-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'My issues', exact: true }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('button', { name: 'Analyze & run', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Analyze & run', exact: true }).click();
  await page.getByRole('heading', { name: 'Main agent', exact: true }).waitFor();
  await page.getByRole('button', { name: /Needs you/ }).click();
  await page.getByRole('heading', { name: 'Which behavior should this preview preserve?', exact: true }).waitFor({ timeout: 30000 });
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(screenshots, 'decision-desktop.png'), fullPage: true });
  await page.getByRole('textbox', { name: 'Expected behavior', exact: true }).fill('Keep the current project selected');
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  let worker;
  for (let attempt = 0; attempt < 100; attempt++) {
    worker = app.store.list('run').find(run => run.role === 'worker');
    if (worker?.state === 'ready_for_review' || worker?.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.deepEqual(failures.map(error => error.message), []);
  assert.equal(worker.state, 'ready_for_review', worker.error);
  assert.equal(await git(repository, ['branch', '--show-current']), 'develop');
  assert.ok(readFileSync(path.join(repository, 'page.html'), 'utf8').includes('Not fixed'));
  const artifacts = app.store.list('artifact').filter(artifact => artifact.runId === worker.id);
  assert.ok(artifacts.some(artifact => artifact.type === 'video/webm'));
  assert.ok(artifacts.some(artifact => artifact.type === 'text/html'));
  assert.ok(artifacts.some(artifact => artifact.type === 'text/plain'));
  await page.getByRole('button', { name: 'Agent runs', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(posts[0].title) }).click();
  await page.getByRole('heading', { name: 'Worktree & proof', exact: true }).waitFor();
  await page.getByText('Ready for review', { exact: true }).first().waitFor();
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.locator('video').evaluate(async video => {
    video.preload = 'auto'; video.load();
    if (video.readyState < 2) await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Recorded video did not decode.')), { once: true });
      setTimeout(() => reject(new Error('Recorded video did not load in time.')), 8000);
    });
    video.currentTime = Math.min(0.1, video.duration / 2);
    await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
  });
  await page.screenshot({ path: path.join(screenshots, 'proof-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'My issues', exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile document must not overflow horizontally');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, 'settings-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile settings must not overflow horizontally');
  await page.getByRole('button', { name: 'Setup', exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, 'setup-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile settings must not overflow horizontally');
  assert.deepEqual(errors, []);
  // Publishing must reject a post-verification edit before any network side effect.
  writeFileSync(path.join(worker.worktree, 'page.html'), 'Changed after verification');
  await assert.rejects(app.desk.publish(worker.id, { approved: true }), /changed after verification/);
  const result = { passed: true, syntheticAgents: true, realGitWorktrees: true, realBrowserVideo: true, actualRegressionCommand: true,
    screenshots, fixtureWorkspace: workspace, workerId: worker.id, artifacts: artifacts.map(item => ({ type: item.type, title: item.title, path: path.join(app.store.directory, 'artifacts', worker.id, item.file) })) };
  writeFileSync(path.join(qa, 'acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await context?.close(); await browser?.close(); await app?.close(); }

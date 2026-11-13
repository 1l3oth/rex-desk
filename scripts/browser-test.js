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
writeFileSync(path.join(repository, 'preview.cjs'), `const http=require('http'),fs=require('fs');http.createServer((q,s)=>{s.setHeader('Content-Type','text/html');s.end(fs.readFileSync('page.html'))}).listen(Number(process.argv[process.argv.indexOf('--port')+1]||process.env.PORT),'127.0.0.1');`);
writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ name: 'qa-fixture', private: true, scripts: { dev: 'node preview.cjs', test: 'node verify.cjs' } }));
writeFileSync(path.join(repository, 'package-lock.json'), JSON.stringify({ name: 'qa-fixture', lockfileVersion: 3, requires: true, packages: { '': { name: 'qa-fixture' } } }));
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
const image = 'https://morningmate.invalid/flowImg/preview.png', clip = 'https://morningmate.invalid/flowFile/repro.webm';
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
      imageAttachments: [{ ATCH_URL: image, ORCP_FILE_NM: 'preview.png' }], attachments: [{ ATCH_URL: clip, ORCP_FILE_NM: 'repro.webm' }],
      remarks: [{ RGSR_NM: 'QA Lead', RGSN_DTTM: '20261020093000', SYSTEM_REMARK_YN: 'N', CNTN: 'Keep the selected project after switching.' },
        { RGSR_NM: 'QA Lead', RGSN_DTTM: '20261020090000', SYSTEM_REMARK_YN: 'Y', REMARK_CNTN: "'Team' → 'Rex Tester' Assignee has been updated." }],
      tasks: [{ TASK_SRNO: post.taskId, TASK_NM: post.title, STTS: status[post.taskStatus][1], TASK_COLUMN_REC: [] }] } };
  }
  return new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNgYGD4z8DAwMDAAAAEBQEAr8Q+0wAAAABJRU5ErkJggg==', 'base64');
// A WebM container header is enough for the server's type check; the viewer then reports that it cannot play the clip.
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04]);
const imageFetcher = async value => String(value) === image ? new Response(png) : String(value) === clip ? new Response(webm) : new Response('', { status: 404 });
const agentCommand = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ loggedIn: true, authMethod: 'synthetic', email: 'agent@example.invalid' }) });

const jevRequests = [];
const jevFetcher = async (url, options) => {
  const request = JSON.parse(options.body); jevRequests.push({ url, authorization: options.headers.Authorization, title: request.state.title });
  const top = /File preview/.test(request.state.title), waiting = /Duplicate notifications/.test(request.state.title);
  const phone = /Assignee filter/.test(request.state.title), stale = /Duplicate notifications/.test(request.state.title);
  const score = value => ({ type: 'score', score: value, probabilities: {}, confidence: 0.8 });
  return new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { severity: score(top ? 4 : 1), effort: score(top ? 0 : 1), web: { type: 'noul', noul: 0.95 },
    platform: { type: 'choice', choice: phone ? 'mobile' : 'web', probabilities: {}, confidence: 0.8 },
    outdated: { type: 'noul', noul: stale ? 0.86 : 0.04 },
    action: { type: 'choice', choice: waiting ? 'wait' : 'fix', probabilities: {}, confidence: 0.8 } } }), { headers: { 'Content-Type': 'application/json' } });
};
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
  app = await createApp({ dataDirectory: path.join(workspace, 'data'), port: 0, fetcher, runnerFactory, agentCommand, imageFetcher, jevFetcher });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The old /classic page is gone; its address no longer serves the old dashboard.
  assert.notEqual((await fetch(`${app.address}/app.js`)).status, 200, 'The old dashboard script is removed');
  await page.goto(app.address);
  const settings = page.getByRole('form', { name: 'Settings' });
  const openSection = async name => {
    if (!(await settings.count())) await page.locator('.rail-settings').click();
    await settings.locator(`[data-st-section="${name}"]`).click();
  };
  const save = async () => { await settings.locator('[data-st-save]').click(); await page.getByText('Saved.', { exact: true }).last().waitFor(); };

  // Projects: a folder is added, and its commands come from the project's own files.
  await openSection('projects');
  await settings.getByRole('textbox', { name: /Folder of a project/ }).fill(repository);
  await settings.locator('[data-st-repo-add]').click();
  await settings.locator('.st-repo summary', { hasText: 'source' }).waitFor({ timeout: 30000 });
  assert.equal(app.store.config().repositories.length, 1);
  await settings.getByRole('heading', { name: 'GitHub', exact: true }).waitFor();

  // Task sources: a Morningmate connection is made, its projects load, and people are added by name.
  await openSection('sources');
  await settings.getByRole('button', { name: '+ Add a connection', exact: true }).click();
  const card = settings.locator('.st-tracker').first();
  await card.locator('input[name$=".name"]').fill('Morningmate synthetic QA');
  await card.locator('input[name$=".apiKey"]').fill('synthetic-key-for-test-only');
  await card.getByRole('button', { name: 'Connect and load projects', exact: true }).click();
  releaseDirectory?.();
  await settings.getByRole('checkbox', { name: /Synthetic QA acceptance project/ }).waitFor({ timeout: 15000 });
  await settings.getByRole('checkbox', { name: /Synthetic QA acceptance project/ }).check();
  await settings.locator('[data-tr-search]').fill('unrelated');
  assert.equal(await settings.locator('.st-tr-project:visible').count(), 1, 'Project search hides the projects that do not match');
  await settings.locator('[data-tr-search]').fill('');
  const person = settings.locator('[data-tr-person]');
  await person.fill('mina@example.invalid'); await person.press('Enter'); await person.dispatchEvent('change');
  await settings.locator('.st-chip', { hasText: 'Mina Park' }).waitFor();
  await settings.locator('[data-tr-person]').fill('rex@example.invalid'); await settings.locator('[data-tr-person]').dispatchEvent('change');
  await settings.locator('.st-chip', { hasText: 'Rex Tester' }).waitFor();
  await settings.locator('.st-chip', { hasText: 'Mina Park' }).getByRole('button', { name: 'Remove' }).click();
  assert.equal(await settings.locator('.st-chip', { hasText: 'Mina Park' }).count(), 0, 'Remove drops one person and keeps the rest');
  assert.equal(await settings.getByRole('checkbox', { name: /Synthetic QA acceptance project/ }).isChecked(), true, 'Adding a person keeps the ticked project');
  await save();
  await page.screenshot({ path: path.join(screenshots, 'sources-desktop.png') });
  const source = app.store.config().sources[0];
  assert.deepEqual(source.projectIds, ['317938']);
  assert.equal(source.userId, 'rex@example.invalid');
  assert.equal(app.store.credential(source.id), 'synthetic-key-for-test-only');
  assert.equal(source.repositoryId, app.store.config().repositories[0].id, 'A single project becomes the connection default');

  // Test sign-ins and the Jev key save, and secrets never come back to the page.
  await openSection('signins');
  await settings.getByRole('button', { name: '+ Add a sign-in' }).click();
  await settings.locator('input[name="ta.0.site"]').fill('127.0.0.1');
  await settings.locator('input[name="ta.0.username"]').fill('qa@example.invalid');
  await settings.locator('input[name="ta.0.password"]').fill('synthetic-test-password');
  await settings.getByRole('button', { name: '+ Add a sign-in' }).click();
  assert.equal(await settings.locator('input[name="ta.0.password"]').inputValue(), 'synthetic-test-password', 'Adding a second sign-in keeps the first password typed');
  await save();
  assert.equal(app.store.testAccounts().length, 1, 'An empty sign-in row is not saved');
  await openSection('jev');
  await settings.locator('input[name="jev.apiKey"]').fill('synthetic-openrouter-key');
  await save();
  assert.ok(!/synthetic-key-|synthetic-openrouter-key|synthetic-test-password/.test(await page.content()), 'Saved secrets never return to the page');
  assert.equal(app.store.testAccounts()[0].password, 'synthetic-test-password');

  // Rank my issues now and Run it now live in Settings.
  await app.desk.sources.sync();
  assert.equal(app.store.list('task').filter(task => task.active && !task.local).length, 3, 'Feedback tasks stay out of the default Request and In progress sync');
  await settings.getByRole('button', { name: 'Rank my issues now', exact: true }).click();
  await page.getByText(/Jev rated|already rated/).last().waitFor({ timeout: 15000 });
  assert.ok(jevRequests.length >= 3 && jevRequests.every(item => item.url === 'https://openrouter.ai/api/v1/systemone' && item.authorization === 'Bearer synthetic-openrouter-key'));
  await openSection('schedule');
  await settings.getByRole('button', { name: 'Run it now', exact: true }).waitFor();
  await openSection('backup');
  await settings.getByRole('heading', { name: 'App updates', exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'settings-desktop.png') });

  // The phone layout of Settings does not overflow sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, 'settings-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile settings must not overflow horizontally');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // One synthetic agent run, start to ready for review: it asks a question, gets the answer, fixes, verifies and records proof.
  const top = app.store.list('task').find(task => task.title === posts[0].title);
  await app.desk.startTask({ taskId: top.id, repositoryId: app.store.config().repositories[0].id });
  let question;
  for (let attempt = 0; attempt < 120 && !question; attempt++) { question = app.store.list('interaction').find(item => item.state === 'pending'); if (!question) await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.ok(question, 'The agent asked its question');
  app.desk.answer(question.id, { action: 'accept', content: { answer: 'Keep the current project selected' } });
  let worker;
  for (let attempt = 0; attempt < 200; attempt++) {
    worker = app.store.list('run').find(run => run.role === 'worker');
    if (worker?.state === 'ready_for_review' || worker?.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.deepEqual(failures.map(error => error.message), []);
  assert.equal(worker.state, 'ready_for_review', worker.error);
  assert.equal(await git(repository, ['branch', '--show-current']), 'develop');
  assert.ok(readFileSync(path.join(repository, 'page.html'), 'utf8').includes('Not fixed'), 'The person\'s own checkout is untouched');
  const artifacts = app.store.list('artifact').filter(artifact => artifact.runId === worker.id);
  assert.ok(artifacts.some(artifact => artifact.type === 'video/webm'));
  assert.ok(artifacts.some(artifact => artifact.type === 'text/html'));
  assert.ok(artifacts.some(artifact => artifact.type === 'text/plain'));
  assert.deepEqual(errors, []);
  // Publishing must reject a post-verification edit before any network side effect.
  writeFileSync(path.join(worker.worktree, 'page.html'), 'Changed after verification');
  await assert.rejects(app.desk.publish(worker.id, { approved: true }), /not committed yet/);
  const result = { passed: true, syntheticAgents: true, realGitWorktrees: true, realBrowserVideo: true, actualRegressionCommand: true,
    screenshots, fixtureWorkspace: workspace, workerId: worker.id, artifacts: artifacts.map(item => ({ type: item.type, title: item.title, path: path.join(app.store.directory, 'artifacts', worker.id, item.file) })) };
  writeFileSync(path.join(qa, 'acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await context?.close(); await browser?.close(); await app?.close(); }

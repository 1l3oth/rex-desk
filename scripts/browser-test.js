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
const fetcher = async value => {
  const url = new URL(value);
  let data;
  if (url.pathname.endsWith('/employees/me')) data = { employee: { userId: 'rex@example.invalid' } };
  else if (url.pathname.endsWith('/columns/status')) data = { options: [{ name: 'Request', value: 'request' }, { name: 'Progress', value: 'progress' }] };
  else if (url.pathname.endsWith('/projects/317938')) data = { posts: posts.map(post => ({ ...post, projectTitle: 'Synthetic QA acceptance project' })), hasNext: false, lastCursor: -1 };
  else {
    const post = posts.find(item => url.pathname.endsWith('/' + item.postId));
    if (!post) return new Response('{}', { status: 404 });
    data = { ...post, projectTitle: 'Synthetic QA acceptance project', content: 'Synthetic acceptance-test issue. Reproduce the blank preview, fix its content, and verify the result.', workers: [{ workerId: 'rex@example.invalid' }] };
  }
  return new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });
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
      const finished = await call('desk_finish', { summary: `Synthetic test only: reproduced and fixed ${task.title}. Regression test and recorded browser assertion passed.` });
      assert.equal(finished.readyForReview, true);
    } catch (error) { failures.push(error); throw error; }
    finally { await client.close(); }
  },
  async interrupt() {}, close() {},
});

let browser, context;
try {
  app = await createApp({ dataDirectory: path.join(workspace, 'data'), port: 0, fetcher, runnerFactory });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: qa, size: { width: 1440, height: 1000 } } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.address);
  await page.getByRole('button', { name: 'Connect a project', exact: true }).click();
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  await page.getByRole('textbox', { name: 'Repository name', exact: true }).fill('Synthetic QA repository');
  await page.getByRole('textbox', { name: 'Local repository path', exact: true }).fill(repository);
  await page.getByRole('textbox', { name: 'Dev server command', exact: true }).fill('node preview.cjs {port}');
  await page.getByRole('textbox', { name: 'Verification command', exact: true }).fill('node verify.cjs');
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByRole('textbox', { name: 'Connection name', exact: true }).fill('Morningmate · synthetic QA');
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('synthetic-key-for-test-only');
  await page.getByRole('textbox', { name: 'Project IDs', exact: true }).fill('317938');
  await page.getByLabel('Source repository').selectOption({ label: 'Synthetic QA repository' });
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  assert.ok(!(await page.content()).includes('synthetic-key-for-test-only'));
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(screenshots, 'settings-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'My issues', exact: true }).click();
  await page.getByRole('button', { name: 'Sync tasks', exact: true }).first().click();
  await page.getByText(posts[0].title, { exact: true }).first().waitFor();
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
  assert.deepEqual(errors, []);
  // Publishing must reject a post-verification edit before any network side effect.
  writeFileSync(path.join(worker.worktree, 'page.html'), 'Changed after verification');
  await assert.rejects(app.desk.publish(worker.id, { approved: true }), /changed after verification/);
  const result = { passed: true, syntheticAgents: true, realGitWorktrees: true, realBrowserVideo: true, actualRegressionCommand: true,
    screenshots, fixtureWorkspace: workspace, workerId: worker.id, artifacts: artifacts.map(item => ({ type: item.type, title: item.title, path: path.join(app.store.directory, 'artifacts', worker.id, item.file) })) };
  writeFileSync(path.join(qa, 'acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await context?.close(); await browser?.close(); await app?.close(); }

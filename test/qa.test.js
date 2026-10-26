import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const idle = () => ({ start: async () => ({ status: 'completed' }), interrupt: async () => {}, close() {} });
const settle = () => new Promise(resolve => setTimeout(resolve, 60));
function workspace({ schedule } = {}) {
  const store = new Store(temporary('qa'));
  store.saveConfig({ ...defaults, ...(schedule ? { schedule } : {}) });
  const desk = new Desk(store, { root: temporary('root'), runnerFactory: idle });
  store.put('task', 'done-1', { id: 'done-1', title: 'Indonesian label fixed', active: true, statusName: 'Development Completed', createdAt: now() });
  store.put('task', 'bug-1', { id: 'bug-1', title: 'Gmail button missing', active: true, statusName: 'Request', createdAt: now() });
  return { store, desk };
}

test('a QA verification run needs no configured site or repository, and never gets a worktree', async () => {
  const { store, desk } = workspace();
  await assert.rejects(desk.startTask({ taskId: 'bug-1' }), /repository/);
  const run = await desk.startTask({ taskId: 'done-1', mode: 'verify' });
  assert.equal(run.role, 'verifier'); assert.equal(run.repositoryId, undefined); assert.equal(run.qaUrl, '', 'The agent chooses the site');
  assert.match(desk.prompt(run), /Choose the test site yourself/);
  await settle();
  const ended = store.get('run', run.id);
  assert.equal(ended.worktree, undefined);
  assert.equal(ended.state, 'qa_blocked', 'An agent that stops without a verdict is blocked, not passed');
  store.close();
});

test('a QA pass needs a recorded assertion, and only a pass may complete the tracker issue', async () => {
  const { store, desk } = workspace();
  store.put('run', 'qa-1', { id: 'qa-1', role: 'verifier', taskId: 'done-1', title: 'Indonesian label fixed', state: 'running', qaUrl: 'https://staging.example.invalid', createdAt: now() });
  await desk.qaResult('qa-1', { verdict: 'pass', summary: 'Label reads Terang.', comment: 'Verified on staging.' });
  assert.equal(store.get('run', 'qa-1').state, 'qa_blocked', 'No recording means the pass is not accepted');
  await assert.rejects(desk.trackerFromQa('qa-1', 'done'), /passed QA/);

  store.put('run', 'qa-2', { id: 'qa-2', role: 'verifier', taskId: 'done-1', title: 'Indonesian label fixed', state: 'running', qaUrl: 'https://staging.example.invalid', createdAt: now() });
  store.put('artifact', 'video-2', { id: 'video-2', runId: 'qa-2', file: 'page.webm', type: 'video/webm', assertions: [{ action: 'assertText', expected: 'Terang' }], createdAt: now() });
  await desk.qaResult('qa-2', { verdict: 'pass', summary: 'Label reads Terang.', comment: 'Verified on staging.' });
  assert.equal(store.get('run', 'qa-2').state, 'qa_passed');
  assert.deepEqual(await desk.trackerFromQa('qa-2', 'done'), { skipped: true, reason: 'No source status mapped for done.' });
  await assert.rejects(desk.qaResult('qa-2', { verdict: 'pass', summary: 'again' }).then(() => desk.trackerFromQa('qa-2', 'review')), /done or working/);
  store.close();
});

test('a QA run opens the site the agent chose, records it, asserts the expected text, and passes with video proof', async () => {
  const http = await import('node:http');
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const deskServer = http.createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Rex Desk</title>Approve'); });
  const deskPort = await listen(deskServer);
  const site = http.createServer((request, response) => {
    if (request.url === '/to-desk') { response.writeHead(302, { Location: `http://localhost:${deskPort}/` }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Org chart</title><button id="bulk">Terang</button>');
  });
  const url = `http://127.0.0.1:${await listen(site)}/org-chart`;
  const { store, desk } = workspace();
  desk.mcpUrl = `http://127.0.0.1:${deskPort}/mcp`;
  try {
    store.put('run', 'qa-live', { id: 'qa-live', role: 'verifier', taskId: 'done-1', title: 'Indonesian label fixed', state: 'running', qaUrl: '', createdAt: now() });
    await assert.rejects(desk.evidence.action('qa-live', { action: 'open' }), /Choose the test site/);
    await assert.rejects(desk.evidence.action('qa-live', { action: 'open', url: `http://localhost:${deskPort}/` }), /Rex Desk itself/);
    const page = await desk.evidence.action('qa-live', { action: 'open', url });
    assert.match(page.text, /Terang/);
    assert.equal(store.get('run', 'qa-live').qaUrl, url, 'The chosen site is recorded on the run');
    assert.match(desk.prompt({ id: 'qa-next', role: 'verifier', taskId: 'done-1', qaUrl: '' }), /Test sites earlier QA checks used: .*org-chart/, 'Later checks see it as a hint');
    await assert.rejects(desk.evidence.action('qa-live', { action: 'navigate', url: 'https://example.invalid/' }), /test site origin/);
    await assert.rejects(desk.evidence.action('qa-live', { action: 'open', url: url.replace('/org-chart', '/to-desk') }), /Rex Desk itself/, 'A redirect cannot reach the dashboard');
    await desk.evidence.action('qa-live', { action: 'open', url });
    await desk.evidence.action('qa-live', { action: 'assertText', selector: '#bulk', expected: 'Terang' });
    const result = await desk.qaResult('qa-live', { verdict: 'pass', summary: 'The button reads Terang.', comment: 'Verified on the test site; recording in Rex Desk.' });
    assert.equal(result.state, 'qa_passed');
    assert.ok(store.list('artifact').some(item => item.runId === 'qa-live' && item.type === 'video/webm'));
    assert.ok(store.list('artifact').some(item => item.runId === 'qa-live' && item.type === 'text/html'));
  } finally { await desk.evidence.stopAll(); site.close(); deskServer.close(); store.close(); }
});

test('verification runs cannot dispatch or read other runs', () => {
  const { store, desk } = workspace();
  assert.throws(() => desk.authorize({ role: 'verifier', runId: 'qa-1' }, null, { coordinator: true }), /main agent/);
  assert.throws(() => desk.authorize({ role: 'verifier', runId: 'qa-1' }, 'other-run'), /own run/);
  store.close();
});

test('the schedule runs once per scheduled day and caps what its main agent may start', async () => {
  const { store, desk } = workspace({ schedule: { enabled: false, time: '00:00', days: [0, 1, 2, 3, 4, 5, 6], verify: true, fix: false, maxRuns: 1 } });
  store.saveConfig({ ...store.publicConfig(), schedule: { ...store.config().schedule, enabled: true } });
  assert.equal(store.get('schedule', 'last').state, 'armed', 'Turning it on after today’s time waits until tomorrow');
  assert.equal(await desk.scheduleTick(), null);

  store.delete('schedule', 'last');
  const first = await desk.scheduleTick();
  assert.equal(first.state, 'started');
  assert.equal(await desk.scheduleTick(), null, 'A second tick on the same day does nothing');
  const coordinator = store.get('run', first.runId);
  assert.equal(coordinator.maxDispatch, 1); assert.deepEqual(coordinator.allowedModes, ['verify']);
  await assert.rejects(desk.startTask({ taskId: 'bug-1', mode: 'fix', parentRunId: coordinator.id }), /only start verify/);
  await desk.startTask({ taskId: 'done-1', mode: 'verify', parentRunId: coordinator.id });
  await assert.rejects(desk.startTask({ taskId: 'bug-1', mode: 'verify', parentRunId: coordinator.id }), /at most 1/);
  await settle(); store.close();
});

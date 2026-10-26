import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { siteEnvironment, releasedToProduction, accountForSite } from '../src/sites.js';

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

test('the schedule runs once per scheduled day and starts the top-ranked issues in its allowed modes', async () => {
  const { store, desk } = workspace({ schedule: { enabled: false, time: '00:00', days: [0, 1, 2, 3, 4, 5, 6], verify: true, fix: false, maxRuns: 1 } });
  store.saveConfig({ ...store.publicConfig(), schedule: { ...store.config().schedule, enabled: true } });
  assert.equal(store.get('schedule', 'last').state, 'armed', 'Turning it on after today’s time waits until tomorrow');
  assert.equal(await desk.scheduleTick(), null);

  store.delete('schedule', 'last');
  const first = await desk.scheduleTick();
  assert.equal(first.state, 'started');
  assert.equal(await desk.scheduleTick(), null, 'A second tick on the same day does nothing');
  assert.equal(first.runIds.length, 1, 'Capped by the daily limit');
  const run = store.get('run', first.runIds[0]);
  assert.equal(run.role, 'verifier'); assert.equal(run.taskId, 'done-1', 'Without Jev, a completed issue is a QA check; fixes are off');
  assert.ok(first.skipped.some(item => item.taskId === 'bug-1' && /fix runs are off/.test(item.reason)));
  assert.equal(store.list('run').some(item => item.role === 'coordinator'), false, 'No main agent is started');
  await settle(); store.close();
});

test('a site is production only when the product itself calls it production', () => {
  assert.equal(siteEnvironment('https://morningmate.com/l/cJDj').environment, 'production');
  assert.equal(siteEnvironment('https://morningmate.com/l/cJDj').product, 'Morningmate');
  assert.equal(siteEnvironment('https://www.flow.team').environment, 'production');
  assert.equal(siteEnvironment('https://seco.flow.team').environment, 'production', 'A customer subdomain is still the live service');
  for (const site of ['https://develop.morningmate.com', 'https://staging.morningmate.com', 'https://release.flow.team', 'https://morningmate.info', 'http://127.0.0.1:3000', 'https://qa.example.com'])
    assert.equal(siteEnvironment(site).environment, 'test', site);
  assert.equal(siteEnvironment('https://example.com').environment, 'unknown', 'An unknown host is not assumed to be production');
  assert.equal(releasedToProduction('Development Completed'), false);
  assert.ok(releasedToProduction('배포완료') && releasedToProduction('Released'));
});

test('a QA check on an unreleased fix is kept off production, and the human can still allow it', () => {
  const { store, desk } = workspace();
  store.put('run', 'qa-prod', { id: 'qa-prod', role: 'verifier', taskId: 'done-1', state: 'running', createdAt: now() });
  const run = store.get('run', 'qa-prod');
  assert.throws(() => desk.evidence.qaSite('https://morningmate.com/l/cJDj', run),
    /live Morningmate service.*Development Completed.*develop\.morningmate\.com/s);
  assert.doesNotThrow(() => desk.evidence.qaSite('https://develop.morningmate.com', run));

  store.put('task', 'shipped', { id: 'shipped', title: 'Shipped fix', statusName: 'Released', createdAt: now() });
  assert.doesNotThrow(() => desk.evidence.qaSite('https://morningmate.com', { ...run, taskId: 'shipped' }), 'A released fix is on production');

  store.put('interaction', 'ask-1', { id: 'ask-1', runId: 'qa-prod', state: 'answered', answer: { action: 'accept', content: { answer: 'Use https://morningmate.com, it is live there' } } });
  assert.doesNotThrow(() => desk.evidence.qaSite('https://morningmate.com/l/cJDj', run), 'The human named the site in their answer');
  store.close();
});

test('the saved test account is never typed into production', async () => {
  const { store, desk } = workspace();
  store.saveConfig({ ...store.publicConfig(), testAccounts: [{ id: 'any', site: '', username: 'qa@example.com', password: 'secret' }] });
  const page = { url: () => 'https://morningmate.com/signin.act', locator: () => { throw new Error('the field must never be filled'); } };
  desk.evidence.sessions.set('qa-fill', { page, qa: true, baseUrl: 'https://morningmate.com', assertions: [], actions: 0 });
  store.put('run', 'qa-fill', { id: 'qa-fill', role: 'verifier', taskId: 'done-1', state: 'running', createdAt: now() });
  await assert.rejects(desk.evidence.action('qa-fill', { action: 'fill', selector: '#id', value: '{{test.username}}' }),
    /does not type a saved test sign-in into morningmate\.com/);
  await assert.rejects(desk.evidence.action('qa-fill', { action: 'fill', selector: '#pw', value: '{{test.password}}' }),
    /those accounts belong to the test servers/);
  desk.evidence.sessions.delete('qa-fill');
  store.close();
});

test('the QA prompt names each environment and the status rule instead of only production', () => {
  const { store, desk } = workspace();
  const prompt = desk.prompt({ id: 'p-1', role: 'verifier', taskId: 'done-1', instructions: '' });
  assert.match(prompt, /https:\/\/develop\.morningmate\.com/);
  assert.match(prompt, /refuses a production site for any other status/);
  assert.match(prompt, /never typed into production/);
  store.close();
});

test('each test server gets its own sign-in, and a site without one falls back or is refused', () => {
  const { store } = workspace();
  store.saveConfig({ ...store.publicConfig(), testAccounts: [
    { id: 'dev', site: 'morningmate.info', username: 'dev@example.com', password: 'dev-pass' },
    { id: 'stage', site: 'staging.morningmate.com', username: 'stage@example.com', password: 'stage-pass' },
    { id: 'any', site: '', username: 'fallback@example.com', password: 'fallback-pass' }] });
  const accounts = store.testAccounts();
  assert.equal(accountForSite(accounts, 'https://morningmate.info/signin.act').username, 'dev@example.com');
  assert.equal(accountForSite(accounts, 'https://staging.morningmate.com/signin.act').username, 'stage@example.com');
  assert.equal(accountForSite(accounts, 'https://release.morningmate.com/').username, 'fallback@example.com', 'An unlisted site uses the any-site sign-in');
  assert.equal(accountForSite([accounts[0]], 'https://release.morningmate.com/'), null, 'Without a fallback there is no sign-in to type');
  assert.equal(store.publicConfig().testAccounts.every(account => account.password === undefined), true, 'The dashboard never receives a password');

  store.saveConfig({ ...store.publicConfig(), testAccounts: store.publicConfig().testAccounts.filter(account => account.id !== 'stage') });
  assert.deepEqual(store.testAccounts().map(account => account.id), ['dev', 'any']);
  assert.equal(store.testAccounts().find(account => account.id === 'dev').password, 'dev-pass', 'The remaining passwords survive a save');
  store.close();
});

test('the older single test account becomes the first entry of the sign-in list', () => {
  const directory = temporary('migrate');
  const first = new Store(directory);
  first.saveConfig({ ...defaults, testAccounts: [] });
  first.put('config', 'main', { ...first.config(), testAccounts: undefined, testAccount: { username: 'qa@example.com', localUsername: 'local@example.com' } });
  first.put('secret', 'test-account-password', first.encrypt('site-pass'));
  first.put('secret', 'test-account-local-password', first.encrypt('local-pass'));
  first.close();

  const store = new Store(directory);
  assert.deepEqual(store.testAccounts(), [
    { id: 'site', site: '', username: 'qa@example.com', password: 'site-pass' },
    { id: 'local', site: '127.0.0.1', username: 'local@example.com', password: 'local-pass' }]);
  assert.equal(store.config().testAccount, undefined, 'The old field is gone once it has been carried over');
  store.close();
});

test('every run opens in an Orca terminal; nothing starts out of sight', async () => {
  const { store, desk } = workspace();
  assert.equal(store.config().execution, 'orca');
  store.saveConfig({ ...store.publicConfig(), execution: 'rex' });
  assert.equal(store.config().execution, 'orca', 'Headless cannot be chosen any more');
  const run = await desk.startTask({ taskId: 'done-1', mode: 'verify' });
  assert.equal(run.execution, 'orca');
  await settle(); store.close();
});

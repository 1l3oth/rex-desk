import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { siteEnvironment, releasedToProduction, accountForSite } from '../src/sites.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const idle = () => ({ start: async () => ({ status: 'completed' }), interrupt: async () => {}, close() {} });
const settle = () => new Promise(resolve => setTimeout(resolve, 60));
// Runs need a repository to work in, so the fixture is a real checkout with one commit.
function gitRepo() {
  const directory = temporary('repo');
  const git = args => execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' });
  git(['init', '-b', 'develop']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(directory, 'app.txt'), 'fixture\n'); git(['add', '.']); git(['commit', '-m', 'Fixture']);
  return directory;
}
function workspace({ schedule } = {}) {
  const store = new Store(temporary('qa'));
  store.saveConfig({ ...defaults, ...(schedule ? { schedule } : {}), repositories: [{ id: 'repo', name: 'repo', path: gitRepo(), baseBranch: 'develop', targetBranch: 'develop' }] });
  const desk = new Desk(store, { root: temporary('root'), runnerFactory: idle });
  store.put('task', 'done-1', { id: 'done-1', repositoryId: 'repo', title: 'Indonesian label fixed', active: true, statusName: 'Development Completed', createdAt: now() });
  store.put('task', 'bug-1', { id: 'bug-1', repositoryId: 'repo', title: 'Gmail button missing', active: true, statusName: 'Request', createdAt: now() });
  return { store, desk };
}

test('the schedule runs once per scheduled day and starts the top-ranked issues', async () => {
  const { store, desk } = workspace({ schedule: { enabled: false, time: '00:00', days: [0, 1, 2, 3, 4, 5, 6], fix: true, maxRuns: 1 } });
  desk.drain = async () => {};
  store.saveConfig({ ...store.publicConfig(), schedule: { ...store.config().schedule, enabled: true } });
  assert.equal(store.get('schedule', 'last').state, 'armed', 'Turning it on after today’s time waits until tomorrow');
  assert.equal(await desk.scheduleTick(), null);

  store.delete('schedule', 'last');
  const first = await desk.scheduleTick();
  assert.equal(first.state, 'started');
  assert.equal(await desk.scheduleTick(), null, 'A second tick on the same day does nothing');
  assert.equal(first.runIds.length, 1, 'Capped by the daily limit');
  const run = store.get('run', first.runIds[0]);
  assert.equal(run.role, 'worker', 'The schedule starts a run that investigates one issue');
  assert.equal(store.list('run').some(item => item.role === 'coordinator'), false, 'No main agent is started');
  await settle(); await desk.shutdown(); store.close();
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

test('the saved test account is never typed into production', async () => {
  const { store, desk } = workspace();
  store.saveConfig({ ...store.publicConfig(), testAccounts: [{ id: 'any', site: '', username: 'qa@example.com', password: 'secret' }] });
  const page = { url: () => 'https://morningmate.com/signin.act', locator: () => { throw new Error('the field must never be filled'); } };
  desk.evidence.sessions.set('qa-fill', { page, baseUrl: 'https://morningmate.com', assertions: [], actions: 0 });
  store.put('run', 'qa-fill', { id: 'qa-fill', role: 'worker', taskId: 'done-1', state: 'running', createdAt: now() });
  await assert.rejects(desk.evidence.action('qa-fill', { action: 'fill', selector: '#id', value: '{{test.username}}' }),
    /does not type a saved test sign-in into morningmate\.com/);
  await assert.rejects(desk.evidence.action('qa-fill', { action: 'fill', selector: '#pw', value: '{{test.password}}' }),
    /those accounts belong to the test servers/);
  desk.evidence.sessions.delete('qa-fill');
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
  first.put('config', 'main', { ...first.config(), execution: 'rex', testAccounts: undefined, testAccount: { username: 'qa@example.com', localUsername: 'local@example.com' } });
  first.put('secret', 'test-account-password', first.encrypt('site-pass'));
  first.put('secret', 'test-account-local-password', first.encrypt('local-pass'));
  first.close();

  const store = new Store(directory);
  assert.deepEqual(store.testAccounts(), [
    { id: 'site', site: '', username: 'qa@example.com', password: 'site-pass' },
    { id: 'local', site: '127.0.0.1', username: 'local@example.com', password: 'local-pass' }]);
  assert.equal(store.config().testAccount, undefined, 'The old field is gone once it has been carried over');
  assert.equal(store.config().execution, 'orca', 'A saved headless choice is dropped');
  store.close();
});

test('every run opens in an Orca terminal; nothing starts out of sight', async () => {
  const { store, desk } = workspace();
  desk.drain = async () => {};
  assert.equal(store.config().execution, 'orca');
  store.saveConfig({ ...store.publicConfig(), execution: 'rex' });
  assert.equal(store.config().execution, 'orca', 'Headless cannot be chosen any more');
  const run = await desk.startTask({ taskId: 'done-1' });
  assert.equal(run.execution, 'orca');
  await settle(); await desk.shutdown(); store.close();
});

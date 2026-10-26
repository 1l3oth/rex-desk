import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { askJev, rankTasks, Jev, jevEndpoint, jevQuestions, taskFingerprint } from '../src/jev.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const idle = () => ({ start: async () => ({ status: 'completed' }), interrupt: async () => {}, close() {} });
const answers = ({ severity = 1, action = 'fix', effort = 1, web = 0.9 } = {}) => ({ severity: { type: 'score', score: severity, probabilities: {}, confidence: 0.8 },
  action: { type: 'choice', choice: action, probabilities: {}, confidence: 0.8 }, effort: { type: 'score', score: effort, probabilities: {}, confidence: 0.7 }, web: { type: 'noul', noul: web } });
const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('Jev is asked through OpenRouter System One with typed questions and the OpenRouter key', async () => {
  let request;
  const fetcher = async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return reply({ model: 'typesafe/jev-1.13', answers: answers(), usage: {} }); };
  const result = await askJev({ apiKey: 'or-key', state: { title: 'Blank preview' }, fetcher });
  assert.equal(request.url, jevEndpoint);
  assert.equal(request.options.headers.Authorization, 'Bearer or-key');
  assert.equal(request.body.model, '~typesafe/jev-latest');
  assert.deepEqual(Object.keys(request.body.questions), Object.keys(jevQuestions));
  assert.equal(request.body.questions.severity.type, 'score'); assert.equal(request.body.questions.action.type, 'choice'); assert.equal(request.body.questions.web.type, 'noul');
  assert.equal(result.answers.action.choice, 'fix');
  await assert.rejects(askJev({ apiKey: 'bad', state: {}, fetcher: async () => new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), { status: 401 }) }), /\(401\): No auth credentials found/);
});

test('ranking puts severe, overdue, browser-checkable work first and waiting or running issues after', () => {
  const today = new Date('2026-10-26T00:00:00Z');
  const tasks = [{ id: 'minor', title: 'Spacing' }, { id: 'critical', title: 'Data loss', dueDate: '2026-10-25 18:00' }, { id: 'blocked', title: 'Needs design' }, { id: 'busy', title: 'In progress' }, { id: 'unrated', title: 'New' }];
  const analyses = new Map([['minor', { answers: answers({ severity: 0, effort: 0 }) }], ['critical', { answers: answers({ severity: 4, effort: 2 }) }],
    ['blocked', { answers: answers({ severity: 3, action: 'wait' }) }], ['busy', { answers: answers({ severity: 4 }) }]]);
  const ranked = rankTasks(tasks, analyses, [{ taskId: 'busy', state: 'running', createdAt: now() }], today);
  assert.deepEqual(ranked.map(item => item.taskId), ['critical', 'unrated', 'minor', 'busy', 'blocked']);
  assert.deepEqual(ranked.map(item => item.rank), [1, 2, 3, null, null]);
  assert.deepEqual(ranked[0].reasons, ['Critical severity', 'Fix', 'large effort', 'overdue 1d']);
  assert.equal(ranked.find(item => item.taskId === 'blocked').group, 'later');
});

test('Jev rates only new or changed issues, and stops at an authentication failure', async () => {
  const store = new Store(temporary('jev'));
  store.saveConfig({ ...defaults, jev: { apiKey: 'or-key', model: '', auto: true } });
  assert.equal(store.publicConfig().jev.hasKey, true); assert.equal(store.publicConfig().jev.apiKey, undefined, 'The key never goes back to the dashboard');
  for (const id of ['a', 'b', 'c']) store.put('task', id, { id, title: `Issue ${id}`, active: true, updatedAt: '2026-10-20 10:00', createdAt: now() });
  let asked = [];
  const jev = new Jev(store, { fetcher: async (url, options) => { asked.push(JSON.parse(options.body).state.title); return reply({ model: 'typesafe/jev-1.13', answers: answers() }); } });
  const first = await jev.prioritize();
  assert.equal(first.total, 3); assert.equal(asked.length, 3); assert.equal(first.ranking.filter(item => item.analyzed).length, 3);
  asked = []; assert.equal((await jev.prioritize()).total, 0, 'Unchanged issues are not asked again');
  store.put('task', 'b', { ...store.get('task', 'b'), updatedAt: '2026-10-26 09:00' });
  await jev.prioritize(); assert.deepEqual(asked, ['Issue b']);
  assert.equal(store.get('priority', 'b').fingerprint, taskFingerprint(store.get('task', 'b')));
  let calls = 0;
  const rejected = new Jev(store, { fetcher: async () => { calls++; return new Response('{"error":{"message":"Invalid key"}}', { status: 401 }); } });
  const failed = await rejected.prioritize({ force: true });
  assert.equal(failed.state, 'error'); assert.ok(calls <= 3, 'A rejected key does not keep calling');
  store.saveConfig({ ...store.publicConfig(), jev: { clearKey: true } });
  await assert.rejects(new Jev(store).prioritize(), /OpenRouter API key/);
  store.close();
});

test('agents type the saved test account through placeholders and never read the password back', async () => {
  const http = await import('node:http');
  const site = http.createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Sign in</title><input id="user"><input id="pass" type="password" oninput="document.getElementById(\'echo\').textContent=this.value"><p id="echo"></p>'); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const store = new Store(temporary('account'));
  store.saveConfig({ ...defaults, testAccount: { username: 'qa@example.invalid', password: 'S3cret-Test!' } });
  assert.deepEqual(store.publicConfig().testAccount, { username: 'qa@example.invalid', hasPassword: true, localUsername: '', hasLocalPassword: false });
  const desk = new Desk(store, { root: temporary('account-root'), runnerFactory: idle });
  store.put('task', 't', { id: 't', title: 'Login check', active: true });
  store.put('run', 'qa', { id: 'qa', role: 'verifier', taskId: 't', state: 'running', qaUrl: '', createdAt: now() });
  assert.match(desk.prompt(store.get('run', 'qa')), /\{\{test\.password\}\}/);
  try {
    await desk.evidence.action('qa', { action: 'open', url: `http://127.0.0.1:${site.address().port}/` });
    await assert.rejects(desk.evidence.action('qa', { action: 'fill', selector: '#user', value: '{{test.password}}' }), /only be typed into a password field/);
    await desk.evidence.action('qa', { action: 'fill', selector: '#user', value: '{{test.username}}' });
    const page = await desk.evidence.action('qa', { action: 'fill', selector: '#pass', value: '{{test.password}}' });
    assert.equal(page.text.includes('S3cret-Test!'), false, 'An echoed password is masked');
    assert.match(page.text, /\[test password\]/);
    assert.equal(store.events('qa').some(event => JSON.stringify(event).includes('S3cret-Test!')), false, 'The journal never records it');
  } finally { await desk.evidence.stopAll(); site.close(); store.close(); }
});

test('sync keeps "Development Completed" out by default, and exact statuses win when chosen', async () => {
  const { matchesTaskStatus } = await import('../src/providers.js');
  const task = (statusName, statusCategory) => ({ statusName, statusCategory });
  assert.equal(matchesTaskStatus(task('Request', '0')), true);
  assert.equal(matchesTaskStatus(task('Re-request', '0')), true);
  assert.equal(matchesTaskStatus(task('In Development', '1')), true);
  assert.equal(matchesTaskStatus(task('Development Completed', '1')), false, 'Done-sounding names in the In progress group wait for QA');
  assert.equal(matchesTaskStatus(task('Development Completed', '1'), 'unfinished'), true, 'All unfinished still includes them');
  assert.equal(matchesTaskStatus(task('In Development', '1'), 'active', ['Request', 'Re-request']), false, 'Exact statuses win');
  assert.equal(matchesTaskStatus(task('re-request', '0'), 'active', ['Re-request']), true);
});

test('a quiet browser saves its clip and closes, and the next action continues on the same page', async () => {
  const http = await import('node:http');
  const site = http.createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'seen=1' }); response.end(`<!doctype html><title>Page ${request.url}</title><p id="where">${request.url}</p><p id="cookie">${request.headers.cookie || 'none'}</p>`); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const store = new Store(temporary('idle')), desk = new Desk(store, { root: temporary('idle-root'), runnerFactory: idle });
  desk.evidence.idleMs = 300;
  store.put('task', 't', { id: 't', title: 'Idle', active: true });
  store.put('run', 'qa', { id: 'qa', role: 'verifier', taskId: 't', state: 'running', qaUrl: '', createdAt: now() });
  try {
    await desk.evidence.action('qa', { action: 'open', url: `http://127.0.0.1:${site.address().port}/first` });
    await desk.evidence.action('qa', { action: 'navigate', url: '/second' });
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(desk.evidence.sessions.has('qa'), false, 'The idle browser closed');
    assert.equal(store.list('artifact').filter(item => item.runId === 'qa' && item.type === 'video/webm').length, 1, 'Its clip was saved');
    const page = await desk.evidence.action('qa', { action: 'assertText', selector: '#where', expected: '/second' });
    assert.match(page.text, /seen=1/, 'Cookies carried over');
    await desk.evidence.close('qa');
    assert.equal(store.list('artifact').filter(item => item.runId === 'qa' && item.type === 'video/webm').length, 2, 'The continued work is a second clip');
  } finally { await desk.evidence.stopAll(); site.close(); store.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { TursoSync } from '../src/turso.js';
import { accountSignIn } from '../src/rexdesk-account.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const passphrase = 'correct horse battery';
const API = 'https://accounts.test';

// A stand-in for the Rex Desk account service: one person, one database, a new key on every ask.
function fakeAccounts() {
  const service = { calls: [], codes: new Map(), sessions: new Set(), keys: 0, signedOut: false, url: 'libsql://rd-test-person.example.invalid' };
  const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
  service.fetcher = async (url, options = {}) => {
    const route = `${options.method || 'GET'} ${String(url).replace(API, '')}`, token = (options.headers?.authorization || '').replace(/^Bearer /, '');
    service.calls.push(route);
    if (route === 'POST /desktop/exchange') {
      const { code, verifier } = JSON.parse(options.body), challenge = service.codes.get(code);
      service.codes.delete(code);
      if (!challenge || createHash('sha256').update(verifier).digest('base64url') !== challenge) return reply(400, { error: { code: 'bad_code', message: 'This sign-in code is wrong or too old. Start the sign-in again.' } });
      const made = `session-${service.sessions.size + 1}`; service.sessions.add(made);
      return reply(200, { token: made, expiresAt: new Date(Date.now() + 60 * 86400000).toISOString(), user: { id: 'u1', email: 'person@example.com', name: 'Test Person', image: null } });
    }
    if (!service.sessions.has(token)) return reply(401, { error: { code: 'signed_out', message: 'Your sign-in ended. Sign in to Rex Desk again.' } });
    if (route === 'POST /v1/sync/database') { service.keys += 1; return reply(200, { url: service.url, authToken: `database-key-${service.keys}`, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), database: 'rd-test-person', created: service.keys === 1 }); }
    if (route === 'DELETE /v1/session') { service.sessions.delete(token); return reply(200, { ok: true }); }
    return reply(404, { error: { code: 'not_found', message: 'There is nothing at this address.' } });
  };
  // What the browser does: the person signs in on the service's page, and it sends them back to this computer with a code.
  service.browser = async opened => {
    const link = new URL(opened), code = `code-${service.codes.size + 1}-${Date.now()}`;
    service.codes.set(code, link.searchParams.get('challenge'));
    return fetch(`http://127.0.0.1:${link.searchParams.get('port')}/?${new URLSearchParams({ code, state: link.searchParams.get('state') })}`);
  };
  return service;
}
function fakeTurso() {
  const remote = new DatabaseSync(':memory:'), seen = [];
  const clientFactory = connection => ({
    async batch(statements) {
      seen.push(connection.authToken); remote.exec('BEGIN');
      try { for (const statement of statements) typeof statement === 'string' ? remote.exec(statement) : remote.prepare(statement.sql).run(...statement.args); remote.exec('COMMIT'); }
      catch (error) { remote.exec('ROLLBACK'); throw error; }
    },
    async execute({ sql, args }) { seen.push(connection.authToken); return { rows: remote.prepare(sql).all(...args) }; },
    close() {},
  });
  return { remote, clientFactory, seen };
}
async function accountApp(root, options = {}) {
  const previous = process.env.REX_DATA_DIR; process.env.REX_DATA_DIR = root;
  try { return await createApp({ port: 0, ...options }); } finally { if (previous === undefined) delete process.env.REX_DATA_DIR; else process.env.REX_DATA_DIR = previous; }
}
function browser(app) {
  let cookie = '';
  return async (route, { method = 'GET', data } = {}) => {
    const response = await fetch(app.address + route, { method, headers: { 'x-rex-desk': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: response.status, body: await response.json() };
  };
}

test('the Rex Desk sign-in comes back to this computer only, and its code is useless without the secret made here', async () => {
  const service = fakeAccounts();
  const signIn = await accountSignIn({ timeoutMs: 5000, base: API, fetcher: service.fetcher });
  const opened = new URL(signIn.url);
  assert.equal(opened.origin + opened.pathname, `${API}/desktop/start`);
  assert.match(opened.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(opened.searchParams.get('state'), /^[A-Za-z0-9_-]{16,128}$/);
  const port = opened.searchParams.get('port');
  // A page that guesses the port but not the state gets nowhere.
  assert.equal((await fetch(`http://127.0.0.1:${port}/?code=stolen&state=wrong`)).status, 400);
  assert.deepEqual(service.calls, []);
  const page = await service.browser(signIn.url);
  assert.match(await page.text(), /close this tab/);
  const session = await signIn.session;
  assert.equal(session.user.email, 'person@example.com'); assert.equal(session.token, 'session-1');
  // The address in the browser never carried the sign-in itself.
  assert.doesNotMatch(signIn.url, /session-1/);
});

test('one sign-in turns cloud backup on: the account service makes the database, and no key is ever shown', async () => {
  const service = fakeAccounts(), turso = fakeTurso();
  const app = await accountApp(temporary('account-on'), { cloudClientFactory: turso.clientFactory, accountFetcher: service.fetcher, accountApi: API });
  const person = browser(app);
  try {
    await person('/api/auth/create', { method: 'POST', data: { email: 'person@example.com', passphrase } });
    assert.equal((await person('/api/database/account-finish', { method: 'POST' })).status, 400, 'finish needs a started sign-in');
    const started = await person('/api/database/account-start', { method: 'POST' });
    assert.equal(started.status, 200);
    const [finished] = await Promise.all([person('/api/database/account-finish', { method: 'POST' }), service.browser(started.body.url)]);
    assert.equal(finished.status, 200);
    assert.equal(finished.body.configured, true); assert.equal(finished.body.url, service.url); assert.equal(finished.body.created, true);
    assert.equal(finished.body.account.email, 'person@example.com');
    assert.ok(turso.seen.includes('database-key-1'), 'the backup connects with the key the account service gave');
    const state = await person('/api/state');
    assert.equal(state.body.database.account.email, 'person@example.com');
    assert.doesNotMatch(JSON.stringify([started.body, finished.body, state.body]), /session-1|database-key-/, 'neither the sign-in nor a database key reaches the screen');

    // Signing the account out ends it at the service and stops renewals; the backup itself stays connected.
    const out = await person('/api/database/account-signout', { method: 'POST' });
    assert.equal(out.body.account, null); assert.equal(out.body.configured, true);
    assert.equal(service.sessions.size, 0);
  } finally { await app.close(); }
});

test('a new computer finds the backup with the same Rex Desk sign-in, then opens it with the passphrase', async () => {
  const service = fakeAccounts(), turso = fakeTurso();
  const options = { cloudClientFactory: turso.clientFactory, accountFetcher: service.fetcher, accountApi: API };
  const first = await accountApp(temporary('account-first'), options), owner = browser(first);
  try {
    await owner('/api/auth/create', { method: 'POST', data: { email: 'person@example.com', passphrase } });
    const started = await owner('/api/database/account-start', { method: 'POST' });
    await Promise.all([owner('/api/database/account-finish', { method: 'POST' }), service.browser(started.body.url)]);
    await owner('/api/database/sync', { method: 'POST' });
  } finally { await first.close(); }

  const second = await accountApp(temporary('account-second'), options), visitor = browser(second);
  try {
    assert.equal((await visitor('/api/auth/cloud', { method: 'POST', data: { account: '1', email: 'person@example.com', passphrase } })).status, 400, 'the account sign-in comes first');
    const started = await visitor('/api/auth/account-start', { method: 'POST', data: {} });
    const [found] = await Promise.all([visitor('/api/auth/account-finish', { method: 'POST', data: {} }), service.browser(started.body.url)]);
    assert.deepEqual(found.body, { found: true, email: 'person@example.com' });
    // The account finds the database; only the passphrase opens what is in it.
    assert.notEqual((await visitor('/api/auth/cloud', { method: 'POST', data: { account: '1', email: 'person@example.com', passphrase: 'not the passphrase' } })).status, 200);
    const restarted = await visitor('/api/auth/account-start', { method: 'POST', data: {} });
    await Promise.all([visitor('/api/auth/account-finish', { method: 'POST', data: {} }), service.browser(restarted.body.url)]);
    const opened = await visitor('/api/auth/cloud', { method: 'POST', data: { account: '1', email: 'person@example.com', passphrase } });
    assert.equal(opened.status, 200); assert.equal(opened.body.current.email, 'person@example.com');
    const state = await visitor('/api/state');
    assert.equal(state.body.database.configured, true); assert.equal(state.body.database.url, service.url);
    assert.equal(state.body.database.account.email, 'person@example.com', 'the new computer keeps the sign-in, so it can renew its key');
  } finally { await second.close(); }
});

test('the database key is renewed before it runs out, and a sign-in that ended says so instead of failing quietly', async () => {
  const service = fakeAccounts(), turso = fakeTurso();
  const store = new Store(temporary('account-renew'));
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 3600000, accountFetcher: service.fetcher, accountApi: API });
  try {
    service.sessions.add('session-kept');
    const soon = new Date(Date.now() + 2 * 86400000).toISOString(), later = new Date(Date.now() + 25 * 86400000).toISOString();
    await store.cloud.connect({ url: service.url, authToken: 'old-key' });
    // Plenty of time left: nothing is asked.
    store.cloud.account.save({ token: 'session-kept', expiresAt: later, user: { email: 'person@example.com' } }, { url: service.url, expiresAt: later });
    await store.cloud.open();
    assert.equal(service.keys, 0); assert.equal(store.cloud.connection.authToken, 'old-key');
    // Two days left: the next connection takes a fresh key and uses it.
    store.cloud.account.save({ token: 'session-kept', expiresAt: later, user: { email: 'person@example.com' } }, { url: service.url, expiresAt: soon });
    await store.cloud.open();
    assert.equal(service.keys, 1); assert.equal(store.cloud.connection.authToken, 'database-key-1');
    assert.equal(turso.seen.at(-1), 'database-key-1');
    assert.ok(new Date(store.cloud.status().account.keyExpiresAt).getTime() > Date.now() + 20 * 86400000);
    // A backup pointed at another database is the person's own business: its key is never replaced.
    await store.cloud.connect({ url: 'libsql://someone-elses.example.invalid', authToken: 'their-own-key' });
    store.cloud.account.saved.keyExpiresAt = soon; store.cloud.account.lastTry = 0;
    await store.cloud.open();
    assert.equal(service.keys, 1); assert.equal(store.cloud.connection.authToken, 'their-own-key');

    // The account was signed out everywhere: renewal stops, and the status says what to do.
    await store.cloud.connect({ url: service.url, authToken: 'database-key-1' });
    service.sessions.clear(); store.cloud.account.saved.keyExpiresAt = soon; store.cloud.account.lastTry = 0;
    await store.cloud.open();
    assert.equal(store.cloud.status().account, null);
    assert.match(store.cloud.status().accountNote, /sign-in ended/);
  } finally { await store.cloud.close(); store.close(); }
});

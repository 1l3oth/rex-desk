import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const passphrase = 'correct horse battery';
// An in-memory stand-in for one person's Turso database, shared by two "computers".
function fakeTurso() {
  const remote = new DatabaseSync(':memory:');
  const clientFactory = () => ({
    async batch(statements) {
      remote.exec('BEGIN');
      try { for (const statement of statements) typeof statement === 'string' ? remote.exec(statement) : remote.prepare(statement.sql).run(...statement.args); remote.exec('COMMIT'); }
      catch (error) { remote.exec('ROLLBACK'); throw error; }
    },
    async execute({ sql, args }) { return { rows: remote.prepare(sql).all(...args) }; },
    close() {},
  });
  return { remote, clientFactory };
}
// Account mode is what a plain start uses: REX_DATA_DIR without an explicit data folder.
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

test('accounts gate the dashboard, the first account is superadmin, and each account sees only its own cloud backup', async () => {
  const app = await accountApp(temporary('accounts'));
  const admin = browser(app), member = browser(app);
  try {
    const first = await admin('/api/auth');
    assert.equal(first.body.mode, 'accounts'); assert.equal(first.body.current, null);
    assert.equal((await admin('/api/state')).status, 401);
    assert.equal((await admin('/api/auth/create', { method: 'POST', data: { email: 'Owner@Example.com', passphrase: 'short' } })).status, 400);
    const created = await admin('/api/auth/create', { method: 'POST', data: { email: 'Owner@Example.com', passphrase } });
    assert.equal(created.body.current.email, 'owner@example.com'); assert.equal(created.body.current.role, 'superadmin');
    const state = await admin('/api/state');
    assert.equal(state.status, 200); assert.equal(state.body.account.role, 'superadmin'); assert.ok(state.body.database);
    assert.equal(existsSync(path.join(app.accounts.directory(app.accounts.byEmail('owner@example.com')), 'vault.key')), false, 'Only the sealed key is stored');
    assert.ok(!readFileSync(app.accounts.file, 'utf8').includes(passphrase));

    const joined = await member('/api/auth/create', { method: 'POST', data: { email: 'qa@example.com', passphrase } });
    assert.equal(joined.body.current.role, 'member');
    assert.equal((await admin('/api/state')).status, 401, 'Opening another account signs the previous window out');
    const memberState = await member('/api/state');
    assert.equal(memberState.body.database.configured, false, 'a new account starts with no backup of its own');
    assert.equal(memberState.body.database.state, 'local');
    assert.notEqual((await member('/api/database/sync', { method: 'POST' })).status, 403, 'a member may manage its own backup');

    assert.match((await admin('/api/auth/login', { method: 'POST', data: { email: 'owner@example.com', passphrase: 'wrong passphrase' } })).body.error, /password is wrong/);
    assert.equal((await admin('/api/auth/login', { method: 'POST', data: { email: 'owner@example.com', passphrase } })).body.current.role, 'superadmin');
    assert.equal((await admin('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.equal((await admin('/api/state')).status, 401);
  } finally { await app.close(); }
});

test('an existing single-folder workspace is claimed with an email and keeps its data', async () => {
  const root = temporary('legacy');
  const legacy = new Store(root); legacy.put('task', 'task-1', { id: 'task-1', title: 'Kept after claiming', active: true }); legacy.close();
  const app = await accountApp(root), client = browser(app);
  try {
    const { workspaces } = (await client('/api/auth')).body;
    assert.equal(workspaces.length, 1); assert.equal(workspaces[0].claimed, false);
    const claimed = await client('/api/auth/login', { method: 'POST', data: { email: 'owner@example.com', passphrase, claimId: workspaces[0].id } });
    assert.equal(claimed.body.current.role, 'superadmin');
    assert.equal(existsSync(path.join(root, 'vault.key')), false);
    assert.ok((await client('/api/state')).body.tasks.some(task => task.title === 'Kept after claiming'));
  } finally { await app.close(); }
});

test('cloud backup comes only with a Rex Desk account: a typed database address, or an own Turso account, is refused', async () => {
  const app = await accountApp(temporary('account-only'), { cloudClientFactory: fakeTurso().clientFactory }), client = browser(app);
  try {
    await client('/api/auth/create', { method: 'POST', data: { email: 'owner@example.com', passphrase } });
    for (const route of ['/api/database/connect', '/api/database/turso-start']) {
      const reply = await client(route, { method: 'POST', data: { url: 'libsql://mine.example.invalid', authToken: 'mine' } });
      assert.notEqual(reply.status, 200, route); assert.match(reply.body.error, /comes with your Rex Desk account/);
    }
    assert.equal(app.store.cloud.enabled, false, 'nothing was connected');
    await client('/api/auth/logout', { method: 'POST' });
    const typed = await client('/api/auth/cloud', { method: 'POST', data: { url: 'libsql://mine.example.invalid', authToken: 'mine', email: 'owner@example.com', passphrase } });
    assert.match(typed.body.error, /comes with your Rex Desk account/);
  } finally { await app.close(); }
});

// The sync itself, with a database of the owner's own (only allowed with REX_DESK_OWN_DATABASE=1 now).
test('the same account opens on another computer from its own Turso database and both computers stay in step', async () => {
  const turso = fakeTurso(), url = 'libsql://owner-db.example.invalid', authToken = 'owner-token';
  const home = await accountApp(temporary('home'), { cloudClientFactory: turso.clientFactory, ownDatabase: true }), atHome = browser(home);
  await atHome('/api/auth/create', { method: 'POST', data: { email: 'owner@example.com', passphrase } });
  home.store.put('task', 'task-home', { id: 'task-home', title: 'Created at home', active: true });
  assert.equal((await atHome('/api/database/connect', { method: 'POST', data: { url, authToken } })).body.state, 'connected');
  await atHome('/api/auth/logout', { method: 'POST' });
  await home.close();

  const work = await accountApp(temporary('work'), { cloudClientFactory: turso.clientFactory, ownDatabase: true }), atWork = browser(work);
  try {
    assert.match((await atWork('/api/auth/cloud', { method: 'POST', data: { url, authToken, email: 'owner@example.com', passphrase: 'wrong passphrase' } })).body.error, /password is wrong/);
    const opened = await atWork('/api/auth/cloud', { method: 'POST', data: { url, authToken, email: 'owner@example.com', passphrase } });
    assert.equal(opened.body.current.role, 'superadmin');
    assert.ok((await atWork('/api/state')).body.tasks.some(task => task.id === 'task-home'), 'Work restores what was done at home');
    work.store.put('task', 'task-work', { id: 'task-work', title: 'Created at work', active: true });
    await atWork('/api/auth/logout', { method: 'POST' });
  } finally { await work.close(); }

  const again = await accountApp(home.accounts.root, { cloudClientFactory: turso.clientFactory }), backHome = browser(again);
  try {
    await backHome('/api/auth/login', { method: 'POST', data: { email: 'owner@example.com', passphrase } });
    const tasks = (await backHome('/api/state')).body.tasks.map(task => task.id);
    assert.ok(tasks.includes('task-work'), 'Home picks up what was done at work');
  } finally { await again.close(); }
});

test('the Tailscale https address (tailscale serve) is treated like another device: it needs the device key', async () => {
  const http = await import('node:http');
  const app = await accountApp(temporary('tsnet'));
  const owner = browser(app);
  const ask = (route, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(app.address + route, { headers: { Host: 'mylaptop.tail1234.ts.net', 'x-rex-desk': '1', ...headers } }, response => { response.resume(); resolve({ status: response.statusCode, location: response.headers.location }); });
    request.on('error', reject); request.end();
  });
  try {
    await owner('/api/auth/create', { method: 'POST', data: { email: 'owner@example.com', passphrase } });
    assert.equal((await ask('/api/state')).status, 401, 'no key, no data');
    assert.equal((await ask('/')).location, '/login', 'the page asks for the key');
    assert.equal((await ask('/manifest.webmanifest')).status, 200, 'what installing needs is open');
    const key = app.desk.peers.key();
    assert.equal((await ask('/api/state', { 'x-rex-peer-key': key })).status, 200, 'with the key it works');
  } finally { await app.close(); }
});

test('a phone through the relay waits for its 6-digit code to be approved on the desk, and cannot approve itself', async () => {
  const http = await import('node:http');
  const app = await accountApp(temporary('phone-relay'));
  const owner = browser(app);
  const ask = (route, headers = {}, method = 'GET', data) => new Promise((resolve, reject) => {
    const request = http.request(app.address + route, { method, headers: { Host: 'node-1.relay.rexdesk.dev', 'x-rex-desk': '1', 'x-rex-relay': app.desk.phoneRelay.secret, 'x-rex-relay-device': 'phone-1', 'x-rex-relay-name': 'Pixel', 'x-rex-relay-account': 'user-2', ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text: raw }));
    });
    request.on('error', reject); request.end(data ? JSON.stringify(data) : undefined);
  });
  try {
    await owner('/api/auth/create', { method: 'POST', data: { email: 'owner@example.com', passphrase } });
    // The line also stays up to sync the account's other computers (L88): with the phone switch off, no phone comes in.
    assert.equal((await ask('/api/state')).status, 503, 'the phone link is off');
    app.desk.phoneRelay.save({ enabled: true });
    const waiting = await ask('/');
    const code = /(\d{3}) (\d{3})/.exec(waiting.text)?.slice(1).join('');
    assert.match(code, /^\d{6}$/, 'the phone shows a 6-digit code');
    assert.equal((await ask('/api/state')).status, 403, 'no data before the OK');
    assert.equal((await ask('/api/state', { 'x-rex-relay': 'forged' })).status, 403, 'a forged relay mark is turned away');
    assert.equal((await ask('/api/phone-relay', {}, 'POST', { action: 'approve', device: 'phone-1', code })).status, 403, 'the phone cannot approve itself');
    const listed = await owner('/api/phone-relay');
    assert.equal(listed.body.pending[0].code, code, 'the desk shows the same code');
    assert.ok(!JSON.stringify(listed.body).includes('phone-1'), 'the desk lists a reference, never the phone id');
    await owner('/api/phone-relay', { method: 'POST', data: { action: 'approve', device: listed.body.pending[0].id, code } });
    assert.equal((await ask('/api/state')).status, 200, 'after the OK the phone gets in');
    assert.equal((await ask('/api/state', { 'x-rex-relay-device': 'phone-2' })).status, 403, 'another phone still waits');
    assert.equal((await ask('/api/state', { 'x-rex-relay-account': 'user-3' })).status, 403, 'the approved phone id under another account waits for its own code');
    assert.equal((await ask('/api/state', { 'x-rex-relay-account': '' })).status, 400, 'a phone the relay names no account for is refused');
    // Signed in to the desk's own account (the relay says so in WELCOME and in the request): no code at all.
    app.desk.phoneRelay.account = 'user-1';
    assert.equal((await ask('/api/state', { 'x-rex-relay-device': 'phone-3', 'x-rex-relay-account': 'user-1' })).status, 200, 'a phone on the same account gets straight in');
    assert.equal((await ask('/api/state', { 'x-rex-relay-device': 'phone-4', 'x-rex-relay-account': 'user-2' })).status, 403, 'another account still waits for the code');
  } finally { await app.close(); }
});

test('stay signed in opens only a window holding the window key, never any program that asks', async () => {
  const root = temporary('window-key');
  const app = await accountApp(root, { requireAccount: false });
  const call = (route, { method = 'GET', data, cookie = '' } = {}) => fetch(app.address + route, { method, redirect: 'manual', headers: { 'x-rex-desk': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const cookies = response => (response.headers.getSetCookie?.() || []).map(item => item.split(';')[0]);
  try {
    const created = await call('/api/auth/create', { method: 'POST', data: { email: 'owner@example.com', passphrase, staySignedIn: true } });
    assert.equal(created.status, 200);
    // Signing in with the passphrase gives this browser the window key as well as the session.
    const given = cookies(created);
    assert.ok(given.some(item => item.startsWith('rex_session=')) && given.some(item => item.startsWith('rex_window=')));
    const key = readFileSync(path.join(root, 'window.key'), 'utf8').trim();
    assert.ok(key.length >= 32);
    // Another program (or Windows user) asking without the key gets no session.
    const stranger = await call('/api/auth');
    assert.deepEqual(cookies(stranger), []); assert.equal((await stranger.json()).current, null);
    assert.equal((await call('/api/auth', { cookie: 'rex_window=wrong-key-wrong-key-wrong-key-wrong' })).headers.getSetCookie().length, 0);
    // The desktop app opens /?window=<key>: the key becomes a cookie and leaves the address.
    const opened = await call(`/?window=${key}`);
    assert.equal(opened.status, 303); assert.equal(opened.headers.get('location'), '/');
    const windowCookie = cookies(opened).find(item => item.startsWith('rex_window='));
    assert.equal(windowCookie, `rex_window=${key}`);
    assert.deepEqual(cookies(await call('/?window=guess')), []);
    // With the key, the window is signed in without the passphrase.
    const handed = await call('/api/auth', { cookie: windowCookie });
    const session = cookies(handed).find(item => item.startsWith('rex_session='));
    assert.ok(session); assert.equal((await handed.json()).current.email, 'owner@example.com');
    assert.equal((await call('/api/agents', { cookie: session })).status, 200);
  } finally { await app.close(); }
});

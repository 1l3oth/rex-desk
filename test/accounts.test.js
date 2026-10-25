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

test('accounts gate the dashboard, the first account is superadmin, and only a superadmin sees the cloud database', async () => {
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
    assert.equal(memberState.body.database, null);
    assert.equal((await member('/api/database/connect', { method: 'POST', data: { url: 'libsql://x.example.invalid', authToken: 'secret' } })).status, 403);

    assert.match((await admin('/api/auth/login', { method: 'POST', data: { email: 'owner@example.com', passphrase: 'wrong passphrase' } })).body.error, /incorrect/);
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

test('the same account opens on another computer from its own Turso database and both computers stay in step', async () => {
  const turso = fakeTurso(), url = 'libsql://owner-db.example.invalid', authToken = 'owner-token';
  const home = await accountApp(temporary('home'), { cloudClientFactory: turso.clientFactory }), atHome = browser(home);
  await atHome('/api/auth/create', { method: 'POST', data: { email: 'owner@example.com', passphrase } });
  home.store.put('task', 'task-home', { id: 'task-home', title: 'Created at home', active: true });
  assert.equal((await atHome('/api/database/connect', { method: 'POST', data: { url, authToken } })).body.state, 'connected');
  await atHome('/api/auth/logout', { method: 'POST' });
  await home.close();

  const work = await accountApp(temporary('work'), { cloudClientFactory: turso.clientFactory }), atWork = browser(work);
  try {
    assert.match((await atWork('/api/auth/cloud', { method: 'POST', data: { url, authToken, email: 'owner@example.com', passphrase: 'wrong passphrase' } })).body.error, /incorrect/);
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

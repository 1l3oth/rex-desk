import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { AccountLink } from '../src/rexdesk-account.js';
import { FileBackup } from '../src/file-backup.js';

const API = 'https://accounts.example.invalid', URL_DB = 'libsql://rd-home.example.invalid';
const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

// The account service: the database lookup and the private file folder. getError makes every download answer with that error.
function service({ files = new Map(), databaseUrl = URL_DB, getError = null } = {}) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const route = `${options.method || 'GET'} ${String(url).replace(API, '')}`; calls.push(route);
    if (route === 'POST /v1/sync/database') return reply(200, { url: databaseUrl, authToken: 'key', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const file = route.match(/^(GET|PUT) \/v1\/files\/(.+)$/);
    if (!file) return reply(404, { error: { code: 'not_found', message: 'Nothing here.' } });
    const key = file[2].split('/').map(decodeURIComponent).join('/');
    if (file[1] === 'PUT') { if (getError?.code === 'too_big') return reply(413, { error: getError }); files.set(key, Buffer.from(options.body)); return reply(200, {}); }
    if (getError) return reply(getError.status || 413, { error: getError });
    const bytes = files.get(key); if (!bytes) return reply(404, { error: { code: 'not_found', message: 'Not in your backup.' } });
    return { status: 200, ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  return { calls, files, fetcher };
}

// A workspace signed in to its Rex Desk account the way signing in to the app saves it: the account only, no database url,
// while cloud backup runs on the account's own database (the home computer of the big file download bug).
function home({ fake, saveUrl = '', rows = [], off = false }) {
  const store = new Store(temporary('files-home'));
  if (off) store.put('backup', 'parts', { id: 'parts', files: false });
  const account = new AccountLink(store, { fetcher: fake.fetcher, base: API });
  account.save({ token: 'session', expiresAt: new Date(Date.now() + 86400000).toISOString(), user: { id: 'u1' } }, { url: saveUrl });
  const client = { execute: async () => ({ rows }) };
  const sync = { store, client, workspace: 'w1', account, ready: true, connection: { url: URL_DB } };
  sync.files = new FileBackup(sync);
  return { store, account, files: sync.files, sync };
}
const KEY = 'data/artifacts/run-1/screen-all.png';

test('a big file in the account folder comes down even when the sign-in was saved without its database, and the database is adopted', async () => {
  const fake = service();
  const { store, account, files } = home({ fake });
  const picture = Buffer.alloc(14 * 1024 * 1024, 7);
  fake.files.set(`w1/${KEY}`, Buffer.from(store.encryptBytes(picture), 'base64'));
  assert.equal(files.hosted(), false, 'the saved sign-in has no database url, as on home');
  assert.equal(await files.fetchOne(KEY), true);
  const local = path.join(store.media('artifacts'), 'run-1', 'screen-all.png');
  assert.ok(existsSync(local) && readFileSync(local).equals(picture), 'the whole 14 MB file arrived');
  assert.equal(account.saved.url, URL_DB, 'the account database was adopted');
  assert.equal(files.hosted(), true);
  assert.equal(files.why(KEY), null);
});

test('a database of the person\'s own is never adopted as the account one', async () => {
  const fake = service({ databaseUrl: 'libsql://rd-someone-else.example.invalid' });
  const { account } = home({ fake });
  assert.equal(await account.adoptDatabase({ url: URL_DB }), false);
  assert.equal(account.saved.url, '');
  assert.equal(await account.adoptDatabase({ url: URL_DB }), false, 'not asked again within ten minutes');
  assert.equal(fake.calls.filter(call => call === 'POST /v1/sync/database').length, 1);
});

test('a sign-in that changes while the database is looked up never gets the old account\'s database, and no file goes up', async () => {
  const fake = service();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async (url, options = {}) => {
    if (String(url).endsWith('/v1/sync/database')) await gate;
    return fake.fetcher(url, options);
  };
  const { store, account, files } = home({ fake: { ...fake, fetcher } });
  mkdirSync(path.join(store.media('artifacts'), 'run-1'), { recursive: true });
  writeFileSync(path.join(store.media('artifacts'), 'run-1', 'screen-all.png'), 'picture');
  const running = files.backup();
  await new Promise(resolve => setImmediate(resolve));
  // Another account signs in while the old one's database is being looked up.
  account.save({ token: 'session-2', expiresAt: new Date(Date.now() + 86400000).toISOString(), user: { id: 'u2' } }, { url: '' });
  release();
  const result = await running;
  assert.equal(result.uploaded, 0);
  assert.equal(account.saved.token, 'session-2');
  assert.equal(account.saved.url, '', 'the old account\'s database was not attached to the new sign-in');
  assert.equal(files.hosted(), false);
  assert.equal(fake.calls.filter(call => call.startsWith('PUT ')).length, 0, 'no file was uploaded');
  const reread = new AccountLink(store, { fetcher, base: API });
  assert.equal(reread.saved.token, 'session-2'); assert.equal(reread.saved.url, '', 'nor written to disk');
});

test('a fresh key looked up for an account that was switched meanwhile is dropped, and its sign-in end never signs out the new one', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async () => { await gate; return reply(401, { error: { code: 'unauthorized', message: 'Signed out.' } }); };
  const store = new Store(temporary('files-key'));
  const account = new AccountLink(store, { fetcher, base: API });
  account.save({ token: 'session', user: { id: 'u1' } }, { url: URL_DB });
  const asking = account.freshKey();
  account.save({ token: 'session-2', user: { id: 'u2' } }, { url: URL_DB });
  release();
  assert.equal(await asking, null);
  assert.equal(account.saved?.token, 'session-2', 'the new sign-in stays');
});

test('a file request whose sign-in ended after the account was switched never signs out the new account', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async () => { await gate; return reply(401, { error: { code: 'unauthorized', message: 'Signed out.' } }); };
  const store = new Store(temporary('files-401'));
  const account = new AccountLink(store, { fetcher, base: API });
  account.save({ token: 'session', user: { id: 'u1' } }, { url: URL_DB });
  const asking = account.putFile('w1/a.txt', Buffer.from('a'));
  account.save({ token: 'session-2', user: { id: 'u2' } }, { url: URL_DB });
  release();
  await assert.rejects(asking);
  assert.equal(account.saved?.token, 'session-2', 'the new sign-in stays');
  assert.equal(account.ended, undefined);
});

test('a file that does not come says why: not in the backup, too big, failed, not connected, or left out', async () => {
  let fake = service(), setup = home({ fake });
  assert.equal(await setup.files.fetchOne(KEY), false);
  assert.equal(setup.files.why(KEY).reason, 'not-in-backup');

  fake = service({ getError: { code: 'too_big', message: 'That file is over the size the account service takes.' } }); setup = home({ fake });
  assert.equal(await setup.files.fetchOne(KEY), false);
  assert.deepEqual(setup.files.why(KEY), { reason: 'too-big', detail: 'That file is over the size the account service takes.' });

  fake = service({ getError: { code: 'down', message: 'The service is down.', status: 500 } }); setup = home({ fake });
  assert.equal(await setup.files.fetchOne(KEY), false);
  assert.deepEqual(setup.files.why(KEY), { reason: 'failed', detail: 'The service is down.' });

  fake = service(); setup = home({ fake }); setup.sync.ready = false;
  assert.equal(await setup.files.fetchOne(KEY), false);
  assert.equal(setup.files.why(KEY).reason, 'not-connected');

  fake = service(); setup = home({ fake, off: true });
  assert.equal(await setup.files.fetchOne(KEY), false);
  assert.equal(setup.files.why(KEY).reason, 'off');

  // A file kept in the database (a backup of the person's own) still comes from there.
  fake = service(); setup = home({ fake, rows: [{ data: '' }] });
  setup.sync.client = { execute: async () => ({ rows: [{ data: setup.store.encryptBytes(Buffer.from('hello')) }] }) };
  assert.equal(await setup.files.fetchOne(KEY), true);
  assert.equal(setup.files.why(KEY), null, 'a file that came clears its reason');
});

test('a file the account service will not take is skipped, never counted as backed up, and not sent again until it changes', async () => {
  const fake = service({ getError: { code: 'too_big', message: 'Too big.' } });
  const { store, files } = home({ fake, saveUrl: URL_DB });
  const folder = path.join(store.media('artifacts'), 'run-1'); mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'screen-all.png'), Buffer.alloc(1024, 1));
  await files.backup();
  const index = JSON.parse(readFileSync(files.indexFile, 'utf8'));
  assert.equal(index.files[KEY], undefined, 'not recorded as in the cloud');
  assert.ok(index.skipped[KEY], 'recorded as skipped');
  const puts = () => fake.calls.filter(call => call.startsWith('PUT')).length, before = puts();
  await files.backup();
  assert.equal(puts(), before, 'not tried again while it is unchanged');
});

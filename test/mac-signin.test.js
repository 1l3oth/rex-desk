import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Accounts } from '../src/accounts.js';
import { createKeychain } from '../src/keychain.js';

// Mac sign-in problems: after any restart of Rex Desk the person was asked to sign in again (a Mac kept no "stay signed in"),
// and the wait for the browser sign-in was one request of up to 4.5 minutes, which a Mac's webview cuts at about a minute,
// so the window showed an error and started the browser again, round and round. These tests stand in for the Mac.
const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

// Apple's `security` tool, as far as Rex Desk uses it: add (-U updates), find (-w prints the password), delete; exit code 44 when
// the item is not there, and a different failure when the Keychain is locked.
function fakeSecurity() {
  const items = new Map(), calls = [];
  const fake = { items, calls, locked: false };
  fake.exec = async (command, args) => {
    calls.push([command, ...args]);
    assert.equal(command, '/usr/bin/security');
    const flag = name => args[args.indexOf(name) + 1], key = `${flag('-s')}\u0000${flag('-a')}`;
    if (fake.locked) throw Object.assign(new Error('User interaction is not allowed.'), { code: 36 });
    if (args[0] === 'add-generic-password') { items.set(key, flag('-w')); return { stdout: '' }; }
    if (args[0] === 'find-generic-password') { if (!items.has(key)) throw Object.assign(new Error('The specified item could not be found in the keychain.'), { code: 44 }); return { stdout: `${items.get(key)}\n` }; }
    if (args[0] === 'delete-generic-password') { if (!items.delete(key)) throw Object.assign(new Error('not found'), { code: 44 }); return { stdout: '' }; }
    throw new Error(`unexpected ${args[0]}`);
  };
  return fake;
}

test('on a Mac, "stay signed in" survives a restart: the vault key goes into the login Keychain and comes back', async () => {
  const mac = fakeSecurity(), root = temporary('mac-accounts'), keychain = createKeychain({ exec: mac.exec });
  const first = new Accounts(root, { platform: 'darwin', keychain });
  assert.equal(first.canRemember, true);
  const { entry, vaultKey } = first.create('mac@example.com', 'correct horse battery');
  await first.remember(entry.id, vaultKey);
  assert.equal(first.workspaces[0].remembered, 'keychain', 'accounts.json holds only a marker, never the key');
  assert.ok(!JSON.stringify(first.workspaces).includes(vaultKey.toString('base64')));
  // Rex Desk restarts (an update, a slow wake): a new Accounts object on the same folder reopens the desk by itself.
  const second = new Accounts(root, { platform: 'darwin', keychain });
  const back = await second.rememberedSession();
  assert.equal(back.entry.id, entry.id);
  assert.ok(back.vaultKey.equals(vaultKey), 'the same key comes back');
  // Signing out forgets it everywhere.
  second.forget(entry.id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(mac.items.size, 0, 'the Keychain item is deleted');
  assert.equal(await new Accounts(root, { platform: 'darwin', keychain }).rememberedSession(), null);
});

test('a locked Keychain keeps "stay signed in" for the next start; a missing item forgets it', async () => {
  const mac = fakeSecurity(), root = temporary('mac-locked'), keychain = createKeychain({ exec: mac.exec });
  const first = new Accounts(root, { platform: 'darwin', keychain });
  const { entry, vaultKey } = first.create('mac@example.com', 'correct horse battery');
  await first.remember(entry.id, vaultKey);
  // Right after login the Keychain may still be locked: no sign-in screen is forced, and the choice is kept.
  mac.locked = true;
  const locked = new Accounts(root, { platform: 'darwin', keychain });
  assert.equal(await locked.rememberedSession(), null);
  assert.equal(locked.workspaces[0].remembered, 'keychain', 'kept for the next start');
  mac.locked = false;
  assert.ok((await locked.rememberedSession()).vaultKey.equals(vaultKey), 'works once the Keychain is open');
  // The Keychain was cleaned: nothing to wait for, so the choice is dropped (the person signs in once, then it is kept again).
  mac.items.clear();
  assert.equal(await locked.rememberedSession(), null);
  assert.equal(locked.workspaces[0].remembered, undefined);
});

test('a computer that cannot keep a sign-in says so instead of pretending', async () => {
  const root = temporary('linux-accounts'), accounts = new Accounts(root, { platform: 'linux' });
  assert.equal(accounts.canRemember, false);
  const { entry, vaultKey } = accounts.create('linux@example.com', 'correct horse battery');
  await assert.rejects(accounts.remember(entry.id, vaultKey), /Windows and macOS/);
});

// A stand-in for the Rex Desk account service.
const API = 'https://accounts.test';
function fakeService() {
  const service = { codes: new Map() };
  const reply = (status, data) => ({ status, ok: status < 300, json: async () => data });
  service.fetcher = async (url, options = {}) => {
    const route = `${options.method || 'GET'} ${String(url).replace(API, '')}`;
    if (route === 'POST /desktop/exchange') {
      const { code, verifier } = JSON.parse(options.body), challenge = service.codes.get(code);
      if (!challenge || createHash('sha256').update(verifier).digest('base64url') !== challenge) return reply(400, { error: { message: 'bad code' } });
      return reply(200, { token: 'session-1', expiresAt: new Date(Date.now() + 60 * 86400000).toISOString(), user: { id: 'u1', email: 'person@example.com', name: 'Test Person', image: null } });
    }
    if (route === 'GET /v1/me') return reply(200, { user: { id: 'u1', email: 'person@example.com' }, plan: 'free', sync: { on: false } });
    return reply(404, { error: { message: 'nothing here' } });
  };
  service.browser = async opened => {
    const link = new URL(opened), code = `code-${service.codes.size + 1}`;
    service.codes.set(code, link.searchParams.get('challenge'));
    return fetch(`http://127.0.0.1:${link.searchParams.get('port')}/?${new URLSearchParams({ code, state: link.searchParams.get('state') })}`);
  };
  return service;
}

test('the wait for the browser sign-in is asked short and repeated, never one request a Mac would cut off', async () => {
  process.env.REX_SIGNIN_POLL_MS = '150';
  const { createApp: freshApp } = await import(`../src/server.js?short-${Date.now()}`);
  const service = fakeService(), root = temporary('mac-door');
  const previous = process.env.REX_DATA_DIR; process.env.REX_DATA_DIR = root;
  let app; try { app = await freshApp({ port: 0, requireAccount: true, accountFetcher: service.fetcher, accountApi: API }); } finally { if (previous === undefined) delete process.env.REX_DATA_DIR; else process.env.REX_DATA_DIR = previous; }
  const ask = (route, data) => fetch(app.address + route, { method: 'POST', headers: { 'x-rex-desk': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }).then(async reply => ({ status: reply.status, body: await reply.json() }));
  try {
    const started = await ask('/api/auth/account-start');
    assert.equal(started.status, 200);
    // The person has not finished in the browser yet: the answer comes back at once with "waiting", and the sign-in stays open.
    const startedAt = Date.now();
    const waiting = await ask('/api/auth/account-finish');
    assert.deepEqual(waiting.body, { waiting: true });
    assert.ok(Date.now() - startedAt < 2000, 'answered within the short wait');
    assert.deepEqual((await ask('/api/auth/account-finish')).body, { waiting: true }, 'and again: still the same open sign-in');
    // The browser finishes while the window is asking again: the next answer carries the sign-in.
    const [found] = await Promise.all([ask('/api/auth/account-finish'), service.browser(started.body.url)]);
    assert.equal(found.status, 200);
    assert.equal(found.body.email, 'person@example.com');
    // Done: a further question has no open sign-in to wait for.
    assert.equal((await ask('/api/auth/account-finish')).status, 400);
  } finally { await app.close(); delete process.env.REX_SIGNIN_POLL_MS; }
});

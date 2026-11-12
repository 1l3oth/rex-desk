import test from 'node:test';
import assert from 'node:assert/strict';
import { tursoSignIn, provisionDatabase } from '../src/turso-setup.js';

const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test("Turso's sign-in page hands its key back to a local address, and a wrong state is ignored", async () => {
  const signIn = await tursoSignIn({ timeoutMs: 5000 });
  const opened = new URL(signIn.url);
  assert.equal(opened.origin, 'https://api.turso.tech');
  assert.equal(opened.searchParams.get('type'), 'cli');
  const port = opened.searchParams.get('port'), state = opened.searchParams.get('state');
  assert.equal((await fetch(`http://localhost:${port}/?state=wrong&jwt=x`)).status, 400);
  const page = await fetch(`http://localhost:${port}/?state=${state}&jwt=platform-key`);
  assert.match(await page.text(), /close this tab/);
  assert.equal(await signIn.token, 'platform-key');
});

test("Turso's newer sign-in page may drop the state on the way back, and the key is still taken", async () => {
  const signIn = await tursoSignIn({ timeoutMs: 5000 });
  const port = new URL(signIn.url).searchParams.get('port');
  const page = await fetch(`http://localhost:${port}/?jwt=platform-key`);
  assert.equal(page.status, 200);
  assert.equal(await signIn.token, 'platform-key');
});

test('a new Turso account gets a group near this computer, a rex-desk database and a key for it', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url.replace('https://api.turso.tech', '')}`);
    assert.ok(url === 'https://region.turso.io' || options.headers.authorization === 'Bearer platform-key');
    if (url === 'https://region.turso.io') return reply(200, { server: 'nrt', client: 'nrt' });
    if (url.endsWith('/v1/organizations')) return reply(200, [{ slug: 'team', type: 'team' }, { slug: 'rex', type: 'personal' }]);
    if (url.endsWith('/groups') && options.method === 'GET') return reply(200, { groups: [] });
    if (url.endsWith('/groups')) { assert.deepEqual(JSON.parse(options.body), { name: 'default', location: 'nrt' }); return reply(200, { group: { name: 'default' } }); }
    if (url.endsWith('/databases')) return reply(200, { database: { Hostname: 'rex-desk-rex.turso.io' } });
    if (url.includes('/auth/tokens')) return reply(200, { jwt: 'db-key' });
    return reply(404, { error: 'unexpected' });
  };
  const made = await provisionDatabase('platform-key', { fetcher });
  assert.deepEqual(made, { url: 'libsql://rex-desk-rex.turso.io', authToken: 'db-key', organization: 'rex', database: 'rex-desk' });
  assert.ok(calls.includes('POST /v1/organizations/rex/groups'));
});

test('an account that already has the rex-desk database reuses it, and a refusal is said plainly', async () => {
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/v1/organizations')) return reply(200, [{ slug: 'rex', type: 'personal' }]);
    if (url.endsWith('/groups')) return reply(200, { groups: [{ name: 'default' }] });
    if (url.endsWith('/databases')) return reply(409, { error: 'database with name rex-desk already exists' });
    if (url.endsWith('/databases/rex-desk')) return reply(200, { database: { Hostname: 'old.turso.io' } });
    if (url.includes('/auth/tokens')) return reply(200, { jwt: 'db-key' });
  };
  assert.equal((await provisionDatabase('k', { fetcher })).url, 'libsql://old.turso.io');
  await assert.rejects(provisionDatabase('k', { fetcher: async () => reply(401, { error: 'token expired' }) }), /Turso could not read your account: token expired/);
});

test('a new computer only finds the existing backup and never makes a database', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url}`);
    if (url.endsWith('/v1/organizations')) return reply(200, [{ slug: 'rex', type: 'personal' }]);
    if (url.endsWith('/databases/rex-desk')) return reply(200, { database: { Hostname: 'mine.turso.io' } });
    if (url.includes('/auth/tokens')) return reply(200, { jwt: 'db-key' });
  };
  assert.equal((await provisionDatabase('k', { fetcher, create: false })).url, 'libsql://mine.turso.io');
  assert.ok(!calls.some(call => call.startsWith('POST') && !call.includes('/auth/tokens')), 'nothing is made');
  const empty = async url => url.endsWith('/v1/organizations') ? reply(200, [{ slug: 'rex', type: 'personal' }]) : reply(404, { error: 'not found' });
  await assert.rejects(provisionDatabase('k', { fetcher: empty, create: false }), /no Rex Desk backup yet/);
});

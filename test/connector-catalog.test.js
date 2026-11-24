import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, catalogItem, probe, serverConfig, readValues } from '../src/connector-catalog.js';
import { createApp } from '../src/server.js';

const catalog = loadCatalog();
const fakeClient = tools => async () => ({ listTools: async () => ({ tools: Array.from({ length: tools }, (_, i) => ({ name: `t${i}` })) }), close: async () => {} });

test('the catalog: a version, task trackers are Orbit, Flow and Morningmate (with their MCP servers), every item says how it connects and where that is written', () => {
  assert.ok(Number(catalog.version) >= 1);
  const groups = new Set(catalog.groups.map(group => group.id));
  assert.deepEqual(catalog.items.filter(item => item.group === 'tasks').map(item => item.id), ['orbit', 'flow', 'morningmate', 'flow-mcp', 'morningmate-mcp']);
  assert.deepEqual(catalog.items.filter(item => item.tier === 'native').map(item => item.id), ['orbit', 'flow', 'morningmate']);
  assert.equal(new Set(catalog.items.map(item => item.id)).size, catalog.items.length);
  for (const item of catalog.items) {
    assert.ok(groups.has(item.group), item.id);
    assert.ok(['remote-mcp', 'local-mcp', 'token', 'webhook', 'device', 'skill'].includes(item.connect.kind), item.id);
    assert.ok(['oauth', 'header', 'env', 'none'].includes(item.connect.auth), item.id);
    assert.ok(Array.isArray(item.connect.fields), item.id);
    if (item.tier !== 'native') assert.match(item.connect.source, /^https:\/\//, `${item.id} names its docs`);
    if (item.connect.kind === 'remote-mcp') assert.match(item.connect.url, /^https:\/\//, item.id);
    if (!item.icon.startsWith('letter:')) assert.ok(existsSync(path.join('public', 'connectors', item.icon)), item.icon);
  }
  // Corrections from the vendors' docs.
  assert.equal(catalogItem('github').connect.auth, 'header');
  assert.equal(catalogItem('clickup').connect.auth, 'oauth');
  assert.equal(catalogItem('atlassian').connect.url, 'https://mcp.atlassian.com/v2/mcp');
  assert.equal(catalogItem('slack').phase, 2); assert.equal(catalogItem('asana').phase, 2);
});

test('probe connects for real: tools counted, a token goes in the header, a sign-in is fine only when the app lets new apps register', async () => {
  const seen = [];
  const ok = await probe(catalogItem('github'), { token: 'ghp_secret123' }, { connect: async (name, config) => { seen.push(config); return fakeClient(3)(); } });
  assert.deepEqual([ok.ok, ok.method, ok.tools], [true, 'remote-mcp', 3]);
  assert.equal(seen[0].headers.Authorization, 'Bearer ghp_secret123');
  assert.equal((await probe(catalogItem('github'), {})).error, 'Fill in the token.', 'a required field is checked before any call');

  const refuse = async () => { throw new Error('Streamable HTTP error: 401 Unauthorized'); };
  const meta = register => async address => ({ ok: true, json: async () => address.includes('protected-resource') ? { authorization_servers: ['https://auth.example.com'] } : { authorization_endpoint: 'https://auth.example.com/a', ...(register ? { registration_endpoint: 'https://auth.example.com/r' } : {}) } });
  const open = await probe(catalogItem('linear'), {}, { connect: refuse, fetcher: meta(true) });
  assert.deepEqual([open.ok, open.method, open.needs], [true, 'oauth', 'sign-in']);
  const closed = await probe(catalogItem('vercel'), {}, { connect: refuse, fetcher: meta(false) });
  assert.equal(closed.ok, false); assert.match(closed.error, /approved/);

  const leak = await probe(catalogItem('stripe'), { token: 'rk_live_verysecret' }, { connect: async () => { throw new Error('bad key rk_live_verysecret'); } });
  assert.equal(leak.ok, false); assert.ok(!leak.error.includes('rk_live_verysecret'), 'the key never comes back in an error');

  assert.equal((await probe(catalogItem('slack'), {})).ok, false, 'phase 2 items cannot be connected yet');
  const local = serverConfig(catalogItem('brave'), readValues(catalogItem('brave'), { apiKey: 'BSA123' }));
  assert.equal(local.env.BRAVE_API_KEY, 'BSA123'); assert.equal(local.command, 'npx');
  assert.equal(serverConfig(catalogItem('gitlab'), { host: 'git.acme.io' }).url, 'https://git.acme.io/api/v4/mcp');
  assert.throws(() => serverConfig(catalogItem('gitlab'), { host: 'evil.com/x?y' }) && serverConfig(catalogItem('gitlab'), { host: 'a b' }));
});

test('token and webhook checks call the vendor once and read its answer', async () => {
  const telegram = await probe(catalogItem('telegram'), { botToken: '123:abc' }, { fetcher: async () => ({ ok: true, json: async () => ({ ok: true, result: { username: 'rexbot' } }) }) });
  assert.deepEqual([telegram.ok, telegram.label], [true, '@rexbot']);
  const bad = await probe(catalogItem('telegram'), { botToken: '123:abc' }, { fetcher: async () => ({ ok: false, json: async () => ({ ok: false }) }) });
  assert.equal(bad.ok, false);
  assert.equal((await probe(catalogItem('discord'), { webhookUrl: 'https://example.com/hook' })).ok, false, 'only a Discord webhook address');
});

test('a failed check saves nothing; the list carries the catalog', async () => {
  const app = await createApp({ dataDirectory: mkdtempSync(path.join(os.tmpdir(), 'rex-desk-catalog-')), port: 0, runnerFactory: () => ({}) });
  const call = async (route, method = 'GET', data) => { const response = await fetch(app.address + route, { method, headers: { 'x-rex-desk': '1', 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, body: await response.json() }; };
  try {
    const listed = await call('/api/connectors');
    assert.equal(listed.body.catalog.version, catalog.version); assert.ok(Array.isArray(listed.body.links));
    const failed = await call('/api/connectors/catalog/discord', 'POST', { webhookUrl: 'https://example.com/nope' });
    assert.equal(failed.status, 400); assert.equal(failed.body.probe.ok, false);
    assert.deepEqual(app.store.list('connector'), []);
    assert.ok(!(await call('/api/connectors')).body.links.some(link => link.connectorId === 'discord'));
    const checked = await call('/api/connectors/catalog/github/probe', 'POST', {});
    assert.equal(checked.body.ok, false);
  } finally { await app.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, catalogItem, probe, serverConfig, readValues } from '../src/connector-catalog.js';
import { createApp } from '../src/server.js';

const catalog = loadCatalog();
const fakeClient = tools => async () => ({ listTools: async () => ({ tools: Array.from({ length: tools }, (_, i) => ({ name: `t${i}` })) }), close: async () => {} });

test('the catalog: a version, task trackers are only Orbit, Flow and Morningmate (their own MCP servers too, now that Rex Desk signs in to them), every item says how it connects and where that is written', () => {
  assert.ok(Number(catalog.version) >= 1);
  const groups = new Set(catalog.groups.map(group => group.id));
  assert.deepEqual(catalog.items.filter(item => item.group === 'tasks').map(item => item.id), ['orbit', 'flow', 'morningmate', 'flow-mcp', 'morningmate-mcp']);
  for (const id of ['flow-mcp', 'morningmate-mcp']) assert.equal(catalogItem(id)?.connect.auth, 'oauth', `${id} is in the picker`);
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
  const gdrive = catalogItem('googledrive');
  assert.equal(gdrive.phase, 1); assert.equal(gdrive.verified, false); assert.equal(gdrive.connect.auth, 'oauth');
  assert.equal(gdrive.connect.oauth?.provider, 'google'); assert.equal(gdrive.connect.oauth?.includeResource, false);
  assert.deepEqual(gdrive.connect.oauth?.scopes, ['https://www.googleapis.com/auth/drive.readonly', 'openid', 'email']);
  assert.deepEqual(gdrive.connect.oauth?.authParams, { access_type: 'offline', prompt: 'select_account consent' });
  assert.doesNotMatch(readFileSync(path.join('public', 'connectors', 'catalog.json'), 'utf8'), /client_secret/i, 'catalog.json never holds a client_secret');
});

test('probe connects for real: tools counted, a token goes in the header, a sign-in is fine only when the app lets new apps register', async () => {
  const seen = [];
  const ok = await probe(catalogItem('github'), { token: 'ghp_secret123' }, { connect: async (name, config) => { seen.push(config); return fakeClient(3)(); } });
  assert.deepEqual([ok.ok, ok.method, ok.tools], [true, 'remote-mcp', 3]);
  assert.equal(seen[0].headers.Authorization, 'Bearer ghp_secret123');
  assert.equal((await probe(catalogItem('github'), {})).error, 'Fill in the token.', 'a required field is checked before any call');

  const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const refuse = async () => { throw new Error('Streamable HTTP error: 401 Unauthorized'); };
  const meta = register => async address => ({ ok: true, json: async () => address.includes('protected-resource') ? { authorization_servers: ['https://auth.example.com'] } : { authorization_endpoint: 'https://auth.example.com/a', ...(register ? { registration_endpoint: 'https://auth.example.com/r' } : {}) } });
  const open = await probe(catalogItem('linear'), {}, { connect: refuse, fetcher: meta(true), resolver: publicResolver });
  assert.deepEqual([open.ok, open.method, open.needs], [true, 'oauth', 'sign-in']);
  const closed = await probe(catalogItem('vercel'), {}, { connect: refuse, fetcher: meta(false), resolver: publicResolver });
  assert.equal(closed.ok, false); assert.match(closed.error, /approved/);

  const leak = await probe(catalogItem('stripe'), { token: 'rk_live_verysecret' }, { connect: async () => { throw new Error('bad key rk_live_verysecret'); } });
  assert.equal(leak.ok, false); assert.ok(!leak.error.includes('rk_live_verysecret'), 'the key never comes back in an error');

  assert.equal((await probe(catalogItem('slack'), {})).ok, false, 'phase 2 items cannot be connected yet');
  const local = serverConfig(catalogItem('brave'), readValues(catalogItem('brave'), { apiKey: 'BSA12345' }));
  assert.equal(local.env.BRAVE_API_KEY, 'BSA12345'); assert.equal(local.command, 'npx');
  assert.equal(serverConfig(catalogItem('gitlab'), { host: 'git.acme.io' }).url, 'https://git.acme.io/api/v4/mcp');
  assert.throws(() => serverConfig(catalogItem('gitlab'), { host: 'evil.com/x?y' }) && serverConfig(catalogItem('gitlab'), { host: 'a b' }));
});

test('token and webhook checks call the vendor once and read its answer', async () => {
  const telegram = await probe(catalogItem('telegram'), { botToken: '123:abcde' }, { fetcher: async () => ({ ok: true, json: async () => ({ ok: true, result: { username: 'rexbot' } }) }) });
  assert.deepEqual([telegram.ok, telegram.label], [true, '@rexbot']);
  const bad = await probe(catalogItem('telegram'), { botToken: '123:abcde' }, { fetcher: async () => ({ ok: false, json: async () => ({ ok: false }) }) });
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

test('Google Drive pre-registered OAuth probe: HTTP 200 on tools/list still needs sign-in, and missing credentials give a plain error', async () => {
  const gdrive = catalogItem('googledrive');
  const publicResolver = async () => [{ address: '142.250.190.78', family: 4 }];
  const googleMeta = async address => {
    if (address.includes('oauth-protected-resource')) return { ok: true, json: async () => ({ resource: 'https://drivemcp.googleapis.com/mcp/v1', authorization_servers: ['https://accounts.google.com'], scopes_supported: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'] }) };
    if (address.includes('openid-configuration')) return { ok: true, json: async () => ({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token', revocation_endpoint: 'https://oauth2.googleapis.com/revoke', userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo', code_challenge_methods_supported: ['plain', 'S256'] }) };
    return { ok: false, json: async () => null };
  };
  // drivemcp.googleapis.com returns HTTP 200 on tools/list without auth: missing client credentials must report a clear error.
  const missing = await probe(gdrive, {}, { connect: fakeClient(4), fetcher: googleMeta, resolver: publicResolver, env: {} });
  assert.equal(missing.ok, false); assert.equal(missing.method, 'oauth');
  assert.match(missing.error, /REX_GOOGLE_OAUTH_CLIENT_ID.*REX_GOOGLE_OAUTH_CLIENT_SECRET/);
  // With pre-registered client credentials, HTTP 200 on tools/list still requires OAuth sign-in.
  const ready = await probe(gdrive, {}, { connect: fakeClient(4), fetcher: googleMeta, resolver: publicResolver, env: { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-client-id', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret' } });
  assert.deepEqual([ready.ok, ready.method, ready.needs, ready.tools], [true, 'oauth', 'sign-in', 4]);
  // A 401 on connect/listTools also succeeds as needs: sign-in when pre-registered credentials exist.
  const on401 = await probe(gdrive, {}, { connect: async () => { throw Object.assign(new Error('HTTP 401 Unauthorized'), { code: 401 }); }, fetcher: googleMeta, resolver: publicResolver, env: { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-client-id', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret' } });
  assert.deepEqual([on401.ok, on401.method, on401.needs], [true, 'oauth', 'sign-in']);
  // Tampered Google OIDC discovery (untrusted token_endpoint) is refused even with credentials configured.
  const tamperedMeta = async address => {
    if (address.includes('oauth-protected-resource')) return { ok: true, json: async () => ({ resource: 'https://drivemcp.googleapis.com/mcp/v1', authorization_servers: ['https://accounts.google.com'] }) };
    if (address.includes('openid-configuration')) return { ok: true, json: async () => ({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://evil.example.test/token' }) };
    return { ok: false, json: async () => null };
  };
  const tampered = await probe(gdrive, {}, { connect: fakeClient(4), fetcher: tamperedMeta, resolver: publicResolver, env: { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-client-id', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret' } });
  assert.equal(tampered.ok, false);
  assert.match(tampered.error, /token address does not match/);
});

test('signInWay uses guarded, DNS-pinned discovery transport and blocks private issuers and redirects to private services', async () => {
  const refuse = async () => { throw Object.assign(new Error('HTTP 401 Unauthorized'), { code: 401 }); };

  // 1) Direct private/loopback authorization_servers and DNS-rebinding hosts are never reached.
  for (const privateIssuer of ['https://127.0.0.1:4317', 'http://127.0.0.1:4317', 'https://10.0.0.5', 'https://169.254.169.254', 'https://rebind.example.test']) {
    const asked = [];
    const resolver = async host => host === 'rebind.example.test' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
    const fetcher = async address => {
      asked.push(String(address));
      if (String(address).includes('oauth-protected-resource')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ authorization_servers: [privateIssuer] }) };
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ authorization_endpoint: `${privateIssuer}/auth`, registration_endpoint: `${privateIssuer}/reg` }) };
    };
    const out = await probe(catalogItem('linear'), {}, { connect: refuse, fetcher, resolver });
    assert.equal(out.ok, false, `must reject private issuer ${privateIssuer}`);
    assert.ok(!asked.some(url => url.startsWith(privateIssuer)), `never probed ${privateIssuer}: ${asked.join(', ')}`);
  }

  // 2) Public issuer requests are DNS-pinned (init.pin + redirect: manual) and redirects to private services are blocked.
  for (const redirectTarget of ['https://127.0.0.1/secret', 'http://10.0.0.5/internal', 'https://sneaky.example.test/meta']) {
    const seen = [];
    const resolver = async host => host === 'sneaky.example.test' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
    const fetcher = async (address, init = {}) => {
      seen.push({ address: String(address), pin: init.pin, redirect: init.redirect });
      if (String(address).includes('oauth-protected-resource')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ authorization_servers: ['https://auth.example.test'] }) };
      }
      if (String(address).startsWith('https://auth.example.test/')) {
        return { ok: false, status: 302, headers: new Headers({ location: redirectTarget }), body: { cancel: async () => {} } };
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ authorization_endpoint: 'https://auth.example.test/a', registration_endpoint: 'https://auth.example.test/r' }) };
    };
    const out = await probe(catalogItem('linear'), {}, { connect: refuse, fetcher, resolver });
    assert.equal(out.ok, false, `must block redirect to ${redirectTarget}`);
    assert.ok(!seen.some(entry => entry.address === redirectTarget), `never followed redirect to ${redirectTarget}`);
    const issuerHit = seen.find(entry => entry.address.startsWith('https://auth.example.test/'));
    assert.ok(issuerHit, 'probed the public issuer');
    assert.deepEqual(issuerHit.pin, { address: '93.184.216.34', family: 4 }, 'pinned the public issuer connection');
    assert.equal(issuerHit.redirect, 'manual', 'used manual redirects so every hop is checked');
  }
});

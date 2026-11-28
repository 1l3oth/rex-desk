import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpSignIn, SIGN_IN_HELP, emailFromIdToken } from '../src/mcp-signin.js';
import { Toolbox, wantsSignIn } from '../src/toolbox.js';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { catalogItem } from '../src/connector-catalog.js';
import { createApp } from '../src/server.js';

// L30: Rex Desk signs in to a remote MCP server itself. A small local server plays the MCP server and its sign-in server.
async function fakeServer({ expiresIn = 3600 } = {}) {
  const seen = { registrations: [], tokenCalls: [], refresh: 'refresh-0', access: 'access-0', over: false, challenge: '' };
  let base = '';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, base); let text = ''; for await (const part of request) text += part;
    const json = (status, body, headers = {}) => response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['user'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { const body = JSON.parse(text); seen.registrations.push(body); return json(201, { ...body, client_id: 'client-1' }); }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(text); seen.tokenCalls.push(Object.fromEntries(form));
      if (form.get('grant_type') === 'authorization_code') {
        if (createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== seen.challenge) return json(400, { error: 'invalid_grant' });
      } else {
        if (seen.over || form.get('refresh_token') !== seen.refresh) return json(400, { error: 'invalid_grant' });
        seen.refresh = `refresh-${seen.tokenCalls.length}`; seen.access = `access-${seen.tokenCalls.length}`;
      }
      return json(200, { access_token: seen.access, refresh_token: seen.refresh, token_type: 'Bearer', expires_in: expiresIn });
    }
    return json(401, { error: 'Unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="user"` });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: `${base}/mcp`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}
function memoryStore() {
  const records = new Map();
  return { records, get: (kind, id) => records.get(`${kind}:${id}`) ?? null, put: (kind, id, value) => { records.set(`${kind}:${id}`, value); }, delete: (kind, id) => { records.delete(`${kind}:${id}`); },
    list: kind => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value), encrypt: text => `sealed:${Buffer.from(text).toString('base64')}`, decrypt: text => Buffer.from(text.slice(7), 'base64').toString() };
}
// What the person's browser does: opens the sign-in page, which sends it back to Rex Desk's one-time address.
async function browser(fake, link, { state } = {}) {
  const asked = new URL(link).searchParams; fake.seen.challenge = asked.get('code_challenge');
  const back = new URL(asked.get('redirect_uri')); back.searchParams.set('code', 'the-code'); back.searchParams.set('state', state ?? asked.get('state'));
  return { asked, back, status: (await fetch(back)).status };
}

test('sign in: discovery, self-registration, PKCE and resource, a one-time local callback, tokens kept sealed', async () => {
  const fake = await fakeServer(), store = memoryStore(), changed = [];
  const signIn = new McpSignIn(store, { changed: url => changed.push(url), loopback: true });
  try {
    const { url, done } = await signIn.start('flow-mcp', fake.url);
    const wrong = await browser(fake, url, { state: 'not-ours' });
    assert.equal(wrong.status, 400); assert.equal(signIn.state(fake.url).waiting, true);
    const { asked, back, status } = await browser(fake, url);
    assert.equal(status, 200); await done;
    assert.equal(asked.get('code_challenge_method'), 'S256'); assert.equal(asked.get('resource'), fake.url); assert.equal(asked.get('scope'), 'user');
    assert.match(asked.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.deepEqual(fake.seen.registrations[0].redirect_uris, [asked.get('redirect_uri')]);
    assert.equal(fake.seen.tokenCalls[0].resource, fake.url);
    assert.equal(signIn.state(fake.url).state, 'connected'); assert.deepEqual(changed, [fake.url]);
    await assert.rejects(() => fetch(back), 'the callback port is closed after one sign-in');
    assert.doesNotMatch(JSON.stringify([...store.records.values()].map(({ sealed, ...rest }) => rest)), /access-|refresh-/);
    assert.doesNotMatch(JSON.stringify([signIn.state(fake.url), signIn.expired()]), /access-|refresh-/);
    assert.equal((await signIn.authorize({ type: 'http', url: fake.url })).headers.Authorization, 'Bearer access-0');
    for (const other of [`${fake.base}/other`, `${fake.url}?x=1`, 'https://example.com/mcp']) assert.deepEqual(await signIn.authorize({ url: other }), { url: other }, 'only the exact address gets the token');
  } finally { signIn.stop(); fake.close(); }
});

test('refresh: before it runs out, once even when asked twice; a refused refresh shows as expired', async () => {
  const fake = await fakeServer({ expiresIn: 300 }), signIn = new McpSignIn(memoryStore(), { loopback: true });
  const refreshes = () => fake.seen.tokenCalls.filter(call => call.grant_type === 'refresh_token').length;
  try {
    const { url, done } = await signIn.start('flow-mcp', fake.url); await browser(fake, url); await done;
    const [one, two] = await Promise.all([signIn.authorize({ url: fake.url }), signIn.authorize({ url: fake.url })]);
    assert.equal(one.headers.Authorization, two.headers.Authorization); assert.notEqual(one.headers.Authorization, 'Bearer access-0');
    assert.equal(refreshes(), 1);
    await signIn.tick(); assert.equal(refreshes(), 2, 'the timer renews it with the rotated token');
    fake.seen.over = true; await signIn.tick();
    assert.equal(signIn.state(fake.url).state, 'expired'); assert.deepEqual(signIn.expired().map(item => item.name), ['flow-mcp']);
    assert.deepEqual(await signIn.authorize({ url: fake.url }), { url: fake.url });
  } finally { signIn.stop(); fake.close(); }
});

test('the toolbox opens the server with the sign-in, and a refused one asks for Sign in, never a terminal', async () => {
  const refused = () => Object.assign(new Error('Error POSTing to endpoint (HTTP 401): MISSING_BEARER_TOKEN'), { code: 401 });
  const connect = async (name, config) => { if (config.headers?.Authorization !== 'Bearer good') throw refused(); return { listTools: async () => ({ tools: [{ name: 'search' }] }), close: async () => {} }; };
  const toolbox = new Toolbox({ connect, mcpConfig: () => ({ 'flow-mcp': { type: 'http', url: 'https://flow.team/ai/mcp' } }) });
  const config = toolbox.servers()['flow-mcp'];
  assert.deepEqual(await toolbox.toolsOf('flow-mcp', config), []);
  assert.equal(toolbox.failed.get('flow-mcp').error, SIGN_IN_HELP);
  toolbox.signIn = { record: () => ({}), authorize: async raw => ({ ...raw, headers: { Authorization: 'Bearer good' } }), refused: async () => false };
  toolbox.failed.clear();
  assert.equal((await toolbox.toolsOf('flow-mcp', config)).length, 1);
  assert.equal(config.headers, undefined, 'the saved config never gets the token');
  await toolbox.closeAll();
});

test('a server that refuses even a renewed token shows as expired, so Needs you asks for Sign in again', async () => {
  const fake = await fakeServer(), signIn = new McpSignIn(memoryStore(), { loopback: true });
  const connect = async () => { throw Object.assign(new Error('HTTP 401'), { code: 401 }); };
  try {
    const { url, done } = await signIn.start('flow-mcp', fake.url); await browser(fake, url); await done;
    const toolbox = new Toolbox({ connect, mcpConfig: () => ({ 'flow-mcp': { type: 'http', url: fake.url } }) }); toolbox.signIn = signIn;
    await toolbox.toolsOf('flow-mcp', toolbox.servers()['flow-mcp']);
    assert.deepEqual(signIn.expired().map(item => item.name), ['flow-mcp']);
    assert.equal(toolbox.failed.get('flow-mcp').error, SIGN_IN_HELP);
  } finally { signIn.stop(); fake.close(); }
});

test('a sign-in never goes into the cloud copy', () => {
  assert.equal(Store.prototype.isPrivate.call({}, 'mcpauth', { id: 'x', sealed: 'y' }), true);
});

// Mock Google Drive MCP + Google OIDC transport using the real production URLs and DNS pinning (no loopback bypass).
function fakeJwt(payload) {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}
const GOOGLE_DRIVE_URL = 'https://drivemcp.googleapis.com/mcp/v1';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_OIDC = {
  issuer: GOOGLE_ISSUER,
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  code_challenge_methods_supported: ['plain', 'S256'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
};
function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function mockGoogleTransport({
  includeIdToken = true,
  revokeFails = false,
  email = 'pkay@example.com',
  prm = null,
  oidc = null,
  extraOidcByOrigin = {},
} = {}) {
  const seen = { asked: [], tokenCalls: [], userinfoCalls: 0, revocations: [], access: 'g-access-0', refresh: 'g-refresh-0', challenge: '' };
  const prmDoc = {
    resource: GOOGLE_DRIVE_URL,
    authorization_servers: [GOOGLE_ISSUER],
    scopes_supported: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
    ...(prm || {}),
  };
  const oidcDoc = { ...GOOGLE_OIDC, ...(oidc || {}) };
  const resolver = async () => [{ address: '142.250.190.78', family: 4 }];
  const fetcher = async (target, init = {}) => {
    const href = String(target), url = new URL(href);
    seen.asked.push({ href, pin: init.pin ?? null, method: (init.method || 'GET').toUpperCase() });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return jsonResponse(200, prmDoc);
    if (url.pathname === '/.well-known/openid-configuration') {
      const override = extraOidcByOrigin[url.origin];
      return jsonResponse(200, override || oidcDoc);
    }
    if (href === oidcDoc.token_endpoint) {
      const rawBody = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body || '');
      const form = Object.fromEntries(new URLSearchParams(rawBody));
      seen.tokenCalls.push({ form, auth: new Headers(init.headers || {}).get('authorization') || '' });
      if (form.client_id !== 'google-cid' || form.client_secret !== 'google-csecret') return jsonResponse(401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        if (createHash('sha256').update(form.code_verifier).digest('base64url') !== seen.challenge) return jsonResponse(400, { error: 'invalid_grant' });
        return jsonResponse(200, { access_token: seen.access, refresh_token: seen.refresh, token_type: 'Bearer', expires_in: 300, ...(includeIdToken ? { id_token: fakeJwt({ sub: '123', email }) } : {}) });
      }
      if (form.grant_type === 'refresh_token') {
        if (form.refresh_token !== seen.refresh) return jsonResponse(400, { error: 'invalid_grant' });
        seen.access = `g-access-${seen.tokenCalls.length}`;
        return jsonResponse(200, { access_token: seen.access, token_type: 'Bearer', expires_in: 3600 });
      }
    }
    if (href === oidcDoc.userinfo_endpoint) {
      seen.userinfoCalls += 1;
      if (new Headers(init.headers || {}).get('authorization') !== `Bearer ${seen.access}`) return jsonResponse(401, { error: 'invalid_token' });
      return jsonResponse(200, { sub: '123', email });
    }
    if (href === oidcDoc.revocation_endpoint || href === 'https://oauth2.googleapis.com/revoke') {
      const rawBody = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body || '');
      seen.revocations.push(Object.fromEntries(new URLSearchParams(rawBody)));
      if (revokeFails) throw new Error('network unreachable');
      return jsonResponse(200, {});
    }
    if (url.pathname === '/mcp/v1') return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: {} });
    return jsonResponse(404, { error: 'not_found' });
  };
  return { url: GOOGLE_DRIVE_URL, seen, fetcher, resolver };
}

test('Google Drive pre-registered OAuth: no DCR, offline/select_account consent, no resource, client_secret, accountEmail, refresh, and signOut outcome', async () => {
  const gdriveOAuth = catalogItem('googledrive').connect.oauth;
  const mock = mockGoogleTransport(), store = memoryStore();
  // Missing credentials fail cleanly with plain language.
  const missing = new McpSignIn(store, { fetcher: mock.fetcher, resolver: mock.resolver, env: {} });
  try {
    await assert.rejects(() => missing.start('googledrive', mock.url, gdriveOAuth), /REX_GOOGLE_OAUTH_CLIENT_ID.*REX_GOOGLE_OAUTH_CLIENT_SECRET/);
  } finally { missing.stop(); }

  const signIn = new McpSignIn(store, { fetcher: mock.fetcher, resolver: mock.resolver, env: { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-cid', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-csecret' } });
  try {
    const { url, done } = await signIn.start('googledrive', mock.url, gdriveOAuth);
    const { asked, status } = await browser(mock, url);
    assert.equal(status, 200); await done;
    assert.equal(asked.get('client_id'), 'google-cid');
    assert.equal(asked.get('access_type'), 'offline');
    assert.equal(asked.get('prompt'), 'select_account consent');
    assert.equal(asked.get('scope'), 'https://www.googleapis.com/auth/drive.readonly openid email');
    assert.equal(asked.get('resource'), null, 'Google auth URL omits RFC 8707 resource');
    assert.equal(mock.seen.tokenCalls[0].form.client_id, 'google-cid');
    assert.equal(mock.seen.tokenCalls[0].form.client_secret, 'google-csecret');
    assert.equal(mock.seen.tokenCalls[0].form.resource, undefined, 'Google token exchange omits RFC 8707 resource');
    assert.equal(signIn.state(mock.url).state, 'connected');
    assert.equal(signIn.state(mock.url).accountEmail, 'pkay@example.com');
    assert.doesNotMatch(JSON.stringify([...store.records.values()].map(({ sealed, ...rest }) => rest)), /g-access-|g-refresh-|google-csecret/);
    // Refresh sends client_secret, omits resource, and preserves accountEmail.
    assert.equal(await signIn.refresh(mock.url), true);
    assert.equal(mock.seen.tokenCalls[1].form.grant_type, 'refresh_token');
    assert.equal(mock.seen.tokenCalls[1].form.client_secret, 'google-csecret');
    assert.equal(mock.seen.tokenCalls[1].form.resource, undefined);
    assert.equal(signIn.state(mock.url).accountEmail, 'pkay@example.com');
    assert.equal((await signIn.authorize({ type: 'http', url: mock.url })).headers.Authorization, 'Bearer g-access-2');
    // signOut clears local record and reports revocation outcome.
    const outcome = await signIn.signOut(mock.url);
    assert.deepEqual(outcome, { localCleared: true, revocation: 'revoked', revoked: true, manageUrl: 'https://myaccount.google.com/permissions' });
    assert.equal(signIn.state(mock.url).state, '');
    assert.equal(signIn.state(mock.url).accountEmail, undefined);
    assert.equal(mock.seen.revocations.length, 1);
    assert.equal(mock.seen.revocations[0].token, 'g-refresh-0');
  } finally { signIn.stop(); }
});

test('Google Drive accountEmail falls back to userinfo when id_token is absent, and signOut clears local state while reporting failed remote revocation', async () => {
  assert.equal(emailFromIdToken(fakeJwt({ email: 'a@b.com' })), 'a@b.com');
  assert.equal(emailFromIdToken('not-a-jwt'), '');
  const gdriveOAuth = catalogItem('googledrive').connect.oauth;
  const mock = mockGoogleTransport({ includeIdToken: false, revokeFails: true, email: 'fallback@example.com' });
  const signIn = new McpSignIn(memoryStore(), { fetcher: mock.fetcher, resolver: mock.resolver, env: { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-cid', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-csecret' } });
  try {
    const { url, done } = await signIn.start('googledrive', mock.url, gdriveOAuth);
    await browser(mock, url); await done;
    assert.equal(mock.seen.userinfoCalls, 1);
    assert.equal(signIn.state(mock.url).accountEmail, 'fallback@example.com');
    // Revocation fails over network, yet local credentials are cleared and failure + manageUrl are reported.
    const outcome = await signIn.signOut(mock.url);
    assert.deepEqual(outcome, { localCleared: true, revocation: 'failed', revoked: false, manageUrl: 'https://myaccount.google.com/permissions' });
    assert.equal(signIn.state(mock.url).state, '');
  } finally { signIn.stop(); }
});

test('pre-registered Google OAuth rejects wrong resource URL, fake issuer, and untrusted endpoints with plain errors', async () => {
  const env = { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-cid', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-csecret' };
  const gdriveOAuth = catalogItem('googledrive').connect.oauth;

  // 1) Wrong resource URL even when connector name is googledrive and oauth.provider is google.
  {
    const mock = mockGoogleTransport();
    const signIn = new McpSignIn(memoryStore(), { fetcher: mock.fetcher, resolver: mock.resolver, env });
    try {
      await assert.rejects(() => signIn.start('googledrive', 'https://evil.example.test/mcp', gdriveOAuth), /not a supported Google MCP server/);
      assert.deepEqual(mock.seen.asked, [], 'stops before sending any request when provider is mismatched with resource URL');
    } finally { signIn.stop(); }
  }

  // 2) Wrong resource URL claiming Google issuer with no DCR: never gets Google's pre-registered client.
  {
    const mock = mockGoogleTransport({ prm: { resource: 'https://evil.example.test/mcp', authorization_servers: [GOOGLE_ISSUER] } });
    const signIn = new McpSignIn(memoryStore(), { fetcher: mock.fetcher, resolver: mock.resolver, env });
    try {
      await assert.rejects(() => signIn.start('googledrive', 'https://evil.example.test/mcp'), /lets only apps it approved sign in/);
      assert.deepEqual(mock.seen.tokenCalls, [], 'Google client credentials are never used for an unsupported resource URL');
    } finally { signIn.stop(); }
  }

  // 3) Fake issuer advertised on supported Google Drive URL.
  {
    const mock = mockGoogleTransport({
      prm: { authorization_servers: ['https://evil.example.test'] },
      extraOidcByOrigin: {
        'https://evil.example.test': {
          ...GOOGLE_OIDC,
          issuer: 'https://evil.example.test',
        },
      },
    });
    const signIn = new McpSignIn(memoryStore(), { fetcher: mock.fetcher, resolver: mock.resolver, env });
    try {
      await assert.rejects(() => signIn.start('googledrive', GOOGLE_DRIVE_URL, gdriveOAuth), /untrusted sign-in issuer/);
    } finally { signIn.stop(); }
  }

  // 4) Untrusted token_endpoint, authorization_endpoint, revocation_endpoint, and userinfo_endpoint are each rejected.
  const tamperedEndpoints = [
    [{ token_endpoint: 'https://evil.example.test/token' }, /token address does not match/],
    [{ authorization_endpoint: 'https://evil.example.test/auth' }, /sign-in page does not match/],
    [{ revocation_endpoint: 'https://evil.example.test/revoke' }, /revocation address does not match/],
    [{ userinfo_endpoint: 'https://evil.example.test/userinfo' }, /account info address does not match/],
  ];
  for (const [override, pattern] of tamperedEndpoints) {
    const mock = mockGoogleTransport({ oidc: override });
    const signIn = new McpSignIn(memoryStore(), { fetcher: mock.fetcher, resolver: mock.resolver, env });
    try {
      await assert.rejects(() => signIn.start('googledrive', GOOGLE_DRIVE_URL, gdriveOAuth), pattern);
      assert.deepEqual(mock.seen.tokenCalls, []);
    } finally { signIn.stop(); }
  }
});

test('POST /api/mcp-sign-in/sign-out reports remote revocation outcome while always clearing local credentials', async () => {
  const app = await createApp({ dataDirectory: mkdtempSync(path.join(os.tmpdir(), 'rex-desk-signout-')), port: 0, runnerFactory: () => ({}) });
  const call = async (route, data) => {
    const response = await fetch(app.address + route, { method: 'POST', headers: { 'x-rex-desk': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  try {
    app.desk.toolbox.servers = () => ({ googledrive: { type: 'http', url: GOOGLE_DRIVE_URL } });
    let failRevoke = false;
    app.desk.mcpSignIn.resolver = async () => [{ address: '142.250.190.78', family: 4 }];
    app.desk.mcpSignIn.fetcher = async href => {
      if (String(href) === 'https://oauth2.googleapis.com/revoke') {
        if (failRevoke) throw new Error('google offline');
        return jsonResponse(200, {});
      }
      return jsonResponse(404, {});
    };

    // 1) Successful remote revocation
    app.desk.mcpSignIn.save(GOOGLE_DRIVE_URL, 'googledrive', {
      server: GOOGLE_ISSUER, metadata: GOOGLE_OIDC, client: { client_id: 'cid', client_secret: 'csec' },
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke', accessToken: 'acc-1', refreshToken: 'ref-1', expiresAt: Date.now() + 3600000,
    }, 'connected', 'pkay@example.com');
    const ok = await call('/api/mcp-sign-in/sign-out', { name: 'googledrive' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.localCleared, true);
    assert.equal(ok.body.revocation, 'revoked');
    assert.equal(ok.body.revoked, true);
    assert.equal(ok.body.manageUrl, 'https://myaccount.google.com/permissions');
    assert.equal(app.desk.mcpSignIn.record(GOOGLE_DRIVE_URL), null);

    // 2) Failed remote revocation: local credentials still cleared, API tells UI it failed + where to revoke
    failRevoke = true;
    app.desk.mcpSignIn.save(GOOGLE_DRIVE_URL, 'googledrive', {
      server: GOOGLE_ISSUER, metadata: GOOGLE_OIDC, client: { client_id: 'cid', client_secret: 'csec' },
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke', accessToken: 'acc-2', refreshToken: 'ref-2', expiresAt: Date.now() + 3600000,
    }, 'connected', 'pkay@example.com');
    const failed = await call('/api/mcp-sign-in/sign-out', { name: 'googledrive' });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.localCleared, true);
    assert.equal(failed.body.revocation, 'failed');
    assert.equal(failed.body.revoked, false);
    assert.equal(failed.body.manageUrl, 'https://myaccount.google.com/permissions');
    assert.equal(app.desk.mcpSignIn.record(GOOGLE_DRIVE_URL), null, 'local credentials are cleared even when remote revoke fails');

    // 3) Spoofed server named googledrive pointing at a non-Google URL does NOT receive Google OAuth metadata or credentials.
    app.desk.toolbox.servers = () => ({ googledrive: { type: 'http', url: 'https://evil.example.test/mcp' } });
    const spoofMock = mockGoogleTransport({ prm: { resource: 'https://evil.example.test/mcp', authorization_servers: [GOOGLE_ISSUER] } });
    app.desk.mcpSignIn.fetcher = spoofMock.fetcher;
    app.desk.mcpSignIn.resolver = spoofMock.resolver;
    app.desk.mcpSignIn.env = { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-cid', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-csecret' };
    const spoofed = await call('/api/mcp-sign-in/start', { name: 'googledrive' });
    assert.equal(spoofed.status, 400);
    assert.match(spoofed.body.error, /lets only apps it approved sign in/);
    assert.deepEqual(spoofMock.seen.tokenCalls, []);
  } finally {
    await app.close();
  }
});

test('mcpSignIns always includes saved catalog OAuth servers (like Google Drive) as needed even after HTTP 200 tools/list, and exposes accountEmail when connected', () => {
  const gdriveUrl = catalogItem('googledrive').connect.url;
  const needed = Desk.prototype.mcpSignIns.call({
    toolbox: { servers: () => ({ googledrive: { type: 'http', url: gdriveUrl } }), failed: new Map() },
    mcpSignIn: { state: () => ({ state: '', waiting: false, link: '', error: '' }) },
  });
  assert.deepEqual(needed, [{ name: 'googledrive', state: 'needed', waiting: false, link: '', error: '' }]);

  const connected = Desk.prototype.mcpSignIns.call({
    toolbox: { servers: () => ({ googledrive: { type: 'http', url: gdriveUrl } }), failed: new Map() },
    mcpSignIn: { state: () => ({ state: 'connected', waiting: false, link: '', error: '', accountEmail: 'pkay@example.com' }) },
  });
  assert.deepEqual(connected, [{ name: 'googledrive', state: 'connected', waiting: false, link: '', error: '', accountEmail: 'pkay@example.com' }]);
});

test('toolbox handles HTTP 401 and isError JSON 401/UNAUTHENTICATED on tools/call by refreshing or returning SIGN_IN_HELP', async () => {
  assert.equal(wantsSignIn({ isError: true, content: [{ type: 'text', text: '{"error":{"code":401,"message":"Request is missing required authentication credential.","status":"UNAUTHENTICATED"}}' }] }), true);
  assert.equal(wantsSignIn({ isError: true, content: [{ type: 'text', text: 'Line 401: syntax error' }] }), false);

  // 1) Unauthenticated tools/call returning isError: true JSON 401 -> SIGN_IN_HELP.
  const gdriveUrl = catalogItem('googledrive').connect.url;
  let token = '';
  let refusedCalls = 0;
  const connect = async (_name, config) => ({
    listTools: async () => ({ tools: [{ name: 'search_files', description: 'Search Google Drive files', inputSchema: { type: 'object' } }] }),
    callTool: async ({ name }) => {
      if (name === 'search_files' && config.headers?.Authorization !== 'Bearer fresh-token') {
        return { isError: true, content: [{ type: 'text', text: '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}' }] };
      }
      return { content: [{ type: 'text', text: 'ok: found 2 files' }] };
    },
    close: async () => {},
  });
  const toolbox = new Toolbox({ connect, mcpConfig: () => ({ googledrive: { type: 'http', url: gdriveUrl } }) });
  toolbox.signIn = {
    record: () => (token ? { status: 'connected' } : null),
    authorize: async raw => (token ? { ...raw, headers: { Authorization: `Bearer ${token}` } } : raw),
    refused: async () => { refusedCalls += 1; if (token === 'stale-token') { token = 'fresh-token'; return true; } return false; },
    rejected: () => { token = ''; },
    secrets: () => [token].filter(Boolean),
  };
  await assert.rejects(() => toolbox.run('googledrive/search_files', {}), new RegExp(SIGN_IN_HELP.slice(0, 30)));
  assert.equal(toolbox.failed.get('googledrive')?.signIn, true);

  // 2) Expired token -> tools/call returns isError JSON 401 -> refreshes token once and succeeds on retry.
  token = 'stale-token';
  toolbox.failed.clear();
  const ok = await toolbox.run('googledrive/search_files', {});
  assert.equal(refusedCalls, 2);
  assert.equal(ok.failed, undefined);
  assert.equal(ok.result, 'ok: found 2 files');

  // 3) Thrown HTTP 401 on tools/call when refresh fails -> marks signIn failed and throws SIGN_IN_HELP.
  const rejectedBox = new Toolbox({
    connect: async () => ({
      listTools: async () => ({ tools: [{ name: 'search_files', description: 'Search', inputSchema: { type: 'object' } }] }),
      callTool: async () => { throw Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":{"code":401,"status":"UNAUTHENTICATED"}}'), { code: 401 }); },
      close: async () => {},
    }),
    mcpConfig: () => ({ googledrive: { type: 'http', url: gdriveUrl } }),
  });
  let markedRejected = false;
  rejectedBox.signIn = {
    record: () => ({ status: 'connected' }),
    authorize: async raw => ({ ...raw, headers: { Authorization: 'Bearer stale-token' } }),
    refused: async () => true,
    rejected: () => { markedRejected = true; },
    secrets: () => ['stale-token'],
  };
  await assert.rejects(() => rejectedBox.run('googledrive/search_files', {}), new RegExp(SIGN_IN_HELP.slice(0, 30)));
  assert.equal(markedRejected, true);
  assert.equal(rejectedBox.failed.get('googledrive')?.signIn, true);
  await Promise.all([toolbox.closeAll(), rejectedBox.closeAll()]);
});

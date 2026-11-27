import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { McpSignIn, SIGN_IN_HELP, emailFromIdToken } from '../src/mcp-signin.js';
import { Toolbox, wantsSignIn } from '../src/toolbox.js';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { catalogItem } from '../src/connector-catalog.js';

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

// Local fake Google-style OIDC server: no registration_endpoint (no DCR), OIDC discovery, client_secret required,
// id_token email + userinfo fallback, revocation endpoint, and HTTP 200 on unauthenticated MCP ping.
function fakeJwt(payload) {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}
async function fakeGoogleServer({ includeIdToken = true, revokeFails = false, email = 'pkay@example.com' } = {}) {
  const seen = { tokenCalls: [], userinfoCalls: 0, revocations: [], access: 'g-access-0', refresh: 'g-refresh-0', challenge: '' };
  let base = '';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, base); let text = ''; for await (const part of request) text += part;
    const json = (status, body, headers = {}) => response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, { resource: `${base}/mcp/v1`, authorization_servers: [base], scopes_supported: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'] });
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: base, authorization_endpoint: `${base}/o/oauth2/v2/auth`, token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`, revocation_endpoint: `${base}/revoke`, jwks_uri: `${base}/certs`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['plain', 'S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(text));
      seen.tokenCalls.push({ form, auth: request.headers.authorization || '' });
      if (form.client_id !== 'google-cid' || form.client_secret !== 'google-csecret') return json(401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        if (createHash('sha256').update(form.code_verifier).digest('base64url') !== seen.challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: seen.access, refresh_token: seen.refresh, token_type: 'Bearer', expires_in: 300, ...(includeIdToken ? { id_token: fakeJwt({ sub: '123', email }) } : {}) });
      }
      if (form.grant_type === 'refresh_token') {
        if (form.refresh_token !== seen.refresh) return json(400, { error: 'invalid_grant' });
        seen.access = `g-access-${seen.tokenCalls.length}`;
        return json(200, { access_token: seen.access, token_type: 'Bearer', expires_in: 3600 });
      }
    }
    if (url.pathname === '/userinfo') {
      seen.userinfoCalls += 1;
      if (request.headers.authorization !== `Bearer ${seen.access}`) return json(401, { error: 'invalid_token' });
      return json(200, { sub: '123', email });
    }
    if (url.pathname === '/revoke') {
      seen.revocations.push(Object.fromEntries(new URLSearchParams(text)));
      if (revokeFails) { response.destroy(); return; }
      return json(200, {});
    }
    if (url.pathname === '/mcp/v1') return json(200, { jsonrpc: '2.0', id: 1, result: {} });
    return json(404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: `${base}/mcp/v1`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

test('Google Drive pre-registered OAuth: no DCR, offline/select_account consent, no resource, client_secret, accountEmail, refresh, and signOut', async () => {
  const gdriveOAuth = catalogItem('googledrive').connect.oauth;
  const fake = await fakeGoogleServer(), store = memoryStore();
  // Missing credentials fail cleanly with plain language.
  const missing = new McpSignIn(store, { loopback: true, env: {} });
  try {
    await assert.rejects(() => missing.start('googledrive', fake.url, gdriveOAuth), /REX_GOOGLE_OAUTH_CLIENT_ID.*REX_GOOGLE_OAUTH_CLIENT_SECRET/);
  } finally { missing.stop(); }

  const signIn = new McpSignIn(store, { loopback: true, env: { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-cid', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-csecret' } });
  try {
    const { url, done } = await signIn.start('googledrive', fake.url, gdriveOAuth);
    const { asked, status } = await browser(fake, url);
    assert.equal(status, 200); await done;
    assert.equal(asked.get('client_id'), 'google-cid');
    assert.equal(asked.get('access_type'), 'offline');
    assert.equal(asked.get('prompt'), 'select_account consent');
    assert.equal(asked.get('scope'), 'https://www.googleapis.com/auth/drive.readonly openid email');
    assert.equal(asked.get('resource'), null, 'Google auth URL omits RFC 8707 resource');
    assert.equal(fake.seen.tokenCalls[0].form.client_id, 'google-cid');
    assert.equal(fake.seen.tokenCalls[0].form.client_secret, 'google-csecret');
    assert.equal(fake.seen.tokenCalls[0].form.resource, undefined, 'Google token exchange omits RFC 8707 resource');
    assert.equal(signIn.state(fake.url).state, 'connected');
    assert.equal(signIn.state(fake.url).accountEmail, 'pkay@example.com');
    assert.doesNotMatch(JSON.stringify([...store.records.values()].map(({ sealed, ...rest }) => rest)), /g-access-|g-refresh-|google-csecret/);
    // Refresh sends client_secret, omits resource, and preserves accountEmail.
    assert.equal(await signIn.refresh(fake.url), true);
    assert.equal(fake.seen.tokenCalls[1].form.grant_type, 'refresh_token');
    assert.equal(fake.seen.tokenCalls[1].form.client_secret, 'google-csecret');
    assert.equal(fake.seen.tokenCalls[1].form.resource, undefined);
    assert.equal(signIn.state(fake.url).accountEmail, 'pkay@example.com');
    assert.equal((await signIn.authorize({ type: 'http', url: fake.url })).headers.Authorization, 'Bearer g-access-2');
    // signOut clears local record and revokes best-effort.
    await signIn.signOut(fake.url);
    assert.equal(signIn.state(fake.url).state, '');
    assert.equal(signIn.state(fake.url).accountEmail, undefined);
    assert.equal(fake.seen.revocations.length, 1);
    assert.equal(fake.seen.revocations[0].token, 'g-refresh-0');
  } finally { signIn.stop(); fake.close(); }
});

test('Google Drive accountEmail falls back to userinfo when id_token is absent, and signOut never fails on revocation network error', async () => {
  assert.equal(emailFromIdToken(fakeJwt({ email: 'a@b.com' })), 'a@b.com');
  assert.equal(emailFromIdToken('not-a-jwt'), '');
  const gdriveOAuth = catalogItem('googledrive').connect.oauth;
  const fake = await fakeGoogleServer({ includeIdToken: false, revokeFails: true, email: 'fallback@example.com' });
  const signIn = new McpSignIn(memoryStore(), { loopback: true, env: { REX_GOOGLE_OAUTH_CLIENT_ID: 'google-cid', REX_GOOGLE_OAUTH_CLIENT_SECRET: 'google-csecret' } });
  try {
    const { url, done } = await signIn.start('googledrive', fake.url, gdriveOAuth);
    await browser(fake, url); await done;
    assert.equal(fake.seen.userinfoCalls, 1);
    assert.equal(signIn.state(fake.url).accountEmail, 'fallback@example.com');
    // Revocation socket drops, yet signOut still succeeds cleanly and clears local state.
    await assert.doesNotReject(() => signIn.signOut(fake.url));
    assert.equal(signIn.state(fake.url).state, '');
  } finally { signIn.stop(); fake.close(); }
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

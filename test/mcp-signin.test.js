import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { McpSignIn, SIGN_IN_HELP } from '../src/mcp-signin.js';
import { Toolbox } from '../src/toolbox.js';
import { Store } from '../src/store.js';

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

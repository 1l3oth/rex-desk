import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpSignIn } from '../src/mcp-signin.js';
import * as guard from '../src/mcp-guard.js';
import { Desk } from '../src/coordinator.js';

// L30 review (8b9b8c6f): where a sign-in's code, verifier or refresh token may go, a stalled registration, addresses that
// carry their own key, and answers whose structure redaction must not break.
function memoryStore() {
  const records = new Map();
  return { get: (kind, id) => records.get(id) ?? null, put: (kind, id, value) => records.set(id, value), delete: (kind, id) => records.delete(id), list: () => [...records.values()], encrypt: text => text, decrypt: text => text };
}
// A sign-in server. token: how /token answers ('ok' or a redirect status); register: 'ok' or 'stall'.
async function authServer({ token = () => 'ok', register = 'ok', expiresIn = 300 } = {}) {
  const seen = { elsewhere: [], token: [] };
  let base = '';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, base); let text = ''; for await (const part of request) text += part;
    const json = (status, body, headers = {}) => response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { if (register === 'stall') return; return json(201, { ...JSON.parse(text), client_id: 'client-1' }); }
    if (url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(text)), how = token(form); seen.token.push(form);
      if (how !== 'ok') return response.writeHead(how, { location: `${base}/elsewhere` }).end();
      return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: expiresIn });
    }
    if (url.pathname === '/elsewhere') { seen.elsewhere.push(text); return json(200, { access_token: 'stolen', token_type: 'Bearer' }); }
    return json(401, { error: 'Unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: `${base}/mcp`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}
async function signInThrough(signIn, fake) {
  const { url, done } = await signIn.start('flow-mcp', fake.url);
  const asked = new URL(url).searchParams, back = new URL(asked.get('redirect_uri'));
  back.searchParams.set('code', 'the-code'); back.searchParams.set('state', asked.get('state'));
  await fetch(back); await done;
}

test('review 1: the code, the verifier and the refresh token go only to the token address, never through a redirect', async () => {
  for (const status of [307, 308]) {
    const fake = await authServer({ token: () => status }), signIn = new McpSignIn(memoryStore(), { loopback: true });
    try {
      await signInThrough(signIn, fake);
      assert.deepEqual(fake.seen.elsewhere, [], `a ${status} on the code exchange is not followed`);
      assert.notEqual(signIn.state(fake.url).state, 'connected');
    } finally { signIn.stop(); fake.close(); }
  }
  let refreshAnswer = 'ok';
  const fake = await authServer({ token: form => form.grant_type === 'refresh_token' ? refreshAnswer : 'ok' }), signIn = new McpSignIn(memoryStore(), { loopback: true });
  try {
    await signInThrough(signIn, fake); assert.equal(signIn.state(fake.url).state, 'connected');
    refreshAnswer = 307;
    assert.equal(await signIn.refresh(fake.url), false);
    assert.deepEqual(fake.seen.elsewhere, [], 'a redirect on refresh is not followed with the refresh token');
  } finally { signIn.stop(); fake.close(); }
});

test('review 1: plain http is refused for the sign-in unless this computer allowed it for a local test server', async () => {
  const fake = await authServer(), signIn = new McpSignIn(memoryStore());
  try {
    await assert.rejects(() => signIn.start('flow-mcp', fake.url), /not a secure address/);
    assert.deepEqual(fake.seen.token, []);
  } finally { signIn.stop(); fake.close(); }
});

test('review 2: a registration that never answers ends the sign-in, with no unhandled failure', { timeout: 8000 }, async () => {
  const unhandled = []; const note = error => unhandled.push(error); process.on('unhandledRejection', note);
  const fake = await authServer({ register: 'stall' }), signIn = new McpSignIn(memoryStore(), { loopback: true, askMs: 300 });
  try {
    await assert.rejects(() => signIn.start('flow-mcp', fake.url), /could not start the sign-in/);
    assert.equal(signIn.state(fake.url).waiting, false);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', note); signIn.stop(); fake.close(); }
});

test('review 3: an address that carries a key is refused for sign-in, and no status shows a server address', async () => {
  const asked = [], signIn = new McpSignIn(memoryStore(), { fetcher: async url => { asked.push(String(url)); throw new Error('no'); } });
  for (const address of ['https://flow.example.test/mcp?api_key=abc', 'https://me:pw@flow.example.test/mcp', 'https://flow.example.test/mcp?access_token=abc'])
    await assert.rejects(() => signIn.start('flow-mcp', address), /key or password in it/);
  assert.deepEqual(asked, [], 'nothing is sent to such an address');
  // The sign-in rows on the pages and in Needs you: by name, never the address.
  const store = memoryStore(); store.put('mcpauth', 'a', { id: 'a', url: 'https://flow.example.test/mcp', name: 'flow-mcp', status: 'expired', at: 'now', sealed: '{}' });
  assert.deepEqual(Object.keys(new McpSignIn(store).expired()[0]).sort(), ['at', 'id', 'name']);
  const rows = Desk.prototype.mcpSignIns.call({
    toolbox: { servers: () => ({ flow: { url: 'https://flow.example.test/mcp' }, keyed: { url: 'https://tool.example.test/mcp?token=abc' } }), failed: new Map([['flow', { signIn: true }], ['keyed', { signIn: true }]]) },
    mcpSignIn: { state: () => ({ state: '', waiting: false, link: '', error: '' }) },
  });
  assert.deepEqual(rows.map(row => row.name), ['flow']);
  assert.doesNotMatch(JSON.stringify(rows), /example\.test/);
});

test('review 4: redaction keeps the MCP structure, holds back what it cannot clean, and withholds base64 that holds a token', () => {
  const answer = { content: [{ type: 'text', text: 'hi' }] };
  assert.throws(() => guard.redactor(['text'])(answer), /held it back/, 'a credential equal to a protocol word never changes a type');
  assert.throws(() => guard.redactor(['42'])({ content: [], structuredContent: { count: 42 } }), /held it back/, 'a number never becomes a string');
  const secret = 'tok-Zq9-secret', b64 = text => Buffer.from(text).toString('base64');
  const clean = guard.redactor([secret])({
    content: [{ type: 'image', mimeType: 'image/png', data: b64(`png${secret}png`) }, { type: 'text', text: `seen ${b64(`a${secret}`)} ok` },
      { type: 'resource', resource: { uri: 'file:///a.bin', mimeType: 'application/octet-stream', blob: b64(`xx${secret}`) } }, { type: 'image', mimeType: 'image/png', data: b64('a plain picture') }],
  });
  assert.deepEqual(clean.content[0].type, 'text'); assert.doesNotMatch(JSON.stringify(clean), new RegExp(`${b64(secret).slice(0, 12)}|${secret}`));
  assert.equal(clean.content[1].text, 'seen [hidden] ok');
  assert.equal(clean.content[2].type, 'resource'); assert.equal(clean.content[2].resource.uri, 'file:///a.bin'); assert.equal(clean.content[2].resource.blob, undefined); assert.equal(typeof clean.content[2].resource.text, 'string');
  assert.deepEqual(clean.content[3], { type: 'image', mimeType: 'image/png', data: b64('a plain picture') }, 'other pictures are left as they are');
  const decoded = Buffer.from(clean.content[0].text || '', 'utf8').toString();
  assert.ok(!decoded.includes(secret));
});

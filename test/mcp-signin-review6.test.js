import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { exchangeAuthorization, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpSignIn, nodeFetch } from '../src/mcp-signin.js';
import { Toolbox } from '../src/toolbox.js';

// The sign-in transport for a local token server: force the pin to loopback so nodeFetch (not the platform fetch) carries
// the SDK's Headers object and URLSearchParams body, which is exactly what the blocker is about.
const pinnedToLoopback = (target, init = {}) => nodeFetch(target, { ...init, pin: { address: '127.0.0.1', family: 4 } });

function memoryStore() {
  const records = new Map();
  return { get: (kind, id) => records.get(id) ?? null, put: (kind, id, value) => records.set(id, value), delete: (kind, id) => records.delete(id), list: () => [...records.values()], encrypt: text => text, decrypt: text => text };
}

// A local token server that records what it actually received (the content-type header and the parsed form body), so a
// transport that drops the SDK's Headers object or cannot write its URLSearchParams body is caught end to end.
async function tokenServer() {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    if (request.url === '/token') {
      seen.push({ contentType: request.headers['content-type'] || '', accept: request.headers['accept'] || '', form: Object.fromEntries(new URLSearchParams(text)) });
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 300 }));
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, metadata: { issuer: base, token_endpoint: `${base}/token` }, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

// L30 review 2aad6cb4 (1): the pinned transport must keep the OAuth SDK's Headers object and write its URLSearchParams body,
// or real token exchange and refresh break. Driven through the real SDK call path against a local token server.
test('review 2aad6cb4 (1): code exchange through the real SDK sends the form body and content-type the server reads', async () => {
  const fake = await tokenServer();
  try {
    const tokens = await exchangeAuthorization(fake.base, { metadata: fake.metadata, clientInformation: { client_id: 'client-1' }, authorizationCode: 'the-code', codeVerifier: 'the-verifier', redirectUri: 'http://127.0.0.1/callback', fetchFn: pinnedToLoopback });
    assert.equal(tokens.access_token, 'access-1');
    assert.equal(fake.seen.length, 1);
    assert.match(fake.seen[0].contentType, /application\/x-www-form-urlencoded/, 'the content-type header survives the transport');
    assert.equal(fake.seen[0].form.grant_type, 'authorization_code', 'the form body is written and read');
    assert.equal(fake.seen[0].form.code, 'the-code');
    assert.equal(fake.seen[0].form.code_verifier, 'the-verifier');
  } finally { fake.close(); }
});

test('review 2aad6cb4 (1): token refresh through the real SDK sends the refresh grant and token in the form body', async () => {
  const fake = await tokenServer();
  try {
    const tokens = await refreshAuthorization(fake.base, { metadata: fake.metadata, clientInformation: { client_id: 'client-1' }, refreshToken: 'refresh-1', fetchFn: pinnedToLoopback });
    assert.equal(tokens.access_token, 'access-1');
    assert.equal(fake.seen.length, 1);
    assert.match(fake.seen[0].contentType, /application\/x-www-form-urlencoded/);
    assert.equal(fake.seen[0].form.grant_type, 'refresh_token');
    assert.equal(fake.seen[0].form.refresh_token, 'refresh-1', 'the refresh token reaches the server in the body');
  } finally { fake.close(); }
});

// L30 review 2aad6cb4 (2): a failed or empty DNS lookup must fail closed, never fall back to an unpinned fetch that could
// reach an unchecked address. Only the configured server's own origin may be reached without a resolved, checked pin.
test('review 2aad6cb4 (2): a pinned request whose host cannot be resolved is refused, not sent unchecked', async () => {
  let sent = false;
  const fetcher = async () => { sent = true; return { status: 200, headers: { get: () => null }, json: async () => ({}), body: { cancel: async () => {} } }; };
  for (const resolver of [async () => { throw new Error('ENOTFOUND'); }, async () => []]) {
    const signIn = new McpSignIn(memoryStore(), { fetcher, resolver });
    const pinned = signIn.pinned('https://auth.example.test/token', 'token address', 'https://server.example.test');
    await assert.rejects(() => pinned('https://auth.example.test/token', { method: 'POST' }), /could not be checked/, 'an off-origin host that does not resolve is refused');
  }
  assert.equal(sent, false, 'nothing is sent while the address cannot be checked');
});

test('review 2aad6cb4 (2): the configured server\'s own origin is still reached without a resolved pin', async () => {
  const seen = [];
  const fetcher = async (url, init) => { seen.push(init.pin); return { status: 200, headers: { get: () => null }, json: async () => ({}), body: { cancel: async () => {} } }; };
  const resolver = async () => { throw new Error('ENOTFOUND'); };
  const signIn = new McpSignIn(memoryStore(), { fetcher, resolver });
  const pinned = signIn.pinned('https://server.example.test/token', 'token address', 'https://server.example.test');
  await pinned('https://server.example.test/token', { method: 'POST' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], null, 'the home origin is reached as named, with no pin, so a private server the person set up still signs in');
});

// L30 review 2aad6cb4 (3): Market must expand environment variables before checking a key, on every write path, so a
// reference that resolves to a short key is refused before anything is written and the pasted text is kept.
test('review 2aad6cb4 (3): a reference that expands to a short key is refused before any Market write, nothing is written', async () => {
  process.env.REX_REVIEW6_KEY = 'abc';
  try {
    const box = new Toolbox({ home: '.', mcpConfig: () => ({}), bundled: '' });
    const written = []; box.cli = async args => { written.push(args); };
    // A pasted command, a JSON block and the typed-field path, each carrying a reference that expands to a 3-character key.
    await assert.rejects(() => box.install('npx -y @scope/foo-mcp --token ${REX_REVIEW6_KEY}'), /at least 8/, 'a command reference');
    await assert.rejects(() => box.install('{"mcpServers":{"s":{"url":"https://h.test/mcp","headers":{"Authorization":"Bearer ${REX_REVIEW6_KEY}"}}}}'), /at least 8/, 'a JSON header reference');
    await assert.rejects(() => box.addServer({ name: 'typed', url: 'https://h.test/mcp?token=${REX_REVIEW6_KEY}' }), /at least 8/, 'a typed-field reference');
    assert.deepEqual(written, [], 'nothing is written while a reference resolves to a short key');
  } finally { delete process.env.REX_REVIEW6_KEY; }
});

test('review 2aad6cb4 (3): a reference that expands to a full key passes and is written', async () => {
  process.env.REX_REVIEW6_KEY = 'abcdefgh';
  try {
    const box = new Toolbox({ home: '.', mcpConfig: () => ({}), bundled: '' });
    const written = []; box.cli = async args => { written.push(args); };
    await box.install('{"mcpServers":{"s":{"url":"https://h.test/mcp","headers":{"Authorization":"Bearer ${REX_REVIEW6_KEY}"}}}}');
    assert.equal(written.length, 1, 'a reference that resolves to a full key is written');
  } finally { delete process.env.REX_REVIEW6_KEY; }
});

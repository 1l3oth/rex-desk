import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpSignIn, nodeFetch } from '../src/mcp-signin.js';
import { Toolbox } from '../src/toolbox.js';

function memoryStore() {
  const records = new Map();
  return { get: (kind, id) => records.get(id) ?? null, put: (kind, id, value) => records.set(id, value), delete: (kind, id) => records.delete(id), list: () => [...records.values()], encrypt: text => text, decrypt: text => text };
}

// L30 review 81b72441 (1): the address that passed the private-address check is the address the connection uses. The DNS
// result is taken once and pinned, so a name that answers public on the check and private on the connect cannot slip past.
test('review 81b72441 (1): a pinned request resolves once and connects to that checked address, not a second resolution', async () => {
  let calls = 0;
  const resolver = async () => { calls += 1; return [{ address: calls === 1 ? '93.184.216.34' : '10.0.0.5', family: 4 }]; };
  const seen = [];
  const fetcher = async (url, init) => { seen.push(init.pin); return { status: 200, headers: { get: () => null }, json: async () => ({}), body: { cancel: async () => {} } }; };
  const signIn = new McpSignIn(memoryStore(), { fetcher, resolver });
  const pinned = signIn.pinned('https://auth.example.test/token', 'token address', 'https://server.example.test');
  await pinned('https://auth.example.test/token', { method: 'POST', body: 'grant_type=authorization_code' });
  assert.equal(calls, 1, 'the host is resolved exactly once');
  assert.deepEqual(seen[0], { address: '93.184.216.34', family: 4 }, 'the connection is pinned to the checked public address, never a fresh resolution that could flip to private');
});

test('review 81b72441 (1): a request whose host resolves to a private address is refused before it is sent', async () => {
  const resolver = async () => [{ address: '10.0.0.5', family: 4 }];
  let sent = false;
  const fetcher = async () => { sent = true; return { status: 200, headers: { get: () => null }, json: async () => ({}), body: { cancel: async () => {} } }; };
  const signIn = new McpSignIn(memoryStore(), { fetcher, resolver });
  const pinned = signIn.pinned('https://auth.example.test/token', 'token address', 'https://server.example.test');
  await assert.rejects(() => pinned('https://auth.example.test/token', { method: 'POST' }), /points inside this computer or network/);
  assert.equal(sent, false, 'nothing is sent to a private address');
});

test('review 81b72441 (1): nodeFetch connects to the pinned address while keeping the host name for the Host header', async () => {
  const server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json', 'x-host': request.headers.host }).end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // The URL names a host that does not resolve; only the pin lets the socket reach the local server.
    const response = await nodeFetch(`http://auth.example.test:${port}/token`, { method: 'POST', body: 'x=1', pin: { address: '127.0.0.1', family: 4 } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('x-host'), `auth.example.test:${port}`, 'the Host header keeps the real host name, not the pinned IP');
  } finally { server.close(); }
});

// L30 review 81b72441 (2): every install path (a pasted command, a bare URL, a JSON block) is checked before a server is
// written, so a short key never reaches Claude Code's config and the pasted text can be kept and fixed.
test('review 81b72441 (2): a short key in a pasted bare URL or command is refused before anything is written', async () => {
  const box = new Toolbox({ home: '.', mcpConfig: () => ({}), bundled: '' });
  const written = []; box.cli = async args => { written.push(args); };
  await assert.rejects(() => box.install('https://h.test/mcp?token=abc'), /at least 8/, 'a bare URL with a short key');
  await assert.rejects(() => box.install('npx -y @scope/foo-mcp --token abc'), /at least 8/, 'a command with a short key flag');
  await assert.rejects(() => box.install('{"mcpServers":{"s":{"url":"https://h.test/mcp","headers":{"Authorization":"Bearer abc"}}}}'), /at least 8/, 'a JSON block with a short header key');
  assert.deepEqual(written, [], 'nothing is written while a key is too short, so the pasted text is not lost');
});

test('review 81b72441 (2): a full key in a bare URL passes the check and is written', async () => {
  const box = new Toolbox({ home: '.', mcpConfig: () => ({}), bundled: '' });
  const written = []; box.cli = async args => { written.push(args); };
  await box.install('https://h.test/mcp?token=abcdefgh');
  assert.equal(written.length, 1, 'a full key is written');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { McpSignIn } from '../src/mcp-signin.js';
import * as guard from '../src/mcp-guard.js';
import * as box from '../src/toolbox.js';

// L30 review a36eb522: encoded secrets in short text and protocol fields, credentials in addresses the server names, a
// malformed callback request, and what the person reads for a server that wants a sign-in.
function memoryStore() {
  const records = new Map();
  return { get: (kind, id) => records.get(id) ?? null, put: (kind, id, value) => records.set(id, value), delete: (kind, id) => records.delete(id), list: () => [...records.values()], encrypt: text => text, decrypt: text => text };
}
// A sign-in server whose metadata can be changed per test (meta gets the base address).
async function authServer(meta = () => ({})) {
  let base = '';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, base); let text = ''; for await (const part of request) text += part;
    const json = (status, body, headers = {}) => response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], ...meta(base) });
    if (url.pathname === '/register') return json(201, { ...JSON.parse(text), client_id: 'client-1' });
    if (url.pathname === '/token') return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
    return json(401, { error: 'Unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: `${base}/mcp`, close: () => { server.closeAllConnections(); server.close(); } };
}
const b64 = text => Buffer.from(text).toString('base64');

test('review a36eb522 (1): a short secret encoded in text, and any encoded secret in an address field, never pass', () => {
  const secret = 'Zq9', clean = guard.redactor([secret]);
  assert.equal(clean({ content: [{ type: 'text', text: `seen ${b64(secret)} ok` }] }).content[0].text, 'seen [hidden] ok', 'base64 shorter than 8 characters');
  for (const uri of [`file:///x/${b64(`a${secret}`)}`, `https://x.test/?q=${Buffer.from(secret).toString('hex')}`, `data:text/plain;base64,${encodeURIComponent(b64(secret))}`])
    assert.throws(() => clean({ contents: [{ uri, text: 'a' }] }), /held it back/, uri);
  assert.deepEqual(clean({ contents: [{ uri: 'file:///notes/today.md', text: 'a' }] }).contents[0].uri, 'file:///notes/today.md', 'a plain address is left alone');
});

test('review a36eb522 (2): an address the server names with a key in it stops the sign-in before any page is shown', async () => {
  const cases = [
    base => ({ token_endpoint: `${base}/token?api_key=abc` }),
    base => ({ authorization_endpoint: `${base}/authorize?access_token=abc` }),
    base => ({ registration_endpoint: `https://me:pw@${base.slice(7)}/register` }),
  ];
  for (const meta of cases) {
    const fake = await authServer(meta), signIn = new McpSignIn(memoryStore(), { loopback: true });
    try {
      await assert.rejects(() => signIn.start('flow-mcp', fake.url), /key or password in it|not a secure address/);
      assert.equal(signIn.state(fake.url).link, '');
    } finally { signIn.stop(); fake.close(); }
  }
});

test('review a36eb522 (3): a malformed callback request gets a 400 and the sign-in still finishes', async () => {
  const fake = await authServer(), signIn = new McpSignIn(memoryStore(), { loopback: true });
  const crashes = []; const note = error => crashes.push(error); process.on('uncaughtException', note);
  try {
    const { url, done } = await signIn.start('flow-mcp', fake.url);
    const asked = new URL(url).searchParams, back = new URL(asked.get('redirect_uri'));
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(back.port), '127.0.0.1', () => socket.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
      let text = ''; socket.on('data', part => { text += part; }); socket.on('end', () => resolve(text)); socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    back.searchParams.set('code', 'the-code'); back.searchParams.set('state', asked.get('state'));
    assert.equal((await fetch(back)).status, 200, 'the listener is still there');
    await done;
    assert.equal(signIn.state(fake.url).state, 'connected');
    assert.deepEqual(crashes, []);
  } finally { process.off('uncaughtException', note); signIn.stop(); fake.close(); }
});

test('a remote server that wants a sign-in (like Notion) says so in plain words, and its address is shown without a key', async () => {
  const refused = () => Object.assign(new Error('Error POSTing to endpoint (HTTP 401): invalid_token'), { code: 401 });
  const toolbox = new box.Toolbox({ connect: async () => { throw refused(); }, mcpConfig: () => ({ notion: { type: 'http', url: 'https://mcp.notion.example.test/mcp' }, keyed: { type: 'http', url: 'https://tool.example.test/mcp?api_key=abc' } }) });
  await toolbox.toolsOf('notion', toolbox.servers().notion);
  assert.equal(toolbox.shownError('notion'), 'Needs sign-in. Press Sign in for it in Settings, Connectors.');
  const overview = await toolbox.overview();
  assert.equal(overview.servers.find(item => item.name === 'notion').error, 'Needs sign-in. Press Sign in for it in Settings, Connectors.');
  assert.equal(overview.servers.find(item => item.name === 'keyed').how, 'https://tool.example.test/mcp');
  await toolbox.closeAll();
});

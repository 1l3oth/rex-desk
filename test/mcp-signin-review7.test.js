import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpSignIn, nodeFetch } from '../src/mcp-signin.js';

// L30 review 4941d45c (1): a connection that drops after the headers but before the body ends must fail, not hang, so a
// sign-in or refresh that loses its server gives up instead of waiting forever.
test('review 4941d45c (1): nodeFetch rejects when the server cuts the body', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    response.write('{"partial":'); // headers and a partial body, then the socket is destroyed
    response.socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(() => nodeFetch(`http://auth.example.test:${port}/token`, { method: 'POST', body: 'x=1', pin: { address: '127.0.0.1', family: 4 } }), /connection|socket|aborted|closed/i);
  } finally { server.close(); }
});

function memoryStore() {
  const records = new Map();
  return { get: (kind, id) => records.get(id) ?? null, put: (kind, id, value) => records.set(id, value), delete: (kind, id) => records.delete(id), list: () => [...records.values()], encrypt: text => text, decrypt: text => text };
}
async function authServer({ tokenStatus = 200 } = {}) {
  let base = '';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, base); let text = ''; for await (const part of request) text += part;
    const json = (status, body, headers = {}) => response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') return json(201, { ...JSON.parse(text), client_id: 'client-1' });
    if (url.pathname === '/token') { if (tokenStatus !== 200) return json(tokenStatus, { error: 'invalid_grant' }); return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 300 }); }
    return json(401, { error: 'Unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: `${base}/mcp`, close: () => { server.closeAllConnections(); server.close(); } };
}
async function callback(signIn, fake) {
  const { url, done } = await signIn.start('flow-mcp', fake.url);
  const asked = new URL(url).searchParams, back = new URL(asked.get('redirect_uri'));
  back.searchParams.set('code', 'the-code'); back.searchParams.set('state', asked.get('state'));
  const page = await fetch(back).then(response => response.text());
  await done.catch(() => {});
  return page;
}

// L30 review 4941d45c (2): the tab says "Signed in" only after the token exchange and save succeed; a failed exchange shows
// a plain failure page, never a false success.
test('review 4941d45c (2): the callback page says Signed in only after the sign-in is saved', async () => {
  const fake = await authServer(), signIn = new McpSignIn(memoryStore(), { loopback: true });
  try {
    const page = await callback(signIn, fake);
    assert.match(page, /Signed in/, 'the tab confirms success');
    assert.equal(signIn.state(fake.url).state, 'connected', 'and it is saved by the time the tab is told');
  } finally { signIn.stop(); fake.close(); }
});

test('review 4941d45c (2): a failed token exchange shows a plain failure page, not a false Signed in', async () => {
  const fake = await authServer({ tokenStatus: 400 }), signIn = new McpSignIn(memoryStore(), { loopback: true });
  try {
    const page = await callback(signIn, fake);
    assert.doesNotMatch(page, /Signed in/, 'no false success');
    assert.match(page, /could not finish/, 'a plain failure page');
    assert.notEqual(signIn.state(fake.url).state, 'connected', 'nothing is saved as connected');
  } finally { signIn.stop(); fake.close(); }
});

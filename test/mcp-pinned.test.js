import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Toolbox, connectServer } from '../src/toolbox.js';

// L30 review: a request that carries a sign-in stays on the address it was made for, and nothing a server sends back
// shows that sign-in again. "orbit" is the Orbit account: a fixed Authorization header, with no sign-in record.
const ORBIT = 'orbit-account-secret';
const config = (url, token = ORBIT, type = 'http') => ({ type, url, headers: { Authorization: `Bearer ${token}` } });
const within = (promise, ms = 8000) => Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Waited too long.')), ms).unref())]);

// A small MCP server over Streamable HTTP (/mcp) or the older SSE (/sse, which posts to /messages). redirect says which
// requests it sends elsewhere on its own origin; everything it was sent anywhere else is kept in "strayed".
async function mcpServer({ redirect = () => '' } = {}) {
  const strayed = [], streams = new Set();
  const answer = asked => ({ jsonrpc: '2.0', id: asked.id, result: asked.method === 'initialize' ? { protocolVersion: asked.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
    : asked.method === 'tools/list' ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'ok' }] } });
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    const asked = text ? JSON.parse(text) : {};
    if (!['/mcp', '/sse', '/messages'].includes(request.url)) { strayed.push(`${request.method} ${request.url} ${request.headers.authorization || ''}`); return response.writeHead(404).end(); }
    const to = redirect(request, asked);
    if (to) return response.writeHead(307, { location: to }).end();
    if (request.url === '/sse') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('event: endpoint\ndata: /messages\n\n'); streams.add(response); return; }
    if (request.url === '/messages') { response.writeHead(202).end(); if (asked.id !== undefined) for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(answer(asked))}\n\n`); return; }
    if (request.method !== 'POST') return response.writeHead(405).end();
    if (asked.id === undefined) return response.writeHead(202).end();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer(asked)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, strayed, close: () => { server.closeAllConnections(); server.close(); } };
}
// Opens the server the way the toolbox and the bridge do, uses a tool, and says whether that worked.
async function use(settings) {
  const toolbox = new Toolbox({ mcpConfig: () => ({}) });
  try { await within(toolbox.signed('orbit', settings, async client => { await client.listTools(); return client.callTool({ name: 'whoami', arguments: {} }); })); return ''; }
  catch (error) { return String(error.message); }
  finally { await toolbox.closeAll(); }
}

const REDIRECTS = [
    ['Streamable HTTP, connecting', 'http', '/mcp', request => request.method === 'POST' && '/moved'],
    ['Streamable HTTP, a later call', 'http', '/mcp', (request, asked) => asked.method === 'tools/call' && '/moved'],
    ['Streamable HTTP, its listening stream', 'http', '/mcp', request => request.method === 'GET' && '/moved'],
    ['SSE, opening the stream', 'sse', '/sse', request => request.url === '/sse' && '/moved'],
    ['SSE, a message', 'sse', '/sse', (request, asked) => asked.method === 'tools/call' && '/moved'],
];
for (const [what, type, route, redirect] of REDIRECTS) {
  test(`with a sign-in, a same-origin redirect is not followed: ${what}`, async () => {
    const fake = await mcpServer({ redirect });
    try {
      const failed = await use(config(`${fake.base}${route}`, ORBIT, type));
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.deepEqual(fake.strayed, [], `${what}: the sign-in went to another address`);
      // The listening stream is optional, so only the other cases must fail, and say why in Rex Desk's own words.
      if (!what.endsWith('listening stream')) assert.match(failed, /tried to send Rex Desk to another address/, what);
    } finally { fake.close(); }
  });
}

test('with a sign-in, both transports still work on the registered address', async () => {
  const fake = await mcpServer();
  try {
    assert.equal(await use(config(`${fake.base}/mcp`)), '');
    assert.equal(await use(config(`${fake.base}/sse`, ORBIT, 'sse')), '');
    const client = await within(connectServer('open', { type: 'sse', url: `${fake.base}/sse` })); await client.close();
  } finally { fake.close(); }
});

// A server that repeats the sign-in in every part of its answers.
const echo = token => ({
  content: [{ type: 'text', text: `you sent ${token} (${token})` }, { type: 'text', text: JSON.stringify({ auth: `Bearer ${token}` }) },
    // The same value written with JSON escapes only.
    { type: 'text', text: `{"auth":"${[...token].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"}` }],
  structuredContent: { nested: [{ [token]: token, deeper: { again: `x${token}y` } }] },
});
// Every string an agent could read in a value, with JSON written inside a string read too.
const readable = value => {
  if (typeof value === 'string') { try { const inner = JSON.parse(value); if (inner && typeof inner === 'object') return [value, ...readable(inner)]; } catch { /* plain words */ } return [value]; }
  return value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [...(Array.isArray(value) ? [] : [key]), ...readable(item)]) : [];
};
const shows = (value, token) => readable(value).some(text => text.includes(token));
const CREDENTIALS = [['a short one', 'Zq9'], ['two characters', '~^'], ['with quotes, slashes and line breaks', 'Zq"9\\7/\n\t§'], ['a long one', ORBIT]];

for (const [what, token] of CREDENTIALS) {
  test(`an echoed sign-in is hidden in every decoded field: ${what}`, async () => {
    const rpcError = () => Object.assign(new Error(`MCP error -32602: bad ${token}`), { name: 'McpError', code: -32602, data: { token } });
    // Orbit's fixed header, and a signed-in server whose old and renewed secrets come from the sign-in.
    for (const signed of [false, true]) {
      const settings = signed ? { type: 'http', url: 'https://flow.example.test/mcp' } : config('https://orbit.example.test/mcp', token);
      let next = () => echo(token);
      const connect = async () => ({ listTools: async () => ({ tools: [{ name: 'whoami', description: `sent ${token}`, inputSchema: { type: 'object', properties: { [token]: { type: 'string', default: token } } } }] }), callTool: async () => next(), close: async () => {} });
      const toolbox = new Toolbox({ connect, mcpConfig: () => ({ orbit: settings }) });
      if (signed) { let held = [token]; toolbox.signIn = { record: () => ({}), authorize: async raw => ({ ...raw, headers: { 'X-Kept': '1' } }), secrets: () => { const now = held; return now; }, refused: async () => false }; const read = next; next = () => { held = ['renewed-secret']; return read(); }; }
      const answer = await toolbox.signed('orbit', settings, client => client.callTool());
      assert.ok(!shows(answer, token), `${what}: an answer`);
      assert.equal(answer.content[0].text, 'you sent [hidden] ([hidden])', what);
      if (signed) continue;
      assert.ok(!shows(await toolbox.toolsOf('orbit', settings), token), `${what}: the tool list`);
      assert.ok(!shows((await toolbox.run('orbit/whoami', {})).result, token), `${what}: desk_run`);
      // Errors: the server's own protocol error is cleaned; a failed request never passes on what came back with it.
      next = () => { throw rpcError(); };
      await assert.rejects(() => toolbox.signed('orbit', settings, client => client.callTool()), error => !shows(error.message, token) && !error.data && /bad \[hidden\]/.test(error.message), `${what}: a protocol error`);
      const body = `{"seen":${JSON.stringify(`Bearer ${token}`).replaceAll('/', '\\/')}}`;
      next = () => { throw Object.assign(new Error(`Error POSTing to endpoint: ${body}`), { code: 500 }); };
      await assert.rejects(() => toolbox.run('orbit/whoami', {}), { message: 'orbit: the server answered with an error (HTTP 500).' }, `${what}: a failed request`);
      toolbox.lists.clear(); toolbox.connectWith = async () => { throw Object.assign(new Error(`Error POSTing to endpoint: ${body}`), { code: 500 }); };
      await toolbox.closeAll(); await toolbox.toolsOf('orbit', settings);
      assert.ok(!shows(toolbox.failed.get('orbit').error, token), `${what}: the reason on the connector`);
    }
  });
}

test('credentials in other headers, and ones filled in from the environment, are hidden too', async () => {
  process.env.PINNED_TEST_KEY = 'k7';
  const settings = { type: 'http', url: 'https://tool.example.test/mcp', headers: { 'X-API-Key': '${PINNED_TEST_KEY}', Cookie: 'sid=c8', 'Proxy-Authorization': 'Basic p9==', Accept: 'application/json' } };
  const toolbox = new Toolbox({ connect: async () => ({ callTool: async () => ({ content: [{ type: 'text', text: 'k7 | c8 | p9== | application/json' }] }), close: async () => {} }), mcpConfig: () => ({}) });
  try { assert.equal((await toolbox.signed('tool', settings, client => client.callTool())).content[0].text, '[hidden] | [hidden] | [hidden] | application/json'); }
  finally { delete process.env.PINNED_TEST_KEY; await toolbox.closeAll(); }
});

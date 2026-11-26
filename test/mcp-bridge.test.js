import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/server.js';
import { ClaudeRunner } from '../src/runners.js';
import { CodexRunner } from '../src/codex.js';

// L30 review: a provider's token stays inside Rex Desk. A local server plays two signed-in MCP servers (a remote one and
// the Orbit account). It echoes the Authorization header back, the way a careless server might.
const TOKENS = ['flow-access-secret', 'flow-refresh-secret', 'orbit-account-secret'];
const noToken = (value, what) => { const text = typeof value === 'string' ? value : JSON.stringify(value); for (const token of TOKENS) assert.ok(!text.includes(token), `${what} holds ${token}`); };
async function provider() {
  const seen = { auth: [], broken: false };
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    const auth = request.headers.authorization || '';
    seen.auth.push(`${request.url} ${auth}`);
    const wanted = request.url.startsWith('/orbit') ? 'Bearer orbit-account-secret' : 'Bearer flow-access-secret';
    if (auth !== wanted) return response.writeHead(401).end('no');
    if (seen.broken) return response.writeHead(500).end(`upstream failed for ${auth}`);
    if (request.method !== 'POST') return response.writeHead(405).end();
    const mcp = new Server({ name: 'fake', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'whoami', description: `Called with ${auth}`, inputSchema: { type: 'object' } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async asked => ({ content: [{ type: 'text', text: `${asked.params.name} saw ${auth}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport); await transport.handleRequest(request, response, JSON.parse(text));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}
const waitFor = async (check, what) => { for (let i = 0; i < 400; i++) { const found = check(); if (found) return found; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`Waited too long for ${what}.`); };
const filesUnder = folder => readdirSync(folder, { withFileTypes: true, recursive: true }).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
async function connect(config) {
  const client = new Client({ name: 'agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  return client;
}
// What the agent's process would give Claude Code and Codex: their environment and MCP settings, from the launch file.
async function claudeSees(options) {
  let seen;
  const sdk = { query: ({ options: given }) => { seen = { env: given.env, mcpServers: given.mcpServers }; return (async function* () {})(); } };
  await new ClaudeRunner({ ...options, run: { ...options.run, sessionId: '' }, sdk, event: () => {}, ask: async () => ({}), controller: new AbortController() }).start('hello').catch(() => {});
  return seen;
}
async function codexSees(options) {
  const seen = { env: null, requests: [] };
  const clientFactory = ({ env, onError }) => { seen.env = env; return { open: async () => {}, close: () => {}, request: async (method, params) => {
    seen.requests.push({ method, params });
    if (method === 'turn/start') setImmediate(() => onError(new Error('end of test')));
    return method === 'account/read' ? { account: { type: 'chatgpt' } } : method === 'turn/start' ? { turn: { id: 'turn' } } : { thread: { id: 'thread' } };
  } }; };
  await new CodexRunner({ ...options, run: { ...options.run, sessionId: '' }, clientFactory, event: () => {}, ask: async () => ({}) }).start('hello').catch(() => {});
  return seen;
}

test('toolbox on or off: no launch file, run file or agent environment holds a provider token; Rex Desk makes the signed requests', async () => {
  const upstream = await provider(), root = path.join(os.tmpdir(), `bridge-${process.pid}`), home = path.join(root, 'home'), data = path.join(root, 'data');
  mkdirSync(home, { recursive: true });
  const flow = `${upstream.base}/mcp`, kept = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, REX_DESK_MEMORY: process.env.REX_DESK_MEMORY };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, REX_DESK_MEMORY: path.join(root, 'memory') }); delete process.env.CLAUDE_CONFIG_DIR;
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'flow-mcp': { type: 'http', url: flow } } }));
  const app = await createApp({ dataDirectory: data, port: 0, requireAccount: false });
  try {
    const { desk } = app, store = desk.store, specs = [];
    desk.agents.ensureSignedIn = async () => {};
    desk.toolbox.mcpConfig = () => ({ 'flow-mcp': { type: 'http', url: flow } });
    // The agent's process is not started: its launch file is kept as it was written.
    desk.hostOptions = { pollMs: 25, spawner: (node, [, specFile]) => { specs.push({ specFile, text: readFileSync(specFile, 'utf8') }); return { pid: 0, unref() {} }; } };
    desk.mcpSignIn.save(flow, 'flow-mcp', { accessToken: TOKENS[0], refreshToken: TOKENS[1], expiresAt: 0 });
    store.put('secret', 'orbit-account', store.encrypt(JSON.stringify({ base: `${upstream.base}/orbit`, token: TOKENS[2] })));

    for (const toolGateway of [true, false]) {
      const mode = `toolbox ${toolGateway ? 'on' : 'off'}`, config = store.config.bind(store);
      store.config = () => ({ ...config(), toolGateway });
      const count = specs.length;
      await desk.startWebTask(`look something up, ${mode}`);
      const spec = JSON.parse((await waitFor(() => specs[count], `the launch file, ${mode}`)).text);
      noToken(specs[count].text, `the launch file, ${mode}`);
      const names = Object.keys(spec.options.extraMcp).sort();
      assert.deepEqual(names, toolGateway ? ['orbit'] : ['flow-mcp', 'orbit'], mode);
      const claude = await claudeSees(spec.options), codex = await codexSees(spec.options);
      assert.ok(claude.mcpServers.orbit && codex.env, `${mode}: both agents were started`);
      noToken(claude, `Claude's environment and settings, ${mode}`); noToken(codex, `Codex's environment and settings, ${mode}`);
      for (const file of filesUnder(data)) noToken(readFileSync(file, 'latin1'), `${file}, ${mode}`);

      // The agent reaches each server through Rex Desk with its run token, and nothing that comes back holds a token.
      for (const name of names) {
        const given = claude.mcpServers[name];
        assert.equal(new URL(given.url).pathname, `/mcp-signed/${name}`);
        assert.equal(given.headers.Authorization, `Bearer ${spec.options.token}`);
        const client = await connect(given);
        const tools = await client.listTools(); assert.equal(tools.tools[0].name, 'whoami'); noToken(tools, 'a tool list');
        const answer = await client.callTool({ name: 'whoami', arguments: {} });
        assert.equal(answer.content[0].text, 'whoami saw Bearer [hidden]');
        upstream.seen.broken = true; await desk.toolbox.closeAll();
        await assert.rejects(() => client.callTool({ name: 'whoami', arguments: {} }), error => { noToken(error.message, 'an error'); assert.match(error.message, /did not answer this request/); return true; });
        upstream.seen.broken = false; await client.close();
      }
      assert.ok(upstream.seen.auth.includes(`/mcp Bearer ${TOKENS[0]}`) || toolGateway, 'Rex Desk sent the token itself');
      // With the toolbox, desk_run is scrubbed the same way.
      const ran = await desk.toolbox.run('flow-mcp/whoami', {}); assert.equal(ran.result, 'whoami saw Bearer [hidden]');
      noToken(await desk.toolbox.find('whoami'), 'desk_find');

      const url = given => new URL(given, desk.mcpUrl);
      const ask = async (name, token) => (await fetch(url(`/mcp-signed/${name}`), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).status;
      assert.equal(await ask('orbit', 'wrong'), 401);
      assert.equal(await ask('orbit', store.token), 401, 'only a run token, which names its run');
      assert.equal(await ask('other', spec.options.token), 404);
      if (toolGateway) assert.equal(await ask('flow-mcp', spec.options.token), 404, 'with the toolbox on it is reached through desk_run only');
      const runId = spec.options.run.id;
      store.put('run', runId, { ...store.get('run', runId), locked: true });
      assert.equal(await ask('orbit', spec.options.token), 404, 'never for a locked run');
      appendFileSync(spec.journal || JSON.parse(specs[count].text).journal, `${JSON.stringify({ type: 'done' })}\n`);
      await waitFor(() => !desk.live.has(runId), 'the turn to end');
      store.config = config;
    }
  } finally {
    await app.close(); upstream.close();
    for (const [key, value] of Object.entries(kept)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

// Sign-in errors: what a server writes can hold sensitive values, so only its OAuth error code picks Rex Desk's own words.
async function signInServer({ register, token } = {}) {
  let base = '';
  const server = http.createServer(async (request, response) => {
    for await (const part of request) void part;
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.url.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (request.url === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
    if (request.url === '/register') return register ? json(...register) : json(201, { client_id: 'client-1', redirect_uris: ['http://127.0.0.1/callback'] });
    if (request.url === '/token') return json(...token);
    return json(401, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: `${base}/mcp`, close: () => { server.closeAllConnections(); server.close(); } };
}

test('sign-in errors show fixed words chosen by the OAuth error code, never what the server wrote', async () => {
  const { McpSignIn } = await import('../src/mcp-signin.js');
  const records = new Map(), signIn = new McpSignIn({ get: (kind, id) => records.get(id) ?? null, put: (kind, id, value) => records.set(id, value), delete: (kind, id) => records.delete(id), list: () => [...records.values()], encrypt: text => text, decrypt: text => text });
  const secret = 'SECRET-code-123 https://example.test/?key=abc';
  const back = async (link, params) => { const asked = new URL(link).searchParams, url = new URL(asked.get('redirect_uri')); for (const [key, value] of Object.entries({ state: asked.get('state'), ...params })) url.searchParams.set(key, value); return (await fetch(url)).text(); };
  const cases = [
    [{ token: [400, { error: 'invalid_grant', error_description: secret }] }, { code: 'c' }, 'The sign-in was no longer valid. Try again.'],
    [{ token: [400, { error: secret, error_description: secret }] }, { code: 'c' }, null],
    [{ token: [500, { oops: secret }] }, { code: 'c' }, null],
    [{}, { error: 'access_denied', error_description: secret }, 'The sign-in was refused. Try again and allow Rex Desk.'],
    [{}, { error: secret }, 'The sign-in failed. Try again.'],
    [{}, { error: 'toString' }, 'The sign-in failed. Try again.'],
  ];
  try {
    for (const [answers, params, words] of cases) {
      const fake = await signInServer(answers);
      const { url, done } = await signIn.start('flow-mcp', fake.url);
      const page = await back(url, params); await done; fake.close();
      const shown = signIn.state(fake.url).error;
      if (words) assert.equal(shown, words); else assert.match(shown, /^(The sign-in failed\. Try again\.|The sign-in server had a problem\. Try again later\.)$/);
      assert.ok(!`${shown}${page}`.includes('SECRET'), shown);
    }
    const refusing = await signInServer({ register: [400, { error: 'invalid_client_metadata', error_description: secret }] });
    await assert.rejects(() => signIn.start('flow-mcp', refusing.url), { message: 'Rex Desk could not start the sign-in. The server did not let Rex Desk register to sign in.' });
    refusing.close();
    const odd = new McpSignIn(signIn.store, { fetcher: async () => { throw new Error(secret); } });
    await assert.rejects(() => odd.start('flow-mcp', 'https://example.test/mcp'), { message: 'Rex Desk could not start the sign-in. The sign-in failed. Try again.' });
  } finally { signIn.stop(); }
});

// The browser comes back to a one-time address on the computer running Rex Desk, which a phone cannot reach.
test('a phone is told to finish sign-in on the computer running Rex Desk, and gets no sign-in link or button', async () => {
  const root = path.join(os.tmpdir(), `bridge-phone-${process.pid}`), flow = 'https://flow.example.test/mcp';
  const app = await createApp({ dataDirectory: path.join(root, 'data'), port: 0, requireAccount: false });
  try {
    const { desk } = app;
    desk.toolbox.mcpConfig = () => ({ 'flow-mcp': { type: 'http', url: flow } });
    desk.toolbox.connectWith = async () => { throw Object.assign(new Error('HTTP 401'), { code: 401 }); };
    desk.mcpSignIn.save(flow, 'flow-mcp', {}, 'expired');
    let started = 0; desk.mcpSignIn.start = async () => { started++; return { url: 'https://flow.example.test/authorize', done: Promise.resolve() }; };
    desk.mcpSignIn.waiting.set(flow, { link: 'https://flow.example.test/authorize', cancel: () => {} });
    const port = app.server.address().port;
    // A request over Tailscale, the way a phone arrives.
    const phone = (route, { method = 'GET', data } = {}) => new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: route, method, headers: { Host: 'desk.tail1234.ts.net', 'x-rex-desk': '1', 'x-rex-peer-key': desk.peers.key(), 'Content-Type': 'application/json' } }, response => { let text = ''; response.on('data', part => { text += part; }); response.on('end', () => resolve({ status: response.statusCode, text })); });
      request.on('error', reject); request.end(data ? JSON.stringify(data) : undefined);
    });
    const tried = await phone('/api/mcp-sign-in/start', { method: 'POST', data: { name: 'flow-mcp' } });
    assert.equal(tried.status, 409); assert.equal(JSON.parse(tried.text).error, 'Finish sign-in on the computer running Rex Desk.'); assert.equal(started, 0);
    let rows, expired;
    for (const route of ['/api/mcp-sign-in', '/api/connectors']) {
      rows = JSON.parse((await phone(route)).text).signIns;
      assert.equal(rows[0].elsewhere, true, route); assert.equal(rows[0].link, '', route);
    }
    expired = JSON.parse((await phone('/api/state')).text).mcpExpired;
    assert.equal(expired[0].elsewhere, true);

    // What the phone draws from that.
    // Needs you borrows pictures from other page files that only run in a browser, so those two are stood in for.
    const stand = { '/chat-rooms.js': 'export const avatarHtml = () => "";', '/chat-devices.js': 'export const phoneAskHtml = () => "", ICON = {};' };
    registerHooks({ resolve: (specifier, context, next) => Object.hasOwn(stand, specifier) ? { url: `data:text/javascript,${encodeURIComponent(stand[specifier])}`, shortCircuit: true }
      : /^\/[\w-]+\.js$/.test(specifier) ? next(new URL(`../public${specifier}`, import.meta.url).href, context) : next(specifier, context) });
    const { connectorsHtml } = await import('../public/chat-connectors.js'), { inboxStage } = await import('../public/chat-inbox.js');
    const esc = text => String(text ?? '');
    const connectors = list => connectorsHtml({ ui: { snap: {} }, esc }, { extra: { connectors: { types: [], connectors: [], connections: [], accounts: [], links: [], catalog: { items: [] }, signIns: list } } }, { sources: [] });
    const away = connectors(rows);
    assert.match(away, /Finish sign-in on the computer running Rex Desk\./); assert.doesNotMatch(away, /data-mcp-start|Open the sign-in page/);
    assert.match(connectors([{ name: 'flow-mcp', state: 'expired' }]), /data-mcp-start/, 'the computer itself keeps its button');
    const needsYou = list => inboxStage({ ui: { snap: { mcpExpired: list }, nySelected: `mcp:${list[0].id}`, nyOpen: true }, esc, pending: () => [] }, {}).feed;
    const there = needsYou(expired);
    assert.match(there, /Finish sign-in on the computer running Rex Desk\./); assert.doesNotMatch(there, /data-mcp-again/);
    assert.match(needsYou(expired.map(({ elsewhere, ...row }) => row)), /data-mcp-again/);
  } finally { await app.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveCommand } from '../src/processes.js';
import { codexDeskConnection, codexMcpServers } from '../src/codex.js';

// Throwaway Codex homes and test data live under D: (never C:). The real Codex binary is used for config
// layering and the shell-tool env test; no model turn is made (those need a ChatGPT sign-in we must not touch).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.TMP || process.env.TEMP || 'D:\\tmp';
const stdioProxy = path.join(root, 'src', 'stdio.js');
const URL_HERE = 'http://127.0.0.1:4317/mcp';

let codex;
try { codex = resolveCommand('codex'); } catch { codex = null; }
const haveCodex = codex && existsSync(codex.args[0] || codex.command);

test('the run token lives only under a per-run unguessable name, never a guessable one a profile could read', () => {
  const token = `tok-${randomUUID()}`;
  const desk = codexDeskConnection({ agentEnv: { REX_DESK_TOKEN: 'inherited-leak', REX_AGENT_TOKEN: 'inherited-leak', PATH: 'x' }, token, mcpUrl: URL_HERE });
  assert.equal(desk.env.REX_DESK_TOKEN, undefined, 'no REX_DESK_TOKEN a bearer_token_env_var could name');
  assert.equal(desk.env.REX_AGENT_TOKEN, undefined, 'no REX_AGENT_TOKEN either');
  assert.match(desk.tokenVar, /^REX_DESK_TOKEN_[0-9A-F]{18}$/, 'per-run random name');
  assert.equal(desk.env[desk.tokenVar], token, 'token sits only under the random name');
  assert.equal(desk.env.REX_DESK_TOKEN_VAR, desk.tokenVar, 'proxy is told which var holds the token');
  assert.equal(desk.env.REX_DESK_URL, URL_HERE);
  assert.equal(desk.env.PATH, 'x', 'the rest of the environment is preserved');
});

test('two runs get different per-run names, so neither the server nor the token var is guessable', () => {
  const a = codexDeskConnection({ token: 't', mcpUrl: URL_HERE });
  const b = codexDeskConnection({ token: 't', mcpUrl: URL_HERE });
  assert.notEqual(a.serverName, b.serverName);
  assert.notEqual(a.tokenVar, b.tokenVar);
  assert.notEqual(a.serverName, 'rex_desk');
  assert.match(a.serverName, /^rex_desk_[0-9a-f]{18}$/);
});

test('the token value is never in the server table (the thread-config payload) - only env var names are', () => {
  const token = `tok-${randomUUID()}`;
  const desk = codexDeskConnection({ token, mcpUrl: URL_HERE });
  const servers = codexMcpServers(desk, {}, desk.env);
  const entry = servers[desk.serverName];
  assert.equal(entry.url, undefined);
  assert.equal(entry.env, undefined, 'no env map carrying raw values');
  assert.deepEqual(entry.env_vars, ['REX_DESK_URL', 'REX_DESK_TOKEN_VAR', desk.tokenVar], 'names only');
  assert.equal(entry.required, true);
  assert.ok(!JSON.stringify(servers).includes(token), 'token value absent from the whole mcp_servers payload');
  assert.ok(!entry.args.some(argument => argument.includes(token)), 'token not on the command line');
});

test('the desk server is added last and extraMcp can never take its name or overwrite it', () => {
  const desk = codexDeskConnection({ token: 't', mcpUrl: URL_HERE });
  const extra = {
    orbit: { url: 'https://orbit.example.com/mcp', headers: { 'X-Key': 'orbit-secret' } },
    [desk.serverName]: { url: 'https://attacker.example.com/mcp' }, // tries to seize the desk name
  };
  const env = { ...desk.env };
  const servers = codexMcpServers(desk, extra, env);
  assert.equal(servers[desk.serverName].command, process.execPath, 'the desk entry is ours, not the collider');
  assert.equal(servers[desk.serverName].url, undefined);
  assert.ok(servers.orbit, 'genuine extra servers survive');
  assert.equal(servers.orbit.url, 'https://orbit.example.com/mcp');
});

test('shell/exec tools never inherit the run token (real Codex binary)', { skip: haveCodex ? false : 'codex binary not found' }, () => {
  const token = `shell-secret-${randomUUID()}`;
  const desk = codexDeskConnection({ token, mcpUrl: URL_HERE });
  const dir = mkdtempSync(path.join(base, 'codex-home-'));
  try {
    const result = spawnSync(codex.command, [...codex.args,
      '-c', `shell_environment_policy.exclude=${JSON.stringify(desk.shellEnvironmentPolicy.exclude)}`,
      'sandbox', '--', process.execPath, '-e', `process.stdout.write('tok='+(process.env[${JSON.stringify(desk.tokenVar)}]||'<absent>')+' plain='+(process.env.REX_DESK_TOKEN||'<absent>'))`],
      { env: { ...process.env, CODEX_HOME: dir, [desk.tokenVar]: token, REX_DESK_TOKEN: token }, encoding: 'utf8', timeout: 60000, windowsHide: true });
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    assert.match(out, /tok=<absent>/, `the per-run token var is stripped from shell tools:\n${out}`);
    assert.match(out, /plain=<absent>/, 'REX_DESK_TOKEN is stripped from shell tools too');
    assert.ok(!out.includes(token), 'the token value never appears in a shell tool environment');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const FORMS = {
  'a clean home (no config.toml)': undefined,
  'after the setup command (a stdio rex_desk)': `[mcp_servers.rex_desk]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(stdioProxy)}]\n`,
  'a url rex_desk (standard table form)': `[mcp_servers.rex_desk]\nurl = "https://elsewhere.example.com/mcp"\nbearer_token_env_var = "REX_DESK_TOKEN"\n`,
  'a url rex_desk (inline table under [mcp_servers])': `[mcp_servers]\nrex_desk = { url = "https://other.example.com/mcp" }\n`,
  'a profile that itself already has a rex_desk_host entry': `[mcp_servers.rex_desk_host]\nurl = "https://seized.example.com/mcp"\n`,
};
const toToml = value => Array.isArray(value) ? `[${value.map(toToml).join(', ')}]` : typeof value === 'string' ? `'${value}'` : String(value);

for (const [label, toml] of Object.entries(FORMS)) {
  test(`config layering with the real Codex binary: ${label}`, { skip: haveCodex ? false : 'codex binary not found' }, () => {
    const desk = codexDeskConnection({ token: 't', mcpUrl: URL_HERE });
    const inline = `{ ${Object.entries(desk.server).map(([key, value]) => `${key} = ${toToml(value)}`).join(', ')} }`;
    const dir = mkdtempSync(path.join(base, 'codex-home-'));
    if (toml !== undefined) writeFileSync(path.join(dir, 'config.toml'), toml);
    try {
      const result = spawnSync(codex.command, [...codex.args, '-c', `mcp_servers.${desk.serverName}=${inline}`, 'mcp', 'list'],
        { env: { ...process.env, CODEX_HOME: dir }, encoding: 'utf8', timeout: 60000, windowsHide: true });
      const out = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status, 0, `codex loaded the merged config without refusing it:\n${out}`);
      assert.doesNotMatch(out, /url is not supported for stdio|invalid transport|failed to load/i, out);
      assert.match(out, new RegExp(`${desk.serverName}[\\s\\S]*stdio\\.js[\\s\\S]*enabled`), 'the run gets its own required stdio connection, enabled');
      if (/seized|elsewhere|other/.test(String(toml))) assert.match(out, /seized|elsewhere|other/, 'the profile entry is left exactly as it was');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('the stdio proxy reaches a desk tool using the token from the per-run var (required round-trip, no REX_DESK_TOKEN)', async () => {
  const TOKEN = `test-token-${randomUUID()}`;
  const sessions = new Map();
  const makeServer = () => {
    const server = new Server({ name: 'fake-desk', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'desk_ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, request => ({ content: [{ type: 'text', text: request.params.name === 'desk_ping' ? 'pong' : 'unknown' }] }));
    return server;
  };
  const httpServer = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      try {
        if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401); response.end('unauthorized'); return; }
        const parsed = raw ? JSON.parse(raw) : undefined;
        const sid = request.headers['mcp-session-id'];
        if (sid && sessions.has(sid)) { await sessions.get(sid).handleRequest(request, response, parsed); return; }
        if (request.method === 'POST' && isInitializeRequest(parsed)) {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => sessions.set(id, transport) });
          transport.onclose = () => { for (const [key, value] of sessions) if (value === transport) sessions.delete(key); };
          await makeServer().connect(transport);
          await transport.handleRequest(request, response, parsed); return;
        }
        response.writeHead(400); response.end('initialize first');
      } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
    });
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
  const desk = codexDeskConnection({ token: TOKEN, mcpUrl: url });
  assert.equal(desk.server.required, true);
  // Mimic Codex forwarding exactly the env_vars it names from its own environment (no plain REX_DESK_TOKEN).
  const childEnv = { ...process.env };
  delete childEnv.REX_DESK_TOKEN;
  for (const name of desk.server.env_vars) childEnv[name] = desk.env[name];
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: desk.server.command, args: desk.server.args, env: childEnv });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'desk_ping'), 'the proxy lists the desk tool');
    const result = await client.callTool({ name: 'desk_ping', arguments: {} });
    assert.equal(result.content[0].text, 'pong', 'the forwarded per-run token authenticates through stdio.js');
  } finally {
    await client.close().catch(() => {});
    await new Promise(resolve => httpServer.close(resolve));
  }
});

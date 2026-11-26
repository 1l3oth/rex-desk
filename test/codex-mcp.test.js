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
import { codexDeskServer, CODEX_DESK_SERVER } from '../src/codex.js';

// Throwaway Codex homes and test data live under D: (never C:). The real Codex binary is used for the
// config-layering tests; no model turn is made (those need a ChatGPT sign-in we must not touch).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.TMP || process.env.TEMP || 'D:\\tmp';
const stdioProxy = path.join(root, 'src', 'stdio.js');
const URL_HERE = 'http://127.0.0.1:4317/mcp';

let codex;
try { codex = resolveCommand('codex'); } catch { codex = null; }
const haveCodex = codex && existsSync(codex.args[0] || codex.command);

// The exact entry our code sends, serialised to a TOML inline table for `codex -c`, which layers onto
// config.toml the same way the thread/start config override does (same deep-merge, same clash errors).
const toToml = value => Array.isArray(value) ? `[${value.map(toToml).join(', ')}]` : typeof value === 'string' ? `'${value}'` : String(value);
function sessionOverride() {
  const entry = codexDeskServer({ mcpUrl: URL_HERE });
  const inline = `{ ${Object.entries(entry).map(([key, value]) => `${key} = ${toToml(value)}`).join(', ')} }`;
  return `mcp_servers.${CODEX_DESK_SERVER}=${inline}`;
}
// Run `codex mcp list` with a throwaway home holding `configToml`, plus our session override. Returns the
// merged view Codex builds (or the error it refuses to start with).
function mergedConfig(configToml) {
  const dir = mkdtempSync(path.join(base, 'codex-home-'));
  if (configToml !== undefined) writeFileSync(path.join(dir, 'config.toml'), configToml);
  try {
    const result = spawnSync(codex.command, [...codex.args, '-c', sessionOverride(), 'mcp', 'list'],
      { env: { ...process.env, CODEX_HOME: dir }, encoding: 'utf8', timeout: 60000, windowsHide: true });
    return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the run connects under a reserved name of its own, never rex_desk, so it can never merge with the profile', () => {
  assert.notEqual(CODEX_DESK_SERVER, 'rex_desk');
  const entry = codexDeskServer({ mcpUrl: URL_HERE });
  assert.equal(entry.command, process.execPath);
  assert.equal(entry.args.at(-1), stdioProxy);
  assert.equal(entry.required, true);
  assert.equal(entry.url, undefined, 'no url field, so it never becomes a command+url table');
  assert.equal(codexDeskServer({ mcpUrl: '' }), null, 'no desk url means no entry');
});

test('the sign-in is forwarded by env var name, never a value in the thread configuration', () => {
  process.env.REX_DESK_TOKEN = `secret-${randomUUID()}`;
  const token = process.env.REX_DESK_TOKEN;
  try {
    const entry = codexDeskServer({ mcpUrl: URL_HERE });
    assert.deepEqual(entry.env_vars, ['REX_DESK_URL', 'REX_DESK_TOKEN'], 'only names, Codex reads values from its own env');
    assert.equal(entry.env, undefined, 'no env map carrying raw values');
    assert.equal(entry.bearer_token_env_var, undefined);
    // The whole servers map that goes into the thread/start config payload must not contain the token value.
    const payload = JSON.stringify({ [CODEX_DESK_SERVER]: entry });
    assert.ok(!payload.includes(token), 'token value is absent from the RPC payload');
    assert.ok(!entry.args.some(argument => argument.includes(token)), 'token is not on the command line');
  } finally { delete process.env.REX_DESK_TOKEN; }
});

const FORMS = {
  'a clean home (no config.toml)': undefined,
  'after the setup command (a stdio rex_desk)': `[mcp_servers.rex_desk]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(stdioProxy)}]\n`,
  'a url rex_desk (standard table form)': `[mcp_servers.rex_desk]\nurl = "https://elsewhere.example.com/mcp"\nbearer_token_env_var = "SOMEONE_TOKEN"\n`,
  'a url rex_desk (inline table under [mcp_servers])': `[mcp_servers]\nrex_desk = { url = "https://other.example.com/mcp" }\n`,
  'a url rex_desk (dotted key form, pointing elsewhere)': `mcp_servers.rex_desk.url = "https://third.example.com/mcp"\n`,
};

for (const [label, toml] of Object.entries(FORMS)) {
  test(`config layering with the real Codex binary: ${label}`, { skip: haveCodex ? false : 'codex binary not found' }, () => {
    const { code, out } = mergedConfig(toml);
    assert.equal(code, 0, `codex loaded the merged config without refusing it:\n${out}`);
    assert.doesNotMatch(out, /url is not supported for stdio|invalid transport|failed to load/i, out);
    assert.match(out, new RegExp(`${CODEX_DESK_SERVER}[\\s\\S]*stdio\\.js[\\s\\S]*enabled`), 'the run gets its required stdio connection to this desk, enabled');
    if (/elsewhere|other|third/.test(String(toml))) assert.match(out, /elsewhere|other|third/, 'the profile entry is left exactly as it was');
  });
}

test('the stdio command the entry names really reaches a Rex Desk tool (required: true round-trip through stdio.js)', async () => {
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
  const entry = codexDeskServer({ mcpUrl: url });
  assert.equal(entry.required, true);
  // Codex forwards the env_vars it names from its own environment to the server: mimic that here.
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...process.env, REX_DESK_URL: url, REX_DESK_TOKEN: TOKEN } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'desk_ping'), 'the proxy lists the desk tool');
    const result = await client.callTool({ name: 'desk_ping', arguments: {} });
    assert.equal(result.content[0].text, 'pong', 'the tool call round-trips through stdio.js and the forwarded token authenticates');
  } finally {
    await client.close().catch(() => {});
    await new Promise(resolve => httpServer.close(resolve));
  }
});

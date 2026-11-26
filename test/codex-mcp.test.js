import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { codexDeskServer, codexRexDeskIsUrl } from '../src/codex.js';

// Throwaway Codex homes and test data live under D: (never C:).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.TMP || process.env.TEMP || 'D:\\tmp';
const stdioProxy = path.join(root, 'src', 'stdio.js');
const home = toml => { const dir = mkdtempSync(path.join(base, 'codex-home-')); if (toml !== undefined) writeFileSync(path.join(dir, 'config.toml'), toml); return dir; };

test('a clean Codex home: Rex Desk is offered as a stdio command entry, never a url', () => {
  const dir = home();
  try {
    const entry = codexDeskServer({ home: dir, mcpUrl: 'http://127.0.0.1:4317/mcp', token: 'T' });
    assert.ok(entry, 'an entry is returned');
    assert.equal(entry.url, undefined, 'no url field: a url merged onto the setup stdio entry is what Codex rejects');
    assert.equal(entry.command, process.execPath);
    assert.equal(entry.args.at(-1), stdioProxy);
    assert.equal(entry.env.REX_DESK_URL, 'http://127.0.0.1:4317/mcp');
    assert.equal(entry.env.REX_DESK_TOKEN, 'T');
    assert.equal(entry.required, true);
    assert.equal(codexRexDeskIsUrl(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('after the setup command (a stdio rex_desk in config.toml) the session entry is still a stdio command, so the two never clash', () => {
  const dir = home(`[mcp_servers.rex_desk]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(stdioProxy)}]\n`);
  try {
    assert.equal(codexRexDeskIsUrl(dir), false, 'the setup entry is a command, not a url');
    const entry = codexDeskServer({ home: dir, mcpUrl: 'http://x/mcp', token: 'T' });
    assert.ok(entry && entry.command && entry.url === undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a profile with its own url-type rex_desk is left alone: no command entry is added, so Codex never merges command+url', () => {
  const dir = home(`[mcp_servers.rex_desk]\nurl = "https://example.com/mcp"\nbearer_token_env_var = "REX_DESK_TOKEN"\n\n[mcp_servers.other]\ncommand = "node"\n`);
  try {
    assert.equal(codexRexDeskIsUrl(dir), true);
    assert.equal(codexDeskServer({ home: dir, mcpUrl: 'http://x/mcp', token: 'T' }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no desk url means no entry at all', () => {
  const dir = home();
  try { assert.equal(codexDeskServer({ home: dir, mcpUrl: '', token: 'T' }), null); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the stdio command the entry names really reaches a Rex Desk tool (required: true round-trip through stdio.js)', async () => {
  const dir = home();
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
  const entry = codexDeskServer({ home: dir, mcpUrl: url, token: TOKEN });
  assert.equal(entry.required, true);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...process.env, ...entry.env } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'desk_ping'), 'the proxy lists the desk tool');
    const result = await client.callTool({ name: 'desk_ping', arguments: {} });
    assert.equal(result.content[0].text, 'pong', 'the tool call round-trips through stdio.js and the bearer token authenticates');
  } finally {
    await client.close().catch(() => {});
    await new Promise(resolve => httpServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

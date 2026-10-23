import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stdio proxy keeps a single authoritative dashboard database and coordinator process.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = new URL(process.env.REX_DESK_URL || 'http://127.0.0.1:4317/mcp');
function localToken() {
  const directory = process.env.REX_DATA_DIR || path.join(root, '.local');
  const file = path.join(directory, 'desk.sqlite');
  if (!existsSync(file)) throw new Error('Start Rex Desk first with npm start.');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get('secret', 'mcp-token');
    if (!row) throw new Error('Rex Desk connection token is missing. Open the dashboard first.');
    const [nonce, tag, encrypted] = JSON.parse(row.value).split('.').map(value => Buffer.from(value, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', readFileSync(path.join(directory, 'vault.key')), nonce);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
  } finally { db.close(); }
}
const token = process.env.REX_DESK_TOKEN || localToken();
const server = new Server({ name: 'rex-desk', version: '0.1.0' }, { capabilities: { tools: {} } });
const client = new Client({ name: 'rex-desk-stdio-proxy', version: '0.1.0' }, { capabilities: { elicitation: { form: {}, url: {} } } });
let activeRequestId;
let queue = Promise.resolve();
client.setRequestHandler(ElicitRequestSchema, request => {
  if (!server.getClientCapabilities()?.elicitation) throw new Error('This client does not support native elicitation. Use desk_ask.');
  return server.elicitInput(request.params, { relatedRequestId: activeRequestId, timeout: 86400000 });
});
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
  const result = queue.then(async () => {
    activeRequestId = extra.requestId;
    try { return await client.callTool(request.params, undefined, { timeout: 86400000 }); }
    finally { activeRequestId = undefined; }
  });
  queue = result.catch(() => {}); return result;
});
await server.connect(new StdioServerTransport());

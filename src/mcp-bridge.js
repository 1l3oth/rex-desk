// Signed-in MCP servers for agents that open servers themselves (L30). The provider's token never leaves Rex Desk: an agent
// gets an address on this computer and its own Rex Desk run token, and Rex Desk makes the signed request for it. So no
// agent process, environment or launch file holds a provider token, and a renewed token needs no new turn.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { SIGN_IN_HELP } from './mcp-signin.js';

export const BRIDGE_PATH = '/mcp-signed/';
// What an agent is given instead of the server itself.
export const bridged = (mcpUrl, token, names) => Object.fromEntries(names.map(name => [name, { type: 'http', url: new URL(`${BRIDGE_PATH}${encodeURIComponent(name)}`, mcpUrl).href, headers: { Authorization: `Bearer ${token}` } }]));

const CALL_MS = 5 * 60000;
const FORWARD = [
  ['tools', ListToolsRequestSchema, (client, params, options) => client.listTools(params, options)],
  ['tools', CallToolRequestSchema, (client, params, options) => client.callTool(params, undefined, options)],
  ['resources', ListResourcesRequestSchema, (client, params, options) => client.listResources(params, options)],
  ['resources', ListResourceTemplatesRequestSchema, (client, params, options) => client.listResourceTemplates(params, options)],
  ['resources', ReadResourceRequestSchema, (client, params, options) => client.readResource(params, options)],
  ['prompts', ListPromptsRequestSchema, (client, params, options) => client.listPrompts(params, options)],
  ['prompts', GetPromptRequestSchema, (client, params, options) => client.getPrompt(params, options)],
];

// One request, answered on its own (no session to lose when Rex Desk restarts under an agent that keeps working).
// use(work) runs work with the signed-in connection to the real server.
export async function handleBridge(use, name, request, response, body) {
  if (request.method !== 'POST') { response.writeHead(405, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Use POST.' })); return; }
  // The words an agent gets when it fails: ours, never what the server sent back with the failed request.
  const failed = error => new McpError(ErrorCode.InternalError, String(error?.message || '').includes(SIGN_IN_HELP) ? `${name}: ${SIGN_IN_HELP}` : `${name}: the server did not answer this request.`);
  const reach = work => use(work).catch(error => { throw failed(error); });
  let offers = { tools: {}, resources: {}, prompts: {} };
  if (body?.method === 'initialize') {
    // Only what the real server offers; one that cannot be reached still joins with tools, and says why when they are used.
    const real = await reach(async client => client.getServerCapabilities?.()).catch(() => null);
    offers = real ? Object.fromEntries(Object.keys(offers).filter(key => real[key]).map(key => [key, {}])) : { tools: {} };
  }
  const server = new Server({ name: 'rex-desk-signed', version: '1.0.0' }, { capabilities: offers });
  for (const [kind, schema, send] of FORWARD) if (offers[kind]) server.setRequestHandler(schema, (asked, extra) => reach(client => send(client, asked.params, { timeout: CALL_MS, signal: extra.signal })));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => { void server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}

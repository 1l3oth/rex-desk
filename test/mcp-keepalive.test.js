import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcp } from '../src/mcp.js';

test('a tool that waits for the person keeps its call alive, so the file card is not closed after 5 silent minutes', async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const desk = { keepAliveMs: 20, editFile: async () => { await wait(150); return { saved: true }; }, signInTerminal: async () => { await wait(150); return { done: true }; } };
  const server = createMcp(desk, { runId: 'run-1' }), client = new Client({ name: 'test', version: '1' });
  const [here, there] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(there), client.connect(here)]);
  try {
    for (const [name, args] of [['desk_edit_file', { path: 'C:/x/.env', why: 'Add the key' }], ['desk_sign_in', { command: 'gh auth login', why: 'Sign in to GitHub' }]]) {
      let heard = 0;
      const answer = await client.callTool({ name, arguments: args }, undefined, { onprogress: () => { heard++; } });
      assert.notEqual(answer.isError, true, name);
      assert.ok(heard >= 2, `${name} sent ${heard} keep-alives while it waited`);
    }
  } finally { await client.close(); }
});

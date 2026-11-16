import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcp } from '../src/mcp.js';
import { Desk } from '../src/coordinator.js';

test('any agent can add a project folder, so a project agent never has to send the person to Settings', async () => {
  const added = [];
  const desk = { authorize: (...args) => Desk.prototype.authorize.apply({}, args), addProject: async folder => { added.push(folder); return { added: true }; } };
  for (const role of ['specialist', 'coordinator', 'worker']) {
    const server = createMcp(desk, { role, runId: 'run-1' }), client = new Client({ name: 'test', version: '1' });
    const [here, there] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(there), client.connect(here)]);
    const answer = await client.callTool({ name: 'desk_add_project', arguments: { path: 'F:\flow-library' } });
    assert.notEqual(answer.isError, true, `${role} may add a project`);
    await client.close();
  }
  assert.equal(added.length, 3);
});

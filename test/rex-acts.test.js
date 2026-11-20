import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { now } from '../src/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const waitFor = async (check, what) => { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out waiting for ${what}`); };
const result = async (client, name, args) => { const answer = await client.callTool({ name, arguments: args }); if (answer.isError) throw new Error(answer.content[0].text); return JSON.parse(answer.content[0].text); };

test('Rex Agent makes a group chat, talks in it and in an agent\'s personal chat as the person, when asked by name', async () => {
  const prompts = [];
  const app = await createApp({ dataDirectory: temporary('acts'), port: 0, runnerFactory: options => ({ async start(prompt) { prompts.push({ run: options.run, prompt }); }, async interrupt() {} }) });
  const client = new Client({ name: 'acts', version: '1' });
  try {
    const project = temporary('acts-project');
    const reel = app.desk.specialists.create({ name: 'ReelHome', projectPath: project, purpose: 'Captions', by: 'you' });
    const web = app.desk.specialists.create({ name: 'Web', projectPath: project, purpose: 'Web pages', by: 'you' });
    app.store.put('run', 'rex', { id: 'rex', role: 'coordinator', main: true, state: 'finished', createdAt: now() });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${app.desk.scopeToken('rex')}` } } }));

    const made = await result(client, 'desk_room_create', { name: 'Launch', agents: ['ReelHome', 'Web'], message: 'Plan the launch video together.' });
    assert.deepEqual(made.members.sort(), ['ReelHome', 'Web', 'You'].filter(name => made.members.includes(name)).sort());
    const room = app.desk.rooms.room(made.roomId);
    assert.ok(room.members.includes(reel.id) && room.members.includes(web.id));
    const first = app.store.list('roommsg').find(message => message.roomId === made.roomId && /Plan the launch/.test(message.text));
    assert.equal(first.from.type, 'human', 'posted as the person');

    const said = await result(client, 'desk_room_say', { room: 'launch', text: 'ReelHome, start with the stills.', to: ['ReelHome'] });
    assert.equal(said.posted, true);
    const second = app.store.list('roommsg').find(message => message.roomId === made.roomId && /start with the stills/.test(message.text));
    assert.equal(second.from.type, 'human');

    await result(client, 'desk_agent_say', { agent: 'Web', text: 'Check the landing page on a phone.' });
    await waitFor(() => prompts.some(item => item.run?.specialistId === web.id && /landing page on a phone/.test(item.prompt)), "the Web agent's personal chat");

    const rooms = await result(client, 'desk_rooms_all', {});
    assert.ok(rooms.some(item => item.name === 'Launch'));
    // The agents woken in the room and in the personal chat answer in the background: let them finish before closing.
    const quiet = () => app.desk.live.size === 0 && !app.store.list('run').some(run => ['queued', 'starting', 'running', 'verifying'].includes(run.state));
    // At most 10 seconds, so a test can never hang the whole run.
    for (let calm = 0, tries = 0; calm < 10 && tries < 100; tries++) { await new Promise(resolve => setTimeout(resolve, 100)); calm = quiet() ? calm + 1 : 0; }
  } finally { await client.close().catch(() => {}); await app.close(); }
});

test('a less-common Rex Desk tool is not loaded up front, but is found with desk_find and run with desk_run', async () => {
  const app = await createApp({ dataDirectory: temporary('acts-defer'), port: 0, runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  const client = new Client({ name: 'acts-defer', version: '1' });
  try {
    app.store.put('run', 'rex', { id: 'rex', role: 'coordinator', main: true, state: 'finished', createdAt: now() });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${app.desk.scopeToken('rex')}` } } }));
    // Deferred tools are not in the directly loaded list.
    const loaded = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(!loaded.includes('desk_monitor'), 'desk_monitor is not loaded up front');
    assert.ok(loaded.includes('desk_find') && loaded.includes('desk_run'), 'the search and run tools are loaded');
    // desk_find offers the deferred tool by name, with its input shape.
    const found = await result(client, 'desk_find', { query: 'what is using my computer memory right now' });
    const hit = found.found.find(item => item.use === 'desk_monitor');
    assert.ok(hit && hit.kind === 'rex', 'desk_find offers desk_monitor');
    // desk_run calls it on the agent's behalf and returns its answer.
    const ran = await result(client, 'desk_run', { use: 'desk_monitor', input: {} });
    assert.ok(typeof ran.text === 'string', 'desk_run returns the deferred tool\'s result');
  } finally { await client.close().catch(() => {}); await app.close(); }
});

test('only Rex Agent may act as the person', async () => {
  const app = await createApp({ dataDirectory: temporary('acts-scope'), port: 0, runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  const client = new Client({ name: 'acts-scope', version: '1' });
  try {
    const agent = app.desk.specialists.create({ name: 'Helper', projectPath: temporary('acts-scope-project'), purpose: 'Help', by: 'you' });
    app.store.put('run', 'helper-run', { id: 'helper-run', role: 'specialist', specialistId: agent.id, state: 'running', createdAt: now() });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${app.desk.scopeToken('helper-run')}` } } }));
    const answer = await client.callTool({ name: 'desk_room_create', arguments: { name: 'Sneaky', agents: [] } });
    assert.equal(answer.isError, true);
    assert.match(answer.content[0].text, /Only the main agent/);
  } finally { await client.close().catch(() => {}); await app.close(); }
});

test('Rex Agent always has desk_update_agent: it renames an agent, and keeps its project on its computer (L29)', async () => {
  const app = await createApp({ dataDirectory: temporary('acts-update'), port: 0, runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  const client = new Client({ name: 'acts-update', version: '1' });
  try {
    const made = app.desk.specialists.create({ name: 'FlowWas_bot', projectPath: temporary('acts-update-project'), purpose: 'Flow WAS', by: 'you' });
    const agent = app.store.put('specialist', made.id, { ...made, projectSlug: 'flow-was', general: false });
    app.store.put('run', 'rex', { id: 'rex', role: 'coordinator', main: true, state: 'finished', createdAt: now() });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${app.desk.scopeToken('rex')}` } } }));
    const loaded = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(loaded.includes('desk_update_agent'), 'loaded up front, so calling it directly works');
    const renamed = await result(client, 'desk_update_agent', { agent: 'FlowWas_bot', name: 'Morningmate_bot' });
    assert.equal(renamed.agent, 'Morningmate_bot'); assert.equal(renamed.was, 'FlowWas_bot');
    assert.equal(app.desk.specialists.get(agent.id).name, 'Morningmate_bot');
    const pinned = await result(client, 'desk_update_agent', { agent: 'Morningmate_bot', onlyOnItsComputer: true, moveHere: true });
    assert.equal(pinned.onlyOnItsComputer, true); assert.equal(pinned.computer, 'this computer');
    assert.equal(app.desk.specialists.get(agent.id).pinned, true);
    assert.equal((await result(client, 'desk_update_agent', { agent: 'Morningmate_bot', onlyOnItsComputer: false })).onlyOnItsComputer, false);
  } finally { await client.close().catch(() => {}); await app.close(); }
});

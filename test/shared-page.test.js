import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { evidenceId } from '../src/peers.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('a page an agent shared on another computer opens here from the shared copy of the chat', () => {
  const store = new Store(temporary('shared-page')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const runId = randomUUID(), name = '1794542525961-eli5-sync.html', html = '<!doctype html><title>Plan</title><p>Hello</p>';
  store.put('chatfile', evidenceId(runId, name), { id: evidenceId(runId, name), path: `evidence:${runId}/${name}`, name, size: html.length, data: Buffer.from(html).toString('base64'), at: new Date().toISOString() });
  const file = path.join(store.directory, 'artifacts', runId, name);
  assert.equal(existsSync(file), false);
  const opened = desk.files.open(file, runId);
  assert.equal(opened.kind, 'html');
  assert.match(opened.text, /Hello/);
  desk.closed = true;
});

test('a message to a chat with an agent that lives on another computer goes there while it is on, and runs here only when it is off', async () => {
  const { createApp } = await import('../src/server.js');
  const app = await createApp({ dataDirectory: temporary('home-agent'), port: 0 });
  try {
    const { store, desk } = app, runId = randomUUID();
    store.put('specialist', 'far', { id: 'far', kind: 'specialist', name: 'Far_bot', slug: 'far', node: 'other-computer', provider: 'claude' });
    store.put('run', runId, { id: runId, specialistId: 'far', state: 'finished', provider: 'claude', createdAt: new Date().toISOString() });
    const sent = []; let online = true;
    desk.peers.online = () => online; desk.peers.chatAction = async (copy, action, input) => { sent.push({ copy, action, text: input.text }); return { queued: true }; };
    const post = text => fetch(`${app.address}/api/runs/${runId}/say`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify({ text }) });
    assert.equal((await post('hello')).status, 200);
    assert.deepEqual(sent.map(item => [item.copy.node, item.action, item.text]), [['other-computer', 'say', 'hello']]);
    online = false; desk.say = async () => ({ ranHere: true });
    assert.deepEqual(await (await post('again')).json(), { ranHere: true });
    assert.equal(sent.length, 1);
  } finally { await app.close(); }
});

test('"Continue in Claude app" reaches the server: the chat opens in the Claude app and closes there again', async () => {
  const { createApp } = await import('../src/server.js');
  const app = await createApp({ dataDirectory: temporary('app-route'), port: 0 });
  try {
    const { store, desk } = app, runId = randomUUID(), calls = [];
    store.put('run', runId, { id: runId, state: 'finished', provider: 'claude', createdAt: new Date().toISOString() });
    desk.continueInApp = async (id, on) => { calls.push([id, on]); return { ok: true }; };
    const post = on => fetch(`${app.address}/api/runs/${runId}/app`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify({ on }) });
    const opened = await post(true);
    assert.equal(opened.status, 200, 'the button used to get "API route not found"');
    await post(false);
    assert.deepEqual(calls, [[runId, true], [runId, false]]);
  } finally { await app.close(); }
});

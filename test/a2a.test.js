import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { agentCard, handleA2aRpc, handleA2aHttp, setA2a, a2aSettings } from '../src/a2a.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup() {
  const store = new Store(temporary('a2a')), prompts = [];
  const desk = new Desk(store, { root: temporary('a2a-root'), memoryDirectory: temporary('a2a-memory'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt); options.event('session', { sessionId: '7c3a8d71-d78d-409a-9a84-91fb162c1be3' });
    options.event('agent-text', { text: 'The cart total is fixed in totals.js.' });
  }, async interrupt() {} }) });
  return { store, desk, prompts };
}
const fakeResponse = () => { const out = {}; return { out, writeHead(status) { out.status = status; }, end(text) { out.body = JSON.parse(text); } }; };

test('another agent sends a task over A2A: it reaches the agent marked as from an outside agent, and the answer comes back', async () => {
  const { store, desk, prompts } = setup();
  try {
    const card = agentCard(desk, 'http://127.0.0.1:4317');
    assert.equal(card.url, 'http://127.0.0.1:4317/a2a'); assert.ok(card.skills.some(skill => skill.id === 'main'));
    const reply = await handleA2aRpc(desk, { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'Is the cart total fixed?' }] }, metadata: { from: 'Shop bot' } } }, { waitMs: 10000, pollMs: 50 });
    assert.equal(reply.result.status.state, 'completed', JSON.stringify(reply));
    assert.match(reply.result.artifacts[0].parts[0].text, /totals\.js/);
    assert.match(prompts.at(-1), /A message from Shop bot, an outside agent that reached you over A2A[\s\S]*Is the cart total fixed\?/);
    const again = await handleA2aRpc(desk, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: reply.result.id } });
    assert.equal(again.result.status.state, 'completed');
    assert.equal((await handleA2aRpc(desk, { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: 'nope' } })).error.code, -32001);
    assert.equal((await handleA2aRpc(desk, { jsonrpc: '2.0', id: 4, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'hi' }] }, metadata: { skillId: 'nobody' } } })).error.code, -32602);
    assert.equal((await handleA2aRpc(desk, { jsonrpc: '2.0', id: 5, method: 'message/stream', params: {} })).error.code, -32601);
  } finally { await desk.shutdown?.(); store.close(); }
});

test('A2A is off until the person turns it on, and every call needs the key', async () => {
  const { store, desk } = setup();
  try {
    const url = new URL('http://127.0.0.1:4317/a2a'), card = new URL('http://127.0.0.1:4317/.well-known/agent-card.json');
    let response = fakeResponse();
    assert.equal(await handleA2aHttp(desk, { method: 'GET', headers: {} }, response, card, async () => ({})), true); assert.equal(response.out.status, 404);
    const settings = setA2a(store, { enabled: true });
    assert.ok(settings.token.length >= 30, 'a long random key is made when it is turned on');
    response = fakeResponse(); await handleA2aHttp(desk, { method: 'GET', headers: {} }, response, card, async () => ({})); assert.equal(response.out.status, 200); assert.equal(response.out.body.name, 'Rex Desk');
    response = fakeResponse(); await handleA2aHttp(desk, { method: 'POST', headers: { authorization: 'Bearer wrong' } }, response, url, async () => ({})); assert.equal(response.out.status, 401);
    response = fakeResponse(); await handleA2aHttp(desk, { method: 'POST', headers: { authorization: `Bearer ${settings.token}` } }, response, url, async () => ({ jsonrpc: '2.0', id: 9, method: 'tasks/get', params: { id: 'x' } }));
    assert.equal(response.out.status, 200); assert.equal(response.out.body.error.code, -32001);
    const renewed = setA2a(store, { newKey: true }); assert.notEqual(renewed.token, settings.token, 'a new key replaces the old one');
    setA2a(store, { enabled: false }); assert.equal(a2aSettings(store).enabled, false);
    assert.equal(await handleA2aHttp(desk, { method: 'GET', headers: {} }, fakeResponse(), new URL('http://127.0.0.1:4317/api/tasks'), async () => ({})), false, 'other addresses are not touched');
  } finally { await desk.shutdown?.(); store.close(); }
});

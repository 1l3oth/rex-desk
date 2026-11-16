import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { ClaudeRunner } from '../src/runners.js';

const run = async messages => {
  const events = [], read = [];
  const sdk = { query: () => (async function* () { for (const message of messages) { read.push(message); yield message; } })() };
  const runner = new ClaudeRunner({ sdk, run: {}, cwd: os.tmpdir(), token: 't', mcpUrl: 'http://127.0.0.1:1/mcp', event: (kind, data) => events.push({ kind, ...data }) });
  await runner.start('Video? video where?');
  return { events, read };
};
const init = { type: 'system', subtype: 'init', session_id: '11111111-2222-3333-4444-555555555555' };
const note = { type: 'result', subtype: 'success', result: '', usage: {}, num_turns: 0, duration_ms: 372 };
const reply = { type: 'assistant', message: { content: [{ type: 'text', text: 'It is in Videos.' }] } };
const done = { type: 'result', subtype: 'success', result: 'It is in Videos.', usage: { input_tokens: 5, output_tokens: 6 }, num_turns: 1 };

test('a note that a background task stopped is not the reply: the message behind it is still answered', async () => {
  const { events } = await run([init, note, reply, done]);
  assert.deepEqual(events.filter(event => event.kind === 'agent-text').map(event => event.text), ['It is in Videos.']);
  const results = events.filter(event => event.kind === 'agent-result');
  assert.equal(results.length, 1, 'the chat shows one end of turn, not one for the note');
  assert.equal(results[0].result, 'It is in Videos.');
});

test('a turn with nothing after the empty result still ends and shows it (a hook refused the message)', async () => {
  const { events } = await run([init, note]);
  const results = events.filter(event => event.kind === 'agent-result');
  assert.equal(results.length, 1); assert.equal(results[0].steps, 0);
});

test('the reply ends the turn: nothing after it is read', async () => {
  const { read } = await run([init, reply, done, reply]);
  assert.equal(read.length, 3);
});

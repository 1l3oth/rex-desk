import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRunner } from '../src/runners.js';

test("Claude Code's words reach Rex Desk while it writes, not only when the reply is done", async () => {
  const delta = text => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  const messages = [{ type: 'system', subtype: 'init', session_id: '7c3a8d71-d78d-409a-9a84-91fb162c1be3' },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } },
    delta('Hello! '), delta('I checked the build.'),
    { type: 'stream_event', parent_tool_use_id: 'toolu_sub', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a sub-agent' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello! I checked the build.' }] } },
    { type: 'result', subtype: 'success', result: 'ok', is_error: false }];
  const seen = [], events = [];
  const sdk = { query: ({ options }) => { seen.push(options); return (async function* () { for (const message of messages) { yield message; await new Promise(resolve => setTimeout(resolve, 130)); } })(); } };
  await new ClaudeRunner({ sdk, run: { id: 'r', role: 'worker' }, cwd: 'x', token: 't', mcpUrl: 'http://127.0.0.1:1/mcp', event: (kind, data) => events.push([kind, data]), ask: async () => ({ action: 'accept' }), controller: new AbortController() }).start('Go');
  assert.equal(seen[0].includePartialMessages, true);
  const partial = events.filter(([kind]) => kind === 'agent-text-partial').map(([, data]) => data.text);
  assert.deepEqual(partial, ['Hello! ', 'Hello! I checked the build.'], 'the text so far, as it grows; a sub-agent\'s words are not the reply');
  assert.ok(events.findIndex(([kind]) => kind === 'agent-text-partial') < events.findIndex(([kind]) => kind === 'agent-text'), 'before the finished text');
});

test('Voice mode speaks each finished phrase while the agent is still writing, in order, and not the reply again', async () => {
  const fetched = [], played = [];
  globalThis.localStorage = { store: { 'rex-read-aloud': JSON.stringify(['main:']) }, getItem(key) { return this.store[key] ?? null; }, setItem(key, value) { this.store[key] = value; }, removeItem(key) { delete this.store[key]; } };
  globalThis.fetch = async (url, { body }) => { const { text } = JSON.parse(body); fetched.push(text); return { ok: true, blob: async () => new Blob([text]) }; };
  globalThis.Audio = class { play() { played.push(this.src); setTimeout(() => this.onended?.(), 5); return Promise.resolve(); } pause() {} };
  const { speakLive, toggleVoiceMode } = await import('../public/chat-speak.js');
  toggleVoiceMode('main:');
  played.length = 0; // the moment of silence that unlocks sound on the click is not a sentence
  const say = (text, done = false) => speakLive({ runId: 'r1', text, done }, 'main:', 'r1');
  say('Hello');
  assert.deepEqual(fetched, [], 'half a phrase waits');
  say('Hello! I checked');
  assert.deepEqual(fetched, ['Hello!'], 'a finished sentence is spoken at once, before the reply ends');
  say('Hello! I checked the **build**, and every test passes. Here is the code:\n```js\nconst x = 1;');
  assert.deepEqual(fetched, ['Hello!', 'I checked the build, and every test passes. Here is the code:'], 'what is finished goes in one piece; markdown marks dropped; an open code block not read');
  say('Hello! I checked the **build**, and every test passes. Here is the code:\n```js\nconst x = 1;\n```\nDone', true);
  assert.deepEqual(fetched.slice(2), ['(code) Done'], 'the rest when it is finished; the code is said as "code"');
  speakLive({ runId: 'other', text: 'Not this chat. ', done: true }, 'main:', 'r1');
  assert.equal(fetched.length, 3, 'only the open chat speaks');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(played.length, 3, 'every piece plays, one after another');
});

test('Voice mode says in a few words what the agent is doing while it works, without filling the silence with chatter', async () => {
  const fetched = [];
  globalThis.localStorage = { store: { 'rex-voice-mode': JSON.stringify(['main:']) }, getItem(key) { return this.store[key] ?? null; }, setItem(key, value) { this.store[key] = value; }, removeItem(key) { delete this.store[key]; } };
  globalThis.fetch = async (url, { body }) => { fetched.push(JSON.parse(body).text); return { ok: true, blob: async () => new Blob(['x']) }; };
  globalThis.Audio = class { play() { setTimeout(() => this.onended?.(), 1); return Promise.resolve(); } pause() {} };
  const { speakLive, toggleVoiceMode } = await import('../public/chat-speak.js?tools');
  toggleVoiceMode('main:');
  speakLive({ runId: 'r1', tool: 'Grep' }, 'main:', 'r1');
  speakLive({ runId: 'r1', tool: 'Read' }, 'main:', 'r1');
  assert.deepEqual(fetched, ['Let me look at the files.'], 'one line, not one per step');
  speakLive({ runId: 'r1', tool: 'Bash' }, 'other:', 'r1');
  assert.equal(fetched.length, 1, 'a chat without Voice mode stays quiet');
});

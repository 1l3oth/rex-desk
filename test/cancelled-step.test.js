import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRunner, cancelledByItself, cancelNote, attachedImages } from '../src/runners.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a step Claude Code cancelled by itself is recognised in either result shape', () => {
  const words = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
  assert.ok(cancelledByItself(words));
  assert.ok(cancelledByItself([{ type: 'text', text: words }]));
  assert.ok(cancelledByItself(words.replace("'", '’')));
  assert.ok(!cancelledByItself('Permission denied by the hook.') && !cancelledByItself(''));
});

test('after a cancelled step the agent is told once to run it again, and past two cancels to stop what is still running', () => {
  const runner = new ClaudeRunner({});
  assert.equal(runner.takeCancelNote(), '', 'nothing to say before a cancel');
  runner.noteCancelled();
  const first = runner.takeCancelNote();
  assert.match(first, /cancelled by Claude Code itself/); assert.match(first, /Run the same step again/); assert.match(first, /background tasks or watches[\s\S]*stop it first \(TaskStop\)/, 'stop your own background tasks before the retry (L50)');
  assert.equal(runner.takeCancelNote(), '', 'said once, not on every step');
  runner.noteCancelled();
  assert.match(runner.takeCancelNote(), /happened 2 times[\s\S]*TaskStop/);
  assert.match(cancelNote(3), /3 times/);
});

// A stand-in for the Agent SDK: replays the given messages and remembers what it was asked.
const fakeSdk = (messages, seen) => ({ query: ({ prompt, options }) => { seen.prompt = prompt; seen.options = options; return Object.assign((async function* replay() { for (const message of messages) yield message; })(), { interrupt: async () => {}, close: () => {} }); } });
const cancelWords = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";

test('a cancel the agent never heard about (it answered without another step) is handed over right after the turn (L50)', async () => {
  const seen = {}, queued = [];
  const runner = new ClaudeRunner({ sdk: fakeSdk([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', is_error: true, content: cancelWords }] } }, { type: 'result', subtype: 'success', result: 'I could not open it.', usage: {} }], seen),
    run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: () => {}, requeue: text => queued.push(text) });
  await runner.start('look at this');
  assert.equal(queued.length, 1); assert.match(queued[0], /Run the same step again/);
});

test('pictures the person attached go to Claude inside the message, so no file read is needed (L50)', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-attach-')), picture = path.join(folder, 'image.png'), note = path.join(folder, 'notes.txt');
  writeFileSync(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])); writeFileSync(note, 'text');
  const prompt = `what is this?

Attached files (read them from these paths):
- ${picture}
- ${note}
- ${path.join(folder, 'gone.png')}`;
  const images = attachedImages(prompt);
  assert.equal(images.length, 1, 'only pictures that are here'); assert.equal(images[0].source.media_type, 'image/png'); assert.equal(Buffer.from(images[0].source.data, 'base64').length, 7);
  const seen = {}, runner = new ClaudeRunner({ sdk: fakeSdk([{ type: 'result', subtype: 'success', result: 'ok', usage: {} }], seen), run: { id: 'r', provider: 'claude' }, cwd: folder, event: () => {} });
  await runner.start(prompt);
  const sent = []; for await (const message of seen.prompt) sent.push(message);
  assert.equal(sent.length, 1); const content = sent[0].message.content;
  assert.equal(content[0].type, 'text'); assert.match(content[0].text, /Attached files/); assert.match(content[0].text, /also in this message/);
  assert.equal(content[1].type, 'image');
  const plain = {}; await new ClaudeRunner({ sdk: fakeSdk([{ type: 'result', subtype: 'success', result: 'ok', usage: {} }], plain), run: { id: 'r', provider: 'claude' }, cwd: folder, event: () => {} }).start('no pictures');
  assert.equal(plain.prompt, 'no pictures', 'a message without pictures goes as plain text');
});

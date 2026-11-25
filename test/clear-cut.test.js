import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Pull the real transcript() out of public/chat.js and run it with small stubs.
// The chat keeps events in arrival order, so a reply synced from another computer can sit before the
// "chat cleared" marker in the list while being newer than it. transcript() must cut by time, not by list position.
function loadTranscript(showEarlier = {}) {
  const source = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
  const start = source.indexOf('function transcript(all, runId');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  const stubs = "const t = text => text, provider = () => 'Agent', tokenText = () => '', lastReply = () => null;"
    + " const spokenText = text => ({ text: String(text || ''), voice: false });";
  return new Function('ui', `${stubs}\n${body}\nreturn transcript;`)({ showEarlier });
}

const order = items => items.map(item => item.text).filter(Boolean);

test('a reply newer than the clear still shows even when it sits before the marker in list order', () => {
  const transcript = loadTranscript();
  // List order (arrival order): an old reply, a newer manager reply, the clear marker, then my message.
  const all = [
    { kind: 'agent-text', text: 'old reply before the clear', createdAt: '2026-01-01T00:00:00.000Z' },
    { kind: 'agent-text', text: 'manager reply after the clear', createdAt: '2026-01-01T00:10:00.000Z' },
    { kind: 'chat-cleared', text: 'Chat cleared', createdAt: '2026-01-01T00:05:00.000Z' },
    { kind: 'human-message', text: 'my message', createdAt: '2026-01-01T00:11:00.000Z' },
  ];
  const texts = order(transcript(all, 'run1'));
  assert.ok(texts.includes('manager reply after the clear'), 'the newer reply before the marker must show');
  assert.ok(texts.includes('my message'), 'my own message after the clear must show');
  assert.ok(!texts.includes('old reply before the clear'), 'a message older than the clear stays hidden');
  const marker = transcript(all, 'run1').find(item => item.role === 'cleared');
  assert.equal(marker.earlier, true, 'the clear marker offers to show the older hidden message');
});

test('showing earlier messages brings back everything, including what is older than the clear', () => {
  const transcript = loadTranscript({ run1: true });
  const all = [
    { kind: 'agent-text', text: 'old reply before the clear', createdAt: '2026-01-01T00:00:00.000Z' },
    { kind: 'chat-cleared', text: 'Chat cleared', createdAt: '2026-01-01T00:05:00.000Z' },
    { kind: 'human-message', text: 'my message', createdAt: '2026-01-01T00:11:00.000Z' },
  ];
  const texts = order(transcript(all, 'run1'));
  assert.ok(texts.includes('old reply before the clear'), 'with earlier shown, the older message is back');
});

test('the newest of several clear markers is the cut, whatever its list position', () => {
  const transcript = loadTranscript();
  const all = [
    { kind: 'chat-cleared', text: 'later clear', createdAt: '2026-01-01T00:20:00.000Z' },
    { kind: 'agent-text', text: 'between the two clears', createdAt: '2026-01-01T00:10:00.000Z' },
    { kind: 'chat-cleared', text: 'earlier clear', createdAt: '2026-01-01T00:05:00.000Z' },
    { kind: 'agent-text', text: 'after the latest clear', createdAt: '2026-01-01T00:25:00.000Z' },
  ];
  const texts = order(transcript(all, 'run1'));
  assert.ok(texts.includes('after the latest clear'), 'content newer than the newest clear shows');
  assert.ok(!texts.includes('between the two clears'), 'content older than the newest clear stays hidden');
  const markers = transcript(all, 'run1').filter(item => item.role === 'cleared');
  assert.equal(markers.length, 1, 'only the newest clear marker is kept');
});

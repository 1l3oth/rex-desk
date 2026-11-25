import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Some phone browsers have no speechSynthesis at all; touching it there threw "Can't find variable: speechSynthesis" when a chat
// opened. Node has none either, so the speech module is loaded here the same way.
test('a browser without speechSynthesis: the speech module answers quietly instead of throwing', async () => {
  assert.equal(typeof globalThis.speechSynthesis, 'undefined');
  globalThis.localStorage ||= { store: {}, getItem(key) { return this.store[key] ?? null; }, setItem(key, value) { this.store[key] = value; }, removeItem(key) { delete this.store[key]; } };
  const speak = await import('../public/chat-speak.js?no-voices');
  assert.equal(speak.synth?.() ?? null, null);
  assert.doesNotThrow(() => speak.stopLive());
  assert.equal(speak.speechPlaying(), false);
  assert.equal(speak.speechIdle(), true);
  assert.deepEqual(await speak.voicesFor('en'), []);
});

test('only the synth() check touches speechSynthesis directly in the page scripts', () => {
  for (const file of readdirSync('public').filter(name => name.endsWith('.js'))) {
    const lines = readFileSync(`public/${file}`, 'utf8').split('\n');
    const bare = lines.map((line, index) => [index + 1, line.replace(/\/\/.*$/, '')])
      .filter(([, line]) => /\bspeechSynthesis\b/.test(line) && !/typeof speechSynthesis !== 'undefined'/.test(line) && !/'speechSynthesis' in window/.test(line));
    assert.deepEqual(bare.map(([number]) => `${file}:${number}`), [], 'use synth() from chat-speak.js');
  }
});

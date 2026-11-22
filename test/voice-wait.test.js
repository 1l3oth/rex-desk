import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { Voice } from '../src/voice.js';

test('a voice model that is still loading answers "still starting" quickly and keeps loading, with no engine log', async () => {
  const voice = new Voice(mkdtempSync(path.join(process.env.REX_TEST_TMP || os.tmpdir(), 'voice-wait-')));
  let loaded; const loading = new Promise(resolve => { loaded = resolve; });
  voice.server = key => { voice.servers.set(key, { since: Date.now() - 5000, up: false }); return loading; };
  const started = Date.now();
  await assert.rejects(voice.transcribe(Buffer.from('wav'), 'en', { waitMs: 50 }), error => error.starting === true && /still starting/.test(error.message) && !/\x1b|llama/.test(error.message));
  assert.ok(Date.now() - started < 2000);
  const starting = voice.status().starting;
  assert.equal(starting.length, 1); assert.ok(starting[0].seconds >= 5);
  loaded({ url: 'http://127.0.0.1:1' });
});

test('the server waits about 20 seconds for the local model, then says it is still starting and never uploads instead', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /LOCAL_VOICE_WAIT_MS = 20000/);
  assert.match(source, /still starting\. Try again in a moment/);
  assert.doesNotMatch(source, /is still starting, so/);
});

test('microphone errors keep their real name', async () => {
  const source = readFileSync(new URL('../public/recorder.js', import.meta.url), 'utf8');
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) assert.match(source, new RegExp(`name === '${name}'`));
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(composer, /catch \{[^}]*could not use the microphone/);
});

test('the voice guide has the same steps in English, Khmer and Korean, and recordings stay on this computer unless an online engine was chosen', () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  const guide = /VOICE_GUIDE = \{([\s\S]*?)\n\};/.exec(composer)[1];
  for (const language of ["en", "km", "ko"]) assert.ok(guide.includes(`  ${language}: [`), language);
  assert.doesNotMatch(composer, /<select data-v-language/);
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /\?\.engine \|\| 'local';/);
  assert.match(server, /wanted === 'local' && !ready\.local\) return json\(response, 400/);
});

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

// liveShow from the page, run against a fake message box.
function liveHarness() {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  const block = start => { const at = composer.indexOf(start); return composer.slice(at, composer.indexOf(start.startsWith('const') ? '\n' : '\n}', at) + (start.startsWith('const') ? 0 : 2)); };
  const code = ['function liveStart', 'function liveShow'].map(block).join('\n');
  const box = { value: '', getAttribute: () => '', focus() {}, dispatchEvent() {} }; let key = 'a';
  const ctx = { draftKey: () => key, ui: { drafts: new Map() } };
  const run = new Function('document', 'Event', `${code}; return { liveStart, liveShow };`)({ getElementById: () => box }, class {});
  return { box, ctx, ...run, switchTo: next => { key = next; } };
}
test('live words keep text typed before, after or inside them, and stay with the chat they started in', () => {
  const { box, ctx, liveStart, liveShow, switchTo } = liveHarness();
  box.value = 'Hi'; const live = liveStart(ctx);
  liveShow(ctx, live, 'fix the'); assert.equal(box.value, 'Hi fix the');
  box.value = 'Hi fix the, please';
  liveShow(ctx, live, 'fix the login'); assert.equal(box.value, 'Hi fix the login, please', 'typed after the words stays after them, no repeat');
  box.value = 'Hi fix it, please';
  liveShow(ctx, live, 'fix the login button'); assert.equal(box.value, 'Hi fix it button, please', 'edited words stay as typed, newer words go after the edit');
  const other = liveStart(ctx); switchTo('b'); box.value = 'other chat';
  liveShow(ctx, other, 'hello', { final: true });
  assert.equal(box.value, 'other chat', 'the open chat is not touched'); assert.equal(ctx.ui.drafts.get('a'), 'Hi fix it button, please hello', 'the words land in the chat they started in');
  // Text typed after the words that repeats them is the person's own, never replaced.
  const again = liveHarness(); again.box.value = 'Hi'; const said = again.liveStart(again.ctx);
  again.liveShow(again.ctx, said, 'yes'); again.box.value = 'Hi yes yes';
  again.liveShow(again.ctx, said, 'yes please'); assert.equal(again.box.value, 'Hi yes please yes');
  again.box.value = `Oh ${again.box.value}`;
  again.liveShow(again.ctx, said, 'yes please now'); assert.equal(again.box.value, 'Oh Hi yes please now yes', 'typed before the words moves them along');
});

test('a Voice mode turn sends only into the chat it started in, and a cancelled one sends nothing', () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  assert.match(composer, /if \(!said \|\| !alive\(\)\) \{ onState\('idle'\); return; \}/, 'browser Voice mode drops words after a chat switch');
  assert.ok(composer.indexOf('const turnOf = voiceTurns') < composer.indexOf('await browserTurn(ctx, onState, alive)'), 'the chat is taken before the mic opens');
  assert.match(composer, /if \(!alive\(\)\) \{ stream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\); return 'cancelled'; \}/);
  assert.match(composer, /cancelVoiceTurn\(\) \{ voiceTurns\+\+/);
  assert.match(composer, /hearWords\(ctx, recording\.wav\(\), \{ alive \}\); if \(alive\(\)\) await sendSpoken/);
  assert.match(composer, /if \(!alive\(\)\) throw Object\.assign\(new Error\('cancelled'\)/);
});

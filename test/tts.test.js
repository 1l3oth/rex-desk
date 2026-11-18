import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Speaker, FISH_VOICES } from '../src/tts.js';

const temporary = () => mkdtempSync(path.join(os.tmpdir(), 'rex-desk-tts-'));
const KEY = 'fish-test-key-0123456789abcdef';
// A Fish Audio answer that arrives in three pieces, like the real chunked one.
const answer = (status = 200, pieces = [Buffer.from('ID3'), Buffer.from('sound-'), Buffer.from('bytes')]) => () => new Response(status === 200 ? new ReadableStream({ start(controller) { for (const piece of pieces) controller.enqueue(piece); controller.close(); } }) : JSON.stringify({ message: 'no' }), { status });
function setup({ replies = [answer()], engine = 'fish', secret = KEY } = {}) {
  const store = new Store(temporary()), calls = [], standard = [];
  const fetcher = async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return (replies[Math.min(calls.length - 1, replies.length - 1)])(); };
  const speaker = new Speaker(store, { fetcher, standard: async (text, options) => { standard.push({ text, options }); return Buffer.from('standard-voice'); }, env: {} });
  if (secret) speaker.saveKey(secret);
  speaker.save({ engine });
  return { store, speaker, calls, standard };
}

test('Fish Audio speaks English with the newest model, the chosen voice and speed, and the sound is sent as it arrives', async () => {
  const { speaker, calls, standard } = setup();
  speaker.save({ voice: FISH_VOICES[1][0], speed: 1.15 });
  const arrived = []; const audio = await speaker.speak('Hello there, Rex.', { lang: 'en', onChunk: chunk => arrived.push(chunk.toString()) });
  assert.equal(audio.toString(), 'ID3sound-bytes'); assert.deepEqual(arrived, ['ID3', 'sound-', 'bytes'], 'three pieces, in order, before the whole is done');
  assert.equal(calls[0].url, 'https://api.fish.audio/v1/tts');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].options.headers.model, 's2.1-pro-free', 'the free newest model, never s1');
  assert.equal(calls[0].body.reference_id, FISH_VOICES[1][0]); assert.equal(calls[0].body.prosody.speed, 1.15); assert.equal(calls[0].body.latency, 'low'); assert.equal(calls[0].body.format, 'mp3');
  assert.equal(standard.length, 0);
  speaker.save({ model: 's2.1-pro' }); await speaker.speak('Another line.', { lang: 'en' });
  assert.equal(calls[1].options.headers.model, 's2.1-pro'); assert.ok(!calls.some(call => call.options.headers.model === 's1'));
});

test('every English line is in the same voice, a repeated line is not fetched twice, and Korean stays with the natural voice', async () => {
  const { speaker, calls, standard } = setup();
  await speaker.speak('First reply.', { lang: 'en', voice: 'en-US-AndrewMultilingualNeural' });
  await speaker.speak('Let me look at the files.', { lang: 'en', voice: 'something else the window picked' });
  assert.equal(new Set(calls.map(call => call.body.reference_id)).size, 1, 'the window cannot make a second voice');
  await speaker.speak('First reply.', { lang: 'en' }); assert.equal(calls.length, 2, 'the repeated line came from the cache');
  await speaker.speak('안녕하세요', { lang: 'ko' }); assert.equal(calls.length, 2); assert.equal(standard.length, 1, 'Korean is not sent to Fish Audio');
});

test('when Fish Audio fails the natural voice says the line, and a refused key or no credit leaves Fish Audio alone for a while', async () => {
  const none = setup({ replies: [answer(402)] });
  const audio = await none.speaker.speak('Are you there?', { lang: 'en' });
  assert.equal(audio.toString(), 'standard-voice', 'never silent'); assert.match(none.speaker.lastError, /no credit/);
  await none.speaker.speak('Second line.', { lang: 'en' }); await none.speaker.speak('Third line.', { lang: 'en' });
  assert.equal(none.calls.length, 1, 'no credit: Fish Audio is not asked again, so one fallback voice says the rest');
  assert.equal(none.standard.length, 3); assert.match((await none.speaker.status()).holding, /no credit/);

  const busy = setup({ replies: [answer(429), answer(429)] });
  assert.equal((await busy.speaker.speak('Busy.', { lang: 'en' })).toString(), 'standard-voice'); assert.equal(busy.calls.length, 2, 'a busy answer is tried once more first');
  const recovers = setup({ replies: [answer(503), answer(200)] });
  assert.equal((await recovers.speaker.speak('Hiccup.', { lang: 'en' })).toString(), 'ID3sound-bytes', 'one hiccup is retried and the Fish voice still says it');

  const nokey = setup({ secret: '' }); assert.equal((await nokey.speaker.speak('No key.', { lang: 'en' })).toString(), 'standard-voice'); assert.equal(nokey.calls.length, 0);
  const standardOnly = setup({ engine: 'standard' }); await standardOnly.speaker.speak('Plain.', { lang: 'en' }); assert.equal(standardOnly.calls.length, 0);
});

test('each line says which voice said it, so the window can fall back to the person\'s own voice', async () => {
  const voices = []; const good = setup(); await good.speaker.speak('Fish says this.', { lang: 'en', onChunk: (_, voice) => voices.push(voice) });
  const failing = setup({ replies: [answer(401)] }); await failing.speaker.speak('The natural voice says this.', { lang: 'en', onChunk: (_, voice) => voices.push(voice) });
  assert.deepEqual([...new Set(voices)], ['fish', 'standard']);
  assert.match((await failing.speaker.status()).holding, /refused the key/, 'the window is told Fish Audio is resting, so its own voice takes over');
});

test('usage stays small: minutes are counted, and past the daily limit the natural voice takes over', async () => {
  const { speaker, calls, standard } = setup();
  speaker.save({ dailyMinutes: 1 });
  await speaker.speak('x'.repeat(1000), { lang: 'en' });
  let status = await speaker.status(); assert.ok(status.usedMinutesToday > 0.5 && status.usedMinutesToday < 1, `used ${status.usedMinutesToday}`); assert.equal(status.capped, false);
  await speaker.speak('y'.repeat(1000), { lang: 'en' }); status = await speaker.status(); assert.equal(status.capped, true);
  await speaker.speak('Past the limit.', { lang: 'en' }); assert.equal(calls.length, 2, 'no third request to Fish Audio'); assert.equal(standard.length, 1); assert.match(speaker.lastError, /daily limit/);
  assert.equal(status.costPerMinute, 0, 'the free model costs nothing');
  speaker.save({ model: 's2.1-pro' }); assert.ok(Math.abs((await speaker.status()).costPerMinute - 0.0208) < 0.001, 'about two cents a minute');
});

test('the key is each person\'s own: kept locked, checked for its shape, never shown in the status; nothing is looked up in anyone\'s secret store', async () => {
  const { store, speaker } = setup({ secret: '' });
  assert.throws(() => speaker.saveKey('short'), /does not look like/);
  assert.equal(speaker.saveKey(KEY), true);
  assert.ok(!JSON.stringify(store.list('secret')).includes(KEY), 'stored encrypted');
  const status = speaker.status(); const shown = await status; assert.equal(shown.hasKey, true); assert.equal(shown.keyFrom, 'rex-desk'); assert.ok(!JSON.stringify(shown).includes(KEY), 'the status never carries the key');
  assert.equal(speaker.saveKey(''), false); assert.equal((await speaker.status()).hasKey, false);
  assert.deepEqual(await new Speaker(store, { env: {} }).key(), { key: '', from: '' }, 'no key of ours, and none of anyone else\'s');
  assert.equal((await new Speaker(store, { env: { FISH_AUDIO_API_KEY: KEY } }).key()).from, 'environment');
  assert.equal((await status).link, 'https://fish.audio/app/api-keys');
});

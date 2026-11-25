import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav, frame, levelsOf, livePieces, finalPass, finalChunks, voicedSeconds, looksTruncated, pickFinal, wav16, runTiming, FRAME, LIVE_PIECE_S } from './voice-timing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => readFileSync(path.join(here, 'fixtures', 'voice', name));

test('parseWav reads the saved 16-bit mono fixtures', () => {
  for (const [name, minSec] of [['en5.wav', 2], ['en30.wav', 10]]) {
    const { rate, samples } = parseWav(fixture(name));
    assert.equal(rate, 22050);
    assert.ok(samples.length / rate > minSec, `${name} should be over ${minSec}s`);
  }
});

test('frame cuts audio into 4096-sample chunks', () => {
  const { samples } = parseWav(fixture('en5.wav'));
  const chunks = frame(samples);
  assert.equal(chunks.length, Math.ceil(samples.length / FRAME));
  assert.ok(chunks.slice(0, -1).every(c => c.length === FRAME));
});

// A recording view of `seconds` of audio, all at speaking loudness unless a pause is added.
const speaking = (seconds, rate = 22050) => {
  const per = FRAME / rate, count = Math.round(seconds / per);
  return { rate, chunks: Array.from({ length: count }, () => 0), levels: Array.from({ length: count }, () => 0.1) };
};
// Drop a run of chunks below the speech floor at `atSeconds` to make a sustained pause.
const pauseAt = (rec, atSeconds) => { const per = FRAME / rec.rate, need = Math.max(2, Math.ceil(0.5 / per)), at = Math.round(atSeconds / per); for (let i = 0; i < need; i++) rec.levels[at + i] = 0.001; return rec; };

test('livePieces holds inside the live window then commits a cut at a pause', () => {
  const inside = speaking(LIVE_PIECE_S); // ~5s of audio, still the live tail
  assert.deepEqual(livePieces(inside, 0), { cut: 0, end: inside.chunks.length });
  const talky = speaking(LIVE_PIECE_S + 2); // past the window but no pause: nothing commits
  assert.equal(livePieces(talky, 0).cut, 0);
  const paused = pauseAt(speaking(LIVE_PIECE_S + 2), 4); // a sustained pause around 4s commits a cut
  const { cut, end } = livePieces(paused, 0);
  assert.ok(cut > 0 && cut < end);
});

test('finalPass takes the tail-only pass after a commit, the whole recording otherwise', () => {
  const rec = speaking(10);
  assert.equal(finalPass({ ...rec, liveFrom: 0, liveKept: '' }).path, 'whole', 'nothing committed: hear it all');
  const tail = finalPass({ ...rec, liveFrom: 30, liveKept: 'open the project' });
  assert.equal(tail.path, 'tail'); assert.equal(tail.kept, 'open the project');
  assert.equal(tail.tail.length, rec.chunks.length - 30, 'only the uncommitted tail is heard again');
});

test('wav16 downsamples a slice to a valid 16 kHz 16-bit mono WAV', () => {
  const { rate, samples } = parseWav(fixture('en5.wav'));
  const wav = wav16(frame(samples), rate);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
});

test('runTiming reports first-word before final-text, with a stub model', async () => {
  const { rate, samples } = parseWav(fixture('en5.wav'));
  const chunks = frame(samples);
  // Fast virtual clock so the test does not wait in real time.
  let clock = 0; const now = () => (clock += 40);
  // Stub model: the more audio it is given, the more "words" it returns; a small processing cost each call.
  const transcribe = async wav => { const words = Math.min(5, Math.floor(wav.length / 12000)); return Array.from({ length: words }, (_, i) => `w${i + 1}`).join(' '); };
  const out = await runTiming({ chunks, rate, transcribe, now, everyMs: 1 });
  assert.ok(out.firstWordMs !== null, 'should capture a first word');
  assert.ok(out.finalTextMs >= 0, 'final text comes after speech ends');
  assert.ok(out.text.length > 0, 'should end with some text');
  assert.ok(out.audioMs > 2000, 'audioMs reflects the ~2.7s clip');
  assert.equal(out.finalPath, 'whole', 'a short clip commits nothing, so the whole recording is the final pass');
  assert.equal(out.committedCuts, 0);
});

test('looksTruncated flags a tiny answer for a long voiced span, not slow or short speech', () => {
  // The real cold-start miss: 5 words for ~12.8s of voiced speech.
  assert.equal(looksTruncated('Please open the project folder.', 12.8), true);
  // The full 30-word answer for the same span is fine.
  assert.equal(looksTruncated('Please open the project folder, pull the latest changes from the main branch, install the packages, start the development server on a free port, then run the full test suite and report any failures.', 12.8), false);
  // A short voiced span is never checked, however few words.
  assert.equal(looksTruncated('Open the project and run tests.', 2.8), false);
  // A genuinely slow but present dictation (one word a second) stays above the floor.
  assert.equal(looksTruncated('one two three four five six seven eight nine ten', 10), false);
});

test('looksTruncated judges a space-less script (Khmer) by characters, so a complete Khmer transcript is kept', () => {
  // Khmer writes a whole phrase as one run with only occasional phrase spaces, so counting whitespace "words"
  // would see a complete sentence as one or two words and wrongly flag it. It is judged by character count.
  const complete = 'សូមបើកថតគម្រោង ទាញយកការផ្លាស់ប្ដូរចុងក្រោយ ដំឡើងកញ្ចប់ រួចរត់ការធ្វើតេស្តទាំងអស់';
  assert.equal(looksTruncated(complete, 12.8), false, 'a full Khmer transcript is not a single truncated word');
  // A genuinely cut-off Khmer answer (a few opening characters) is still caught.
  assert.equal(looksTruncated('សូមបើក', 12.8), true, 'only the opening characters for a long span is truncated');
});

test('pickFinal keeps a passing retry even when it has fewer characters than the first answer', () => {
  const voiced = 12.8;
  // First answer: two very long "words", so it is truncated by word count yet longer in characters.
  const first = 'antidisestablishmentarianism supercalifragilisticexpialidocious';
  // Retry: more words but fewer characters, enough words to pass the guard.
  const retry = 'go to the main page and open it right now';
  assert.equal(looksTruncated(first, voiced), true, 'the first answer is far too few words for the span');
  assert.equal(looksTruncated(retry, voiced), false, 'the retry has enough words to pass');
  assert.ok(retry.length < first.length, 'the retry is shorter in characters, so a length-based pick would drop it');
  assert.equal(pickFinal(first, retry, voiced), retry, 'pickFinal keeps the retry that passes the guard, not the longer string');
  // When both pass, the fuller by the guard measure wins (the retry on a tie).
  assert.equal(pickFinal('one two three four five six seven', 'a b c d e f g h i j k', voiced), 'a b c d e f g h i j k', 'the fuller answer wins when both pass');
});

test('voicedSeconds counts only spoken frames, so a short phrase inside long silence is never flagged', () => {
  const rate = 22050, per = FRAME / rate;
  const voicedN = Math.round(2 / per), silentN = Math.round(15 / per); // ~2s of speech, ~15s of silence around it
  const levels = [...Array(silentN).fill(0.001), ...Array(voicedN).fill(0.1), ...Array(silentN).fill(0.001)];
  const rec = { rate, chunks: levels.map(() => 0), levels };
  const voiced = voicedSeconds(rec);
  assert.ok(Math.abs(voiced - 2) < 0.3, 'about 2s of voiced speech, not the ~32s of wall-clock audio');
  assert.equal(looksTruncated('Open the file.', voiced), false, 'a short phrase in long silence is a short voiced span, never suspected');
});

test('finalChunks cuts a long recording only at confirmed pauses, covering it with short windows', () => {
  const rate = 22050, per = FRAME / rate;
  // Two sustained pauses (half a second of sub-floor chunks each), around 4.3s and 8.6s into a 13s clip.
  const rec = pauseAt(pauseAt(speaking(13, rate), 4.3), 8.6);
  const count = rec.chunks.length, windows = finalChunks(rec);
  assert.ok(windows.length >= 3, 'a 13s clip with two pauses becomes several short windows');
  assert.equal(windows[0][0], 0); assert.equal(windows[windows.length - 1][1], count, 'the windows cover the whole recording with no gap');
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i][0], windows[i - 1][1], 'each window starts where the last ended');
  for (const [from, to] of windows) assert.ok((to - from) * per <= LIVE_PIECE_S + 0.01, 'each window is at most the live piece length');
  const firstPause = Math.round(4.3 / per);
  assert.equal(windows[0][1], firstPause, 'the first cut lands at the start of the confirmed pause, never mid-word');
  // Every boundary (except the last, which is the end) sits on a sub-floor frame, i.e. inside a real pause.
  for (let i = 0; i < windows.length - 1; i++) assert.ok(rec.levels[windows[i][1]] < 0.012, 'a cut only ever lands in a sub-floor pause');
});

test('finalChunks never splits continuous speech: with no pause it is one window, and a too-short answer is flagged', () => {
  // The reviewer's case: cutting continuous speech at the single quietest frame could split a word, and joining
  // the pieces cannot put it back. So with no confirmed pause the whole recording stays one request. That request
  // can be slow (not truncated) under load; a genuinely cut-off answer is caught by looksTruncated and cleared.
  const rate = 22050, per = FRAME / rate, count = Math.round(13 / per);
  const rec = speaking(13, rate); // continuous 0.1 RMS, no sub-floor frame anywhere
  assert.deepEqual(finalChunks(rec), [[0, count]], 'no confirmed pause: a single window, so no word is ever split');
  assert.equal(looksTruncated('w0 w1', count * per), true, 'a two-word answer for 13s is flagged truncated, so it is cleared not sent');
});

test('the whole pass is heard window by window at the pauses, so the full text comes back under load', async () => {
  // Under a fully loaded machine one long request stays correct but slow and can be cut off by the client timeout;
  // short requests complete. The stub models that: any request over 6s of audio comes back as just the first two
  // words; shorter requests return the full words for their slice. finalChunks cuts at the confirmed pauses so
  // every window is short enough to complete, and joining them returns the whole text.
  const rate = 22050, per = FRAME / rate, count = Math.round(13 / per);
  const chunks = Array.from({ length: count }, () => new Float32Array(FRAME).fill(0.1));
  const need = Math.max(2, Math.ceil(0.5 / per));
  for (const at of [3.5, 7, 10.5]) { const i0 = Math.round(at / per); for (let i = 0; i < need; i++) chunks[i0 + i] = new Float32Array(FRAME); } // silent pauses
  const levels = levelsOf(chunks), windows = finalChunks({ rate, chunks, levels });
  assert.ok(windows.length >= 3, 'the whole pass splits into several short windows at the pauses');
  assert.ok(windows.every(([from, to]) => (to - from) * per <= LIVE_PIECE_S + 0.01), 'every window is short enough to complete under load');
  const transcribe = async wav => {
    const seconds = (wav.length - 44) / 2 / 16000, words = Math.max(1, Math.round(seconds * 2));
    return seconds > 6 ? 'w0 w1' : Array.from({ length: words }, (_, i) => `w${i}`).join(' '); // a long request stops early
  };
  const parts = [];
  for (const [from, to] of windows) parts.push((await transcribe(wav16(chunks.slice(from, to), rate))).trim());
  const text = parts.filter(Boolean).join(' ');
  assert.ok(text.split(/\s+/).length > 10, 'joining the windows returns the whole text, not just the first two words');
  assert.equal(looksTruncated(text, count * per), false, 'the joined whole text is not flagged truncated');
});

test('runTiming drives the real cut and reports the tail-only pass when a clip has a pause', async () => {
  // Synthetic 8s clip: speech at 0.1 RMS with a half-second silent gap at ~3.5s, so livePieces commits a
  // cut there and finishMic takes the tail-only final pass. No model: a stub returns one word per chunk.
  const rate = 22050, per = FRAME / rate, make = seconds => Array.from({ length: Math.round(seconds / per) }, () => new Float32Array(FRAME).fill(0.1));
  const chunks = make(8), gapAt = Math.round(3.5 / per), gap = Math.max(2, Math.ceil(0.5 / per));
  for (let i = 0; i < gap; i++) chunks[gapAt + i] = new Float32Array(FRAME); // the silent pause
  let clock = 0; const now = () => (clock += 40);
  const transcribe = async wav => Array.from({ length: Math.max(1, Math.floor(wav.length / 16000)) }, (_, i) => `w${i}`).join(' ');
  const out = await runTiming({ chunks, rate, transcribe, now, everyMs: 1 });
  assert.ok(out.committedCuts >= 1, 'the sustained pause commits at least one live cut');
  assert.equal(out.finalPath, 'tail', 'with a committed cut the final pass hears only the uncommitted tail');
  assert.ok(out.firstWordMs !== null && out.text.length > 0);
});

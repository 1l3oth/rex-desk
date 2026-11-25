import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav, frame, levelsOf, livePieces, finalPass, looksTruncated, wav16, runTiming, FRAME, LIVE_PIECE_S } from './voice-timing.mjs';

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

test('looksTruncated flags a tiny answer for long audio, not slow or short speech', () => {
  // The real cold-start miss: 5 words for ~12.8s of speech.
  assert.equal(looksTruncated('Please open the project folder.', 12.8), true);
  // The full 30-word answer for the same clip is fine.
  assert.equal(looksTruncated('Please open the project folder, pull the latest changes from the main branch, install the packages, start the development server on a free port, then run the full test suite and report any failures.', 12.8), false);
  // Short clips are never checked, however few words.
  assert.equal(looksTruncated('Open the project and run tests.', 2.8), false);
  // A genuinely slow but present dictation (one word a second) stays above the floor.
  assert.equal(looksTruncated('one two three four five six seven eight nine ten', 10), false);
});

test('a truncated cold-start final is heard again and the fuller answer kept, never reported truncated', async () => {
  // A ~12s clip with a pause so a cut commits (tail path). A cold stub returns only a couple of words for
  // any piece, and the full sentence only once the whole clip is re-heard (the engine warm by then), which
  // is exactly what the guard does on a suspiciously short final.
  const rate = 22050, per = FRAME / rate, make = seconds => Array.from({ length: Math.round(seconds / per) }, () => new Float32Array(FRAME).fill(0.1));
  const chunks = make(12), gapAt = Math.round(3.5 / per), gap = Math.max(2, Math.ceil(0.5 / per));
  for (let i = 0; i < gap; i++) chunks[gapAt + i] = new Float32Array(FRAME);
  const FULL = 'Please open the project folder, pull the latest changes, install the packages, start the server, then run the tests and report back.';
  const transcribe = async wav => ((wav.length - 44) / 2 / 16000 >= 11 ? FULL : 'ok');
  let clock = 0; const now = () => (clock += 40);
  const out = await runTiming({ chunks, rate, transcribe, now, everyMs: 1 });
  assert.ok(out.committedCuts >= 1, 'the pause commits a live cut (tail path)');
  assert.equal(out.retriedFinal, true, 'a too-short final is heard once more');
  assert.equal(out.truncated, false, 'after the retry the answer is no longer truncated');
  assert.equal(out.text, FULL, 'the fuller answer wins, so no words are lost');
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

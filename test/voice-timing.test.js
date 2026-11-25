import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav, frame, livePieces, wav16, runTiming, FRAME, LIVE_PIECE_S } from './voice-timing.mjs';

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

test('livePieces holds inside the live window then commits a cut', () => {
  const rate = 22050, per = FRAME / rate;
  const insideCount = Math.floor(LIVE_PIECE_S / per); // ~5s of audio, still the live tail
  assert.deepEqual(livePieces(insideCount, rate, 0), { cut: 0, end: insideCount });
  const longCount = Math.ceil((LIVE_PIECE_S + 2) / per); // past the window: a cut is committed
  const { cut, end } = livePieces(longCount, rate, 0);
  assert.ok(cut > 0 && cut < end);
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
});

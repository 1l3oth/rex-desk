// Replayable voice timing harness. Feeds a saved WAV through the on-computer model the same way live
// dictation does (a sliding window every 1.5s, mirroring liveLocal in public/chat-composer.js), and
// prints the two numbers QA records: first-word latency and final-text latency.
//
//   node test/voice-timing.mjs test/fixtures/voice/en5.wav en
//   REX_VOICE_DIR="<app data>/voice" node test/voice-timing.mjs test/fixtures/voice/en30.wav en
//
// It uses the real installed model (the same Voice class the app uses), so run it on a build where
// "Voice on this computer" is installed. --selftest replaces the model with a stub so the schedule and
// timing maths can be checked with no model present (used by test/voice-timing.test.js).
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVE_EVERY_MS = 1500, LIVE_PIECE_S = 5, LIVE_CUT_S = 2.5, FRAME = 4096;

// Parse a 16-bit PCM mono WAV into { rate, samples: Float32Array in -1..1 }.
export function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file.');
  let offset = 12, rate = 0, bits = 0, channels = 0, data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === 'fmt ') { channels = buffer.readUInt16LE(body + 2); rate = buffer.readUInt32LE(body + 4); bits = buffer.readUInt16LE(body + 14); }
    else if (id === 'data') { data = buffer.subarray(body, body + size); }
    offset = body + size + (size & 1);
  }
  if (!data || bits !== 16 || channels !== 1) throw new Error('Expected 16-bit mono PCM WAV.');
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 0x8000;
  return { rate, samples };
}

// Frame samples into FRAME-sample chunks, like the recorder's ScriptProcessor.
export function frame(samples) {
  const chunks = [];
  for (let i = 0; i < samples.length; i += FRAME) chunks.push(samples.subarray(i, i + FRAME));
  return chunks;
}

// Mirror livePieces (public/chat-composer.js): given how many chunks have arrived and the cursor, say
// which committed cut to take (0 = still inside the live window). The app also nudges the cut to the
// quietest frame; levels are not needed for timing, so the plain cut is used.
export function livePieces(count, rate, from = 0) {
  const per = FRAME / rate, end = count;
  if ((end - from) * per <= LIVE_PIECE_S) return { cut: 0, end };
  const cut = from + Math.ceil(LIVE_CUT_S / per);
  return { cut, end };
}

// Build a 16 kHz 16-bit mono WAV Buffer from a slice of chunks at `rate`, like wavFrom in recorder.js.
export function wav16(chunks, rate) {
  let total = 0; for (const c of chunks) total += c.length;
  const input = new Float32Array(total); let at = 0;
  for (const c of chunks) { input.set(c, at); at += c.length; }
  const ratio = rate / 16000, length = Math.floor(input.length / ratio), pcm = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) { const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)])); pcm.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), i * 2); }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Run the live schedule against a transcriber, in real time (now = performance.now()). Returns the
// timings. `transcribe(wavBuffer)` resolves to the recognized text for that slice.
export async function runTiming({ chunks, rate, transcribe, now = () => performance.now(), everyMs = LIVE_EVERY_MS }) {
  const per = (FRAME / rate) * 1000, audioMs = chunks.length * per;
  const t0 = now();
  const arrived = () => Math.min(chunks.length, Math.floor((now() - t0) / per));
  let busy = false, from = 0, kept = '', firstWordAt = null, lastShownAt = null, shown = '';
  const hear = async (start, stop) => (await transcribe(wav16(chunks.slice(start, stop), rate)).catch(() => '')).trim();
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const count = arrived();
      const { cut, end } = livePieces(count, rate, from);
      if (cut) { const words = await hear(from, cut); kept = [kept, words].filter(Boolean).join(' '); from = cut; }
      const tail = cut ? '' : await hear(from, end);
      const text = [kept, tail].filter(Boolean).join(' ');
      if (text) { if (!firstWordAt) firstWordAt = now(); shown = text; lastShownAt = now(); }
    } finally { busy = false; }
  };
  await new Promise(resolve => {
    const timer = setInterval(() => void tick(), everyMs);
    const stopAt = t0 + audioMs;
    const waitStop = setInterval(async () => {
      if (now() < stopAt) return;
      clearInterval(waitStop); clearInterval(timer);
      while (busy) await new Promise(r => setTimeout(r, 20));
      const finalStart = now();
      const finalText = (await transcribe(wav16(chunks, rate)).catch(() => '')).trim();
      if (finalText) { shown = finalText; if (!firstWordAt) firstWordAt = now(); }
      resolve({ finalAt: now(), finalStart, finalText });
    }, 50);
  }).then(final => (runTiming._final = final));
  const { finalAt } = runTiming._final;
  return {
    audioMs: Math.round(audioMs),
    firstWordMs: firstWordAt === null ? null : Math.round(firstWordAt - t0),
    finalTextMs: Math.round(finalAt - (t0 + audioMs)),
    text: shown,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) { console.log('This file is a harness; run test/voice-timing.test.js for the self-test.'); return; }
  const wavPath = args[0], language = args[1] || 'en';
  if (!wavPath) { console.error('Usage: node test/voice-timing.mjs <wav> [en|km|ko]'); process.exit(2); }
  const { Voice } = await import('../src/voice.js');
  const dir = process.env.REX_VOICE_DIR;
  if (!dir) { console.error('Set REX_VOICE_DIR to the app\'s voice folder (<app data>/voice) so the installed model is used.'); process.exit(2); }
  const voice = new Voice(dir);
  const status = voice.status();
  if (!status.languages[language]) { console.error(`The ${language} model is not installed in ${dir}. Install Voice in the app first.`); process.exit(2); }
  const { rate, samples } = parseWav(readFileSync(path.resolve(wavPath)));
  const chunks = frame(samples);
  process.stderr.write('Warming the model...\n');
  await voice.prepare(language);
  const transcribe = async wav => (await voice.transcribe(wav, language)).text || '';
  const out = await runTiming({ chunks, rate, transcribe });
  console.log(JSON.stringify({ wav: path.basename(wavPath), language, ...out }, null, 2));
  voice.stopAll();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(e => { console.error(e.message); process.exit(1); });

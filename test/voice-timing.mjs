// Replayable voice timing harness. Feeds a saved WAV through the on-computer model the same way live
// dictation does, driving the REAL cut and final-pass logic from public/voice-live.js (the same code the
// app runs), and prints the numbers QA records: first live word, final text, and which final pass ran.
//
//   node test/voice-timing.mjs test/fixtures/voice/en-pauses.wav en
//   REX_VOICE_DIR="<app data>/voice" node test/voice-timing.mjs test/fixtures/voice/en30.wav en
//
// It uses the real installed model (the same Voice class the app uses), so run it on a build where
// "Voice on this computer" is installed. test/voice-timing.test.js drives runTiming with a stub model and
// a virtual clock, so the schedule and the path choice can be checked with no model present.
//
// en-pauses.wav has clear pauses between phrases, so livePieces commits cuts and finishMic takes the
// tail-only final pass. en30.wav is continuous (pause-free), so nothing commits and the whole-recording
// pass runs. The harness prints finalPath ("tail" or "whole") for each clip, so QA can tell them apart.
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { livePieces, finalPass, finalChunks, audioSeconds, voicedSeconds, looksTruncated, pickFinal, FRAME, LIVE_EVERY_MS, LIVE_PIECE_S } from '../public/voice-live.js';

export { livePieces, finalPass, finalChunks, audioSeconds, voicedSeconds, looksTruncated, pickFinal, FRAME, LIVE_EVERY_MS, LIVE_PIECE_S };

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

// Per-chunk RMS loudness, the exact number recorder.js stores in recording.levels, so the real livePieces
// sees the same pauses the app would.
export function levelsOf(chunks) {
  return chunks.map(chunk => { let sum = 0; for (const value of chunk) sum += value * value; return chunk.length ? Math.sqrt(sum / chunk.length) : 0; });
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

// Run the real live schedule against a transcriber, in real time (now = performance.now()). It mirrors
// liveLocal + finishMic in public/chat-composer.js, but calls the shared livePieces and finalPass so the
// path it reports is the path the app would take. `transcribe(wavBuffer)` resolves to the recognized text
// for that slice. Returns the timings plus finalPath and how many live cuts committed.
export async function runTiming({ chunks, rate, transcribe, now = () => performance.now(), everyMs = LIVE_EVERY_MS }) {
  const per = (FRAME / rate) * 1000, audioMs = chunks.length * per;
  const levels = levelsOf(chunks);
  const t0 = now();
  const arrived = () => Math.min(chunks.length, Math.floor((now() - t0) / per));
  let busy = false, from = 0, kept = '', liveFrom = 0, liveKept = '', committedCuts = 0;
  let firstWordAt = null, shown = '';
  const hear = async (start, stop) => (await transcribe(wav16(chunks.slice(start, stop), rate)).catch(() => '')).trim();
  // One live tick, like liveLocal's tick: hear the kept cut (if any) then the live tail, and show the text.
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const count = arrived();
      const recording = { rate, chunks: chunks.slice(0, count), levels: levels.slice(0, count) };
      const { cut, end } = livePieces(recording, from);
      if (cut) { const words = await hear(from, cut); kept = [kept, words].filter(Boolean).join(' '); from = cut; liveFrom = from; liveKept = kept; committedCuts++; }
      const tail = cut ? '' : await hear(from, end);
      const text = [kept, tail].filter(Boolean).join(' ');
      if (text) { if (!firstWordAt) firstWordAt = now(); shown = text; }
    } finally { busy = false; }
  };
  const final = await new Promise(resolve => {
    const timer = setInterval(() => void tick(), everyMs);
    const stopAt = t0 + audioMs;
    const waitStop = setInterval(async () => {
      if (now() < stopAt) return;
      clearInterval(waitStop); clearInterval(timer);
      while (busy) await new Promise(r => setTimeout(r, 20));
      const finalStart = now();
      // finishMic on stop: the shared finalPass picks the tail-only or the whole-recording pass. The whole-recording
      // pass is heard in short windows (finalChunks) cut only at confirmed pauses, since on a fully loaded machine one
      // long request stays correct but turns very slow and can be cut off by the request timeout; each short window
      // completes in a few seconds. Pause-free audio has no safe cut, so it stays one request (slower, never split).
      const pass = finalPass({ rate, chunks, levels, liveFrom, liveKept });
      const hearWindowed = async () => {
        const windows = finalChunks({ rate, chunks, levels });
        if (windows.length <= 1) return hear(0, chunks.length);
        const parts = [];
        for (const [from, to] of windows) parts.push(await hear(from, to));
        return parts.filter(Boolean).join(' ');
      };
      let finalText = pass.path === 'tail'
        ? [pass.kept, await hear(pass.from, chunks.length)].filter(Boolean).join(' ')
        : await hearWindowed();
      // Judged against voiced speech time, not the whole recording. A suspiciously short answer is re-heard once
      // and pickFinal keeps whichever passes the guard (or the fuller by its measure); it is discarded (cleared)
      // only if the chosen answer is STILL far too short for a long voiced span.
      const voiced = voicedSeconds({ rate, chunks, levels });
      if (looksTruncated(finalText, voiced)) finalText = pickFinal(finalText, await hearWindowed(), voiced);
      const truncated = looksTruncated(finalText, voiced);
      // The final pass is authoritative: report it, never stale live text, so a discarded answer shows as empty.
      shown = truncated ? '' : finalText; if (shown && !firstWordAt) firstWordAt = now();
      resolve({ finalAt: now(), finalStart, finalText: shown, path: pass.path, windowedFinal: pass.path === 'whole', truncated });
    }, 50);
  });
  return {
    audioMs: Math.round(audioMs),
    firstWordMs: firstWordAt === null ? null : Math.round(firstWordAt - t0),
    finalTextMs: Math.round(final.finalAt - (t0 + audioMs)),
    finalPath: final.path,
    committedCuts,
    windowedFinal: final.windowedFinal,
    truncated: final.truncated,
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
  process.stderr.write(`Final pass: ${out.finalPath === 'tail' ? 'tail only (a pause committed live)' : 'whole recording in short windows'}; ${out.committedCuts} live cut(s)${out.truncated ? '; STILL TRUNCATED (final was too short for the audio)' : ''}.\n`);
  voice.stopAll();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(e => { console.error(e.message); process.exit(1); });

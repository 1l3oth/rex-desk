// Voices every step of the Settings tours (public/guides/settings-tour-steps.js) with KiriTTS and writes one small
// AAC file per step to public/guides/voice/<step id>.m4a, which the tour plays as the step is shown.
// Run: KIRITTS_API_KEY=... KIRITTS_VOICE=<voice or clone id> FFMPEG=<path to ffmpeg> node scripts/make-tour-voice.js
// Voiced lines are cached in .local/guide-voice by voice, speed and text, so only changed lines cost credits.
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ALL_STEPS } from '../public/guides/settings-tour-steps.js';

const KEY = process.env.KIRITTS_API_KEY, VOICE = process.env.KIRITTS_VOICE || 'daraboth', SPEED = Number(process.env.KIRITTS_SPEED || 0.9);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const cache = path.resolve('.local/guide-voice'), out = path.resolve('public/guides/voice');
mkdirSync(cache, { recursive: true }); mkdirSync(out, { recursive: true });

async function speak(text) {
  const file = path.join(cache, `${createHash('sha1').update(`${VOICE}|${SPEED}|${text}`).digest('hex').slice(0, 16)}.wav`);
  if (existsSync(file)) return file;
  if (!KEY) throw new Error('Set KIRITTS_API_KEY (and KIRITTS_VOICE) to voice new lines.');
  // The connection sometimes drops mid-answer; try again a few times before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch('https://api.kiritts.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'kiritts', voice: VOICE, input: text, speed: SPEED, response_format: 'wav' }) });
      if (!response.ok) throw new Error(`KiriTTS ${response.status}: ${(await response.text()).slice(0, 200)}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer())); return file;
    } catch (error) { if (attempt >= 4 || /KiriTTS 4\d\d/.test(error.message)) throw error; console.log(`Retry ${attempt}: ${error.message}`); await new Promise(resolve => setTimeout(resolve, 3000 * attempt)); }
  }
}

const ids = new Set();
for (const step of ALL_STEPS) {
  const source = await speak(step.say || step.km), target = path.join(out, `${step.id}.m4a`); ids.add(`${step.id}.m4a`);
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', source, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1', '-c:a', 'aac', '-b:a', '40k', '-movflags', '+faststart', '-f', 'mp4', target]);
}
// Voice files of steps that no longer exist are removed.
for (const name of readdirSync(out)) if (!ids.has(name)) rmSync(path.join(out, name));
console.log(`Wrote ${ids.size} voice files to public/guides/voice.`);

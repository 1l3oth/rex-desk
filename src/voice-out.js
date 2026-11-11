// Reading a reply aloud with Microsoft's neural voices (the ones Edge's Read aloud uses): far clearer than the one robotic
// voice Windows has. The text goes to Microsoft's speech service and comes back as MP3; the same text is not fetched twice.
import { createHash } from 'node:crypto';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const NEURAL_VOICES = {
  en: [['en-US-AvaMultilingualNeural', 'Ava (natural, US)'], ['en-US-AndrewMultilingualNeural', 'Andrew (natural, US)'], ['en-US-EmmaMultilingualNeural', 'Emma (natural, US)'], ['en-US-BrianMultilingualNeural', 'Brian (natural, US)'], ['en-GB-SoniaNeural', 'Sonia (UK)'], ['en-AU-NatashaNeural', 'Natasha (Australia)']],
  ko: [['ko-KR-SunHiNeural', 'SunHi (natural)'], ['ko-KR-InJoonNeural', 'InJoon (natural)'], ['ko-KR-HyunsuMultilingualNeural', 'Hyunsu (natural)']],
  km: [['km-KH-SreymomNeural', 'Sreymom (natural)'], ['km-KH-PisethNeural', 'Piseth (natural)']],
};
const cache = new Map();
// Up to about 900 letters per request, cut at sentence ends: the service stops on very long input.
function pieces(text) {
  const out = []; let piece = '';
  for (const sentence of text.split(/(?<=[.!?。\n])\s+/)) { if ((piece + sentence).length > 900 && piece) { out.push(piece.trim()); piece = ''; } piece += `${sentence} `; }
  if (piece.trim()) out.push(piece.trim());
  return out;
}
async function one(text, voice) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  return new Promise((resolve, reject) => {
    const chunks = []; const timer = setTimeout(() => { tts.close?.(); reject(new Error('The voice service did not answer.')); }, 30000);
    audioStream.on('data', chunk => chunks.push(chunk));
    const done = () => { clearTimeout(timer); tts.close?.(); resolve(Buffer.concat(chunks)); };
    audioStream.on('end', done); audioStream.on('close', done); audioStream.on('error', error => { clearTimeout(timer); reject(error); });
  });
}
export async function speak(text, { lang = 'en', voice = '' } = {}) {
  const clean = String(text || '').trim().slice(0, 12000); if (!clean) throw new Error('Nothing to read.');
  const known = NEURAL_VOICES[lang] || NEURAL_VOICES.en, chosen = known.some(([id]) => id === voice) || /^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(voice) ? voice : known[0][0];
  const key = createHash('sha256').update(`${chosen}\n${clean}`).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const parts = []; for (const piece of pieces(clean)) parts.push(await one(piece, chosen));
  const audio = Buffer.concat(parts);
  if (!audio.length) throw new Error('The voice service sent no sound.');
  cache.set(key, audio); if (cache.size > 60) cache.delete(cache.keys().next().value);
  return audio;
}

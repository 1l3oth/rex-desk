// Spoken replies: one place decides which voice says anything, so Voice mode, the speaker button, the welcome lines and the
// short status lines are all in the same voice. Two engines: Microsoft's natural voices (free, the standard) and Fish Audio
// (online, its own key). Fish Audio is used for English only; Korean and Khmer stay with the Microsoft voices. When Fish Audio
// cannot answer (no key, a refused key, no credit, too busy, a daily limit reached) the standard voice says the line, so
// Voice mode never goes silent, and after a refused key or no credit Fish Audio is left alone for a while so the rest of the
// conversation stays in one voice instead of switching back and forth.
import { createHash } from 'node:crypto';
import { speak as speakStandard } from './voice-out.js';

export const FISH_URL = 'https://api.fish.audio/v1/tts';
// A few good English voices from Fish Audio's public library: calm and clear, for an assistant that talks a lot.
export const FISH_VOICES = [
  ['933563129e564b19a115bedd57b7406a', 'Sarah (warm, conversational)'],
  ['b347db033a6549378b48d00acb0d06cd', 'Selene (soft, calm)'],
  ['c2623f0c075b4492ac367989aee1576f', 'Paula (clear, friendly)'],
  ['536d3a5e000945adb7038665781a4aca', 'Ethan (clear, steady)'],
  ['bf322df2096a46f18c579d0baa36f41d', 'Adrian (deep, narrator)'],
  ['c5f56a6cc2ec4fa8920cb4c5889a3fb7', 'Slax (medium, clear)'],
];
// The free model costs nothing under Fish Audio's fair use; the best one is billed by the size of the text.
// Fish Audio says one million UTF-8 bytes of text is about 12 hours of speech, at $15.
export const FISH_MODELS = [['s2.1-pro-free', 'Free model'], ['s2.1-pro', 'Best model (paid)']];
const PAID_PER_MILLION_BYTES = 15, BYTES_PER_MINUTE = 1_000_000 / (12 * 60);
export const costPerMinute = model => (model === 's2.1-pro-free' ? 0 : PAID_PER_MILLION_BYTES * BYTES_PER_MINUTE / 1_000_000);
export const DEFAULTS = { engine: 'standard', voice: FISH_VOICES[0][0], speed: 1, model: 'in-use', dailyMinutes: 30 };
const SECRET = 'FISH_AUDIO_API_KEY', HOLD_MS = 10 * 60000;
const today = () => new Date().toISOString().slice(0, 10);

// Fish Audio is opt-in and every person brings their own key: the one pasted in Settings (kept locked on this computer), or the
// FISH_AUDIO_API_KEY variable for someone who starts Rex Desk with it set. It is held in memory only and never written to a
// log or sent anywhere but Fish Audio. Rex Desk ships no key and uses nobody else's.
export class Speaker {
  constructor(store, { fetcher = fetch, standard = speakStandard, env = process.env } = {}) {
    Object.assign(this, { store, fetcher, standard, env });
    this.cache = new Map(); this.hold = { until: 0, reason: '' }; this.lastError = '';
  }
  settings() { return { ...DEFAULTS, ...(this.store.get('voice', 'tts') || {}) }; }
  save(input = {}) {
    const now = this.settings(), next = { ...now };
    if (['standard', 'fish'].includes(input.engine)) next.engine = input.engine;
    if (FISH_VOICES.some(([id]) => id === input.voice)) next.voice = input.voice;
    if (Number.isFinite(Number(input.speed))) next.speed = Math.min(1.5, Math.max(0.7, Math.round(Number(input.speed) * 20) / 20));
    if (FISH_MODELS.some(([id]) => id === input.model)) next.model = input.model;
    if (Number.isFinite(Number(input.dailyMinutes))) next.dailyMinutes = Math.min(600, Math.max(1, Math.round(Number(input.dailyMinutes))));
    this.store.put('voice', 'tts', { id: 'tts', ...next }); this.hold = { until: 0, reason: '' }; this.lastError = '';
    return this.settings();
  }
  // The model in use: the free one unless the person chose the best one.
  model(settings = this.settings()) { return settings.model === 's2.1-pro' ? 's2.1-pro' : 's2.1-pro-free'; }
  async key() {
    const own = this.store.get('secret', 'fish-audio');
    if (own) { try { return { key: this.store.decrypt(own), from: 'rex-desk' }; } catch { /* a key made under another vault falls through */ } }
    if (this.env[SECRET]) return { key: String(this.env[SECRET]).trim(), from: 'environment' };
    return { key: '', from: '' };
  }
  saveKey(key) {
    const clean = String(key || '').trim();
    if (!clean) { this.store.delete('secret', 'fish-audio'); return false; }
    if (!/^[A-Za-z0-9_-]{20,}$/.test(clean)) throw new Error('That does not look like a Fish Audio API key.');
    this.store.put('secret', 'fish-audio', this.store.encrypt(clean)); this.hold = { until: 0, reason: '' }; this.lastError = ''; return true;
  }
  // What the minutes used say: bytes of text sent to Fish Audio today and this month.
  usage() {
    const saved = this.store.get('voice', 'fish-usage') || {}, day = today(), month = day.slice(0, 7);
    return { day, todayBytes: saved.day === day ? saved.todayBytes || 0 : 0, month, monthBytes: saved.month === month ? saved.monthBytes || 0 : 0, requests: saved.day === day ? saved.requests || 0 : 0 };
  }
  count(bytes) {
    const used = this.usage();
    this.store.put('voice', 'fish-usage', { id: 'fish-usage', day: used.day, todayBytes: used.todayBytes + bytes, month: used.month, monthBytes: used.monthBytes + bytes, requests: used.requests + 1 });
  }
  async status() {
    const settings = this.settings(), { from } = await this.key(), used = this.usage(), model = this.model(settings), cap = settings.dailyMinutes * BYTES_PER_MINUTE;
    return { engine: settings.engine, voice: settings.voice, speed: settings.speed, model: settings.model === 's2.1-pro' ? 's2.1-pro' : 's2.1-pro-free', dailyMinutes: settings.dailyMinutes,
      hasKey: Boolean(from), keyFrom: from, voices: FISH_VOICES, models: FISH_MODELS, costPerMinute: costPerMinute(model), paidCostPerMinute: costPerMinute('s2.1-pro'),
      usedMinutesToday: Math.round(used.todayBytes / BYTES_PER_MINUTE * 10) / 10, usedMinutesMonth: Math.round(used.monthBytes / BYTES_PER_MINUTE * 10) / 10,
      costThisMonth: Math.round(used.monthBytes * (model === 's2.1-pro-free' ? 0 : PAID_PER_MILLION_BYTES / 1_000_000) * 100) / 100,
      capped: used.todayBytes >= cap, link: 'https://fish.audio/app/api-keys', holding: this.hold.until > Date.now() ? this.hold.reason : '', problem: this.lastError };
  }
  // Fish Audio says it with every request; a refused key or no credit stops asking for a while.
  async fish(text, settings, onChunk) {
    const { key } = await this.key(); if (!key) throw Object.assign(new Error('Add your Fish Audio key to use its voice.'), { hard: true });
    const bytes = Buffer.byteLength(text);
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.fetcher(FISH_URL, { method: 'POST', signal: AbortSignal.timeout(30000),
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', model: this.model(settings) },
          body: JSON.stringify({ text, reference_id: settings.voice, format: 'mp3', mp3_bitrate: 128, latency: 'low', normalize: true, prosody: { speed: settings.speed } }) });
      } catch (error) { response = null; if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 400)); continue; } throw new Error('Fish Audio did not answer.'); }
      if (response.status === 429 || response.status >= 500) { if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 400)); continue; } }
      break;
    }
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Fish Audio refused the key. Paste a new one.'), { hard: true });
    if (response.status === 402) throw Object.assign(new Error('Fish Audio has no credit left. Add credit on fish.audio.'), { hard: true });
    if (!response.ok) throw new Error(`Fish Audio answered ${response.status}.`);
    const chunks = [], reader = response.body.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; const chunk = Buffer.from(value); chunks.push(chunk); onChunk?.(chunk, 'fish'); } }
    catch { throw Object.assign(new Error('Fish Audio stopped part way.'), { sent: chunks.length > 0 }); }
    const audio = Buffer.concat(chunks); if (!audio.length) throw new Error('Fish Audio sent no sound.');
    this.count(bytes); return audio;
  }
  // The one door for every spoken line. onChunk gets the sound as it arrives (Fish Audio streams), or once for the whole of it.
  async speak(text, { lang = 'en', voice = '', onChunk } = {}) {
    const clean = String(text || '').trim().slice(0, 12000); if (!clean) throw new Error('Nothing to read.');
    const settings = this.settings();
    const wanted = settings.engine === 'fish' && lang === 'en' && this.hold.until <= Date.now();
    if (wanted) {
      const used = this.usage(), cap = settings.dailyMinutes * BYTES_PER_MINUTE;
      if (used.todayBytes >= cap) { this.lastError = `The daily limit of ${settings.dailyMinutes} minutes of Fish Audio speech is reached. The standard voice says the rest today.`; }
      else {
        const id = createHash('sha256').update(`fish\n${this.model(settings)}\n${settings.voice}\n${settings.speed}\n${clean}`).digest('hex');
        const hit = this.cache.get(id); if (hit) { onChunk?.(hit, 'fish'); return hit; }
        try {
          const audio = await this.fish(clean, settings, onChunk); this.lastError = '';
          this.cache.set(id, audio); if (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value);
          return audio;
        } catch (error) {
          this.lastError = error.message;
          if (error.hard) this.hold = { until: Date.now() + HOLD_MS, reason: error.message };
          if (error.sent) throw error;
        }
      }
    }
    const audio = await this.standard(clean, { lang, voice }); onChunk?.(audio, 'standard'); return audio;
  }
}

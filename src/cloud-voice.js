// Online speech-to-text, for when the on-computer model does not understand a language well enough (Khmer above all).
// Two engines: Gemini through the person's OpenRouter key (already used by Jev), and ElevenLabs Scribe with its own key.
// The recording leaves the computer only when the person picks one of these engines, or presses Compare.
const NAMES = { km: 'Khmer', en: 'English', ko: 'Korean' };
const ISO3 = { km: 'khm', en: 'eng', ko: 'kor' };

// The newest Gemini Flash on OpenRouter that takes audio, looked up once a day, so a retired model id never breaks voice.
let cachedModel = { id: '', at: 0 };
async function geminiModel(fetcher) {
  if (cachedModel.id && Date.now() - cachedModel.at < 86400000) return cachedModel.id;
  try {
    const response = await fetcher('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) });
    const { data = [] } = await response.json();
    const audio = data.filter(model => /^google\/gemini-[\d.]+-flash/.test(model.id) && !/lite|image|tts|thinking/i.test(model.id) && model.architecture?.input_modalities?.includes('audio'));
    const version = id => Number(/gemini-([\d.]+)/.exec(id)?.[1] || 0) - (/preview|exp/.test(id) ? 0.01 : 0);
    const best = audio.sort((left, right) => version(right.id) - version(left.id))[0];
    if (best) { cachedModel = { id: best.id, at: Date.now() }; return best.id; }
  } catch {}
  return 'google/gemini-2.5-flash';
}

export async function transcribeGemini(wav, language, key, { fetcher = fetch } = {}) {
  if (!key) throw new Error('Gemini needs your OpenRouter key. Add it in Issues & settings → Jev priority.');
  const model = await geminiModel(fetcher);
  const response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Rex Desk' },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: [
      { type: 'text', text: `Transcribe this ${NAMES[language] || ''} speech exactly as spoken, in its own script${language === 'km' ? ' (Khmer script, not romanized)' : ''}. Keep English words that were spoken in English. Reply with the words only: no translation, no notes, no quotes.` },
      { type: 'input_audio', input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } },
    ] }] }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gemini: ${data.error?.message || `HTTP ${response.status}`}`);
  return { text: String(data.choices?.[0]?.message?.content || '').trim().replace(/^["“]|["”]$/g, ''), engine: 'gemini', model };
}

export async function transcribeElevenLabs(wav, language, key, { fetcher = fetch } = {}) {
  if (!key) throw new Error('ElevenLabs needs its API key. Add it under Voice engine.');
  const send = async model => {
    const form = new FormData();
    form.append('model_id', model); form.append('language_code', ISO3[language] || ''); form.append('tag_audio_events', 'false');
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    return fetcher('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(60000) });
  };
  let model = 'scribe_v2', response = await send(model);
  if (response.status === 400 || response.status === 422) { model = 'scribe_v1'; response = await send(model); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('ElevenLabs refused the key. Paste a new one under Voice engine.');
  if (!response.ok) throw new Error(`ElevenLabs: ${data.detail?.message || data.detail || `HTTP ${response.status}`}`);
  return { text: String(data.text || '').trim(), engine: 'elevenlabs', model };
}

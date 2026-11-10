import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeGemini, transcribeElevenLabs } from '../src/cloud-voice.js';

test('Gemini picks the newest audio Flash model on OpenRouter and asks for Khmer script', async () => {
  const sent = [];
  const fetcher = async (url, options = {}) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [
      { id: 'google/gemini-2.5-flash', architecture: { input_modalities: ['text', 'audio'] } },
      { id: 'google/gemini-3.1-flash', architecture: { input_modalities: ['text', 'image', 'audio'] } },
      { id: 'google/gemini-3.1-flash-lite', architecture: { input_modalities: ['text', 'audio'] } },
      { id: 'google/gemini-9-flash-image', architecture: { input_modalities: ['text'] } },
    ] });
    sent.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: '"សួស្តី"' } }] });
  };
  const result = await transcribeGemini(Buffer.from('RIFFwav'), 'km', 'sk-or-test', { fetcher });
  assert.equal(result.text, 'សួស្តី'); assert.equal(result.model, 'google/gemini-3.1-flash');
  assert.match(sent[0].messages[0].content[0].text, /Khmer script/); assert.equal(sent[0].messages[0].content[1].input_audio.format, 'wav');
  await assert.rejects(transcribeGemini(Buffer.from('x'), 'km', '', { fetcher }), /OpenRouter key/);
});

test('ElevenLabs sends the Khmer language code and falls back to the older Scribe model', async () => {
  const models = [];
  const fetcher = async (url, options) => {
    const model = options.body.get('model_id'); models.push([model, options.body.get('language_code')]);
    if (model === 'scribe_v2') return Response.json({ detail: 'unknown model' }, { status: 422 });
    return Response.json({ text: ' សួស្តី ' });
  };
  const result = await transcribeElevenLabs(Buffer.from('RIFFwav'), 'km', 'eleven-key-1234567890', { fetcher });
  assert.equal(result.text, 'សួស្តី'); assert.deepEqual(models, [['scribe_v2', 'khm'], ['scribe_v1', 'khm']]);
});

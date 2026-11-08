// Voice recording shared by the dashboard and the Jev bar: the microphone at its own rate, turned into 16 kHz mono WAV,
// which the speech model reads. It stops by itself after a second and a half of quiet once you have spoken, or after 20 seconds.
export async function openMicrophone() {
  return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
}
export function startRecorder(stream, { onQuiet = () => {}, onLevel = () => {} } = {}) {
  const context = new AudioContext(), source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1);
  const recorder = { chunks: [], rate: context.sampleRate, started: performance.now(), heard: false, quietSince: 0, stopped: false };
  processor.onaudioprocess = event => {
    if (recorder.stopped) return;
    const data = event.inputBuffer.getChannelData(0); recorder.chunks.push(new Float32Array(data));
    let sum = 0; for (const value of data) sum += value * value;
    const level = Math.sqrt(sum / data.length), time = performance.now();
    onLevel(level);
    if (level > 0.02) { recorder.heard = true; recorder.quietSince = 0; } else if (recorder.heard && !recorder.quietSince) recorder.quietSince = time;
    if ((recorder.heard && recorder.quietSince && time - recorder.quietSince > 1500) || time - recorder.started > 20000) onQuiet();
  };
  source.connect(processor); processor.connect(context.destination);
  recorder.stop = () => {
    if (recorder.stopped) return; recorder.stopped = true;
    processor.disconnect(); stream.getTracks().forEach(track => track.stop()); void context.close();
  };
  recorder.wav = () => wavFrom(recorder.chunks, recorder.rate);
  return recorder;
}
export function wavFrom(chunks, rate) {
  const input = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const ratio = rate / 16000, length = Math.floor(input.length / ratio), samples = new Int16Array(length);
  for (let index = 0; index < length; index++) { const sample = Math.max(-1, Math.min(1, input[Math.floor(index * ratio)])); samples[index] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF; }
  const header = new DataView(new ArrayBuffer(44)), text = (at, value) => [...value].forEach((char, index) => header.setUint8(at + index, char.charCodeAt(0)));
  text(0, 'RIFF'); header.setUint32(4, 36 + samples.byteLength, true); text(8, 'WAVE'); text(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
  header.setUint32(24, 16000, true); header.setUint32(28, 32000, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true); text(36, 'data'); header.setUint32(40, samples.byteLength, true);
  return new Blob([header.buffer, samples.buffer], { type: 'audio/wav' });
}
// Sends the recording to Rex Desk's on-computer speech model and returns { text, fallback }.
export async function transcribe(wav, language) {
  const response = await fetch(`/api/voice/transcribe?language=${encodeURIComponent(language)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'x-rex-desk': '1' }, body: wav });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  if (!result.text) throw new Error('No words were recognized. Try again a little closer to the microphone.');
  return result;
}

// Listen to a reply: the 🔊 on an agent's message reads it aloud with the voices built into the computer (nothing is sent anywhere).
// It picks a Korean or Khmer voice when the message is in that language, prefers the natural-sounding voices, and reads in short
// pieces so long replies are not cut off. Pressing it again, or another message's button, stops it.
let playing = null;
const SPEAKER = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 6h2l3-2.5v9L5 10H3z" fill="currentColor"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const STOP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
export const speakButton = (extraClass = '') => ('speechSynthesis' in window ? `<button type="button" class="speak ${extraClass}" data-speak title="Listen" aria-label="Listen to this message">${SPEAKER}</button>` : '');

// What a person would hear: the words, without code, link addresses, the token line or the "to …" line.
function spokenText(message) {
  const copy = message.cloneNode(true);
  copy.querySelectorAll('.tok,.to,.rquote,.md-code,pre,.speak,button').forEach(node => node.replaceWith(node.matches?.('.md-code,pre') ? ' (code) ' : ''));
  return copy.innerText.replace(/https?:\/\/\S+/g, 'a link').replace(/[*_`#>|]+/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}
function language(text) { return /[ក-៿]/.test(text) ? 'km' : /[가-힯]/.test(text) ? 'ko' : 'en'; }
function voiceFor(lang) {
  const voices = speechSynthesis.getVoices().filter(voice => voice.lang.toLowerCase().startsWith(lang));
  return voices.find(voice => /natural|online|neural/i.test(voice.name)) || voices.find(voice => voice.localService) || voices[0] || null;
}
// Pieces of about two sentences: browsers stop very long utterances part way.
function pieces(text) {
  const out = []; let piece = '';
  for (const sentence of text.split(/(?<=[.!?。\n])\s+/)) { if ((piece + sentence).length > 220 && piece) { out.push(piece); piece = ''; } piece += `${sentence} `; }
  if (piece.trim()) out.push(piece);
  return out;
}
function stop() {
  speechSynthesis.cancel();
  if (playing) { playing.button.innerHTML = SPEAKER; playing.button.classList.remove('on'); playing.button.title = 'Listen'; }
  playing = null;
}
function play(button) {
  const message = button.closest('.bubble')?.querySelector('.md'); if (!message) return;
  const text = spokenText(message); if (!text) return;
  stop();
  const lang = language(text), voice = voiceFor(lang), parts = pieces(text);
  playing = { button }; button.innerHTML = STOP; button.classList.add('on'); button.title = 'Stop';
  const mine = playing;
  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part);
    utterance.lang = voice?.lang || { en: 'en-US', ko: 'ko-KR', km: 'km-KH' }[lang]; if (voice) utterance.voice = voice;
    utterance.rate = 1.05;
    if (index === parts.length - 1) utterance.onend = () => { if (playing === mine) stop(); };
    utterance.onerror = () => { if (playing === mine) stop(); };
    speechSynthesis.speak(utterance);
  });
}
export function wireSpeak() {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.getVoices(); speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-speak]'); if (!button) return;
    event.preventDefault(); event.stopPropagation();
    if (playing?.button === button) stop(); else play(button);
  }, true);
  // Leaving the chat stops the voice.
  window.addEventListener('hashchange', stop);
}

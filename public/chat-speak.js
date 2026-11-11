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
  // A copy outside the page has no layout, so its lines are joined by hand: each paragraph, list item and heading ends with a pause.
  copy.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,tr,div,br').forEach(node => node.append('\n'));
  return copy.textContent.replace(/https?:\/\/\S+/g, 'a link').replace(/[*_`#>|]+/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}
// The language with the most letters wins, so a Korean name in an English reply is still read in English.
function language(text) {
  const count = pattern => (text.match(pattern) || []).length;
  const counts = { km: count(/[ក-៿]/g), ko: count(/[가-힯ᄀ-ᇿ㄰-㆏]/g), en: count(/[A-Za-z]/g) };
  return Object.entries(counts).sort((left, right) => right[1] - left[1])[0][0];
}
// The voice list arrives a moment after the page opens; asking before that gave the computer's default voice (Korean on a Korean
// Windows) for English text.
function voices() {
  const now = speechSynthesis.getVoices(); if (now.length) return Promise.resolve(now);
  return new Promise(resolve => { const done = () => resolve(speechSynthesis.getVoices()); speechSynthesis.addEventListener?.('voiceschanged', done, { once: true }); setTimeout(done, 1500); });
}
export const chosenVoice = lang => { try { return localStorage.getItem(`rex-desk-voice-${lang}`) || ''; } catch { return ''; } };
export async function voicesFor(lang) { return (await voices()).filter(voice => voice.lang.toLowerCase().replace('_', '-').startsWith(lang)); }
async function voiceFor(lang) {
  const list = await voicesFor(lang), picked = chosenVoice(lang);
  return list.find(voice => voice.name === picked) || list.find(voice => /natural|online|neural/i.test(voice.name) && /en-us|ko-kr|km-kh/i.test(voice.lang)) || list.find(voice => /natural|online|neural/i.test(voice.name)) || list.find(voice => /en-us/i.test(voice.lang)) || list[0] || null;
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
async function play(button) {
  const message = button.closest('.bubble')?.querySelector('.md'); if (!message) return;
  const text = spokenText(message); if (!text) return;
  stop();
  const lang = language(text), voice = await voiceFor(lang), parts = pieces(text);
  if (!voice && lang === 'en') ctxToast?.('No English voice is installed on this computer. Add one in Windows Settings, Time & language, Speech.');
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
let ctxToast = null;
export function wireSpeak(toast) {
  ctxToast = toast;
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

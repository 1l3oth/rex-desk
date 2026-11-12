// Listen to a reply: the 🔊 on an agent's message reads it aloud with the voices built into the computer (nothing is sent anywhere).
// It picks a Korean or Khmer voice when the message is in that language, prefers the natural-sounding voices, and reads in short
// pieces so long replies are not cut off. Pressing it again, or another message's button, stops it.
let playing = null;
const SPEAKER = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 6h2l3-2.5v9L5 10H3z" fill="currentColor"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const STOP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
export const speakButton = (extraClass = '') => (true ? `<button type="button" class="speak ${extraClass}" data-speak title="Listen" aria-label="Listen to this message">${SPEAKER}</button>` : '');

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
// Phones (iPhone above all) only let a page make sound that starts during the tap itself. The voice is fetched first, so one
// player is started with a moment of silence right at the tap, and every piece of the voice then plays through that same player.
let player = null;
const SILENCE = Uint8Array.from(atob('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='), char => char.charCodeAt(0));
function unlockSound() {
  player ||= new Audio();
  try { player.src = URL.createObjectURL(new Blob([SILENCE], { type: 'audio/wav' })); const started = player.play(); started?.catch?.(() => {}); } catch { /* the voice still tries */ }
  // The computer's own voices on a phone need the same first touch.
  try { if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(' ')); } catch { /* no voices */ }
}
function stop() {
  speechSynthesis.cancel?.();
  if (playing?.audio) { playing.audio.pause(); playing.audio.onended = null; playing.audio.onerror = null; URL.revokeObjectURL(playing.audio.src); }
  if (playing) { playing.button.innerHTML = SPEAKER; playing.button.classList.remove('on', 'loading'); playing.button.title = 'Listen'; }
  playing = null;
}
// The computer's own voices: used when the neural voice cannot be reached, or when the person picked one in Settings.
async function playLocal(text, lang, mine) {
  const voice = await voiceFor(lang), parts = pieces(text);
  if (!voice && lang === 'en') ctxToast?.('No English voice is installed on this computer. Add one in Windows Settings, Time & language, Speech.');
  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part);
    utterance.lang = voice?.lang || { en: 'en-US', ko: 'ko-KR', km: 'km-KH' }[lang]; if (voice) utterance.voice = voice;
    utterance.rate = 1.05;
    if (index === parts.length - 1) utterance.onend = () => { if (playing === mine) stop(); };
    utterance.onerror = () => { if (playing === mine) stop(); };
    speechSynthesis.speak(utterance);
  });
}
async function play(button) {
  const message = button.closest('.bubble')?.querySelector('.md'); if (!message) return;
  const text = spokenText(message); if (!text) return;
  stop(); unlockSound();
  const lang = language(text), chosen = chosenVoice(lang);
  playing = { button }; button.innerHTML = STOP; button.classList.add('on', 'loading'); button.title = 'Stop';
  const mine = playing;
  // A neural voice (Microsoft's Edge voices, the same studybook uses) unless the person chose one of the computer's voices.
  if (!chosen || /Neural$/.test(chosen)) {
    // Short pieces, so the first one plays within a moment while the next is fetched behind it.
    const parts = [];
    for (const piece of pieces(text)) { const last = parts.at(-1); if (last && (last + piece).length < 380) parts[parts.length - 1] = `${last} ${piece}`; else parts.push(piece); }
    const fetchPart = part => fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify({ text: part, lang, voice: chosen }) })
      .then(async response => { if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The voice service did not answer.'); return URL.createObjectURL(await response.blob()); });
    try {
      let next = fetchPart(parts[0]);
      for (let index = 0; index < parts.length; index += 1) {
        const url = await next; if (playing !== mine) { URL.revokeObjectURL(url); return; }
        next = index + 1 < parts.length ? fetchPart(parts[index + 1]) : null;
        const audio = player || new Audio(); audio.src = url; mine.audio = audio; button.classList.remove('loading');
        await new Promise((resolve, reject) => { audio.onended = resolve; audio.onerror = () => reject(new Error('The sound could not play.')); audio.play().catch(reject); });
        URL.revokeObjectURL(url); if (playing !== mine) return;
      }
      if (playing === mine) stop(); return;
    } catch (error) { if (playing !== mine) return; button.classList.remove('loading'); ctxToast?.(`Using this computer's voice: ${error.message}`, true); }
  }
  button.classList.remove('loading');
  if ('speechSynthesis' in window) await playLocal(text, lang, mine); else stop();
}
let ctxToast = null;
export function wireSpeak(toast) {
  ctxToast = toast;
  if ('speechSynthesis' in window) { speechSynthesis.getVoices(); speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices()); }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-speak]'); if (!button) return;
    event.preventDefault(); event.stopPropagation();
    if (playing?.button === button) stop(); else play(button);
  }, true);
  // Leaving the chat stops the voice.
  window.addEventListener('hashchange', stop);
}

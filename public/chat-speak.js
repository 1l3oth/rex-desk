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
  // Resolves when the last piece has been spoken, so replies read one after another do not cut each other off.
  return new Promise(resolve => {
    if (!parts.length) { resolve(); return; }
    parts.forEach((part, index) => {
      const utterance = new SpeechSynthesisUtterance(part);
      utterance.lang = voice?.lang || { en: 'en-US', ko: 'ko-KR', km: 'km-KH' }[lang]; if (voice) utterance.voice = voice;
      utterance.rate = 1.05;
      if (index === parts.length - 1) utterance.onend = () => { if (playing === mine) stop(); resolve(); };
      utterance.onerror = () => { if (playing === mine) stop(); resolve(); };
      speechSynthesis.speak(utterance);
    });
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
// Read replies aloud: a switch in every chat that has the play button (personal chats, Rex Agent and group chats). While
// it is on, each new reply is read out once it is finished (not while the AI is still typing), one after another, in the
// voice picked in Settings. Replies that were there when it was switched on, or when the chat was opened, are not read.
const AUTO = 'rex-read-aloud', heard = new Map();
let reading = Promise.resolve();
const autoChats = () => { try { return new Set(JSON.parse(localStorage.getItem(AUTO) || '[]')); } catch { return new Set(); } };
export const readAloudOn = key => autoChats().has(key);
const replies = () => [...document.querySelectorAll('#feed-inner .msg:not(.mine) [data-speak]')];
const replyId = button => { const message = button.closest('.msg'), text = button.closest('.bubble')?.querySelector('.md')?.textContent || ''; return message?.dataset.msg || (text ? `${text.length}:${text.slice(0, 120)}` : ''); };
const markAll = key => heard.set(key, new Set(replies().map(replyId)));
export function toggleReadAloud(key) {
  const chats = autoChats(), on = !chats.has(key);
  if (on) { chats.add(key); unlockSound(); markAll(key); } else { chats.delete(key); stop(); }
  try { localStorage.setItem(AUTO, JSON.stringify([...chats])); } catch { /* private window */ }
  return on;
}
// After each redraw: finished replies not read yet are read, oldest first. A reply Voice mode already spoke is not read again.
export function readNewReplies(key) {
  // In Voice mode, Voice mode alone decides what is said (never a written report or code), so read-aloud stays quiet.
  if (!heard.has(key) || !readAloudOn(key) || voiceModeOn(key)) { markAll(key); return; }
  if (document.querySelector('#feed-inner .bubble.typing')) return;
  const seen = heard.get(key);
  for (const button of replies()) {
    const id = replyId(button); if (!id || seen.has(id)) continue;
    seen.add(id);
    if (spokenLive(button.closest('.bubble')?.querySelector('.md')?.textContent || '')) continue;
    reading = reading.then(() => (readAloudOn(key) && document.body.contains(button) ? play(button) : null)).catch(() => {});
  }
}

// ---------- Voice mode ----------
// A spoken conversation, separate from read-aloud above: Rex Desk listens, sends what you said when you stop talking, speaks
// the agent's reply while the agent is still writing it (each finished phrase at once, a phrase behind the words), and
// listens again once the reply is spoken. The server sends the text so far of the block being written (event "partial");
// "done" carries the finished block. Switched on per chat with its own button in the chat header.
// Kept only while the page is open, never saved: after a reload Voice mode is off until the person turns it on again with
// a click. A Voice mode that came back by itself could make no sound (browsers block sound a page starts without a click)
// and would open the microphone unasked.
const voiceOnIn = new Set();
try { localStorage.removeItem('rex-voice-mode'); } catch { /* private window */ }
export const voiceModeOn = key => voiceOnIn.has(key);
export function toggleVoiceMode(key) {
  const on = !voiceOnIn.has(key);
  // Turned on by a click: the player starts inside that click, so the browser lets it make sound.
  if (on) { voiceOnIn.add(key); unlockSound(); } else { voiceOnIn.delete(key); stopLive(); }
  return on;
}
const WAVE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>';
export const voiceModeButton = key => { const on = voiceModeOn(key); return `<button type="button" class="icon-btn voice-mode${on ? ' on' : ''}" data-action="voice-mode" aria-pressed="${on}" title="${on ? 'Voice mode is on: talk, and the reply is spoken as it is written. Press to end' : 'Voice mode: talk with this agent'}" aria-label="Voice mode">${WAVE}</button>`; };
// Nothing is being said or waiting to be said.
export const speechIdle = () => live.pending === 0 && !(typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking);
// How loud Rex's own voice is right now (0 to 1), for the body in Voice mode to glow with. It listens to a copy of the
// player's sound (captureStream), so the voice itself always plays straight out: routing the player through a meter made
// it silent whenever the browser had not let the meter start yet. Where no copy can be taken, and for the computer's own
// voices, the body gets a gentle made-up rhythm while it speaks.
let meter = null;
function measure(audio) {
  if (!audio || typeof audio.captureStream !== 'function') return;
  try {
    meter ||= (() => { const context = new (window.AudioContext || window.webkitAudioContext)(), analyser = context.createAnalyser(); analyser.fftSize = 512; return { context, analyser, data: new Float32Array(analyser.fftSize), source: null }; })();
    const stream = audio.captureStream(); if (!stream.getAudioTracks().length) return;
    meter.source?.disconnect(); meter.source = meter.context.createMediaStreamSource(stream); meter.source.connect(meter.analyser);
  } catch { /* the made-up rhythm stands in */ }
}
const rhythm = () => 0.18 + 0.12 * Math.abs(Math.sin(performance.now() / 160));
export function outputLevel() {
  if (live.pending && meter?.source) {
    if (meter.context.state !== 'running') void meter.context.resume().catch(() => {});
    meter.analyser.getFloatTimeDomainData(meter.data); let sum = 0; for (const value of meter.data) sum += value * value;
    const level = Math.sqrt(sum / meter.data.length) * 3;
    return level > 0.01 ? Math.min(1, level) : rhythm();
  }
  if (live.pending || (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking)) return rhythm();
  return 0;
}
const fingerprint = text => String(text).toLowerCase().replace(/[^a-z0-9ក-៿가-힯]+/g, '').slice(0, 60);
const live = { runId: '', text: '', said: 0, token: 0, queue: Promise.resolve(), spoken: new Set(), spokenAt: 0, pending: 0, playing: false };
const spokenLive = text => { const print = fingerprint(text); return print.length > 8 && live.spoken.has(print); };
// What is read: code is said as "code", a block still open is not read yet, links and markdown marks are dropped.
function sayable(raw) {
  let text = String(raw).replace(/```[\s\S]*?```/g, ' (code) ');
  const open = text.indexOf('```'); if (open >= 0) text = text.slice(0, open);
  return text;
}
const cleanPhrase = phrase => phrase.replace(/`[^`]*`/g, match => (match.length > 40 ? ' (code) ' : match.slice(1, -1))).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/https?:\/\/\S+/g, 'a link').replace(/(\*{1,3}|_{1,3})([^*_\n]+?)\1/g, '$2').replace(/[*#>|]+/g, ' ').replace(/\s+/g, ' ').trim();
// The end of the last whole phrase in what is not said yet: a sentence end or a line break, or a comma once enough is waiting.
function phraseEnd(pending, finished) {
  if (finished) return pending.length;
  let end = -1;
  for (const match of pending.matchAll(/[.!?。…](?=\s)|\n/g)) end = match.index + 1;
  if (end < 0 && pending.length > 90) for (const match of pending.matchAll(/[,;:](?=\s)/g)) if (match.index > 30) end = match.index + 1;
  return end;
}
// notBefore: a time (performance.now()) the phrase must not start before; its sound is still fetched at once, so it is
// ready the moment it is due (the welcome waits for the body's opening this way).
function sayPhrase(phrase, token, notBefore = 0) {
  const text = cleanPhrase(phrase); if (!/[\p{L}\p{N}]/u.test(text)) return;
  const lang = language(text), chosen = chosenVoice(lang);
  const due = () => (notBefore > performance.now() ? new Promise(resolve => setTimeout(resolve, notBefore - performance.now())) : null);
  if (chosen && !/Neural$/.test(chosen)) {
    // The computer's own voice queues phrases by itself.
    void Promise.all([voiceFor(lang), due()]).then(([voice]) => { if (token !== live.token) return; const utterance = new SpeechSynthesisUtterance(text); utterance.lang = voice?.lang || { en: 'en-US', ko: 'ko-KR', km: 'km-KH' }[lang]; if (voice) utterance.voice = voice; utterance.rate = 1.05; speechSynthesis.speak(utterance); });
    return;
  }
  // The neural voice: each phrase is fetched at once, and played in order as soon as the one before it ends.
  // A voice that has not come back in 15 seconds is given up (the computer's own voice says it), so nothing waits for ever.
  const sound = fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify({ text, lang, voice: chosen }), signal: AbortSignal.timeout?.(15000) })
    .then(response => (response.ok ? response.blob() : null)).then(blob => (blob ? URL.createObjectURL(blob) : null)).catch(() => null);
  live.pending += 1;
  live.queue = live.queue.then(async () => {
    await due();
    const url = await sound; if (token !== live.token) { if (url) URL.revokeObjectURL(url); return; }
    // The online voice did not answer (no network, the service down): this computer's own voice says it instead of silence.
    if (!url) { await sayHere(text, lang, token); return; }
    player ||= new Audio(); const audio = player; audio.src = url;
    const played = await new Promise(resolve => {
      audio.onended = () => { live.playing = false; resolve(true); }; audio.onerror = () => { live.playing = false; resolve(false); };
      audio.onplaying = () => { live.playing = true; measure(audio); };
      audio.play().catch(() => { live.playing = false; resolve(false); });
    });
    URL.revokeObjectURL(url);
    if (!played && token === live.token) await sayHere(text, lang, token);
  }).finally(() => { live.pending = Math.max(0, live.pending - 1); });
}
// Sound is coming out right now (not only waiting to be made): what the body's "Speaking" means.
export const speechPlaying = () => live.playing || (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking);
// One phrase in this computer's own voice, resolved when it has been said.
async function sayHere(text, lang, token) {
  if (typeof speechSynthesis === 'undefined' || token !== live.token) return;
  const voice = await voiceFor(lang);
  await new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text); utterance.lang = voice?.lang || { en: 'en-US', ko: 'ko-KR', km: 'km-KH' }[lang]; if (voice) utterance.voice = voice; utterance.rate = 1.05;
    utterance.onend = resolve; utterance.onerror = resolve; speechSynthesis.speak(utterance); setTimeout(resolve, 20000);
  });
}
// While the agent works instead of talking, Voice mode says so in a few words ("Let me look at the files."), at most one
// line every few seconds and never the same line twice in a row, so the person is not left in silence.
function toolWords(tool, input = {}) {
  // Rex says itself that it is on it; starting a job or acting for the person needs no extra words.
  if (/^desk_(background|agent_say|room_say|room_create|rooms_all|room_manage)$/.test(tool)) return '';
  if (/^(Read|Glob|Grep|LS|NotebookRead|view_file|read_file|list_dir|grep_search|find_by_name)$/.test(tool)) return 'Let me look at the files.';
  if (/^(Bash|PowerShell|run_command)$/.test(tool)) return input.description && input.description.length < 70 ? `${input.description.replace(/\.$/, '')}.` : 'Running a command.';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'Making the change now.';
  if (/^(WebSearch|search_web)$/.test(tool)) return 'Searching the web.';
  if (/^(WebFetch|read_url_content)$/.test(tool)) return 'Reading a web page.';
  if (/^(Agent|Task)$/.test(tool)) return 'Working on it.';
  if (/^desk_(specialists|rooms|room_read|tasks|task|progress)/.test(tool)) return 'Checking on the agents.';
  if (/^desk_memory/.test(tool)) return 'Checking my notes.';
  if (/browser|playwright|screenshot/i.test(tool)) return 'Looking at it in the browser.';
  return 'One moment, I am working on it.';
}
const told = { at: 0, last: '' };
function sayTool(tool, input) {
  const line = toolWords(tool, input), now = Date.now(); if (!line) return;
  if (line === told.last && now - told.at < 30000) return;
  if (now - told.at < 6000 || live.pending > 1) return;
  told.at = now; told.last = line; sayPhrase(line, live.token);
}
export function speakLive({ runId, text = '', done = false, tool = '', input = {} }, key, openRunId) {
  if (!runId || runId !== openRunId || !voiceModeOn(key)) return;
  if (tool) { sayTool(tool, input); return; }
  const said = sayable(text);
  // A new block (the agent wrote, used a tool, and writes again) starts over.
  if (runId !== live.runId || !said.startsWith(live.text.slice(0, live.said))) { live.runId = runId; live.said = 0; }
  live.text = said;
  const pending = said.slice(live.said), end = phraseEnd(pending, done);
  if (end > 0) { sayPhrase(pending.slice(0, end), live.token); live.said += end; live.spokenAt = Date.now(); }
  if (done) { live.spoken.add(fingerprint(cleanPhrase(text))); if (live.spoken.size > 50) live.spoken.delete(live.spoken.values().next().value); live.said = 0; live.text = ''; }
}
// Voice mode's welcome, said by Rex Desk itself (no AI, so no wait) the moment the body has formed: its sound is fetched
// now, during the opening, and played at `at`. The agent meanwhile reads its report quietly.
export function welcome(text, at) { sayPhrase(text, live.token, at); }
// Stops live speech (read-aloud turned off, another chat opened).
export function stopLive() { live.token += 1; live.queue = Promise.resolve(); live.pending = 0; live.playing = false; live.said = 0; live.text = ''; live.runId = ''; try { speechSynthesis.cancel(); } catch { /* no voices */ } if (player) { try { player.pause(); } catch { /* not playing */ } } }
export const readAloudButton = key => { const on = readAloudOn(key); return `<button type="button" class="icon-btn read-aloud${on ? ' on' : ''}" data-action="read-aloud" aria-pressed="${on}" title="${on ? 'Replies are read aloud. Press to stop' : 'Read replies aloud'}" aria-label="Read replies aloud">${SPEAKER}</button>`; };
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
  // Opening another chat starts fresh there: replies it already had are not read out.
  window.addEventListener('hashchange', () => { heard.clear(); reading = Promise.resolve(); stopLive(); });
}

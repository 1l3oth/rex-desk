import { openMicrophone, startRecorder, transcribe } from './recorder.js';

// The Jev bar: a small window that opens over any app (Ctrl+Alt+J), listens, does the command, and closes itself.
const $ = selector => document.querySelector(selector);
const form = $('#jev-form'), input = $('#jev-text'), mic = $('#jev-mic'), languageSelect = $('#jev-language');
const statusLine = $('#jev-status'), result = $('#jev-result'), meter = $('#jev-meter i');
const params = new URLSearchParams(location.search);
const state = { ready: false, voice: false, recording: null, busy: false, closeTimer: 0, pending: null };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const recall = key => { try { return localStorage.getItem(key); } catch { return null; } };

async function api(endpoint, { method = 'GET', data } = {}) {
  const response = await fetch(`/api${endpoint}`, { method, headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status, signIn: value.signIn });
  return value;
}
function status(text, tone = '') { statusLine.textContent = text; statusLine.className = `jev-status ${tone}`; }
function phase(name) { document.body.dataset.phase = name; mic.classList.toggle('recording', name === 'listening'); }
const language = () => languageSelect.value;

// Closes by itself a few seconds after a command worked, unless the person starts using the window.
function closeSoon(ms = 4000) { clearTimeout(state.closeTimer); state.closeTimer = setTimeout(() => window.close(), ms); }
const stay = () => clearTimeout(state.closeTimer);
for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, stay, { capture: true });

async function listen() {
  if (state.recording || state.busy) return;
  if (!state.voice) { status('Voice is not installed yet. Install it in Rex Desk → Settings → Jev and voice, or type below.', 'warn'); input.focus(); return; }
  void api(`/voice/prepare?language=${language()}`, { method: 'POST' }).catch(() => {});
  let stream;
  try { stream = await openMicrophone(); }
  catch { status('Jev could not use the microphone. Allow it for this window, then press the microphone again.', 'error'); return; }
  result.innerHTML = '';
  state.recording = startRecorder(stream, { onQuiet: () => void stopListening(), onLevel: level => { meter.style.width = `${Math.min(100, level * 900)}%`; } });
  phase('listening'); status('Listening… speak now. Jev sends when you stop talking.');
}
async function stopListening() {
  const recording = state.recording;
  if (!recording) return;
  state.recording = null; recording.stop(); meter.style.width = '0';
  if (!recording.heard) { phase('idle'); status('Nothing was heard. Press the microphone or type instead.', 'warn'); input.focus(); return; }
  phase('thinking'); status('Turning your words into text on this computer…');
  const slow = setTimeout(() => status('Loading the voice model from disk. The first command after a restart can take a minute or two; after that it answers in about a second.'), 4000);
  try {
    const heard = await transcribe(recording.wav(), language()).finally(() => clearTimeout(slow));
    input.value = heard.text;
    await perform(heard.text, heard.fallback);
  } catch (error) { phase('idle'); status(error.message, 'error'); }
}

function renderResult(answer, fallback = '') {
  const steps = answer.results?.length ? answer.results : [];
  const rows = steps.map(step => `<li class="${step.ok ? 'ok' : 'failed'}"><span aria-hidden="true">${step.ok ? '✓' : '✗'}</span> ${esc(step.title)}${step.ok ? summary(step.result) : ` — ${esc(step.error)}`}</li>`).join('');
  const confirm = answer.needsConfirm?.length ? `<div class="jev-confirm"><p>Do this? <strong>${esc(answer.needsConfirm.join(', '))}</strong></p>
    <button type="button" class="button primary" data-confirm="yes">Yes, do it</button> <button type="button" class="button" data-confirm="no">Cancel</button></div>` : '';
  result.innerHTML = `${answer.say ? `<p class="jev-say">${esc(answer.say)}</p>` : ''}${rows ? `<ul class="jev-steps">${rows}</ul>` : ''}${confirm}${fallback ? `<p class="jev-note">${esc(fallback)}</p>` : ''}`;
  if (confirm) result.querySelector('[data-confirm="yes"]').focus();
}
// A short reading of what came back (volume level, battery, and so on), when the action returns one.
function summary(value) {
  if (!value || typeof value !== 'object') return '';
  const parts = [];
  if (value.level !== undefined) parts.push(`${value.level}%${value.muted ? ', muted' : ''}`);
  if (value.percent !== undefined) parts.push(`${value.percent}%${value.charging ? ', charging' : ''}`);
  if (value.text && typeof value.text === 'string') parts.push(value.text.slice(0, 120));
  return parts.length ? ` <span class="muted">· ${esc(parts.join(' · '))}</span>` : '';
}

async function perform(text, fallback = '') {
  const command = String(text || '').trim();
  if (!command || state.busy) return;
  state.busy = true; phase('thinking'); status('Jev is working out what to do…'); result.innerHTML = '';
  const started = performance.now();
  try {
    const answer = await api('/computer/do', { method: 'POST', data: { text: command } });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    renderResult(answer, fallback);
    if (answer.needsConfirm?.length) { state.pending = answer.steps; phase('confirm'); status('This one needs your yes first.', 'warn'); }
    else if (!answer.steps?.length) { phase('idle'); status('Jev did not find a computer action for that. Try other words.', 'warn'); }
    else if (answer.done) { phase('done'); status(`Done in ${seconds} s.`, 'good'); input.value = ''; if (params.has('auto')) closeSoon(); }
    else { phase('idle'); status('Something did not work.', 'error'); }
  } catch (error) { phase('idle'); status(error.message, 'error'); }
  finally { state.busy = false; }
}
async function confirm(yes) {
  const steps = state.pending; state.pending = null;
  if (!yes || !steps) { phase('idle'); status('Cancelled.'); result.innerHTML = ''; input.focus(); return; }
  state.busy = true; phase('thinking'); status('Running…');
  try {
    const answer = await api('/computer/run', { method: 'POST', data: { steps } });
    renderResult(answer); phase(answer.done ? 'done' : 'idle'); status(answer.done ? 'Done.' : 'Something did not work.', answer.done ? 'good' : 'error');
    if (answer.done && params.has('auto')) closeSoon();
  } catch (error) { phase('idle'); status(error.message, 'error'); }
  finally { state.busy = false; }
}

form.addEventListener('submit', event => { event.preventDefault(); void perform(input.value); });
mic.addEventListener('click', () => void (state.recording ? stopListening() : listen()));
$('#jev-close').addEventListener('click', () => window.close());
languageSelect.addEventListener('change', () => { remember('jev-language', language()); if (state.voice) void api(`/voice/prepare?language=${language()}`, { method: 'POST' }).catch(() => {}); });
result.addEventListener('click', event => { const button = event.target.closest('[data-confirm]'); if (button) void confirm(button.dataset.confirm === 'yes'); });
addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); if (state.recording) { state.recording.stop(); state.recording = null; phase('idle'); status('Stopped listening.'); } else window.close(); return; }
  if (event.key === ' ' && document.activeElement === input && !input.value) { event.preventDefault(); void (state.recording ? stopListening() : listen()); }
});

async function start() {
  phase('idle');
  try {
    const auth = await api('/auth');
    if (auth.mode === 'accounts' && !auth.current) {
      status('Sign in to Rex Desk once and tick “Stay signed in”. After that Jev works from any app.', 'warn');
      result.innerHTML = '<p><a class="button primary" href="/" target="_blank" rel="noopener">Open Rex Desk to sign in</a></p>'; return;
    }
    const computer = await api('/computer');
    if (computer.control?.enabled === false) { status('Computer control is off. Turn it on in Rex Desk → Settings → Jev and voice.', 'warn'); return; }
    languageSelect.value = recall('jev-language') || computer.control?.language || 'en';
    state.voice = Boolean(computer.voice?.installed); state.ready = true;
    status(state.voice ? 'Press the microphone or type a command.' : 'Type a command. Voice can be installed in Rex Desk → Settings → Jev and voice.');
    if (params.has('text')) { input.value = params.get('text'); void perform(input.value); }
    else if (params.has('listen') && state.voice) void listen();
    else input.focus();
  } catch (error) {
    status(error.signIn ? 'Sign in to Rex Desk once and tick “Stay signed in”. After that Jev works from any app.' : `Rex Desk is not answering: ${error.message}`, 'error');
  }
}
void start();

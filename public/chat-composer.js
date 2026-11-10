// The chat input: a rounded box with a + menu, slash commands, @ mentions, voice, attachments, and the model, effort and mode pickers underneath.
const ICON = {
  plus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
};
import { pickerHtml } from '/chat-pick.js';
import { openMicrophone, startRecorder, transcribe } from '/recorder.js';
const KEY = 'rex-desk-input';
const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const EFFORT_HINT = { low: 'Fast, light thinking', medium: 'Balanced', high: 'Thinks longer', xhigh: 'Thinks a lot longer', max: 'Longest thinking, slowest' };
const MODE_HINT = { bypassPermissions: 'Runs tools without asking', manual: 'Asks you for each tool, in the chat', auto: 'A checker decides what is safe', plan: 'Plans only, runs nothing', acceptEdits: 'Edits files freely, asks for the rest' };
const DEFAULT_MODE = 'bypassPermissions';

function saved() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
function remember(patch) { try { localStorage.setItem(KEY, JSON.stringify({ ...saved(), ...patch })); } catch { /* private window */ } }

// What the pickers show: the run's own choice when it has one, else what the person last picked, else the defaults.
export function currentOptions(ctx) {
  const { ui } = ctx, choices = ui.snap?.choices || { models: [], efforts: [], modes: [] }, run = ui.view.type === 'main' ? ctx.mainRun() : ui.view.type === 'run' ? ctx.runById(ui.view.id) : null, last = saved();
  const configured = ui.snap?.config?.models?.claude;
  // Only a model that is on the current list is shown and sent; anything else falls back to the first one (the recommended default).
  const ids = choices.models.map(item => item.id), model = [run?.model, last.model, configured].find(value => value && ids.includes(value)) || ids[0] || '';
  return { model, effort: run?.effort || last.effort || 'medium', permissionMode: run?.permissionMode || last.permissionMode || DEFAULT_MODE };
}
export function pickedOptions(ctx) {
  const read = id => document.getElementById(id)?.value || '';
  return { model: read('opt-model') || undefined, effort: read('opt-effort') || undefined, permissionMode: read('opt-mode') || undefined };
}

export function composerHtml(ctx, model) {
  const { ui, esc } = ctx, choices = ui.snap?.choices || { models: [], efforts: [], modes: [] }, now = currentOptions(ctx), working = Boolean(model.working);
  const select = (id, label, items, value) => pickerHtml(ctx, { id, label, compact: true, value, items: items.map(item => ({ value: item.id, label: item.label, hint: item.hint })) });
  const modes = choices.modes.map(item => ({ ...item, label: item.id === 'bypassPermissions' ? 'Dangerous' : item.label, hint: MODE_HINT[item.id] }));
  return `<div class="composer" id="composer"><div class="composer-inner">
    <div class="attach-chips" id="attach-chips"></div>
    <div class="box2"><div id="menu"></div>
      <button class="icon-btn" data-action="plus" aria-label="Add" title="Add">${ICON.plus}</button>
      <textarea id="draft" rows="1" placeholder="${esc(model.composer.placeholder)}">${esc(ui.drafts.get(ctx.draftKey()) || '')}</textarea>
      ${navigator.mediaDevices?.getUserMedia ? `<button class="icon-btn" data-action="mic" aria-label="Dictate" title="Dictate: click, or hold Space (Khmer, English or Korean, on this computer)">${ICON.mic}</button>` : ''}
      <button class="send-btn" data-action="send" aria-label="Send" title="Send">${ICON.up}</button>
      <input type="file" id="file-input" multiple hidden>
    </div>
    <div class="foot"><span class="hint">Type / for commands · hold Space to talk${model.composer.mentions?.length ? ' · @ to mention · # for a task' : ''}</span><span class="spacer"></span>
      ${model.composer.noPickers ? '' : `${select('opt-model', 'Model', choices.models, now.model)}${select('opt-effort', 'Effort', choices.efforts.map(id => ({ id, label: EFFORT_LABEL[id] || id, hint: EFFORT_HINT[id] })), now.effort)}${select('opt-mode', 'Mode', modes, now.permissionMode)}
      <span class="ring ${working ? 'busy' : ''}" title="${working ? 'The agent is working' : 'Idle'}" aria-hidden="true"></span>`}</div>
  </div></div>`;
}

// ---------- attachments ----------
function drawChips(ctx) {
  const host = document.getElementById('attach-chips'); if (!host) return;
  host.innerHTML = ctx.ui.attachments.map((file, index) => `<span class="attach ${file.error ? 'bad' : ''}">${ICON.file}<span class="nm">${ctx.esc(file.name)}</span>${file.path ? '' : '<span class="sp"></span>'}<button type="button" data-remove-attach="${index}" aria-label="Remove">×</button></span>`).join('');
}
async function upload(ctx, file) {
  const entry = { name: file.name || 'pasted-file', path: '' }; ctx.ui.attachments.push(entry); drawChips(ctx);
  try {
    const response = await fetch(`/api/uploads?name=${encodeURIComponent(entry.name)}`, { method: 'POST', headers: { 'x-rex-desk': '1' }, body: file });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Upload failed.');
    entry.path = body.path; entry.name = body.name;
  } catch (error) { ctx.ui.attachments.splice(ctx.ui.attachments.indexOf(entry), 1); ctx.toast(error.message, true); }
  drawChips(ctx);
}
export const attachmentText = ctx => {
  const ready = ctx.ui.attachments.filter(file => file.path);
  return ready.length ? `\n\nAttached files (read them from these paths):\n${ready.map(file => `- ${file.path}`).join('\n')}` : '';
};

// ---------- menus: slash commands and @ mentions share one list ----------
function commands(ctx) {
  const { ui } = ctx, c = ctx.commands;
  return [
    { name: 'sync', hint: 'Sync issues from the tracker', run: c.sync },
    { name: 'projects', hint: 'Scan this computer for projects', run: c.projects },
    { name: 'room', hint: 'Start a room for several agents', run: c.room },
    { name: 'agent', hint: 'Create an agent for a project', run: c.agent },
    ...(ui.view.type === 'room' ? [{ name: 'assign', hint: 'Give a task to an agent: /assign @agent #task', run: c.assign }] : []),
    { name: 'main', hint: 'Go to Rex Agent', run: c.main },
    ...(ui.view.type === 'main' || ui.view.type === 'run' ? [{ name: 'stop', hint: 'Stop the agent', run: c.stop }] : []),
    { name: 'settings', hint: 'Open issues and settings', run: c.settings },
  ];
}
function drawMenu(ctx) {
  const host = document.getElementById('menu'); if (!host) return;
  const menu = ctx.ui.menu;
  host.innerHTML = menu ? `<div class="menu" role="listbox">${menu.items.map((item, index) => `<button type="button" role="option" class="${index === menu.index ? 'on' : ''}" data-menu="${index}"><strong>${menu.kind === 'slash' ? '/' : menu.kind === 'task' ? '#' : item.plain ? '' : '@'}${ctx.esc(item.name)}</strong>${item.hint ? `<small>${ctx.esc(item.hint)}</small>` : ''}</button>`).join('')}</div>` : '';
}
function closeMenu(ctx) { ctx.ui.menu = null; drawMenu(ctx); }
function choose(ctx, item) {
  const menu = ctx.ui.menu, box = document.getElementById('draft'); if (!menu || !item) return;
  if (menu.kind === 'slash') { box.value = ''; ctx.ui.drafts.set(ctx.draftKey(), ''); closeMenu(ctx); void item.run?.(); return; }
  const end = box.selectionStart;
  box.value = `${box.value.slice(0, menu.from)}${menu.kind === 'task' ? '#' : '@'}${item.name} ${box.value.slice(end)}`; ctx.ui.drafts.set(ctx.draftKey(), box.value); closeMenu(ctx); box.focus();
}
function menuItems(ctx, box) {
  const before = box.value.slice(0, box.selectionStart);
  const slash = /^\/([\w-]*)$/.exec(before);
  if (slash) { const items = commands(ctx).filter(item => item.name.startsWith(slash[1].toLowerCase())); return items.length ? { kind: 'slash', items, index: 0, from: 0 } : null; }
  const room = ctx.ui.view.type === 'room' ? ctx.ui.snap.rooms.find(item => item.id === ctx.ui.view.id) : null;
  const at = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(before);
  if (at) {
    const agentsHere = room ? room.members.filter(member => member.id !== 'you').length : 0;
    const items = (room ? [...(agentsHere > 1 ? [{ name: 'all', hint: `Everyone in this room (${agentsHere} agents)` }] : []), ...room.members.map(member => ({ name: member.handle, hint: `${member.name} · ${member.project} · ${member.label}` }))] : (ctx.ui.mentions || []).map(name => ({ name }))).filter(item => item.name && item.name.toLowerCase().startsWith(at[2].toLowerCase()));
    return items.length ? { kind: 'mention', items, index: 0, from: before.length - at[2].length - 1 } : null;
  }
  const hash = /(^|\s)#(\d*)$/.exec(before);
  if (hash && room) {
    const items = (ctx.ui.snap.tasks || []).filter(task => task.active && !task.demo).filter(task => String(task.taskNumber || task.externalId).startsWith(hash[2])).slice(0, 8).map(task => ({ name: String(task.taskNumber || task.externalId), hint: task.titleEn || task.title }));
    return items.length ? { kind: 'task', items, index: 0, from: before.length - hash[2].length - 1 } : null;
  }
  return null;
}

// ---------- voice ----------
// Dictation uses Rex Desk's own speech model on this computer (the same one as Jev), not the browser's online service,
// which does not work inside the desktop app. Recording stops by itself when you stop talking; press the mic again to stop sooner.
let listening = null, transcribing = false;
const micButton = () => document.querySelector('[data-action="mic"]');
const voiceLanguage = ctx => { try { return localStorage.getItem('jev-language') || ctx.ui.snap?.config?.control?.language || 'en'; } catch { return ctx.ui.snap?.config?.control?.language || 'en'; } };
async function finishMic(ctx) {
  const recording = listening; if (!recording) return;
  listening = null; recording.stop(); micButton()?.classList.remove('rec');
  if (!recording.heard) { ctx.toast('Nothing was heard. Hold Space (or press the mic) and speak.', true); return; }
  transcribing = true; micButton()?.classList.add('busy');
  const slow = setTimeout(() => ctx.toast('Loading the voice model. The first time after a restart takes a minute or two.'), 4000);
  try {
    const heard = await transcribe(recording.wav(), voiceLanguage(ctx)), box = document.getElementById('draft');
    if (box) { box.value = (box.value.trim() ? `${box.value.trim()} ` : '') + heard.text; ctx.ui.drafts.set(ctx.draftKey(), box.value); box.focus(); box.dispatchEvent(new Event('input', { bubbles: true })); }
  } catch (error) {
    ctx.toast(/not installed|install/i.test(error.message) ? 'Voice is not installed yet. Install it in Issues & settings → Computer control.' : `Voice input: ${error.message}`, true);
  } finally { clearTimeout(slow); transcribing = false; micButton()?.classList.remove('busy'); }
}
async function toggleMic(ctx) {
  if (transcribing) return;
  if (listening) return finishMic(ctx);
  void fetch(`/api/voice/prepare?language=${voiceLanguage(ctx)}`, { method: 'POST', headers: { 'x-rex-desk': '1' } }).catch(() => {});
  let stream;
  try { stream = await openMicrophone(); } catch { ctx.toast('Rex Desk could not use the microphone. Allow it, then press the mic again.', true); return; }
  listening = startRecorder(stream, { onQuiet: () => void finishMic(ctx) });
  micButton()?.classList.add('rec');
}

// Hold Space to talk: past a short hold it listens until Space is let go, then the words land in the message box.
// A quick tap still types a space. It works in the message box, or anywhere that is not another text field.
const HOLD_MS = 320;
const hold = { timer: 0, active: false, pending: false, releasedEarly: false };
const holdable = target => target?.id === 'draft' || !(target?.closest?.('input,textarea,select,[contenteditable="true"],.dialog,.dialog-back'));
async function startHold(ctx) {
  if (listening || transcribing) return;
  hold.active = true; hold.pending = true;
  void fetch(`/api/voice/prepare?language=${voiceLanguage(ctx)}`, { method: 'POST', headers: { 'x-rex-desk': '1' } }).catch(() => {});
  let stream;
  try { stream = await openMicrophone(); } catch { hold.active = hold.pending = false; ctx.toast('Rex Desk could not use the microphone. Allow it, then try again.', true); return; }
  // While Space is held, quiet does not end the recording; only letting go does (or a minute at most).
  const recording = startRecorder(stream, { onQuiet: () => { if (performance.now() - recording.started > 60000) void finishMic(ctx); } });
  listening = recording; hold.pending = false;
  micButton()?.classList.add('rec'); document.body.classList.add('ptt');
  if (hold.releasedEarly) { hold.releasedEarly = false; hold.active = false; document.body.classList.remove('ptt'); void finishMic(ctx); }
}
function insertSpace(box) {
  const start = box.selectionStart ?? box.value.length, end = box.selectionEnd ?? start;
  box.value = `${box.value.slice(0, start)} ${box.value.slice(end)}`; box.selectionStart = box.selectionEnd = start + 1;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}
function initPushToTalk(ctx) {
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || !holdable(event.target) || ctx.ui.menu) return;
    if (event.repeat || hold.timer || hold.active) { event.preventDefault(); return; }
    if (!micButton() || transcribing) return;
    event.preventDefault();
    hold.timer = setTimeout(() => { hold.timer = 0; void startHold(ctx); }, HOLD_MS);
  });
  document.addEventListener('keyup', event => {
    if (event.code !== 'Space') return;
    if (hold.timer) {
      // Let go before the hold time: it was a normal space.
      clearTimeout(hold.timer); hold.timer = 0;
      if (event.target.id === 'draft') insertSpace(event.target);
      return;
    }
    if (!hold.active) return;
    event.preventDefault();
    if (hold.pending) { hold.releasedEarly = true; return; }
    hold.active = false; document.body.classList.remove('ptt'); void finishMic(ctx);
  });
  // Leaving the window while holding stops listening, so the microphone never stays on.
  window.addEventListener('blur', () => { if (hold.timer) { clearTimeout(hold.timer); hold.timer = 0; } if (hold.active && !hold.pending) { hold.active = false; document.body.classList.remove('ptt'); void finishMic(ctx); } });
}

// ---------- wiring ----------
export function initComposer(ctx) {
  initPushToTalk(ctx);
  document.addEventListener('click', event => {
    const chip = event.target.closest('[data-remove-attach]');
    if (chip) { ctx.ui.attachments.splice(Number(chip.dataset.removeAttach), 1); drawChips(ctx); return; }
    const entry = event.target.closest('[data-menu]');
    if (entry && ctx.ui.menu) { choose(ctx, ctx.ui.menu.items[Number(entry.dataset.menu)]); return; }
    const button = event.target.closest('[data-action="plus"],[data-action="mic"]');
    if (!button) { if (ctx.ui.menu && !event.target.closest('.box2')) closeMenu(ctx); return; }
    if (button.dataset.action === 'mic') return toggleMic(ctx);
    const items = [
      { name: 'Attach a file or image', plain: true, hint: '', run: () => document.getElementById('file-input').click() },
      { name: 'Start a room', plain: true, run: ctx.commands.room }, { name: 'Create an agent', plain: true, run: ctx.commands.agent }, { name: 'Scan for projects', plain: true, run: ctx.commands.projects },
    ];
    ctx.ui.menu = { kind: 'slash', items, index: 0, from: 0 }; drawMenu(ctx);
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'file-input') { for (const file of event.target.files) void upload(ctx, file); event.target.value = ''; return; }
    if (event.target.id === 'opt-model') remember({ model: event.target.value });
    if (event.target.id === 'opt-effort') remember({ effort: event.target.value });
    if (event.target.id === 'opt-mode') { remember({ permissionMode: event.target.value }); if (event.target.value === 'bypassPermissions') ctx.toast('Dangerous: the agent runs tools without asking.'); }
  });
  document.addEventListener('keydown', event => {
    if (event.target.id !== 'draft') return;
    const menu = ctx.ui.menu;
    if (menu && ['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Escape') return closeMenu(ctx);
      if (event.key === 'Tab') return choose(ctx, menu.items[menu.index]);
      menu.index = (menu.index + (event.key === 'ArrowDown' ? 1 : -1) + menu.items.length) % menu.items.length; return drawMenu(ctx);
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (menu) return choose(ctx, menu.items[menu.index]); void ctx.send(); }
  });
  document.addEventListener('input', event => {
    if (event.target.id !== 'draft') return;
    const box = event.target; ctx.ui.drafts.set(ctx.draftKey(), box.value); box.style.height = 'auto'; box.style.height = `${Math.min(200, box.scrollHeight)}px`;
    ctx.ui.menu = menuItems(ctx, box); drawMenu(ctx);
  });
  document.addEventListener('paste', event => {
    if (event.target.id !== 'draft') return;
    const files = [...(event.clipboardData?.files || [])]; if (!files.length) return;
    event.preventDefault(); for (const file of files) void upload(ctx, file);
  });
  document.addEventListener('dragover', event => { if (event.target.closest?.('#composer')) event.preventDefault(); });
  document.addEventListener('drop', event => {
    if (!event.target.closest?.('#composer')) return;
    event.preventDefault(); for (const file of event.dataTransfer?.files || []) void upload(ctx, file);
  });
}
export const redrawAttachments = drawChips;

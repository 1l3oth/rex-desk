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
// The AI a chat runs on: the one picked for it here, else the run's own, else the default in Settings.
function providerOf(ctx, run) { const picked = ctx.ui.providerPick?.[ctx.draftKey()]; return picked || run?.provider || ctx.ui.snap?.config?.provider || 'claude'; }
function choicesFor(ctx, provider) { const all = ctx.ui.snap?.choices || { models: [], efforts: [], modes: [] }; return all.providers?.[provider] || all; }
export function currentOptions(ctx) {
  const { ui } = ctx, run = ui.view.type === 'main' ? ctx.mainRun() : ui.view.type === 'run' ? ctx.runById(ui.view.id) : null, last = saved(), provider = providerOf(ctx, run), choices = choicesFor(ctx, provider);
  const configured = ui.snap?.config?.models?.[provider];
  // Only a model that is on the current list is shown and sent; anything else falls back to the first one (the recommended default).
  const ids = choices.models.filter(item => !item.disabled).map(item => item.id), model = [run?.model, last.model, configured].find(value => value && ids.includes(value)) || ids[0] || '';
  const modeIds = choices.modes.map(item => item.id), mode = [run?.permissionMode, last.permissionMode, DEFAULT_MODE].find(value => value && modeIds.includes(value)) || modeIds[0];
  const effort = [run?.effort, last.effort, 'medium'].find(value => value && choices.efforts.includes(value)) || choices.efforts[0];
  return { provider, model, effort, permissionMode: mode };
}
export function pickedOptions(ctx) {
  const read = id => document.getElementById(id)?.value || '';
  return { provider: read('opt-provider') || undefined, model: read('opt-model') || undefined, effort: read('opt-effort') || undefined, permissionMode: read('opt-mode') || undefined };
}

// The AI, model, effort and mode pickers under the message box, for the AI picked now.
function optionPickers(ctx) {
  const now = currentOptions(ctx), choices = choicesFor(ctx, now.provider);
  const select = (id, label, items, value) => pickerHtml(ctx, { id, label, compact: true, value, items: items.map(item => ({ value: item.id, label: item.label, hint: item.hint, disabled: item.disabled })) });
  const modes = choices.modes.map(item => ({ ...item, label: item.id === 'bypassPermissions' ? 'Dangerous' : item.label, hint: item.hint || MODE_HINT[item.id] }));
  return `${select('opt-provider', 'AI', [{ id: 'claude', label: 'Claude Code', hint: 'Your Claude subscription' }, { id: 'codex', label: 'Codex', hint: 'Your ChatGPT subscription' }, { id: 'gemini', label: 'Gemini', hint: 'Your Google account, through Antigravity' }], now.provider)}${select('opt-model', 'Model', choices.models, now.model)}${select('opt-effort', 'Effort', choices.efforts.map(id => ({ id, label: EFFORT_LABEL[id] || id, hint: EFFORT_HINT[id] })), now.effort)}${select('opt-mode', 'Mode', modes, now.permissionMode)}`;
}
// The message box is not redrawn while the chat updates (it would lose what is typed), so a new AI redraws only its pickers.
function redrawOptionPickers(ctx) {
  const ids = ['opt-model', 'opt-effort', 'opt-mode'];
  if (ctx.ui.picks) for (const id of ids) delete ctx.ui.picks[id];
  const fresh = document.createElement('div'); fresh.innerHTML = optionPickers(ctx);
  for (const id of ids) { const old = document.querySelector(`.composer [data-pick="${id}"]`), next = fresh.querySelector(`[data-pick="${id}"]`); if (old && next) old.replaceWith(next); }
}
export function composerHtml(ctx, model) {
  const { ui, esc } = ctx, working = Boolean(model.working);
  return `<div class="composer" id="composer"><div class="composer-inner">
    <div class="attach-chips" id="attach-chips"></div>
    <div class="box2"><div id="menu"></div>
      <button class="icon-btn" data-action="plus" aria-label="Add" title="Add">${ICON.plus}</button>
      <textarea id="draft" rows="1" placeholder="${esc(model.composer.placeholder)}">${esc(ui.drafts.get(ctx.draftKey()) || '')}</textarea>
      ${navigator.mediaDevices?.getUserMedia ? `<button class="icon-btn" data-action="mic" aria-label="Dictate" title="Dictate: click, or hold Space (Khmer, English or Korean, on this computer)">${ICON.mic}</button>` : ''}
      <button class="send-btn" data-action="send" aria-label="Send" title="Send">${ICON.up}</button>
      <input type="file" id="file-input" multiple hidden>
    </div>
    <div class="foot"><span class="hint">Type / for commands · hold Space to talk${model.composer.mentions?.length ? ' · @ to mention · # for a task' : ''}</span><span class="spacer"></span>${model.composer.foot || ''}
      ${model.composer.noPickers ? '' : `${optionPickers(ctx)}
      ${contextRing(ctx, working)}`}</div>
  </div></div>`;
}

// ---------- attachments ----------
function drawChips(ctx) {
  const host = document.getElementById('attach-chips'); if (!host) return;
  host.innerHTML = ctx.ui.attachments.map((file, index) => `<span class="attach ${file.error ? 'bad' : ''}">${ICON.file}<span class="nm">${ctx.esc(file.name)}</span>${file.path ? '' : '<span class="sp"></span>'}<button type="button" data-remove-attach="${index}" aria-label="Remove">×</button></span>`).join('');
}
// Saves a dropped or pasted file in Rex Desk and gives back where it is, without attaching it to a message.
async function store(file) {
  const response = await fetch(`/api/uploads?name=${encodeURIComponent(file.name || 'dropped-file')}`, { method: 'POST', headers: { 'x-rex-desk': '1' }, body: file });
  const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Upload failed.');
  return body;
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

// The ring by the message box: how full this chat's context is (what the agent holds in mind). Near full, /clear starts fresh.
function contextRing(ctx, working) {
  const { ui } = ctx, view = ui.view, run = view.type === 'main' ? ctx.mainRun() : view.type === 'run' ? ctx.runById(view.id) : null;
  const used = Number(run?.contextUsed || 0), window = Number(run?.contextWindow || 200000), share = Math.min(1, used / window), round = 2 * Math.PI * 7;
  const kilo = value => value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
  const title = run ? (used ? `Context: ${kilo(used)} of ${kilo(window)} (${Math.round(share * 100)}%).${share > 0.7 ? ' Getting full: /clear starts fresh with a summary.' : ''}` : 'Context: empty. It fills as you talk.') : 'Context shows in a chat with one agent.';
  return `<span class="ring ctx ${share > 0.85 ? 'full' : share > 0.6 ? 'mid' : ''} ${working ? 'busy' : ''}" title="${ctx.esc(title)}" aria-label="${ctx.esc(title)}" role="img"><svg viewBox="0 0 18 18" width="18" height="18"><circle cx="9" cy="9" r="7" class="ring-bg"/><circle cx="9" cy="9" r="7" class="ring-fill" stroke-dasharray="${(share * round).toFixed(2)} ${round.toFixed(2)}" transform="rotate(-90 9 9)"/></svg></span>`;
}

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
    ...(ui.view.type === 'main' || ui.view.type === 'run' ? [{ name: 'stop', hint: 'Stop the agent', run: c.stop }, { name: 'clear', hint: 'Fresh start: the agent gets a handoff of this chat and a clean session', run: c.clear }, { name: 'loop', hint: 'Check its own tasks now and start on one', run: c.loop }] : []),
    { name: 'voice', hint: 'Voice engine and language: compare which one understands you', run: () => voiceDialog(ctx) },
    { name: 'settings', hint: 'Open settings', run: c.settings },
    // The agent's own skills and commands, like typing / in Claude Code: choosing one puts it in the box to send to the agent.
    ...agentSlash(ctx),
  ];
}
function toolsAgent(ctx) {
  const { ui } = ctx, view = ui.view;
  if (view.type === 'main') return 'main';
  if (view.type === 'run') { const run = (ui.snap?.runs || []).find(item => item.id === view.id); return run?.specialistId || (run?.main ? 'main' : ''); }
  return '';
}
function agentSlash(ctx) {
  const id = toolsAgent(ctx); if (!id) return [];
  const tools = ctx.ui.tools?.[id];
  if (!tools) { ctx.ui.tools = ctx.ui.tools || {}; ctx.ui.tools[id] = { skills: [], commands: [], loading: true }; void ctx.api(`/agents/tools?agent=${encodeURIComponent(id)}`).then(found => { ctx.ui.tools[id] = found; }).catch(() => {}); return []; }
  const put = name => () => { const box = document.getElementById('draft'); if (!box) return; box.value = `/${name} `; ctx.ui.drafts.set(ctx.draftKey(), box.value); box.focus(); };
  return [...(tools.commands || []).map(item => ({ name: item.name, hint: `Command · ${item.description || item.source}`, run: put(item.name) })),
    ...(tools.skills || []).map(item => ({ name: item.name, hint: `Skill · ${item.description || item.source}`, run: put(item.name) }))];
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
    if (box) { ctx.ui.voiceDrafts = ctx.ui.voiceDrafts || new Set(); ctx.ui.voiceDrafts.add(ctx.draftKey()); box.value = (box.value.trim() ? `${box.value.trim()} ` : '') + heard.text; ctx.ui.drafts.set(ctx.draftKey(), box.value); box.focus(); box.dispatchEvent(new Event('input', { bubbles: true })); }
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
function initPushToTalk(ctx) {
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || !holdable(event.target) || ctx.ui.menu) return;
    if (event.repeat || hold.timer || hold.active) { event.preventDefault(); return; }
    if (!micButton() || transcribing) return;
    // In the message box the space is typed at once, so fast typing never comes out of order ("explaint he").
    // Only when Space stays down past the hold time does it become talking, and that one space is taken back out.
    const box = event.target.id === 'draft' ? event.target : null;
    if (!box) event.preventDefault();
    const at = box ? (box.selectionStart ?? box.value.length) : -1;
    hold.timer = setTimeout(() => {
      hold.timer = 0;
      if (box && box.value[at] === ' ') { box.value = `${box.value.slice(0, at)}${box.value.slice(at + 1)}`; box.selectionStart = box.selectionEnd = at; box.dispatchEvent(new Event('input', { bubbles: true })); }
      void startHold(ctx);
    }, HOLD_MS);
  });
  // Any other key while Space waits means the person is typing, not talking.
  document.addEventListener('keydown', event => { if (event.code !== 'Space' && hold.timer) { clearTimeout(hold.timer); hold.timer = 0; } }, true);
  document.addEventListener('keyup', event => {
    if (event.code !== 'Space') return;
    if (hold.timer) {
      // Let go before the hold time: it was a normal space, already typed.
      clearTimeout(hold.timer); hold.timer = 0;
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
  document.addEventListener('click', event => { if (event.target.closest?.('[data-action="st-voice"]')) { event.stopPropagation(); void voiceDialog(ctx); } }, true);
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
      { name: 'Start a room', plain: true, run: ctx.commands.room }, { name: 'Create an agent', plain: true, run: ctx.commands.agent }, { name: 'Scan for projects', plain: true, run: ctx.commands.projects }, { name: 'Voice engine and language', plain: true, run: () => voiceDialog(ctx) },
    ];
    ctx.ui.menu = { kind: 'slash', items, index: 0, from: 0 }; drawMenu(ctx);
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'file-input') { for (const file of event.target.files) void upload(ctx, file); event.target.value = ''; return; }
    // Switching the AI shows that AI's models and modes; the next message goes to it, with the chat so far handed over.
    if (event.target.id === 'opt-provider') { ctx.ui.providerPick = { ...(ctx.ui.providerPick || {}), [ctx.draftKey()]: event.target.value }; redrawOptionPickers(ctx); ctx.render(); ctx.toast(`Your next message goes to ${event.target.value === 'codex' ? 'Codex' : event.target.value === 'gemini' ? 'Gemini' : 'Claude Code'}.`); return; }
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
  // Files can be dropped anywhere: on a chat they are attached to the message, on another text box their saved path is typed in,
  // and on the file window they open there. Nothing dropped ever makes the page leave Rex Desk.
  const carriesFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  const field = target => target?.closest?.('input:not([type]),input[type="text"],input[type="url"],input[type="search"],textarea');
  let hide = 0;
  document.addEventListener('dragover', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const where = event.target.closest?.('.fw') ? 'Open in the file window' : field(event.target) && event.target.id !== 'draft' ? 'Put its path here' : document.getElementById('draft') ? 'Attach to your message' : '';
    document.body.classList.toggle('dropping-files', Boolean(where)); document.body.dataset.dropHint = where;
    clearTimeout(hide); hide = setTimeout(() => document.body.classList.remove('dropping-files'), 300);
  });
  document.addEventListener('drop', async event => {
    if (!carriesFiles(event)) return;
    event.preventDefault(); document.body.classList.remove('dropping-files');
    const files = [...(event.dataTransfer?.files || [])]; if (!files.length) return;
    const input = field(event.target);
    if (event.target.closest?.('.fw')) { for (const file of files) { try { const saved = await store(file); await window.rexOpenFile?.(saved.path); } catch (error) { ctx.toast(error.message, true); } } return; }
    if (input && input.id !== 'draft') {
      try {
        const paths = []; for (const file of files) paths.push((await store(file)).path);
        const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start, text = paths.join(input.tagName === 'TEXTAREA' ? '\n' : ' ');
        input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`; input.focus(); input.selectionStart = input.selectionEnd = start + text.length;
        input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (error) { ctx.toast(error.message, true); }
      return;
    }
    if (!document.getElementById('draft')) { ctx.toast('Open a chat to attach files.', true); return; }
    for (const file of files) void upload(ctx, file);
    document.getElementById('draft')?.focus();
  });
}
export const redrawAttachments = drawChips;

// ---------- voice engine: which speech-to-text understands the person best ----------
const ENGINE = { local: ['On this computer', 'Private and free. Weak on Khmer.'], gemini: ['Gemini (online)', 'Uses your OpenRouter key. Good with Khmer.'], elevenlabs: ['ElevenLabs Scribe (online)', 'Its own key. Strong across languages.'] };
const LANG = [['km', 'Khmer'], ['en', 'English'], ['ko', 'Korean']];
async function voiceDialog(ctx) {
  const { api, toast, esc } = ctx;
  document.querySelector('.dialog-back.voice')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back voice'; document.body.append(back);
  let info = await api('/voice/engines').catch(error => { toast(error.message, true); return null; }); if (!info) { back.remove(); return; }
  let results = null, recording = null, busy = false;
  const setLanguage = value => { try { localStorage.setItem('jev-language', value); } catch {} };
  // On-computer voice installs right here: one download (about 1.9 GB), with its progress.
  const localHint = () => {
    const local = info.local || {};
    if (local.supported === false) return 'Not available on this computer.';
    if (local.installing) { const p = local.progress; return `Downloading${p ? ` ${p.index} of ${p.total}${p.sizeMB ? `: ${Math.round(p.receivedMB)} of ${Math.round(p.sizeMB)} MB` : ''}` : ''}… You can keep working.`; }
    return `${local.error ? `Install failed: ${esc(local.error)}. ` : 'Not installed yet. '}<button type="button" class="btn small" data-v-install>Install (${local.downloadMB || 1900} MB download)</button>`;
  };
  let watching = null;
  const watchInstall = () => {
    if (watching) return;
    watching = setInterval(async () => {
      if (!back.isConnected) { clearInterval(watching); watching = null; return; }
      try { info = await api('/voice/engines'); } catch { return; }
      if (!info.local?.installing) { clearInterval(watching); watching = null; if (info.available.local) toast('Voice on this computer is installed.'); }
      draw();
    }, 2000);
  };
  if (info.local?.installing) watchInstall();
  const draw = () => {
    const language = voiceLanguage(ctx);
    back.innerHTML = `<form class="dialog vdialog"><h2>Voice</h2>
      <label>I speak<select data-v-language>${LANG.map(([value, label]) => `<option value="${value}" ${value === language ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <fieldset class="vengines"><legend>Turn speech into text with</legend>${Object.entries(ENGINE).map(([key, [label, hint]]) => `<label class="${info.available[key] ? '' : 'off'}"><input type="radio" name="engine" value="${key}" ${info.engine === key ? 'checked' : ''} ${info.available[key] ? '' : 'disabled'}><span><b>${label}</b><small>${info.available[key] ? hint : key === 'local' ? localHint() : key === 'gemini' ? 'Needs your OpenRouter key: Issues & settings → Jev priority.' : 'Paste a key below to use it.'}</small></span></label>`).join('')}</fieldset>
      <label>ElevenLabs API key<span class="vkey"><input type="password" data-v-key autocomplete="off" spellcheck="false" placeholder="${info.available.elevenlabs ? 'Saved. Paste a new key to replace it.' : 'From elevenlabs.io → Profile → API keys'}"><button type="button" class="btn small" data-v-savekey>Save key</button>${info.available.elevenlabs ? '<button type="button" class="btn small quiet danger" data-v-dropkey>Remove</button>' : ''}</span></label>
      <section class="vcompare"><h3>Which one understands you?</h3><p class="muted small">Press Record, say one sentence, then Stop. It goes through every engine that is ready, so you can pick the best. Online engines receive this recording.</p>
        <button type="button" class="btn ${recording ? 'danger' : 'primary'}" data-v-record ${busy ? 'disabled' : ''}>${recording ? 'Stop' : busy ? 'Comparing…' : 'Record a sentence'}</button>
        ${results ? `<ol class="vresults">${results.map(item => `<li><div><b>${esc(ENGINE[item.engine]?.[0] || item.engine)}</b><small>${(item.ms / 1000).toFixed(1)} s${item.model ? ` · ${esc(item.model)}` : ''}</small></div><p class="${item.error ? 'bad' : ''}">${esc(item.error || item.text || '(nothing heard)')}</p>${item.error ? '' : `<button type="button" class="btn small" data-v-use="${esc(item.engine)}">Use this one</button>`}</li>`).join('')}</ol>` : ''}
      </section>
      <div class="row"><button type="button" class="btn" data-v-close>Done</button></div></form>`;
  };
  draw();
  const choose = async engine => { try { info = { ...info, engine: (await api('/voice/engine', { method: 'POST', data: { engine } })).engine }; toast(`Voice now uses ${ENGINE[engine][0]}.`); draw(); } catch (error) { toast(error.message, true); draw(); } };
  back.addEventListener('change', event => {
    if (event.target.matches('[data-v-language]')) { setLanguage(event.target.value); results = null; draw(); }
    if (event.target.name === 'engine') void choose(event.target.value);
  });
  back.addEventListener('click', async event => {
    const target = event.target;
    if (target === back || target.closest('[data-v-close]')) { recording?.stop(); back.remove(); return; }
    const use = target.closest('[data-v-use]'); if (use) { await choose(use.dataset.vUse); return; }
    if (target.closest('[data-v-install]')) { event.preventDefault(); try { info = { ...info, local: await api('/voice/install', { method: 'POST', data: {} }) }; draw(); watchInstall(); } catch (error) { toast(error.message, true); } return; }
    if (target.closest('[data-v-savekey]') || target.closest('[data-v-dropkey]')) {
      const key = target.closest('[data-v-dropkey]') ? '' : back.querySelector('[data-v-key]').value.trim();
      if (!key && !target.closest('[data-v-dropkey]')) return toast('Paste the key first.', true);
      try { await api('/voice/key', { method: 'POST', data: { key } }); info = await api('/voice/engines'); toast(key ? 'ElevenLabs key saved.' : 'ElevenLabs key removed.'); draw(); } catch (error) { toast(error.message, true); }
      return;
    }
    if (!target.closest('[data-v-record]')) return;
    if (recording) {
      const done = recording; recording = null; done.stop(); busy = true; draw();
      if (!done.heard) { busy = false; toast('Nothing was heard. Try again a little closer to the microphone.', true); draw(); return; }
      try {
        const response = await fetch(`/api/voice/compare?language=${voiceLanguage(ctx)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'x-rex-desk': '1' }, body: done.wav() });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        results = body.results;
      } catch (error) { toast(error.message, true); }
      busy = false; draw(); return;
    }
    try { recording = startRecorder(await openMicrophone(), { onQuiet: () => {} }); results = null; draw(); }
    catch { toast('Rex Desk could not use the microphone.', true); }
  });
}

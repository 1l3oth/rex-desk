import { t } from './i18n.js';
import { aiId, aiName, aiChoices, confirmAiSwitch } from './ai-names.js';
// The chat input: a rounded box with a + menu, slash commands, @ mentions, voice, attachments, and the model, effort and mode pickers underneath.
const ICON = {
  plus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  help: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.8 2.8 0 0 1 5.4 1c0 1.8-2.6 2.2-2.6 4"/><path d="M12 17h.01"/></svg>',
};
import { pickerHtml } from '/chat-pick.js';
import { openMicrophone, startRecorder, transcribe } from '/recorder.js';
const KEY = 'rex-desk-input';
const EFFORT_LABEL = { low: t('Low'), medium: t('Medium'), high: t('High'), xhigh: t('Extra high'), max: t('Max') };
const EFFORT_HINT = { low: t('Fast, light thinking'), medium: t('Balanced'), high: t('Thinks longer'), xhigh: t('Thinks a lot longer'), max: t('Longest thinking, slowest') };
const MODE_HINT = { bypassPermissions: t('Runs tools without asking'), manual: t('Asks you for each tool, in the chat'), auto: t('A checker decides what is safe'), plan: t('Plans only, runs nothing'), acceptEdits: t('Edits files freely, asks for the rest') };
const DEFAULT_MODE = 'bypassPermissions';

function saved() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
function remember(patch) { try { localStorage.setItem(KEY, JSON.stringify({ ...saved(), ...patch })); } catch { /* private window */ } }

// What the pickers show: the run's own choice when it has one, else what the person last picked, else the defaults.
// The AI a chat runs on: the one picked for it here, else the run's own, else the default in Settings.
// Local AI is offered as an AI of its own (the models on this computer), though it runs through Claude Code: a chat on
// a local model shows "Local AI", Claude Code's list shows only Claude's models, and the message goes out as Claude Code.
const LOCAL = 'local';
const isLocalId = id => String(id || '').startsWith('local:');
function providerOf(ctx, run) {
  const picked = ctx.ui.providerPick?.[ctx.draftKey()]; if (picked) return picked;
  const own = run?.provider || ctx.ui.snap?.config?.provider || 'claude';
  return own === 'claude' && isLocalId(run ? run.model : ctx.ui.snap?.config?.models?.claude) ? LOCAL : own;
}
function choicesFor(ctx, provider) {
  const all = ctx.ui.snap?.choices || { models: [], efforts: [], modes: [] };
  if (provider !== LOCAL && provider !== 'claude') return all.providers?.[provider] || all;
  const claude = all.providers?.claude || all, local = provider === LOCAL;
  const models = claude.models.filter(item => isLocalId(item.id) === local);
  // No model on this computer yet: say where to get one instead of an empty list.
  return { ...claude, models: models.length || !local ? models : [{ id: '', label: t('No models yet'), hint: t('Open Settings, Local AI, and press Set up: it installs Ollama and a starter model.'), disabled: true }] };
}
const sentProvider = provider => (provider === LOCAL ? 'claude' : provider);
export function currentOptions(ctx) {
  const { ui } = ctx, run = ui.view.type === 'main' ? ctx.mainRun() : ui.view.type === 'run' ? ctx.runById(ui.view.id) : null, last = saved(), provider = providerOf(ctx, run), choices = choicesFor(ctx, provider);
  const configured = ui.snap?.config?.models?.[sentProvider(provider)];
  // Only a model that is on the current list is shown and sent; anything else falls back to the first one (the recommended default).
  const ids = choices.models.filter(item => !item.disabled).map(item => item.id), model = [run?.model, last.model, configured].find(value => value && ids.includes(value)) || ids[0] || '';
  const modeIds = choices.modes.map(item => item.id), wanted = ui.snap?.config?.defaultMode || DEFAULT_MODE, mode = [run?.permissionMode, last.permissionMode, wanted].find(value => value && modeIds.includes(value)) || (modeIds.includes('manual') ? 'manual' : modeIds[0]);
  const effort = [run?.effort, last.effort, 'medium'].find(value => value && choices.efforts.includes(value)) || choices.efforts[0];
  return { provider, model, effort, permissionMode: mode };
}
export function pickedOptions(ctx) {
  const read = id => document.getElementById(id)?.value || '';
  // In a chat that already exists the model goes out only when the person picked one there: the one shown by itself (the
  // agent card's, or the default) is not a choice, and sending it pinned the chat to it for good (L68).
  const run = ctx.ui.view.type === 'main' ? ctx.mainRun() : ctx.ui.view.type === 'run' ? ctx.runById(ctx.ui.view.id) : null, shown = read('opt-model');
  // Switching the AI (Local AI included: it goes out as Claude with a local model) is a pick of the model it shows.
  const key = ctx.draftKey(), model = !run || ctx.ui.modelPick?.[key] === shown || ctx.ui.providerPick?.[key] || isLocalId(shown) ? shown : '';
  return { provider: sentProvider(read('opt-provider')) || undefined, model: model || undefined, effort: read('opt-effort') || undefined, permissionMode: read('opt-mode') || undefined };
}

// The AI, model, effort and mode pickers under the message box, for the AI picked now.
function optionPickers(ctx) {
  const now = currentOptions(ctx), choices = choicesFor(ctx, now.provider);
  const select = (id, label, items, value) => pickerHtml(ctx, { id, label, compact: true, value, items: items.map(item => ({ value: item.id, label: item.label, hint: item.hint, disabled: item.disabled })) });
  const modes = choices.modes.map(item => ({ ...item, label: item.id === 'bypassPermissions' ? t('Dangerous') : item.label, hint: item.hint || MODE_HINT[item.id] }));
  return `${select('opt-provider', 'AI', [{ id: 'claude', label: t('Claude Code'), hint: t('Your Claude plan') }, { id: 'codex', label: t('Codex'), hint: t('Your ChatGPT plan') }, { id: 'gemini', label: t('Gemini'), hint: t('Your Google account, through Antigravity') }, { id: 'openrouter', label: t('OpenRouter'), hint: t('Your OpenRouter key, any model it offers') }, { id: LOCAL, label: t('Local AI'), hint: t('A model on this computer: free and private, no account needed') }], now.provider)}${select('opt-model', t('Model'), choices.models, now.model)}${select('opt-effort', t('Effort'), choices.efforts.map(id => ({ id, label: EFFORT_LABEL[id] || id, hint: EFFORT_HINT[id] })), now.effort)}${select('opt-mode', t('Mode'), modes, now.permissionMode)}`;
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
      <button class="icon-btn" data-action="plus" aria-label="${t`Add`}" title="${t`Add`}">${ICON.plus}</button>
      <textarea id="draft" rows="1" placeholder="${esc(model.composer.placeholder)}">${esc(ui.drafts.get(ctx.draftKey()) || '')}</textarea>
      ${navigator.mediaDevices?.getUserMedia ? `<button class="icon-btn" data-action="mic" aria-label="${t`Dictate`}" title="${t`Dictate: click, or hold Space (Khmer, English or Korean, on this computer)`}">${ICON.mic}</button>` : ''}
      <button class="send-btn" data-action="send" aria-label="${t`Send`}" title="${t`Send`}">${ICON.up}</button>
      <input type="file" id="file-input" multiple hidden>
    </div>
    <div class="foot"><button type="button" class="icon-btn help-btn" data-action="help" aria-label="${t`Help`}" title="${t`See everything you can type here`}">${ICON.help}</button><span class="hint">${t('Type / for commands · hold Space to talk')}${model.composer.mentions?.length ? t(' · @ to mention · # for a task') : ''}</span><span class="spacer"></span>${model.composer.foot || ''}
      ${model.composer.noPickers ? '' : `${optionPickers(ctx)}
      ${contextRing(ctx, working)}`}</div>
  </div></div>`;
}

// ---------- attachments ----------
function drawChips(ctx) {
  const host = document.getElementById('attach-chips'); if (!host) return;
  const thumb = file => file.path && /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.path) ? `<img class="thumb" src="/api/uploads/file?path=${encodeURIComponent(file.path)}" alt="">` : ICON.file;
  host.innerHTML = ctx.ui.attachments.map((file, index) => `<span class="attach ${file.error ? 'bad' : ''}">${thumb(file)}<span class="nm">${ctx.esc(file.name)}</span>${file.path ? '' : '<span class="sp"></span>'}<button type="button" data-remove-attach="${index}" aria-label="${t`Remove`}">×</button></span>`).join('');
}
async function upload(ctx, file) {
  const entry = { name: file.name || 'pasted-file', path: '' }; ctx.ui.attachments.push(entry); drawChips(ctx);
  try {
    const response = await fetch(`/api/uploads?name=${encodeURIComponent(entry.name)}`, { method: 'POST', headers: { 'x-rex-desk': '1' }, body: file });
    const body = await response.json(); if (!response.ok) throw new Error(body.error ? t(body.error) : t('Upload failed.'));
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
  const title = run ? (used ? t`Context: ${kilo(used)} of ${kilo(window)} (${Math.round(share * 100)}%). Click for details.${share > 0.7 ? ' Getting full: /clear starts fresh with a summary.' : ''}` : t('Context: empty. It fills as you talk. Click for details.')) : t('Context shows in a chat with one agent.');
  // Tokens, not a share (L58): on a 1M window 20% is already 200k, which the share hides.
  const pct = used ? `<span class="ring-pct">${kilo(used)}</span>` : '';
  return `<button type="button" class="ring ctx ${share > 0.85 ? 'full' : share > 0.6 ? 'mid' : ''} ${working ? 'busy' : ''}" data-action="ctx-detail" title="${ctx.esc(title)}" aria-label="${ctx.esc(title)}"><svg viewBox="0 0 18 18" width="18" height="18"><circle cx="9" cy="9" r="7" class="ring-bg"/><circle cx="9" cy="9" r="7" class="ring-fill" stroke-dasharray="${(share * round).toFixed(2)} ${round.toFixed(2)}" transform="rotate(-90 9 9)"/></svg>${pct}</button><div id="ctx-panel" class="ctx-panel" hidden></div>`;
}
// The full context breakdown, opened from the ring: how full the window is, this chat's running token total, and the last
// reply's tokens (fresh input, cache reuse, output, steps). A per-part split (system, tools, messages) is not shown because
// the engine reports only totals.
export function contextDetailHtml(ctx) {
  const { ui, esc } = ctx, view = ui.view, run = view.type === 'main' ? ctx.mainRun() : view.type === 'run' ? ctx.runById(view.id) : null;
  if (!run) return `<div class="ctxd"><p class="muted small">${t`Open a chat with one agent to see its context.`}</p></div>`;
  const kilo = value => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value || 0));
  const used = Number(run.contextUsed || 0), window = Number(run.contextWindow || 200000), share = window ? Math.min(1, used / window) : 0;
  const last = run.lastTokens || {}, total = run.tokensTotal || {};
  const row = (label, value, tip = '') => `<div class="ctxd-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>${tip ? `<div class="ctxd-tip">${esc(tip)}</div>` : ''}`;
  return `<div class="ctxd">
    <div class="ctxd-head"><strong>${t`Context in this chat`}</strong><span class="muted">${kilo(used)} / ${kilo(window)} · ${Math.round(share * 100)}%</span></div>
    <div class="ctxd-bar"><i style="width:${Math.round(share * 100)}%" class="${share > 0.85 ? 'full' : share > 0.6 ? 'mid' : ''}"></i></div>
    ${share > 0.7 ? `<p class="ctxd-warn">${t`Getting full. Type /clear to start fresh with a short summary.`}</p>` : ''}
    <div class="ctxd-sec">${t`Right now in the window`}</div>
    ${row(t`In the agent's mind`, kilo(used))}
    ${row(t`Room left`, kilo(Math.max(0, window - used)))}
    <div class="ctxd-sec">${t`Last reply`}</div>
    ${row(t`Fresh input (billed)`, kilo(last.input || 0))}
    ${row(t`Reused from cache (cheap)`, kilo(last.cacheRead || 0))}
    ${row(t`Written to cache`, kilo(last.cacheWrite || 0))}
    ${row(t`The agent's output`, kilo(last.output || 0))}
    ${last.steps ? row(t`Tool steps`, String(last.steps)) : ''}
    <div class="ctxd-sec">${t`This whole chat`}</div>
    ${row(t`Total input`, kilo(total.input || 0))}
    ${row(t`Total from cache`, kilo(total.cacheRead || 0))}
    ${row(t`Total output`, kilo(total.output || 0))}
    <p class="ctxd-foot muted">${t`A per-part split (system, tools, messages) is not shown: the AI engine reports only these totals.`}</p>
  </div>`;
}

// ---------- menus: slash commands and @ mentions share one list ----------
function commands(ctx) {
  const { ui } = ctx, c = ctx.commands;
  return [
    { name: 'sync', hint: t('Get the newest tasks from your task app'), run: c.sync },
    { name: 'projects', hint: t('Scan this computer for projects'), run: c.projects },
    { name: 'room', hint: t('Start a room for several agents'), run: c.room },
    { name: 'agent', hint: t('Create an agent for a project'), run: c.agent },
    ...(ui.view.type === 'room' ? [{ name: 'assign', hint: t('Give a task to an agent: /assign @agent #task'), run: c.assign }] : []),
    { name: 'main', hint: t('Go to Rex Agent'), run: c.main },
    ...(ui.view.type === 'main' || ui.view.type === 'run' ? [{ name: 'stop', hint: t('Stop the agent'), run: c.stop }, { name: 'clear', hint: t('Fresh start: the agent gets a summary of this chat and starts again'), run: c.clear }, { name: 'loop', hint: t('Check its own tasks now and start on one'), run: c.loop }] : []),
    { name: 'voice', hint: t('Voice engine and language: compare which one understands you'), run: () => voiceDialog(ctx) },
    { name: 'settings', hint: t('Open settings'), run: c.settings },
    { name: 'setup', hint: t('Show the setup checklist: what is left to set up'), run: c.setup },
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
  return [...(tools.commands || []).map(item => ({ name: item.name, hint: t`Command · ${item.description || item.source}`, run: put(item.name) })),
    ...(tools.skills || []).map(item => ({ name: item.name, hint: t`Skill · ${item.description || item.source}`, run: put(item.name) }))];
}
function drawMenu(ctx) {
  const host = document.getElementById('menu'); if (!host) return;
  const menu = ctx.ui.menu;
  host.innerHTML = menu ? `<div class="menu" role="listbox">${menu.items.map((item, index) => `<button type="button" role="option" class="${index === menu.index ? 'on' : ''}" data-menu="${index}"><strong>${menu.kind === 'slash' ? '/' : menu.kind === 'task' ? '#' : item.plain ? '' : '@'}${ctx.esc(item.name)}</strong>${item.hint ? `<small>${ctx.esc(item.hint)}</small>` : ''}</button>`).join('')}</div>` : '';
}
function closeMenu(ctx) { ctx.ui.menu = null; drawMenu(ctx); }
function choose(ctx, item) {
  const menu = ctx.ui.menu, box = document.getElementById('draft'); if (!menu || !item) return;
  if (menu.kind === 'slash') {
    // A slash at the very start runs the command as before. One typed mid-sentence puts the command in place of the /query,
    // keeping the text around it, instead of wiping the box.
    if (!menu.from) { box.value = ''; ctx.ui.drafts.set(ctx.draftKey(), ''); closeMenu(ctx); void item.run?.(); return; }
    const end = box.selectionStart;
    box.value = `${box.value.slice(0, menu.from)}/${item.name} ${box.value.slice(end)}`; ctx.ui.drafts.set(ctx.draftKey(), box.value); closeMenu(ctx); box.focus(); return;
  }
  const end = box.selectionStart;
  box.value = `${box.value.slice(0, menu.from)}${menu.kind === 'task' ? '#' : '@'}${item.name} ${box.value.slice(end)}`; ctx.ui.drafts.set(ctx.draftKey(), box.value); closeMenu(ctx); box.focus();
}
function menuItems(ctx, box) {
  const before = box.value.slice(0, box.selectionStart);
  // A slash opens the command list at the start of the box or anywhere after a space, so /command works mid-sentence too.
  const slash = /(^|\s)\/([\w-]*)$/.exec(before);
  if (slash) { const query = slash[2]; const items = commands(ctx).filter(item => item.name.startsWith(query.toLowerCase())); return items.length ? { kind: 'slash', items, index: 0, from: before.length - query.length - 1 } : null; }
  const room = ctx.ui.view.type === 'room' ? ctx.ui.snap.rooms.find(item => item.id === ctx.ui.view.id) : null;
  const at = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(before);
  if (at) {
    const agentsHere = room ? room.members.filter(member => member.id !== 'you').length : 0;
    const items = (room ? [...(agentsHere > 1 ? [{ name: 'all', hint: t`Everyone in this room (${agentsHere} agents)` }] : []), ...room.members.map(member => ({ name: member.handle, hint: `${member.name} · ${member.project} · ${member.label}` }))] : (ctx.ui.mentions || []).map(name => ({ name }))).filter(item => item.name && item.name.toLowerCase().startsWith(at[2].toLowerCase()));
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
// Dictation with the browser's own speech recognition (Chrome, Edge; see Voice mode below): it works the words out while
// they are said, so they are in the box the moment the person stops, instead of being worked out from a recording after.
// Where it cannot be used (the desktop app's window, no network), Rex Desk's own engine records as before.
function putInBox(ctx, text) {
  const box = document.getElementById('draft'); if (!box || !text) return;
  ctx.ui.voiceDrafts = ctx.ui.voiceDrafts || new Set(); ctx.ui.voiceDrafts.add(ctx.draftKey());
  box.value = (box.value.trim() ? `${box.value.trim()} ` : '') + text; ctx.ui.drafts.set(ctx.draftKey(), box.value); box.focus(); box.dispatchEvent(new Event('input', { bubbles: true }));
}
// The browser's recognition listens to the browser's own microphone choice, which can be a muted virtual one (iVCam): it
// is handed the microphone Rex Desk found working instead, where the browser allows that (Chrome does).
function startOn(recognition, stream) {
  const track = stream?.getAudioTracks?.()[0];
  if (track) { try { recognition.start(track); return; } catch { /* an older browser: its own microphone */ } }
  recognition.start();
}
async function browserDictate(ctx, { untilRelease = false } = {}) {
  if (browserSpeech === 'no') return false;
  let recognition; try { recognition = new Recognition(); } catch { browserSpeech = 'no'; return false; }
  let stream = null; try { stream = await openMicrophone(); } catch { /* the browser asks for the microphone itself */ }
  const release = () => stream?.getTracks().forEach(track => track.stop());
  // Always continuous (on its own it stops at the first breath). Held Space ends when it is let go; the mic button ends after
  // a pause of two seconds with no new words, or when it is pressed again.
  recognition.lang = SPEECH_LANG[voiceLanguage(ctx)] || 'en-US'; recognition.interimResults = true; recognition.continuous = true;
  let said = '', lastWords = 0;
  const watch = untilRelease ? 0 : setInterval(() => { if (said && performance.now() - lastWords > 2000) turn.stop(); }, 200);
  const turn = { browser: true, stop: () => { clearInterval(watch); try { recognition.stop(); } catch { /* already over */ } } };
  recognition.onresult = event => { said = [...event.results].map(result => result[0].transcript).join(' ').replace(/\s+/g, ' ').trim(); lastWords = performance.now(); };
  recognition.onerror = event => { turn.failed = event.error; if (['network', 'not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error)) browserSpeech = 'no'; };
  recognition.onend = () => {
    clearInterval(watch); release(); if (listening === turn) listening = null;
    micButton()?.classList.remove('rec'); document.body.classList.remove('ptt');
    if (said) { putInBox(ctx, said); return; }
    ctx.toast(turn.failed && browserSpeech === 'no' ? t('The browser could not turn speech into words here. Press the mic again to use Rex Desk\'s own voice engine.') : t('Nothing was heard. Hold Space (or press the mic) and speak.'), true);
  };
  try { startOn(recognition, stream); } catch { release(); browserSpeech = 'no'; return false; }
  if (browserSpeech === 'try') browserSpeech = 'yes';
  listening = turn; micButton()?.classList.add('rec');
  return true;
}
async function finishMic(ctx) {
  const recording = listening; if (!recording) return;
  // The browser's recognition puts the words in the box itself when it ends.
  if (recording.browser) { recording.stop(); return; }
  listening = null; recording.stop(); micButton()?.classList.remove('rec');
  if (!recording.heard) { ctx.toast(t('Nothing was heard. Hold Space (or press the mic) and speak.'), true); return; }
  transcribing = true; micButton()?.classList.add('busy');
  const slow = setTimeout(() => ctx.toast(t('Loading the voice model. The first time after a restart takes a minute or two.')), 4000);
  try {
    const heard = await transcribe(recording.wav(), voiceLanguage(ctx)), box = document.getElementById('draft');
    if (box) { ctx.ui.voiceDrafts = ctx.ui.voiceDrafts || new Set(); ctx.ui.voiceDrafts.add(ctx.draftKey()); box.value = (box.value.trim() ? `${box.value.trim()} ` : '') + heard.text; ctx.ui.drafts.set(ctx.draftKey(), box.value); box.focus(); box.dispatchEvent(new Event('input', { bubbles: true })); }
  } catch (error) {
    ctx.toast(/not installed|install/i.test(error.message) ? t('Voice is not installed yet. Install it in Settings → Jev and voice.') : t`Voice input: ${error.message}`, true);
  } finally { clearTimeout(slow); transcribing = false; micButton()?.classList.remove('busy'); }
}
async function toggleMic(ctx) {
  if (transcribing) return;
  if (listening) return finishMic(ctx);
  if (await browserDictate(ctx)) return;
  void fetch(`/api/voice/prepare?language=${voiceLanguage(ctx)}`, { method: 'POST', headers: { 'x-rex-desk': '1' } }).catch(() => {});
  let stream;
  try { stream = await openMicrophone(); } catch { ctx.toast(t('Rex Desk could not use the microphone. Allow it, then press the mic again.'), true); return; }
  listening = startRecorder(stream, { onQuiet: () => void finishMic(ctx) });
  micButton()?.classList.add('rec');
}

// Voice mode (chat-speak.js): one spoken turn. It listens until the person stops talking, then sends what they said as a
// message. Nothing said in 20 seconds ends the turn quietly; Voice mode starts the next one. Returns false when it could
// not start (already listening, the microphone is blocked).
export const voiceBusy = () => Boolean(listening || transcribing);
// What the body in Voice mode shows: listening (with how loud the person is), or turning speech into words.
// heardAt: the last moment the person's voice was loud enough to be talking, so Voice mode never takes them for silent
// (and never interrupts them with "are you still there?") while they talk.
let micLevel = 0, heardAt = 0;
const hearLevel = level => { micLevel = level; if (level > 0.12) heardAt = Date.now(); };
export const voiceListening = () => ({ listening: Boolean(listening), transcribing, level: micLevel, heardAt });
// The words go to the agent as a message, as if typed.
async function sendSpoken(ctx, text) {
  const box = document.getElementById('draft'); if (!text || !box) return;
  box.value = (box.value.trim() ? `${box.value.trim()} ` : '') + text; ctx.ui.drafts.set(ctx.draftKey(), box.value);
  box.dispatchEvent(new Event('input', { bubbles: true })); ctx.ui.voiceNext = true; await ctx.send();
}
// The browser's own speech recognition (Chrome, Edge): free, no key, it hears the words while they are said and knows by
// itself when the person stopped. The desktop app's window has none that works, and a browser whose service fails (no
// network, blocked) is not asked again; Rex Desk's own engines (on this computer, Gemini, ElevenLabs) take over.
const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
let browserSpeech = Recognition && !window.__REX_SHELL ? 'try' : 'no';
const SPEECH_LANG = { en: 'en-US', km: 'km-KH', ko: 'ko-KR' };
function listenLevel(stream) {
  const context = new (window.AudioContext || window.webkitAudioContext)(), analyser = context.createAnalyser(); analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize); let timer = 0;
  const tick = () => { analyser.getFloatTimeDomainData(data); let sum = 0; for (const value of data) sum += value * value; hearLevel(Math.min(1, Math.sqrt(sum / data.length) * 6)); timer = requestAnimationFrame(tick); };
  tick();
  return () => { cancelAnimationFrame(timer); micLevel = 0; stream.getTracks().forEach(track => track.stop()); void context.close(); };
}
async function browserTurn(ctx, onState) {
  let stream; try { stream = await openMicrophone(); } catch { return 'blocked'; }
  const stopLevel = listenLevel(stream), recognition = new Recognition();
  // Continuous: on its own the recognition ends a turn at the first breath, cutting the person off mid-sentence. Rex Desk
  // decides the end itself: once something was said, a pause of PAUSE_MS with no new words and a quiet microphone.
  recognition.lang = SPEECH_LANG[voiceLanguage(ctx)] || 'en-US'; recognition.interimResults = true; recognition.continuous = true; recognition.maxAlternatives = 1;
  let said = '', failed = '', lastWords = 0, ended = false;
  const PAUSE_MS = 1800, LONGEST_MS = 90000, started = performance.now();
  recognition.onresult = event => { said = [...event.results].map(result => result[0].transcript).join(' ').replace(/\s+/g, ' ').trim(); lastWords = performance.now(); };
  recognition.onerror = event => { failed = event.error || 'error'; if (['network', 'not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(failed)) browserSpeech = 'no'; };
  const finish = () => { if (ended) return; ended = true; clearInterval(watch); try { recognition.stop(); } catch { /* already over */ } };
  const watch = setInterval(() => {
    const now = performance.now();
    if (said && now - lastWords > PAUSE_MS && micLevel < 0.08) finish();
    else if (now - started > LONGEST_MS) finish();
  }, 150);
  const turn = { stop: () => { ended = true; clearInterval(watch); try { recognition.abort(); } catch { /* already over */ } } };
  recognition.onend = async () => {
    clearInterval(watch); stopLevel(); if (listening !== turn) return;
    listening = null; micButton()?.classList.remove('rec');
    if (!said) { onState('idle'); return; }
    transcribing = true; onState('thinking');
    try { await sendSpoken(ctx, said); } finally { transcribing = false; onState('idle'); }
  };
  try { startOn(recognition, stream); } catch { stopLevel(); browserSpeech = 'no'; return 'failed'; }
  listening = turn; micButton()?.classList.add('rec'); onState('listening');
  if (browserSpeech === 'try') browserSpeech = 'yes';
  return 'started';
}
export async function voiceTurn(ctx, { onState = () => {} } = {}) {
  if (listening || transcribing) return false;
  if (browserSpeech !== 'no') {
    const started = await browserTurn(ctx, onState);
    if (started === 'started') return true;
    if (started === 'blocked') { ctx.toast(t('Rex Desk could not use the microphone, so Voice mode stopped. Allow it, then turn Voice mode on again.'), true); return false; }
  }
  void fetch(`/api/voice/prepare?language=${voiceLanguage(ctx)}`, { method: 'POST', headers: { 'x-rex-desk': '1' } }).catch(() => {});
  let stream;
  try { stream = await openMicrophone(); } catch { ctx.toast(t('Rex Desk could not use the microphone, so Voice mode stopped. Allow it, then turn Voice mode on again.'), true); return false; }
  onState('listening');
  const recording = startRecorder(stream, { onQuiet: () => void finish(), onLevel: level => hearLevel(Math.min(1, level * 6)), longest: 90000, pause: 1800 });
  listening = recording; micButton()?.classList.add('rec');
  async function finish() {
    if (listening !== recording) return;
    listening = null; micLevel = 0; recording.stop(); micButton()?.classList.remove('rec');
    if (!recording.heard) { onState('idle'); return; }
    transcribing = true; onState('thinking');
    try { const heard = await transcribe(recording.wav(), voiceLanguage(ctx)); await sendSpoken(ctx, String(heard.text || '').trim()); }
    catch (error) { ctx.toast(/no voice engine|not installed|install/i.test(error.message) ? t('Voice mode needs a way to turn speech into words here: add an OpenRouter key (or install the voice model) in Settings → Jev and voice.') : t`Voice mode: ${error.message}`, true); }
    finally { transcribing = false; onState('idle'); }
  }
  return true;
}
// Ends a Voice mode turn that is still listening, without sending anything.
export function cancelVoiceTurn() { const turn = listening; if (!turn) return; listening = null; micLevel = 0; turn.stop(); micButton()?.classList.remove('rec'); }

// Hold Space to talk: past a short hold it listens until Space is let go, then the words land in the message box.
// A quick tap still types a space. It works in the message box, or anywhere that is not another text field.
const HOLD_MS = 320;
const hold = { timer: 0, active: false, pending: false, releasedEarly: false };
const holdable = target => target?.id === 'draft' || !(target?.closest?.('input,textarea,select,[contenteditable="true"],.dialog,.dialog-back'));
async function startHold(ctx) {
  if (listening || transcribing) return;
  hold.active = true; hold.pending = true;
  // The browser's own recognition, until Space is let go: the words are ready the moment it is.
  if (await browserDictate(ctx, { untilRelease: true })) {
    hold.pending = false;
    const box = document.getElementById('composer')?.getBoundingClientRect(); if (box) document.body.style.setProperty('--ptt-bottom', `${Math.max(16, Math.round(innerHeight - box.top + 12))}px`);
    document.body.classList.add('ptt');
    if (hold.releasedEarly) { hold.releasedEarly = false; hold.active = false; document.body.classList.remove('ptt'); void finishMic(ctx); }
    return;
  }
  void fetch(`/api/voice/prepare?language=${voiceLanguage(ctx)}`, { method: 'POST', headers: { 'x-rex-desk': '1' } }).catch(() => {});
  let stream;
  try { stream = await openMicrophone(); } catch { hold.active = hold.pending = false; ctx.toast(t('Rex Desk could not use the microphone. Allow it, then try again.'), true); return; }
  // While Space is held, quiet does not end the recording; only letting go does (or a minute at most).
  const recording = startRecorder(stream, { onQuiet: () => { if (performance.now() - recording.started > 60000) void finishMic(ctx); } });
  listening = recording; hold.pending = false;
  micButton()?.classList.add('rec');
  const box = document.getElementById('composer')?.getBoundingClientRect(); if (box) document.body.style.setProperty('--ptt-bottom', `${Math.max(16, Math.round(innerHeight - box.top + 12))}px`);
  document.body.classList.add('ptt');
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
    // The context ring opens (and closes) a panel with the full breakdown.
    const ctxBtn = event.target.closest('[data-action="ctx-detail"]');
    if (ctxBtn) { const panel = document.getElementById('ctx-panel'); if (panel) { const show = panel.hidden; panel.innerHTML = show ? contextDetailHtml(ctx) : ''; panel.hidden = !show; } return; }
    const panel = document.getElementById('ctx-panel');
    if (panel && !panel.hidden && !event.target.closest('#ctx-panel')) { panel.hidden = true; panel.innerHTML = ''; }
    // The help button opens the full command list, the same as typing / at the start of the box.
    if (event.target.closest('[data-action="help"]')) { ctx.ui.menu = { kind: 'slash', items: commands(ctx), index: 0, from: 0 }; drawMenu(ctx); return; }
    const chip = event.target.closest('[data-remove-attach]');
    if (chip) { ctx.ui.attachments.splice(Number(chip.dataset.removeAttach), 1); drawChips(ctx); return; }
    const entry = event.target.closest('[data-menu]');
    if (entry && ctx.ui.menu) { choose(ctx, ctx.ui.menu.items[Number(entry.dataset.menu)]); return; }
    const button = event.target.closest('[data-action="plus"],[data-action="mic"]');
    if (!button) { if (ctx.ui.menu && !event.target.closest('.box2')) closeMenu(ctx); return; }
    if (button.dataset.action === 'mic') return toggleMic(ctx);
    const items = [
      { name: t('Attach a file or image'), plain: true, hint: '', run: () => document.getElementById('file-input').click() },
      { name: t('Start a room'), plain: true, run: ctx.commands.room }, { name: t('Create an agent'), plain: true, run: ctx.commands.agent }, { name: t('Scan for projects'), plain: true, run: ctx.commands.projects }, { name: t('Voice engine and language'), plain: true, run: () => voiceDialog(ctx) },
    ];
    ctx.ui.menu = { kind: 'slash', items, index: 0, from: 0 }; drawMenu(ctx);
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'file-input') { for (const file of event.target.files) void upload(ctx, file); event.target.value = ''; return; }
    // Switching the AI shows that AI's models and modes; the next message goes to it, with the chat so far handed over.
    if (event.target.id === 'opt-provider') {
      const value = event.target.value, run = ctx.ui.view.type === 'main' ? ctx.mainRun() : ctx.ui.view.type === 'run' ? ctx.runById(ctx.ui.view.id) : null;
      const pick = () => { ctx.ui.providerPick = { ...(ctx.ui.providerPick || {}), [ctx.draftKey()]: value }; redrawOptionPickers(ctx); ctx.render(); ctx.toast(t`Your next message goes to ${value === LOCAL ? t('Local AI, on this computer') : aiName(value)}.`); };
      // A chat that already talked on another AI is handed over: warn first, since the new AI rereads all of it.
      if (run?.sessionId && sentProvider(value) !== (run.provider || 'claude')) { void confirmAiSwitch(run.title || t('This chat'), sentProvider(value)).then(yes => yes ? pick() : redrawOptionPickers(ctx)); return; }
      pick(); return;
    }
    if (event.target.id === 'opt-model') { remember({ model: event.target.value }); ctx.ui.modelPick = { ...(ctx.ui.modelPick || {}), [ctx.draftKey()]: event.target.value }; }
    if (event.target.id === 'opt-effort') remember({ effort: event.target.value });
    if (event.target.id === 'opt-mode') { remember({ permissionMode: event.target.value }); if (event.target.value === 'bypassPermissions') ctx.toast(t('Dangerous: the agent runs tools without asking.')); }
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
    if (!document.getElementById('draft')) return;
    if (event.target.id !== 'draft' && field(event.target)) return;
    const files = [...(event.clipboardData?.files || [])]; if (!files.length) return;
    event.preventDefault(); for (const file of files) void upload(ctx, file);
  });
  // A file dropped anywhere in Rex Desk (the sidebar, the side panel, the file window, any text box) is attached to the one
  // message box (L52). With no chat open, it goes to the last chat that was open, which opens. Nothing dropped ever makes the
  // page leave Rex Desk.
  const carriesFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  const lastChat = () => { try { const view = JSON.parse(localStorage.getItem('rex-last-chat') || 'null'); return view?.type ? view : null; } catch { return null; } };
  let hide = 0;
  document.addEventListener('dragover', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dropping-files'); document.body.dataset.dropHint = t('Drop to attach');
    clearTimeout(hide); hide = setTimeout(() => document.body.classList.remove('dropping-files'), 300);
  });
  document.addEventListener('drop', async event => {
    if (!carriesFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); document.body.classList.remove('dropping-files');
    const files = [...(event.dataTransfer?.files || [])]; if (!files.length) return;
    if (!document.getElementById('draft')) {
      const last = lastChat() || { type: 'main', id: '' };
      ctx.open(last.type, last.id);
      for (let tries = 0; tries < 60 && !document.getElementById('draft'); tries++) await new Promise(resolve => setTimeout(resolve, 100));
      if (!document.getElementById('draft')) { ctx.toast(t('Open a chat to attach files.'), true); return; }
    }
    for (const file of files) void upload(ctx, file);
    document.getElementById('draft')?.focus();
  });
}
export const redrawAttachments = drawChips;

// ---------- voice engine: which speech-to-text understands the person best ----------
const ENGINE = { local: [t('On this computer'), t('Private and free. Weak on Khmer.')], gemini: [t('Gemini (online)'), t('Uses your OpenRouter key. Good with Khmer.')], elevenlabs: [t('ElevenLabs Scribe (online)'), t('Its own key. Strong across languages.')] };
const LANG = [['km', t('Khmer')], ['en', t('English')], ['ko', t('Korean')]];
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
    if (local.supported === false) return t('Not available on this computer.');
    if (local.installing) { const p = local.progress; return !p ? t`Downloading… You can keep working.` : p.sizeMB ? t`Downloading ${p.index} of ${p.total}: ${Math.round(p.receivedMB)} of ${Math.round(p.sizeMB)} MB… You can keep working.` : t`Downloading ${p.index} of ${p.total}… You can keep working.`; }
    return `${local.error ? t`Install failed: ${esc(local.error)}. ` : t('Not installed yet. ')}<button type="button" class="btn small" data-v-install>${t`Install (${local.downloadMB || 1900} MB download)`}</button>`;
  };
  let watching = null;
  const watchInstall = () => {
    if (watching) return;
    watching = setInterval(async () => {
      if (!back.isConnected) { clearInterval(watching); watching = null; return; }
      try { info = await api('/voice/engines'); } catch { return; }
      if (!info.local?.installing) { clearInterval(watching); watching = null; if (info.available.local) toast(t('Voice on this computer is installed.')); }
      draw();
    }, 2000);
  };
  if (info.local?.installing) watchInstall();
  const draw = () => {
    const language = voiceLanguage(ctx);
    back.innerHTML = `<form class="dialog vdialog"><h2>${t`Voice`}</h2>
      <label>${t`I speak`}<select data-v-language>${LANG.map(([value, label]) => `<option value="${value}" ${value === language ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <fieldset class="vengines"><legend>${t`Turn speech into text with`}</legend>${Object.entries(ENGINE).map(([key, [label, hint]]) => `<label class="${info.available[key] ? '' : 'off'}"><input type="radio" name="engine" value="${key}" ${info.engine === key ? 'checked' : ''} ${info.available[key] ? '' : 'disabled'}><span><b>${label}</b><small>${info.available[key] ? hint : key === 'local' ? localHint() : key === 'gemini' ? t('Needs your OpenRouter key: Settings → Jev and voice.') : t('Paste a key below to use it.')}</small></span></label>`).join('')}</fieldset>
      <label>${t`ElevenLabs API key`}<span class="vkey"><input type="password" data-v-key autocomplete="off" spellcheck="false" placeholder="${info.available.elevenlabs ? t('Saved. Paste a new key to replace it.') : t('From elevenlabs.io → Profile → API keys')}"><button type="button" class="btn small" data-v-savekey>${t`Save key`}</button>${info.available.elevenlabs ? `<button type="button" class="btn small quiet danger" data-v-dropkey>${t`Remove`}</button>` : ''}</span></label>
      <section class="vcompare"><h3>${t`Which one understands you?`}</h3><p class="muted small">${t`Press Record, say one sentence, then Stop. It goes through every engine that is ready, so you can pick the best. Online engines receive this recording.`}</p>
        <button type="button" class="btn ${recording ? 'danger' : 'primary'}" data-v-record ${busy ? 'disabled' : ''}>${recording ? t('Stop') : busy ? t('Comparing…') : t('Record a sentence')}</button>
        ${results ? `<ol class="vresults">${results.map(item => `<li><div><b>${esc(ENGINE[item.engine]?.[0] || item.engine)}</b><small>${(item.ms / 1000).toFixed(1)} s${item.model ? ` · ${esc(item.model)}` : ''}</small></div><p class="${item.error ? 'bad' : ''}">${esc(item.error || item.text || '(nothing heard)')}</p>${item.error ? '' : `<button type="button" class="btn small" data-v-use="${esc(item.engine)}">${t`Use this one`}</button>`}</li>`).join('')}</ol>` : ''}
      </section>
      <div class="row"><button type="button" class="btn" data-v-close>${t`Done`}</button></div></form>`;
  };
  draw();
  const choose = async engine => { try { info = { ...info, engine: (await api('/voice/engine', { method: 'POST', data: { engine } })).engine }; toast(t`Voice now uses ${ENGINE[engine][0]}.`); draw(); } catch (error) { toast(error.message, true); draw(); } };
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
      if (!key && !target.closest('[data-v-dropkey]')) return toast(t('Paste the key first.'), true);
      try { await api('/voice/key', { method: 'POST', data: { key } }); info = await api('/voice/engines'); toast(key ? t('ElevenLabs key saved.') : t('ElevenLabs key removed.')); draw(); } catch (error) { toast(error.message, true); }
      return;
    }
    if (!target.closest('[data-v-record]')) return;
    if (recording) {
      const done = recording; recording = null; done.stop(); busy = true; draw();
      if (!done.heard) { busy = false; toast(t('Nothing was heard. Try again a little closer to the microphone.'), true); draw(); return; }
      try {
        const response = await fetch(`/api/voice/compare?language=${voiceLanguage(ctx)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'x-rex-desk': '1' }, body: done.wav() });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        results = body.results;
      } catch (error) { toast(error.message, true); }
      busy = false; draw(); return;
    }
    try { recording = startRecorder(await openMicrophone(), { onQuiet: () => {} }); results = null; draw(); }
    catch { toast(t('Rex Desk could not use the microphone.'), true); }
  });
}

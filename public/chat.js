import { askConfirm } from './confirm.js';
import './layers.js';
import { t, locale } from './i18n.js';
import { splitStage } from '/chat-split.js';
import { rexCore } from '/rex-core.js';
import { agentListHtml, roomListHtml, initSidebarDrag, togglePin, applyFilter } from '/chat-sidebar.js';
import { agentStage, agentAction, agentGroups, chatTakers, moveRunDialog, initAgentCard, openAgentChat, savedChatGone, toggleGroup, wireLoop } from '/chat-agents.js';
import { subagentHtml as subagentCard, subagentsFromEvents, subagentsPanel } from '/chat-subagents.js';
import { sideTabsHtml, crewHtml, savedSideTab, saveSideTab } from '/chat-sidetabs.js';
import { stepsHtml, terminalItems, terminalHtml } from '/chat-activity.js';
import { markdown } from '/chat-markdown.js';
import { initPickers, setPickActions, pickerOpen, pickerHtml } from '/chat-pick.js';
import { roomStage, newRoomDialog as openRoomDialog, tasksStage, taskStage, roomAction, initRoomInfo, avatarHtml, roomRunIds, initLocalTasks, sharedTabButtons } from '/chat-rooms.js';
import { collectShared, sharedTabsHtml, attachedFiles } from '/chat-media.js';
import { chatPins, pinsAction, watchMessagePins } from '/chat-pins.js';
import { whereLine } from '/chat-where.js';
import { devicesStage, devicesAction, initDevices } from '/chat-devices.js';
import { marketStage, marketAction, loadMarket, initMarket, MARKET_ICON } from '/chat-market.js';
import { monitorStage, monitorAction } from '/chat-monitor.js';
import { netStage, loadNet, wireNet } from '/chat-net.js';
import { expStage, wireExp, expTab, EXP_ICON } from '/chat-exp.js';
import { worktreesStage, fillWorktreeEmbeds, wireWorktrees, wireChatSwitch, WORKTREE_ICON, chatWorktrees, worktreeSideHtml } from '/chat-worktrees.js';
import { noticesAction, noticeKey, unreadFor, watchNotices } from '/chat-notices.js';
import { inboxStage, wireInbox } from '/chat-inbox.js';
import { openSettings, SETTINGS_GEAR } from '/chat-settings.js';
import { maybeStartTour } from '/chat-tour.js';
import { wireFiles, watchShownFile, watchFileWindow } from '/chat-files.js';
import { wireAgentCards } from '/chat-card.js';
import { wireImageViewer } from '/chat-viewer.js';
import { wireSpeak, speakButton, readAloudButton, toggleReadAloud, readNewReplies, speakLive, voiceModeButton, toggleVoiceMode, voiceModeOn, speechIdle, speechPlaying, stopLive, outputLevel, welcome } from '/chat-speak.js';
import { mountOrb } from '/voice-orb.js';
import { welcomeLine, STILL_THERE, GOODBYE } from '/voice-phrases.js';
import { openAvatarPicker, saveCover } from '/chat-avatar.js';
import { watchForStar } from '/chat-star.js';
import { setupHtml, setupClick, showSetup } from '/chat-setup.js';
import { showUpdateCard, updateLater, updateShow, installUpdate, revealInstaller, updateWhenIdle, watchForUpdates, showSyncNote } from '/chat-update.js';
import { composerHtml, initComposer, pickedOptions, attachmentText, redrawAttachments, voiceTurn, voiceBusy, cancelVoiceTurn, voiceListening, endDictation } from '/chat-composer.js';
// Rex Desk, chat first. One conversation at a time: the main agent, an agent run, a room of agents, or what needs you.
const app = document.getElementById('app');
// Which screen is open lives in the address (#/room/ID) and is also saved, so a refresh or a restart comes back to the same place.
const SCREENS = ['main', 'inbox', 'room', 'run', 'specialist', 'task', 'tasks', 'project', 'person', 'devices', 'market', 'jev', 'monitor', 'worktrees', 'net', 'exp', 'split'];
const hashOf = view => `#/${view.type}${view.id ? `/${encodeURIComponent(view.id)}` : ''}`;
// A chat loads its newest messages; "Show in chat" of an old pin asks for more (ui.historyLimit) until it finds the message.
const historyQuery = runId => (ui?.historyLimit?.[runId] ? `?limit=${ui.historyLimit[runId]}` : '');
function viewFromHash() { const match = /^#\/([a-z]+)(?:\/(.+))?$/.exec(location.hash); return match && SCREENS.includes(match[1]) ? { type: match[1], id: match[2] ? decodeURIComponent(match[2]) : '' } : null; }
function savedView() { try { const view = JSON.parse(localStorage.getItem('rex-desk-view') || 'null'); return view && SCREENS.includes(view.type) ? { type: view.type, id: String(view.id || '') } : null; } catch { return null; } }
// Task states that count as open on the Team tab. Defined before the first render (the top-level await refresh), which can draw it.
const TEAM_OPEN = new Set(['queued', 'working', 'needs-manager']);
const ui = { chatTab: savedSideTab('chat'), sideTab: savedSideTab('room'), snap: null, view: viewFromHash() || savedView() || { type: 'main' }, events: new Map(), memory: null, page: '', menu: null, done: false, drafts: new Map(), stick: true, attachments: [], openSteps: new Map(), termOpen: true, qstep: new Map(), qanswers: new Map(), files: new Map() };
// Tokens one reply used: what was new, what the agent wrote, and the context it read again from the cache (cheap, but it counts toward limits).
const kilo = number => number >= 1000000 ? `${(number / 1000000).toFixed(1)}M` : number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : String(number);
// The agent's last reply of this turn: the newest agent message since the person last wrote.
const lastReply = items => { for (let index = items.length - 1; index >= 0; index -= 1) { if (items[index].role === 'human') return null; if (items[index].role === 'agent') return items[index]; } return null; };
export const tokenText = tokens => tokens ? [`${kilo((tokens.input || 0) + (tokens.cacheWrite || 0))} in`, t`${kilo(tokens.output || 0)} out`, tokens.cacheRead ? t`${kilo(tokens.cacheRead)} from cache` : ''].filter(Boolean).join(' · ') + ' ' + t('tokens') : '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const hhmm = value => { const date = new Date(value); return Number.isNaN(+date) ? '' : date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }); };
const ago = value => { const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 60000)); return minutes < 1 ? t('now') : minutes < 60 ? t`${minutes}m` : minutes < 1440 ? t`${Math.round(minutes / 60)}h` : t`${Math.round(minutes / 1440)}d`; };
const provider = name => name === 'codex' ? t('Codex') : name === 'gemini' ? t('Gemini') : name === 'openrouter' ? t('OpenRouter') : name === 'claude' ? t('Claude Code') : t('Agent');
const aiKey = value => ['codex', 'gemini', 'openrouter'].includes(value) ? value : 'claude';
const ctx = { get ui() { return ui; }, api, esc, toast, refresh, open, railItem, markdown, mainRun: () => mainRun(), runById: id => runById(id), draftKey: () => draftKey(), send: () => send(),
  bubble: args => bubble(args), note: text => note(text), typing: (name, caption) => typing(name, caption), hhmm: value => hhmm(value), tokenText,
  render: () => renderAll(), renderAll: () => renderAll(), isCollapsed: key => collapsed.has(key), currentRunId: () => (ui.view.type === 'main' ? mainRun()?.id : ui.view.type === 'run' ? ui.view.id : '') || '', openSettings: (section, extra) => openSettings(ctx, section, extra), askMain: text => askMain(text), avatar: args => avatarHtml(ctx, args), pending: runId => pending(runId), decisionCard: item => decisionCard(item),
  commands: { assign: () => { const box = document.getElementById('draft'); if (box) { box.value = '/assign '; ui.drafts.set(draftKey(), box.value); box.focus(); } }, sync: () => syncIssues().catch(error => toast(error.message, true)), projects: () => scanProjects().catch(error => toast(error.message, true)), room: () => newRoomDialog(), agent: () => agentAction(ctx, 'spec-new'), main: () => open('main'), stop: () => stopAgent().catch(error => toast(error.message, true)), clear: () => clearAgent().catch(error => toast(error.message, true)), loop: () => loopNow().catch(error => toast(error.message, true)), settings: () => openSettings(ctx), setup: () => { showSetup(ctx); open('main'); renderAll(); } }, get initials() { return initials; } };
const initials = text => (String(text).match(/[\p{L}\p{N}]/gu) || ['?']).slice(0, 2).join('').toUpperCase();

async function api(path, { method = 'GET', data, retry = false, timeout = 0 } = {}) {
  // A timeout is set only by callers that must never hang (the live refresh): a slow server then aborts the fetch instead of
  // freezing every later update. Long calls (uploads, model actions) pass no timeout and wait as before.
  // An answer that cannot be read is an error with its real cause, never an empty {}: over a slow link (the phone through a
  // Tailscale relay) a cut-off /api/state used to become {} and the page crashed on it ("ui.snap.runs.find").
  const slow = error => error?.name === 'TimeoutError' || error?.name === 'AbortError';
  let response, text;
  try { response = await fetch(`/api${path}`, { method, ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}), headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }); }
  catch (error) { throw new Error(slow(error) ? t('Your computer answered too slowly. Trying again.') : t('Cannot reach your computer. Trying again.')); }
  try { text = await response.text(); }
  catch (error) { throw new Error(slow(error) ? t('Your computer answered too slowly. Trying again.') : t('The answer from your computer was cut off. Trying again.')); }
  let body = {};
  if (text) {
    try { body = JSON.parse(text); }
    catch {
      // A sign-in page where data was expected: this device was signed out (the key or cookie expired, or a proxy asked again).
      if (/text\/html/i.test(response.headers.get('content-type') || '')) { if (response.redirected) location.href = response.url; throw new Error(t('Sign in to Rex Desk again on this device.')); }
      throw new Error(response.ok ? t('The answer from your computer was cut off. Trying again.') : t`Request failed (${response.status})`);
    }
  }
  // With accounts, a workspace that stays signed in hands this window its cookie through /api/auth; otherwise the window signs in first.
  if (response.status === 401 && body.signIn) {
    const auth = retry ? null : await fetch('/api/auth', { headers: { 'x-rex-desk': '1' } }).then(reply => reply.json()).catch(() => null);
    if (auth?.current) return api(path, { method, data, retry: true });
    location.href = '/signin'; throw new Error(t('Sign in to Rex Desk.'));
  }
  if (!response.ok) throw new Error(body.error ? t(body.error) : t`Request failed (${response.status})`);
  return body;
}
let toastTimer;
function toast(text, bad = false) {
  const box = document.getElementById('toast'); box.textContent = text; box.className = `on${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { box.className = ''; }, 3500);
}

const workingStates = ['starting', 'running', 'queued', 'waiting', 'verifying'];
const reviewStates = ['ready_for_review', 'needs_evidence', 'qa_passed', 'qa_failed', 'qa_blocked', 'published'];
const stateGroup = run => workingStates.includes(run.state) ? 'working' : reviewStates.includes(run.state) ? 'review' : 'done';
// Continue in Claude app: a Claude chat stays open with Remote Control, so the person can chat with it from claude.ai/code or
// the Claude app on a phone. While it is open the header links to it and offers to close it there; Rex Desk shows the same chat.
const APP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/></svg>';
function appControl(run, live) {
  if (run.inApp) {
    if (run.inApp.error) return `<button class="btn small" data-action="app-off" title="${esc(run.inApp.error)}">${t`Could not open in Claude app. Close`}</button> `;
    const open = run.inApp.url ? `<a class="btn small app-link" href="${esc(run.inApp.url)}" target="_blank" rel="noopener">${APP_ICON}${t('Open in Claude app')}</a>`
      : `<span class="btn small app-link" aria-busy="true">${APP_ICON}${t('Connecting…')}</span>`;
    return `${open} <button class="btn small" data-action="app-off" title="${t`Close it in the Claude app. The chat carries on here.`}">${t`Close in app`}</button> `;
  }
  if ((run.provider || 'claude') !== 'claude' || run.remote || run.cloudCopy || live || run.state === 'waiting') return '';
  return `<button class="btn small app-link" data-action="app-on" title="${t`Keep this chat open so you can chat with it from claude.ai/code or the Claude app on your phone`}">${APP_ICON}${t('Continue in Claude app')}</button> `;
}
const stateTone = run => ({ working: 'working', review: 'warn' })[stateGroup(run)] || (['failed', 'interrupted'].includes(run.state) ? 'bad' : 'good');
const stateLabel = run => ({ starting: t('Preparing'), queued: t('Queued'), running: t('Working'), waiting: t('Needs you'), verifying: t('Checking'), ready_for_review: t('Ready for review'), needs_evidence: t('Needs proof'), published: t('PR created'), failed: t('Failed'), interrupted: t('Cut off'), stopped: t('Stopped'), finished: t('Finished') }[run.state] || String(run.state || '').replaceAll('_', ' '));
const pending = runId => (ui.snap?.interactions || []).filter(item => item.state === 'pending' && (!runId || item.runId === runId));
const runById = id => ui.snap.runs.find(run => run.id === id);
// The main agent's personal chat. Its room session (role coordinator, roomAgent main) is a separate conversation and never opens here.
// Only this computer's main agent: the other computers' main agents sync in through Turso but are theirs.
const mainRun = () => ui.snap.runs.find(run => run.role === 'coordinator' && run.main && !run.roomAgent && run.computer === ui.snap.computer);
// A run on a task is named by the task's English name, whatever language the tracker used.
const runTitle = run => { const task = run?.taskId ? ui.snap?.tasks?.find(item => item.id === run.taskId) : null; return task?.titleEn || run?.title || run?.branch || t`Run ${String(run?.id || '').slice(0, 8)}`; };
const roomById = id => ui.snap.rooms.find(room => room.id === id);

// ---------- rail ----------
const TILE_NAMES = { notices: t('Alerts'), inbox: t('Needs'), tasks: t('Tasks'), jev: t('Jev'), person: t('You'), monitor: 'RAM', devices: 'PCs', worktrees: t('Trees') };
// A small square button for a place (Notifications, Tasks, Monitor…), with its name and state in the tooltip and a badge when something waits.
// A place in the rail: an icon, a name, and a count on the right (amber when it needs you).
function place(type, icon, name, count = 0, warn = false, hint = '', sub = '') {
  // The bell opens a dropdown instead of a screen; it keeps the "tile" class the dropdown places itself by.
  const bell = type === 'notices', active = bell ? Boolean(document.querySelector('.nt-pane')) : ui.view.type === type;
  return `<button type="button" class="place${bell ? ' tile' : ''}${active ? ' active' : ''}" ${bell ? 'data-action="nt-panel"' : `data-open="${type}" data-id=""`} ${active ? 'aria-current="page"' : ''} title="${esc(hint || name)}">${iconAv(icon, warn && count ? 'warn' : '')}<span>${esc(name)}${sub ? `<small class="place-sub">${esc(sub)}</small>` : ''}</span>${count ? `<b class="${warn ? 'warn' : ''}">${count > 99 ? '99+' : count}</b>` : ''}</button>`;
}
function tile(type, avatar, name, sub, badge = 0, warn = false) {
  // The bell opens a dropdown list instead of a screen.
  const active = type === 'notices' ? Boolean(document.querySelector('.nt-pane')) : ui.view.type === type, how = type === 'notices' ? 'data-action="nt-panel"' : `data-open="${type}" data-id=""`;
  return `<button class="tile ${active ? 'active' : ''}" ${how} title="${esc(`${name} · ${sub}`)}" aria-label="${esc(`${name}, ${sub}`)}">${avatar}${badge ? `<span class="tbadge ${warn ? 'warn' : ''}">${badge > 99 ? '99+' : badge}</span>` : ''}<span class="tname">${esc(TILE_NAMES[type] || name)}</span></button>`;
}
// The computer an agent works on, after its state, unless the state already names it ("Offline · Work is off").
const withDevice = (text, device) => !device || String(text).includes(device) ? text : `${text} · ${device}`;
// Rex Agent's own state, the same shape as an agent's.
const mainLive = () => {
  const listed = (ui.snap?.specialists || []).find(agent => agent.kind === 'main')?.status; if (listed) return listed;
  const run = mainRun(); if (run && ['starting', 'running', 'queued', 'verifying'].includes(run.state)) return { state: 'replying' };
  if (run?.state === 'waiting') return { state: 'waiting' };
  const last = run?.lastTokens, span = last?.cacheTtl >= 3600 ? last.cacheTtl - 600 : Math.max(0, (last?.cacheTtl || 0) - 60), until = last?.at && span ? new Date(last.at).getTime() + span * 1000 : 0;
  return { state: 'idle', warmUntil: until > Date.now() ? new Date(until).toISOString() : '', warmTtl: span };
};
function railItem(type, id, { dot = '', avatar = '', name, sub = '', badge = 0, warn = false, title = '', live = '' }) {
  const active = (ui.view.type === type && (ui.view.id || '') === (id || '')) || (type === 'specialist' && ui.view.type === 'run' && (ui.snap?.specialists || []).some(agent => agent.id === id && agent.runId === ui.view.id));
  // live: { state, warmUntil } of an agent: working shows a turning halo, asleep a dimmed face, warm a countdown.
  const mood = live ? (['busy', 'replying'].includes(live.state) ? 'is-working' : live.state === 'waiting' ? 'is-waiting' : live.state === 'idle' || !live.state ? 'is-asleep' : '') : '';
  const warm = mood === 'is-asleep' && live.warmUntil ? ` data-warm="${esc(live.warmUntil)}" data-ttl="${Number(live.warmTtl) || 300}"` : '';
  return `<button class="item ${active ? 'active' : ''} ${mood}" data-open="${type}" data-id="${esc(id || '')}"${warm}${title ? ` title="${esc(title)}"` : ''}>${avatar || (dot ? `<span class="dot ${dot}"></span>` : '')}<span class="name">${esc(name)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>${badge ? `<span class="badge ${warn ? 'warn' : ''}">${badge}</span>` : ''}</button>`;
}
// Sidebar pieces: an icon or a picture for every row, a status dot on agents, and sections that fold and remember it.
const SVG = {
  main: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8l5.6-.8z"/></svg>',
  split: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16M3 12h9"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/></svg>',
  person: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  usage: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19a9 9 0 1 1 16 0"/><path d="M12 14l4-5"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 13l3-3 3 2 4-5M8 21h8"/></svg>',
  market: MARKET_ICON,
  devices: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6M9 14v4"/><rect x="17" y="8" width="5" height="12" rx="1"/></svg>',
  worktrees: WORKTREE_ICON,
  run: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 3 14 9-14 9z"/></svg>',
};
const iconAv = (name, tone = '') => `<span class="av sm icon ${tone}">${SVG[name]}</span>`;
const withDot = (avatar, dot) => `<span class="avwrap">${avatar}${dot ? `<span class="sdot ${dot}"></span>` : ''}</span>`;
const collapsed = (() => { try { return new Set(JSON.parse(localStorage.getItem('rex-desk-collapsed') || '[]')); } catch { return new Set(); } })();
function section(key, title, count, extra, body) {
  const shut = collapsed.has(key);
  return `<div class="sec ${shut ? 'shut' : ''}"><div class="sec-head"><button type="button" class="sec-toggle" data-action="sec-toggle" data-sec="${key}" aria-expanded="${!shut}"><span class="chev" aria-hidden="true">▾</span>${esc(title)}${count !== '' ? `<span class="cnt">${count}</span>` : ''}</button>${extra}</div>${shut ? '' : `<div class="sec-body">${body}</div>`}</div>`;
}
function toggleSection(key) { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); try { localStorage.setItem('rex-desk-collapsed', JSON.stringify([...collapsed])); } catch { /* private window */ } renderAll(); }
const agentDot = state => ({ busy: 'working', replying: 'working', waiting: 'warn', idle: 'good', offline: 'off' })[state] || '';

// The Tasks row says how they stand without opening it: open, waiting on someone, done.
function taskSummary(counts) {
  if (!counts || !(counts.open + counts.waiting + counts.done)) return '';
  return t`${counts.open} open · ${counts.waiting} waiting · ${counts.done} done`;
}
function renderRail() {
  // No Runs list: agents work in their own chats and rooms, the way the person tells them. An old run still opens from its task.
  const snap = ui.snap, asks = pending().length;
  const tgUnread = (snap.telegramInbox || []).filter(row => !row.read).length;
  const main = mainRun(), agents = snap.specialists || [], tasks = (snap.tasks || []).filter(task => task.active && !task.demo), busy = agents.filter(agent => agent.status?.state === 'busy').length;
  // The Tasks badge counts work still to do: open and waiting, never done.
  const openTasks = snap.taskCounts ? (snap.taskCounts.open || 0) + (snap.taskCounts.waiting || 0) : tasks.filter(task => task.status !== 'done').length;
  const plus = (action, label) => `<button class="sec-add" data-action="${action}" title="${label}" aria-label="${label}">+</button>`;
  return `<div class="rail-head"><span class="brand"><img class="brand-logo" src="/favicon.svg" alt="" width="26" height="26"><strong>${t`Rex Desk`}</strong></span><span class="spacer"></span></div>${phoneHead()}<div class="rail-scroll">${phoneChats()}
    <div class="sec-body top">
      ${railItem('main', '', { avatar: withDot(rexCore('sm', (ui.snap?.specialists || []).filter(agent => agent.kind !== 'main').length), main ? stateTone(main) : ''), name: t('Rex Agent'), sub: mainLive().state === 'idle' ? t('Asleep') : main ? stateLabel(main) : t('Not started'), badge: unreadFor(ui, 'main:'), live: mainLive() })}
      <nav class="places" aria-label="${t`Places`}">${[
        place('notices', 'bell', t('Notifications'), snap.notices?.unread || 0, true),
        place('inbox', 'inbox', t('Needs you'), asks + tgUnread, true),
        place('tasks', 'tasks', t('Tasks'), busy || openTasks, false, busy ? t`${busy} being worked on` : '', taskSummary(snap.taskCounts)),
        place('person', 'person', t('Knowledge'), 0),
        place('split', 'split', t('Split view'), 0),
      ].join('')}</nav>
    </div>
    ${newComputerCard(snap)}
    ${section('rooms', t('Meeting rooms'), snap.rooms.length, plus('new-room', t('New meeting room')), snap.rooms.length ? roomListHtml(ctx, snap.rooms, room => railItem('room', room.id, { avatar: withDot(avatarHtml(ctx, { name: room.name, image: room.image, id: room.id, members: (room.members || []).map(member => member.id || member), at: room.imageAt || '', size: 'sm' }), room.members.some(member => member.state === 'replying' || member.state === 'busy') ? 'working' : ''), name: room.name, sub: room.endedAt ? t('Ended') : room.members.length === 1 ? t`${room.members.length} agent` : t`${room.members.length} agents`, badge: unreadFor(ui, `room:${room.id}`) })) : `<button type="button" class="rail-cta" data-action="new-room">${t`New meeting room`}</button>`)}
    ${section('agents', t('Agents'), agents.length, plus('spec-new', t('New agent')), agents.length ? agentListHtml(ctx, agents, agent => railItem('specialist', agent.id, { avatar: withDot(avatarHtml(ctx, { name: agent.name, agent, size: 'sm' }), agentDot(agent.status?.state)), name: agent.name, sub: agentWhere(agent), live: agent.device && agent.status?.state === 'offline' ? null : agent.status, title: [agent.device && t`Works on ${agent.device}`, agent.projectPath && `Folder: ${agent.projectPath}`].filter(Boolean).join(' · '), badge: agent.runId ? unreadFor(ui, `run:${agent.runId}`) : 0 })) : `<button type="button" class="rail-cta" data-action="spec-new">${t`New agent`}</button>`)}
  </div>${phoneTabs(asks + tgUnread)}<div class="rail-tools" role="toolbar" aria-label="${t`Tools`}"><button type="button" class="tool" data-open="jev" title="${t`Jev: control this computer and websites`}" aria-label="${t`Jev`}">${iconAv('mic', 'accent')}</button><button type="button" class="tool" data-open="monitor" title="${esc(ui.monitor ? t`Memory: ${ui.monitor.freeMb >= 1024 ? `${(ui.monitor.freeMb / 1024).toFixed(1)} GB` : `${ui.monitor.freeMb} MB`} free` : t('Memory and what uses it'))}" aria-label="${t`Memory`}">${iconAv('monitor')}</button><button type="button" class="tool" data-open="devices" title="${t`Devices: your other computers and phone`}" aria-label="${t`Devices`}">${iconAv('devices')}</button><button type="button" class="tool" data-open="market" data-id="" title="${t`Market: skills, commands and MCP servers`}" aria-label="${t`Market`}">${iconAv('market')}</button><button type="button" class="tool" data-open="exp" data-id="" title="${t`Experimental`}" aria-label="${t`Experimental`}"><span class="av sm icon">${EXP_ICON}</span></button></div><div class="rail-foot"><button class="acct-btn" data-action="account-open" title="${t`Your Rex Desk account`}">${rexAccountChip()}</button><button type="button" class="acct-ai" data-action="accounts" title="${t`Which Claude account the agents use`}">${accountChip()}</button><div class="rail-row"><button class="btn small rail-settings" data-action="settings-open" title="${t`Settings`}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SETTINGS_GEAR}</svg>${t`Settings`}</button><button class="btn small rail-theme" data-action="theme" title="${t`Light or dark`}" aria-label="${t`Light or dark`}"><svg class="ti-sun" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="ti-moon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg><span class="ti-word" data-light>${t`Light`}</span><span class="ti-word" data-dark>${t`Dark`}</span></button><button type="button" class="rail-ver${ui.snap.update?.ready || ui.snap.update?.available ? ' new' : ''}" data-action="about-open" title="${t`About Rex Desk: version, storage and what it holds`}">${esc(ui.snap.update?.current ? `v${ui.snap.update.current}` : 'dev')}</button></div></div>`;
}

// ---------- run conversation ----------
// The conversation, with the agent's steps folded into groups between its messages.
function renderItems(items, run, live) {
  const out = []; let group = [];
  const link = agent => `<a href="#" class="steplink" data-open="specialist" data-id="${esc(agent.id)}">${t`Open card`}</a>`;
  const flush = last => { if (group.length) out.push(stepsHtml(group, { esc, hhmm, live: live && last, openKeys: ui.openSteps, specialists: ui.snap.specialists || [], link })); group = []; };
  for (const item of items) {
    if (item.role === 'tool') { group.push(item); continue; }
    flush(false);
    out.push(item.role === 'qa-ask' ? askHtml(item, run) : item.role === 'qa-answer' ? answerHtml(item)
      : item.role === 'human' ? bubble({ mine: true, name: t('You'), time: hhmm(item.at), voice: item.voice, html: (attached => attached.top + markdown(attached.text) + attached.html)(attachedFiles(item.text, esc)), unsend: item.sequence ? `${run.id}:${item.sequence}` : '' })
      : item.role === 'agent' ? bubble({ name: provider(run.provider), uid: item.uid, time: hhmm(item.at), html: markdown(item.text) + (item.tokens ? `<div class="tok" title="${t`Tokens this reply used`}">${esc(tokenText(item.tokens))}</div>` : '') })
      : item.role === 'cleared' ? `<div class="cleared"><span>${t`Chat cleared · ${esc(item.text)}`}${item.tokens ? ` · <span class="tok">${esc(typeof item.tokens === 'object' ? tokenText(item.tokens) : typeof item.tokens === 'number' ? `${kilo(item.tokens)} ${t('tokens')}` : String(item.tokens))}</span>` : ''}</span>${item.earlier ? `<button type="button" class="btn small quiet" data-action="show-earlier">${t`Show earlier messages`}</button>` : ''}</div>`
      : item.role === 'subagent' ? subagentHtml(item, live)
      : item.role === 'error' ? `<div class="card bad"><h4>${t`Needs attention`}</h4><div class="md">${markdown(item.text)}</div>${/is not installed|usage limit|limit reached|not signed in|not logged in|log ?in again|sign ?in again|unauthorized|401/i.test(item.text) ? `<button type="button" class="btn small primary" data-action="agent-signin" data-provider="${esc(run.provider || 'claude')}">${/is not installed/i.test(item.text) ? t`Install Claude Code` : t`Sign in again`}</button>` : ''}</div>`
      : note(`${esc(item.text)}${item.tokens ? ` · <span class="tok">${esc(typeof item.tokens === 'object' ? tokenText(item.tokens) : typeof item.tokens === 'number' ? `${kilo(item.tokens)} ${t('tokens')}` : String(item.tokens))}</span>` : ''} · ${hhmm(item.at)}`));
  }
  flush(true);
  return out.join('');
}
const subagentHtml = (item, live) => subagentCard(item, live, { esc, markdown, openSubs: ui.openSubs });
// "Show in chat" on a row of the Sub-agents tab: open that card in the chat and scroll to it.
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-action="sub-jump"]'); if (!button) return; event.preventDefault();
  const card = [...document.querySelectorAll('details.subagent')].find(box => box.dataset.sub === button.dataset.sub && !box.closest('.side-body'));
  if (!card) { toast(t('That card is not in the chat on screen. Use Show earlier messages.')); return; }
  card.open = true; card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600);
});
document.addEventListener('toggle', event => { const box = event.target; if (!box.matches?.('details.subagent')) return; ui.openSubs ||= new Set(); if (box.open) ui.openSubs.add(box.dataset.sub); else ui.openSubs.delete(box.dataset.sub); }, true);
// A question that was answered stays in the chat as two messages: the agent asking, and the person answering.
function answeredItem(item) {
  const properties = item.request?.requestedSchema?.properties || {}, content = item.answer?.content || {}, action = item.answer?.action || (item.state === 'expired' ? 'expired' : 'cancel');
  const rows = Object.entries(properties).map(([key, property]) => ({ label: property.title || key, value: content[key] }));
  return [{ role: 'qa-ask', at: item.createdAt, title: item.title, approval: item.kind === 'approval', labels: rows.map(row => row.label) },
    { role: 'qa-answer', at: item.answeredAt || item.createdAt, approval: item.kind === 'approval', action, rows: rows.filter(row => row.value !== undefined && row.value !== '') }];
}
function askHtml(item, run) {
  const list = item.labels.length > 1 ? `<ol class="qa-list">${item.labels.map(label => `<li>${esc(label)}</li>`).join('')}</ol>` : item.labels.length === 1 ? `<p class="qa-one"><b>${esc(item.labels[0])}</b></p>` : '';
  return bubble({ name: provider(run.provider), time: hhmm(item.at), html: markdown(String(item.title).replace(/mcp__[a-z0-9_]+?__/gi, '')) + list });
}
function answerHtml(item) {
  const body = item.action !== 'accept' ? `<em>${item.approval ? t('Declined') : item.action === 'expired' ? '(question dropped)' : t('Skipped')}</em>`
    : item.approval ? `<em>${t`Approved`}</em>` : item.rows.length > 1 ? item.rows.map(row => `<div class="qa-ans"><span class="qa-l">${esc(row.label)}</span><br>${esc(String(row.value))}</div>`).join('') : item.rows.length ? esc(String(item.rows[0].value)) : `<em>${t`Sent`}</em>`;
  return bubble({ mine: true, name: t('You'), time: hhmm(item.at), html: body });
}
function transcript(all, runId = '') {
  // After /clear the chat starts empty again; what came before stays one click away. Events are kept in arrival order,
  // so a reply synced from another computer can sit before the marker in the list yet be newer; cut by time against the
  // newest chat-cleared marker, not by list position, or those replies would stay hidden.
  const clearedAt = all.reduce((latest, event) => event.kind === 'chat-cleared' && String(event.createdAt || '') > latest ? String(event.createdAt) : latest, '');
  const hideEarlier = Boolean(clearedAt) && !ui.showEarlier?.[runId];
  const hasEarlier = hideEarlier && all.some(event => String(event.createdAt || '') < clearedAt);
  const events = hideEarlier ? all.filter(event => String(event.createdAt || '') >= clearedAt) : all;
  const items = [], results = new Map(events.filter(event => event.kind === 'agent-tool-result').map(event => [event.id, event])), subs = new Map();
  let lastSwitch = null;
  for (const event of events) {
    if (event.kind === 'chat-cleared') { const item = { role: 'cleared', text: event.text, at: event.createdAt, earlier: hasEarlier, tokens: event.usage || event.tokens || null }; items.push(item); lastSwitch = item; continue; }
    // A sub-agent shows as one card: what it was asked, its steps, and what it reported back.
    if (event.kind === 'agent-tool' && event.tool === 'Agent') { const sub = { role: 'subagent', id: event.id, input: event.input || {}, steps: [], text: '', done: false, failed: false, at: event.createdAt }; subs.set(event.id, sub); if (!subs.has(event.parent)) items.push(sub); else subs.get(event.parent).steps.push({ tool: t('Agent'), input: { description: sub.input.description } }); continue; }
    if (event.parent && subs.has(event.parent)) { const sub = subs.get(event.parent); if (event.kind === 'agent-tool') sub.steps.push(event); else if (event.kind === 'subagent-text') sub.text = event.text; continue; }
    if (event.kind === 'subagent-text') continue;
    if (event.kind === 'subagent-done') { const sub = subs.get(event.id); if (sub) Object.assign(sub, { done: true, failed: event.failed, result: event.text, endedAt: event.createdAt }); continue; }
    if (['command-output', 'dev-output'].includes(event.kind)) continue;
    if (event.kind === 'human-message') { const said = spokenText(event.text); items.push({ role: 'human', text: said.text, voice: said.voice, at: event.createdAt, sequence: event.sequence }); }
    // Written in the Claude app while the chat was open there (Continue in Claude app).
    else if (event.kind === 'app-message') items.push({ role: 'human', text: event.text || '', at: event.createdAt, sequence: event.sequence });
    else if (event.kind === 'turn-start') items.push({ role: 'status', text: t`${event.resumed ? t('Resumed') : t('Started')} with ${provider(event.provider)}`, at: event.createdAt });
    else if (event.kind === 'loop-check') items.push({ role: 'status', text: event.text || t('Loop check'), at: event.createdAt });
    // The tokens of a reply show under the reply itself, like in a group chat.
    else if (event.kind === 'agent-result' && typeof event.usage === 'object' && tokenText(event.usage) && lastReply(items)) {
      lastReply(items).tokens = event.usage;
      if (lastSwitch && !lastSwitch.tokens && event.usage.input) { lastSwitch.tokens = event.usage; lastSwitch = null; }
    }
    else if (event.kind === 'agent-result') {
      items.push({ role: 'status', text: t`Turn ended${event.subtype && event.subtype !== 'success' ? ` · ${event.subtype}` : ''}${typeof event.usage === 'object' && tokenText(event.usage) ? ` · ${tokenText(event.usage)}` : ''}${event.cost && event.paidByApi === true ? ` · $${Number(event.cost).toFixed(2)}` : ''}`, at: event.createdAt });
      if (lastSwitch && !lastSwitch.tokens && typeof event.usage === 'object' && event.usage.input) { lastSwitch.tokens = event.usage; lastSwitch = null; }
    }
    else if (event.kind === 'message' || event.kind === 'agent-text') items.push({ role: 'agent', text: event.text || event.message || '', at: event.createdAt, uid: event.uid || '' });
    else if (event.kind === 'agent-tool' && ['desk_ask', 'desk_message', 'desk_elicit'].includes(event.tool)) continue; // shown as chat messages already
    else if (event.kind === 'agent-tool-result') continue;
    else if (event.kind === 'agent-tool') items.push({ role: 'tool', id: event.id, output: results.get(event.id), tool: event.tool, input: event.input, change: event.change, failed: event.failed, text: event.text, at: event.createdAt });
    else if (event.kind === 'error') items.push({ role: 'error', text: event.text || event.message || t('The run needs attention.'), at: event.createdAt });
    else if (['provider-switch', 'account-switched'].includes(event.kind)) { const item = { role: 'status', text: event.text || event.message || event.kind.replaceAll('-', ' '), at: event.createdAt, tokens: event.usage || event.tokens || null }; items.push(item); lastSwitch = item; }
    else if (event.visible) items.push({ role: 'status', text: event.text || event.message || event.kind.replaceAll('-', ' '), at: event.createdAt });
  }
  return items;
}
const UNSEND_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const bubble = ({ mine, name, time, html, voice = false, unsend = '', uid = '' }) => `<div class="msg ${mine ? 'mine' : ''}"${uid ? ` data-event="${esc(uid)}"` : ''}>${unsend ? `<button type="button" class="unsend" data-unsend="${unsend}" title="${t`Unsend`}" aria-label="${t`Unsend this message`}">${UNSEND_ICON}</button>` : ''}<div class="avatar">${esc(initials(name))}</div><div class="bubble"><div class="who"><strong>${esc(name)}</strong><span>${esc(time)}${voice ? ` ${micIcon()}` : ''}</span></div><div class="md">${html}</div>${mine ? '' : `<div class="msg-acts">${speakButton()}</div>`}</div></div>`;
// The reply as it is written (L56): the server sends the text so far of the block the agent is writing ("partial"); it shows in
// a bubble that grows under the chat, and goes away once the saved message is drawn, so it never shows twice.
const live = { runId: '', text: '', doneAt: 0, timer: 0, eventId: '' };
// The saved message a finished block became, found by the id the server sends with the finished block (never by its words).
const savedById = id => Boolean(id) && Boolean(document.querySelector(`#feed-inner .msg[data-event="${CSS.escape(id)}"]`));
// Lines sent only for Voice mode to say (a question's title, a desk_message) are not the reply being written: they never touch it.
function showLive({ runId, text = '', done = false, tool = '', eventId = '', voiceOnly = false }) {
  if (tool || voiceOnly || !runId || runId !== ctx.currentRunId()) return;
  if (live.runId !== runId) Object.assign(live, { runId, text: '', doneAt: 0, eventId: '' });
  if (done) {
    // A reply that comes whole (no words streamed first, as Codex may send it) gets no live copy: the saved message shows it.
    if (!live.text || live.doneAt) return;
    Object.assign(live, { doneAt: Date.now(), text: String(text || live.text), eventId: String(eventId || '') });
  } else Object.assign(live, { text: String(text || ''), doneAt: 0, eventId: '' });
  drawLive();
}
// The live bubble is built once per run; each new chunk swaps only the words inside it and puts the caret back at the end,
// so the bubble and its avatar never blink or change height for a frame.
function drawLive() {
  const box = document.getElementById('live-reply'); if (!box) return;
  clearTimeout(live.timer);
  const feed = document.getElementById('feed'), atEnd = feed && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const shown = live.runId === ctx.currentRunId() && live.text.trim();
  // A finished block leaves in the same redraw that draws its saved message (matched by id), so the feed never shrinks and
  // grows back. With no id, or if the saved message never comes (another chat was opened), it goes after 4 s anyway.
  const gone = !shown || (live.doneAt && (savedById(live.eventId) || Date.now() - live.doneAt > 4000));
  if (gone) { if (box.firstChild) { box.replaceChildren(); delete box.dataset.run; document.body.classList.remove('live-replying'); } if (live.doneAt) Object.assign(live, { text: '', doneAt: 0, eventId: '' }); return; }
  let md = box.querySelector('.msg.live .md');
  if (!md || box.dataset.run !== live.runId) {
    const run = runById(live.runId), name = run ? (personalAgent(run)?.name || provider(run.provider)) : t('Agent');
    box.innerHTML = `<div class="msg live"><div class="avatar">${esc(initials(name))}</div><div class="bubble"><div class="md"></div></div></div>`;
    box.dataset.run = live.runId; md = box.querySelector('.md'); md.dataset.src = '';
  }
  if (md.dataset.src !== live.text) {
    md.innerHTML = markdown(live.text); md.dataset.src = live.text;
    // The caret sits right after the last word, inside the last paragraph or list item, not on a line of its own.
    const caret = document.createElement('span'); caret.className = 'live-caret'; caret.setAttribute('aria-hidden', 'true');
    let last = md; while (last.lastElementChild && !['PRE', 'TABLE', 'IMG', 'BR', 'HR'].includes(last.lastElementChild.tagName)) last = last.lastElementChild;
    (last.tagName === 'CODE' && last.parentElement?.tagName !== 'PRE' ? last.parentElement : last).append(caret);
  }
  document.body.classList.add('live-replying');
  // The same scroll rule as the feed (L55): follow the newest words only at the bottom, and never cut a glide short.
  if (feed && ui.stick && atEnd && !ui.gliding) feed.scrollTop = feed.scrollHeight;
  if (live.doneAt) live.timer = setTimeout(drawLive, 500);
}
const typing = (name, caption = '') => `<div class="msg" aria-live="polite" aria-label="${t`${esc(name)} is typing`}"><div class="avatar">${esc(initials(name))}</div><div class="bubble typing"><span class="dots"><i></i><i></i><i></i></span>${caption ? `<span class="cap">${esc(caption)}</span>` : ''}</div></div>`;
const note = text => `<div class="note">${text}</div>`;
// Runs that are over. Any other run that is not working can still be closed, so a stuck run never blocks its task.
const FINISHED = ['ready_for_review', 'published', 'failed', 'stopped', 'interrupted', 'finished', 'qa_passed', 'qa_failed', 'qa_blocked'];
function decisionCard(item) {
  if (item.kind === 'file') return fileCard(item);
  if (item.kind === 'terminal') return signInCard(item);
  // Pictures waiting for the person's OK are looked at full size in Needs you.
  if (item.kind === 'review') return `<div class="qcard"><div class="qtitle">${esc(item.title || '')}</div><div class="row"><button type="button" class="btn small primary" data-open="inbox" data-id="">${t`Open in Needs you`}</button></div></div>`;
  const request = item.request || {}, run = runById(item.runId), properties = request.requestedSchema?.properties || {}, required = request.requestedSchema?.required || [];
  const saved = ui.qanswers.get(item.id) || {};
  const field = (key, property, needed) => {
    const attrs = `name="${esc(key)}" data-type="${esc(property.type || 'string')}" ${needed ? 'required' : ''}`;
    const control = property.type === 'boolean' ? `<div class="seg"><button type="button" data-seg="true">${t`Yes`}</button><button type="button" data-seg="false">No</button><input type="hidden" ${attrs.replace('required', '')}></div>`
      : `<input class="qinput" ${attrs} type="${['number', 'integer'].includes(property.type) ? 'number' : 'text'}" placeholder="${t`Type your answer…`}" autocomplete="off" value="${esc(saved[key] || '')}">`;
    const options = (property.options || (property.enum || []).map(label => ({ label }))).slice(0, 8);
    const suggestions = options.length ? `<div class="sugg" data-multi="${property.multiSelect ? 1 : 0}">${options.map((option, index) => `<button type="button" class="sugg-chip${String(saved[key] || '').split(', ').includes(option.label) ? ' on' : ''}" data-fill="${esc(option.label)}"><span class="num">${index + 1}</span><span class="txt"><b>${esc(option.label)}</b>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span></button>`).join('')}<div class="sugg-other">${t`Or type your own answer below`}</div></div>` : '';
    return `<label class="qfield"><span>${esc(property.title || key)}</span>${suggestions}${control}</label>`;
  };
  const list = [...Object.entries(properties).map(([key, property]) => field(key, property, required.includes(key))),
    ...(request.questions || []).map(question => field(question.id || question.question, { type: 'string', title: question.question, options: question.options, multiSelect: question.multiSelect }, true))];
  const many = list.length, ask = item.kind !== 'approval', detail = ask ? null : request.command || request.input || request;
  // Several questions come one at a time: answering one slides to the next.
  const slides = ask && many > 1, step = slides ? Math.min(ui.qstep.get(item.id) || 0, many - 1) : 0;
  const fields = slides ? `<div class="qslider">${list.map((html, index) => `<div class="qslide${index === step ? ' on' : ''}" data-slide="${index}">${html}</div>`).join('')}</div>` : list.join('');
  const progress = slides ? `<span class="qcount" data-qcount>${t`Question ${step + 1} of ${many}`}</span><span class="qdots" aria-hidden="true">${list.map((_, index) => `<i class="${index === step ? 'on' : index < step ? 'done' : ''}"></i>`).join('')}</span>` : '';
  return `<form class="card ask qcard${slides ? ' sliding' : ''}" data-interaction="${esc(item.id)}" data-count="${many}" data-step="${step}" ${slides ? 'novalidate' : ''}><div class="qhead"><span class="qdot"></span>${ask ? (slides ? progress : t('Question')) : t('Needs your OK')} · ${esc(runTitle(run))}</div><div class="qtext md">${markdown(String(item.title).replace(/mcp__[a-z0-9_]+?__/gi, ''))}</div>${detail ? `<pre>${esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 1500))}</pre>` : ''}${fields}
    <div class="row">${slides ? `<button type="button" class="btn small qback" data-qmove="-1" ${step ? '' : 'hidden'}>${t`Back`}</button><button type="button" class="send-btn wide qnext" data-qmove="1" ${step < many - 1 ? '' : 'hidden'}>${t`Next`}</button>` : ''}<button class="send-btn wide qsend" name="decision" value="accept" ${slides && step < many - 1 ? 'hidden' : ''}>${ask ? (many > 1 ? t('Send answers') : t('Send')) : t('Approve once')}</button>${request.allowAlways ? `<button class="btn small" name="decision" value="always" formnovalidate>${t`Always allow for this run`}</button>` : ''}<button class="btn small" name="decision" value="decline" formnovalidate>${ask ? t('Skip') : t('Decline')}</button>${slides ? `<small class="qhint">${t`Pick an answer or type one · Enter for next`}</small>` : ''}</div></form>`;
}

// ---------- stage ----------
function stageModel() {
  const { type, id } = ui.view, snap = ui.snap;
  if (type === 'room') return roomStage(ctx);
  if (type === 'tasks') return tasksStage(ctx);
  if (type === 'task') return taskStage(ctx);
  if (type === 'inbox') return inboxStage(ctx, { decisionCard, personalAgent, runTitle });
  if (type === 'specialist') return agentStage(ctx);
  if (type === 'devices') return devicesStage(ctx);
  if (type === 'market') return marketStage(ctx);
  if (type === 'monitor') return monitorStage(ctx);
  if (type === 'worktrees') return worktreesStage(ctx);
  if (type === 'net') return netStage(ctx);
  if (type === 'exp') return expStage(ctx);
  if (type === 'jev') return jevStage();
  if (type === 'split') return splitStage();
  if (type === 'person') { const graph = knowledgeView() === 'graph'; return { title: t('Knowledge'), meta: graph ? t('You, your agents and your second brain') : t('Your profile, from what the agents learned'), top: true,
    actions: `<div class="kg-switch" role="tablist" aria-label="${t`How to look at your knowledge`}"><button type="button" role="tab" aria-selected="${graph}" class="${graph ? 'on' : ''}" data-action="kg-view" data-view="graph">${t`Graph`}</button><button type="button" role="tab" aria-selected="${!graph}" class="${graph ? '' : 'on'}" data-action="kg-view" data-view="list">${t`List`}</button></div>`,
    feed: graph ? '<div class="kg" id="kg" data-keep="kg"></div>' : personPage() }; }
  if (type === 'project') {
    return { title: id, meta: t('Project memory'), feed: `<div class="page"><div class="row"><button class="btn primary small" data-action="spec-new">${t`Create agent for this project`}</button></div><div class="card"><div class="md">${markdown(ui.page || t('Loading…'))}</div></div></div>` };
  }
  const run = type === 'main' ? mainRun() : runById(id);
  if (!run && type === 'main') return welcomeStage();
  if (!run) {
    // A view saved on this computer can still point at an agent's deleted chat: start a new one, or show its card when its computer is off.
    const agent = type === 'run' ? (ui.snap.specialists || []).find(item => item.runId === id) : null;
    if (agent) { setTimeout(() => agent.remote ? open('specialist', agent.id) : void openAgentChat(ctx, agent)); return emptyStage(agent.remote ? t`${esc(agent.name)}'s chat is on ${esc(agent.device || 'another computer')}.` : t`Starting a new chat with ${esc(agent.name)}…`); }
    return emptyStage(t('That run is gone.'));
  }
  const shown = ui.events.get(run.id) || [], cleared = ui.showEarlier?.[run.id] ? '' : shown.reduce((latest, event) => event.kind === 'chat-cleared' && String(event.createdAt || '') > latest ? String(event.createdAt) : latest, '');
  const items = [...transcript(shown, run.id), ...(ui.snap.interactions || []).filter(item => item.runId === run.id && (!cleared || String(item.createdAt || item.at || '') >= cleared) && item.state !== 'pending').flatMap(answeredItem)].sort((left, right) => String(left.at).localeCompare(String(right.at))), live = ['starting', 'running'].includes(run.state) && !run.inApp; // a chat open in the Claude app waits for the person; it is not "typing"
  const feed = (items.length ? renderItems(items, run, live) : `<div class="empty"><h2>${esc(runTitle(run))}</h2><p>${ui.events.has(run.id) ? t('Nothing recorded yet.') : t('Loading the conversation…')}</p></div>`) + outboxHtml(run, shown)
    + pending(run.id).map(item => `<div class="msg qfloat"><div class="avatar">${esc(initials(provider(run.provider)))}</div>${decisionCard(item)}</div>`).join('') + (live ? typing(provider(run.provider), run.state === 'starting' ? t('Preparing…') : '') : '')
    // At the end, beside the composer: at the top of a long chat it sat above a thousand messages and nobody saw it.
    + splitCard(run);
  const shells = terminalItems(items), stop = (shells.length && !ui.termOpen ? `<button class="btn small" data-action="term-open">${t`Terminal (${shells.length})`}</button> ` : '') + (live || run.state === 'waiting' ? `<button class="btn small danger" data-action="stop">${t`Stop`}</button>` : !FINISHED.includes(run.state) ? `<button class="btn small danger" data-action="stop" title="${t`This run is not working. Close it so the task can get a new run.`}">${t`Close run`}</button>` : '');
  // A personal chat with an agent shows its profile and what was shared on the right; the terminal is one of those tabs.
  const personal = personalAgent(run);
  // The chat on screen, for the Pin button over pictures, files and links in its messages.
  ui.pinChat = personal ? `agent:${personal.id}` : null;
  const side = personal ? (ui.chatInfo === false ? '' : personalSide(run, personal, items, shells)) : shells.length && ui.termOpen ? terminalHtml(shells, { esc, hhmm }) : '';
  const take = !personal && !run.inApp && chatTakers(ctx, run).length ? `<button class="btn small" data-action="move-to-chat" title="${t`Make this run an agent's personal chat: click the agent to see this work and keep talking`}">${t`Move to chat`}</button> ` : '';
  const actions = take + appControl(run, live) + (personal ? `<button class="icon-btn head-add" data-action="chat-to-room" title="${t`Add agents: start a meeting with this agent and others`}" aria-label="${t`Add agents`}"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg></button> ${ui.chatInfo === false ? `<button class="btn small" data-action="chat-info">${t`Info`}</button> ` : ''}${live || run.state === 'waiting' ? `<button class="btn small danger" data-action="stop">${t`Stop`}</button>` : ''}` : run.inApp ? '' : stop);
  return { title: personal ? personal.name : runTitle(run), meta: personal ? '' : `${provider(run.provider)}${run.branch ? ` · ${run.branch}` : ''}`, chips: run.inApp ? `<span class="chip working">${t`In Claude app`}</span>` : personal ? '' : `<span class="chip ${stateTone(run)}">${esc(stateLabel(run))}</span>`, actions, feed, side, sideClass: personal ? 'info' : '',
    working: workingStates.includes(run.state), composer: { placeholder: composerHint(run, workingStates.includes(run.state)), mentions: [] } };
}
// Until the second brain is set up, the main agent's screen and About you offer to do it.
const brainBanner = () => ui.snap?.memory?.secondBrain === false ? `<div class="card brainbar"><div><b>${t`Your agents don't know your second brain yet.`}</b><span class="muted small">${t`${ui.snap.memory.brainCandidates?.length ? t` Found ${esc(ui.snap.memory.brainCandidates[0])}.` : ''} Rex Agent can set it up for all of them.`}</span></div><button class="btn primary small" data-action="brain-setup">${t`Set it up`}</button></div>` : '';
const quick = (label, text) => `<button class="chip-btn" data-action="quick" data-text="${esc(text)}">${esc(label)}</button>`;
// Three ways to start, one per kind of work. Each sends Rex Agent a first message that has it set up the projects or agents
// itself, in the chat, so nobody needs Settings. The messages stay in English: they are prompts for the agent.
const STARTERS = [
  { label: t('Developer'), example: t('Connect my code project and fix a bug'), icon: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    text: 'I am a developer. Help me connect my code project and fix a bug. Ask me where the project is (a folder on this computer or a GitHub link), add it to Rex Desk, set up an agent for it, then let us find and fix the bug together.' },
  { label: t('Media and marketing'), example: t('Video editing, images, social posts, a campaign'), icon: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9.5 5 2.5-5 2.5z"/>',
    text: 'I work in media and marketing: video editing, images, social posts and campaigns. Ask me a few short questions about my work, set up the agents and folders I need here yourself, then help me with my first piece of work.' },
  { label: t('Other work'), example: t('HR, admin, finance or sales: "draft a job post", "organize my week"'), icon: '<rect x="3.5" y="7" width="17" height="12.5" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17"/>',
    text: 'My work is outside IT (for example HR, admin, finance or sales). Ask me what I do, set up an agent that helps with it yourself, then help me with a first job, like drafting a job post or organizing my week.' },
];
const starter = item => `<button type="button" class="starter" data-action="quick" data-text="${esc(item.text)}"><span class="starter-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.icon}</svg></span><span class="starter-text"><b>${esc(item.label)}</b><small>${esc(item.example)}</small></span><svg class="starter-go" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>`;
const welcomeStage = () => ({ title: t('Rex'), meta: t('Rex Agent'), start: true,
  feed: `${brainBanner()}<div class="welcome">${rexCore('xl', (ui.snap?.specialists || []).filter(agent => agent.kind !== 'main').length)}<h2>${t`Hi, I am Rex`}</h2><p>${t`Tell me what you work on and I set everything up for you. Pick a start, or just type.`}</p><div class="starters">${STARTERS.map(starter).join('')}</div></div>`,
  composer: { placeholder: t('Message Rex…'), mentions: [] } });
// The chat is not drawn again from nothing when something changes: only the messages that differ are swapped, and new
// ones are added at the end. Messages already on screen stay as they are (a playing video, selected text, an open step).
let feedHtml = '';
// Graph or list on the Knowledge screen; remembered on this computer.
const knowledgeView = () => { try { return localStorage.getItem('rex-knowledge-view') === 'list' ? 'list' : 'graph'; } catch { return 'graph'; } };
function patchFeed(inner, html, full) {
  if (!full && html === feedHtml && inner.childElementCount) return false;
  feedHtml = html;
  const next = document.createElement('template'); next.innerHTML = html;
  const want = [...next.content.childNodes], have = [...inner.childNodes];
  if (full || !have.length) { inner.replaceChildren(...want); return true; }
  return patchChildren(inner, want, have);
}
// An element marked data-keep (the graph's canvas lives in one) is kept as it is while its mark stays the same. An element
// marked data-patch (the Needs you list and pane) keeps itself and patches its children one by one, so a change in the list
// leaves a playing video in the pane alone.
function patchChildren(inner, want, have = [...inner.childNodes]) {
  const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType === 1 ? (a.dataset.keep && a.dataset.keep === b.dataset.keep) || a.outerHTML === b.outerHTML : a.nodeValue === b.nodeValue);
  const nested = (a, b) => a.nodeType === 1 && b.nodeType === 1 && a.tagName === b.tagName && b.hasAttribute('data-patch') && a.hasAttribute('data-patch');
  let changed = false;
  for (let index = 0; index < want.length; index++) {
    const old = have[index], fresh = want[index];
    if (!old) { inner.append(fresh); changed = true; }
    else if (same(old, fresh)) continue;
    else if (nested(old, fresh)) {
      for (const { name } of [...old.attributes]) if (!fresh.hasAttribute(name)) { old.removeAttribute(name); changed = true; }
      for (const { name, value } of [...fresh.attributes]) if (old.getAttribute(name) !== value) { old.setAttribute(name, value); changed = true; }
      if (patchChildren(old, [...fresh.childNodes])) changed = true;
    } else { old.replaceWith(fresh); changed = true; }
  }
  for (let index = want.length; index < have.length; index++) { have[index].remove(); changed = true; }
  return changed;
}
// Staying at the newest message: a new reply glides into view; a first draw or a switch of chat jumps there at once.
// A reply that grew during the glide is caught up when it ends, if the reader is still following.
function followFeed(feed, glide) {
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches, gap = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
  if (glide && !calm && gap > 4 && gap < feed.clientHeight * 1.5) { ui.gliding = true; clearTimeout(ui.glideTimer); ui.glideTimer = setTimeout(() => { ui.gliding = false; if (ui.stick && feed.isConnected) feed.scrollTop = feed.scrollHeight; }, 700); feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }); }
  else feed.scrollTop = feed.scrollHeight;
}
const emptyStage = text => ({ title: t('Rex Desk'), meta: '', feed: `<div class="empty"><h2>${t`Nothing here`}</h2><p>${text}</p></div>` });

function renderStage(full) {
  const model = stageModel(), stage = document.getElementById('stage');
  // Rex Agent's chat carries the setup checklist until everything is set up.
  if (ui.view.type === 'main') { model.banner = setupHtml(ctx) + (model.banner || ''); if (model.banner && !ui.accounts && !ui.setupAccounts) { ui.setupAccounts = true; void loadAccounts().then(() => renderAll()); } }
  const head = `<div class="stage-head"><button type="button" class="pane-toggle" data-pane="rail" aria-pressed="true" aria-label="${t`Show or hide the list`}" title="${t`Show or hide the list (Ctrl+B)`}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><rect class="fill" x="3" y="4" width="6.5" height="16" rx="3" fill="currentColor" stroke="none" opacity=".55"/><path d="M9.5 4v16"/></svg></button><button class="m-menu" data-action="m-rail" aria-label="${t`Back to the list`}"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button><div class="head-title"><h1>${esc(model.title)}</h1><span class="meta">${esc(model.meta || '')}</span>${model.chips || ''}</div><span class="spacer"></span><div class="head-actions">${model.composer && ['run', 'main', 'room'].includes(ui.view.type) ? readAloudButton(draftKey()) + voiceModeButton(draftKey()) : ''}${model.actions || ''}</div><button type="button" class="pane-toggle" data-pane="side" aria-pressed="true" aria-label="${t`Show or hide the side panel`}" title="${t`Show or hide the side panel (Ctrl+.)`}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><rect class="fill" x="14.5" y="4" width="6.5" height="16" rx="3" fill="currentColor" stroke="none" opacity=".55"/><path d="M14.5 4v16"/></svg></button></div>`;
  // A view that needs the message box always gets it, even when an earlier view had none.
  if (full || !document.getElementById('feed') || Boolean(model.composer) !== Boolean(document.getElementById('composer'))) {
    stage.innerHTML = `<div class="stage-main"><div><div id="head">${head}</div><div id="members">${model.members || ''}</div></div><div id="banner"></div><div class="feed" id="feed"><div class="feed-inner" id="feed-inner"></div><div class="feed-inner live-reply" id="live-reply" aria-live="polite"></div></div>${model.composer ? composerHtml(ctx, model) : '<div></div>'}${model.top ? '' : `<button type="button" class="to-end" id="to-end" hidden aria-label="${t`Go to the newest messages`}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg><span class="to-end-new">${t`New messages`}</span></button>`}</div><aside class="side" id="side"></aside>`;
    ui.stick = !model.top; redrawAttachments(ctx); if (model.top) document.getElementById('feed').scrollTop = 0;
  } else { document.getElementById('head').innerHTML = head; const slot = document.getElementById('members'); if (!slot.contains(document.activeElement) && !pickerOpen()) slot.innerHTML = model.members || ''; }
  // The hint in the message box follows the AI picked under it without redrawing what is typed.
  const draftBox = document.getElementById('draft'); if (draftBox && model.composer?.placeholder && draftBox.placeholder !== model.composer.placeholder) draftBox.placeholder = model.composer.placeholder;
  document.getElementById('feed').className = `feed ${model.feedClass || ''}`;
  // A chat with nothing said yet (Rex's welcome): the message box sits under it in the middle, and drops to the bottom after the first message.
  document.querySelector('#stage .stage-main')?.classList.toggle('start', Boolean(model.start));
  const banner = document.getElementById('banner'); if (banner && banner.innerHTML !== (model.banner || '')) banner.innerHTML = model.banner || '';
  drawSide(model.side || '', model.sideClass || '');
  const feed = document.getElementById('feed'), inner = document.getElementById('feed-inner');
  // Someone typing in an approval form keeps their text: the feed is not redrawn under them.
  // A form that is gone from the new view (it was answered) never holds the redraw back.
  const active = document.activeElement, form = active?.closest?.('[data-interaction]');
  const editing = !full && feed.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName) && (!form || model.feed.includes(`data-interaction="${form.dataset.interaction}"`));
  const choosing = pickerOpen();
  if (!editing && !choosing) { const changed = patchFeed(inner, model.feed, full); if (ui.stick && !model.top) followFeed(feed, changed && !full); else if (changed && feed.scrollHeight > ui.feedHeight) ui.freshBelow = true; ui.feedHeight = feed.scrollHeight; }
  syncToEnd();
  ui.mentions = model.composer?.mentions || [];
  syncVoiceStage();
  drawLive();
}
// Voice mode's screen: Rex's body over the chat, nothing else but a faint way out (or Esc). It is made once and kept
// (re-attached after a redraw), so its animation never restarts. What it shows comes from what is happening right now.
let voiceStage = null, voiceOrb = null, voiceBeat = 0;
// While the body is on screen it says so every two seconds (this window and the split view's panes read it): no
// notification pop-ups or sounds talk over the voice.
const voiceLive = () => { try { localStorage.setItem('rex-voice-live', String(Date.now())); } catch { /* private window */ } };
function closeVoiceStage() {
  clearInterval(voiceBeat); voiceBeat = 0; try { localStorage.removeItem('rex-voice-live'); } catch { /* private window */ }
  voiceOrb?.destroy(); voiceStage?.remove(); voiceStage = voiceOrb = null;
}
// The agent is writing a reply the person waits for. Its quiet turn reading Voice mode's report does not count: the mic
// opens right after the welcome, and what the person says reaches the agent as soon as it has read.
function agentWriting() {
  if (!document.querySelector('#feed-inner .bubble.typing')) return false;
  return !runById(ctx.currentRunId())?.voice?.reading;
}
function voiceNow() {
  const heard = voiceListening();
  // "Speaking" only while sound is coming out; while a sentence's voice is still being made it is "Thinking".
  if (speechPlaying()) return { state: 'speaking', level: outputLevel() };
  if (!speechIdle()) return { state: 'thinking', level: 0 };
  if (heard.listening) return { state: 'listening', level: heard.level };
  if (heard.transcribing || agentWriting()) return { state: 'thinking', level: 0 };
  return { state: 'idle', level: 0 };
}
// The badge under the body says plainly whether to talk: green "Listening, go ahead" only while the mic is open.
const VOICE_WORDS = { idle: t('One moment'), listening: t('Listening, go ahead'), thinking: t('Thinking'), speaking: t('Speaking') };
const MIC_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
// A soft short tone each time the mic opens, so the person knows when to talk without looking.
let voiceTone = null;
function micOpenTone() {
  try {
    voiceTone ||= new (window.AudioContext || window.webkitAudioContext)();
    if (voiceTone.state !== 'running') void voiceTone.resume();
    const at = voiceTone.currentTime, tone = voiceTone.createOscillator(), gain = voiceTone.createGain();
    tone.type = 'sine'; tone.frequency.setValueAtTime(880, at); tone.frequency.exponentialRampToValueAtTime(1320, at + 0.09);
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    tone.connect(gain).connect(voiceTone.destination); tone.start(at); tone.stop(at + 0.25);
  } catch { /* no sound: the badge still shows it */ }
}
function syncVoiceStage() {
  const main = document.querySelector('#stage .stage-main'), on = Boolean(main) && voiceModeOn(draftKey()) && Boolean(ctx.currentRunId());
  if (!on) {
    if (voiceStage) { void api(`/runs/${voiceStage.dataset.run}/voice`, { method: 'POST', data: { on: false } }).catch(() => {}); closeVoiceStage(); }
    return;
  }
  if (voiceStage && voiceStage.dataset.run !== ctx.currentRunId()) { closeVoiceStage(); }
  if (!voiceStage) {
    voiceStage = document.createElement('div'); voiceStage.className = 'voice-stage'; voiceStage.dataset.run = ctx.currentRunId();
    // The briefing is made now, while the body opens (code, not AI): the first question is answered from it at once.
    void api(`/runs/${voiceStage.dataset.run}/voice`, { method: 'POST', data: { on: true } }).catch(() => {});
    voiceStage.innerHTML = `<button type="button" class="voice-exit" data-action="voice-mode" aria-label="${t`End voice mode`}" title="${t`End voice mode (Esc)`}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button><div class="voice-cue" data-state="idle" role="status" aria-live="polite"><span class="vc-dot" aria-hidden="true"></span>${MIC_ICON}<span class="vc-text">${t`One moment`}</span></div>`;
    const cue = voiceStage.querySelector('.voice-cue'), word = cue.querySelector('.vc-text');
    voiceLive(); voiceBeat = setInterval(voiceLive, 2000);
    // The welcome is said by Rex Desk itself the moment the body has formed (about 2.3 s), not written by the AI, which
    // takes a few seconds more; the mic opens after it.
    welcome(welcomeLine(), performance.now() + 2300); voiceRest = Date.now() + 3200;
    voiceOrb = mountOrb(voiceStage, () => {
      const now = voiceNow(), text = VOICE_WORDS[now.state];
      if (cue.dataset.state !== now.state) { if (now.state === 'listening') micOpenTone(); cue.dataset.state = now.state; word.textContent = text; }
      // The dot grows with the person's voice while it listens, so they can see it hears them.
      cue.style.setProperty('--level', now.state === 'listening' ? Math.min(1, now.level).toFixed(2) : '0');
      return now;
    });
  }
  if (voiceStage.parentElement !== main) main.append(voiceStage);
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && voiceStage && voiceModeOn(draftKey())) { toggleVoiceMode(draftKey()); cancelVoiceTurn(); stopLive(); renderAll(); } });
// The terminal panel keeps its scroll place unless it was at the bottom, where it follows the newest command.
function drawSide(html, extra = '') {
  const side = document.getElementById('side'); if (!side) return;
  // The Terminal shows the newest at the top, so it pins to the top (not the bottom): a fresh open, and new commands
  // arriving while the reader is already at the top, both keep the newest in view. If the reader scrolled down to read
  // older commands, their place is kept instead.
  const body = document.getElementById('side-body'), keep = body ? { top: body.scrollTop, atTop: body.scrollTop < 40 } : { top: 0, atTop: true };
  if (side.dataset.html !== html) { side.innerHTML = html; side.dataset.html = html; }
  side.className = `side${html ? ' on' : ''} ${extra}`.trim();
  const fresh = document.getElementById('side-body'); if (fresh) fresh.scrollTop = keep.atTop ? 0 : keep.top;
}
const draftKey = () => `${ui.view.type}:${ui.view.id || ''}`;
// The message box names the AI the next message goes to: the one picked under the box, else the chat's own.
function composerHint(run, working) {
  // Local AI runs through Claude Code: switching between them keeps the same conversation.
  const picked = ui.providerPick?.[draftKey()], next = picked === 'local' ? 'claude' : picked || (run.provider === 'codex' ? 'claude' : run.provider);
  const name = id => (id === 'claude' && (picked === 'local' || (!picked && String(run.model || '').startsWith('local:'))) ? t('Local AI') : provider(id));
  if (working) return t`Message ${name(run.provider)}…`;
  return next !== run.provider ? t`Message ${name(next)}. It takes over from ${provider(run.provider)} with the chat so far…` : t`Message ${name(next)}. It picks up where it left off…`;
}

function renderAll(full = false) {
  queueMicrotask(drawReplyBar);
  queueMicrotask(() => readNewReplies(draftKey()));
  if (!ui.snap) return;
  // On a phone Rex Desk opens on the list, like a messaging app; a chat slides in over it and the back arrow returns.
  if (!document.getElementById('rail')) ui.railHtml = '', app.innerHTML = `<div class="chat-shell${phone() && !location.hash ? ' show-rail' : ''}"><aside class="rail" id="rail"></aside><main class="stage" id="stage"></main></div>`;
  const rail = document.getElementById('rail'), scroll = rail.querySelector('.rail-scroll')?.scrollTop || 0;
  // The sidebar is rebuilt only when something in it changed.
  // While the person types in the phone search box, only the list under it is redrawn, so the box keeps its focus.
  const railHtml = renderRail(); if (railHtml !== ui.railHtml) { ui.railHtml = railHtml;
    if (document.activeElement?.id === 'm-search' && rail.querySelector('.rail-scroll')) { const fresh = document.createElement('div'); fresh.innerHTML = railHtml; rail.querySelector('.rail-scroll').replaceWith(fresh.querySelector('.rail-scroll')); }
    else rail.innerHTML = railHtml;
    const restored = rail.querySelector('.rail-scroll'); if (restored) restored.scrollTop = scroll; filterChats();
    // The agent filter keeps hiding what does not match, and keeps the cursor if the person was typing in it.
    applyFilter(rail, ui.agentFilter);
    if (ui.filterFocused) { const box = rail.querySelector('[data-rail-filter]'); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } } }
  renderStage(full);
  if (ui.profileId) { if ((ui.snap.specialists || []).some(item => item.id === ui.profileId)) drawProfile(); else closeProfile(); }
  fillWorktreeEmbeds(ctx);
  if (ui.view.type === 'worktrees' && ui.view.id && ui.wtFocused !== ui.view.id) { const card = document.querySelector(`.wt-page [data-wt-id="${CSS.escape(ui.view.id)}"]`); if (card) { ui.wtFocused = ui.view.id; card.classList.add('focus'); card.scrollIntoView({ block: 'center' }); } }
}

// ---------- data ----------
async function loadView(early = null) {
  const { type, id } = ui.view;
  try {
    if (type === 'main' || type === 'run') {
      const run = type === 'main' ? mainRun() : runById(id); if (!run) return;
      const events = await (early && type === 'run' ? early : api(`/runs/${run.id}/messages${historyQuery(run.id)}`)); ui.events.set(run.id, events);
    } else if (type === 'room') {
      const room = ui.snap.rooms.find(item => item.id === id);
      if (room && ui.infoOpen !== false && ['activity', 'subagents', 'team', 'terminal'].includes(ui.sideTab)) await Promise.all(roomRunIds(ui, room).map(async runId => ui.events.set(runId, await api(`/runs/${runId}/messages`).catch(() => []))));
    } else if (type === 'net') { await loadNet(ctx);
    } else if (type === 'exp') { if (expTab(ui) === 'a2a') await loadNet(ctx);
    } else if (type === 'market') { await loadMarket(ctx);
    } else if (type === 'worktrees') { await api('/worktrees');
    } else if (type === 'monitor') { ui.monitor = await api('/monitor'); 
    } else if (type === 'person') { ui.page = (await api('/memory/page?name=user')).text; }
    else if (type === 'project') ui.page = (await api(`/memory/page?name=${encodeURIComponent(id)}`)).text;
  } catch (error) { if (type === 'project') ui.page = error.message; }
}
let busy = false, again = false, againFull = false, lastTyped = 0, typingHold = 0;
// The last message sent to the agent in each chat, so Escape (stop) can drop it back into the input to edit and resend.
const lastSent = new Map();
// While the person types, the page is not redrawn: a redraw of a long chat takes the main thread and the letters lag.
// Updates wait until they pause for a moment, then everything catches up at once.
document.addEventListener('input', event => { if (event.target.id === 'draft' || event.target.closest?.('#composer')) lastTyped = performance.now(); }, true);
async function refresh({ full = false } = {}) {
  const sinceTyping = performance.now() - lastTyped;
  if (!full && sinceTyping < 1200) { clearTimeout(typingHold); typingHold = setTimeout(() => void refresh().catch(() => {}), 1250 - sinceTyping); return; }
  // A refresh asked for while one is running comes after it, and a full one (another chat was opened) stays full.
  if (busy) { again = true; againFull ||= full; return; } busy = true;
  try {
    // Everything the page needs is asked for at once, not one after another: opening a chat waited for four answers in a row.
    const view = ui.view, early = view.type === 'run' ? api(`/runs/${view.id}/messages${historyQuery(view.id)}`, { timeout: 15000 }).catch(() => null) : null;
    // The live refresh gives up after 15 s so one slow answer never freezes later updates; the first load has nothing to show
    // yet, so it waits up to 90 s (a whole state over a slow relay can take longer than 15 s).
    // A link that is always slow (the phone over a relay) gets twice the time its last whole answer took, up to 90 s.
    const wait = ui.snap?.runs ? Math.min(90000, Math.max(15000, (ui.stateMs || 0) * 2)) : 90000, asked = Date.now();
    const [snap, memory, profile] = await Promise.all([api('/state', { timeout: wait }).then(answer => { ui.stateMs = Date.now() - asked; return answer; }), api('/memory', { timeout: wait }).catch(() => ui.memory), api('/profile', { timeout: wait }).catch(() => ui.profile)]);
    if (!snap || !Array.isArray(snap.runs)) throw new Error(t('The answer from your computer was cut off. Trying again.'));
    ui.snap = snap;
    // The server restarted on new code: load the new page too, so it never asks for a file or route the old one lacked.
    if (ui.snap.code && ui.code && ui.snap.code !== ui.code) { location.reload(); return; } ui.code ||= ui.snap.code; ui.memory = memory; ui.profile = profile;
    await loadView(view === ui.view && early ? early.then(events => events || api(`/runs/${view.id}/messages${historyQuery(view.id)}`)) : null); renderAll(full); maybeStartTour(ctx); if (!window.__starWatch && !document.documentElement.classList.contains('embed')) { window.__starWatch = true; watchForStar(); } if (!window.__pinWatch) { window.__pinWatch = true; watchMessagePins(ctx); } showUpdateCard(ui.snap.update); showSyncNote(ui.snap.cloudSync); initSidebarDrag(ctx); if (ui.snap.update?.supported) watchForUpdates(api); watchNotices(ctx); watchShownFile(ctx); watchFileWindow(ctx);
  } finally { busy = false; if (again) { const wasFull = againFull; again = false; againFull = false; void refresh({ full: wasFull }); } }
}
// A chat opened is drawn at once from what the page already holds (its messages from the last visit), and brought up to
// date a moment later; before, the screen stayed on the old chat until the server had answered everything.
function showNow() {
  const { type, id } = ui.view; if (!ui.snap) return;
  const run = type === 'main' ? mainRun() : type === 'run' ? runById(id) : null;
  if (['main', 'run'].includes(type) && !(run && ui.events.has(run.id))) return;
  if (!['main', 'run', 'room'].includes(type)) return;
  try { renderAll(true); } catch { /* the refresh below draws it */ }
}
// The last chat that was open, for a file dropped while none is (chat-composer.js), also when it was opened from the address bar.
const rememberChat = view => { if (['main', 'run', 'room'].includes(view?.type) && !document.documentElement.classList.contains('embed')) try { localStorage.setItem('rex-last-chat', JSON.stringify(view)); } catch { /* private window */ } };
rememberChat(ui.view);
window.addEventListener('hashchange', () => rememberChat(viewFromHash()));
function open(type, id = '') {
  ui.view = { type, id }; ui.page = ''; window.rexView = noticeKey(ui.view); window.rexPresence?.();
  if (!document.documentElement.classList.contains('embed')) try { localStorage.setItem('rex-desk-view', JSON.stringify(ui.view));} catch { /* private window */ }
  rememberChat(ui.view);
  if (location.hash !== hashOf(ui.view)) { ui.fromOpen = true; location.hash = hashOf(ui.view); } document.querySelector('.chat-shell')?.classList.remove('show-rail'); showNow(); void refresh({ full: true }); }

// ---------- actions ----------
let voiceRest = 0;
const voiceQuiet = { since: 0, asked: false };
// A question from a page (Market "What is this?") goes to Rex Agent's chat as the person's message, and that chat opens.
async function askMain(text) {
  const run = mainRun();
  if (run) await api(`/runs/${run.id}/${workingStates.includes(run.state) ? 'say' : 'resume'}`, { method: 'POST', data: workingStates.includes(run.state) ? { text } : { prompt: text } });
  else await api('/main', { method: 'POST', data: { prompt: text } });
  open('main'); await refresh();
}
async function send() {
  const box = document.getElementById('draft'), typed = box?.value.trim(), hasFiles = ui.attachments.some(file => file.path);
  if (!typed && !hasFiles) return;
  if (ui.attachments.some(file => !file.path)) return toast(t('Wait for the upload to finish.'), true);
  // Dictated words may be misheard: the agent is told, quietly, so it reads them against the conversation.
  const spoken = ui.voiceDrafts?.has(draftKey()) ? VOICE_NOTE : '';
  const text = `${typed || t('See the attached files.')}${attachmentText(ctx)}${spoken}`, picked = pickedOptions(ctx);
  // Local AI with no model on this computer yet: the message would go to Claude instead, so it waits for the setup.
  if (document.getElementById('opt-provider')?.value === 'local' && !picked.model) return toast(t('Open Settings, Local AI, and press Set up: it installs Ollama and a starter model.'), true);
  // A dictation still listening ends here, so its words never come back into the box once it is cleared.
  endDictation();
  const { type, id } = ui.view; box.disabled = true; ui.voiceDrafts?.delete(draftKey());
  try {
    if (type === 'jev') { box.value = ''; ui.drafts.set(draftKey(), ''); void jevDo(typed); }
    else if (type === 'room' && /^\/assign\b/i.test(typed)) await assignFromRoom(id, typed);
    else if (type === 'room') { const replyTo = ui.reply?.roomId === id ? ui.reply.id : ''; await api(`/rooms/${id}/messages`, { method: 'POST', data: { text, ...(replyTo ? { replyTo } : {}) } }); ui.reply = null; drawReplyBar(); }
    else if (type === 'main' && !mainRun()) await api('/main', { method: 'POST', data: { prompt: text, ...picked } });
    else {
      const run = type === 'main' ? mainRun() : runById(id);
      // Always show the message the moment it is sent, with a status, so it never just vanishes: "starting here" for an
      // agent on this computer, "sending to <device>" for one on another. The bubble clears itself once the message lands.
      const away = { text, at: new Date().toISOString(), local: !run.remote };
      (ui.outbox ||= new Map()).set(run.id, [...(ui.outbox.get(run.id) || []), away]); box.value = ''; renderAll();
      try {
        // Spoken in Voice mode: always through "say", which gives the agent its briefing and how to talk.
        const spoken = ui.voiceNext; ui.voiceNext = false;
        if (spoken) await api(`/runs/${run.id}/say`, { method: 'POST', data: { text, ...picked, voice: true } });
        else if (workingStates.includes(run.state)) await api(`/runs/${run.id}/say`, { method: 'POST', data: { text, ...picked } });
        else await api(`/runs/${run.id}/resume`, { method: 'POST', data: { prompt: text, ...picked } });
      } catch (error) { ui.outbox.set(run.id, (ui.outbox.get(run.id) || []).filter(item => item !== away)); box.value = typed; throw error; }
      away.sent = true;
    }
    if ((type === 'main' || type === 'run') && typed) lastSent.set(draftKey(), typed);
    box.value = ''; box.style.height = ''; ui.drafts.delete(draftKey()); ui.attachments = []; redrawAttachments(ctx); await refresh();
  } catch (error) { toast(error.message, true); }
  finally { box.disabled = false; box.focus(); }
}
// /assign @agent #task: gives a task to an agent from the room.
async function assignFromRoom(roomId, command) {
  const room = ui.snap.rooms.find(item => item.id === roomId), handle = /@([\p{L}\p{N}_-]+)/u.exec(command)?.[1]?.toLowerCase(), number = /#(\d{2,})/.exec(command)?.[1];
  const member = room?.members.find(item => item.handle.toLowerCase() === handle || item.name.toLowerCase() === handle), task = (ui.snap.tasks || []).find(item => String(item.taskNumber) === number || String(item.externalId) === number);
  if (!member) throw new Error(t('Name an agent in this room: /assign @agent #task'));
  if (!task) throw new Error(t('Name a task by its number: /assign @agent #49760'));
  const given = await api(`/specialists/${member.id}/assign`, { method: 'POST', data: { taskId: task.id, roomId } }); if (given?.queued) toast(given.message);
  toast(t`${member.name} is on it.`);
}
async function syncIssues() { toast(t('Syncing issues…')); await api('/sync', { method: 'POST', data: {} }); toast(t('Issues synced.')); await refresh(); }
async function scanProjects() { toast(t('Scanning this computer for projects…')); const result = await api('/memory/scan', { method: 'POST', data: {} }); toast(t`Found ${result.count} projects.`); await refresh(); }
// /clear: the agent writes nothing itself; Rex Desk saves a summary of the conversation and the next message starts a fresh session that reads it.
// /loop: the agent looks at its own tasks now, the same as its scheduled check.
async function loopNow() {
  const run = ui.view.type === 'run' ? runById(ui.view.id) : null, agentId = run?.specialistId;
  if (!agentId) return toast(t('Open an agent\'s chat to run its loop.'), true);
  const box = document.getElementById('draft'); if (box) { box.value = ''; ui.drafts.set(draftKey(), ''); }
  await api(`/specialists/${agentId}/loop`, { method: 'POST', data: {} }); toast(t('Checking its tasks now.')); await refresh();
}
async function clearAgent() {
  const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); if (!run) return toast(t('No agent conversation here.'), true);
  // The chat may change while the box is up, so clear only the draft of the chat that asked.
  const key = draftKey();
  if (!await askConfirm(t('Clear this conversation? The agent starts fresh with your next message and reads a summary of what was said. The messages stay on screen.'))) return;
  ui.drafts.set(key, ''); const box = document.getElementById('draft'); if (box && draftKey() === key) box.value = '';
  await api(`/runs/${run.id}/fresh`, { method: 'POST', data: {} }); toast(t('Cleared. Your next message starts a fresh session.')); await refresh();
}
async function stopAgent() { const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); if (!run) return toast(t('No agent to stop here.'), true); await api(`/runs/${run.id}/stop`, { method: 'POST', data: {} }); await refresh(); }
// Escape stops the working agent in the open chat and drops your last message back into the input to edit and resend,
// the way Claude Code does. It steps aside for the menus and panels that already use Escape (a slash/@ menu, the reply
// bar, Voice mode, an open popup), and only acts while an agent is actually working here.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (ui.menu || ui.reply || voiceModeOn(draftKey())) return;
  // Stay out of the way when the reader is in another input or a dialog; act only from the chat itself or its composer.
  const active = document.activeElement;
  if (active && active !== document.body && active.id !== 'draft' && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.closest('.popup, .dialog, dialog, [role="dialog"], [aria-modal="true"]'))) return;
  if (!['main', 'run'].includes(ui.view.type)) return;
  const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id);
  if (!run || !workingStates.includes(run.state)) return;
  event.preventDefault();
  const box = document.getElementById('draft'), back = lastSent.get(draftKey());
  if (box && back && !box.value.trim()) { box.value = back; ui.drafts.set(draftKey(), back); box.style.height = 'auto'; box.style.height = `${Math.min(200, box.scrollHeight)}px`; box.focus(); }
  lastSent.delete(draftKey());
  void stopAgent().catch(error => toast(error.message, true));
});
function newRoomDialog() { openRoomDialog(ctx); }
// The full profile as a popup (wide screens): the same page, drawn inside a sheet over the chat, redrawn when the data changes
// unless the person is typing or has unsaved rules in it.
function drawProfile() {
  const back = document.querySelector('.agp-modal'), sheet = back?.querySelector('.agp-sheet'); if (!sheet) return;
  const active = document.activeElement, busy = sheet.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
  // Unsaved rules are kept as a draft and put back when the Profile tab is drawn again, so a tab switch never loses them.
  const rules = sheet.querySelector('#sp-rules'), dirty = Boolean(sheet.querySelector('.ag-save button:not([disabled])'));
  if (rules) ui.rulesDraft = dirty ? rules.value : undefined;
  if ((busy || dirty) && !ui.profileForce) return;
  ui.profileForce = false;
  const body = sheet.querySelector('.agp-scroll'), top = body.scrollTop, html = agentStage(ctx, ui.profileId).feed;
  if (body.dataset.html === html) return; body.dataset.html = html; body.innerHTML = html; body.scrollTop = top;
  const box = body.querySelector('#sp-rules'); if (box && ui.rulesDraft !== undefined && ui.rulesDraft !== box.value) { box.value = ui.rulesDraft; const save = body.querySelector('.ag-save button'); if (save) save.disabled = false; }
}
function closeProfile() { document.querySelector('.agp-modal')?.remove(); ui.profileId = ''; ui.rulesDraft = undefined; }
function showProfile(id) {
  closeProfile(); ui.profileId = id; ui.agentTab = 'about';
  const back = document.createElement('div'); back.className = 'agp-modal';
  back.innerHTML = `<div class="agp-sheet" role="dialog" aria-modal="true" aria-label="${t`Agent profile`}"><button type="button" class="agp-close" aria-label="${t`Close`}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button><div class="agp-scroll"></div></div>`;
  back.addEventListener('mousedown', event => { if (event.target === back) closeProfile(); });
  back.querySelector('.agp-close').addEventListener('click', closeProfile);
  document.body.append(back); drawProfile(); back.querySelector('.agp-close').focus();
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.querySelector('.agp-modal') && !document.querySelector('.dialog-back')) closeProfile(); });
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-open],[data-action]'); if (!target) return;
  if (target.dataset.open) {
    event.preventDefault();
    // An agent you already chat with opens that chat, like a messenger; its profile is on the right ("Edit profile" opens the card).
    if (target.dataset.open === 'specialist' && !target.dataset.profile) {
      const agent = (ui.snap.specialists || []).find(item => item.id === target.dataset.id);
      if (agent?.runId && runById(agent.runId)) return open('run', agent.runId);
      if (savedChatGone(ctx, agent) && !agent.remote) return openAgentChat(ctx, agent);
    }
    // On a wide screen the full profile is a popup over the chat; the chat stays as it was.
    if (target.dataset.open === 'specialist' && target.dataset.profile && !phone() && ui.view.type !== 'specialist' && (ui.snap.specialists || []).some(item => item.id === target.dataset.id)) return showProfile(target.dataset.id);
    return open(target.dataset.open, target.dataset.id);
  }
  const action = target.dataset.action;
  // The popup closes for actions that leave it; the agent is named on the button first, since closing forgets it.
  if (action === 'spec-tab' && ui.profileId) ui.profileForce = true;
  if (action === 'spec-save') ui.rulesDraft = undefined;
  if (['spec-chat', 'spec-remove', 'spec-duplicate'].includes(action) && document.querySelector('.agp-modal')) { if (!target.dataset.agentId) target.dataset.agentId = ui.profileId; closeProfile(); }
  try {
    if (action?.startsWith('spec-') || action === 'chat-pick') await agentAction(ctx, action, target);
    else if (action === 'send') await send();
    else if (action === 'agent-signin') { try { await api('/agents/login', { method: 'POST', data: { provider: target.dataset.provider || 'claude', profile: '' } }); toast(t('Sign-in opened. Pick the account that has the plan, finish it, then start a fresh chat.')); } catch (error) { toast(error.message, true); } }
    else if (action === 'update-install') await installUpdate(api);
    else if (action === 'update-reveal') await revealInstaller(api);
    else if (action === 'update-later') updateLater();
    else if (action === 'voice-mode') { const on = toggleVoiceMode(draftKey()); if (!on) { cancelVoiceTurn(); stopLive(); } voiceRest = 0; toast(on ? t('Voice mode is on. Talk when the mic lights up; the reply is spoken as it is written.') : t('Voice mode is off.')); renderAll(); }
    else if (action === 'read-aloud') { const on = toggleReadAloud(draftKey()); toast(on ? t('New replies in this chat are read aloud.') : t('Replies are no longer read aloud.')); renderAll(); }
    else if (action === 'update-show') updateShow(ui.snap.update);
    else if (action === 'cover-reset') { const agent = (ui.snap.specialists || []).find(item => item.id === target.closest('[data-agent]')?.dataset.agent); if (agent) void saveCover(ctx, agent, null);
    } else if (action === 'avatar-pick') { const agent = (ui.snap.specialists || []).find(item => item.id === target.closest('[data-agent-id]')?.dataset.agentId); if (agent) openAvatarPicker(ctx, agent); }
    else if (action === 'pin-toggle') togglePin(ctx, target.dataset.kind, target.dataset.id);
    else if (action === 'app-on' || action === 'app-off') {
      const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); if (!run) return;
      await api(`/runs/${run.id}/app`, { method: 'POST', data: { on: action === 'app-on' } });
      toast(action === 'app-on' ? t('Opening this chat in the Claude app. Its link shows here in a few seconds.') : t('Closed in the Claude app. The chat carries on here.'));
      await refresh();
    }
    else if (action === 'update-when-idle') await updateWhenIdle(api);
    else if (action === 'update-cancel') await updateWhenIdle(api, false);
    else if (action === 'new-room') newRoomDialog();
    else if (action === 'show-earlier') { ui.showEarlier = { ...(ui.showEarlier || {}), [ui.view.type === 'main' ? mainRun()?.id : ui.view.id]: true }; renderAll(true); }
    else if (action === 'move-to-chat') { const run = runById(ui.view.id); if (run) moveRunDialog(ctx, run); }
    else if (action === 'chat-to-room') { const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id), agent = personalAgent(run); if (agent) openRoomDialog(ctx, { id: agent.id, name: agent.name }); }
    else if (action === 'term-close') { ui.termOpen = false; renderAll(); }
    else if (action === 'term-open') { ui.termOpen = true; renderAll(); }
    else if (['room-shared', 'room-stop', 'room-remove', 'task-assign', 'info-toggle', 'room-image', 'room-delete', 'side-tab', 'agents-pop'].includes(action)) await roomAction(ctx, action, target);
    else if (action?.startsWith('pin-')) await pinsAction(ctx, action, target);
    else if (action?.startsWith('dev-')) await devicesAction(ctx, action, target);
    else if (action?.startsWith('mk-')) await marketAction(ctx, action, target);
    else if (action?.startsWith('mo-')) await monitorAction(ctx, action, target);
    else if (action?.startsWith('nt-')) await noticesAction(ctx, action, target);
    else if (action?.startsWith('setup-')) await setupClick(ctx, action, target, { redraw: () => renderAll(), settings: section => openSettings(ctx, section), sendMain: async text => { if (mainRun()) await api(`/runs/${mainRun().id}/${workingStates.includes(mainRun().state) ? 'say' : 'resume'}`, { method: 'POST', data: workingStates.includes(mainRun().state) ? { text } : { prompt: text } }); else await api('/main', { method: 'POST', data: { prompt: text } }); open('main'); await refresh(); } });
    else if (action === 'brain-setup') { const found = ui.snap.memory?.brainCandidates?.[0]; const text = t`Help me set up my second brain for all agents.${found ? t` I think it is at ${found}.` : ''} Ask me how I want you to use it.`; if (mainRun()) await api(`/runs/${mainRun().id}/${workingStates.includes(mainRun().state) ? 'say' : 'resume'}`, { method: 'POST', data: workingStates.includes(mainRun().state) ? { text } : { prompt: text } }); else await api('/main', { method: 'POST', data: { prompt: text } }); open('main'); }
    else if (action === 'quick') { await api('/main', { method: 'POST', data: { prompt: target.dataset.text } }); await refresh(); }
    else if (action === 'sync') await syncIssues();
    else if (action === 'sec-toggle') toggleSection(target.dataset.sec);
    else if (action === 'settings-open') openSettings(ctx);
    else if (action === 'about-open') openSettings(ctx, 'about');
    else if (action === 'account-open') openSettings(ctx, 'backup');
    else if (action === 'settings-sources') { document.querySelector('.dialog-back:not(.settings)')?.remove(); openSettings(ctx, 'sources'); }
    else if (action === 'sync-source') { ui.syncing = target.dataset.source; renderAll(); try { const [result] = await api('/sync', { method: 'POST', data: { sourceId: target.dataset.source } }); toast(result?.error ? t`Sync failed: ${result.error}` : `${result?.name || t('Tracker')} synced.`, Boolean(result?.error)); } finally { ui.syncing = ''; await refresh(); } }
    else if (action === 'know-tab') { ui.knowTab = target.dataset.tab; renderAll(true); }
    else if (action === 'kg-view') { try { localStorage.setItem('rex-knowledge-view', target.dataset.view); } catch {} renderAll(true); }
    else if (action === 'theme') window.rexTheme?.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    else if (action === 'stop') { const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); await api(`/runs/${run.id}/stop`, { method: 'POST', data: {} }); await refresh(); }
    else if (action === 'scan') await scanProjects();
    else if (action === 'wake-approve') { await api(`/rooms/x/wakes/${target.dataset.id}`, { method: 'POST', data: {} }); toast(t('Agent resumed.')); await refresh(); }
    else if (action === 'wake-dismiss') { await api(`/rooms/x/wakes/${target.dataset.id}`, { method: 'DELETE' }); await refresh(); }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('change', async event => {
  if (event.target.dataset.action === 'room-add' && event.target.value) {
    try { await api(`/rooms/${ui.view.id}/members`, { method: 'POST', data: { agentId: event.target.value } }); await refresh(); } catch (error) { toast(error.message, true); }
  }
  if (event.target.tagName === 'SELECT' && event.target.closest('[data-interaction]')) event.target.closest('label')?.querySelector('.hidden,input[name$="__custom"]')?.classList.toggle('hidden', event.target.value !== '__custom');
});
document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-interaction]'); if (!form) return; event.preventDefault();
  const decision = event.submitter?.value || 'accept', content = {};
  if (decision === 'accept' && form.classList.contains('sliding')) {
    const missing = [...form.querySelectorAll('.qslide')].findIndex(slide => !answered(slide));
    if (missing >= 0) { slideTo(form, missing); toast(t('Answer this one first, or press Skip.'), true); return; }
  }
  for (const field of form.querySelectorAll('[data-type]')) {
    let value = field.value; if (value === '__custom') value = form.elements[`${field.name}__custom`].value; if (value === '') continue;
    content[field.name] = field.dataset.type === 'boolean' ? value === 'true' : ['number', 'integer'].includes(field.dataset.type) ? Number(value) : value;
  }
  const always = decision === 'always';
  document.activeElement?.blur?.();
  try { await api(`/interactions/${form.dataset.interaction}/answer`, { method: 'POST', data: { action: always ? 'accept' : decision, content: always ? { ...content, always: true } : content } }); toast(decision === 'accept' || always ? t('Sent to the agent.') : t('Declined.')); await refresh(); }
  catch (error) { toast(error.message, true); }
});
// Scrolling up with the wheel, a key or the scroll bar while an agent replies stops following the newest message at once (L55):
// the glide to the bottom used to ignore the person's scrolling, so the chat felt stuck while text kept arriving.
const letGo = () => { ui.gliding = false; clearTimeout(ui.glideTimer); ui.stick = false; };
document.addEventListener('wheel', event => { if (event.deltaY < 0 && event.target.closest?.('#feed')) letGo(); }, { passive: true });
document.addEventListener('pointerdown', event => { const feed = event.target.closest?.('#feed'); if (feed && event.offsetX > feed.clientWidth) letGo(); }, { passive: true });
document.addEventListener('keydown', event => { if (['PageUp', 'ArrowUp', 'Home'].includes(event.key) && document.activeElement?.closest?.('#feed')) letGo(); });
document.addEventListener('scroll', event => { if (event.target.id === 'feed') { if (ui.gliding) return; ui.stick = event.target.scrollHeight - event.target.scrollTop - event.target.clientHeight < 80; if (ui.stick) ui.freshBelow = false; syncToEnd(); } }, true);

initPickers(ctx); wireInbox(ctx); initRoomInfo(ctx); initAgentCard(ctx); wireLoop(ctx); initLocalTasks(ctx); initDevices(ctx); initMarket(ctx); window.__rexCtx = ctx; wireFiles(ctx); wireAgentCards(ctx); wireSpeak(toast); wireWorktrees(ctx); wireNet(ctx); wireExp(ctx); wireChatSwitch(); wireImageViewer();
// On a phone the side panels start closed, and the menu button opens the list of chats.
if (window.matchMedia('(max-width: 760px)').matches) { ui.infoOpen = false; ui.chatInfo = false; ui.termOpen = false; }
// A page an agent made (an explanation of its changes) opens full screen over the chat, in a sandbox with no access to Rex Desk.
function openPage(src, title = t('Explanation')) {
  document.querySelector('.page-view')?.remove();
  const view = document.createElement('div'); view.className = 'page-view'; view.setAttribute('role', 'dialog'); view.setAttribute('aria-label', title);
  view.innerHTML = `<div class="pv-bar"><b>${esc(title)}</b><span class="spacer"></span><a class="btn small" href="${esc(src)}" target="_blank" rel="noopener noreferrer">${t`Open in a new window`}</a><button type="button" class="btn small" data-pv-close>${t`Close`}</button></div><iframe class="pv-frame" sandbox="allow-scripts" src="${esc(src)}" title="${esc(title)}"></iframe>`;
  document.body.append(view); view.querySelector('[data-pv-close]').focus();
  view.addEventListener('click', event => { if (event.target.closest('[data-pv-close]')) view.remove(); });
  view.addEventListener('keydown', event => { if (event.key === 'Escape') view.remove(); });
}
// An explanation page an agent made opens as a tab of the file window, on its preview (Code shows its source).
document.addEventListener('click', event => { const button = event.target.closest?.('[data-page-open]'); if (!button) return; event.preventDefault(); event.stopPropagation(); if (window.rexOpenFile) void window.rexOpenFile(button.dataset.pageOpen, { view: 'preview' }); else openPage(button.dataset.pageOpen, button.textContent.trim() || t('Explanation')); }, true);
document.addEventListener('click', event => { if (!event.target.closest?.('[data-action="m-rail"]')) return; event.stopPropagation(); document.querySelector('.chat-shell')?.classList.toggle('show-rail'); }, true);
document.addEventListener('click', event => { const head = event.target.closest?.('[data-action="agent-group"]'); if (!head) return; event.stopPropagation(); toggleGroup(head.dataset.project); renderAll(); }, true);
// The back and forward buttons, and a pasted address, move between screens.
window.addEventListener('hashchange', () => {
  if (ui.fromOpen) { ui.fromOpen = false; return; }
  const view = viewFromHash(); if (!view) return;
  ui.view = view; ui.page = ''; showNow(); void refresh({ full: true });
});
setPickActions({ 'room-add': async agentId => { try { await api(`/rooms/${ui.view.id}/members`, { method: 'POST', data: { agentId } }); await refresh(); } catch (error) { toast(error.message, true); } } });
// Yes and No answers.
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-seg]'); if (!button) return;
  const group = button.parentElement; for (const other of group.querySelectorAll('[data-seg]')) other.classList.toggle('on', other === button);
  group.querySelector('input').value = button.dataset.seg;
});
initComposer(ctx);
// A shell step in the chat points to its entry in the terminal panel.
document.addEventListener('click', event => {
  const link = event.target.closest?.('[data-term-focus]'); if (!link) return;
  ui.termOpen = true; renderAll();
  const entry = document.getElementById(`term-${link.dataset.termFocus}`); if (!entry) return;
  if (entry.tagName === 'DETAILS') entry.open = true;
  entry.scrollIntoView({ block: 'center' }); entry.classList.add('flash'); setTimeout(() => entry.classList.remove('flash'), 1200);
});
// In a question card, the keys 1 to 9 pick that option (when not typing).
document.addEventListener('keydown', event => {
  if (!/^[1-9]$/.test(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
  const form = document.activeElement?.closest?.('.qcard') || (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) ? null : document.querySelector('.qcard')); if (!form) return;
  if (document.activeElement?.classList?.contains('qinput') || document.activeElement?.id === 'draft') return;
  const first = form.querySelector('.qslide.on .sugg') || form.querySelector('.sugg'), chip = first?.querySelectorAll('.sugg-chip')[Number(event.key) - 1]; if (!chip) return;
  event.preventDefault(); chip.click();
});
// A suggested answer fills its box; a multi-select question collects several.
document.addEventListener('click', event => {
  const chip = event.target.closest?.('.sugg-chip'); if (!chip) return;
  event.preventDefault();
  const field = chip.closest('.qfield'), input = field.querySelector('.qinput'), multi = chip.parentElement.dataset.multi === '1', label = chip.dataset.fill;
  if (multi) { chip.classList.toggle('on'); input.value = [...chip.parentElement.querySelectorAll('.sugg-chip.on')].map(item => item.dataset.fill).join(', '); }
  else { for (const other of chip.parentElement.children) other.classList.toggle('on', other === chip); input.value = label; }
  remember(chip.closest('form'));
  const form = chip.closest('form.sliding');
  if (form && !multi) { setTimeout(() => slideTo(form, Number(form.dataset.step) + 1), 220); return; }
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
});
document.addEventListener('input', event => { if (event.target.id === 'task-filter') { ui.taskFilter = event.target.value; renderAll(); } });
document.addEventListener('toggle', event => { const group = event.target, key = group?.dataset?.steps !== undefined ? group.dataset.steps : group?.dataset?.term !== undefined ? `term:${group.dataset.term}` : null; if (key !== null) ui.openSteps.set(key, group.open); }, true);
document.addEventListener('keydown', event => {
  const input = event.target.closest?.('.qinput'); if (!input || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  const form = input.closest('form'), all = [...form.querySelectorAll('.qinput:not(.hidden)')], next = all[all.indexOf(input) + 1];
  event.preventDefault();
  if (form.classList.contains('sliding') && !event.ctrlKey) { const step = Number(form.dataset.step); if (step < Number(form.dataset.count) - 1) { if (answered(form.querySelector('.qslide.on'))) slideTo(form, step + 1); return; } }
  if (next && !event.ctrlKey && !form.classList.contains('sliding')) next.focus(); else form.requestSubmit(form.querySelector('[value=accept]'));
});
// Opening the app. Over a slow link (the phone through a Tailscale relay) the first state can take long: it is waited for
// with the long first-load timeout, and when it still fails the page tries again in place. It never reloads itself,
// since a reload starts over and failed the same way every time (the phone reloaded every few seconds, forever).
// The page script is running: the loading screen is waiting for data, not broken (boot-watch.js leaves it alone).
document.querySelector('#app > .boot')?.setAttribute('data-started', '1');
async function openApp() {
  await refresh({ full: true });
  const stream = new EventSource('/api/events'); let timer, lastRefresh = 0;
  // A "something changed" ping asks the page to catch up. While an agent writes, these pings arrive faster than the old 700ms
  // wait, so the wait was reset every time and the page never refreshed until the agent stopped (the "spinner forever" bug).
  // Now it still waits a beat to batch a burst, but refreshes at least a few times a second during a stream.
  const onChange = () => {
    const since = performance.now() - lastRefresh;
    const run = () => { lastRefresh = performance.now(); void refresh().catch(() => {}); };
    if (since > 900) return run();
    clearTimeout(timer); timer = setTimeout(run, Math.max(120, 900 - since));
  };
  stream.addEventListener('change', onChange);
  // A dropped stream (server busy, network blip, update) reconnects on its own; when it does, catch up at once so the page
  // never sits blank waiting for the next change.
  stream.addEventListener('open', () => void refresh().catch(() => {}));
  // Voice mode: when nothing is being written or said, listen for the person's next turn; after they spoke, give the
  // agent a moment to start replying before listening again.
  // When the person says nothing for a while (only listening, no agent at work), Rex asks once whether they are still
  // there; after two minutes it says it will be there when needed and ends Voice mode, so the mic is not left open.
  setInterval(() => {
    if (!voiceModeOn(draftKey())) { voiceQuiet.since = 0; return; }
    const agentBusy = agentWriting() || !speechIdle() || voiceListening().transcribing;
    if (agentBusy) voiceQuiet.since = 0; else if (!voiceQuiet.since) { voiceQuiet.since = Date.now(); voiceQuiet.asked = false; }
    // Quiet counts from the last moment the person's voice was heard, not from when the mic opened: someone who talks for a
    // long time is never taken for silent, and never cut off.
    const lastVoice = voiceListening().heardAt;
    if (voiceQuiet.since && lastVoice > voiceQuiet.since) { voiceQuiet.since = lastVoice; voiceQuiet.asked = false; }
    if (voiceQuiet.since && !agentBusy) {
      const quiet = Date.now() - voiceQuiet.since;
      if (quiet > 120000) { voiceQuiet.since = 0; cancelVoiceTurn(); welcome(GOODBYE, 0); setTimeout(() => { if (voiceModeOn(draftKey())) { toggleVoiceMode(draftKey()); renderAll(); } }, 3500); return; }
      if (quiet > 25000 && !voiceQuiet.asked) { voiceQuiet.asked = true; cancelVoiceTurn(); welcome(STILL_THERE, 0); voiceRest = Date.now() + 1500; return; }
    }
    if (voiceBusy() || Date.now() < voiceRest || document.hidden) return;
    if (agentBusy) { voiceRest = Date.now() + 600; return; }
    void voiceTurn(ctx, { onState: state => { if (state === 'thinking') { voiceRest = Date.now() + 4000; voiceQuiet.since = 0; } } }).then(started => { if (!started) { toggleVoiceMode(draftKey()); renderAll(); } });
  }, 400);
  // An agent's words as they are written: Voice mode speaks them a phrase behind, without waiting for the whole reply.
  stream.addEventListener('partial', event => { try { const data = JSON.parse(event.data); speakLive(data, draftKey(), ctx.currentRunId()); showLive(data); } catch { /* a broken message is skipped */ } });
  setInterval(() => void refresh().catch(() => {}), 15000);
}
try { await openApp(); } catch (error) {
  app.innerHTML = `<div class="boot boot-failed" data-retrying="1"><h2>${t`Rex Desk is unavailable`}</h2><p>${esc(error.message)}</p><p>${t`Opening it again by itself as soon as the server answers.`}</p></div>`;
  const again = async () => { try { await openApp(); } catch (failure) { const line = app.querySelector('.boot-failed p'); if (line) line.textContent = failure.message; setTimeout(again, 5000); } };
  setTimeout(again, 5000);
}

// A question card with several questions shows one at a time. Back and Next move between them; picking an answer moves on by itself.
function answered(slide) {
  const input = slide?.querySelector('[data-type]'); if (!input) return true;
  return !input.hasAttribute('required') || String(input.value || '').trim() !== '';
}
function slideTo(form, index) {
  const slides = [...form.querySelectorAll('.qslide')], count = slides.length; if (!count) return;
  const from = Number(form.dataset.step) || 0, to = Math.max(0, Math.min(count - 1, index));
  if (to === from && slides[to].classList.contains('on')) { if (to === count - 1) form.querySelector('.qsend')?.focus(); return; }
  form.dataset.step = String(to); ui.qstep.set(form.dataset.interaction, to);
  slides.forEach((slide, position) => { slide.classList.toggle('on', position === to); slide.classList.toggle('back', position === to && to < from); });
  form.querySelectorAll('.qdots i').forEach((dot, position) => { dot.className = position === to ? 'on' : position < to ? 'done' : ''; });
  const counter = form.querySelector('[data-qcount]'); if (counter) counter.textContent = t`Question ${to + 1} of ${count}`;
  form.querySelector('.qback').hidden = to === 0; form.querySelector('.qnext').hidden = to === count - 1; form.querySelector('.qsend').hidden = to !== count - 1;
  const box = slides[to].querySelector('.qinput');
  if (to === count - 1 && box?.value) form.querySelector('.qsend').focus(); else box?.focus({ preventScroll: true });
}
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-qmove]'); if (!button) return;
  const form = button.closest('form'), step = Number(form.dataset.step), move = Number(button.dataset.qmove);
  if (move > 0 && !answered(form.querySelector('.qslide.on'))) { toast(t('Pick or type an answer first.'), true); return; }
  slideTo(form, step + move);
});
// Answers typed or picked so far stay when the chat redraws the card.
function remember(form) {
  if (!form?.dataset?.interaction) return;
  ui.qanswers.set(form.dataset.interaction, Object.fromEntries([...form.querySelectorAll('.qinput[name]')].map(input => [input.name, input.value])));
}
document.addEventListener('input', event => { if (event.target.classList?.contains('qinput')) remember(event.target.closest('form')); });

// ---------- About you: a small portfolio of the person ----------
function photoUrl() { return `/api/profile/photo?v=${encodeURIComponent(ui.profile?.photo?.updatedAt || '')}`; }
function noteText(item) { const match = /^(.*?)\s+\((\d{4}-\d{2}-\d{2})(, may change)?\)$/.exec(item); return match ? { text: match[1], when: match[2], soft: Boolean(match[3]) } : { text: item, when: '', soft: false }; }
function personPage() {
  const profile = ui.profile || { sections: [], projects: [], agents: [] }, name = profile.name || t('You');
  const photo = profile.photo ? `<img class="kl-photo" src="${photoUrl()}" alt="${esc(name)}">` : `<div class="kl-photo kl-initials" aria-hidden="true">${esc(initials(name))}</div>`;
  const plain = text => String(text || '').replace(/\*\*|__|`/g, '');
  // What the agents know, one tab for each kind. The title is the heading in .rexdesk/user.md.
  const KINDS = [['explain', t('How to explain things to me'), t('Explain'), t('Format, length, detail, examples: how every agent answers you.'), t('Short answer first, then the steps as a numbered list')],
    ['likes', t('Likes'), t('Likes'), t('What works well for you.'), t('Plain words, no jargon')],
    ['dislikes', t('Dislikes'), t('Dislikes'), t('What agents should stop doing.'), t('Long walls of text')],
    ['works', t('How they work'), t('How you work'), t('Your habits, tools and rules.'), t('I test on my phone before I merge')],
    ['personality', t('Personality'), t('Personality'), t('How you think, so agents meet you where you are.'), t('I learn by doing; show me, then explain')],
    ['about', t('About them'), t('About you'), t('Facts about you.'), t('I speak Khmer, English and Korean')]];
  const itemsOf = title => (profile.sections.find(section => section.title === title)?.items || []).map(noteText);
  const tab = KINDS.some(kind => kind[0] === ui.knowTab) ? ui.knowTab : (KINDS.find(item => itemsOf(item[1]).length) || KINDS[0])[0];
  const [kind, title, label, hint, example] = KINDS.find(item => item[0] === tab);
  const total = KINDS.reduce((sum, item) => sum + itemsOf(item[1]).length, 0);
  const items = itemsOf(title);
  const tabs = `<div class="kl-tabs" role="tablist" aria-label="${t`What the agents know`}">${KINDS.map(([key, heading, short]) => { const count = itemsOf(heading).length; return `<button type="button" role="tab" aria-selected="${key === tab}" class="${key === tab ? 'on' : ''}" data-action="know-tab" data-tab="${key}">${esc(short)}<span>${count}</span></button>`; }).join('')}</div>`;
  const rows = items.length ? `<ul class="kl-list">${items.map(item => `<li><span class="kl-text">${esc(item.text)}</span><span class="kl-meta">${item.when ? esc(item.when) : ''}${item.soft ? `<em>${t`may change`}</em>` : ''}</span><button type="button" class="kl-x" data-note-forget="${esc(kind)}" data-note-text="${esc(item.text)}" title="${t`Remove`}" aria-label="${t`Remove this`}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button></li>`).join('')}</ul>`
    : `<p class="kl-empty">${t`Nothing here yet. Agents add to it when they notice what works, or add your own above.`}</p>`;
  const panel = `<section class="kl-panel" role="tabpanel"><header><h2>${esc(label)}</h2><p>${esc(hint)}</p></header>
    <form class="kl-add" data-note-add="${esc(kind)}"><input name="text" type="text" maxlength="240" placeholder="${t`Add one, for example: ${esc(example)}`}" aria-label="${t`Add to ${esc(label)}`}" autocomplete="off"><button class="btn primary small">${t`Add`}</button></form>${rows}</section>`;
  const side = `<aside class="kl-side"><div class="kl-me">${photo}<div><h2>${esc(name)}</h2>${profile.email ? `<p>${esc(profile.email)}</p>` : ''}</div></div>
    <div class="kl-stats"><div><b>${total}</b><span>${t`things known`}</span></div><div><b>${profile.projects.length}</b><span>${t`projects`}</span></div><div><b>${profile.agents.length}</b><span>${t`agents`}</span></div></div>
    <div class="kl-actions"><label class="btn small pf-upload">${profile.photo ? t('Change photo') : t('Add a photo')}<input type="file" accept="image/png,image/jpeg,image/webp" data-photo-upload hidden></label>${profile.photo ? `<button class="btn small" data-action="photo-remove">${t`Remove`}</button>` : ''}</div>
    ${profile.projects.length ? `<h3>${t`Projects`}</h3><div class="kl-chips">${profile.projects.map(project => `<button type="button" data-open="project" data-id="${esc(project.slug)}" title="${esc(plain(project.purpose))}">${esc(project.slug)}</button>`).join('')}</div>` : ''}
    ${profile.agents.length ? `<h3>${t`Agents`}</h3><div class="kl-chips">${profile.agents.map(agent => `<button type="button" data-open="specialist" data-id="${esc(agent.id)}">${esc(agent.name)}</button>`).join('')}</div>` : ''}
    <p class="kl-file">${t`Kept in .rexdesk/user.md. Every agent reads it before it answers you.`}</p></aside>`;
  return `<div class="page kl">${brainBanner()}<div class="kl-body">${side}<div class="kl-main">${tabs}${panel}</div></div></div>`;
}
// A chosen picture is made small (512 px) in the page before it is saved.
document.addEventListener('change', async event => {
  if (!event.target.matches?.('[data-photo-upload]')) return;
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const bitmap = await createImageBitmap(file), scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    await api('/profile/photo', { method: 'POST', data: { data: canvas.toDataURL('image/jpeg', 0.9).split(',')[1] } });
    toast(t('Profile photo saved.')); await refresh({ full: true });
  } catch (error) { toast(error.message || t('That picture could not be read.'), true); }
});
document.addEventListener('click', async event => {
  if (!event.target.closest?.('[data-action="photo-remove"]')) return;
  try { await api('/profile/photo', { method: 'DELETE' }); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
}, true);

// ---------- a file an agent opened for the person to fill in ----------
// The file is read and saved by Rex Desk on this computer; the agent only learns that it was saved and which keys have values.
function isEnv(file) { return /(^|[\\/])\.env(\.[\w.-]+)?$|\.env$/i.test(file); }
function secretKey(key) { return /key|secret|token|passw|pwd|auth|credential|private|cookie|session/i.test(key); }
function envLine(line) { return /^(\s*(?:export\s+)?)([A-Za-z_][\w.-]*)(\s*=\s*)(.*)$/.exec(line); }
function fileState(item) {
  let state = ui.files.get(item.id);
  if (!state && item.cloudCopy) {
    // On another of the person's computers: only the keys the agent asked for, empty. What is typed is locked here so only the
    // agent's computer can read it, and saved there. The rest of the file never leaves that computer.
    const keys = item.request?.keys || [];
    state = { loading: false, remote: true, content: keys.map(key => `${key}=`).join('\n'), mode: 'fields', shown: new Set(), keys, exists: item.request?.exists,
      error: keys.length && item.request?.lockKey ? '' : t`Open this file on the computer the agent works on to fill it in.` };
    ui.files.set(item.id, state);
  }
  if (!state) {
    state = { loading: true, content: '', mode: isEnv(item.request?.path) ? 'fields' : 'text', shown: new Set() }; ui.files.set(item.id, state);
    api(`/interactions/${item.id}/file`).then(file => {
      let content = file.content;
      // Keys the agent asked for that are not in the file yet are added at the end, empty, for the person to fill.
      const present = new Set(content.split('\n').map(envLine).filter(Boolean).map(match => match[2]));
      const missing = (file.keys || []).filter(key => !present.has(key));
      if (missing.length && state.mode === 'fields') content = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${missing.map(key => `${key}=`).join('\n')}\n`;
      Object.assign(state, { loading: false, content, original: file.content, exists: file.exists, keys: file.keys || [] }); renderAll(true);
    }).catch(error => { Object.assign(state, { loading: false, error: error.message }); renderAll(true); });
  }
  return state;
}
function fileCard(item) {
  const run = runById(item.runId), state = fileState(item), file = item.request?.path || '';
  let body;
  if (state.loading) body = `<p class="muted">${t`Opening the file…`}</p>`;
  else if (state.error) body = `<p class="fbad">${esc(state.error)}</p>`;
  else if (state.mode === 'fields') {
    const lines = state.content.split('\n'), rows = lines.map((line, index) => [line, index, envLine(line)]).filter(([, , match]) => match);
    body = rows.length ? `<div class="frows">${rows.map(([, index, match]) => {
      const key = match[2], value = match[4].replace(/^(["'])(.*)\1$/, '$2'), hidden = secretKey(key) && !state.shown.has(index), wanted = state.keys.includes(key);
      return `<label class="frow${wanted ? ' wanted' : ''}"><span class="fkey">${esc(key)}${wanted ? `<small>${t`asked for`}</small>` : ''}</span><span class="fval"><input type="${hidden ? 'password' : 'text'}" data-file-line="${index}" value="${esc(value)}" autocomplete="off" spellcheck="false" placeholder="${wanted ? t('Paste the value here') : 'empty'}">${secretKey(key) ? `<button type="button" class="btn small quiet" data-file-show="${index}">${hidden ? t('Show') : t('Hide')}</button>` : ''}</span></label>`;
    }).join('')}</div>` : `<p class="muted">${t`No KEY=value lines yet. Switch to text to write the file.`}</p>`;
  } else body = `<textarea class="ftext" data-file-text spellcheck="false">${esc(state.content)}</textarea>`;
  const toggle = !state.loading && !state.error && !state.remote && isEnv(file) ? `<button type="button" class="btn small quiet" data-file-mode>${state.mode === 'fields' ? t('Edit as text') : t('Edit as fields')}</button>` : '';
  return `<form class="card ask fcard" data-file="${esc(item.id)}"><div class="qhead"><span class="qdot"></span>${t`File to fill in · ${esc(runTitle(run))}`}</div>
    <div class="qtext md">${markdown(String(item.title || ''))}</div>
    <div class="fpath"><code title="${esc(file)}">${esc(file)}</code>${state.exists === false ? `<span class="chip">${t`new file`}</span>` : ''}${toggle}</div>
    ${body}
    <p class="fnote">${state.remote ? t`Locked on this computer so only ${esc((ui.snap.specialists || []).find(agent => agent.id === run?.specialistId)?.device || t('the agent\'s computer'))} can read it, then saved there. ${esc(runTitle(run))} sees only which keys have a value, never what you type.` : t`Saved straight to this computer. ${esc(runTitle(run))} sees only which keys have a value, never what you type.`}</p>
    <div class="row"><button class="send-btn wide" ${state.loading || state.error ? 'disabled' : ''}>${t`Save file`}</button><button type="button" class="btn small" data-file-close>${t`Close without saving`}</button></div></form>`;
}
function fileLine(state, index, value) {
  const lines = state.content.split('\n'), match = envLine(lines[index]); if (!match) return;
  const quote = /^(["']).*\1$/.exec(match[4])?.[1] || (/[\s#]/.test(value) ? '"' : '');
  lines[index] = `${match[1]}${match[2]}${match[3]}${quote}${value}${quote}`; state.content = lines.join('\n');
}
document.addEventListener('input', event => {
  const form = event.target.closest?.('[data-file]'); if (!form) return;
  const state = ui.files.get(form.dataset.file); if (!state) return;
  if (event.target.dataset.fileLine !== undefined) fileLine(state, Number(event.target.dataset.fileLine), event.target.value);
  else if (event.target.matches('[data-file-text]')) state.content = event.target.value;
});
document.addEventListener('click', async event => {
  const form = event.target.closest?.('[data-file]'); if (!form) return;
  const state = ui.files.get(form.dataset.file); if (!state) return;
  const show = event.target.closest('[data-file-show]');
  if (show) { const index = Number(show.dataset.fileShow); if (state.shown.has(index)) state.shown.delete(index); else state.shown.add(index); renderAll(true); return; }
  if (event.target.closest('[data-file-mode]')) { state.mode = state.mode === 'fields' ? 'text' : 'fields'; renderAll(true); return; }
  if (event.target.closest('[data-file-close]')) {
    try { await api(`/interactions/${form.dataset.file}/answer`, { method: 'POST', data: { action: 'decline' } }); ui.files.delete(form.dataset.file); toast(t('Closed without saving.')); await refresh(); } catch (error) { toast(error.message, true); }
  }
});
document.addEventListener('submit', async event => {
  const form = event.target.closest?.('[data-file]'); if (!form) return; event.preventDefault(); event.stopPropagation();
  const state = ui.files.get(form.dataset.file); if (!state || state.loading) return;
  if (state.remote) {
    const values = Object.fromEntries(state.content.split('\n').map(envLine).filter(Boolean).map(match => [match[2], match[4].replace(/^(["'])(.*)\1$/, '$2')]).filter(([, value]) => value.trim()));
    try { await api(`/interactions/${form.dataset.file}/sealed`, { method: 'POST', data: { values } }); ui.files.delete(form.dataset.file); document.activeElement?.blur?.(); toast(t('Sent locked. It is saved on the agent\'s computer.')); await refresh({ full: true }); }
    catch (error) { toast(error.message, true); }
    return;
  }
  try { await api(`/interactions/${form.dataset.file}/file`, { method: 'POST', data: { content: state.content } }); ui.files.delete(form.dataset.file); document.activeElement?.blur?.(); toast(t('File saved.')); await refresh({ full: true }); }
  catch (error) { toast(error.message, true); }
}, true);

// ---------- reply to a room message: it goes to that agent without an @mention ----------
function drawReplyBar() {
  const composer = document.querySelector('.composer-inner'); if (!composer) return;
  composer.querySelector('.replybar')?.remove();
  const reply = ui.reply; if (!reply || ui.view.type !== 'room' || reply.roomId !== ui.view.id) return;
  composer.insertAdjacentHTML('afterbegin', `<div class="replybar"><span>${t`Replying to`} <b>${esc(reply.name)}</b> <span class="muted">${esc(reply.text)}</span></span><button type="button" class="ag-x" data-reply-cancel aria-label="${t`Cancel the reply`}" title="${t`Cancel the reply`}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>`);
}
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-reply]');
  if (button) {
    const message = (ui.snap.messages || []).find(item => item.id === button.dataset.reply); if (!message) return;
    const plain = String(message.text).replace(/\s+/g, ' ').trim();
    ui.reply = { roomId: message.roomId, id: message.id, name: message.from.label, text: plain.length > 80 ? `${plain.slice(0, 80)}…` : plain };
    drawReplyBar(); document.getElementById('draft')?.focus(); return;
  }
  if (event.target.closest?.('[data-reply-cancel]')) { ui.reply = null; drawReplyBar(); document.getElementById('draft')?.focus(); return; }
  const jump = event.target.closest?.('[data-jump]');
  if (jump) { const target = document.querySelector(`[data-msg="${CSS.escape(jump.dataset.jump)}"]`); if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); } }
});
// A picture or video that does not load shows "Not on this computer yet" in the chat, never a broken image; only when the
// server says the file was deleted (Settings, Storage) does it say "File removed".
document.addEventListener('error', event => {
  const media = event.target; if (!['IMG', 'VIDEO'].includes(media?.tagName) || !media.closest('.msg .md, .sh-grid, .pin-list')) return;
  const gone = document.createElement('span'); gone.className = 'file-gone'; gone.setAttribute('role', 'img'); gone.textContent = t('Not on this computer yet');
  const source = media.currentSrc || media.src || media.querySelector?.('source')?.src;
  (media.closest('.md-media-link, .sh-thumb') || media).replaceWith(gone);
  if (source) fetch(source, { cache: 'no-store' }).then(async answer => {
    if (answer.status !== 404) return;
    if (/This file was deleted/.test(await answer.text())) { gone.textContent = t('File removed'); return; }
    // Why the cloud backup did not bring it (src/file-backup.js why), so it never just waits forever.
    const reason = answer.headers.get('X-Rex-Missing'), detail = decodeURIComponent(answer.headers.get('X-Rex-Missing-Detail') || '');
    const said = { off: t('Pictures and files are left out of the cloud backup'), 'not-connected': t('Cloud backup is not connected on this computer'), 'not-in-backup': t('Not in the cloud backup yet'), 'too-big': t('Too big for the cloud backup'), failed: t('Could not download it') }[reason];
    if (said) { gone.textContent = said; if (detail) gone.title = detail; }
  }).catch(() => {});
}, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && ui.reply && event.target.id === 'draft' && !ui.menu) { ui.reply = null; drawReplyBar(); } });
// Ctrl+Up in the message box replies to the message above (again: the one before it); Ctrl+Down goes back down, past the newest stops replying.
document.addEventListener('keydown', event => {
  if (!event.ctrlKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.target.id !== 'draft' || ui.view.type !== 'room') return;
  const list = (ui.snap.messages || []).filter(item => item.roomId === ui.view.id && item.from.type !== 'system').sort((left, right) => left.seq - right.seq);
  if (!list.length) return;
  event.preventDefault();
  const at = ui.reply?.roomId === ui.view.id ? list.findIndex(item => item.id === ui.reply.id) : list.length;
  const next = event.key === 'ArrowUp' ? Math.max((at < 0 ? list.length : at) - 1, 0) : (at < 0 ? list.length : at) + 1;
  if (next >= list.length) { ui.reply = null; drawReplyBar(); return; }
  const message = list[next], plain = String(message.text).replace(/\s+/g, ' ').trim();
  ui.reply = { roomId: message.roomId, id: message.id, name: message.from.label, text: plain.length > 80 ? `${plain.slice(0, 80)}…` : plain };
  drawReplyBar();
  const row = document.querySelector(`[data-msg="${CSS.escape(message.id)}"]`); if (row) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 900); }
});
// Ctrl+Alt on its own (pressed and let go, with no other key) puts the cursor in the message box.
const chord = { ctrl: false, alt: false, other: false };
document.addEventListener('keydown', event => {
  if (event.key === 'Control') chord.ctrl = true; else if (event.key === 'Alt') chord.alt = true; else chord.other = true;
}, true);
document.addEventListener('keyup', event => {
  if (!['Control', 'Alt'].includes(event.key)) return;
  if (chord.ctrl && chord.alt && !chord.other) { const box = document.getElementById('draft'); if (box) { event.preventDefault(); box.focus(); box.selectionStart = box.selectionEnd = box.value.length; } }
  if (!event.ctrlKey && !event.altKey) { chord.ctrl = chord.alt = chord.other = false; }
}, true);
window.addEventListener('blur', () => { chord.ctrl = chord.alt = chord.other = false; });
// Unsend your own message in a personal chat.
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-unsend]'); if (!button) return;
  event.stopPropagation();
  const [runId, sequence] = button.dataset.unsend.split(':');
  if (!event.shiftKey && !await askConfirm(t('Unsend this message? (Shift+click unsends without asking.)'))) return;
  try { const result = await api(`/runs/${runId}/messages/${sequence}`, { method: 'DELETE' }); toast(result.seen ? t('Unsent. The agent had already read it.') : t('Unsent before the agent read it.')); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
});
// Unsend your own message in a group chat.
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-msg-delete]'); if (!button) return;
  event.stopPropagation();
  const message = (ui.snap.messages || []).find(item => item.id === button.dataset.msgDelete); if (!message) return;
  if (!event.shiftKey && !await askConfirm(t('Unsend this message? (Shift+click unsends without asking.)'))) return;
  try { await api(`/rooms/${message.roomId}/messages/${message.id}`, { method: 'DELETE' }); if (ui.reply?.id === message.id) { ui.reply = null; drawReplyBar(); } await refresh(); } catch (error) { toast(error.message, true); }
});

// ---------- a personal chat with an agent: its profile and what was shared, on the right ----------
// A computer Rex Desk has not seen before has no name yet: it asks for one, so every screen can tell your computers apart.
function newComputerCard(snap) {
  const self = snap.devices?.self; if (!self || self.named !== false) return '';
  return `<form class="newpc" data-newpc><b>${t('New computer')}</b><span class="muted small">${t('Name it so you can tell your computers apart, like Home or Work.')}</span>
    <div class="newpc-row"><input name="name" maxlength="40" value="${esc(self.name || '')}" aria-label="${t('Name of this computer')}"><button class="btn small primary">${t('Save')}</button></div></form>`;
}
// The sidebar line under an agent: what it is doing and the computer it runs on (named, and whether that one is on).
function agentWhere(agent) {
  const where = agent.device || '', state = agent.status?.state;
  if (['busy', 'replying', 'waiting'].includes(state)) return [agent.status.label, where].filter(Boolean).join(' · ');
  if (state === 'offline') return t`Offline · ${where}`;
  return [t('Asleep'), where].filter(Boolean).join(' · ');
}
// An agent whose chat went two ways on two computers: the person picks the one every computer keeps (src/chat-split.js).
function splitCard(run) {
  const split = (ui.snap.chatSplits || []).find(item => item.runId === run.id); if (!split) return '';
  const when = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const side = item => `<div class="split-side"><b>${esc(item.name)}${item.here ? ` <span class="muted">${t('(this computer)')}</span>` : ''}</b>
    <span class="muted">${item.messages === 1 ? t`1 message` : t`${item.messages} messages`}${item.lastAt ? ` · ${t`last ${when(item.lastAt)}`}` : ''}</span>
    ${item.lastText ? `<q>${esc(item.lastText)}</q>` : ''}<button class="btn small primary" data-action="chat-pick" data-agent-id="${esc(split.agentId)}" data-node="${esc(item.node)}">${t`Keep this chat`}</button></div>`;
  return `<section class="split-card" role="alert"><h3>${t('This agent has two different chats')}</h3><p class="muted">${t('Your computers each kept their own chat with this agent. Pick the one to keep: every computer then shows that chat, and the other one is put away (not deleted).')}</p>
    <div class="split-sides">${split.sides.map(side).join('')}</div>${split.sides.length < 2 ? `<p class="muted small">${t('Waiting for the other computer to add its side. It has to be on.')}</p>` : ''}</section>`;
}
function personalAgent(run) {
  if (!run || run.roomAgent) return null;
  if (run.role === 'coordinator' && run.main) return { id: 'main', name: t('Rex Agent'), projectSlug: 'all projects', purpose: t('Knows every project and agent, and helps you decide who does what.'), main: true, status: { label: stateLabel(run) } };
  if (!run.specialistId) return null;
  return (ui.snap.specialists || []).find(agent => agent.id === run.specialistId && agent.runId === run.id) || null;
}
// The Team tab: the tasks this agent gave to others (and got from a manager), live, with what each one needs.
function teamOf(agentId) {
  const tasks = (ui.snap.teamTasks || []).filter(task => task.managerId === agentId || task.workerId === agentId);
  return { tasks, open: tasks.filter(task => TEAM_OPEN.has(task.state)).length, owed: tasks.some(task => task.state === 'needs-manager' && task.managerId === agentId) };
}
function teamPanel(agent, team) {
  const label = { queued: t('Waiting its turn'), working: t('Working'), 'needs-manager': t('Has a question'), done: t('Done'), failed: t('Failed'), stalled: t('Stalled'), canceled: t('Canceled') };
  const tone = { working: 'live', 'needs-manager': 'owed', done: 'done', failed: 'bad', stalled: 'bad', queued: '', canceled: '' };
  const row = task => {
    const mine = task.managerId === agent.id, other = mine ? task.workerName : task.managerName || t('its manager'), when = hhmm(task.endedAt || task.createdAt);
    return `<li class="tm-task ${tone[task.state] || ''}"><div class="tm-top"><span class="tm-dot ${tone[task.state] || ''}" aria-hidden="true"></span><b>${esc(task.title)}</b><span class="tm-when">${esc(when)}</span></div>
      <p class="tm-who">${mine ? t`To ${esc(other)}` : t`From ${esc(other)}`}${task.remote ? ` · ${t`on your other computer`}` : ''} · <span class="tm-state">${label[task.state] || esc(task.state)}</span></p>
      ${task.state === 'needs-manager' && task.question ? `<blockquote>${esc(task.question)}</blockquote>${mine ? `<div class="tm-answer"><input name="tm-answer" placeholder="${t`Answer for ${esc(agent.name)}`}" aria-label="${t`Answer`}"><button type="button" class="btn small primary" data-action="team-answer" data-task="${esc(task.id)}">${t`Send`}</button></div>` : ''}` : ''}
      ${task.answer && ['done', 'failed'].includes(task.state) ? `<details class="tm-result"><summary>${t`Result`}</summary><p>${esc(task.answer)}</p></details>` : ''}
      ${mine && TEAM_OPEN.has(task.state) ? `<button type="button" class="btn small tm-cancel" data-action="team-cancel" data-task="${esc(task.id)}">${t`Cancel`}</button>` : ''}</li>`;
  };
  const open = team.tasks.filter(task => TEAM_OPEN.has(task.state)), past = team.tasks.filter(task => !TEAM_OPEN.has(task.state));
  if (!team.tasks.length) return `<div class="side-body"><div class="side-empty">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.8c1.5.6 2.6 1.9 3 4.2"/></svg>'}<p>${t`No team task yet. Ask ${esc(agent.name)} to hand work to your other agents, like "ask Dev to build it and QA to check it".`}</p></div></div>`;
  return `<div class="side-body tm">${open.length ? `<h3 class="tm-sec">${t`Now`}<span class="cnt">${open.length}</span></h3><ul class="tm-list">${open.map(row).join('')}</ul>` : ''}${past.length ? `<h3 class="tm-sec">${t`Finished`}<span class="cnt">${past.length}</span></h3><ul class="tm-list">${past.slice(0, 30).map(row).join('')}</ul>` : ''}</div>`;
}
// The Connectors tab (L105): this agent's own Telegram bot. First the connection, then (once connected) the groups it may work in.
function connectorsPanel(agent) {
  const bot = ui.agentBots?.[agent.id];
  if (!bot) {
    if (!ui.agentBotsLoading?.[agent.id]) { ui.agentBotsLoading = { ...(ui.agentBotsLoading || {}), [agent.id]: true }; void api(`/agents/${encodeURIComponent(agent.id)}/telegram`).then(status => { ui.agentBots = { ...(ui.agentBots || {}), [agent.id]: status }; }, () => { ui.agentBots = { ...(ui.agentBots || {}), [agent.id]: { connected: false } }; }).finally(() => { delete ui.agentBotsLoading[agent.id]; renderAll(); }); }
    return `<div class="side-body aps"><p class="muted">${t`Loading…`}</p></div>`;
  }
  // Keep the status fresh while this tab is open (pairing and group requests arrive from Telegram, not from a click).
  if (!ui.agentBotsTimer) ui.agentBotsTimer = setInterval(() => {
    if (ui.chatTab !== 'connectors') { clearInterval(ui.agentBotsTimer); ui.agentBotsTimer = null; ui.agentBotsFor = null; ui.agentBotDraft = {}; return; }
    if (document.hidden) return;
    const open = ui.agentBotsFor; if (!open) return;
    void api(`/agents/${encodeURIComponent(open)}/telegram`).then(status => { if (JSON.stringify(status) !== JSON.stringify(ui.agentBots?.[open])) { ui.agentBots = { ...(ui.agentBots || {}), [open]: status }; if (!document.activeElement?.matches?.('[data-ab-token],[data-bb-token]')) renderAll(); } }, () => {});
    if (ui.bugBot) void api('/bugbot').then(status => { if (JSON.stringify(status) !== JSON.stringify(ui.bugBot)) { ui.bugBot = status; if (!document.activeElement?.matches?.('[data-ab-token],[data-bb-token]')) renderAll(); } }, () => {});
  }, 4000);
  // A token typed for one agent is never shown in another agent's form.
  if (ui.agentBotsFor !== agent.id) { ui.agentBotsFor = agent.id; ui.agentBotDraft = {}; }
  const id = esc(agent.id), draft = ui.agentBotDraft || {};
  const about = `<section class="aps-sec"><h3>${t`What this is`}</h3><p class="cn-note">${t`A connector gives ${esc(agent.name)} its own Telegram bot. People message the bot and ${esc(agent.name)} answers, like a chat in this app.`}</p>
    <ul class="cn-note cn-steps"><li>${t`Make a bot with @BotFather and paste its token.`}</li><li>${t`Send the pairing code to the bot to make yourself its owner. The owner chats with it privately.`}</li><li>${t`Allow the bot in groups. Members of an allowed group can mention the bot or reply to its messages.`}</li></ul></section>`;
  const head = `<div class="cn-head"><b>Telegram</b>${bot.connected ? `<span class="cn-state"><span class="dot good"></span>${t`Connected`}</span>` : ''}</div>`;
  if (!bot.connected) {
    return `<div class="side-body aps cn">${about}
      <section class="aps-sec">${head}<p class="cn-note">${t`Give ${esc(agent.name)} its own Telegram bot, so people can talk to it there. Make one with @BotFather and paste its token here.`}</p>
        <input class="cn-input" data-ab-token data-agent="${id}" type="password" autocomplete="off" spellcheck="false" placeholder="123456:ABC-..." value="${esc(draft.token || '')}" aria-label="${t`Bot token`}">
        <button type="button" class="btn small primary cn-wide" data-action="ab-connect" data-agent="${id}" aria-label="${t`Connect agent bot`}">${bugBotSection(agent) ? t`Connect agent bot` : t`Connect bot`}</button></section>${bugBotSection(agent)}</div>`;
  }
  const groupRow = (group, button) => `<li class="cn-row"><span class="cn-text"><b>${esc(group.title || t('Group'))}</b><small>${esc(String(group.id))}</small></span>${button}</li>`;
  const owner = bot.ownerLinked
    ? `<div class="aps-row"><span>${t`Owner`}</span><div>${esc(bot.owner || t('Linked'))}</div></div><button type="button" class="btn small quiet cn-wide" data-action="ab-code" data-agent="${id}">${t`Link another owner`}</button>`
    : `<p class="cn-note">${bot.pairCode ? t`Open @${esc(bot.botUsername)} in Telegram and send it this code to make you its owner:` : t`Make a new code, then send it to the bot in Telegram.`}</p>${bot.pairCode ? `<p class="cn-code">${esc(bot.pairCode)}</p>` : `<button type="button" class="btn small cn-wide" data-action="ab-code" data-agent="${id}">${t`Make a code`}</button>`}`;
  const groups = `<section class="aps-sec"><h3>${t`Allow in groups`}</h3><p class="cn-note">${t`The bot works only in groups you allow, and only when someone mentions it or replies to its messages. Add it to a group, then allow it here.`}</p>
    ${bot.pending.length ? `<ul class="cn-list">${bot.pending.map(group => groupRow(group, `<button type="button" class="btn small" data-action="ab-allow" data-agent="${id}" data-gid="${esc(String(group.id))}" data-title="${esc(group.title || '')}">${t`Allow`}</button>`)).join('')}</ul>` : ''}
    ${bot.groups.length ? `<ul class="cn-list">${bot.groups.map(group => groupRow(group, `<button type="button" class="btn small quiet danger" data-action="ab-remove" data-agent="${id}" data-gid="${esc(String(group.id))}">${t`Remove`}</button>`)).join('')}</ul>` : (bot.pending.length ? '' : `<p class="cn-note">${t`No groups yet.`}</p>`)}</section>`;
  return `<div class="side-body aps cn">${about}
    <section class="aps-sec">${head}<div class="aps-row"><span>${t`Bot`}</span><div>@${esc(bot.botUsername)}</div></div>${owner}
      <button type="button" class="btn small quiet danger cn-wide" data-action="ab-disconnect" data-agent="${id}">${t`Disconnect`}</button></section>
    ${groups}${bugBotSection(agent)}</div>`;
}
// The bug-report bot lives in the App Agent's Connectors tab, since its approved reports become tasks for that agent. Its queue
// of reports waiting for an OK is in Needs you.
function bugBotSection(agent) {
  const data = ui.bugBot;
  if (!data) {
    if (!ui.bugBotLoading) { ui.bugBotLoading = true; void api('/bugbot').then(status => { ui.bugBot = status; }, () => { ui.bugBot = { connected: false }; }).finally(() => { ui.bugBotLoading = false; renderAll(); }); }
    return '';
  }
  // Bound to the agent's stable id, not its name: renaming the App Agent keeps its bug bot controls.
  if (!data.agentId || data.agentId !== agent.id) return '';
  const head = `<div class="cn-head"><b>${t`Bug report bot`}</b>${data.connected ? `<span class="cn-state"><span class="dot good"></span>${t`Connected`}</span>` : ''}</div>`;
  if (!data.connected) {
    return `<section class="aps-sec">${head}<p class="cn-note">${t`A separate Telegram bot for customer groups. It only files bug reports. Make a second bot with @BotFather and paste its token here.`}</p>
      <input class="cn-input" data-bb-token type="password" autocomplete="off" spellcheck="false" placeholder="123456:ABC-..." aria-label="${t`Bug bot token`}">
      <button type="button" class="btn small primary cn-wide" data-action="bb-connect" aria-label="${t`Connect bug bot`}">${t`Connect bug bot`}</button></section>`;
  }
  const row = (group, button) => `<li class="cn-row"><span class="cn-text"><b>${esc(group.title || t('Group'))}</b><small>${esc(String(group.id))}</small></span>${button}</li>`;
  const pending = data.pending || [], groups = data.groups || [];
  return `<section class="aps-sec">${head}<div class="aps-row"><span>${t`Bot`}</span><div>@${esc(data.botUsername || '')}</div></div>
    <div class="aps-row"><span>${t`Morning report`}</span><div><input class="cn-time" type="time" data-bb-time value="${esc(data.reportAt || '09:00')}" aria-label="${t`Morning report time`}"></div></div>
    <button type="button" class="btn small quiet danger cn-wide" data-action="bb-disconnect">${t`Disconnect`}</button></section>
    <section class="aps-sec"><h3>${t`Bug bot groups`}</h3><p class="cn-note">${t`It works only in allowed groups. Reports wait in Needs you until you approve them.`}</p>
    ${pending.length ? `<ul class="cn-list">${pending.map(group => row(group, `<button type="button" class="btn small" data-action="bb-allow" data-gid="${esc(String(group.id))}" data-title="${esc(group.title || '')}">${t`Allow`}</button>`)).join('')}</ul>` : ''}
    ${groups.length ? `<ul class="cn-list">${groups.map(group => row(group, `<button type="button" class="btn small quiet danger" data-action="bb-remove" data-gid="${esc(String(group.id))}">${t`Remove`}</button>`)).join('')}</ul>` : (pending.length ? '' : `<p class="cn-note">${t`No groups yet.`}</p>`)}</section>`;
}
document.addEventListener('change', async event => {
  const input = event.target.closest?.('[data-bb-time]'); if (!input) return;
  try { ui.bugBot = await api('/bugbot/report-time', { method: 'POST', data: { at: input.value || '09:00' } }).then(() => api('/bugbot')); toast(t('Saved.')); renderAll(); } catch (error) { toast(error.message, true); }
});
document.addEventListener('click', async event => {
  const target = event.target.closest?.('[data-action^="bb-"]'); if (!target) return;
  event.stopPropagation();
  const reload = async () => { ui.bugBot = await api('/bugbot'); renderAll(); };
  try {
    switch (target.dataset.action) {
      case 'bb-connect': { const token = document.querySelector('[data-bb-token]')?.value.trim() || ''; if (!token) return toast(t('Paste the bot token first.'), true); target.disabled = true; await api('/bugbot/connect', { method: 'POST', data: { botToken: token } }); toast(t('Bug bot connected.')); await reload(); break; }
      case 'bb-disconnect': if (await askConfirm(t('Disconnect the bug bot?'), { ok: t('Disconnect') })) { await api('/bugbot/disconnect', { method: 'POST', data: {} }); await reload(); } break;
      case 'bb-allow': await api('/bugbot/groups', { method: 'POST', data: { id: target.dataset.gid, title: target.dataset.title } }); toast(t('Group allowed.')); await reload(); break;
      case 'bb-remove': await api('/bugbot/groups/remove', { method: 'POST', data: { id: target.dataset.gid } }); await reload(); break;
    }
  } catch (error) { target.disabled = false; toast(error.message, true); }
}, true);
// Coming back to the window while the Connectors tab is open: show what changed meanwhile, and the polling carries on.
document.addEventListener('visibilitychange', () => { if (!document.hidden && ui.chatTab === 'connectors') { ui.agentBots = {}; ui.bugBot = null; renderAll(); } });
document.addEventListener('input', event => { if (event.target.matches?.('[data-ab-token]')) ui.agentBotDraft = { token: event.target.value }; ui.agentBotsFor = event.target.dataset.agent || ui.agentBotsFor; });
document.addEventListener('click', async event => {
  const target = event.target.closest?.('[data-action^="ab-"]'); if (!target) return;
  event.stopPropagation();
  const agentId = target.dataset.agent, base = `/agents/${encodeURIComponent(agentId)}/telegram`, set = status => { ui.agentBots = { ...(ui.agentBots || {}), [agentId]: status }; renderAll(); };
  try {
    switch (target.dataset.action) {
      case 'ab-connect': { const token = document.querySelector('[data-ab-token]')?.value.trim() || ''; if (!token) return toast(t('Paste the bot token first.'), true); target.disabled = true; set(await api(`${base}/connect`, { method: 'POST', data: { botToken: token } })); ui.agentBotDraft = {}; toast(t('Bot connected.')); break; }
      case 'ab-disconnect': if (await askConfirm(t`Disconnect this bot?

The agent stops getting messages from it.`, { ok: t('Disconnect') })) set(await api(`${base}/disconnect`, { method: 'POST', data: {} })); break;
      case 'ab-code': set(await api(`${base}/code`, { method: 'POST', data: {} })); break;
      case 'ab-allow': set(await api(`${base}/groups`, { method: 'POST', data: { id: target.dataset.gid, title: target.dataset.title } })); break;
      case 'ab-remove': set(await api(`${base}/groups/remove`, { method: 'POST', data: { id: target.dataset.gid } })); break;
    }
  } catch (error) { target.disabled = false; toast(error.message, true); }
}, true);
function personalSide(run, agent, items, shells) {
  // Tabs, like a messenger's chat info: Profile (with what was shared in the chat), the worktrees of this chat, and the agent's Terminal.
  const trees = chatWorktrees(ui, { runId: run.id, agentId: agent.id });
  const subs = items.filter(item => item.role === 'subagent');
  const team = teamOf(agent.id);
  const tab = ui.chatTab === 'terminal' && shells.length ? 'terminal' : ui.chatTab === 'connectors' ? 'connectors' : ui.chatTab === 'worktrees' ? 'worktrees' : ui.chatTab === 'subagents' || ui.chatTab === 'team' ? 'team' : 'profile', part = ['media', 'files', 'links', 'pinned'].includes(ui.chatShared) ? ui.chatShared : 'media';
  const entries = items.filter(item => item.role === 'human' || item.role === 'agent').map(item => ({ from: item.role === 'human' ? t('You') : agent.name, at: item.at, text: item.text }));
  const shared = collectShared(entries, (ui.snap.artifacts || []).filter(item => item.runId === run.id).map(item => ({ ...item, from: agent.name })));
  const close = `<button type="button" class="side-x" data-action="chat-info-close" aria-label="${t`Close the side panel`}" title="${t`Close`}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
  const tabs = sideTabsHtml(esc, { action: 'chat-tab', current: tab, close, tabs: [
    { id: 'profile', label: t('Profile'), group: 'about' },
    { id: 'connectors', label: t('Connectors'), group: 'about' },
    { id: 'team', label: t('Team'), count: team.open + (stateTone(run) === 'working' ? subs.filter(item => !item.done).length : 0), owed: team.owed, group: 'work' },
    { id: 'worktrees', label: t('Worktrees'), count: trees.length, group: 'code' },
    ...(shells.length ? [{ id: 'terminal', label: t('Terminal'), count: shells.length, group: 'code' }] : [])] });
  if (tab === 'connectors') return tabs + connectorsPanel(agent);
  if (tab === 'worktrees') return tabs + worktreeSideHtml(ctx, trees);
  if (tab === 'team') return tabs + crewHtml({ taskBody: teamPanel(agent, team), taskCount: team.tasks.length, subBody: subagentsPanel(subs.map(item => ({ ...item, runId: run.id })), ctx, { live: () => stateTone(run) === 'working', jump: true }), subCount: subs.length, labels: { tasks: t('Team tasks'), subs: t('Sub-agents') },
    empty: `<div class="side-body"><div class="side-empty">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.8c1.5.6 2.6 1.9 3 4.2"/></svg>'}<p>${t`No team work yet. When ${esc(agent.name)} hands work to another agent or runs a sub-agent, it shows here.`}</p></div></div>` });
  if (tab === 'terminal') return tabs + terminalHtml(shells, { esc, hhmm }).replace(/^<div class="side-head">[\s\S]*?<\/div>(?=<div class="tl-bar)/, '');
  const sharedBox = `<h3>${t`Media, files and links`}</h3><div class="pshared"><div class="pseg">${sharedTabButtons(shared, part, 'chat-shared', chatPins(ui, `agent:${agent.id}`).length)}</div><div class="shared">${sharedTabsHtml(ctx, shared, part, `agent:${agent.id}`)}</div></div>`;
  const sources = (agent.taskSources || []).map(id => id === 'local' ? t('Rex Desk tasks') : (ui.snap.config?.sources || []).find(source => source.id === id)?.name).filter(Boolean);
  const rooms = (ui.snap.rooms || []).filter(room => room.members.some(member => member.id === agent.id));
  // The Profile tab: who this is and what it is doing, what was shared, and the few things worth changing from a chat.
  const ai = aiKey(agent.provider);
  const model = agent.model ? ((ui.snap.choices?.providers?.[ai] || ui.snap.choices || {}).models || []).find(item => item.id === agent.model)?.label || agent.model : t('Default');
  const avatar = agent.remote ? avatarHtml(ctx, { name: agent.name, agent, size: 'sm' }) : `<button type="button" class="av-edit" data-action="avatar-pick" data-agent-id="${esc(agent.id)}" title="${t`Change ${esc(agent.name)}'s avatar`}" aria-label="${t`Change ${esc(agent.name)}'s avatar`}">${avatarHtml(ctx, { name: agent.name, agent, size: 'sm' })}</button>`;
  const openFull = agent.main ? '' : `<button type="button" class="aps-open" data-open="specialist" data-id="${esc(agent.id)}" data-profile="1" title="${t`Open the full profile`}" aria-label="${t`Open the full profile`}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></button>`;
  const head = `<header class="aps-head">${avatar}<div class="aps-who"><h2>${esc(agent.name)}</h2><p><span class="dot ${stateTone(run) === 'working' ? 'working' : 'good'}"></span>${esc(agent.status?.label || stateLabel(run))}${agent.main || !agent.projectSlug ? '' : ` · <a href="#" data-open="project" data-id="${esc(agent.projectSlug)}">${esc(agent.projectSlug)}</a>`}</p></div>${openFull}</header>`;
  const sec = (title, body, count = 0) => `<section class="aps-sec"><h3>${title}${count ? ` <span class="aps-count">${count}</span>` : ''}</h3>${body}</section>`;
  const row = (label, value) => `<div class="aps-row"><span>${label}</span><div>${value}</div></div>`;
  const setup = agent.main ? '' : sec(t('Setup'), [
    row('AI', esc(provider(agent.provider || 'claude'))),
    row(t('Model'), esc(model)),
    row(t('Account'), pickerHtml(ctx, { id: 'pp-profile', label: t('Account'), value: agent.profile || '', compact: true, items: [{ value: '', label: t('Same as everyone'), hint: t('The account chosen at the bottom left') }, ...((ui.accounts?.[ai === 'codex' ? 'codex' : 'claude']?.profiles) || []).filter(item => item.loggedIn).map(item => ({ value: item.profile, label: item.account || item.label, hint: [item.label, item.plan].filter(Boolean).join(' · ') }))] })),
    whereLine(ctx, agent),
    row(t('Tasks from'), esc(sources.join(', ') || t('Not set yet'))),
  ].join('') + (agent.remote && !agent.pinned ? `<button class="btn small aps-wide" data-action="spec-move" data-agent-id="${esc(agent.id)}">${t`Move to this computer`}</button>` : ''));
  const lessons = (agent.lessons || []).slice(-3).reverse();
  return `${tabs}<div class="side-body aps">
    ${head}
    ${agent.purpose ? `<p class="aps-about">${esc(agent.purpose)}</p>` : ''}
    ${sec(t('Media, files and links'), `<div class="pshared"><div class="pseg">${sharedTabButtons(shared, part, 'chat-shared', chatPins(ui, `agent:${agent.id}`).length)}</div><div class="shared">${sharedTabsHtml(ctx, shared, part, `agent:${agent.id}`)}</div></div>`)}
    ${setup}
    ${toolsHtml(agent.main ? 'main' : agent.id)}
    ${lessons.length ? sec(t('Lessons learned'), `<ul class="aps-list">${lessons.map(lesson => `<li>${esc(lesson.text)}</li>`).join('')}</ul>`, agent.lessons.length) : ''}
    ${rooms.length ? sec(t('Meeting rooms'), `<ul class="rtasks">${rooms.map(room => `<li><button class="rtask" data-open="room" data-id="${esc(room.id)}">${avatarHtml(ctx, { name: room.name, image: room.image, id: room.id, members: (room.members || []).map(member => member.id || member), at: room.imageAt || '', size: 'xs' })}<span>${esc(room.name)}</span></button></li>`).join('')}</ul>`, rooms.length) : ''}
    ${agent.main ? '' : earlierChats(agent)}
  </div>`;
}
// The Team tab: the person answers a worker's question or cancels a task, in the manager's place.
document.addEventListener('click', async event => {
  const target = event.target.closest?.('[data-action="team-cancel"],[data-action="team-answer"]'); if (!target) return;
  event.stopPropagation();
    const text = target.dataset.action === 'team-answer' ? target.closest('.tm-task')?.querySelector('[name="tm-answer"]')?.value.trim() || '' : '';
    if (target.dataset.action === 'team-answer' && !text) return toast(t('Write the answer first.'), true);
    try { await api(`/team/${encodeURIComponent(target.dataset.task)}`, { method: 'POST', data: { action: target.dataset.action === 'team-cancel' ? 'cancel' : 'answer', text } }); toast(target.dataset.action === 'team-cancel' ? t('Canceled.') : t('Sent.')); await refresh(); } catch (error) { toast(error.message, true); }
    return;
});
document.addEventListener('click', event => {
  const target = event.target.closest?.('[data-action="chat-tab"],[data-action="chat-shared"],[data-action="chat-info-close"],[data-action="chat-info"],[data-copy]'); if (!target) return;
  event.stopPropagation();
  if (target.dataset.copy !== undefined) { void navigator.clipboard?.writeText(target.dataset.copy).then(() => toast(t('Path copied.')), () => toast(t('Could not copy.'), true)); return; }
  if (target.dataset.action === 'chat-tab') { ui.chatTab = saveSideTab('chat', target.dataset.tab); ui.agentBotDraft = {}; ui.agentBotsFor = ''; }
  else if (target.dataset.action === 'chat-shared') ui.chatShared = target.dataset.tab;
  else ui.chatInfo = target.dataset.action === 'chat-info';
  renderAll();
}, true);

// ---------- dictated messages ----------
// Added to a message that came from the microphone. It reaches the agent, but the chat shows the message without it.
const VOICE_NOTE = '\n\n(Sent by voice: speech-to-text may have misheard some words, names or Khmer and Korean terms. Read it against our conversation and the topic we are on, and work out what I meant. If a word could change what you do and you are not sure, ask.)';
function spokenText(text) { const mark = /\s*\(Sent by voice: [^)]*\)\s*$/; return mark.test(String(text || '')) ? { text: String(text).replace(mark, ''), voice: true } : { text, voice: false }; }
document.addEventListener('input', event => { if (event.target.id === 'draft' && !event.target.value.trim()) ui.voiceDrafts?.delete(draftKey()); });

function micIcon() { return `<svg class="vmic" viewBox="0 0 16 16" width="12" height="12" aria-label="${t`Sent by voice`}" role="img"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`; }

// Adding and removing lines in "How your agents should talk to you".
document.addEventListener('submit', async event => {
  const form = event.target.closest?.('[data-note-add]'); if (!form) return; event.preventDefault(); event.stopPropagation();
  const text = form.text.value.trim(); if (!text) return;
  try { await api('/profile/notes', { method: 'POST', data: { kind: form.dataset.noteAdd, text } }); form.text.value = ''; document.activeElement?.blur?.(); toast(t('Saved. Every agent follows it from now on.')); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
}, true);
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-note-forget]'); if (!button) return; event.stopPropagation();
  try { await api('/profile/notes', { method: 'DELETE', data: { kind: button.dataset.noteForget, text: button.dataset.noteText } }); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
}, true);

// ---------- Claude accounts: which subscription the agents run on ----------
function rexAccountChip() {
  const account = ui.snap?.database?.account, who = account?.name || account?.email || ui.snap?.account?.email || '';
  if (!who) return `<span class="acct-av none" aria-hidden="true">?</span><span class="acct-text"><b>${t`Sign in to Rex Desk`}</b></span>`;
  const paid = ui.snap?.database?.space?.paid, plan = ui.snap?.database?.space ? (paid ? t('Cloud backup') : t('Free')) : '';
  return `<span class="acct-av" aria-hidden="true">${esc(who[0].toUpperCase())}</span><span class="acct-text"><b>${esc(who)}</b>${plan ? `<small>${esc(plan)}</small>` : ''}</span>`;
}
function accountChip() {
  const name = aiKey(ui.snap?.config?.provider), list = ui.accounts?.[name], current = list?.profiles?.find(item => item.profile === list.selected) || list?.profiles?.[0];
  const ai = { codex: t('Codex'), gemini: t('Gemini') }[name] || t('Claude');
  return `<span class="acct-dot ${current?.loggedIn ? 'good' : 'bad'}"></span><span class="acct-text">${current?.loggedIn ? t`${ai} connected` : t`${ai} not connected`}</span>`;
}
async function loadAccounts(refreshStatus = false) { try { ui.accounts = await api(`/agents${refreshStatus ? '?refresh=1' : ''}`); ui.accountsAuto = (await api('/accounts/auto')).on; } catch {} }
async function accountsDialog() {
  document.querySelector('.dialog-back.accounts')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back accounts'; document.body.append(back);
  const NAMES = { claude: [t('Claude'), t('Claude Code'), t('Claude')], codex: [t('Codex'), t('Codex'), 'ChatGPT'], gemini: [t('Gemini'), t('Gemini'), t('Google')], openrouter: [t('OpenRouter'), t('OpenRouter'), 'OpenRouter'] };
  const tab = () => NAMES[ui.acctTab] ? ui.acctTab : aiKey(ui.snap?.config?.provider);
  const draw = () => {
    const name = tab(), [short, product, service] = NAMES[name], list = ui.accounts?.[name] || { profiles: [] }, defaultAi = aiKey(ui.snap?.config?.provider);
    const signedIn = list.profiles.filter(item => item.loggedIn), signedOut = list.profiles.filter(item => !item.loggedIn);
    // The title is the account; the line under it says where it lives and what plan it is, without repeating the title or saying "none".
    // Each account: a colored letter for the person, the email, its plan as a tag, and the profile folder it lives in, in plain words.
    const where = item => { const label = String(item.label || ''), folder = label.match(/\.(?:claude|codex)(?:-([\w-]+?))?(?:-profile)?$/i); return /^Orca profile/i.test(label) ? t('Orca profile') : folder ? (folder[1] ? t`${folder[1][0].toUpperCase() + folder[1].slice(1)} profile` : t('Main profile')) : label; };
    const plan = item => item.plan && item.plan !== 'none' ? `<span class="acct-plan">${esc(`${item.plan[0].toUpperCase()}${item.plan.slice(1)}`)}</span>` : '';
    // How much of each limit the account used, and when it resets: Claude Code and Codex report it while agents work on that account.
    const resets = at => { if (!at) return ''; const date = new Date(at), today = new Date(); const time = date.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }); return date.toDateString() === today.toDateString() ? t`resets ${time}` : t`resets ${date.toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`; };
    const LIMITS = [['five_hour', '5 hours'], ['seven_day', t('Week')], ['seven_day_opus', t('Week, Opus')], ['seven_day_sonnet', t('Week, Sonnet')]];
    const savedUsage = (provider, profile) => (ui.snap.usage || []).find(entry => entry.provider === provider && (entry.profile || '') === (profile || '')) || (ui.snap.usage || []).find(entry => entry.provider === provider && entry.id === `${provider}:${profile || 'default'}`);
    const usageHtml = (provider, profile) => {
      const saved = savedUsage(provider, profile);
      // The known limits first, then any other one the account reports (a per-model week, like Fable), under its own label.
      const extra = Object.entries(saved?.windows || {}).filter(([key]) => !LIMITS.some(([known]) => known === key)).map(([key, value]) => [key, value.label || key.replace(/^seven_day_/, 'Week, ').replace(/_/g, ' ')]);
      const windows = [...LIMITS, ...extra].filter(([key]) => saved?.windows?.[key] && (saved.windows[key].used !== null || saved.windows[key].resetsAt));
      if (!windows.length) return `<span class="acct-usage none">${t`Usage shows after an agent works on this account.`}</span>`;
      return `<span class="acct-usage">${windows.map(([key, label]) => { const limit = saved.windows[key], used = limit.used ?? 0, passed = limit.resetsAt && limit.resetsAt < Date.now(); return `<span class="acct-limit ${used >= 90 && !passed ? 'hot' : ''}"><span class="acct-lname">${label}</span><meter min="0" max="100" low="70" high="90" optimum="0" value="${passed ? 0 : used}"></meter><span class="acct-lval">${passed ? 'reset' : `${used}%`}</span><span class="acct-lreset">${passed ? '' : esc(resets(limit.resetsAt))}</span></span>`; }).join('')}</span>`;
    };
    const row = item => { const who = item.account || item.label; return `<label class="acct-row${item.profile === list.selected ? ' on' : ''}" title="${esc(item.label)}"><input type="radio" name="profile" value="${esc(item.profile)}" ${item.profile === list.selected ? 'checked' : ''}><span class="acct-main"><span class="acct-name"><b>${esc(who)}</b>${plan(item)}${item.profile === list.selected ? `<span class="acct-badge"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>${t`In use`}</span>` : `<span class="acct-use">${t`Use`}</span>`}</span><small>${esc([item.account ? where(item) : '', item.method, savedUsage(name, item.profile)?.at ? t`as of ${new Date(savedUsage(name, item.profile).at).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })}` : ''].filter(Boolean).join(' · '))}</small>${usageHtml(name, item.profile)}</span></label>`; };
    const out = item => `<li><span class="acct-main"><b>${esc(item.account || item.label)}</b><small>${esc(item.label !== (item.account || item.label) ? item.label : t('Not signed in'))}</small></span><button type="button" class="btn small" data-acct-login="${esc(item.profile)}">${t`Sign in`}</button></li>`;
    // OpenRouter has no accounts to sign in to: one API key (typed here, checked, kept encrypted, never shown again) and the model agents use.
    const orBody = () => {
      const key = list.profiles[0] || {}, models = ui.snap.choices?.providers?.openrouter?.models || [], chosen = ui.snap.config?.models?.openrouter || '';
      // Laid out like a native settings page: grouped rows with the label on the left and the value on the right.
      const status = key.loggedIn ? `<span class="or-val good">${t`Key works`}</span>` : key.hasKey ? `<span class="or-val bad">${esc(key.error || t('OpenRouter did not accept the saved key.'))}</span>` : `<span class="or-val">${t`No key yet.`}</span>`;
      const use = defaultAi === name ? `<span class="or-val good">${t`In use`}</span>` : `<button type="button" class="or-link" data-acct-default="${name}" ${key.loggedIn ? '' : 'disabled'}>${t`Use`}</button>`;
      return `<p class="or-intro">${t`Agents on OpenRouter run through Claude Code with your OpenRouter key. You pay OpenRouter for what they use.`}</p>
      <div class="or-group">
        <div class="or-row"><span>${t`Status`}</span>${status}</div>
        ${key.plan ? `<div class="or-row"><span>${t`Plan`}</span><span class="or-val">${esc(key.plan)}</span></div>` : ''}
        ${key.account ? `<div class="or-row"><span>${t`Key`}</span><span class="or-val mono">${esc(key.account)}</span></div>` : ''}
        <div class="or-row"><span>${t`Use for new agents`}</span>${use}</div>
      </div>
      <div class="or-title or-title-act"><h3>${key.hasKey ? t('Replace key') : t('API key')}</h3><button type="button" class="or-link" data-acct-orsave>${t`Check and save`}</button></div>
      <div class="or-group">
        <div class="or-row or-field"><input type="password" data-acct-orkey autocomplete="off" spellcheck="false" placeholder="${key.hasKey ? t('Paste a new key') : 'sk-or-v1-…'}" aria-label="${t`OpenRouter API key`}"></div>
        ${key.hasKey ? `<div class="or-row"><button type="button" class="or-link bad" data-acct-ordel>${t`Remove key`}</button></div>` : ''}
      </div>
      <p class="or-note">${t`The key stays encrypted on this computer and is never shown in a chat. Jev uses the same key.`} <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">${t`Get a key`}</a></p>
      ${key.loggedIn ? `<h3 class="or-title">${t`Agents`}</h3><div class="or-group"><label class="or-row"><span>${t`Model`}</span><select data-acct-ormodel>${[['', t('Claude Sonnet, latest')], ...models.map(model => [model.id, model.label])].map(([id, label]) => `<option value="${esc(id)}" ${id === chosen ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label></div>
      <p class="or-note">${t`Claude models work best. Other models may not handle every tool.`}</p>` : ''}`;
    };
    back.innerHTML = `<form class="dialog acct-dialog"><div class="acct-head"><h2>${t`AI accounts`}</h2><button type="button" class="side-x" data-close aria-label="${t`Close`}" title="${t`Close`}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>
      <div class="acct-tabs" role="tablist">${Object.entries(NAMES).map(([key, [, title]]) => `<button type="button" role="tab" aria-selected="${name === key}" class="acct-tab${name === key ? ' on' : ''}" data-acct-tab="${key}"><b>${title}</b>${defaultAi === key ? `<span class="acct-default-badge">${t`Default`}</span>` : ''}</button>`).join('')}</div>
      <div class="acct-body">${name === 'openrouter' ? orBody() : `<div class="acct-intro"><p>${t`Agents on ${product} run on the account marked ${`<b>${t`In use`}</b>`}. Click another account to switch.`}</p>${defaultAi === name ? `<span class="acct-note">${t`New agents and chats use ${product}`}</span>` : `<button type="button" class="btn small" data-acct-default="${name}">${t`Use ${product} for new agents`}</button>`}</div>
      ${signedIn.length ? `<div class="acct-list">${signedIn.map(row).join('')}</div>` : `<p class="acct-empty">${t`No ${service} account is signed in yet. Press Sign in: a window opens, installs ${name === 'codex' ? 'the Codex CLI' : name === 'gemini' ? 'the Antigravity CLI' : t('Claude Code')} if this computer does not have it yet, and opens the sign-in in your browser.`}</p>`}
      ${signedOut.length ? `<details class="acct-out"${signedIn.length ? '' : ' open'}><summary>${t`Not signed in`} <span>${signedOut.length}</span></summary><ul>${signedOut.map(out).join('')}</ul></details>` : ''}
      ${name === 'gemini' ? '' : `<div class="acct-add" data-acct-addbox>${ui.acctAdding ? `<input type="text" data-acct-name maxlength="30" placeholder="${t`Name for the new account, like work or personal`}" aria-label="${t`Name for the new account`}"><button type="button" class="btn small primary" data-acct-create>${t`Create and sign in`}</button><button type="button" class="btn small" data-acct-cancel>${t`Cancel`}</button>` : `<button type="button" class="btn small" data-acct-new>${t`+ Add a ${short} account`}</button>`}</div>`}
      ${ui.acctWaiting ? `<p class="acct-wait"><span class="dot working"></span> ${t`Finish signing in to ${service} in the window that opened. This list updates by itself.`}</p>` : ''}
      <label class="acct-auto"><input type="checkbox" data-acct-auto ${ui.accountsAuto !== false ? 'checked' : ''}><span>${t`When an account hits its usage limit, switch to another signed-in one and continue`}</span></label>`}</div></div>
      <div class="acct-foot"><button type="button" class="btn quiet" data-acct-refresh>${t`Check again`}</button><button type="button" class="btn primary" data-close>${t`Done`}</button></div></form>`;
  };
  if (!ui.accounts) { back.innerHTML = `<div class="dialog"><p class="muted">${t`Checking your AI accounts…`}</p></div>`; await loadAccounts(true); }
  draw();
  back.addEventListener('click', async event => {
    if (event.target === back || event.target.closest('[data-close]')) { back.remove(); renderAll(); return; }
    const switchTab = event.target.closest('[data-acct-tab]'); if (switchTab) { ui.acctTab = switchTab.dataset.acctTab; ui.acctAdding = false; draw(); return; }
    const pickDefault = event.target.closest('[data-acct-default]');
    if (pickDefault) { try { await api('/config', { method: 'PUT', data: { ...ui.snap.config, provider: pickDefault.dataset.acctDefault } }); await refresh(); ui.acctTab = pickDefault.dataset.acctDefault; toast(t`New agents and chats use ${{ codex: t('Codex'), gemini: t('Gemini') }[pickDefault.dataset.acctDefault] || t('Claude Code')}.`); draw(); } catch (error) { toast(error.message, true); } return; }
    if (event.target.closest('[data-acct-orsave]')) {
      const input = back.querySelector('[data-acct-orkey]'), key = input.value.trim(); input.value = '';
      if (!key) { toast(t('Paste your OpenRouter key first.'), true); return; }
      const button = back.querySelector('[data-acct-orsave]'); button.disabled = true; button.textContent = t('Checking…');
      try { await api('/agents/openrouter-key', { method: 'POST', data: { key } }); toast(t('OpenRouter key saved. It works.')); } catch (error) { toast(error.message, true); }
      await loadAccounts(true); await refresh(); draw(); return;
    }
    if (event.target.closest('[data-acct-ordel]')) {
      if (!await askConfirm(t`Remove the OpenRouter key? Agents on OpenRouter and Jev stop working until a new one is added.`)) return;
      try { await api('/agents/openrouter-key', { method: 'DELETE' }); } catch (error) { toast(error.message, true); }
      await loadAccounts(true); draw(); return;
    }
    if (event.target.closest('[data-acct-refresh]')) { back.querySelector('[data-acct-refresh]').textContent = t('Checking…'); await loadAccounts(true); draw(); }
    if (event.target.closest('[data-acct-new]')) { ui.acctAdding = true; draw(); back.querySelector('[data-acct-name]')?.focus(); }
    if (event.target.closest('[data-acct-cancel]')) { ui.acctAdding = false; draw(); }
    const login = event.target.closest('[data-acct-login]'), create = event.target.closest('[data-acct-create]');
    if (login || create) {
      event.preventDefault(); const name = tab(), signedIn = () => (ui.accounts?.[name]?.profiles || []).filter(item => item.loggedIn).length;
      try {
        let started;
        if (create) { const label = back.querySelector('[data-acct-name]').value.trim(); if (!label) return toast(t('Give the account a name first.'), true); started = await api('/agents/add', { method: 'POST', data: { name: label, provider: name } }); ui.acctAdding = false; }
        else started = await api('/agents/login', { method: 'POST', data: { profile: login.dataset.acctLogin, provider: name } });
        if (started?.installing) toast(t('A sign-in window opened. It installs the tool first, then opens the browser.'));
        ui.acctWaiting = true; await loadAccounts(true); draw();
        // Sign-in happens in the browser; look again every few seconds for up to three minutes, or ten while the tool installs.
        for (let tries = 0; tries < (started?.installing ? 200 : 60) && ui.acctWaiting && document.body.contains(back); tries++) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          const before = signedIn(); await loadAccounts(true);
          if (signedIn() > before) { ui.acctWaiting = false; toast(t('Signed in. You can pick this account now.')); }
          if (document.body.contains(back)) draw();
        }
        ui.acctWaiting = false; if (document.body.contains(back)) draw();
      } catch (error) { ui.acctWaiting = false; toast(error.message, true); draw(); }
    }
  });
  back.addEventListener('keydown', event => { if (event.target.matches('[data-acct-name]') && event.key === 'Enter') { event.preventDefault(); back.querySelector('[data-acct-create]')?.click(); } });
  back.addEventListener('change', async event => {
    try {
      if (event.target.name === 'profile') { const name = tab(); await api('/agents/profile', { method: 'POST', data: { provider: name, profile: event.target.value } }); await loadAccounts(); toast(t`Agents on ${NAMES[name][1]} now use this account from their next reply.`); draw(); }
      if (event.target.matches('[data-acct-ormodel]')) { const config = ui.snap.config; ui.snap.config = await api('/config', { method: 'PUT', data: { ...config, models: { ...config.models, openrouter: event.target.value } } }); toast(t('Model saved. Agents on OpenRouter use it from their next reply.')); }
      if (event.target.matches('[data-acct-auto]')) { ui.accountsAuto = (await api('/accounts/auto', { method: 'POST', data: { on: event.target.checked } })).on; }
    } catch (error) { toast(error.message, true); }
  });
}
document.addEventListener('click', event => { if (!event.target.closest?.('[data-action="accounts"]')) return; event.stopPropagation(); void accountsDialog(); }, true);
void loadAccounts().then(() => { if (ui.snap) renderAll(); });

// ---------- Jev: say or type what this computer (or a website) should do ----------
function jevStage() {
  const log = ui.jevLog || [];
  const examples = [t('Turn the volume down to 30'), t('Open Bluetooth settings'), t('Turn on dark mode'), t('Find the cheapest flight from Phnom Penh to Seoul next Friday'), t('Take a screenshot'), t('What is using my memory?')];
  const entry = item => `<li class="jv-item"><div class="jv-said"><b>${esc(item.text)}</b><small>${esc(item.at)}</small></div>${item.busy ? `<p class="muted">${t`Working…`}</p>` : ''}${item.error ? `<p class="bad">${esc(item.error)}</p>` : ''}${item.say ? `<p>${esc(item.say)}</p>` : ''}${(item.results || []).map(step => `<p class="jv-step ${step.ok ? 'ok' : 'bad'}">${step.ok ? '✓' : '✗'} ${esc(step.title)}${step.ok ? (step.result?.url ? ` · <a href="${esc(step.result.url)}">${t`open its chat`}</a>` : step.result?.text ? ` · ${esc(String(step.result.text).slice(0, 160))}` : '') + jevDetail(step.result) : ` · ${esc(step.error)}`}</p>`).join('')}${item.confirm ? `<div class="jv-confirm"><span>${t`Do this?`} <b>${esc(item.confirm.join(', '))}</b></span><button class="btn small primary" data-jev-yes="${item.id}">${t`Yes`}</button><button class="btn small" data-jev-yes="${item.id}" data-always="1" title="${t`Do it now, and never ask again for ${esc(item.confirm.join(', '))}`}">${t`Yes, always`}</button><button class="btn small quiet" data-jev-no="${item.id}">${t`Cancel`}</button></div>` : ''}</li>`;
  return { title: t('Jev'), meta: t('Control this computer and websites'), top: true,
    feed: `<div class="page jv"><section class="jv-hero"><h2>${t`What should Jev do?`}</h2><p class="muted">${t`On this computer: apps, settings, sound, screen, Wi-Fi and Bluetooth, files, typing and clicking. On the web: search, compare and book with a browser agent that asks before paying. Khmer, English or Korean. Hold Space in the box below to talk. From any app, press ${'<kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>J</kbd>'}.`}</p>
      <div class="jv-examples">${examples.map(text => `<button class="chip-btn" data-jev-try="${esc(text)}">${esc(text)}</button>`).join('')}</div></section>
      ${log.length ? `<ol class="jv-log">${log.slice().reverse().map(entry).join('')}</ol>` : ''}</div>`,
    composer: { placeholder: t('Tell Jev what to do… (hold Space to talk)'), mentions: [], noPickers: true } };
}
async function jevDo(text) {
  const item = { id: String(Date.now()), text, at: new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }), busy: true };
  ui.jevLog = [...(ui.jevLog || []), item].slice(-30); renderAll();
  try {
    const answer = await api('/computer/do', { method: 'POST', data: { text } });
    Object.assign(item, { busy: false, say: answer.say, results: answer.results || [], steps: answer.steps, confirm: answer.needsConfirm?.length ? answer.needsConfirm : null, confirmActions: answer.confirmActions || [], error: !answer.steps?.length ? (answer.say || t('Jev did not find something to do for that. Try other words.')) : '' });
    if (item.error === item.say) item.say = '';
  } catch (error) { Object.assign(item, { busy: false, error: error.message }); }
  renderAll();
}
document.addEventListener('click', async event => {
  const tryIt = event.target.closest?.('[data-jev-try]'); if (tryIt) { event.stopPropagation(); return jevDo(tryIt.dataset.jevTry); }
  const yes = event.target.closest?.('[data-jev-yes]'), no = event.target.closest?.('[data-jev-no]'); if (!yes && !no) return;
  event.stopPropagation(); const item = (ui.jevLog || []).find(entry => entry.id === (yes || no).dataset[yes ? 'jevYes' : 'jevNo']); if (!item) return;
  item.confirm = null;
  if (no) { item.say = t('Cancelled.'); return renderAll(); }
  // "Yes, always": these actions stop asking from now on (Settings, Jev and voice, lists them).
  if (yes.dataset.always && item.confirmActions?.length) await api('/computer/allow', { method: 'POST', data: { actions: item.confirmActions } }).then(() => toast(t('Jev will do that without asking from now on.'))).catch(error => toast(error.message, true));
  item.busy = true; renderAll();
  try { const answer = await api('/computer/run', { method: 'POST', data: { steps: item.steps } }); Object.assign(item, { busy: false, results: answer.results || [] }); } catch (error) { Object.assign(item, { busy: false, error: error.message }); }
  renderAll();
}, true);

// What an action returned, in a few readable lines: a list of programs or windows, a level, a battery reading.
function jevDetail(result) {
  if (!result || typeof result !== 'object') return '';
  const list = Array.isArray(result) ? result : result.processes || result.programs || result.windows || result.apps || result.items || null;
  if (Array.isArray(list) && list.length) {
    const row = item => {
      if (typeof item !== 'object') return '<li>' + esc(item) + '</li>';
      const name = item.name || item.title || item.process || '';
      const mb = item.memoryMB ?? item.mb, other = item.cpu ?? item.percent ?? item.memory;
      const extra = mb !== undefined ? Math.round(mb) + ' MB' : other !== undefined ? String(other) : '';
      return '<li><b>' + esc(name) + '</b>' + (extra ? ' <span class="muted">' + esc(extra) + '</span>' : '') + '</li>';
    };
    return '<ul class="jv-list">' + list.slice(0, 8).map(row).join('') + '</ul>';
  }
  const parts = [];
  if (result.level !== undefined) parts.push(result.level + '%' + (result.muted ? ', muted' : ''));
  if (result.percent !== undefined) parts.push(result.percent + '%' + (result.charging ? ', charging' : ''));
  return parts.length ? ' · ' + esc(parts.join(' · ')) : '';
}

// The account picked in an agent's profile panel is saved for that agent at once.
document.addEventListener('change', async event => {
  if (event.target.id !== 'pp-profile') return;
  const run = runById(ui.view.id), agent = run && personalAgent(run); if (!agent || agent.main) return;
  try { await api(`/specialists/${agent.id}`, { method: 'PUT', data: { profile: event.target.value } }); toast(event.target.value ? t`${agent.name} now uses that Claude account.` : t`${agent.name} uses the same account as everyone.`); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
});
document.addEventListener('change', event => {
  const input = event.target.closest?.('[data-cover-upload]'); if (!input) return;
  const agent = (ui.snap.specialists || []).find(item => item.id === input.closest('[data-agent]')?.dataset.agent), file = input.files?.[0]; input.value = '';
  if (agent && file) void saveCover(ctx, agent, file);
});
// Forms inside popups are handled by their buttons; pressing Enter never reloads the page.
document.addEventListener('submit', event => { if (event.target.closest?.('.settings-pop,.acct-dialog,.vdialog,.src-dialog')) event.preventDefault(); });

// The MCP servers and skills an agent has, in its profile panel: exactly what its instructions name (one list, read by both),
// then the skills it can find by searching.
function toolsHtml(id) {
  const tools = ui.tools?.[id];
  if (!tools || tools.loading) { ui.tools = ui.tools || {}; if (!tools) { ui.tools[id] = { loading: true, servers: [], skills: [], more: [] }; void api(`/agents/tools?agent=${encodeURIComponent(id)}`).then(found => { ui.tools[id] = found; renderAll(); }).catch(() => {}); } return `<section class="aps-sec"><h3>${t`Tools`}</h3><p class="aps-faint">${t`Checking…`}</p></section>`; }
  const servers = tools.servers || [], skills = tools.skills || [], more = tools.more || [];
  const server = item => `<li class="${item.error ? 'tl-failed' : ''}"><b>${esc(item.name)}</b><small>${item.error ? `${t`Could not connect`} · ${esc(item.error)}` : item.tools.length ? esc(item.tools.join(', ')) : t('Its tools are listed the first time it is used.')}</small></li>`;
  const skill = item => `<li><b>${esc(item.name)}</b><small>${esc(item.description || '')}</small></li>`;
  const count = more.length ? t`${servers.length} MCP · ${skills.length} skills + ${more.length} by search` : t`${servers.length} MCP · ${skills.length} skills`;
  // One line until opened: the lists are long, and rarely what a chat needs.
  return `<details class="aps-tools"><summary><h3>${t`Tools`}</h3><span class="aps-faint">${count}</span></summary>
    <h4 class="tl-h">${t`MCP servers`}</h4><ul class="tl-list">${servers.map(server).join('') || `<li class="muted small">${t`None.`}</li>`}</ul>
    <h4 class="tl-h">${t`Skills named in its instructions`}</h4><ul class="tl-list">${skills.map(skill).join('') || `<li class="muted small">${t`None.`}</li>`}</ul>
    ${more.length ? `<details class="tl-more"><summary>${t`${more.length} more it can find with search`}</summary><ul class="tl-list">${more.map(skill).join('')}</ul></details>` : ''}</details>`;
}

// ---------- a sign-in an agent needs: open a terminal running the command, sign in, say done ----------
function signInCard(item) {
  const run = runById(item.runId), opened = ui.signInOpened?.has(item.id);
  if (item.request?.purpose === 'run') return `<div class="card ask scard" data-signin="${esc(item.id)}"><div class="qhead"><span class="qdot"></span>${t`Your agent needs you to run this · ${esc(runTitle(run))}`}</div>
    <div class="qtext md">${markdown(String(item.title || ''))}</div>
    <div class="scmd"><code>${esc(item.request?.command || '')}</code></div>
    <p class="fnote">${t`No terminal needed: Run opens a window on this computer with this command running. Do what it asks, then press Done.`}</p>
    <div class="row"><button type="button" class="send-btn wide" data-signin-open data-run>${opened ? t('Run again') : t('Run')}</button><button type="button" class="btn small ${opened ? 'primary' : ''}" data-signin-done>${t`Done`}</button><button type="button" class="btn small" data-signin-skip>${t`Not now`}</button></div></div>`;
  return `<div class="card ask scard" data-signin="${esc(item.id)}"><div class="qhead"><span class="qdot"></span>${t`Sign-in needed · ${esc(runTitle(run))}`}</div>
    <div class="qtext md">${markdown(String(item.title || ''))}</div>
    <div class="scmd"><code>${esc(item.request?.command || '')}</code></div>
    <p class="fnote">${t`Opens a terminal on this computer running this command. Sign in there; the tool keeps the sign-in on this computer, so every agent can use it.`}</p>
    <div class="row"><button type="button" class="send-btn wide" data-signin-open>${opened ? t('Open the terminal again') : t('Open terminal')}</button><button type="button" class="btn small ${opened ? 'primary' : ''}" data-signin-done>${t`I'm signed in`}</button><button type="button" class="btn small" data-signin-skip>${t`Not now`}</button></div></div>`;
}
document.addEventListener('click', async event => {
  const card = event.target.closest?.('[data-signin]'); if (!card) return;
  const id = card.dataset.signin;
  try {
    if (event.target.closest('[data-signin-open]')) { await api(`/interactions/${id}/terminal`, { method: 'POST', data: {} }); (ui.signInOpened ||= new Set()).add(id); toast(card.querySelector('[data-signin-open]').hasAttribute('data-run') ? t('Running. When it is finished, press Done.') : t('Terminal opened. Sign in there, then press "I\'m signed in".')); renderAll(); }
    else if (event.target.closest('[data-signin-done]')) { await api(`/interactions/${id}/answer`, { method: 'POST', data: { action: 'accept', content: {} } }); toast(t('Thanks. The agent checks it and goes on.')); await refresh(); }
    else if (event.target.closest('[data-signin-skip]')) { await api(`/interactions/${id}/answer`, { method: 'POST', data: { action: 'decline' } }); await refresh(); }
  } catch (error) { toast(error.message, true); }
});

// ---------- phone: the list screen's tab bar ----------
function phone() { return window.matchMedia('(max-width:760px)').matches; }
function phoneTabs(asks) {
  const ic = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const tab = (attrs, label, icon, on = false, badge = 0) => `<button type="button" ${attrs} class="${on ? 'on' : ''}">${icon}${badge ? `<span class="tb-badge">${badge}</span>` : ''}<span>${label}</span></button>`;
  return `<nav class="m-tabs" aria-label="${t`Sections`}">
    ${tab('data-action="m-top"', t('Chats'), ic('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'), true)}
    ${tab('data-open="inbox" data-id=""', t('Needs you'), ic('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'), false, asks)}
    ${tab('data-open="tasks" data-id=""', t('Tasks'), ic('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>'))}
    ${tab('data-open="jev" data-id=""', t('Jev'), ic('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'))}
    ${tab('data-action="settings-open"', t('Settings'), ic(SETTINGS_GEAR))}
  </nav>`;
}
document.addEventListener('click', event => { if (!event.target.closest?.('[data-action="m-top"]')) return; event.stopPropagation(); document.querySelector('.rail-scroll')?.scrollTo({ top: 0, behavior: 'smooth' }); }, true);

document.addEventListener('change', async event => {
  if (!event.target.matches?.('[data-mo-auto]')) return;
  try { await api('/config', { method: 'PUT', data: { ...ui.snap.config, autoFree: event.target.checked } }); toast(event.target.checked ? t('Rex Desk frees memory by itself when it runs low.') : t('Automatic freeing is off.')); await refresh(); } catch (error) { toast(error.message, true); }
});

// An agent's earlier personal chats (also the ones on another computer), newest first, in its profile.
function earlierChats(agent) {
  const runs = (ui.snap?.runs || []).filter(run => run.specialistId === agent.id && !run.roomAgent && !run.roomId && run.id !== agent.runId)
    .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt))).slice(0, 12);
  if (!runs.length) return '';
  return `<section class="aps-sec"><h3>${t`Earlier chats`} <span class="aps-count">${runs.length}</span></h3><ul class="tl-list">${runs.map(run => `<li><button type="button" class="link-btn" data-open="run" data-id="${esc(run.id)}"><b>${esc(runTitle(run))}</b></button><small>${esc(ago(run.updatedAt || run.createdAt))}</small></li>`).join('')}</ul></section>`;
}

// Messages on their way to an agent on another computer. One leaves the list when that computer's copy of the chat has it.
function outboxHtml(run, shown) {
  // The agent is on its way from another computer (L114): the message is already saved here and goes to it once it arrives.
  const mover = personalAgent(run), moving = mover?.move?.state === 'running';
  const movingLine = moving ? `<div class="msg moving-here" role="status"><div class="send-state"><span class="spin" aria-hidden="true"></span>${esc(t('Moving the agent here…'))}</div></div>` : '';
  const waiting = ui.outbox?.get(run.id); if (!waiting?.length) return movingLine;
  // The words the person sees, without the hidden voice note; a few minutes of leeway for the two computers' clocks.
  const words = text => spokenText(String(text || '').split(/\n*Attached files \(read them from these paths\):/)[0]).text.replace(/\s+/g, ' ').trim().slice(0, 200);
  const arrived = item => shown.some(event => event.kind === 'human-message' && Date.parse(event.createdAt || 0) > Date.parse(item.at) - 300000 && words(event.text).includes(words(item.text)));
  const left = waiting.filter(item => !arrived(item)); ui.outbox.set(run.id, left);
  const agent = personalAgent(run), where = agent?.device || 'the other computer', off = agent?.status?.state === 'offline';
  return left.map(item => {
    const old = Date.now() - Date.parse(item.at) > 20000;
    // An agent on this computer: "starting"; if nothing picks it up it stays shown as kept, never lost. An agent on
    // another computer: "sending to <device>", then "still on its way" after a while.
    const state = moving ? t('Moving the agent here…') : item.local
      ? (old ? t('Not picked up yet. Kept here; send again if needed.') : t('Starting the agent…'))
      : (!item.sent ? t('Sending…') : off ? t`Waiting for ${where} to turn on` : Date.now() - Date.parse(item.at) > 45000 ? t`Still on its way to ${where}…` : t`Sending to ${where}…`);
    return `<div class="msg mine sending${item.local && old && !moving ? ' stuck' : ''}"><div class="bubble">${(sent => sent.top + `<div class="md">${markdown(spokenText(sent.text).text)}</div>` + sent.html)(attachedFiles(item.text, esc))}<div class="send-state">${item.local && old && !moving ? '' : '<span class="spin" aria-hidden="true"></span>'}${esc(state)}</div></div></div>`;
  }).join('') + movingLine;
}
// While a message is on its way, the screen looks again every few seconds, so "Still on its way" shows even with no news.
setInterval(() => { if (([...(ui.outbox?.values() || [])].some(list => list.length) || (ui.snap?.specialists || []).some(agent => agent.move?.state === 'running')) && ui.view.type === 'run') renderAll(); }, 5000);

// Scrolled up through the history: a round button brings the chat back to the newest message, and says when new ones came in.
function syncToEnd() {
  const feed = document.getElementById('feed'), button = document.getElementById('to-end'); if (!feed || !button) return;
  const far = feed.scrollHeight - feed.scrollTop - feed.clientHeight > 240;
  button.hidden = !far; button.classList.toggle('fresh', far && Boolean(ui.freshBelow));
  // Just above the message box, however tall it is now.
  const box = document.getElementById('composer'); button.style.bottom = `${(box?.offsetHeight || 0) + 16}px`;
}
document.addEventListener('click', event => {
  if (!event.target.closest?.('#to-end')) return;
  const feed = document.getElementById('feed'); if (!feed) return;
  ui.stick = true; ui.freshBelow = false;
  feed.scrollTo({ top: feed.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

// ---------- phone: the chat list like a messenger ----------
function phIcon(name) {
  return ({
  bell: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
})[name];
}
function phoneHead() {
  const unread = ui.snap?.notices?.unread || 0;
  const me = ui.profile?.photo ? `<img class="av photo" src="${photoUrl()}" alt="">` : `<span class="av icon">${SVG.person}</span>`;
  return `<div class="m-head"><div class="m-bar"><button type="button" class="m-me" data-open="person" data-id="" aria-label="${t`About you`}">${me}</button><h2>${t`Chats`}</h2>
    <button type="button" class="m-round" data-action="nt-panel" aria-label="${t`Notifications`}">${phIcon('bell')}${unread ? `<span class="tb-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</button>
    <button type="button" class="m-round" data-action="m-more" aria-label="${t`More`}">${phIcon('more')}</button></div>
    <label class="m-search">${phIcon('search')}<input id="m-search" type="search" placeholder="${t`Search`}" autocomplete="off" value="${esc(ui.chatFilter || '')}"></label></div>`;
}
function phoneChats() {
  const snap = ui.snap, rows = [], last = new Map();
  for (const message of snap.messages || []) if (message.from?.type !== 'system') last.set(message.roomId, message);
  for (const room of snap.rooms || []) {
    const said = last.get(room.id), who = said ? (said.from.type === 'human' ? t('You') : said.from.name || (said.from.id === 'main' ? t('Rex Agent') : (snap.specialists || []).find(agent => agent.id === said.from.id)?.name) || t('Agent')) : '';
    const working = room.members.some(member => member.state === 'replying' || member.state === 'busy');
    rows.push({ at: said?.at || room.createdAt || '', html: phoneRow('room', room.id, avatarHtml(ctx, { name: room.name, image: room.image, id: room.id, members: (room.members || []).map(member => member.id || member), at: room.imageAt || '', size: 'sm' }), working ? 'working' : '', room.name,
      working ? t('Someone is typing…') : said ? `${who}: ${String(said.text || '').replace(/\s+/g, ' ').slice(0, 90)}` : `${room.members.length} ${room.members.length === 1 ? 'agent' : 'agents'}`, said?.at || '', unreadFor(ui, `room:${room.id}`)) });
  }
  for (const agent of snap.specialists || []) {
    const run = runById(agent.runId), state = agent.status?.state;
    rows.push({ at: run?.updatedAt || agent.updatedAt || agent.createdAt || '', html: phoneRow('specialist', agent.id, avatarHtml(ctx, { name: agent.name, agent, size: 'sm' }), agentDot(state), agent.name,
      [agent.status?.label || t('Idle'), agent.projectSlug].filter(Boolean).join(' · '), run?.updatedAt || '', agent.runId ? unreadFor(ui, `run:${agent.runId}`) : 0) });
  }
  rows.sort((left, right) => String(right.at).localeCompare(String(left.at)));
  const main = mainRun();
  const pinned = phoneRow('main', '', rexCore('sm', (ui.snap?.specialists || []).filter(agent => agent.kind !== 'main').length), main ? stateTone(main) : '', t('Rex Agent'), main ? stateLabel(main) : t('Your helper for everything'), main?.updatedAt || '', unreadFor(ui, 'main:'));
  return `<div class="m-chats">${pinned}${rows.map(row => row.html).join('')}<p class="m-none" hidden>${t`No chat matches.`}</p></div>`;
}
function phoneRow(type, id, avatar, dot, name, sub, at, badge) {
  return `<button type="button" class="m-row${badge ? ' unread' : ''}" data-open="${type}" data-id="${esc(id || '')}" data-name="${esc(String(name).toLowerCase())}">${withDot(avatar, dot)}<span class="m-text"><span class="m-top"><b>${esc(name)}</b>${at ? `<time>${esc(ago(at))}</time>` : ''}</span><span class="m-sub"><span>${esc(sub)}</span>${badge ? `<span class="m-badge">${badge}</span>` : ''}</span></span></button>`;
}
function filterChats() {
  const words = String(ui.chatFilter || '').trim().toLowerCase(), list = document.querySelector('.m-chats'); if (!list) return;
  let shown = 0;
  for (const row of list.querySelectorAll('.m-row')) { const match = !words || row.dataset.name.includes(words); row.hidden = !match; if (match) shown += 1; }
  const none = list.querySelector('.m-none'); if (none) none.hidden = shown > 0;
}
document.addEventListener('input', event => { if (event.target.id !== 'm-search') return; ui.chatFilter = event.target.value; filterChats(); });
// More: what the round buttons used to hold, in a sheet from the bottom.
document.addEventListener('click', event => {
  if (!event.target.closest?.('[data-action="m-more"]')) return;
  event.stopPropagation();
  document.querySelector('.dialog-back.m-more-sheet')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back m-more-sheet';
  const item = (attrs, icon, label) => `<button type="button" class="m-sheet-item" ${attrs}>${icon}<span>${label}</span></button>`;
  back.innerHTML = `<div class="dialog m-sheet" role="dialog" aria-label="${t`More`}">
    ${item('data-action="new-room"', iconAv('main'), t('New meeting room'))}
    ${item('data-action="spec-new"', iconAv('person'), t('New agent'))}
    ${item('data-action="accounts"', iconAv('usage'), t('AI usage'))}
    ${item('data-open="devices" data-id=""', iconAv('devices'), t('Devices'))}
    ${item('data-open="monitor" data-id=""', iconAv('monitor'), t('Memory'))}
    ${item('data-open="exp" data-id=""', `<span class="av sm icon">${EXP_ICON}</span>`, t('Experimental'))}
    ${item('data-action="sync"', iconAv('tasks'), t('Sync tasks now'))}
    <button type="button" class="btn m-sheet-close">${t`Close`}</button></div>`;
  document.body.append(back);
  back.addEventListener('click', inner => { if (inner.target === back || inner.target.closest('.m-sheet-close') || inner.target.closest('.m-sheet-item')) setTimeout(() => back.remove()); });
}, true);

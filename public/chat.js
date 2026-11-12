import { agentStage, agentAction, agentGroups, initAgentCard, openAgentChat, savedChatGone, toggleGroup, wireLoop } from '/chat-agents.js';
import { stepsHtml, terminalItems, terminalHtml } from '/chat-activity.js';
import { markdown } from '/chat-markdown.js';
import { initPickers, setPickActions, pickerOpen, pickerHtml } from '/chat-pick.js';
import { roomStage, newRoomDialog as openRoomDialog, tasksStage, taskStage, roomAction, initRoomInfo, avatarHtml, roomRunIds, initLocalTasks, sharedTabButtons } from '/chat-rooms.js';
import { collectShared, sharedTabsHtml } from '/chat-media.js';
import { devicesStage, devicesAction, initDevices } from '/chat-devices.js';
import { monitorStage, monitorAction } from '/chat-monitor.js';
import { worktreesStage, fillWorktreeEmbeds, wireWorktrees, wireChatSwitch, WORKTREE_ICON, chatWorktrees, worktreeSideHtml } from '/chat-worktrees.js';
import { noticesAction, noticeKey, unreadFor, watchNotices } from '/chat-notices.js';
import { openSettings } from '/chat-settings.js';
import { wireFiles, watchShownFile, watchFileWindow } from '/chat-files.js';
import { wireAgentCards } from '/chat-card.js';
import { wireImageViewer } from '/chat-viewer.js';
import { wireSpeak, speakButton } from '/chat-speak.js';
import { composerHtml, initComposer, pickedOptions, attachmentText, redrawAttachments } from '/chat-composer.js';
// Rex Desk, chat first. One conversation at a time: the main agent, an agent run, a room of agents, or what needs you.
const app = document.getElementById('app');
// Which screen is open lives in the address (#/room/ID) and is also saved, so a refresh or a restart comes back to the same place.
const SCREENS = ['main', 'inbox', 'room', 'run', 'specialist', 'task', 'tasks', 'project', 'person', 'devices', 'jev', 'monitor', 'worktrees'];
const hashOf = view => `#/${view.type}${view.id ? `/${encodeURIComponent(view.id)}` : ''}`;
function viewFromHash() { const match = /^#\/([a-z]+)(?:\/(.+))?$/.exec(location.hash); return match && SCREENS.includes(match[1]) ? { type: match[1], id: match[2] ? decodeURIComponent(match[2]) : '' } : null; }
function savedView() { try { const view = JSON.parse(localStorage.getItem('rex-desk-view') || 'null'); return view && SCREENS.includes(view.type) ? { type: view.type, id: String(view.id || '') } : null; } catch { return null; } }
const ui = { snap: null, view: viewFromHash() || savedView() || { type: 'main' }, events: new Map(), memory: null, page: '', menu: null, done: false, drafts: new Map(), stick: true, attachments: [], openSteps: new Map(), termOpen: true, qstep: new Map(), qanswers: new Map(), files: new Map() };
// Tokens one reply used: what was new, what the agent wrote, and the context it read again from the cache (cheap, but it counts toward limits).
const kilo = number => number >= 1000000 ? `${(number / 1000000).toFixed(1)}M` : number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : String(number);
// The agent's last reply of this turn: the newest agent message since the person last wrote.
const lastReply = items => { for (let index = items.length - 1; index >= 0; index -= 1) { if (items[index].role === 'human') return null; if (items[index].role === 'agent') return items[index]; } return null; };
export const tokenText = tokens => tokens ? [`${kilo((tokens.input || 0) + (tokens.cacheWrite || 0))} in`, `${kilo(tokens.output || 0)} out`, tokens.cacheRead ? `${kilo(tokens.cacheRead)} from cache` : ''].filter(Boolean).join(' · ') + ' tokens' : '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const hhmm = value => { const date = new Date(value); return Number.isNaN(+date) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const ago = value => { const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 60000)); return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`; };
const provider = name => name === 'codex' ? 'Codex' : name === 'gemini' ? 'Gemini' : name === 'claude' ? 'Claude Code' : 'Agent';
const aiKey = value => ['codex', 'gemini'].includes(value) ? value : 'claude';
const ctx = { get ui() { return ui; }, api, esc, toast, refresh, open, railItem, markdown, mainRun: () => mainRun(), runById: id => runById(id), draftKey: () => draftKey(), send: () => send(),
  bubble: args => bubble(args), note: text => note(text), typing: (name, caption) => typing(name, caption), hhmm: value => hhmm(value), tokenText,
  render: () => renderAll(), currentRunId: () => (ui.view.type === 'main' ? mainRun()?.id : ui.view.type === 'run' ? ui.view.id : '') || '', openSettings: section => openSettings(ctx, section), avatar: args => avatarHtml(ctx, args), pending: runId => pending(runId), decisionCard: item => decisionCard(item),
  commands: { assign: () => { const box = document.getElementById('draft'); if (box) { box.value = '/assign '; ui.drafts.set(draftKey(), box.value); box.focus(); } }, sync: () => syncIssues().catch(error => toast(error.message, true)), projects: () => scanProjects().catch(error => toast(error.message, true)), room: () => newRoomDialog(), agent: () => agentAction(ctx, 'spec-new'), main: () => open('main'), stop: () => stopAgent().catch(error => toast(error.message, true)), clear: () => clearAgent().catch(error => toast(error.message, true)), loop: () => loopNow().catch(error => toast(error.message, true)), settings: () => openSettings(ctx) }, get initials() { return initials; } };
const initials = text => (String(text).match(/[\p{L}\p{N}]/gu) || ['?']).slice(0, 2).join('').toUpperCase();

async function api(path, { method = 'GET', data, retry = false } = {}) {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json().catch(() => ({}));
  // With accounts, a workspace that stays signed in hands this window its cookie through /api/auth; otherwise the window signs in first.
  if (response.status === 401 && body.signIn) {
    const auth = retry ? null : await fetch('/api/auth', { headers: { 'x-rex-desk': '1' } }).then(reply => reply.json()).catch(() => null);
    if (auth?.current) return api(path, { method, data, retry: true });
    location.href = '/signin'; throw new Error('Sign in to Rex Desk.');
  }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
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
const stateTone = run => ({ working: 'working', review: 'warn' })[stateGroup(run)] || (['failed', 'interrupted'].includes(run.state) ? 'bad' : 'good');
const stateLabel = run => ({ starting: 'Preparing', queued: 'Queued', running: 'Working', waiting: 'Needs you', verifying: 'Verifying', ready_for_review: 'Ready for review', needs_evidence: 'Needs evidence', published: 'PR created', failed: 'Failed', interrupted: 'Interrupted', stopped: 'Stopped', finished: 'Finished' }[run.state] || String(run.state || '').replaceAll('_', ' '));
const pending = runId => (ui.snap?.interactions || []).filter(item => item.state === 'pending' && (!runId || item.runId === runId));
const runById = id => ui.snap.runs.find(run => run.id === id);
// The main agent's personal chat. Its room session (role coordinator, roomAgent main) is a separate conversation and never opens here.
// Only this computer's main agent: the other computers' main agents sync in through Turso but are theirs.
const mainRun = () => ui.snap.runs.find(run => run.role === 'coordinator' && run.main && !run.roomAgent && run.computer === ui.snap.computer);
// A run on a task is named by the task's English name, whatever language the tracker used.
const runTitle = run => { const task = run?.taskId ? ui.snap?.tasks?.find(item => item.id === run.taskId) : null; return task?.titleEn || run?.title || run?.branch || `Run ${String(run?.id || '').slice(0, 8)}`; };
const roomById = id => ui.snap.rooms.find(room => room.id === id);

// ---------- rail ----------
const TILE_NAMES = { notices: 'Alerts', inbox: 'Needs', tasks: 'Tasks', jev: 'Jev', person: 'You', monitor: 'RAM', devices: 'PCs', worktrees: 'Trees' };
// A small square button for a place (Notifications, Tasks, Monitor…), with its name and state in the tooltip and a badge when something waits.
function tile(type, avatar, name, sub, badge = 0, warn = false) {
  // The bell opens a dropdown list instead of a screen.
  const active = type === 'notices' ? Boolean(document.querySelector('.nt-pane')) : ui.view.type === type, how = type === 'notices' ? 'data-action="nt-panel"' : `data-open="${type}" data-id=""`;
  return `<button class="tile ${active ? 'active' : ''}" ${how} title="${esc(`${name} · ${sub}`)}" aria-label="${esc(`${name}, ${sub}`)}">${avatar}${badge ? `<span class="tbadge ${warn ? 'warn' : ''}">${badge > 99 ? '99+' : badge}</span>` : ''}<span class="tname">${esc(TILE_NAMES[type] || name)}</span></button>`;
}
function railItem(type, id, { dot = '', avatar = '', name, sub = '', badge = 0, warn = false }) {
  const active = (ui.view.type === type && (ui.view.id || '') === (id || '')) || (type === 'specialist' && ui.view.type === 'run' && (ui.snap?.specialists || []).some(agent => agent.id === id && agent.runId === ui.view.id));
  return `<button class="item ${active ? 'active' : ''}" data-open="${type}" data-id="${esc(id || '')}">${avatar || (dot ? `<span class="dot ${dot}"></span>` : '')}<span class="name">${esc(name)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>${badge ? `<span class="badge ${warn ? 'warn' : ''}">${badge}</span>` : ''}</button>`;
}
// Sidebar pieces: an icon or a picture for every row, a status dot on agents, and sections that fold and remember it.
const SVG = {
  main: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8l5.6-.8z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  person: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 13l3-3 3 2 4-5M8 21h8"/></svg>',
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

function renderRail() {
  // No Runs list: agents work in their own chats and rooms, the way the person tells them. An old run still opens from its task.
  const snap = ui.snap, asks = pending().length;
  const main = mainRun(), agents = snap.specialists || [], tasks = (snap.tasks || []).filter(task => task.active && !task.demo), busy = agents.filter(agent => agent.status?.state === 'busy').length;
  const plus = (action, label) => `<button class="sec-add" data-action="${action}" title="${label}" aria-label="${label}">+</button>`;
  return `<div class="rail-head"><span class="brand">${iconAv('main', 'brandmark')}<strong>Rex Desk</strong></span><span class="spacer"></span><button class="btn small" data-action="sync" title="Sync issues from the tracker">Sync</button></div><div class="rail-scroll">
    <div class="sec-body top">
      ${railItem('main', '', { avatar: withDot(iconAv('main', 'accent'), main ? stateTone(main) : ''), name: 'Rex Agent', sub: main ? stateLabel(main) : 'Not started', badge: unreadFor(ui, 'main:') })}
      <div class="tiles" role="toolbar" aria-label="Places">${[
        tile('notices', iconAv('bell', snap.notices?.unread ? 'warn' : ''), 'Notifications', snap.notices?.unread ? `${snap.notices.unread} unread` : 'All caught up', snap.notices?.unread || 0, true),
        tile('inbox', iconAv('inbox', asks ? 'warn' : ''), 'Needs you', asks ? `${asks} waiting` : 'Nothing waiting', asks, true),
        tile('tasks', iconAv('tasks'), 'Tasks', busy ? `${busy} being worked on` : `${tasks.length} tasks`, 0),
        tile('jev', iconAv('mic', 'accent'), 'Jev', 'Control this computer and websites', 0),
        tile('person', ui.profile?.photo ? `<img class="av sm photo" src="${photoUrl()}" alt="">` : iconAv('person'), 'About you', ui.profile?.name || 'What the agents learned', 0),
        tile('monitor', iconAv('monitor'), 'Monitor', ui.monitor ? `${ui.monitor.freeMb >= 1024 ? `${(ui.monitor.freeMb / 1024).toFixed(1)} GB` : `${ui.monitor.freeMb} MB`} free` : 'Memory and what uses it', 0),
        tile('devices', iconAv('devices'), 'Devices', (snap.devices?.peers || []).length ? `${(snap.devices.peers.filter(peer => peer.online).length + 1)} of ${snap.devices.peers.length + 1} on` : 'Only this computer', 0),
      ].join('')}</div>
    </div>
    ${section('rooms', 'Rooms', snap.rooms.length, plus('new-room', 'New room'), snap.rooms.length ? snap.rooms.map(room => railItem('room', room.id, { avatar: withDot(avatarHtml(ctx, { name: room.name, image: room.image, id: room.id, at: room.imageAt || '', size: 'sm' }), room.members.some(member => member.state === 'replying' || member.state === 'busy') ? 'working' : ''), name: room.name, sub: `${room.members.length} agents`, badge: unreadFor(ui, `room:${room.id}`) })).join('') : '<p class="rail-empty">No rooms yet.</p>')}
    ${section('agents', 'Agents', agents.length, plus('spec-new', 'New agent'), agents.length ? agentGroups(ctx, agents, (agent, grouped) => railItem('specialist', agent.id, { avatar: withDot(avatarHtml(ctx, { name: agent.name, size: 'sm' }), agentDot(agent.status?.state)), name: agent.name, sub: grouped ? agent.status?.label || 'Idle' : `${agent.status?.state === 'idle' || !agent.status ? agent.projectSlug : agent.status.label}`, badge: agent.runId ? unreadFor(ui, `run:${agent.runId}`) : 0 })) : '<p class="rail-empty">No agents yet. Press + to create one.</p>')}
  </div>${phoneTabs(asks)}<div class="rail-foot"><button class="acct-btn" data-action="accounts" title="Which Claude account the agents use">${accountChip()}</button><button class="btn small rail-settings" data-action="settings-open" title="Settings"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>Settings</button><button class="btn small" data-action="theme">Theme</button></div>`;
}

// ---------- run conversation ----------
// The conversation, with the agent's steps folded into groups between its messages.
function renderItems(items, run, live) {
  const out = []; let group = [];
  const link = agent => `<a href="#" class="steplink" data-open="specialist" data-id="${esc(agent.id)}">Open card</a>`;
  const flush = last => { if (group.length) out.push(stepsHtml(group, { esc, hhmm, live: live && last, openKeys: ui.openSteps, specialists: ui.snap.specialists || [], link })); group = []; };
  for (const item of items) {
    if (item.role === 'tool') { group.push(item); continue; }
    flush(false);
    out.push(item.role === 'qa-ask' ? askHtml(item, run) : item.role === 'qa-answer' ? answerHtml(item)
      : item.role === 'human' ? bubble({ mine: true, name: 'You', time: hhmm(item.at), voice: item.voice, html: markdown(item.text), unsend: item.sequence ? `${run.id}:${item.sequence}` : '' })
      : item.role === 'agent' ? bubble({ name: provider(run.provider), time: hhmm(item.at), html: markdown(item.text) + (item.tokens ? `<div class="tok" title="Tokens this reply used">${esc(tokenText(item.tokens))}</div>` : '') })
      : item.role === 'cleared' ? `<div class="cleared"><span>Chat cleared · ${esc(item.text)}</span>${item.earlier ? '<button type="button" class="btn small quiet" data-action="show-earlier">Show earlier messages</button>' : ''}</div>`
      : item.role === 'subagent' ? subagentHtml(item, live)
      : item.role === 'error' ? `<div class="card bad"><h4>Needs attention</h4><div class="md">${markdown(item.text)}</div></div>`
      : note(`${esc(item.text)} · ${hhmm(item.at)}`));
  }
  flush(true);
  return out.join('');
}
// A sub-agent the agent started: who it is, what it was asked, how far it got. Open it to see each step and its report.
function subagentHtml(item, live) {
  const input = item.input, state = item.done ? (item.failed ? 'failed' : 'done') : live ? 'working' : 'stopped';
  const label = { working: 'Working…', done: 'Done', failed: 'Failed', stopped: 'Stopped' }[state];
  const took = item.endedAt ? Math.max(1, Math.round((Date.parse(item.endedAt) - Date.parse(item.at)) / 1000)) : 0;
  const step = event => `<li><b>${esc(event.tool)}</b> ${esc(Object.values(event.input || {}).filter(value => typeof value === 'string').join(' · ').slice(0, 140))}</li>`;
  return `<details class="subagent ${state}"${ui.openSubs?.has(item.id) ? ' open' : ''} data-sub="${esc(item.id)}"><summary><span class="sa-dot ${state}"></span><span class="sa-main"><b>Sub-agent${input.description ? `: ${esc(input.description)}` : ''}</b><small>${esc([input.type, input.model, `${item.steps.length} step${item.steps.length === 1 ? '' : 's'}`, took ? `${took < 60 ? `${took}s` : `${Math.round(took / 60)} min`}` : ''].filter(Boolean).join(' · '))}</small></span><span class="sa-state">${label}</span></summary>
    <div class="sa-body">${input.prompt ? `<p class="sa-h">Asked</p><div class="md sa-text">${markdown(input.prompt)}</div>` : ''}${item.steps.length ? `<p class="sa-h">Steps</p><ol class="sa-steps">${item.steps.slice(-40).map(step).join('')}</ol>` : ''}${item.result || item.text ? `<p class="sa-h">Reported back</p><div class="md sa-text">${markdown(item.result || item.text)}</div>` : ''}</div></details>`;
}
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
  const body = item.action !== 'accept' ? `<em>${item.approval ? 'Declined' : item.action === 'expired' ? '(question dropped)' : 'Skipped'}</em>`
    : item.approval ? '<em>Approved</em>' : item.rows.length > 1 ? item.rows.map(row => `<div class="qa-ans"><span class="qa-l">${esc(row.label)}</span><br>${esc(String(row.value))}</div>`).join('') : item.rows.length ? esc(String(item.rows[0].value)) : '<em>Sent</em>';
  return bubble({ mine: true, name: 'You', time: hhmm(item.at), html: body });
}
function transcript(all, runId = '') {
  // After /clear the chat starts empty again; what came before stays one click away.
  const cut = all.map(event => event.kind).lastIndexOf('chat-cleared');
  const events = cut >= 0 && !ui.showEarlier?.[runId] ? all.slice(cut) : all;
  const items = [], results = new Map(events.filter(event => event.kind === 'agent-tool-result').map(event => [event.id, event])), subs = new Map();
  for (const event of events) {
    if (event.kind === 'chat-cleared') { items.push({ role: 'cleared', text: event.text, at: event.createdAt, earlier: cut > 0 && !ui.showEarlier?.[runId] }); continue; }
    // A sub-agent shows as one card: what it was asked, its steps, and what it reported back.
    if (event.kind === 'agent-tool' && event.tool === 'Agent') { const sub = { role: 'subagent', id: event.id, input: event.input || {}, steps: [], text: '', done: false, failed: false, at: event.createdAt }; subs.set(event.id, sub); if (!subs.has(event.parent)) items.push(sub); else subs.get(event.parent).steps.push({ tool: 'Agent', input: { description: sub.input.description } }); continue; }
    if (event.parent && subs.has(event.parent)) { const sub = subs.get(event.parent); if (event.kind === 'agent-tool') sub.steps.push(event); else if (event.kind === 'subagent-text') sub.text = event.text; continue; }
    if (event.kind === 'subagent-text') continue;
    if (event.kind === 'subagent-done') { const sub = subs.get(event.id); if (sub) Object.assign(sub, { done: true, failed: event.failed, result: event.text, endedAt: event.createdAt }); continue; }
    if (['command-output', 'dev-output'].includes(event.kind)) continue;
    if (event.kind === 'human-message') { const said = spokenText(event.text); items.push({ role: 'human', text: said.text, voice: said.voice, at: event.createdAt, sequence: event.sequence }); }
    else if (event.kind === 'turn-start') items.push({ role: 'status', text: `${event.resumed ? 'Resumed' : 'Started'} with ${provider(event.provider)}`, at: event.createdAt });
    else if (event.kind === 'loop-check') items.push({ role: 'status', text: event.text || 'Loop check', at: event.createdAt });
    // The tokens of a reply show under the reply itself, like in a group chat.
    else if (event.kind === 'agent-result' && typeof event.usage === 'object' && tokenText(event.usage) && lastReply(items)) lastReply(items).tokens = event.usage;
    else if (event.kind === 'agent-result') items.push({ role: 'status', text: `Turn ended${event.subtype && event.subtype !== 'success' ? ` · ${event.subtype}` : ''}${typeof event.usage === 'object' && tokenText(event.usage) ? ` · ${tokenText(event.usage)}` : ''}${event.cost && event.paidByApi === true ? ` · $${Number(event.cost).toFixed(2)}` : ''}`, at: event.createdAt });
    else if (event.kind === 'message' || event.kind === 'agent-text') items.push({ role: 'agent', text: event.text || event.message || '', at: event.createdAt });
    else if (event.kind === 'agent-tool' && ['desk_ask', 'desk_message', 'desk_elicit'].includes(event.tool)) continue; // shown as chat messages already
    else if (event.kind === 'agent-tool-result') continue;
    else if (event.kind === 'agent-tool') items.push({ role: 'tool', id: event.id, output: results.get(event.id), tool: event.tool, input: event.input, change: event.change, failed: event.failed, text: event.text, at: event.createdAt });
    else if (event.kind === 'error') items.push({ role: 'error', text: event.text || event.message || 'The run needs attention.', at: event.createdAt });
    else if (event.visible) items.push({ role: 'status', text: event.text || event.message || event.kind.replaceAll('-', ' '), at: event.createdAt });
  }
  return items;
}
const UNSEND_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const bubble = ({ mine, name, time, html, voice = false, unsend = '' }) => `<div class="msg ${mine ? 'mine' : ''}">${unsend ? `<button type="button" class="unsend" data-unsend="${unsend}" title="Unsend" aria-label="Unsend this message">${UNSEND_ICON}</button>` : ''}<div class="avatar">${esc(initials(name))}</div><div class="bubble"><div class="who"><strong>${esc(name)}</strong><span>${esc(time)}${voice ? ` ${micIcon()}` : ''}</span></div><div class="md">${html}</div>${mine ? '' : `<div class="msg-acts">${speakButton()}</div>`}</div></div>`;
const typing = (name, caption = '') => `<div class="msg" aria-live="polite" aria-label="${esc(name)} is typing"><div class="avatar">${esc(initials(name))}</div><div class="bubble typing"><span class="dots"><i></i><i></i><i></i></span>${caption ? `<span class="cap">${esc(caption)}</span>` : ''}</div></div>`;
const note = text => `<div class="note">${text}</div>`;
// Runs that are over. Any other run that is not working can still be closed, so a stuck run never blocks its task.
const FINISHED = ['ready_for_review', 'published', 'failed', 'stopped', 'interrupted', 'finished', 'qa_passed', 'qa_failed', 'qa_blocked'];
function decisionCard(item) {
  if (item.kind === 'file') return fileCard(item);
  if (item.kind === 'terminal') return signInCard(item);
  const request = item.request || {}, run = runById(item.runId), properties = request.requestedSchema?.properties || {}, required = request.requestedSchema?.required || [];
  const saved = ui.qanswers.get(item.id) || {};
  const field = (key, property, needed) => {
    const attrs = `name="${esc(key)}" data-type="${esc(property.type || 'string')}" ${needed ? 'required' : ''}`;
    const control = property.type === 'boolean' ? `<div class="seg"><button type="button" data-seg="true">Yes</button><button type="button" data-seg="false">No</button><input type="hidden" ${attrs.replace('required', '')}></div>`
      : `<input class="qinput" ${attrs} type="${['number', 'integer'].includes(property.type) ? 'number' : 'text'}" placeholder="Type your answer…" autocomplete="off" value="${esc(saved[key] || '')}">`;
    const options = (property.options || (property.enum || []).map(label => ({ label }))).slice(0, 8);
    const suggestions = options.length ? `<div class="sugg" data-multi="${property.multiSelect ? 1 : 0}">${options.map((option, index) => `<button type="button" class="sugg-chip${String(saved[key] || '').split(', ').includes(option.label) ? ' on' : ''}" data-fill="${esc(option.label)}"><span class="num">${index + 1}</span><span class="txt"><b>${esc(option.label)}</b>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span></button>`).join('')}<div class="sugg-other">Or type your own answer below</div></div>` : '';
    return `<label class="qfield"><span>${esc(property.title || key)}</span>${suggestions}${control}</label>`;
  };
  const list = [...Object.entries(properties).map(([key, property]) => field(key, property, required.includes(key))),
    ...(request.questions || []).map(question => field(question.id || question.question, { type: 'string', title: question.question, options: question.options, multiSelect: question.multiSelect }, true))];
  const many = list.length, ask = item.kind !== 'approval', detail = ask ? null : request.command || request.input || request;
  // Several questions come one at a time: answering one slides to the next.
  const slides = ask && many > 1, step = slides ? Math.min(ui.qstep.get(item.id) || 0, many - 1) : 0;
  const fields = slides ? `<div class="qslider">${list.map((html, index) => `<div class="qslide${index === step ? ' on' : ''}" data-slide="${index}">${html}</div>`).join('')}</div>` : list.join('');
  const progress = slides ? `<span class="qcount" data-qcount>Question ${step + 1} of ${many}</span><span class="qdots" aria-hidden="true">${list.map((_, index) => `<i class="${index === step ? 'on' : index < step ? 'done' : ''}"></i>`).join('')}</span>` : '';
  return `<form class="card ask qcard${slides ? ' sliding' : ''}" data-interaction="${esc(item.id)}" data-count="${many}" data-step="${step}" ${slides ? 'novalidate' : ''}><div class="qhead"><span class="qdot"></span>${ask ? (slides ? progress : 'Question') : 'Needs your OK'} · ${esc(runTitle(run))}</div><div class="qtext md">${markdown(String(item.title).replace(/mcp__[a-z0-9_]+?__/gi, ''))}</div>${detail ? `<pre>${esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 1500))}</pre>` : ''}${fields}
    <div class="row">${slides ? `<button type="button" class="btn small qback" data-qmove="-1" ${step ? '' : 'hidden'}>Back</button><button type="button" class="send-btn wide qnext" data-qmove="1" ${step < many - 1 ? '' : 'hidden'}>Next</button>` : ''}<button class="send-btn wide qsend" name="decision" value="accept" ${slides && step < many - 1 ? 'hidden' : ''}>${ask ? (many > 1 ? 'Send answers' : 'Send') : 'Approve once'}</button>${request.allowAlways ? '<button class="btn small" name="decision" value="always" formnovalidate>Always allow for this run</button>' : ''}<button class="btn small" name="decision" value="decline" formnovalidate>${ask ? 'Skip' : 'Decline'}</button>${slides ? '<small class="qhint">Pick an answer or type one · Enter for next</small>' : ''}</div></form>`;
}
function wakeCard(wake) {
  const run = runById(wake.runId), room = roomById(wake.roomId);
  return `<div class="card ask"><h4>${esc(wake.from)} mentioned ${esc(runTitle(run))} in ${esc(room?.name || 'a room')}</h4><div class="md">${esc(wake.text)}</div><div class="row"><button class="btn primary small" data-action="wake-approve" data-id="${esc(wake.id)}">Wake it up</button><button class="btn small" data-action="wake-dismiss" data-id="${esc(wake.id)}">Dismiss</button></div></div>`;
}

// ---------- stage ----------
function stageModel() {
  const { type, id } = ui.view, snap = ui.snap;
  if (type === 'room') return roomStage(ctx);
  if (type === 'tasks') return tasksStage(ctx);
  if (type === 'task') return taskStage(ctx);
  if (type === 'inbox') {
    const asks = pending(), wakes = snap.wakes || [];
    return { title: 'Needs you', meta: `${asks.length + wakes.length} waiting`, feed: asks.length + wakes.length ? asks.map(decisionCard).join('') + wakes.map(wakeCard).join('') : '<div class="empty"><h2>All clear</h2><p>Questions, approvals and wake-ups from your agents show up here.</p></div>' };
  }
  if (type === 'specialist') return agentStage(ctx);
  if (type === 'devices') return devicesStage(ctx);
  if (type === 'monitor') return monitorStage(ctx);
  if (type === 'worktrees') return worktreesStage(ctx);
  if (type === 'jev') return jevStage();
  if (type === 'person') return { title: 'About you', meta: 'Your profile, from what the agents learned', feed: personPage(), top: true };
  if (type === 'project') {
    return { title: id, meta: 'Project memory', feed: `<div class="page"><div class="row"><button class="btn primary small" data-action="spec-new">Create agent for this project</button></div><div class="card"><div class="md">${markdown(ui.page || 'Loading…')}</div></div></div>` };
  }
  const run = type === 'main' ? mainRun() : runById(id);
  if (!run && type === 'main') return welcomeStage();
  if (!run) {
    // A view saved on this computer can still point at an agent's deleted chat: start a new one, or show its card when its computer is off.
    const agent = type === 'run' ? (ui.snap.specialists || []).find(item => item.runId === id) : null;
    if (agent) { setTimeout(() => agent.remote && agent.status?.state === 'offline' ? open('specialist', agent.id) : void openAgentChat(ctx, agent)); return emptyStage(`Starting a new chat with ${esc(agent.name)}…`); }
    return emptyStage('That run is gone.');
  }
  const shown = ui.events.get(run.id) || [], cleared = ui.showEarlier?.[run.id] ? '' : [...shown].reverse().find(event => event.kind === 'chat-cleared')?.createdAt || '';
  const items = [...transcript(shown, run.id), ...(ui.snap.interactions || []).filter(item => item.runId === run.id && (!cleared || String(item.createdAt || item.at || '') >= cleared) && item.state !== 'pending').flatMap(answeredItem)].sort((left, right) => String(left.at).localeCompare(String(right.at))), live = ['starting', 'running'].includes(run.state);
  const feed = (items.length ? renderItems(items, run, live) : `<div class="empty"><h2>${esc(runTitle(run))}</h2><p>${ui.events.has(run.id) ? 'Nothing recorded yet.' : 'Loading the conversation…'}</p></div>`)
    + pending(run.id).map(item => `<div class="msg qfloat"><div class="avatar">${esc(initials(provider(run.provider)))}</div>${decisionCard(item)}</div>`).join('') + (live ? typing(provider(run.provider), run.state === 'starting' ? 'Preparing…' : '') : '');
  const shells = terminalItems(items), stop = (shells.length && !ui.termOpen ? `<button class="btn small" data-action="term-open">Terminal (${shells.length})</button> ` : '') + (live || run.state === 'waiting' ? '<button class="btn small danger" data-action="stop">Stop</button>' : !FINISHED.includes(run.state) ? '<button class="btn small danger" data-action="stop" title="This run is not working. Close it so the task can get a new run.">Close run</button>' : '');
  // A personal chat with an agent shows its profile and what was shared on the right; the terminal is one of those tabs.
  const personal = personalAgent(run);
  const side = personal ? (ui.chatInfo === false ? '' : personalSide(run, personal, items, shells)) : shells.length && ui.termOpen ? terminalHtml(shells, { esc, hhmm }) : '';
  const actions = personal ? `<button class="btn small" data-action="chat-to-room" title="Make a group chat from this chat: add agents and carry on with the same topic">+ Group chat</button> ${ui.chatInfo === false ? '<button class="btn small" data-action="chat-info">Info</button> ' : ''}${live || run.state === 'waiting' ? '<button class="btn small danger" data-action="stop">Stop</button>' : ''}` : stop;
  return { title: personal ? personal.name : runTitle(run), meta: personal ? `${provider(run.provider)} · ${personal.projectSlug}` : `${provider(run.provider)}${run.branch ? ` · ${run.branch}` : ''}`, chips: `<span class="chip ${stateTone(run)}">${esc(stateLabel(run))}</span>`, actions, feed, side, sideClass: personal ? 'info' : '',
    working: workingStates.includes(run.state), composer: { placeholder: workingStates.includes(run.state) ? `Message ${provider(run.provider)}…` : (run.provider === 'codex' ? 'Message Claude Code. It takes over from Codex with the chat so far…' : `Message ${provider(run.provider)}. It picks up where it left off…`), mentions: [] } };
}
// Until the second brain is set up, the main agent's screen and About you offer to do it.
const brainBanner = () => ui.snap?.memory?.secondBrain === false ? `<div class="card brainbar"><div><b>Your agents don't know your second brain yet.</b><span class="muted small">${ui.snap.memory.brainCandidates?.length ? ` Found ${esc(ui.snap.memory.brainCandidates[0])}.` : ''} Rex Agent can set it up for all of them.</span></div><button class="btn primary small" data-action="brain-setup">Set it up</button></div>` : '';
const quick = (label, text) => `<button class="chip-btn" data-action="quick" data-text="${esc(text)}">${esc(label)}</button>`;
const welcomeStage = () => ({ title: 'Rex', meta: 'Rex Agent',
  feed: `${brainBanner()}<div class="welcome"><div class="avatar big">RX</div><h2>Hi, I am Rex</h2><p>I get to know your projects, set up an agent for each one, and help you work through your issues. Pick a start, or just type.</p><div class="chips">${quick('Meet my projects', 'Meet my projects: go through them one by one, ask me what you are unsure about, and set up an agent for each.')}${quick('Triage my issues', 'Look at my assigned issues and tell me what to do first.')}${quick('What can you do?', 'What can you do for me here?')}</div></div>`,
  composer: { placeholder: 'Message Rex…', mentions: [] } });
const emptyStage = text => ({ title: 'Rex Desk', meta: '', feed: `<div class="empty"><h2>Nothing here</h2><p>${text}</p></div>` });

function renderStage(full) {
  const model = stageModel(), stage = document.getElementById('stage');
  const head = `<div class="stage-head"><button class="m-menu" data-action="m-rail" aria-label="Back to the list"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button><h1>${esc(model.title)}</h1><span class="meta">${esc(model.meta || '')}</span>${model.chips || ''}<span class="spacer"></span>${model.actions || ''}</div>`;
  // A view that needs the message box always gets it, even when an earlier view had none.
  if (full || !document.getElementById('feed') || Boolean(model.composer) !== Boolean(document.getElementById('composer'))) {
    stage.innerHTML = `<div class="stage-main"><div><div id="head">${head}</div><div id="members">${model.members || ''}</div></div><div id="banner"></div><div class="feed" id="feed"><div class="feed-inner" id="feed-inner"></div></div>${model.composer ? composerHtml(ctx, model) : '<div></div>'}</div><aside class="side" id="side"></aside>`;
    ui.stick = !model.top; redrawAttachments(ctx); if (model.top) document.getElementById('feed').scrollTop = 0;
  } else { document.getElementById('head').innerHTML = head; const slot = document.getElementById('members'); if (!slot.contains(document.activeElement) && !pickerOpen()) slot.innerHTML = model.members || ''; }
  document.getElementById('feed').className = `feed ${model.feedClass || ''}`;
  const banner = document.getElementById('banner'); if (banner && banner.innerHTML !== (model.banner || '')) banner.innerHTML = model.banner || '';
  drawSide(model.side || '', model.sideClass || '');
  const feed = document.getElementById('feed'), inner = document.getElementById('feed-inner');
  // Someone typing in an approval form keeps their text: the feed is not redrawn under them.
  // A form that is gone from the new view (it was answered) never holds the redraw back.
  const active = document.activeElement, form = active?.closest?.('[data-interaction]');
  const editing = !full && feed.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName) && (!form || model.feed.includes(`data-interaction="${form.dataset.interaction}"`));
  const choosing = pickerOpen();
  if (!editing && !choosing) { inner.innerHTML = model.feed; if (ui.stick && !model.top) feed.scrollTop = feed.scrollHeight; }
  ui.mentions = model.composer?.mentions || [];
}
// The terminal panel keeps its scroll place unless it was at the bottom, where it follows the newest command.
function drawSide(html, extra = '') {
  const side = document.getElementById('side'); if (!side) return;
  const body = document.getElementById('side-body'), keep = body ? { top: body.scrollTop, bottom: body.scrollHeight - body.scrollTop - body.clientHeight < 40 } : { top: 0, bottom: true };
  if (side.dataset.html !== html) { side.innerHTML = html; side.dataset.html = html; }
  side.className = `side${html ? ' on' : ''} ${extra}`.trim();
  const fresh = document.getElementById('side-body'); if (fresh) fresh.scrollTop = keep.bottom ? fresh.scrollHeight : keep.top;
}
const draftKey = () => `${ui.view.type}:${ui.view.id || ''}`;

function renderAll(full = false) {
  queueMicrotask(drawReplyBar);
  if (!ui.snap) return;
  // On a phone Rex Desk opens on the list, like a messaging app; a chat slides in over it and the back arrow returns.
  if (!document.getElementById('rail')) ui.railHtml = '', app.innerHTML = `<div class="chat-shell${phone() && !location.hash ? ' show-rail' : ''}"><aside class="rail" id="rail"></aside><main class="stage" id="stage"></main></div>`;
  const rail = document.getElementById('rail'), scroll = rail.querySelector('.rail-scroll')?.scrollTop || 0;
  // The sidebar is rebuilt only when something in it changed.
  const railHtml = renderRail(); if (railHtml !== ui.railHtml) { ui.railHtml = railHtml; rail.innerHTML = railHtml; const restored = rail.querySelector('.rail-scroll'); if (restored) restored.scrollTop = scroll; }
  renderStage(full);
  fillWorktreeEmbeds(ctx);
  if (ui.view.type === 'worktrees' && ui.view.id && ui.wtFocused !== ui.view.id) { const card = document.querySelector(`.wt-page [data-wt-id="${CSS.escape(ui.view.id)}"]`); if (card) { ui.wtFocused = ui.view.id; card.classList.add('focus'); card.scrollIntoView({ block: 'center' }); } }
}

// ---------- data ----------
async function loadView() {
  const { type, id } = ui.view;
  try {
    if (type === 'main' || type === 'run') {
      const run = type === 'main' ? mainRun() : runById(id); if (!run) return;
      const events = await api(`/runs/${run.id}/messages`); ui.events.set(run.id, events);
    } else if (type === 'room') {
      const room = ui.snap.rooms.find(item => item.id === id);
      if (room && ui.infoOpen !== false && ui.sideTab === 'activity') await Promise.all(roomRunIds(ui, room).map(async runId => ui.events.set(runId, await api(`/runs/${runId}/messages`).catch(() => []))));
    } else if (type === 'worktrees') { await api('/worktrees');
    } else if (type === 'monitor') { ui.monitor = await api('/monitor'); 
    } else if (type === 'person') { ui.page = (await api('/memory/page?name=user')).text; }
    else if (type === 'project') ui.page = (await api(`/memory/page?name=${encodeURIComponent(id)}`)).text;
  } catch (error) { if (type === 'project') ui.page = error.message; }
}
let busy = false, again = false, lastTyped = 0, typingHold = 0;
// While the person types, the page is not redrawn: a redraw of a long chat takes the main thread and the letters lag.
// Updates wait until they pause for a moment, then everything catches up at once.
document.addEventListener('input', event => { if (event.target.id === 'draft' || event.target.closest?.('#composer')) lastTyped = performance.now(); }, true);
async function refresh({ full = false } = {}) {
  const sinceTyping = performance.now() - lastTyped;
  if (!full && sinceTyping < 1200) { clearTimeout(typingHold); typingHold = setTimeout(() => void refresh().catch(() => {}), 1250 - sinceTyping); return; }
  if (busy) { again = true; return; } busy = true;
  try {
    ui.snap = await api('/state');
    // The server restarted on new code: load the new page too, so it never asks for a file or route the old one lacked.
    if (ui.snap.code && ui.code && ui.snap.code !== ui.code) { location.reload(); return; } ui.code ||= ui.snap.code; ui.memory = await api('/memory').catch(() => ui.memory); ui.profile = await api('/profile').catch(() => ui.profile);
    await loadView(); renderAll(full); watchNotices(ctx); watchShownFile(ctx); watchFileWindow(ctx);
  } finally { busy = false; if (again) { again = false; void refresh(); } }
}
function open(type, id = '') {
  ui.view = { type, id }; ui.page = ''; window.rexView = noticeKey(ui.view); window.rexPresence?.();
  try { localStorage.setItem('rex-desk-view', JSON.stringify(ui.view)); } catch { /* private window */ }
  if (location.hash !== hashOf(ui.view)) { ui.fromOpen = true; location.hash = hashOf(ui.view); } document.querySelector('.chat-shell')?.classList.remove('show-rail'); void refresh({ full: true }); }

// ---------- actions ----------
async function send() {
  const box = document.getElementById('draft'), typed = box?.value.trim(), hasFiles = ui.attachments.some(file => file.path);
  if (!typed && !hasFiles) return;
  if (ui.attachments.some(file => !file.path)) return toast('Wait for the upload to finish.', true);
  // Dictated words may be misheard: the agent is told, quietly, so it reads them against the conversation.
  const spoken = ui.voiceDrafts?.has(draftKey()) ? VOICE_NOTE : '';
  const text = `${typed || 'See the attached files.'}${attachmentText(ctx)}${spoken}`, picked = pickedOptions(ctx);
  const { type, id } = ui.view; box.disabled = true; ui.voiceDrafts?.delete(draftKey());
  try {
    if (type === 'jev') { box.value = ''; ui.drafts.set(draftKey(), ''); void jevDo(typed); }
    else if (type === 'room' && /^\/assign\b/i.test(typed)) await assignFromRoom(id, typed);
    else if (type === 'room') { const replyTo = ui.reply?.roomId === id ? ui.reply.id : ''; await api(`/rooms/${id}/messages`, { method: 'POST', data: { text, ...(replyTo ? { replyTo } : {}) } }); ui.reply = null; drawReplyBar(); }
    else if (type === 'main' && !mainRun()) await api('/main', { method: 'POST', data: { prompt: text, ...picked } });
    else {
      const run = type === 'main' ? mainRun() : runById(id);
      if (workingStates.includes(run.state)) await api(`/runs/${run.id}/say`, { method: 'POST', data: { text, ...picked } });
      else await api(`/runs/${run.id}/resume`, { method: 'POST', data: { prompt: text, ...picked } });
    }
    box.value = ''; box.style.height = ''; ui.drafts.delete(draftKey()); ui.attachments = []; redrawAttachments(ctx); await refresh();
  } catch (error) { toast(error.message, true); }
  finally { box.disabled = false; box.focus(); }
}
// /assign @agent #task: gives a task to an agent from the room.
async function assignFromRoom(roomId, command) {
  const room = ui.snap.rooms.find(item => item.id === roomId), handle = /@([\p{L}\p{N}_-]+)/u.exec(command)?.[1]?.toLowerCase(), number = /#(\d{2,})/.exec(command)?.[1];
  const member = room?.members.find(item => item.handle.toLowerCase() === handle || item.name.toLowerCase() === handle), task = (ui.snap.tasks || []).find(item => String(item.taskNumber) === number || String(item.externalId) === number);
  if (!member) throw new Error('Name an agent in this room: /assign @agent #task');
  if (!task) throw new Error('Name a task by its number: /assign @agent #49760');
  const given = await api(`/specialists/${member.id}/assign`, { method: 'POST', data: { taskId: task.id, roomId } }); if (given?.queued) toast(given.message);
  toast(`${member.name} is on it.`);
}
async function syncIssues() { toast('Syncing issues…'); await api('/sync', { method: 'POST', data: {} }); toast('Issues synced.'); await refresh(); }
async function scanProjects() { toast('Scanning this computer for projects…'); const result = await api('/memory/scan', { method: 'POST', data: {} }); toast(`Found ${result.count} projects.`); await refresh(); }
// /clear: the agent writes nothing itself; Rex Desk saves a handoff of the conversation and the next message starts a fresh session that reads it.
// /loop: the agent looks at its own tasks now, the same as its scheduled check.
async function loopNow() {
  const run = ui.view.type === 'run' ? runById(ui.view.id) : null, agentId = run?.specialistId;
  if (!agentId) return toast('Open an agent\'s chat to run its loop.', true);
  const box = document.getElementById('draft'); if (box) { box.value = ''; ui.drafts.set(draftKey(), ''); }
  await api(`/specialists/${agentId}/loop`, { method: 'POST', data: {} }); toast('Checking its tasks now.'); await refresh();
}
async function clearAgent() {
  const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); if (!run) return toast('No agent conversation here.', true);
  if (!confirm('Clear this conversation? The agent starts a fresh session with your next message and reads a handoff of what was said. The messages stay on screen.')) return;
  const box = document.getElementById('draft'); if (box) { box.value = ''; ui.drafts.set(draftKey(), ''); }
  await api(`/runs/${run.id}/fresh`, { method: 'POST', data: {} }); toast('Cleared. Your next message starts a fresh session.'); await refresh();
}
async function stopAgent() { const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); if (!run) return toast('No agent to stop here.', true); await api(`/runs/${run.id}/stop`, { method: 'POST', data: {} }); await refresh(); }
function newRoomDialog() { openRoomDialog(ctx); }
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-open],[data-action]'); if (!target) return;
  if (target.dataset.open) {
    event.preventDefault();
    // An agent you already chat with opens that chat, like a messenger; its profile is on the right ("Edit profile" opens the card).
    if (target.dataset.open === 'specialist' && !target.dataset.profile) {
      const agent = (ui.snap.specialists || []).find(item => item.id === target.dataset.id);
      if (agent?.runId && runById(agent.runId)) { ui.chatTab = 'profile'; return open('run', agent.runId); }
      if (savedChatGone(ctx, agent) && !(agent.remote && agent.status?.state === 'offline')) { ui.chatTab = 'profile'; return openAgentChat(ctx, agent); }
    }
    return open(target.dataset.open, target.dataset.id);
  }
  const action = target.dataset.action;
  try {
    if (action?.startsWith('spec-')) await agentAction(ctx, action, target);
    else if (action === 'send') await send();
    else if (action === 'new-room') newRoomDialog();
    else if (action === 'show-earlier') { ui.showEarlier = { ...(ui.showEarlier || {}), [ui.view.type === 'main' ? mainRun()?.id : ui.view.id]: true }; renderAll(true); }
    else if (action === 'chat-to-room') { const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id), agent = personalAgent(run); if (agent) openRoomDialog(ctx, { id: agent.id, name: agent.name }); }
    else if (action === 'term-close') { ui.termOpen = false; renderAll(); }
    else if (action === 'term-open') { ui.termOpen = true; renderAll(); }
    else if (['room-shared', 'room-stop', 'room-remove', 'task-assign', 'info-toggle', 'room-image', 'room-delete', 'side-tab'].includes(action)) await roomAction(ctx, action, target);
    else if (action?.startsWith('dev-')) await devicesAction(ctx, action, target);
    else if (action?.startsWith('mo-')) await monitorAction(ctx, action, target);
    else if (action?.startsWith('nt-')) await noticesAction(ctx, action, target);
    else if (action === 'brain-setup') { const found = ui.snap.memory?.brainCandidates?.[0]; const text = `Help me set up my second brain for all agents.${found ? ` I think it is at ${found}.` : ''} Ask me how I want you to use it.`; if (mainRun()) await api(`/runs/${mainRun().id}/${workingStates.includes(mainRun().state) ? 'say' : 'resume'}`, { method: 'POST', data: workingStates.includes(mainRun().state) ? { text } : { prompt: text } }); else await api('/main', { method: 'POST', data: { prompt: text } }); open('main'); }
    else if (action === 'quick') { await api('/main', { method: 'POST', data: { prompt: target.dataset.text } }); await refresh(); }
    else if (action === 'sync') await syncIssues();
    else if (action === 'sec-toggle') toggleSection(target.dataset.sec);
    else if (action === 'settings-open') openSettings(ctx);
    else if (action === 'theme') window.rexTheme?.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    else if (action === 'stop') { const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); await api(`/runs/${run.id}/stop`, { method: 'POST', data: {} }); await refresh(); }
    else if (action === 'scan') await scanProjects();
    else if (action === 'wake-approve') { await api(`/rooms/x/wakes/${target.dataset.id}`, { method: 'POST', data: {} }); toast('Agent resumed.'); await refresh(); }
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
    if (missing >= 0) { slideTo(form, missing); toast('Answer this one first, or press Skip.', true); return; }
  }
  for (const field of form.querySelectorAll('[data-type]')) {
    let value = field.value; if (value === '__custom') value = form.elements[`${field.name}__custom`].value; if (value === '') continue;
    content[field.name] = field.dataset.type === 'boolean' ? value === 'true' : ['number', 'integer'].includes(field.dataset.type) ? Number(value) : value;
  }
  const always = decision === 'always';
  document.activeElement?.blur?.();
  try { await api(`/interactions/${form.dataset.interaction}/answer`, { method: 'POST', data: { action: always ? 'accept' : decision, content: always ? { ...content, always: true } : content } }); toast(decision === 'accept' || always ? 'Sent to the agent.' : 'Declined.'); await refresh(); }
  catch (error) { toast(error.message, true); }
});
document.addEventListener('scroll', event => { if (event.target.id === 'feed') ui.stick = event.target.scrollHeight - event.target.scrollTop - event.target.clientHeight < 80; }, true);

initPickers(ctx); initRoomInfo(ctx); initAgentCard(ctx); wireLoop(ctx); initLocalTasks(ctx); initDevices(ctx); window.__rexCtx = ctx; wireFiles(ctx); wireAgentCards(ctx); wireSpeak(toast); wireWorktrees(ctx); wireChatSwitch(); wireImageViewer();
// On a phone the side panels start closed, and the menu button opens the list of chats.
if (window.matchMedia('(max-width: 760px)').matches) { ui.infoOpen = false; ui.chatInfo = false; ui.termOpen = false; }
// A page an agent made (an explanation of its changes) opens full screen over the chat, in a sandbox with no access to Rex Desk.
function openPage(src, title = 'Explanation') {
  document.querySelector('.page-view')?.remove();
  const view = document.createElement('div'); view.className = 'page-view'; view.setAttribute('role', 'dialog'); view.setAttribute('aria-label', title);
  view.innerHTML = `<div class="pv-bar"><b>${esc(title)}</b><span class="spacer"></span><a class="btn small" href="${esc(src)}" target="_blank" rel="noopener noreferrer">Open in a new window</a><button type="button" class="btn small" data-pv-close>Close</button></div><iframe class="pv-frame" sandbox="allow-scripts" src="${esc(src)}" title="${esc(title)}"></iframe>`;
  document.body.append(view); view.querySelector('[data-pv-close]').focus();
  view.addEventListener('click', event => { if (event.target.closest('[data-pv-close]')) view.remove(); });
  view.addEventListener('keydown', event => { if (event.key === 'Escape') view.remove(); });
}
// An explanation page an agent made opens as a tab of the file window, on its preview (Code shows its source).
document.addEventListener('click', event => { const button = event.target.closest?.('[data-page-open]'); if (!button) return; event.preventDefault(); event.stopPropagation(); if (window.rexOpenFile) void window.rexOpenFile(button.dataset.pageOpen, { view: 'preview' }); else openPage(button.dataset.pageOpen, button.textContent.trim() || 'Explanation'); }, true);
document.addEventListener('click', event => { if (!event.target.closest?.('[data-action="m-rail"]')) return; event.stopPropagation(); document.querySelector('.chat-shell')?.classList.toggle('show-rail'); }, true);
document.addEventListener('click', event => { const head = event.target.closest?.('[data-action="agent-group"]'); if (!head) return; event.stopPropagation(); toggleGroup(head.dataset.project); renderAll(); }, true);
// The back and forward buttons, and a pasted address, move between screens.
window.addEventListener('hashchange', () => {
  if (ui.fromOpen) { ui.fromOpen = false; return; }
  const view = viewFromHash(); if (!view) return;
  ui.view = view; ui.page = ''; void refresh({ full: true });
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
try {
  await refresh({ full: true });
  const stream = new EventSource('/api/events'); let timer;
  stream.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(() => void refresh().catch(() => {}), 700); });
  setInterval(() => void refresh().catch(() => {}), 15000);
} catch (error) { app.innerHTML = `<div class="boot"><h2>Rex Desk is unavailable</h2><p>${esc(error.message)}</p><p>Start it with <code>npm start</code>, then reload.</p></div>`; }

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
  const counter = form.querySelector('[data-qcount]'); if (counter) counter.textContent = `Question ${to + 1} of ${count}`;
  form.querySelector('.qback').hidden = to === 0; form.querySelector('.qnext').hidden = to === count - 1; form.querySelector('.qsend').hidden = to !== count - 1;
  const box = slides[to].querySelector('.qinput');
  if (to === count - 1 && box?.value) form.querySelector('.qsend').focus(); else box?.focus({ preventScroll: true });
}
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-qmove]'); if (!button) return;
  const form = button.closest('form'), step = Number(form.dataset.step), move = Number(button.dataset.qmove);
  if (move > 0 && !answered(form.querySelector('.qslide.on'))) { toast('Pick or type an answer first.', true); return; }
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
  const profile = ui.profile || { sections: [], projects: [], agents: [] }, name = profile.name || 'You';
  const about = profile.sections.find(section => section.title === 'About them')?.items.map(noteText) || [];
  const others = profile.sections.filter(section => section.title !== 'About them');
  const photo = profile.photo ? `<img class="pf-photo" src="${photoUrl()}" alt="${esc(name)}">` : `<div class="pf-photo pf-initials" aria-hidden="true">${esc(initials(name))}</div>`;
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const stats = `Works on ${plural(profile.projects.length, 'project')} with ${plural(profile.agents.length, 'agent')}.`;
  const plain = text => String(text || '').replace(/\*\*|__|`/g, '');
  const hero = `<section class="pf-hero">${photo}<div class="pf-who"><h2>${esc(name)}</h2>${profile.email ? `<p class="muted">${esc(profile.email)}</p>` : ''}
    <p class="pf-intro">${about.length ? about.map(item => esc(item.text)).join(' · ') : 'Your agents add what they learn about you here as you work with them.'}</p>
    <p class="pf-stats">${stats}</p>
    <div class="pf-actions"><label class="btn small pf-upload">${profile.photo ? 'Change photo' : 'Add a photo'}<input type="file" accept="image/png,image/jpeg,image/webp" data-photo-upload hidden></label>${profile.photo ? '<button class="btn small" data-action="photo-remove">Remove photo</button>' : ''}</div>
    ${profile.photo ? '' : '<p class="muted small">Or let Rex Agent find a picture of you in your projects: it asks before using one.</p>'}</div></section>`;
  // How agents should talk to you: every section is shown, so you can fill it in yourself; agents add to it as they learn.
  const SECTIONS = [['explain', 'How to explain things to me', 'Format, length, level of detail, examples, what to always explain, what to skip.', 'Short answer first, then the steps as a numbered list'],
    ['personality', 'Personality', 'How you think and work, so agents meet you where you are.', 'I learn by doing; show me, then explain'],
    ['likes', 'Likes', 'What works well for you.', 'Plain words, no jargon'], ['dislikes', 'Dislikes', 'What agents should stop doing.', 'Long walls of text'],
    ['works', 'How they work', 'Your habits and tools.', 'I work in Orca and test on my phone'], ['about', 'About them', 'Facts about you.', 'I speak Khmer, English and Korean']];
  const card = ([kind, title, hint, example]) => {
    const items = (profile.sections.find(section => section.title === title)?.items || []).map(noteText);
    return `<div class="pf-card pf-notes${kind === 'explain' ? ' wide' : ''}"><h3>${esc(title)}</h3><p class="pf-hint">${esc(hint)}</p>
      ${items.length ? `<ul>${items.map(item => `<li><span>${esc(item.text)}${item.when ? ` <small class="muted">${item.when}${item.soft ? ' · may change' : ''}</small>` : ''}</span><button type="button" class="ag-x" data-note-forget="${esc(kind)}" data-note-text="${esc(item.text)}" title="Remove this" aria-label="Remove this"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></li>`).join('')}</ul>` : ''}
      <form class="pf-add" data-note-add="${esc(kind)}"><input name="text" type="text" maxlength="240" placeholder="For example: ${esc(example)}" aria-label="Add to ${esc(title)}" autocomplete="off"><button class="btn small">Add</button></form></div>`;
  };
  const notes = `<section><h3 class="pf-title">How your agents should talk to you</h3><p class="pf-hint">Every agent reads this before it answers you, including new ones. Agents add to it when they notice what works; you can add or remove anything.</p><div class="pf-grid pf-notes-grid">${SECTIONS.map(card).join('')}</div></section>`;
  const projects = profile.projects.length ? `<section><h3 class="pf-title">Projects</h3><div class="pf-grid">${profile.projects.map(project => `<button class="pf-card pf-project" data-open="project" data-id="${esc(project.slug)}"><h3>${esc(project.slug)}</h3><p>${esc(plain(project.purpose) || 'No description yet.')}</p>${project.stack.filter(item => !/\.(json|toml|lock|txt)$/i.test(item)).length ? `<div class="pf-tags">${project.stack.filter(item => !/\.(json|toml|lock|txt)$/i.test(item)).slice(0, 5).map(item => `<span>${esc(item)}</span>`).join('')}</div>` : ''}</button>`).join('')}</div></section>` : '';
  const agents = profile.agents.length ? `<section><h3 class="pf-title">Your agents</h3><div class="pf-agents">${profile.agents.map(agent => `<button class="pf-agent" data-open="specialist" data-id="${esc(agent.id)}">${avatarHtml(ctx, { name: agent.name, size: 'sm' })}<span>${esc(agent.name)}<small>${esc(agent.project)}</small></span></button>`).join('')}</div></section>` : '';
  return `<div class="page pf">${brainBanner()}${hero}${notes}${projects}${agents}<p class="muted small">Notes are kept in .rexdesk/user.md. Change or delete any line there and every agent follows it.</p></div>`;
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
    toast('Profile photo saved.'); await refresh({ full: true });
  } catch (error) { toast(error.message || 'That picture could not be read.', true); }
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
  if (state.loading) body = '<p class="muted">Opening the file…</p>';
  else if (state.error) body = `<p class="fbad">${esc(state.error)}</p>`;
  else if (state.mode === 'fields') {
    const lines = state.content.split('\n'), rows = lines.map((line, index) => [line, index, envLine(line)]).filter(([, , match]) => match);
    body = rows.length ? `<div class="frows">${rows.map(([, index, match]) => {
      const key = match[2], value = match[4].replace(/^(["'])(.*)\1$/, '$2'), hidden = secretKey(key) && !state.shown.has(index), wanted = state.keys.includes(key);
      return `<label class="frow${wanted ? ' wanted' : ''}"><span class="fkey">${esc(key)}${wanted ? '<small>asked for</small>' : ''}</span><span class="fval"><input type="${hidden ? 'password' : 'text'}" data-file-line="${index}" value="${esc(value)}" autocomplete="off" spellcheck="false" placeholder="${wanted ? 'Paste the value here' : 'empty'}">${secretKey(key) ? `<button type="button" class="btn small quiet" data-file-show="${index}">${hidden ? 'Show' : 'Hide'}</button>` : ''}</span></label>`;
    }).join('')}</div>` : '<p class="muted">No KEY=value lines yet. Switch to text to write the file.</p>';
  } else body = `<textarea class="ftext" data-file-text spellcheck="false">${esc(state.content)}</textarea>`;
  const toggle = !state.loading && !state.error && isEnv(file) ? `<button type="button" class="btn small quiet" data-file-mode>${state.mode === 'fields' ? 'Edit as text' : 'Edit as fields'}</button>` : '';
  return `<form class="card ask fcard" data-file="${esc(item.id)}"><div class="qhead"><span class="qdot"></span>File to fill in · ${esc(runTitle(run))}</div>
    <div class="qtext md">${markdown(String(item.title || ''))}</div>
    <div class="fpath"><code title="${esc(file)}">${esc(file)}</code>${state.exists === false ? '<span class="chip">new file</span>' : ''}${toggle}</div>
    ${body}
    <p class="fnote">Saved straight to this computer. ${esc(runTitle(run))} sees only which keys have a value, never what you type.</p>
    <div class="row"><button class="send-btn wide" ${state.loading || state.error ? 'disabled' : ''}>Save file</button><button type="button" class="btn small" data-file-close>Close without saving</button></div></form>`;
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
    try { await api(`/interactions/${form.dataset.file}/answer`, { method: 'POST', data: { action: 'decline' } }); ui.files.delete(form.dataset.file); toast('Closed without saving.'); await refresh(); } catch (error) { toast(error.message, true); }
  }
});
document.addEventListener('submit', async event => {
  const form = event.target.closest?.('[data-file]'); if (!form) return; event.preventDefault(); event.stopPropagation();
  const state = ui.files.get(form.dataset.file); if (!state || state.loading) return;
  try { await api(`/interactions/${form.dataset.file}/file`, { method: 'POST', data: { content: state.content } }); ui.files.delete(form.dataset.file); document.activeElement?.blur?.(); toast('File saved.'); await refresh({ full: true }); }
  catch (error) { toast(error.message, true); }
}, true);

// ---------- reply to a room message: it goes to that agent without an @mention ----------
function drawReplyBar() {
  const composer = document.querySelector('.composer-inner'); if (!composer) return;
  composer.querySelector('.replybar')?.remove();
  const reply = ui.reply; if (!reply || ui.view.type !== 'room' || reply.roomId !== ui.view.id) return;
  composer.insertAdjacentHTML('afterbegin', `<div class="replybar"><span>Replying to <b>${esc(reply.name)}</b> <span class="muted">${esc(reply.text)}</span></span><button type="button" class="ag-x" data-reply-cancel aria-label="Cancel the reply" title="Cancel the reply"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>`);
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
  if (!event.shiftKey && !confirm('Unsend this message? (Shift+click unsends without asking.)')) return;
  try { const result = await api(`/runs/${runId}/messages/${sequence}`, { method: 'DELETE' }); toast(result.seen ? 'Unsent. The agent had already read it.' : 'Unsent before the agent read it.'); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
});
// Unsend your own message in a group chat.
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-msg-delete]'); if (!button) return;
  event.stopPropagation();
  const message = (ui.snap.messages || []).find(item => item.id === button.dataset.msgDelete); if (!message) return;
  if (!event.shiftKey && !confirm('Unsend this message? (Shift+click unsends without asking.)')) return;
  try { await api(`/rooms/${message.roomId}/messages/${message.id}`, { method: 'DELETE' }); if (ui.reply?.id === message.id) { ui.reply = null; drawReplyBar(); } await refresh(); } catch (error) { toast(error.message, true); }
});

// ---------- a personal chat with an agent: its profile and what was shared, on the right ----------
function personalAgent(run) {
  if (!run || run.roomAgent) return null;
  if (run.role === 'coordinator' && run.main) return { id: 'main', name: 'Rex Agent', projectSlug: 'all projects', purpose: 'Knows every project and agent, and helps you decide who does what.', main: true, status: { label: stateLabel(run) } };
  if (run.role !== 'specialist' || !run.specialistId) return null;
  return (ui.snap.specialists || []).find(agent => agent.id === run.specialistId && agent.runId === run.id) || null;
}
function personalSide(run, agent, items, shells) {
  // Tabs, like a messenger's chat info: Profile (with what was shared in the chat), the worktrees of this chat, and the agent's Terminal.
  const trees = chatWorktrees(ui, { runId: run.id, agentId: agent.id });
  const tab = ui.chatTab === 'terminal' && shells.length ? 'terminal' : ui.chatTab === 'worktrees' ? 'worktrees' : 'profile', part = ['media', 'files', 'links'].includes(ui.chatShared) ? ui.chatShared : 'media';
  const entries = items.filter(item => item.role === 'human' || item.role === 'agent').map(item => ({ from: item.role === 'human' ? 'You' : agent.name, at: item.at, text: item.text }));
  const shared = collectShared(entries, (ui.snap.artifacts || []).filter(item => item.runId === run.id).map(item => ({ ...item, from: agent.name })));
  const close = '<button type="button" class="side-x" data-action="chat-info-close" aria-label="Close the side panel" title="Close"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>';
  const tabs = `<div class="side-head tabs"><button type="button" class="tab ${tab === 'profile' ? 'on' : ''}" data-action="chat-tab" data-tab="profile">Profile</button><button type="button" class="tab ${tab === 'worktrees' ? 'on' : ''}" data-action="chat-tab" data-tab="worktrees">Worktrees${trees.length ? `<span class="tcount quiet">${trees.length}</span>` : ''}</button>${shells.length ? `<button type="button" class="tab ${tab === 'terminal' ? 'on' : ''}" data-action="chat-tab" data-tab="terminal">Terminal<span class="tcount quiet">${shells.length}</span></button>` : ''}<span class="spacer"></span>${close}</div>`;
  if (tab === 'worktrees') return tabs + worktreeSideHtml(ctx, trees);
  if (tab === 'terminal') return tabs + terminalHtml(shells, { esc, hhmm }).replace(/^<div class="side-head">[\s\S]*?<\/div>(?=<div class="side-body)/, '');
  const sharedBox = `<h3>Media, files and links</h3><div class="pshared"><div class="pseg">${sharedTabButtons(shared, part, 'chat-shared')}</div><div class="shared">${sharedTabsHtml(ctx, shared, part)}</div></div>`;
  const sources = (agent.taskSources || []).map(id => id === 'local' ? 'Rex Desk tasks' : (ui.snap.config?.sources || []).find(source => source.id === id)?.name).filter(Boolean);
  const rooms = (ui.snap.rooms || []).filter(room => room.members.some(member => member.id === agent.id));
  return `${tabs}<div class="side-body rinfo pinfo">
    <div class="rhero">${avatarHtml(ctx, { name: agent.name, size: 'xl' })}<h2 class="pname">${esc(agent.name)}</h2><p class="rsub"><span class="dot ${stateTone(run) === 'working' ? 'working' : 'good'}"></span> ${esc(agent.status?.label || stateLabel(run))}${agent.main ? '' : ` on <a href="#" data-open="project" data-id="${esc(agent.projectSlug)}">${esc(agent.projectSlug)}</a>`}</p></div>
    ${agent.purpose ? `<h3>About</h3><p class="pabout">${esc(agent.purpose)}</p>` : ''}
    ${sharedBox}
    ${agent.main ? '' : `<h3>${agent.provider === 'codex' ? 'Codex' : agent.provider === 'gemini' ? 'Google (Antigravity)' : 'Claude'} account</h3>${pickerHtml(ctx, { id: 'pp-profile', label: 'Account', value: agent.profile || '', items: [{ value: '', label: 'Same as everyone', hint: 'The account chosen at the bottom left' }, ...((ui.accounts?.[agent.provider === 'codex' ? 'codex' : 'claude']?.profiles) || []).filter(item => item.loggedIn).map(item => ({ value: item.profile, label: item.account || item.label, hint: [item.label, item.plan].filter(Boolean).join(' · ') }))] })}<button type="button" class="btn small quiet" data-action="accounts">Manage accounts</button>`}
    ${toolsHtml(agent.main ? 'main' : agent.id)}
    ${agent.main ? '' : `<h3>Tasks come from</h3><p class="pabout">${esc(sources.join(', ') || 'Not set yet')}</p>`}
    ${(agent.lessons || []).length ? `<h3>Lessons learned <span>${agent.lessons.length}</span></h3><ul class="plessons">${agent.lessons.slice(-4).map(lesson => `<li>${esc(lesson.text)}</li>`).join('')}</ul>` : ''}
    ${rooms.length ? `<h3>Group chats <span>${rooms.length}</span></h3><ul class="rtasks">${rooms.map(room => `<li><button class="rtask" data-open="room" data-id="${esc(room.id)}">${avatarHtml(ctx, { name: room.name, image: room.image, id: room.id, at: room.imageAt || '', size: 'xs' })}<span>${esc(room.name)}</span></button></li>`).join('')}</ul>` : ''}
    ${agent.main ? '' : `<div class="prow"><button class="btn small" data-open="specialist" data-id="${esc(agent.id)}" data-profile="1">Edit profile</button></div>`}
  </div>`;
}
document.addEventListener('click', event => {
  const target = event.target.closest?.('[data-action="chat-tab"],[data-action="chat-shared"],[data-action="chat-info-close"],[data-action="chat-info"],[data-copy]'); if (!target) return;
  event.stopPropagation();
  if (target.dataset.copy !== undefined) { void navigator.clipboard?.writeText(target.dataset.copy).then(() => toast('Path copied.'), () => toast('Could not copy.', true)); return; }
  if (target.dataset.action === 'chat-tab') ui.chatTab = target.dataset.tab;
  else if (target.dataset.action === 'chat-shared') ui.chatShared = target.dataset.tab;
  else ui.chatInfo = target.dataset.action === 'chat-info';
  renderAll();
}, true);

// ---------- dictated messages ----------
// Added to a message that came from the microphone. It reaches the agent, but the chat shows the message without it.
const VOICE_NOTE = '\n\n(Sent by voice: speech-to-text may have misheard some words, names or Khmer and Korean terms. Read it against our conversation and the topic we are on, and work out what I meant. If a word could change what you do and you are not sure, ask.)';
function spokenText(text) { const mark = /\s*\(Sent by voice: [^)]*\)\s*$/; return mark.test(String(text || '')) ? { text: String(text).replace(mark, ''), voice: true } : { text, voice: false }; }
document.addEventListener('input', event => { if (event.target.id === 'draft' && !event.target.value.trim()) ui.voiceDrafts?.delete(draftKey()); });

function micIcon() { return '<svg class="vmic" viewBox="0 0 16 16" width="12" height="12" aria-label="Sent by voice" role="img"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'; }

// Adding and removing lines in "How your agents should talk to you".
document.addEventListener('submit', async event => {
  const form = event.target.closest?.('[data-note-add]'); if (!form) return; event.preventDefault(); event.stopPropagation();
  const text = form.text.value.trim(); if (!text) return;
  try { await api('/profile/notes', { method: 'POST', data: { kind: form.dataset.noteAdd, text } }); form.text.value = ''; document.activeElement?.blur?.(); toast('Saved. Every agent follows it from now on.'); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
}, true);
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-note-forget]'); if (!button) return; event.stopPropagation();
  try { await api('/profile/notes', { method: 'DELETE', data: { kind: button.dataset.noteForget, text: button.dataset.noteText } }); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
}, true);

// ---------- Claude accounts: which subscription the agents run on ----------
function accountChip() {
  const name = aiKey(ui.snap?.config?.provider), list = ui.accounts?.[name], current = list?.profiles?.find(item => item.profile === list.selected) || list?.profiles?.[0];
  return `<span class="acct-dot ${current?.loggedIn ? 'good' : 'bad'}"></span><span class="acct-text"><b>${{ codex: 'Codex', gemini: 'Gemini' }[name] || 'Claude'}</b> ${esc(current ? (current.account || current.label) : 'account')}</span>`;
}
async function loadAccounts(refreshStatus = false) { try { ui.accounts = await api(`/agents${refreshStatus ? '?refresh=1' : ''}`); ui.accountsAuto = (await api('/accounts/auto')).on; } catch {} }
async function accountsDialog() {
  document.querySelector('.dialog-back.accounts')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back accounts'; document.body.append(back);
  const NAMES = { claude: ['Claude', 'Claude Code', 'Claude'], codex: ['Codex', 'Codex', 'ChatGPT'], gemini: ['Gemini', 'Gemini', 'Google'] };
  const tab = () => NAMES[ui.acctTab] ? ui.acctTab : aiKey(ui.snap?.config?.provider);
  const draw = () => {
    const name = tab(), [short, product, service] = NAMES[name], list = ui.accounts?.[name] || { profiles: [] }, defaultAi = aiKey(ui.snap?.config?.provider);
    const signedIn = list.profiles.filter(item => item.loggedIn), signedOut = list.profiles.filter(item => !item.loggedIn);
    // The title is the account; the line under it says where it lives and what plan it is, without repeating the title or saying "none".
    // Each account: a colored letter for the person, the email, its plan as a tag, and the profile folder it lives in, in plain words.
    const hue = text => [...String(text || '?')].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7) % 8;
    const where = item => { const label = String(item.label || ''), folder = label.match(/\.(?:claude|codex)(?:-([\w-]+?))?(?:-profile)?$/i); return /^Orca profile/i.test(label) ? 'Orca profile' : folder ? (folder[1] ? `${folder[1][0].toUpperCase()}${folder[1].slice(1)} profile` : 'Main profile') : label; };
    const plan = item => item.plan && item.plan !== 'none' ? `<span class="acct-plan">${esc(`${item.plan[0].toUpperCase()}${item.plan.slice(1)}`)}</span>` : '';
    // How much of each limit the account used, and when it resets: Claude Code and Codex report it while agents work on that account.
    const resets = at => { if (!at) return ''; const date = new Date(at), today = new Date(); const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return date.toDateString() === today.toDateString() ? `resets ${time}` : `resets ${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`; };
    const LIMITS = [['five_hour', '5 hours'], ['seven_day', 'Week'], ['seven_day_opus', 'Week, Opus'], ['seven_day_sonnet', 'Week, Sonnet']];
    const usageHtml = (provider, profile) => {
      const saved = (ui.snap.usage || []).find(entry => entry.provider === provider && (entry.profile || '') === (profile || '')) || (ui.snap.usage || []).find(entry => entry.provider === provider && entry.id === `${provider}:${profile || 'default'}`);
      // The known limits first, then any other one the account reports (a per-model week, like Fable), under its own label.
      const extra = Object.entries(saved?.windows || {}).filter(([key]) => !LIMITS.some(([known]) => known === key)).map(([key, value]) => [key, value.label || key.replace(/^seven_day_/, 'Week, ').replace(/_/g, ' ')]);
      const windows = [...LIMITS, ...extra].filter(([key]) => saved?.windows?.[key] && (saved.windows[key].used !== null || saved.windows[key].resetsAt));
      if (!windows.length) return '<span class="acct-usage none">Usage shows after an agent works on this account.</span>';
      return `<span class="acct-usage">${windows.map(([key, label]) => { const limit = saved.windows[key], used = limit.used ?? 0, passed = limit.resetsAt && limit.resetsAt < Date.now(); return `<span class="acct-limit ${used >= 90 && !passed ? 'hot' : ''}"><span class="acct-lname">${label}</span><meter min="0" max="100" low="70" high="90" optimum="0" value="${passed ? 0 : used}"></meter><span class="acct-lval">${passed ? 'reset' : `${used}%`}</span><span class="acct-lreset">${passed ? '' : esc(resets(limit.resetsAt))}</span></span>`; }).join('')}<small class="acct-asof">as of ${esc(new Date(saved.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</small></span>`;
    };
    const row = item => { const who = item.account || item.label; return `<label class="acct-row${item.profile === list.selected ? ' on' : ''}" title="${esc(item.label)}"><input type="radio" name="profile" value="${esc(item.profile)}" ${item.profile === list.selected ? 'checked' : ''}><span class="nt-av acct-pic h${hue(who)}">${esc((String(who).match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}</span><span class="acct-main"><span class="acct-name"><b>${esc(who)}</b>${plan(item)}</span><small>${esc([item.account ? where(item) : '', item.method].filter(Boolean).join(' · '))}</small>${usageHtml(name, item.profile)}</span>${item.profile === list.selected ? '<span class="acct-badge"><i aria-hidden="true"></i>In use</span>' : '<span class="acct-use">Use</span>'}</label>`; };
    const out = item => `<li><span class="acct-main"><b>${esc(item.account || item.label)}</b><small>${esc(item.label !== (item.account || item.label) ? item.label : 'Not signed in')}</small></span><button type="button" class="btn small" data-acct-login="${esc(item.profile)}">Sign in</button></li>`;
    back.innerHTML = `<form class="dialog acct-dialog"><div class="acct-head"><h2>AI accounts</h2><button type="button" class="side-x" data-close aria-label="Close" title="Close"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>
      <div class="acct-tabs" role="tablist">${Object.entries(NAMES).map(([key, [, title]]) => `<button type="button" role="tab" aria-selected="${name === key}" class="acct-tab${name === key ? ' on' : ''}" data-acct-tab="${key}"><b>${title}</b>${defaultAi === key ? '<span class="acct-default-badge">Default</span>' : ''}</button>`).join('')}</div>
      <div class="acct-intro"><p>Agents on ${product} run on the account marked <b>In use</b>. Click another account to switch.</p>${defaultAi === name ? `<span class="acct-note">New agents and chats use ${product}</span>` : `<button type="button" class="btn small" data-acct-default="${name}">Use ${product} for new agents</button>`}</div>
      ${signedIn.length ? `<div class="acct-list">${signedIn.map(row).join('')}</div>` : `<p class="acct-empty">No ${service} account is signed in yet${name === 'codex' ? '. Install the Codex CLI (npm install -g @openai/codex) if it is missing, then add an account below.' : name === 'gemini' ? '. Install the Antigravity CLI (winget install Google.AntigravityCLI) if it is missing, then press Sign in.' : '.'}</p>`}
      ${signedOut.length ? `<details class="acct-out"${signedIn.length ? '' : ' open'}><summary>Not signed in <span>${signedOut.length}</span></summary><ul>${signedOut.map(out).join('')}</ul></details>` : ''}
      ${name === 'gemini' ? '' : `<div class="acct-add" data-acct-addbox>${ui.acctAdding ? `<input type="text" data-acct-name maxlength="30" placeholder="Name for the new account, like work or personal" aria-label="Name for the new account"><button type="button" class="btn small primary" data-acct-create>Create and sign in</button><button type="button" class="btn small" data-acct-cancel>Cancel</button>` : `<button type="button" class="btn small" data-acct-new>+ Add a ${short} account</button>`}</div>`}
      ${ui.acctWaiting ? `<p class="acct-wait"><span class="dot working"></span> Finish signing in to ${service} in the window that opened. This list updates by itself.</p>` : ''}
      <label class="acct-auto"><input type="checkbox" data-acct-auto ${ui.accountsAuto !== false ? 'checked' : ''}><span>When an account hits its usage limit, switch to another signed-in one and continue</span></label>
      <div class="acct-foot"><button type="button" class="btn quiet" data-acct-refresh>Check again</button><button type="button" class="btn primary" data-close>Done</button></div></form>`;
  };
  if (!ui.accounts) { back.innerHTML = '<div class="dialog"><p class="muted">Checking your AI accounts…</p></div>'; await loadAccounts(true); }
  draw();
  back.addEventListener('click', async event => {
    if (event.target === back || event.target.closest('[data-close]')) { back.remove(); renderAll(); return; }
    const switchTab = event.target.closest('[data-acct-tab]'); if (switchTab) { ui.acctTab = switchTab.dataset.acctTab; ui.acctAdding = false; draw(); return; }
    const pickDefault = event.target.closest('[data-acct-default]');
    if (pickDefault) { try { await api('/config', { method: 'PUT', data: { ...ui.snap.config, provider: pickDefault.dataset.acctDefault } }); await refresh(); ui.acctTab = pickDefault.dataset.acctDefault; toast(`New agents and chats use ${{ codex: 'Codex', gemini: 'Gemini' }[pickDefault.dataset.acctDefault] || 'Claude Code'}.`); draw(); } catch (error) { toast(error.message, true); } return; }
    if (event.target.closest('[data-acct-refresh]')) { back.querySelector('[data-acct-refresh]').textContent = 'Checking…'; await loadAccounts(true); draw(); }
    if (event.target.closest('[data-acct-new]')) { ui.acctAdding = true; draw(); back.querySelector('[data-acct-name]')?.focus(); }
    if (event.target.closest('[data-acct-cancel]')) { ui.acctAdding = false; draw(); }
    const login = event.target.closest('[data-acct-login]'), create = event.target.closest('[data-acct-create]');
    if (login || create) {
      event.preventDefault(); const name = tab(), signedIn = () => (ui.accounts?.[name]?.profiles || []).filter(item => item.loggedIn).length;
      try {
        if (create) { const label = back.querySelector('[data-acct-name]').value.trim(); if (!label) return toast('Give the account a name first.', true); await api('/agents/add', { method: 'POST', data: { name: label, provider: name } }); ui.acctAdding = false; }
        else await api('/agents/login', { method: 'POST', data: { profile: login.dataset.acctLogin, provider: name } });
        ui.acctWaiting = true; await loadAccounts(true); draw();
        // Sign-in happens in the browser; look again every few seconds for up to three minutes.
        for (let tries = 0; tries < 60 && ui.acctWaiting && document.body.contains(back); tries++) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          const before = signedIn(); await loadAccounts(true);
          if (signedIn() > before) { ui.acctWaiting = false; toast('Signed in. You can pick this account now.'); }
          if (document.body.contains(back)) draw();
        }
        ui.acctWaiting = false; if (document.body.contains(back)) draw();
      } catch (error) { ui.acctWaiting = false; toast(error.message, true); draw(); }
    }
  });
  back.addEventListener('keydown', event => { if (event.target.matches('[data-acct-name]') && event.key === 'Enter') { event.preventDefault(); back.querySelector('[data-acct-create]')?.click(); } });
  back.addEventListener('change', async event => {
    try {
      if (event.target.name === 'profile') { const name = tab(); await api('/agents/profile', { method: 'POST', data: { provider: name, profile: event.target.value } }); await loadAccounts(); toast(`Agents on ${NAMES[name][1]} now use this account from their next reply.`); draw(); }
      if (event.target.matches('[data-acct-auto]')) { ui.accountsAuto = (await api('/accounts/auto', { method: 'POST', data: { on: event.target.checked } })).on; }
    } catch (error) { toast(error.message, true); }
  });
}
document.addEventListener('click', event => { if (!event.target.closest?.('[data-action="accounts"]')) return; event.stopPropagation(); void accountsDialog(); }, true);
void loadAccounts().then(() => { if (ui.snap) renderAll(); });

// ---------- Jev: say or type what this computer (or a website) should do ----------
function jevStage() {
  const log = ui.jevLog || [];
  const examples = ['Turn the volume down to 30', 'Open Bluetooth settings', 'Turn on dark mode', 'Find the cheapest flight from Phnom Penh to Seoul next Friday', 'Take a screenshot', 'What is using my memory?'];
  const entry = item => `<li class="jv-item"><div class="jv-said"><b>${esc(item.text)}</b><small>${esc(item.at)}</small></div>${item.busy ? '<p class="muted">Working…</p>' : ''}${item.error ? `<p class="bad">${esc(item.error)}</p>` : ''}${item.say ? `<p>${esc(item.say)}</p>` : ''}${(item.results || []).map(step => `<p class="jv-step ${step.ok ? 'ok' : 'bad'}">${step.ok ? '✓' : '✗'} ${esc(step.title)}${step.ok ? (step.result?.url ? ` · <a href="${esc(step.result.url)}">open its chat</a>` : step.result?.text ? ` · ${esc(String(step.result.text).slice(0, 160))}` : '') + jevDetail(step.result) : ` · ${esc(step.error)}`}</p>`).join('')}${item.confirm ? `<div class="jv-confirm"><span>Do this? <b>${esc(item.confirm.join(', '))}</b></span><button class="btn small primary" data-jev-yes="${item.id}">Yes</button><button class="btn small" data-jev-yes="${item.id}" data-always="1" title="Do it now, and never ask again for ${esc(item.confirm.join(', '))}">Yes, always</button><button class="btn small quiet" data-jev-no="${item.id}">Cancel</button></div>` : ''}</li>`;
  return { title: 'Jev', meta: 'Control this computer and websites', top: true,
    feed: `<div class="page jv"><section class="jv-hero"><h2>What should Jev do?</h2><p class="muted">On this computer: apps, settings, sound, screen, Wi-Fi and Bluetooth, files, typing and clicking. On the web: search, compare and book with a browser agent that asks before paying. Khmer, English or Korean. Hold Space in the box below to talk. From any app, press <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>J</kbd>.</p>
      <div class="jv-examples">${examples.map(text => `<button class="chip-btn" data-jev-try="${esc(text)}">${esc(text)}</button>`).join('')}</div></section>
      ${log.length ? `<ol class="jv-log">${log.slice().reverse().map(entry).join('')}</ol>` : ''}</div>`,
    composer: { placeholder: 'Tell Jev what to do… (hold Space to talk)', mentions: [], noPickers: true } };
}
async function jevDo(text) {
  const item = { id: String(Date.now()), text, at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), busy: true };
  ui.jevLog = [...(ui.jevLog || []), item].slice(-30); renderAll();
  try {
    const answer = await api('/computer/do', { method: 'POST', data: { text } });
    Object.assign(item, { busy: false, say: answer.say, results: answer.results || [], steps: answer.steps, confirm: answer.needsConfirm?.length ? answer.needsConfirm : null, confirmActions: answer.confirmActions || [], error: !answer.steps?.length ? (answer.say || 'Jev did not find something to do for that. Try other words.') : '' });
    if (item.error === item.say) item.say = '';
  } catch (error) { Object.assign(item, { busy: false, error: error.message }); }
  renderAll();
}
document.addEventListener('click', async event => {
  const tryIt = event.target.closest?.('[data-jev-try]'); if (tryIt) { event.stopPropagation(); return jevDo(tryIt.dataset.jevTry); }
  const yes = event.target.closest?.('[data-jev-yes]'), no = event.target.closest?.('[data-jev-no]'); if (!yes && !no) return;
  event.stopPropagation(); const item = (ui.jevLog || []).find(entry => entry.id === (yes || no).dataset[yes ? 'jevYes' : 'jevNo']); if (!item) return;
  item.confirm = null;
  if (no) { item.say = 'Cancelled.'; return renderAll(); }
  // "Yes, always": these actions stop asking from now on (Settings, Jev and voice, lists them).
  if (yes.dataset.always && item.confirmActions?.length) await api('/computer/allow', { method: 'POST', data: { actions: item.confirmActions } }).then(() => toast('Jev will do that without asking from now on.')).catch(error => toast(error.message, true));
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
  try { await api(`/specialists/${agent.id}`, { method: 'PUT', data: { profile: event.target.value } }); toast(event.target.value ? `${agent.name} now uses that Claude account.` : `${agent.name} uses the same account as everyone.`); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
});
// Forms inside popups are handled by their buttons; pressing Enter never reloads the page.
document.addEventListener('submit', event => { if (event.target.closest?.('.settings-pop,.acct-dialog,.vdialog,.src-dialog')) event.preventDefault(); });

// The MCP servers and skills an agent has, in its profile panel.
function toolsHtml(id) {
  const tools = ui.tools?.[id];
  if (!tools || tools.loading) { ui.tools = ui.tools || {}; if (!tools) { ui.tools[id] = { loading: true, skills: [], commands: [], mcp: [] }; void api(`/agents/tools?agent=${encodeURIComponent(id)}`).then(found => { ui.tools[id] = found; renderAll(); }).catch(() => {}); } return '<h3>Tools</h3><p class="muted small">Checking…</p>'; }
  const server = item => `<li><span class="tl-type ${esc(item.type)}">${esc(item.type === 'stdio' ? 'local' : item.type)}</span><b>${esc(item.name)}</b><small>${esc(item.where || '')}${item.source ? ` · ${esc(item.source === 'account' ? 'from the Claude account' : item.source === 'project' ? 'from the project' : item.source)}` : ''}</small></li>`;
  const skills = [...(tools.commands || []), ...(tools.skills || [])];
  return `<h3>Tools (MCP) <span>${tools.mcp.length}</span></h3><ul class="tl-list">${tools.mcp.map(server).join('')}</ul>
    <details class="tl-skills"><summary><h3>Skills and commands <span>${skills.length}</span></h3></summary><ul class="tl-list">${skills.map(item => `<li><b>/${esc(item.name)}</b><small>${esc(item.description || '')}</small></li>`).join('') || '<li class="muted small">None.</li>'}</ul></details>
    <p class="muted small">Type / in the message box to use one.</p>`;
}

// ---------- a sign-in an agent needs: open a terminal running the command, sign in, say done ----------
function signInCard(item) {
  const run = runById(item.runId), opened = ui.signInOpened?.has(item.id);
  return `<div class="card ask scard" data-signin="${esc(item.id)}"><div class="qhead"><span class="qdot"></span>Sign-in needed · ${esc(runTitle(run))}</div>
    <div class="qtext md">${markdown(String(item.title || ''))}</div>
    <div class="scmd"><code>${esc(item.request?.command || '')}</code></div>
    <p class="fnote">Opens a terminal on this computer running this command. Sign in there; the tool keeps the sign-in on this computer, so every agent can use it.</p>
    <div class="row"><button type="button" class="send-btn wide" data-signin-open>${opened ? 'Open the terminal again' : 'Open terminal'}</button><button type="button" class="btn small ${opened ? 'primary' : ''}" data-signin-done>I'm signed in</button><button type="button" class="btn small" data-signin-skip>Not now</button></div></div>`;
}
document.addEventListener('click', async event => {
  const card = event.target.closest?.('[data-signin]'); if (!card) return;
  const id = card.dataset.signin;
  try {
    if (event.target.closest('[data-signin-open]')) { await api(`/interactions/${id}/terminal`, { method: 'POST', data: {} }); (ui.signInOpened ||= new Set()).add(id); toast('Terminal opened. Sign in there, then press "I\'m signed in".'); renderAll(); }
    else if (event.target.closest('[data-signin-done]')) { await api(`/interactions/${id}/answer`, { method: 'POST', data: { action: 'accept', content: {} } }); toast('Thanks. The agent checks the sign-in and goes on.'); await refresh(); }
    else if (event.target.closest('[data-signin-skip]')) { await api(`/interactions/${id}/answer`, { method: 'POST', data: { action: 'decline' } }); await refresh(); }
  } catch (error) { toast(error.message, true); }
});

// ---------- phone: the list screen's tab bar ----------
function phone() { return window.matchMedia('(max-width:760px)').matches; }
function phoneTabs(asks) {
  const ic = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const tab = (attrs, label, icon, on = false, badge = 0) => `<button type="button" ${attrs} class="${on ? 'on' : ''}">${icon}${badge ? `<span class="tb-badge">${badge}</span>` : ''}<span>${label}</span></button>`;
  return `<nav class="m-tabs" aria-label="Sections">
    ${tab('data-action="m-top"', 'Chats', ic('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'), true)}
    ${tab('data-open="inbox" data-id=""', 'Needs you', ic('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'), false, asks)}
    ${tab('data-open="tasks" data-id=""', 'Tasks', ic('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>'))}
    ${tab('data-open="jev" data-id=""', 'Jev', ic('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'))}
    ${tab('data-action="settings-open"', 'Settings', ic('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'))}
  </nav>`;
}
document.addEventListener('click', event => { if (!event.target.closest?.('[data-action="m-top"]')) return; event.stopPropagation(); document.querySelector('.rail-scroll')?.scrollTo({ top: 0, behavior: 'smooth' }); }, true);

document.addEventListener('change', async event => {
  if (!event.target.matches?.('[data-mo-auto]')) return;
  try { await api('/config', { method: 'PUT', data: { ...ui.snap.config, autoFree: event.target.checked } }); toast(event.target.checked ? 'Rex Desk frees memory by itself when it runs low.' : 'Automatic freeing is off.'); await refresh(); } catch (error) { toast(error.message, true); }
});

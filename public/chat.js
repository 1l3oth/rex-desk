import { agentStage, agentAction, agentGroups, initAgentCard, toggleGroup } from '/chat-agents.js';
import { stepsHtml, terminalItems, terminalHtml } from '/chat-activity.js';
import { markdown } from '/chat-markdown.js';
import { initPickers, setPickActions, pickerOpen } from '/chat-pick.js';
import { roomStage, newRoomDialog as openRoomDialog, tasksStage, taskStage, roomAction, initRoomInfo, avatarHtml, roomRunIds } from '/chat-rooms.js';
import { composerHtml, initComposer, pickedOptions, attachmentText, redrawAttachments } from '/chat-composer.js';
// Rex Desk, chat first. One conversation at a time: the main agent, an agent run, a room of agents, or what needs you.
const app = document.getElementById('app');
// Which screen is open lives in the address (#/room/ID) and is also saved, so a refresh or a restart comes back to the same place.
const SCREENS = ['main', 'inbox', 'room', 'run', 'specialist', 'task', 'tasks', 'project', 'person'];
const hashOf = view => `#/${view.type}${view.id ? `/${encodeURIComponent(view.id)}` : ''}`;
function viewFromHash() { const match = /^#\/([a-z]+)(?:\/(.+))?$/.exec(location.hash); return match && SCREENS.includes(match[1]) ? { type: match[1], id: match[2] ? decodeURIComponent(match[2]) : '' } : null; }
function savedView() { try { const view = JSON.parse(localStorage.getItem('rex-desk-view') || 'null'); return view && SCREENS.includes(view.type) ? { type: view.type, id: String(view.id || '') } : null; } catch { return null; } }
const ui = { snap: null, view: viewFromHash() || savedView() || { type: 'main' }, events: new Map(), memory: null, page: '', menu: null, done: false, drafts: new Map(), stick: true, attachments: [], openSteps: new Map(), termOpen: true, qstep: new Map(), qanswers: new Map() };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const hhmm = value => { const date = new Date(value); return Number.isNaN(+date) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const ago = value => { const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 60000)); return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`; };
const provider = name => name === 'codex' ? 'Codex (retired)' : name === 'claude' ? 'Claude Code' : 'Agent';
const ctx = { get ui() { return ui; }, api, esc, toast, refresh, open, railItem, markdown, mainRun: () => mainRun(), runById: id => runById(id), draftKey: () => draftKey(), send: () => send(),
  bubble: args => bubble(args), note: text => note(text), typing: (name, caption) => typing(name, caption), hhmm: value => hhmm(value),
  render: () => renderAll(), avatar: args => avatarHtml(ctx, args), pending: runId => pending(runId), decisionCard: item => decisionCard(item),
  commands: { assign: () => { const box = document.getElementById('draft'); if (box) { box.value = '/assign '; ui.drafts.set(draftKey(), box.value); box.focus(); } }, sync: () => syncIssues().catch(error => toast(error.message, true)), projects: () => scanProjects().catch(error => toast(error.message, true)), room: () => newRoomDialog(), agent: () => agentAction(ctx, 'spec-new'), main: () => open('main'), stop: () => stopAgent().catch(error => toast(error.message, true)), settings: () => { location.href = '/classic'; } }, get initials() { return initials; } };
const initials = text => (String(text).match(/[\p{L}\p{N}]/gu) || ['?']).slice(0, 2).join('').toUpperCase();

async function api(path, { method = 'GET', data, retry = false } = {}) {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json().catch(() => ({}));
  // With accounts, a workspace that stays signed in hands this window its cookie through /api/auth; otherwise the window signs in first.
  if (response.status === 401 && body.signIn) {
    const auth = retry ? null : await fetch('/api/auth', { headers: { 'x-rex-desk': '1' } }).then(reply => reply.json()).catch(() => null);
    if (auth?.current) return api(path, { method, data, retry: true });
    location.href = '/classic'; throw new Error('Sign in to Rex Desk.');
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
function railItem(type, id, { dot = '', avatar = '', name, sub = '', badge = 0, warn = false }) {
  const active = ui.view.type === type && (ui.view.id || '') === (id || '');
  return `<button class="item ${active ? 'active' : ''}" data-open="${type}" data-id="${esc(id || '')}">${avatar || (dot ? `<span class="dot ${dot}"></span>` : '')}<span class="name">${esc(name)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>${badge ? `<span class="badge ${warn ? 'warn' : ''}">${badge}</span>` : ''}</button>`;
}
// Sidebar pieces: an icon or a picture for every row, a status dot on agents, and sections that fold and remember it.
const SVG = {
  main: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8l5.6-.8z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  person: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/></svg>',
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
const agentDot = state => ({ busy: 'working', replying: 'working', waiting: 'warn', idle: 'good' })[state] || '';

function renderRail() {
  const snap = ui.snap, runs = snap.runs.filter(run => run.role !== 'coordinator' && run.role !== 'specialist' && !run.setupSourceId), asks = pending().length;
  const group = name => runs.filter(run => stateGroup(run) === name);
  const line = run => railItem('run', run.id, { avatar: withDot(iconAv('run'), stateTone(run)), name: runTitle(run), sub: `${stateLabel(run)} · ${ago(run.updatedAt || run.createdAt)}`, badge: pending(run.id).length, warn: true });
  const main = mainRun(), agents = snap.specialists || [], tasks = (snap.tasks || []).filter(task => task.active && !task.demo), busy = agents.filter(agent => agent.status?.state === 'busy').length;
  const working = group('working'), review = group('review'), done = group('done'), shownDone = ui.done ? done : done.slice(0, 4);
  const plus = (action, label) => `<button class="sec-add" data-action="${action}" title="${label}" aria-label="${label}">+</button>`;
  return `<div class="rail-head"><span class="brand">${iconAv('main', 'brandmark')}<strong>Rex Desk</strong></span><span class="spacer"></span><button class="btn small" data-action="sync" title="Sync issues from the tracker">Sync</button></div><div class="rail-scroll">
    <div class="sec-body top">
      ${railItem('main', '', { avatar: withDot(iconAv('main', 'accent'), main ? stateTone(main) : ''), name: 'Rex Agent', sub: main ? stateLabel(main) : 'Not started' })}
      ${railItem('inbox', '', { avatar: iconAv('inbox', asks ? 'warn' : ''), name: 'Needs you', sub: asks ? `${asks} waiting` : 'Nothing waiting', badge: asks, warn: true })}
      ${railItem('person', '', { avatar: ui.profile?.photo ? `<img class="av sm photo" src="${photoUrl()}" alt="">` : iconAv('person'), name: 'About you', sub: ui.profile?.name || 'What the agents learned' })}
    </div>
    ${section('rooms', 'Rooms', snap.rooms.length, plus('new-room', 'New room'), snap.rooms.length ? snap.rooms.map(room => railItem('room', room.id, { avatar: withDot(avatarHtml(ctx, { name: room.name, image: room.image, id: room.id, at: room.imageAt || '', size: 'sm' }), room.members.some(member => member.state === 'replying' || member.state === 'busy') ? 'working' : ''), name: room.name, sub: `${room.members.length} agents` })).join('') : '<p class="rail-empty">No rooms yet.</p>')}
    ${section('agents', 'Agents', agents.length, plus('spec-new', 'New agent'), agents.length ? agentGroups(ctx, agents, (agent, grouped) => railItem('specialist', agent.id, { avatar: withDot(avatarHtml(ctx, { name: agent.name, size: 'sm' }), agentDot(agent.status?.state)), name: agent.name, sub: grouped ? agent.status?.label || 'Idle' : `${agent.status?.state === 'idle' || !agent.status ? agent.projectSlug : agent.status.label}` })) : '<p class="rail-empty">No agents yet. Press + to create one.</p>')}
    ${section('tasks', 'Tasks', tasks.length, '', railItem('tasks', '', { avatar: iconAv('tasks'), name: 'All tasks', sub: busy ? `${busy} being worked on` : `${tasks.length} issues` }))}
    ${working.length || review.length || done.length ? section('runs', 'Runs', working.length || '', '', `${working.map(line).join('')}${review.length ? `<p class="rail-label">To review</p>${review.map(line).join('')}` : ''}${done.length ? `<p class="rail-label">Done</p>${shownDone.map(line).join('')}${done.length > 4 ? `<button class="item more" data-action="toggle-done"><span class="name sub">${ui.done ? 'Show fewer' : `Show all ${done.length}`}</span></button>` : ''}` : ''}`) : ''}
  </div><div class="rail-foot"><a href="/classic">Issues &amp; settings</a><button class="btn small" data-action="theme">Theme</button></div>`;
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
      : item.role === 'human' ? bubble({ mine: true, name: 'You', time: hhmm(item.at), html: markdown(item.text) })
      : item.role === 'agent' ? bubble({ name: provider(run.provider), time: hhmm(item.at), html: markdown(item.text) })
      : item.role === 'error' ? `<div class="card bad"><h4>Needs attention</h4><div class="md">${markdown(item.text)}</div></div>`
      : note(`${esc(item.text)} · ${hhmm(item.at)}`));
  }
  flush(true);
  return out.join('');
}
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
function transcript(events) {
  const items = [], results = new Map(events.filter(event => event.kind === 'agent-tool-result').map(event => [event.id, event]));
  for (const event of events) {
    if (['command-output', 'dev-output'].includes(event.kind)) continue;
    if (event.kind === 'human-message') items.push({ role: 'human', text: event.text, at: event.createdAt });
    else if (event.kind === 'turn-start') items.push({ role: 'status', text: `${event.resumed ? 'Resumed' : 'Started'} with ${provider(event.provider)}`, at: event.createdAt });
    else if (event.kind === 'agent-result') items.push({ role: 'status', text: `Turn ended${event.subtype && event.subtype !== 'success' ? ` · ${event.subtype}` : ''}${event.cost ? ` · $${Number(event.cost).toFixed(2)}` : ''}`, at: event.createdAt });
    else if (event.kind === 'message' || event.kind === 'agent-text') items.push({ role: 'agent', text: event.text || event.message || '', at: event.createdAt });
    else if (event.kind === 'agent-tool' && ['desk_ask', 'desk_message', 'desk_elicit'].includes(event.tool)) continue; // shown as chat messages already
    else if (event.kind === 'agent-tool-result') continue;
    else if (event.kind === 'agent-tool') items.push({ role: 'tool', id: event.id, output: results.get(event.id), tool: event.tool, input: event.input, failed: event.failed, text: event.text, at: event.createdAt });
    else if (event.kind === 'error') items.push({ role: 'error', text: event.text || event.message || 'The run needs attention.', at: event.createdAt });
    else if (event.visible) items.push({ role: 'status', text: event.text || event.message || event.kind.replaceAll('-', ' '), at: event.createdAt });
  }
  return items;
}
const bubble = ({ mine, name, time, html }) => `<div class="msg ${mine ? 'mine' : ''}"><div class="avatar">${esc(initials(name))}</div><div class="bubble"><div class="who"><strong>${esc(name)}</strong><span>${esc(time)}</span></div><div class="md">${html}</div></div></div>`;
const typing = (name, caption = '') => `<div class="msg" aria-live="polite" aria-label="${esc(name)} is typing"><div class="avatar">${esc(initials(name))}</div><div class="bubble typing"><span class="dots"><i></i><i></i><i></i></span>${caption ? `<span class="cap">${esc(caption)}</span>` : ''}</div></div>`;
const note = text => `<div class="note">${text}</div>`;
// Runs that are over. Any other run that is not working can still be closed, so a stuck run never blocks its task.
const FINISHED = ['ready_for_review', 'published', 'failed', 'stopped', 'interrupted', 'finished', 'qa_passed', 'qa_failed', 'qa_blocked'];
function decisionCard(item) {
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
  if (type === 'person') return { title: 'About you', meta: 'Your profile, from what the agents learned', feed: personPage() };
  if (type === 'project') {
    return { title: id, meta: 'Project memory', feed: `<div class="page"><div class="row"><button class="btn primary small" data-action="spec-new">Create agent for this project</button></div><div class="card"><div class="md">${markdown(ui.page || 'Loading…')}</div></div></div>` };
  }
  const run = type === 'main' ? mainRun() : runById(id);
  if (!run && type === 'main') return welcomeStage();
  if (!run) return emptyStage('That run is gone.');
  const items = [...transcript(ui.events.get(run.id) || []), ...(ui.snap.interactions || []).filter(item => item.runId === run.id && item.state !== 'pending').flatMap(answeredItem)].sort((left, right) => String(left.at).localeCompare(String(right.at))), live = ['starting', 'running'].includes(run.state);
  const feed = (items.length ? renderItems(items, run, live) : `<div class="empty"><h2>${esc(runTitle(run))}</h2><p>${ui.events.has(run.id) ? 'Nothing recorded yet.' : 'Loading the conversation…'}</p></div>`)
    + pending(run.id).map(item => `<div class="msg qfloat"><div class="avatar">${esc(initials(provider(run.provider)))}</div>${decisionCard(item)}</div>`).join('') + (live ? typing(provider(run.provider), run.state === 'starting' ? 'Preparing…' : '') : '');
  const shells = terminalItems(items), stop = (shells.length && !ui.termOpen ? `<button class="btn small" data-action="term-open">Terminal (${shells.length})</button> ` : '') + (live || run.state === 'waiting' ? '<button class="btn small danger" data-action="stop">Stop</button>' : !FINISHED.includes(run.state) ? '<button class="btn small danger" data-action="stop" title="This run is not working. Close it so the task can get a new run.">Close run</button>' : '');
  return { title: runTitle(run), meta: `${provider(run.provider)}${run.branch ? ` · ${run.branch}` : ''}`, chips: `<span class="chip ${stateTone(run)}">${esc(stateLabel(run))}</span>`, actions: stop, feed, side: shells.length && ui.termOpen ? terminalHtml(shells, { esc, hhmm }) : '',
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
  const head = `<div class="stage-head"><h1>${esc(model.title)}</h1><span class="meta">${esc(model.meta || '')}</span>${model.chips || ''}<span class="spacer"></span>${model.actions || ''}</div>`;
  if (full || !document.getElementById('feed')) {
    stage.innerHTML = `<div class="stage-main"><div><div id="head">${head}</div><div id="members">${model.members || ''}</div></div><div class="feed" id="feed"><div class="feed-inner" id="feed-inner"></div></div>${model.composer ? composerHtml(ctx, model) : '<div></div>'}</div><aside class="side" id="side"></aside>`;
    ui.stick = true; redrawAttachments(ctx);
  } else { document.getElementById('head').innerHTML = head; const slot = document.getElementById('members'); if (!slot.contains(document.activeElement) && !pickerOpen()) slot.innerHTML = model.members || ''; }
  document.getElementById('feed').className = `feed ${model.feedClass || ''}`;
  drawSide(model.side || '', model.sideClass || '');
  const feed = document.getElementById('feed'), inner = document.getElementById('feed-inner');
  // Someone typing in an approval form keeps their text: the feed is not redrawn under them.
  // A form that is gone from the new view (it was answered) never holds the redraw back.
  const active = document.activeElement, form = active?.closest?.('[data-interaction]');
  const editing = !full && feed.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName) && (!form || model.feed.includes(`data-interaction="${form.dataset.interaction}"`));
  const choosing = pickerOpen();
  if (!editing && !choosing) { inner.innerHTML = model.feed; if (ui.stick) feed.scrollTop = feed.scrollHeight; }
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
  if (!ui.snap) return;
  if (!document.getElementById('rail')) app.innerHTML = '<div class="chat-shell"><aside class="rail" id="rail"></aside><main class="stage" id="stage"></main></div>';
  const rail = document.getElementById('rail'), scroll = rail.querySelector('.rail-scroll')?.scrollTop || 0;
  rail.innerHTML = renderRail(); const restored = rail.querySelector('.rail-scroll'); if (restored) restored.scrollTop = scroll;
  renderStage(full);
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
      if (room && ui.infoOpen !== false && ui.sideTab !== 'info') await Promise.all(roomRunIds(ui, room).map(async runId => ui.events.set(runId, await api(`/runs/${runId}/messages`).catch(() => []))));
    } else if (type === 'person') { ui.page = (await api('/memory/page?name=user')).text; }
    else if (type === 'project') ui.page = (await api(`/memory/page?name=${encodeURIComponent(id)}`)).text;
  } catch (error) { if (type === 'project') ui.page = error.message; }
}
let busy = false, again = false;
async function refresh({ full = false } = {}) {
  if (busy) { again = true; return; } busy = true;
  try {
    ui.snap = await api('/state'); ui.memory = await api('/memory').catch(() => ui.memory); ui.profile = await api('/profile').catch(() => ui.profile);
    await loadView(); renderAll(full);
  } finally { busy = false; if (again) { again = false; void refresh(); } }
}
function open(type, id = '') {
  ui.view = { type, id }; ui.page = '';
  try { localStorage.setItem('rex-desk-view', JSON.stringify(ui.view)); } catch { /* private window */ }
  if (location.hash !== hashOf(ui.view)) { ui.fromOpen = true; location.hash = hashOf(ui.view); } document.querySelector('.chat-shell')?.classList.remove('show-rail'); void refresh({ full: true }); }

// ---------- actions ----------
async function send() {
  const box = document.getElementById('draft'), typed = box?.value.trim(), hasFiles = ui.attachments.some(file => file.path);
  if (!typed && !hasFiles) return;
  if (ui.attachments.some(file => !file.path)) return toast('Wait for the upload to finish.', true);
  const text = `${typed || 'See the attached files.'}${attachmentText(ctx)}`, picked = pickedOptions(ctx);
  const { type, id } = ui.view; box.disabled = true;
  try {
    if (type === 'room' && /^\/assign\b/i.test(typed)) await assignFromRoom(id, typed);
    else if (type === 'room') await api(`/rooms/${id}/messages`, { method: 'POST', data: { text } });
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
  const room = ui.snap.rooms.find(item => item.id === roomId), handle = /@([\p{L}\p{N}_.-]+)/u.exec(command)?.[1]?.toLowerCase(), number = /#(\d{2,})/.exec(command)?.[1];
  const member = room?.members.find(item => item.handle.toLowerCase() === handle || item.name.toLowerCase() === handle), task = (ui.snap.tasks || []).find(item => String(item.taskNumber) === number || String(item.externalId) === number);
  if (!member) throw new Error('Name an agent in this room: /assign @agent #task');
  if (!task) throw new Error('Name a task by its number: /assign @agent #49760');
  await api(`/specialists/${member.id}/assign`, { method: 'POST', data: { taskId: task.id, roomId } });
  toast(`${member.name} is on it.`);
}
async function syncIssues() { toast('Syncing issues…'); await api('/sync', { method: 'POST', data: {} }); toast('Issues synced.'); await refresh(); }
async function scanProjects() { toast('Scanning this computer for projects…'); const result = await api('/memory/scan', { method: 'POST', data: {} }); toast(`Found ${result.count} projects.`); await refresh(); }
async function stopAgent() { const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); if (!run) return toast('No agent to stop here.', true); await api(`/runs/${run.id}/stop`, { method: 'POST', data: {} }); await refresh(); }
function newRoomDialog() { openRoomDialog(ctx); }
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-open],[data-action]'); if (!target) return;
  if (target.dataset.open) { event.preventDefault(); return open(target.dataset.open, target.dataset.id); }
  const action = target.dataset.action;
  try {
    if (action?.startsWith('spec-')) await agentAction(ctx, action, target);
    else if (action === 'send') await send();
    else if (action === 'new-room') newRoomDialog();
    else if (action === 'term-close') { ui.termOpen = false; renderAll(); }
    else if (action === 'term-open') { ui.termOpen = true; renderAll(); }
    else if (['room-remove', 'task-assign', 'info-toggle', 'room-image', 'room-delete', 'side-tab'].includes(action)) await roomAction(ctx, action, target);
    else if (action === 'brain-setup') { const found = ui.snap.memory?.brainCandidates?.[0]; const text = `Help me set up my second brain for all agents.${found ? ` I think it is at ${found}.` : ''} Ask me how I want you to use it.`; if (mainRun()) await api(`/runs/${mainRun().id}/${workingStates.includes(mainRun().state) ? 'say' : 'resume'}`, { method: 'POST', data: workingStates.includes(mainRun().state) ? { text } : { prompt: text } }); else await api('/main', { method: 'POST', data: { prompt: text } }); open('main'); }
    else if (action === 'quick') { await api('/main', { method: 'POST', data: { prompt: target.dataset.text } }); await refresh(); }
    else if (action === 'sync') await syncIssues();
    else if (action === 'toggle-done') { ui.done = !ui.done; renderAll(); }
    else if (action === 'sec-toggle') toggleSection(target.dataset.sec);
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

initPickers(ctx); initRoomInfo(ctx); initAgentCard(ctx);
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
  stream.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(() => void refresh().catch(() => {}), 300); });
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
const photoUrl = () => `/api/profile/photo?v=${encodeURIComponent(ui.profile?.photo?.updatedAt || '')}`;
const noteText = item => { const match = /^(.*?)\s+\((\d{4}-\d{2}-\d{2})(, may change)?\)$/.exec(item); return match ? { text: match[1], when: match[2], soft: Boolean(match[3]) } : { text: item, when: '', soft: false }; };
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
  const card = section => `<div class="pf-card"><h3>${esc(section.title)}</h3><ul>${section.items.map(noteText).map(item => `<li>${esc(item.text)}${item.when ? ` <small class="muted">${item.when}${item.soft ? ' · may change' : ''}</small>` : ''}</li>`).join('')}</ul></div>`;
  const notes = others.length ? `<section><h3 class="pf-title">What your agents learned about you</h3><div class="pf-grid">${others.map(card).join('')}</div></section>` : '';
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

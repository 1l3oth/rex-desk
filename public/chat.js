import { agentsRail, agentStage, agentAction } from '/chat-agents.js';
import { stepsHtml, terminalItems, terminalHtml } from '/chat-activity.js';
import { markdown } from '/chat-markdown.js';
import { roomStage, newRoomDialog as openRoomDialog, tasksStage, taskStage, roomAction } from '/chat-rooms.js';
import { composerHtml, initComposer, pickedOptions, attachmentText, redrawAttachments } from '/chat-composer.js';
// Rex Desk, chat first. One conversation at a time: the main agent, an agent run, a room of agents, or what needs you.
const app = document.getElementById('app');
const ui = { snap: null, view: { type: 'main' }, events: new Map(), memory: null, page: '', menu: null, done: false, drafts: new Map(), stick: true, attachments: [], openSteps: new Map(), termOpen: true };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const hhmm = value => { const date = new Date(value); return Number.isNaN(+date) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const ago = value => { const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 60000)); return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`; };
const provider = name => name === 'codex' ? 'Codex (retired)' : name === 'claude' ? 'Claude Code' : 'Agent';
const ctx = { get ui() { return ui; }, api, esc, toast, refresh, open, railItem, markdown, mainRun: () => mainRun(), runById: id => runById(id), draftKey: () => draftKey(), send: () => send(),
  bubble: args => bubble(args), note: text => note(text), typing: (name, caption) => typing(name, caption), hhmm: value => hhmm(value),
  commands: { assign: () => { const box = document.getElementById('draft'); if (box) { box.value = '/assign '; ui.drafts.set(draftKey(), box.value); box.focus(); } }, sync: () => syncIssues().catch(error => toast(error.message, true)), projects: () => scanProjects().catch(error => toast(error.message, true)), room: () => newRoomDialog(), agent: () => agentAction(ctx, 'spec-new'), main: () => open('main'), stop: () => stopAgent().catch(error => toast(error.message, true)), settings: () => { location.href = '/classic'; } }, get initials() { return initials; } };
const initials = text => (String(text).match(/[\p{L}\p{N}]/gu) || ['?']).slice(0, 2).join('').toUpperCase();

async function api(path, { method = 'GET', data } = {}) {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json().catch(() => ({}));
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
const mainRun = () => ui.snap.runs.find(run => run.role === 'coordinator');
// A run on a task is named by the task's English name, whatever language the tracker used.
const runTitle = run => { const task = run?.taskId ? ui.snap?.tasks?.find(item => item.id === run.taskId) : null; return task?.titleEn || run?.title || run?.branch || `Run ${String(run?.id || '').slice(0, 8)}`; };
const roomById = id => ui.snap.rooms.find(room => room.id === id);

// ---------- rail ----------
function railItem(type, id, { dot = '', name, sub = '', badge = 0, warn = false }) {
  const active = ui.view.type === type && (ui.view.id || '') === (id || '');
  return `<button class="item ${active ? 'active' : ''}" data-open="${type}" data-id="${esc(id || '')}">${dot ? `<span class="dot ${dot}"></span>` : ''}<span class="name">${esc(name)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>${badge ? `<span class="badge ${warn ? 'warn' : ''}">${badge}</span>` : ''}</button>`;
}
function renderRail() {
  const snap = ui.snap, runs = snap.runs.filter(run => run.role !== 'coordinator' && run.role !== 'specialist' && !run.setupSourceId), asks = pending().length;
  const group = name => runs.filter(run => stateGroup(run) === name);
  const line = run => railItem('run', run.id, { dot: stateTone(run), name: runTitle(run), sub: `${provider(run.provider)} · ${stateLabel(run)} · ${ago(run.updatedAt || run.createdAt)}`, badge: pending(run.id).length, warn: true });
  const done = group('done'), shownDone = ui.done ? done : done.slice(0, 4), main = mainRun();
  const tasks = (snap.tasks || []).filter(task => task.active && !task.demo), busy = (snap.specialists || []).filter(agent => agent.status?.state === 'busy').length;
  return `<div class="rail-head"><span class="dot ${snap.syncing ? 'working' : 'good'}"></span><strong>Rex Desk</strong><span class="spacer"></span><button class="btn small" data-action="sync" title="Sync issues from the tracker">Sync</button></div><div class="rail-scroll">
    ${railItem('main', '', { dot: main ? stateTone(main) : '', name: 'Main agent', sub: main ? `${provider(main.provider)} · ${stateLabel(main)}` : 'Not started' })}
    ${railItem('inbox', '', { name: 'Needs you', sub: asks ? `${asks} waiting` : 'Nothing waiting', badge: asks, warn: true })}
    <h3>Rooms <button data-action="new-room" title="New room" aria-label="New room">+</button></h3>
    ${snap.rooms.length ? snap.rooms.map(room => railItem('room', room.id, { dot: room.members.some(member => member.state === 'replying' || member.state === 'busy') ? 'working' : '', name: room.name, sub: `${room.members.length} agents` })).join('') : '<p class="rail-empty">No rooms yet.</p>'}
    ${agentsRail(ctx)}
    <h3>Tasks</h3>
    ${railItem('tasks', '', { name: 'All tasks', sub: `${tasks.length} issues${busy ? ` · ${busy} being worked on` : ''}` })}
    ${['working', 'review'].map(name => { const list = group(name); return list.length ? `<h3>${name === 'working' ? 'Runs working' : 'Runs to review'} <span>${list.length}</span></h3>${list.map(line).join('')}` : ''; }).join('')}
    ${done.length ? `<h3>Runs done <span>${done.length}</span></h3>${shownDone.map(line).join('')}${done.length > 4 ? `<button class="item" data-action="toggle-done"><span class="name sub">${ui.done ? 'Show fewer' : `Show all ${done.length}`}</span></button>` : ''}` : ''}
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
function decisionCard(item) {
  const request = item.request || {}, run = runById(item.runId), properties = request.requestedSchema?.properties || {}, required = request.requestedSchema?.required || [];
  const field = (key, property, needed) => {
    const attrs = `name="${esc(key)}" data-type="${esc(property.type || 'string')}" ${needed ? 'required' : ''}`;
    const control = property.type === 'boolean' ? `<select ${attrs}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select>`
      : property.enum ? `<select ${attrs}><option value="">Choose…</option>${property.enum.map(value => `<option>${esc(value)}</option>`).join('')}<option value="__custom">Write another answer…</option></select><input class="qinput hidden" name="${esc(key)}__custom" placeholder="Your answer">`
      : `<input class="qinput" ${attrs} type="${['number', 'integer'].includes(property.type) ? 'number' : 'text'}" placeholder="Type your answer…" autocomplete="off">`;
    const options = (property.options || []).slice(0, 6);
    const suggestions = options.length ? `<div class="sugg" data-multi="${property.multiSelect ? 1 : 0}">${options.map((option, index) => `<button type="button" class="sugg-chip" data-fill="${esc(option.label)}"><span class="num">${index + 1}</span><span class="txt"><b>${esc(option.label)}</b>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span></button>`).join('')}<div class="sugg-other">Or type your own answer below</div></div>` : '';
    return `<label class="qfield"><span>${esc(property.title || key)}</span>${suggestions}${control}</label>`;
  };
  const fields = Object.entries(properties).map(([key, property]) => field(key, property, required.includes(key))).join('')
    + (request.questions || []).map(question => field(question.id || question.question, { type: 'string', title: question.question, options: question.options, multiSelect: question.multiSelect }, true)).join('');
  const many = (fields.match(/class="qfield"/g) || []).length;
  const ask = item.kind !== 'approval', detail = ask ? null : request.command || request.input || request;
  return `<form class="card ask qcard" data-interaction="${esc(item.id)}"><div class="qhead"><span class="qdot"></span>${ask ? (many > 1 ? `${many} questions` : 'Question') : 'Needs your OK'} · ${esc(runTitle(run))}</div><div class="qtext md">${markdown(String(item.title).replace(/mcp__[a-z0-9_]+?__/gi, ''))}</div>${detail ? `<pre>${esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 1500))}</pre>` : ''}${fields}
    <div class="row"><button class="send-btn wide" name="decision" value="accept">${ask ? (many > 1 ? 'Send answers' : 'Send') : 'Approve once'}</button>${request.allowAlways ? '<button class="btn small" name="decision" value="always" formnovalidate>Always allow for this run</button>' : ''}<button class="btn small" name="decision" value="decline" formnovalidate>${ask ? 'Skip' : 'Decline'}</button>${ask && many > 1 ? '<small class="qhint">Enter moves to the next answer · Ctrl+Enter sends</small>' : ''}</div></form>`;
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
  if (type === 'project') {
    return { title: id, meta: 'Project memory', feed: `<div class="page"><div class="row"><button class="btn primary small" data-action="spec-new">Create agent for this project</button></div><div class="card"><div class="md">${markdown(ui.page || 'Loading…')}</div></div></div>` };
  }
  const run = type === 'main' ? mainRun() : runById(id);
  if (!run && type === 'main') return welcomeStage();
  if (!run) return emptyStage('That run is gone.');
  const items = [...transcript(ui.events.get(run.id) || []), ...(ui.snap.interactions || []).filter(item => item.runId === run.id && item.state !== 'pending').flatMap(answeredItem)].sort((left, right) => String(left.at).localeCompare(String(right.at))), live = ['starting', 'running'].includes(run.state);
  const feed = (items.length ? renderItems(items, run, live) : `<div class="empty"><h2>${esc(runTitle(run))}</h2><p>${ui.events.has(run.id) ? 'Nothing recorded yet.' : 'Loading the conversation…'}</p></div>`)
    + pending(run.id).map(item => `<div class="msg"><div class="avatar">${esc(initials(provider(run.provider)))}</div>${decisionCard(item)}</div>`).join('') + (live ? typing(provider(run.provider), run.state === 'starting' ? 'Preparing…' : '') : '');
  const shells = terminalItems(items), stop = (shells.length && !ui.termOpen ? `<button class="btn small" data-action="term-open">Terminal (${shells.length})</button> ` : '') + (live || run.state === 'waiting' ? '<button class="btn small danger" data-action="stop">Stop</button>' : '');
  return { title: runTitle(run), meta: `${provider(run.provider)}${run.branch ? ` · ${run.branch}` : ''}`, chips: `<span class="chip ${stateTone(run)}">${esc(stateLabel(run))}</span>`, actions: stop, feed, side: shells.length && ui.termOpen ? terminalHtml(shells, { esc, hhmm }) : '',
    working: workingStates.includes(run.state), composer: { placeholder: workingStates.includes(run.state) ? `Message ${provider(run.provider)}…` : (run.provider === 'codex' ? 'Message Claude Code. It takes over from Codex with the chat so far…' : `Message ${provider(run.provider)}. It picks up where it left off…`), mentions: [] } };
}
const quick = (label, text) => `<button class="chip-btn" data-action="quick" data-text="${esc(text)}">${esc(label)}</button>`;
const welcomeStage = () => ({ title: 'Rex', meta: 'Main agent',
  feed: `<div class="welcome"><div class="avatar big">RX</div><h2>Hi, I am Rex</h2><p>I get to know your projects, set up an agent for each one, and help you work through your issues. Pick a start, or just type.</p><div class="chips">${quick('Meet my projects', 'Meet my projects: go through them one by one, ask me what you are unsure about, and set up an agent for each.')}${quick('Triage my issues', 'Look at my assigned issues and tell me what to do first.')}${quick('What can you do?', 'What can you do for me here?')}</div></div>`,
  composer: { placeholder: 'Message Rex…', mentions: [] } });
const emptyStage = text => ({ title: 'Rex Desk', meta: '', feed: `<div class="empty"><h2>Nothing here</h2><p>${text}</p></div>` });

function renderStage(full) {
  const model = stageModel(), stage = document.getElementById('stage');
  const head = `<div class="stage-head"><h1>${esc(model.title)}</h1><span class="meta">${esc(model.meta || '')}</span>${model.chips || ''}<span class="spacer"></span>${model.actions || ''}</div>`;
  if (full || !document.getElementById('feed')) {
    stage.innerHTML = `<div class="stage-main"><div><div id="head">${head}</div><div id="members">${model.members || ''}</div></div><div class="feed" id="feed"><div class="feed-inner" id="feed-inner"></div></div>${model.composer ? composerHtml(ctx, model) : '<div></div>'}</div><aside class="side" id="side"></aside>`;
    ui.stick = true; redrawAttachments(ctx);
  } else { document.getElementById('head').innerHTML = head; const slot = document.getElementById('members'); if (!slot.contains(document.activeElement)) slot.innerHTML = model.members || ''; }
  document.getElementById('feed').className = `feed ${model.feedClass || ''}`;
  drawSide(model.side || '');
  const feed = document.getElementById('feed'), inner = document.getElementById('feed-inner');
  // Someone typing in an approval form keeps their text: the feed is not redrawn under them.
  // A form that is gone from the new view (it was answered) never holds the redraw back.
  const active = document.activeElement, form = active?.closest?.('[data-interaction]');
  const editing = !full && feed.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName) && (!form || model.feed.includes(`data-interaction="${form.dataset.interaction}"`));
  if (!editing) { inner.innerHTML = model.feed; if (ui.stick) feed.scrollTop = feed.scrollHeight; }
  ui.mentions = model.composer?.mentions || [];
}
// The terminal panel keeps its scroll place unless it was at the bottom, where it follows the newest command.
function drawSide(html) {
  const side = document.getElementById('side'); if (!side) return;
  const body = document.getElementById('side-body'), keep = body ? { top: body.scrollTop, bottom: body.scrollHeight - body.scrollTop - body.clientHeight < 40 } : { top: 0, bottom: true };
  if (side.dataset.html !== html) { side.innerHTML = html; side.dataset.html = html; }
  side.classList.toggle('on', Boolean(html));
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
    } else if (type === 'project') ui.page = (await api(`/memory/page?name=${encodeURIComponent(id)}`)).text;
  } catch (error) { if (type === 'project') ui.page = error.message; }
}
let busy = false, again = false;
async function refresh({ full = false } = {}) {
  if (busy) { again = true; return; } busy = true;
  try {
    ui.snap = await api('/state'); ui.memory = await api('/memory').catch(() => ui.memory);
    await loadView(); renderAll(full);
  } finally { busy = false; if (again) { again = false; void refresh(); } }
}
function open(type, id = '') { ui.view = { type, id }; ui.page = ''; document.querySelector('.chat-shell')?.classList.remove('show-rail'); void refresh({ full: true }); }

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
    if (action?.startsWith('spec-')) await agentAction(ctx, action);
    else if (action === 'send') await send();
    else if (action === 'new-room') newRoomDialog();
    else if (action === 'term-close') { ui.termOpen = false; renderAll(); }
    else if (action === 'term-open') { ui.termOpen = true; renderAll(); }
    else if (action === 'room-remove' || action === 'task-assign') await roomAction(ctx, action, target);
    else if (action === 'quick') { await api('/main', { method: 'POST', data: { prompt: target.dataset.text } }); await refresh(); }
    else if (action === 'sync') await syncIssues();
    else if (action === 'toggle-done') { ui.done = !ui.done; renderAll(); }
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
  const first = form.querySelector('.sugg'), chip = first?.querySelectorAll('.sugg-chip')[Number(event.key) - 1]; if (!chip) return;
  event.preventDefault(); chip.click();
});
// A suggested answer fills its box; a multi-select question collects several.
document.addEventListener('click', event => {
  const chip = event.target.closest?.('.sugg-chip'); if (!chip) return;
  event.preventDefault();
  const field = chip.closest('.qfield'), input = field.querySelector('.qinput'), multi = chip.parentElement.dataset.multi === '1', label = chip.dataset.fill;
  if (multi) { chip.classList.toggle('on'); input.value = [...chip.parentElement.querySelectorAll('.sugg-chip.on')].map(item => item.dataset.fill).join(', '); }
  else { for (const other of chip.parentElement.children) other.classList.toggle('on', other === chip); input.value = label; }
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
});
document.addEventListener('input', event => { if (event.target.id === 'task-filter') { ui.taskFilter = event.target.value; renderAll(); } });
document.addEventListener('toggle', event => { const group = event.target, key = group?.dataset?.steps !== undefined ? group.dataset.steps : group?.dataset?.term !== undefined ? `term:${group.dataset.term}` : null; if (key !== null) ui.openSteps.set(key, group.open); }, true);
document.addEventListener('keydown', event => {
  const input = event.target.closest?.('.qinput'); if (!input || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  const form = input.closest('form'), all = [...form.querySelectorAll('.qinput:not(.hidden)')], next = all[all.indexOf(input) + 1];
  event.preventDefault();
  if (next && !event.ctrlKey) next.focus(); else form.requestSubmit(form.querySelector('[value=accept]'));
});
try {
  await refresh({ full: true });
  const stream = new EventSource('/api/events'); let timer;
  stream.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(() => void refresh().catch(() => {}), 300); });
  setInterval(() => void refresh().catch(() => {}), 15000);
} catch (error) { app.innerHTML = `<div class="boot"><h2>Rex Desk is unavailable</h2><p>${esc(error.message)}</p><p>Start it with <code>npm start</code>, then reload.</p></div>`; }

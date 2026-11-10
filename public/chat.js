import { agentsRail, agentStage, agentAction } from '/chat-agents.js';
// Rex Desk, chat first. One conversation at a time: the main agent, an agent run, a room of agents, or what needs you.
const app = document.getElementById('app');
const ui = { snap: null, view: { type: 'main' }, events: new Map(), memory: null, page: '', menu: null, done: false, drafts: new Map(), stick: true };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const hhmm = value => { const date = new Date(value); return Number.isNaN(+date) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const ago = value => { const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 60000)); return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`; };
const provider = name => name === 'codex' ? 'Codex (retired)' : name === 'claude' ? 'Claude Code' : 'Agent';
const ctx = { get ui() { return ui; }, api, esc, toast, refresh, open, railItem, markdown, get initials() { return initials; } };
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

// A safe markdown subset: escape first, then restore fenced code, inline code, bold and links.
function markdown(text, { mentions = [] } = {}) {
  const parts = String(text ?? '').split(/```[^\n]*\n?/);
  return parts.map((part, index) => {
    if (index % 2) return `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`;
    let html = esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/^(\s*)[-*] /gm, '$1• ');
    for (const name of mentions) html = html.replace(new RegExp(`(^|\\s)@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_.-])`, 'giu'), '$1<span class="mention">@' + esc(name) + '</span>');
    return html;
  }).join('');
}

const workingStates = ['starting', 'running', 'queued', 'waiting', 'verifying'];
const reviewStates = ['ready_for_review', 'needs_evidence', 'qa_passed', 'qa_failed', 'qa_blocked', 'published'];
const stateGroup = run => workingStates.includes(run.state) ? 'working' : reviewStates.includes(run.state) ? 'review' : 'done';
const stateTone = run => ({ working: 'working', review: 'warn' })[stateGroup(run)] || (['failed', 'interrupted'].includes(run.state) ? 'bad' : 'good');
const stateLabel = run => ({ starting: 'Preparing', queued: 'Queued', running: 'Working', waiting: 'Needs you', verifying: 'Verifying', ready_for_review: 'Ready for review', needs_evidence: 'Needs evidence', published: 'PR created', failed: 'Failed', interrupted: 'Interrupted', stopped: 'Stopped', finished: 'Finished' }[run.state] || String(run.state || '').replaceAll('_', ' '));
const pending = runId => (ui.snap?.interactions || []).filter(item => item.state === 'pending' && (!runId || item.runId === runId));
const runById = id => ui.snap.runs.find(run => run.id === id);
const mainRun = () => ui.snap.runs.find(run => run.role === 'coordinator');
const runTitle = run => run?.title || run?.branch || `Run ${String(run?.id || '').slice(0, 8)}`;
const roomById = id => ui.snap.rooms.find(room => room.id === id);

// ---------- rail ----------
function railItem(type, id, { dot = '', name, sub = '', badge = 0, warn = false }) {
  const active = ui.view.type === type && (ui.view.id || '') === (id || '');
  return `<button class="item ${active ? 'active' : ''}" data-open="${type}" data-id="${esc(id || '')}">${dot ? `<span class="dot ${dot}"></span>` : ''}<span class="name">${esc(name)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>${badge ? `<span class="badge ${warn ? 'warn' : ''}">${badge}</span>` : ''}</button>`;
}
function renderRail() {
  const snap = ui.snap, runs = snap.runs.filter(run => run.role !== 'coordinator' && !run.setupSourceId), asks = pending().length + (snap.wakes || []).length;
  const group = name => runs.filter(run => stateGroup(run) === name);
  const line = run => railItem('run', run.id, { dot: stateTone(run), name: runTitle(run), sub: `${provider(run.provider)} · ${stateLabel(run)} · ${ago(run.updatedAt || run.createdAt)}`, badge: pending(run.id).length, warn: true });
  const done = group('done'), shownDone = ui.done ? done : done.slice(0, 6);
  const main = mainRun(), mem = ui.memory;
  return `<div class="rail-head"><span class="dot ${snap.syncing ? 'working' : 'good'}"></span><strong>Rex Desk</strong></div><div class="rail-scroll">
    ${railItem('main', '', { dot: main ? stateTone(main) : '', name: 'Main agent', sub: main ? `${provider(main.provider)} · ${stateLabel(main)}` : 'Not started' })}
    ${railItem('inbox', '', { name: 'Needs you', sub: asks ? `${asks} waiting` : 'Nothing waiting', badge: asks, warn: true })}
    <h3>Rooms <button data-action="new-room" title="New room" aria-label="New room">+</button></h3>
    ${snap.rooms.length ? snap.rooms.map(room => railItem('room', room.id, { name: room.name, sub: `${room.members.length} agents` })).join('') : '<p class="rail-empty">No rooms yet.</p>'}
    ${['working', 'review'].map(name => { const list = group(name); return list.length ? `<h3>${name === 'working' ? 'Working' : 'Review'} <span>${list.length}</span></h3>${list.map(line).join('')}` : ''; }).join('')}
    <h3>Done <span>${done.length}</span></h3>${shownDone.map(line).join('')}${done.length > 6 ? `<button class="item" data-action="toggle-done"><span class="name sub">${ui.done ? 'Show fewer' : `Show all ${done.length}`}</span></button>` : ''}
    ${agentsRail(ctx)}
    <h3>Projects <button data-action="scan" title="Scan this computer for projects" aria-label="Scan this computer">↻</button></h3>
    ${mem?.projects?.length ? mem.projects.map(project => railItem('project', project.slug, { name: project.slug, sub: project.purpose || 'no description' })).join('') : '<p class="rail-empty">Not scanned. Press ↻ to find your projects.</p>'}
  </div><div class="rail-foot"><a href="/classic">Issues &amp; settings</a><button class="btn small" data-action="theme">Theme</button></div>`;
}

// ---------- run conversation ----------
function transcript(events) {
  const items = [];
  for (const event of events) {
    if (['command-output', 'dev-output'].includes(event.kind)) continue;
    if (event.kind === 'human-message') items.push({ role: 'human', text: event.text, at: event.createdAt });
    else if (event.kind === 'turn-start') items.push({ role: 'status', text: `${event.resumed ? 'Resumed' : 'Started'} with ${provider(event.provider)}`, at: event.createdAt });
    else if (event.kind === 'agent-result') items.push({ role: 'status', text: `Turn ended${event.subtype && event.subtype !== 'success' ? ` · ${event.subtype}` : ''}${event.cost ? ` · $${Number(event.cost).toFixed(2)}` : ''}`, at: event.createdAt });
    else if (event.kind === 'message' || event.kind === 'agent-text') items.push({ role: 'agent', text: event.text || event.message || '', at: event.createdAt });
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
      : property.enum ? `<select ${attrs}><option value="">Choose…</option>${property.enum.map(value => `<option>${esc(value)}</option>`).join('')}<option value="__custom">Write another answer…</option></select><input class="hidden" name="${esc(key)}__custom" placeholder="Your answer">`
      : `<input ${attrs} type="${['number', 'integer'].includes(property.type) ? 'number' : 'text'}" placeholder="Your answer">`;
    return `<label><span>${esc(property.title || key)}</span>${control}</label>`;
  };
  const fields = Object.entries(properties).map(([key, property]) => field(key, property, required.includes(key))).join('')
    + (request.questions || []).map(question => field(question.id || question.question, { type: 'string', title: question.question, enum: question.options?.map(option => option.label) }, true)).join('');
  const detail = item.kind === 'approval' ? request.command || request.input || request : null;
  return `<form class="card ask" data-interaction="${esc(item.id)}"><h4>${item.kind === 'approval' ? 'Approve' : 'Question'} · ${esc(runTitle(run))}</h4><div>${esc(String(item.title).replace(/mcp__[a-z0-9_]+?__/gi, ''))}</div>${detail ? `<pre>${esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 1500))}</pre>` : ''}${fields}
    <div class="row"><button class="btn primary small" name="decision" value="accept">${item.kind === 'approval' ? 'Approve once' : 'Send answer'}</button>${request.allowAlways ? '<button class="btn small" name="decision" value="always" formnovalidate>Always allow for this run</button>' : ''}<button class="btn small" name="decision" value="decline" formnovalidate>Decline</button></div></form>`;
}
function wakeCard(wake) {
  const run = runById(wake.runId), room = roomById(wake.roomId);
  return `<div class="card ask"><h4>${esc(wake.from)} mentioned ${esc(runTitle(run))} in ${esc(room?.name || 'a room')}</h4><div class="md">${esc(wake.text)}</div><div class="row"><button class="btn primary small" data-action="wake-approve" data-id="${esc(wake.id)}">Wake it up</button><button class="btn small" data-action="wake-dismiss" data-id="${esc(wake.id)}">Dismiss</button></div></div>`;
}

// ---------- stage ----------
function stageModel() {
  const { type, id } = ui.view, snap = ui.snap;
  if (type === 'room') {
    const room = roomById(id); if (!room) return emptyStage('That room is gone.');
    const names = ['you', ...room.members.map(member => member.label)];
    const messages = (snap.messages || []).filter(message => message.roomId === id).sort((left, right) => left.seq - right.seq);
    const body = messages.length ? messages.map(message => message.from.type === 'system' ? note(esc(message.text))
      : bubble({ mine: message.from.type === 'human', name: message.from.label, time: hhmm(message.at), html: markdown(message.text, { mentions: names }) })).join('') : `<div class="empty"><h2>${esc(room.name)}</h2><p>Mention an agent with @ to talk to it. Agents answer only when they are mentioned.</p></div>`;
    const free = snap.runs.filter(run => run.role !== 'coordinator' && !room.members.some(member => member.runId === run.id) && stateGroup(run) !== 'done');
    return { title: room.name, meta: `${room.members.length} agents`, chips: '', head: '', composer: { placeholder: 'Message the room. Use @ to mention an agent…', mentions: names },
      members: `<div class="members">${room.members.map(member => `<span class="chip ${member.state === 'running' ? 'working' : ''}">${esc(member.label)} · ${esc(member.state)} <button class="btn small x" data-action="room-remove" data-id="${esc(member.runId)}" title="Remove">×</button></span>`).join('')}${free.length ? `<select data-action="room-add"><option value="">+ Add agent…</option>${free.map(run => `<option value="${esc(run.id)}">${esc(runTitle(run))}</option>`).join('')}</select>` : ''}</div>`,
      feed: `${body}${(snap.wakes || []).filter(wake => wake.roomId === id).map(wakeCard).join('')}` };
  }
  if (type === 'inbox') {
    const asks = pending(), wakes = snap.wakes || [];
    return { title: 'Needs you', meta: `${asks.length + wakes.length} waiting`, feed: asks.length + wakes.length ? asks.map(decisionCard).join('') + wakes.map(wakeCard).join('') : '<div class="empty"><h2>All clear</h2><p>Questions, approvals and wake-ups from your agents show up here.</p></div>' };
  }
  if (type === 'specialist') return agentStage(ctx);
  if (type === 'project') {
    return { title: id, meta: 'Project memory', feed: `<div class="page"><div class="row"><button class="btn primary small" data-action="spec-new">Create agent for this project</button></div><div class="card"><div class="md">${markdown(ui.page || 'Loading…')}</div></div></div>` };
  }
  const run = type === 'main' ? mainRun() : runById(id);
  if (!run) return emptyStage(type === 'main' ? 'The main agent has not started. Press Sync in Issues &amp; settings, or fire an issue, and it appears here.' : 'That run is gone.');
  const items = transcript(ui.events.get(run.id) || []), live = ['starting', 'running'].includes(run.state);
  const feed = (items.length ? items.map(item => item.role === 'human' ? bubble({ mine: true, name: 'You', time: hhmm(item.at), html: markdown(item.text) })
      : item.role === 'agent' ? bubble({ name: provider(run.provider), time: hhmm(item.at), html: markdown(item.text) })
      : item.role === 'error' ? `<div class="card bad"><h4>Needs attention</h4><div class="md">${markdown(item.text)}</div></div>`
      : note(`${esc(item.text)} · ${hhmm(item.at)}`)).join('') : `<div class="empty"><h2>${esc(runTitle(run))}</h2><p>${ui.events.has(run.id) ? 'Nothing recorded yet.' : 'Loading the conversation…'}</p></div>`)
    + pending(run.id).map(decisionCard).join('') + (live ? typing(provider(run.provider), run.state === 'starting' ? 'Preparing…' : '') : '');
  const stop = live || run.state === 'waiting' ? '<button class="btn small danger" data-action="stop">Stop</button>' : '';
  return { title: runTitle(run), meta: `${provider(run.provider)}${run.branch ? ` · ${run.branch}` : ''}`, chips: `<span class="chip ${stateTone(run)}">${esc(stateLabel(run))}</span>`, actions: stop, feed,
    composer: { placeholder: workingStates.includes(run.state) ? `Message ${provider(run.provider)}…` : (run.provider === 'codex' ? 'Message Claude Code. It takes over from Codex with the chat so far…' : `Message ${provider(run.provider)}. It picks up where it left off…`), mentions: [] } };
}
const emptyStage = text => ({ title: 'Rex Desk', meta: '', feed: `<div class="empty"><h2>Nothing here</h2><p>${text}</p></div>` });

function renderStage(full) {
  const model = stageModel(), stage = document.getElementById('stage');
  const head = `<div class="stage-head"><h1>${esc(model.title)}</h1><span class="meta">${esc(model.meta || '')}</span>${model.chips || ''}<span class="spacer"></span>${model.actions || ''}</div>`;
  if (full || !document.getElementById('feed')) {
    stage.innerHTML = `<div><div id="head">${head}</div><div id="members">${model.members || ''}</div></div><div class="feed" id="feed"><div class="feed-inner" id="feed-inner"></div></div>${model.composer ? `<div class="composer"><div class="composer-inner"><div class="box"><div id="menu"></div><textarea id="draft" rows="1" placeholder="${esc(model.composer.placeholder)}">${esc(ui.drafts.get(draftKey()) || '')}</textarea><button class="btn primary small send" data-action="send">Send</button></div><div class="hint">Enter sends · Shift+Enter adds a line</div></div></div>` : '<div></div>'}`;
    ui.stick = true;
  } else { document.getElementById('head').innerHTML = head; document.getElementById('members').innerHTML = model.members || ''; }
  const feed = document.getElementById('feed'), inner = document.getElementById('feed-inner');
  // Someone typing in an approval form keeps their text: the feed is not redrawn under them.
  const editing = !full && feed.contains(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (!editing) { inner.innerHTML = model.feed; if (ui.stick) feed.scrollTop = feed.scrollHeight; }
  ui.mentions = model.composer?.mentions || [];
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
  const box = document.getElementById('draft'), text = box?.value.trim(); if (!text) return;
  const { type, id } = ui.view; box.disabled = true;
  try {
    if (type === 'room') await api(`/rooms/${id}/messages`, { method: 'POST', data: { text } });
    else {
      const run = type === 'main' ? mainRun() : runById(id);
      if (workingStates.includes(run.state) && run.execution === 'orca') await api(`/runs/${run.id}/say`, { method: 'POST', data: { text } });
      else { await api(`/runs/${run.id}/resume`, { method: 'POST', data: { prompt: text } }); if (run.provider === 'codex') toast('Claude Code took over from Codex. The chat so far was handed over.'); }
    }
    box.value = ''; ui.drafts.delete(draftKey()); await refresh();
  } catch (error) { toast(error.message, true); }
  finally { box.disabled = false; box.focus(); }
}
function newRoomDialog() {
  const runs = ui.snap.runs.filter(run => run.role !== 'coordinator' && stateGroup(run) !== 'done');
  const back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog"><h2>New room</h2><label>Name<input type="text" name="name" placeholder="Export bug across flow-was and desktop" required></label><label>Agents in the room</label>${runs.length ? runs.map(run => `<label class="pick"><input type="checkbox" name="member" value="${esc(run.id)}"> ${esc(runTitle(run))}</label>`).join('') : '<p class="muted">No working agents yet. You can add them later.</p>'}<div class="row"><button class="btn primary">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`;
  document.body.append(back);
  back.addEventListener('click', event => { if (event.target === back || event.target.dataset.close !== undefined) back.remove(); });
  back.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try { const room = await api('/rooms', { method: 'POST', data: { name: form.get('name'), members: form.getAll('member') } }); back.remove(); await refresh(); open('room', room.id); }
    catch (error) { toast(error.message, true); }
  });
}
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-open],[data-action]'); if (!target) return;
  if (target.dataset.open) { event.preventDefault(); return open(target.dataset.open, target.dataset.id); }
  const action = target.dataset.action;
  try {
    if (action?.startsWith('spec-')) await agentAction(ctx, action);
    else if (action === 'send') await send();
    else if (action === 'new-room') newRoomDialog();
    else if (action === 'toggle-done') { ui.done = !ui.done; renderAll(); }
    else if (action === 'theme') window.rexTheme?.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    else if (action === 'stop') { const run = ui.view.type === 'main' ? mainRun() : runById(ui.view.id); await api(`/runs/${run.id}/stop`, { method: 'POST', data: {} }); await refresh(); }
    else if (action === 'scan') { toast('Scanning this computer for projects…'); const result = await api('/memory/scan', { method: 'POST', data: {} }); toast(`Found ${result.count} projects. Notes are in ${result.directory}`); await refresh(); }
    else if (action === 'wake-approve') { await api(`/rooms/x/wakes/${target.dataset.id}`, { method: 'POST', data: {} }); toast('Agent resumed.'); await refresh(); }
    else if (action === 'wake-dismiss') { await api(`/rooms/x/wakes/${target.dataset.id}`, { method: 'DELETE' }); await refresh(); }
    else if (action === 'room-remove') { await api(`/rooms/${ui.view.id}/members/${target.dataset.id}`, { method: 'DELETE' }); await refresh(); }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('change', async event => {
  if (event.target.dataset.action === 'room-add' && event.target.value) {
    try { await api(`/rooms/${ui.view.id}/members`, { method: 'POST', data: { runId: event.target.value } }); await refresh(); } catch (error) { toast(error.message, true); }
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
  try { await api(`/interactions/${form.dataset.interaction}/answer`, { method: 'POST', data: { action: always ? 'accept' : decision, content: always ? { ...content, always: true } : content } }); toast(decision === 'accept' || always ? 'Sent to the agent.' : 'Declined.'); await refresh(); }
  catch (error) { toast(error.message, true); }
});
// Composer: Enter sends; typing @ offers the room's agents.
document.addEventListener('keydown', event => {
  if (event.target.id !== 'draft') return;
  if (ui.menu && ['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'Escape') { ui.menu = null; document.getElementById('menu').innerHTML = ''; return; }
    if (event.key === 'Tab') return pickMention(ui.menu.items[ui.menu.index]);
    ui.menu.index = (ui.menu.index + (event.key === 'ArrowDown' ? 1 : -1) + ui.menu.items.length) % ui.menu.items.length; return drawMenu();
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (ui.menu) return pickMention(ui.menu.items[ui.menu.index]); void send(); }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'draft') return;
  const box = event.target; ui.drafts.set(draftKey(), box.value); box.style.height = 'auto'; box.style.height = `${Math.min(180, box.scrollHeight)}px`;
  const before = box.value.slice(0, box.selectionStart), match = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(before);
  const items = match ? (ui.mentions || []).filter(name => name.toLowerCase().startsWith(match[2].toLowerCase())) : [];
  ui.menu = items.length ? { items, index: 0, from: before.length - match[2].length - 1 } : null; drawMenu();
});
function drawMenu() {
  const host = document.getElementById('menu'); if (!host) return;
  host.innerHTML = ui.menu ? `<div class="menu">${ui.menu.items.map((name, index) => `<button type="button" class="${index === ui.menu.index ? 'on' : ''}" data-mention="${esc(name)}">@${esc(name)}</button>`).join('')}</div>` : '';
}
function pickMention(name) {
  const box = document.getElementById('draft'), end = box.selectionStart;
  box.value = `${box.value.slice(0, ui.menu.from)}@${name} ${box.value.slice(end)}`; ui.drafts.set(draftKey(), box.value); ui.menu = null; drawMenu(); box.focus();
}
document.addEventListener('mousedown', event => { const item = event.target.closest('[data-mention]'); if (item && ui.menu) { event.preventDefault(); pickMention(item.dataset.mention); } });
document.addEventListener('scroll', event => { if (event.target.id === 'feed') ui.stick = event.target.scrollHeight - event.target.scrollTop - event.target.clientHeight < 80; }, true);

try {
  await refresh({ full: true });
  const stream = new EventSource('/api/events'); let timer;
  stream.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(() => void refresh().catch(() => {}), 300); });
  setInterval(() => void refresh().catch(() => {}), 15000);
} catch (error) { app.innerHTML = `<div class="boot"><h2>Rex Desk is unavailable</h2><p>${esc(error.message)}</p><p>Start it with <code>npm start</code>, then reload.</p></div>`; }

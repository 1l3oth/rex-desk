import { pickerHtml } from '/chat-pick.js';
// Rooms (group chats with agents) and Tasks. Both are their own screens, apart from the main agent.
const WORKING = ['starting', 'running', 'queued', 'verifying'];
// A round picture: the room's own image, or its initials on a colour taken from its name.
const hashOf = text => [...String(text)].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7) % 8;
export function avatarHtml(ctx, { name, image = '', id = '', at = '', size = '' }) {
  const { esc, initials } = ctx;
  return image ? `<span class="av ${size}"><img src="/api/rooms/${esc(id)}/image?v=${encodeURIComponent(at)}" alt=""></span>` : `<span class="av av${hashOf(name)} ${size}">${esc(initials(name))}</span>`;
}
const taskNumber = task => String(task.taskNumber || task.externalId || '');
export const taskName = task => task.titleEn || task.title;
const dotFor = state => ({ busy: 'working', replying: 'working', waiting: 'warn', idle: 'good' })[state] || '';

// ---------- rooms ----------
export function roomStage(ctx) {
  const { ui, esc, bubble, note, typing, markdown, hhmm } = ctx, room = ui.snap.rooms.find(item => item.id === ui.view.id);
  if (!room) return { title: 'Room', meta: '', feed: '<div class="empty"><h2>That room is gone.</h2></div>' };
  const handles = room.members.map(member => member.handle).filter(Boolean), tasks = Object.fromEntries((ui.snap.tasks || []).map(task => [taskNumber(task), taskName(task)]));
  const messages = (ui.snap.messages || []).filter(message => message.roomId === room.id).sort((left, right) => left.seq - right.seq);
  const names = new Map(room.members.map(member => [member.id, member.name]));
  const render = message => {
    if (message.from.type === 'system') return note(esc(message.text));
    const to = message.from.type === 'human' && message.to.some(id => id !== 'you') ? message.to.filter(id => id !== 'you').map(id => names.get(id)).filter(Boolean) : [];
    return bubble({ mine: message.from.type === 'human', name: message.from.label, time: hhmm(message.at), html: markdown(message.text, { mentions: ['you', ...handles], tasks }) + (to.length ? `<div class="to">to ${esc(to.join(', '))}</div>` : '') });
  };
  const empty = `<div class="empty"><h2>${esc(room.name)}</h2><p>Mention an agent with @ to talk to it, and a task with #. Agents answer only when they are mentioned, and each one reads this room before it answers.</p></div>`;
  const doing = room.members.filter(member => member.state === 'replying' || member.state === 'busy').map(member => typing(member.name, member.state === 'busy' ? `${member.name} · ${member.label}` : `${member.name} is replying…`)).join('');
  const free = [{ id: 'main', name: 'Main agent', projectSlug: 'all projects', status: { label: 'Knows every project' } }, ...(ui.snap.specialists || [])].filter(agent => !room.members.some(member => member.id === agent.id));
  const chip = member => `<span class="chip member ${esc(member.state)}"><button class="member-open" data-open="${member.runId ? 'run' : 'specialist'}" data-id="${esc(member.runId || member.id)}" title="Open ${esc(member.name)}"><span class="dot ${dotFor(member.state)}"></span><strong>${esc(member.name)}</strong><span class="mlabel">${esc(member.label)}</span></button><button class="btn small x" data-action="room-remove" data-id="${esc(member.id)}" title="Remove from the room">×</button></span>`;
  return { title: room.name, meta: `${room.members.length} agents`, feedClass: 'room',
    composer: { placeholder: 'Message the room. @ mentions an agent, # mentions a task…', mentions: handles, noPickers: true },
    side: ui.infoOpen === false ? '' : roomInfoHtml(ctx, room), sideClass: 'info',
    actions: ui.infoOpen === false ? '<button class="btn small" data-action="info-toggle">Info</button>' : '',
    members: ui.infoOpen !== false ? '' : `<div class="members">${room.members.map(chip).join('')}${free.length ? pickerHtml(ctx, { id: 'room-add-pick', label: 'Add an agent to this room', placeholder: '+ Add agent', searchable: free.length > 6, action: 'room-add', items: free.map(agent => ({ value: agent.id, label: agent.name, hint: `${agent.projectSlug} · ${agent.status?.label || 'Idle'}` })) }) : ''}</div>`,
    feed: `${messages.length ? messages.map(render).join('') : empty}${doing}` };
}

// The room's info on the right, like a messenger: picture, name, who is in it and what they are doing, and the tasks talked about.
function roomInfoHtml(ctx, room) {
  const { ui, esc } = ctx, messages = (ui.snap.messages || []).filter(message => message.roomId === room.id);
  const mentioned = [...new Set(messages.flatMap(message => message.tasks || []))].map(id => (ui.snap.tasks || []).find(task => task.id === id)).filter(Boolean);
  const free = [{ id: 'main', name: 'Main agent', projectSlug: 'all projects', status: { label: 'Knows every project' } }, ...(ui.snap.specialists || [])].filter(agent => !room.members.some(member => member.id === agent.id));
  const member = person => `<li class="rperson"><button class="rperson-main" data-open="${person.runId ? 'run' : 'specialist'}" data-id="${esc(person.runId || person.id)}" title="Open ${esc(person.name)}">${avatarHtml(ctx, { name: person.name, size: 'sm' })}<span class="rperson-text"><b>${esc(person.name)}</b><small>${esc(person.project)} · <span class="st ${esc(person.state)}">${esc(person.label)}</span></small></span></button><button class="btn small x" data-action="room-remove" data-id="${esc(person.id)}" title="Remove from the room" aria-label="Remove ${esc(person.name)}">×</button></li>`;
  return `<div class="side-head"><strong>Chat info</strong><span class="spacer"></span><button type="button" class="btn small" data-action="info-toggle" aria-label="Close the info panel">Close</button></div>
    <div class="side-body rinfo">
      <div class="rhero"><button type="button" class="ravatar" data-action="room-image" title="Change the picture">${avatarHtml(ctx, { name: room.name, image: room.image, id: room.id, at: room.imageAt || '', size: 'xl' })}<span class="cam">Change</span></button><input type="file" id="room-image-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        <input class="rname" id="room-name" value="${esc(room.name)}" maxlength="80" aria-label="Room name" spellcheck="false">
        <p class="rsub">${room.members.length} agent${room.members.length === 1 ? '' : 's'} · started ${esc(new Date(room.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</p></div>
      <h3>Members <span>${room.members.length + 1}</span></h3>
      <ul class="rmembers"><li class="rperson me"><span class="rperson-main">${avatarHtml(ctx, { name: 'You', size: 'sm' })}<span class="rperson-text"><b>You</b><small>The person</small></span></span></li>${room.members.map(member).join('')}</ul>
      ${free.length ? pickerHtml(ctx, { id: 'room-add-pick', label: 'Add people', placeholder: '+ Add people', searchable: free.length > 6, action: 'room-add', items: free.map(agent => ({ value: agent.id, label: agent.name, hint: `${agent.projectSlug} · ${agent.status?.label || 'Idle'}` })) }) : ''}
      <h3>Tasks in this chat <span>${mentioned.length}</span></h3>
      ${mentioned.length ? `<ul class="rtasks">${mentioned.map(task => `<li><button class="rtask" data-open="task" data-id="${esc(task.id)}"><span class="tnum">#${esc(taskNumber(task))}</span><span>${esc(taskName(task))}</span></button></li>`).join('')}</ul>` : '<p class="muted small">None yet. Type # in the message box to mention a task.</p>'}
      <div class="rdanger"><button class="btn danger small" data-action="room-delete">Delete this room</button></div>
    </div>`;
}

export function newRoomDialog(ctx) {
  const { ui, esc, toast, api, refresh, open } = ctx, agents = ui.snap.specialists || [];
  const back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog"><h2>New room</h2><label>Name<input type="text" name="name" placeholder="Checkout bug" required maxlength="80"></label><label>Agents in the room</label><label class="pick"><input type="checkbox" name="member" value="main"> Main agent <span class="muted">· knows every project</span></label>${agents.length ? agents.map(agent => `<label class="pick"><input type="checkbox" name="member" value="${esc(agent.id)}"> ${esc(agent.name)} <span class="muted">· ${esc(agent.projectSlug)}</span></label>`).join('') : '<p class="muted">No agents yet. Create one with the + next to Agents, then add it to a room.</p>'}<div class="row"><button class="btn primary">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`;
  document.body.append(back); back.querySelector('input').focus();
  back.addEventListener('click', event => { if (event.target === back || event.target.dataset.close !== undefined) back.remove(); });
  back.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try { const room = await api('/rooms', { method: 'POST', data: { name: form.get('name'), members: form.getAll('member') } }); back.remove(); await refresh(); open('room', room.id); }
    catch (error) { toast(error.message, true); }
  });
}

// ---------- tasks ----------
const requested = new Set();
// Tasks written in another language get an English name the first time they are shown.
export function ensureNames(ctx, tasks) {
  const missing = tasks.filter(task => !task.titleEn && !requested.has(task.id)).slice(0, 4);
  if (!missing.length) return;
  for (const task of missing) requested.add(task.id);
  void Promise.all(missing.map(task => ctx.api(`/tasks/${task.id}/name`, { method: 'POST', data: {} }).catch(() => null))).then(() => ctx.refresh());
}
const agentOnTask = (ui, task) => { const run = (ui.snap.runs || []).find(item => item.taskId === task.id && item.specialistId && !['finished', 'failed', 'stopped', 'interrupted', 'published', 'ready_for_review', 'needs_evidence'].includes(item.state)); return run ? { run, agent: (ui.snap.specialists || []).find(agent => agent.id === run.specialistId) } : null; };

export function tasksStage(ctx) {
  const { ui, esc } = ctx, all = (ui.snap.tasks || []).filter(task => task.active && !task.demo), filter = String(ui.taskFilter || '').toLowerCase();
  const shown = all.filter(task => !filter || `${taskNumber(task)} ${taskName(task)} ${task.title} ${task.statusName || task.status || ''} ${task.projectName || ''}`.toLowerCase().includes(filter));
  ensureNames(ctx, shown);
  const rows = shown.map(task => {
    const on = agentOnTask(ui, task);
    return `<button class="trow" data-open="task" data-id="${esc(task.id)}"><span class="tnum">#${esc(taskNumber(task))}</span><span class="tname">${esc(taskName(task))}</span><span class="tmeta">${esc(task.statusName || task.status || '')}${task.projectName ? ` · ${esc(task.projectName)}` : ''}</span>${on?.agent ? `<span class="tagent"><span class="dot working"></span>${esc(on.agent.name)}</span>` : ''}</button>`;
  }).join('');
  return { title: 'Tasks', meta: `${all.length} issues`,
    members: `<div class="members"><input id="task-filter" type="search" placeholder="Search tasks…" value="${esc(ui.taskFilter || '')}" autocomplete="off"></div>`,
    feed: `<div class="page"><div class="tlist">${rows || '<div class="empty"><h2>No tasks</h2><p>Press Sync to bring in your assigned issues.</p></div>'}</div></div>` };
}

export function taskStage(ctx) {
  const { ui, esc, markdown } = ctx, task = (ui.snap.tasks || []).find(item => item.id === ui.view.id);
  if (!task) return { title: 'Task', meta: '', feed: '<div class="empty"><h2>That task is gone.</h2></div>' };
  ensureNames(ctx, [task]);
  const on = agentOnTask(ui, task), agents = ui.snap.specialists || [], rooms = ui.snap.rooms || [];
  const assign = on?.agent
    ? `<p class="assigned"><span class="dot working"></span><strong>${esc(on.agent.name)}</strong> is working on this. <button class="btn small" data-open="run" data-id="${esc(on.run.id)}">Open the work</button></p>`
    : agents.length ? `<div class="assign"><label>Assign to${pickerHtml(ctx, { id: 'assign-agent', label: 'Assign to', searchable: agents.length > 6, value: agents.find(agent => agent.status?.state !== 'busy')?.id || '', items: agents.map(agent => ({ value: agent.id, label: agent.name, hint: agent.projectSlug, meta: agent.status?.state === 'busy' ? 'busy' : '', disabled: agent.status?.state === 'busy' })) })}</label>
        <label>Tell this room${pickerHtml(ctx, { id: 'assign-room', label: 'Tell this room', value: '', items: [{ value: '', label: 'No room' }, ...rooms.map(room => ({ value: room.id, label: room.name, hint: `${room.members.length} agents` }))] })}</label>
        <button class="btn primary" data-action="task-assign" data-id="${esc(task.id)}">Assign</button></div>` : '<p class="muted">Create an agent first (the + next to Agents), then assign this task to it.</p>';
  return { title: `#${taskNumber(task)} ${taskName(task)}`, meta: task.statusName || task.status || '',
    feed: `<div class="page"><section class="idcard"><div class="thead"><span class="tnum">#${esc(taskNumber(task))}</span><h2>${esc(taskName(task))}</h2></div>
      ${task.titleEn && task.titleEn !== task.title ? `<p class="orig">${esc(task.title)}</p>` : ''}
      <div class="idmeta">${task.statusName || task.status ? `<span class="chip">${esc(task.statusName || task.status)}</span>` : ''}${task.projectName ? `<span class="chip">${esc(task.projectName)}</span>` : ''}${task.reporter ? `<span class="chip">Reporter: ${esc(task.reporter)}</span>` : ''}${task.url ? `<a class="chip" href="${esc(task.url)}" target="_blank" rel="noopener noreferrer">Open the original</a>` : ''}</div>
      ${assign}
      <h3>Description</h3><div class="md">${markdown(String(task.description || 'No description.').slice(0, 6000))}</div></section></div>` };
}

// ---------- room info: name and picture ----------
export function initRoomInfo(ctx) {
  document.addEventListener('change', async event => {
    const { ui, api, toast, refresh } = ctx;
    if (event.target.id === 'room-name') {
      try { await api(`/rooms/${ui.view.id}`, { method: 'PUT', data: { name: event.target.value } }); await refresh(); } catch (error) { toast(error.message, true); await refresh(); }
    } else if (event.target.id === 'room-image-input' && event.target.files[0]) {
      const file = event.target.files[0]; event.target.value = '';
      try {
        const response = await fetch(`/api/rooms/${ui.view.id}/image`, { method: 'POST', headers: { 'x-rex-desk': '1', 'Content-Type': file.type }, body: file }), body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Upload failed.');
        await refresh(); toast('Room picture changed.');
      } catch (error) { toast(error.message, true); }
    }
  });
  document.addEventListener('keydown', event => { if (event.target.id === 'room-name' && event.key === 'Enter') { event.preventDefault(); event.target.blur(); } });
}

// ---------- actions ----------
export async function roomAction(ctx, action, target) {
  const { ui, api, toast, refresh } = ctx;
  if (action === 'info-toggle') { ui.infoOpen = ui.infoOpen === false; ctx.render(); return; }
  if (action === 'room-image') { document.getElementById('room-image-input')?.click(); return; }
  if (action === 'room-delete') {
    const room = ui.snap.rooms.find(item => item.id === ui.view.id);
    if (room && confirm(`Delete the room "${room.name}" and its messages? The agents and their sessions stay.`)) { await api(`/rooms/${room.id}`, { method: 'DELETE' }); ctx.open('main'); }
    return;
  }
  if (action === 'room-remove') { await api(`/rooms/${ui.view.id}/members/${target.dataset.id}`, { method: 'DELETE' }); await refresh(); }
  else if (action === 'task-assign') {
    const agentId = document.getElementById('assign-agent')?.value, roomId = document.getElementById('assign-room')?.value || '';
    if (!agentId) return toast('Pick an agent first.', true);
    await api(`/specialists/${agentId}/assign`, { method: 'POST', data: { taskId: target.dataset.id, roomId } });
    toast('Assigned. The agent starts on it now.'); await refresh();
  }
}

// Rooms (group chats with agents) and Tasks. Both are their own screens, apart from the main agent.
const WORKING = ['starting', 'running', 'queued', 'verifying'];
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
  const free = (ui.snap.specialists || []).filter(agent => !room.members.some(member => member.id === agent.id));
  const chip = member => `<span class="chip member ${esc(member.state)}"><button class="member-open" data-open="${member.runId ? 'run' : 'specialist'}" data-id="${esc(member.runId || member.id)}" title="Open ${esc(member.name)}"><span class="dot ${dotFor(member.state)}"></span><strong>${esc(member.name)}</strong><span class="mlabel">${esc(member.label)}</span></button><button class="btn small x" data-action="room-remove" data-id="${esc(member.id)}" title="Remove from the room">×</button></span>`;
  return { title: room.name, meta: `${room.members.length} agents`, feedClass: 'room',
    composer: { placeholder: 'Message the room. @ mentions an agent, # mentions a task…', mentions: handles, noPickers: true },
    members: `<div class="members">${room.members.map(chip).join('')}${free.length ? `<select data-action="room-add"><option value="">+ Add agent…</option>${free.map(agent => `<option value="${esc(agent.id)}">${esc(agent.name)} · ${esc(agent.projectSlug)}</option>`).join('')}</select>` : ''}</div>`,
    feed: `${messages.length ? messages.map(render).join('') : empty}${doing}` };
}

export function newRoomDialog(ctx) {
  const { ui, esc, toast, api, refresh, open } = ctx, agents = ui.snap.specialists || [];
  const back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog"><h2>New room</h2><label>Name<input type="text" name="name" placeholder="Checkout bug" required maxlength="80"></label><label>Agents in the room</label>${agents.length ? agents.map(agent => `<label class="pick"><input type="checkbox" name="member" value="${esc(agent.id)}"> ${esc(agent.name)} <span class="muted">· ${esc(agent.projectSlug)}</span></label>`).join('') : '<p class="muted">No agents yet. Create one with the + next to Agents, then add it to a room.</p>'}<div class="row"><button class="btn primary">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`;
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
    : agents.length ? `<div class="assign"><label>Assign to<select id="assign-agent">${agents.map(agent => `<option value="${esc(agent.id)}" ${agent.status?.state === 'busy' ? 'disabled' : ''}>${esc(agent.name)} · ${esc(agent.projectSlug)}${agent.status?.state === 'busy' ? ' (busy)' : ''}</option>`).join('')}</select></label>
        <label>Tell this room<select id="assign-room"><option value="">None</option>${rooms.map(room => `<option value="${esc(room.id)}">${esc(room.name)}</option>`).join('')}</select></label>
        <button class="btn primary" data-action="task-assign" data-id="${esc(task.id)}">Assign</button></div>` : '<p class="muted">Create an agent first (the + next to Agents), then assign this task to it.</p>';
  return { title: `#${taskNumber(task)} ${taskName(task)}`, meta: task.statusName || task.status || '',
    feed: `<div class="page"><section class="idcard"><div class="thead"><span class="tnum">#${esc(taskNumber(task))}</span><h2>${esc(taskName(task))}</h2></div>
      ${task.titleEn && task.titleEn !== task.title ? `<p class="orig">${esc(task.title)}</p>` : ''}
      <div class="idmeta">${task.statusName || task.status ? `<span class="chip">${esc(task.statusName || task.status)}</span>` : ''}${task.projectName ? `<span class="chip">${esc(task.projectName)}</span>` : ''}${task.reporter ? `<span class="chip">Reporter: ${esc(task.reporter)}</span>` : ''}${task.url ? `<a class="chip" href="${esc(task.url)}" target="_blank" rel="noopener noreferrer">Open the original</a>` : ''}</div>
      ${assign}
      <h3>Description</h3><div class="md">${markdown(String(task.description || 'No description.').slice(0, 6000))}</div></section></div>` };
}

// ---------- actions ----------
export async function roomAction(ctx, action, target) {
  const { ui, api, toast, refresh } = ctx;
  if (action === 'room-remove') { await api(`/rooms/${ui.view.id}/members/${target.dataset.id}`, { method: 'DELETE' }); await refresh(); }
  else if (action === 'task-assign') {
    const agentId = document.getElementById('assign-agent')?.value, roomId = document.getElementById('assign-room')?.value || '';
    if (!agentId) return toast('Pick an agent first.', true);
    await api(`/specialists/${agentId}/assign`, { method: 'POST', data: { taskId: target.dataset.id, roomId } });
    toast('Assigned. The agent starts on it now.'); await refresh();
  }
}

import { chatWorktrees, worktreeSideHtml } from '/chat-worktrees.js';
import { speakButton } from '/chat-speak.js';
import { pickerHtml } from '/chat-pick.js';
import { collectShared, sharedTabsHtml, sharedCount } from '/chat-media.js';
import { toolLine, changeHtml } from '/chat-activity.js';
// Rooms (group chats with agents) and Tasks. Both are their own screens, apart from the main agent.
const WORKING = ['starting', 'running', 'queued', 'verifying'];
// A round picture: the room's own image, or its initials on a colour taken from its name.
const hashOf = text => [...String(text)].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7) % 8;
export function avatarHtml(ctx, { name, image = '', id = '', at = '', size = '' }) {
  const { esc, initials } = ctx;
  return image ? `<span class="av ${size}"><img src="/api/rooms/${esc(id)}/image?v=${encodeURIComponent(at)}" alt=""></span>` : `<span class="av av${hashOf(name)} ${size}">${esc(initials(name))}</span>`;
}
export const nameHash = text => [...String(text)].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7) % 8;
const taskNumber = task => String(task.taskNumber || task.externalId || '');
export const taskName = task => task.titleEn || task.title;
const dotFor = state => ({ busy: 'working', replying: 'working', waiting: 'warn', idle: 'good', offline: 'off' })[state] || '';

// ---------- rooms ----------
export function roomStage(ctx) {
  const { ui, esc, bubble, note, typing, markdown, hhmm } = ctx, room = ui.snap.rooms.find(item => item.id === ui.view.id);
  if (!room) return { title: 'Room', meta: '', feed: '<div class="empty"><h2>That room is gone.</h2></div>' };
  const handles = room.members.map(member => member.handle).filter(Boolean), tasks = Object.fromEntries((ui.snap.tasks || []).map(task => [taskNumber(task), taskName(task)]));
  const messages = (ui.snap.messages || []).filter(message => message.roomId === room.id).sort((left, right) => left.seq - right.seq);
  const names = new Map(room.members.map(member => [member.id, member.name]));
  // Like a group chat: an agent's message has its picture and its name in its own colour; messages in a row from the same sender share one header.
  let previous = null;
  const byId = new Map(messages.map(message => [message.id, message]));
  const snippet = text => { const plain = String(text || '').replace(/\s+/g, ' ').trim(); return plain.length > 90 ? `${plain.slice(0, 90)}…` : plain; };
  const quote = message => { const parent = message.replyTo && byId.get(message.replyTo); return parent ? `<button type="button" class="rquote" data-jump="${esc(parent.id)}" title="Show the message this answers"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4L2 8l4 4M2 8h8a4 4 0 0 1 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><b>${esc(parent.from.type === 'human' ? 'You' : parent.from.label)}</b> ${esc(snippet(parent.text))}</button>` : ''; };
  const render = message => {
    if (message.from.type === 'system') { previous = null; return note(esc(message.text)); }
    const to = message.from.type === 'human' && message.to.some(id => id !== 'you') ? message.to.filter(id => id !== 'you').map(id => names.get(id)).filter(Boolean) : [];
    const shown = message.from.type === 'human' ? String(message.text).replace(/\s*\(Sent by voice: [^)]*\)\s*$/, '') : message.text;
    const html = markdown(shown, { mentions: ['you', ...handles], tasks }) + (to.length ? `<div class="to">to ${esc(to.join(', '))}</div>` : '') + (message.tokens ? `<div class="tok" title="Tokens this reply used">${esc(ctx.tokenText(message.tokens))}</div>` : '');
    const same = previous && previous.from.id === message.from.id && Date.parse(message.at) - Date.parse(previous.at) < 5 * 60000; previous = message;
    if (message.from.type === 'human') return bubble({ mine: true, name: 'You', time: hhmm(message.at), voice: shown !== message.text, html: quote(message) + html }).replace('<div class="msg mine', `<div data-msg="${esc(message.id)}" class="msg mine`);
    return `<div class="msg rmsg ${same ? 'cont' : ''}" data-msg="${esc(message.id)}"><div class="ravcol"${message.from.type === 'agent' ? ` data-agent-card="${esc(message.from.id)}" title="${esc(message.from.label)}'s card"` : ''}>${same ? '' : ctx.avatar({ name: message.from.label, size: 'sm' })}</div><div class="bubble"><div class="who rwho"><strong class="nc${nameHash(message.from.label)}"${message.from.type === 'agent' ? ` data-agent-card="${esc(message.from.id)}"` : ''}>${esc(message.from.label)}</strong><span>${esc(hhmm(message.at))}</span>${message.from.type === 'human' ? `<button type="button" class="rreply rdel" data-msg-delete="${esc(message.id)}" title="Unsend" aria-label="Unsend this message"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ''}${message.from.type === 'agent' ? speakButton('rreply') : ''}<button type="button" class="rreply" data-reply="${esc(message.id)}" title="Reply to ${esc(message.from.label)}" aria-label="Reply to ${esc(message.from.label)}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 4L2 8l4 4M2 8h8a4 4 0 0 1 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Reply</button></div>${quote(message)}<div class="md">${html}</div></div></div>`;
  };
  const empty = `<div class="empty"><h2>${esc(room.name)}</h2><p>Mention an agent with @ to talk to it, and a task with #. Agents answer only when they are mentioned, and each one reads this room before it answers.</p></div>`;
  // One typing line for everyone answering in the room, like a messenger; work on a task shows in the Activity tab instead.
  const replying = room.members.filter(member => member.state === 'replying').map(member => member.name);
  const doing = replying.length ? typing(replying[0], replying.length === 1 ? `${replying[0]} is replying…` : replying.length === 2 ? `${replying[0]} and ${replying[1]} are replying…` : `${replying[0]} and ${replying.length - 1} others are replying…`) : '';
  // Anyone working in the room can be stopped from here; a message sent while they work reaches them between steps.
  const working = room.members.filter(member => ['replying', 'busy'].includes(member.state) && member.runId);
  const stopBar = working.length ? `<div class="rstop">${working.map(member => `<button type="button" class="btn small danger" data-action="room-stop" data-run="${esc(member.runId)}" title="Stop ${esc(member.name)} now">Stop ${esc(member.name)}</button>`).join('')}<span class="muted small">Or just write: they read new messages between steps.</span></div>` : '';
  const free = [{ id: 'main', name: 'Rex Agent', projectSlug: 'all projects', status: { label: 'Knows every project' } }, ...(ui.snap.specialists || [])].filter(agent => !room.members.some(member => member.id === agent.id));
  const chip = member => `<span class="chip member ${esc(member.state)}"><button class="member-open" data-open="${member.runId ? 'run' : 'specialist'}" data-id="${esc(member.runId || member.id)}" title="Open ${esc(member.name)}"><span class="dot ${dotFor(member.state)}"></span><strong>${esc(member.name)}</strong><span class="mlabel">${esc(member.label)}</span></button><button class="btn small x" data-action="room-remove" data-id="${esc(member.id)}" title="Remove from the room">×</button></span>`;
  const awayBanner = room.away?.on ? `<div class="away-banner"><span class="dot working"></span><span><b>Away mode</b> · the agents keep working${room.away.goal ? ` on ${esc(room.away.goal)}` : ''} · ${room.away.every === 'auto' ? `next check-in in about ${room.away.nextMinutes || 30} min (auto)` : `check-in every ${room.away.every} min`}${room.away.until ? ` · until ${esc(new Date(room.away.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : ' · until you are back'}. Write here to end it.</span></div>` : '';
  return { title: room.name, meta: `${room.members.length} agents`, feedClass: 'room', banner: awayBanner,
    composer: { placeholder: 'Message the room (Rex Agent answers unless you @mention someone)…', mentions: handles, noPickers: true, foot: `<span class="agents-pop-host"><button type="button" class="btn small agents-btn" data-action="agents-pop" aria-haspopup="true" title="Each agent's AI and model">AI · Model <span aria-hidden="true">▴</span></button><div class="agents-pop" id="agents-pop" role="dialog" aria-label="Agents" ${ui.agentsPop ? '' : 'hidden'}>${ui.agentsPop ? roomAgentsHtml(ctx, room) : ''}</div></span>` },
    side: ui.infoOpen === false ? '' : roomSideHtml(ctx, room), sideClass: 'info',
    actions: `${room.away?.on ? '<button class="btn small away-on" data-action="away-stop">Away mode on · Stop</button>' : '<button class="btn small" data-action="away-start" title="Let the agents keep working while you are away">Away mode</button>'} ${ui.infoOpen === false ? '<button class="btn small" data-action="info-toggle">Info</button>' : ''}`,
    members: ui.infoOpen !== false ? '' : `<div class="members">${room.members.map(chip).join('')}${free.length ? pickerHtml(ctx, { id: 'room-add-pick', label: 'Add an agent to this room', placeholder: '+ Add agent', searchable: free.length > 6, action: 'room-add', items: free.map(agent => ({ value: agent.id, label: agent.name, hint: `${agent.projectSlug} · ${agent.status?.label || 'Idle'}` })) }) : ''}</div>`,
    feed: `${messages.length ? messages.map(render).join('') : empty}${asks(ctx, room)}${doing}${stopBar}` };
}

// Questions and approvals from the members' sessions in this room show in the room, from the agent who asked.
function asks(ctx, room) {
  const owner = new Map();
  for (const member of room.members) for (const id of roomRunIds(ctx.ui, { id: room.id, members: [member] })) owner.set(id, member.name);
  return ctx.pending().filter(item => owner.has(item.runId)).map(item => `<div class="msg rmsg"><div class="ravcol">${ctx.avatar({ name: owner.get(item.runId), size: 'sm' })}</div>${ctx.decisionCard(item)}</div>`).join('');
}
// The room's info on the right, like a messenger: picture, name, who is in it and what they are doing, and the tasks talked about.
// The sessions whose work shows in a room's Activity tab: each member's room session, and the task run of a member who is busy on one.
export function roomRunIds(ui, room) {
  const ids = [];
  for (const member of room.members) {
    const agent = member.id === 'main' ? null : (ui.snap.specialists || []).find(item => item.id === member.id);
    const roomRun = member.id === 'main' ? (ui.snap.runs || []).find(run => run.roomAgent === 'main' && run.roomOf === room.id)?.id : agent?.roomRuns?.[room.id];
    if (roomRun) ids.push(roomRun);
    if (member.state === 'busy' && member.runId) ids.push(member.runId);
  }
  return [...new Set(ids)];
}
const HIDDEN_STEPS = ['desk_ask', 'desk_message', 'desk_elicit', 'desk_room_post'];
// What everyone in the room is doing, newest at the bottom: their steps, the commands they ran (with output), and when they replied.
function activityHtml(ctx, room) {
  const { ui, esc, hhmm } = ctx, names = new Map(room.members.map(member => [member.id, member.name])), owner = new Map();
  for (const member of room.members) for (const id of roomRunIds(ui, { id: room.id, members: [member] })) owner.set(id, member.name);
  const rows = [];
  for (const [runId, who] of owner) {
    const events = ui.events.get(runId) || [], results = new Map(events.filter(event => event.kind === 'agent-tool-result').map(event => [event.id, event]));
    for (const event of events) {
      if (event.kind === 'agent-tool' && !HIDDEN_STEPS.includes(event.tool)) rows.push({ at: event.createdAt, who, event, out: results.get(event.id) });
      else if (event.kind === 'agent-text') rows.push({ at: event.createdAt, who, said: event.text });
      else if (event.kind === 'turn-start') rows.push({ at: event.createdAt, who, note: 'started working' });
    }
  }
  rows.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const working = room.members.filter(member => member.state === 'busy' || member.state === 'replying' || member.state === 'waiting');
  const now = working.length ? `<div class="anow">${working.map(member => `<div class="anow-row"><span class="dot ${member.state === 'waiting' ? 'warn' : 'working'}"></span><b>${esc(member.name)}</b><span>${esc(member.label)}</span></div>`).join('')}</div>` : '<p class="muted small">Nobody is working right now.</p>';
  const row = item => {
    const head = `${ctx.avatar({ name: item.who, size: 'xs' })}<b>${esc(item.who)}</b><span class="atime">${esc(hhmm(item.at))}</span>`;
    if (item.note) return `<li class="arow">${head}<span class="atext muted">${esc(item.note)}</span></li>`;
    if (item.said) return `<li class="arow">${head}<span class="atext">replied: ${esc(String(item.said).replace(/\s+/g, ' ').slice(0, 140))}</span></li>`;
    const shell = item.event.tool === 'Bash' || item.event.tool === 'PowerShell';
    const line = `<span class="atext">${esc(toolLine({ tool: item.event.tool, input: item.event.input, failed: item.event.failed, text: item.event.text }))}</span>`;
    if (item.event.change) return `<li class="arow">${head}${changeHtml(item.event.change, esc)}</li>`;
    if (!shell) return `<li class="arow ${item.event.failed ? 'bad' : ''}">${head}${line}</li>`;
    const state = item.out ? (item.out.failed ? 'failed' : 'done') : 'running…';
    return `<li class="arow">${head}<details class="aterm"><summary>${line}<span class="tstate ${item.out ? (item.out.failed ? 'bad' : 'ok') : 'run'}">${state}</span></summary><pre class="tout">$ ${esc(item.event.input?.command || '')}\n${esc(item.out?.text || '')}</pre></details></li>`;
  };
  return `<div class="side-body ractivity" id="side-body"><h3>Now</h3>${now}<h3>Recent</h3>${rows.length ? `<ul class="alist">${rows.slice(-80).map(row).join('')}</ul>` : '<p class="muted small">Nothing yet. Mention an agent and its work shows here.</p>'}</div>`;
}
// The right side of a room: Activity and Chat info, as tabs.
// Two tabs, like a messenger's chat info: Chat info (members, and the media, files and links shared here) and Activity (what the agents are doing).
function roomSideHtml(ctx, room) {
  const trees = chatWorktrees(ctx.ui, { roomId: room.id });
  const tab = ['activity', 'worktrees'].includes(ctx.ui.sideTab) ? ctx.ui.sideTab : 'info', busy = room.members.filter(member => member.state === 'busy' || member.state === 'replying').length;
  const close = '<button type="button" class="side-x" data-action="info-toggle" aria-label="Close the side panel" title="Close"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>';
  return `<div class="side-head tabs"><button type="button" class="tab ${tab === 'info' ? 'on' : ''}" data-action="side-tab" data-tab="info">Chat info</button><button type="button" class="tab ${tab === 'activity' ? 'on' : ''}" data-action="side-tab" data-tab="activity">Activity${busy ? `<span class="tcount">${busy}</span>` : ''}</button><button type="button" class="tab ${tab === 'worktrees' ? 'on' : ''}" data-action="side-tab" data-tab="worktrees">Worktrees${trees.length ? `<span class="tcount quiet">${trees.length}</span>` : ''}</button><span class="spacer"></span>${close}</div>${tab === 'info' ? roomInfoHtml(ctx, room) : tab === 'worktrees' ? worktreeSideHtml(ctx, trees) : activityHtml(ctx, room)}`;
}
// The Agents tab: each member's AI and model, changed right here. Saved at once on the agent itself, so it holds in every chat.
const AIS = [{ value: 'claude', label: 'Claude Code', hint: 'Claude subscription' }, { value: 'codex', label: 'Codex', hint: 'ChatGPT subscription' }, { value: 'gemini', label: 'Gemini', hint: 'Google account, through Antigravity' }];
function roomAgentsHtml(ctx, room) {
  const { esc, ui } = ctx, agents = room.members.map(member => member.id === 'main' ? ui.snap.mainAgent : (ui.snap.specialists || []).find(item => item.id === member.id)).filter(Boolean);
  if (!agents.length) return '<p class="muted">No agents in this room yet.</p>';
  return `<div class="room-agents">${agents.map(agent => {
    const ai = ['codex', 'gemini'].includes(agent.provider) ? agent.provider : 'claude', choices = ui.snap.choices?.providers?.[ai] || ui.snap.choices || {};
    const models = [{ value: '', label: 'Default', hint: 'The model set in Settings' }, ...(choices.models || []).map(model => ({ value: model.id, label: model.label, hint: model.hint, disabled: model.disabled }))];
    const seat = room.members.find(member => member.id === agent.id) || {};
    return `<section class="ag-sec room-agent" data-agent="${esc(agent.id)}"><div class="rperson-main ra-head">${avatarHtml(ctx, { name: agent.name, size: 'sm' })}<span class="rperson-text"><b>${esc(agent.name)}</b><small>${esc(seat.project || '')}${seat.label ? ` · <span class="st ${esc(seat.state)}">${esc(seat.label)}</span>` : ''}</small></span></div>
      <label class="room-agent-row"><span>AI</span>${pickerHtml(ctx, { id: `ra-provider-${agent.id}`, label: 'AI', value: ai, items: AIS, compact: true })}</label>
      <label class="room-agent-row"><span>Model</span>${pickerHtml(ctx, { id: `ra-model-${agent.id}`, label: 'Model', value: agent.model || '', items: models, compact: true })}</label></section>`;
  }).join('')}<p class="muted">Changes save at once and hold for this agent everywhere. A new AI starts a fresh session with the chat so far handed over.</p></div>`;
}
function roomSharedHtml(ctx, room) {
  const messages = (ctx.ui.snap.messages || []).filter(message => message.roomId === room.id && message.from.type !== 'system'), runs = new Set(roomRunIds(ctx.ui, room));
  const shared = collectShared(messages.map(message => ({ from: message.from.type === 'human' ? 'You' : message.from.label, at: message.at, text: message.text })), (ctx.ui.snap.artifacts || []).filter(item => runs.has(item.runId)));
  const part = ['media', 'files', 'links'].includes(ctx.ui.roomShared) ? ctx.ui.roomShared : 'media';
  return `<h3>Media, files and links</h3><div class="pshared"><div class="pseg">${sharedTabButtons(shared, part, 'room-shared')}</div><div class="shared">${sharedTabsHtml(ctx, shared, part)}</div></div>`;
}
function roomInfoHtml(ctx, room) {
  const { ui, esc } = ctx, messages = (ui.snap.messages || []).filter(message => message.roomId === room.id);
  const mentioned = [...new Set(messages.flatMap(message => message.tasks || []))].map(id => (ui.snap.tasks || []).find(task => task.id === id)).filter(Boolean);
  const free = [{ id: 'main', name: 'Rex Agent', projectSlug: 'all projects', status: { label: 'Knows every project' } }, ...(ui.snap.specialists || [])].filter(agent => !room.members.some(member => member.id === agent.id));
  const member = person => `<li class="rperson"><button class="rperson-main" data-open="${person.runId ? 'run' : 'specialist'}" data-id="${esc(person.runId || person.id)}" title="Open ${esc(person.name)}"><span data-agent-card="${esc(person.id)}" title="${esc(person.name)}'s card">${avatarHtml(ctx, { name: person.name, size: 'sm' })}</span><span class="rperson-text"><b>${esc(person.name)}</b><small>${esc(person.project)} · <span class="st ${esc(person.state)}">${esc(person.label)}</span></small></span></button><button class="btn small x" data-action="room-remove" data-id="${esc(person.id)}" title="Remove from the room" aria-label="Remove ${esc(person.name)}">×</button></li>`;
  return `<div class="side-body rinfo">
      <div class="rhero"><button type="button" class="ravatar" data-action="room-image" title="Change the picture">${avatarHtml(ctx, { name: room.name, image: room.image, id: room.id, at: room.imageAt || '', size: 'xl' })}<span class="cam">Change</span></button><input type="file" id="room-image-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        <input class="rname" id="room-name" value="${esc(room.name)}" maxlength="80" aria-label="Room name" spellcheck="false">
        <p class="rsub">${room.members.length} agent${room.members.length === 1 ? '' : 's'} · started ${esc(new Date(room.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</p></div>
      <h3>Members <span>${room.members.length + 1}</span></h3>
      <ul class="rmembers"><li class="rperson me"><span class="rperson-main">${avatarHtml(ctx, { name: 'You', size: 'sm' })}<span class="rperson-text"><b>You</b><small>The person</small></span></span></li>${room.members.map(member).join('')}</ul>
      ${free.length ? pickerHtml(ctx, { id: 'room-add-pick', label: 'Add people', placeholder: '+ Add people', searchable: free.length > 6, action: 'room-add', items: free.map(agent => ({ value: agent.id, label: agent.name, hint: `${agent.projectSlug} · ${agent.status?.label || 'Idle'}` })) }) : ''}
      ${roomSharedHtml(ctx, room)}
      <h3>Tasks in this chat <span>${mentioned.length}</span></h3>
      ${mentioned.length ? `<ul class="rtasks">${mentioned.map(task => `<li><button class="rtask" data-open="task" data-id="${esc(task.id)}"><span class="tnum">#${esc(taskNumber(task))}</span><span>${esc(taskName(task))}</span></button></li>`).join('')}</ul>` : '<p class="muted small">None yet. Type # in the message box to mention a task.</p>'}
      <div class="rdanger"><button class="btn danger small" data-action="room-delete">Delete this room</button></div>
    </div>`;
}

export function newRoomDialog(ctx, from = null) {
  const { ui, esc, toast, api, refresh, open } = ctx, agents = (ui.snap.specialists || []).filter(agent => agent.id !== from?.id);
  const back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog"><h2>${from ? `Group chat from your chat with ${esc(from.name)}` : 'New room'}</h2>${from ? `<p class="muted small">${esc(from.name)} comes along, and the last 20 messages are copied in, so everyone carries on with the same topic.</p>` : ''}<label>Name<input type="text" name="name" placeholder="Checkout bug" required maxlength="80" value="${from ? esc(`${from.name} and team`) : ''}"></label><label>Agents in the room</label>${from?.id === 'main' ? '' : '<label class="pick"><input type="checkbox" name="member" value="main"> Rex Agent <span class="muted">· knows every project</span></label>'}${agents.length ? agents.map(agent => `<label class="pick"><input type="checkbox" name="member" value="${esc(agent.id)}"> ${esc(agent.name)} <span class="muted">· ${esc(agent.projectSlug)}</span></label>`).join('') : '<p class="muted">No agents yet. Create one with the + next to Agents, then add it to a room.</p>'}<div class="row"><button class="btn primary">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`;
  document.body.append(back); back.querySelector('input').focus();
  back.addEventListener('click', event => { if (event.target === back || event.target.dataset.close !== undefined) back.remove(); });
  back.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try { const room = from ? await api('/rooms/from-chat', { method: 'POST', data: { agentId: from.id, name: form.get('name'), members: form.getAll('member') } }) : await api('/rooms', { method: 'POST', data: { name: form.get('name'), members: form.getAll('member') } }); back.remove(); await refresh(); open('room', room.id); }
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

const STATUS = [['in_progress', 'In progress'], ['in_review', 'In review'], ['todo', 'To do'], ['blocked', 'Blocked'], ['backlog', 'Backlog'], ['done', 'Done']];
const STATUS_TONE = { in_progress: 'working', in_review: 'warn', blocked: 'bad', done: 'good' };
const PRIORITY = [['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
// One task as a row of columns: state, number, title, where it comes from, its status, who works on it, and when it is due.
function taskRow(ctx, task) {
  const { ui, esc } = ctx, on = agentOnTask(ui, task), assignee = task.assignee && (ui.snap.specialists || []).find(agent => agent.id === task.assignee);
  const source = task.local ? { type: 'local', name: 'Rex Desk' } : (ui.snap.config?.sources || []).find(item => item.id === task.sourceId) || { type: task.source || '', name: task.sourceName || '' };
  const steps = task.checklist?.length ? `<span class="tk-check" title="Checklist">${task.checklist.filter(item => item.done).length}/${task.checklist.length}</span>` : '';
  const tags = (task.tags || []).slice(0, 3).map(tag => `<span class="tk-tag">${esc(tag)}</span>`).join('');
  const who = on?.agent ? `<span class="tk-who working" title="${esc(on.agent.name)} is working on it"><span class="dot working"></span>${esc(on.agent.name)}</span>` : assignee ? `<span class="tk-who">${esc(assignee.name)}</span>` : '<span class="tk-who none">—</span>';
  const due = task.dueDate ? `<span class="tk-due${task.dueDate < new Date().toISOString().slice(0, 10) && task.status !== 'done' ? ' late' : ''}">${esc(new Date(`${task.dueDate}T00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span>` : '<span class="tk-due none"></span>';
  const prio = task.priority === 'urgent' || task.priority === 'high' ? `<span class="tprio ${task.priority}">${task.priority === 'urgent' ? 'Urgent' : 'High'}</span>` : '';
  return `<button class="tk-row" data-open="task" data-id="${esc(task.id)}"><span class="tstat ${task.local ? STATUS_TONE[task.status] || '' : 'tracker'}" title="${esc(task.statusName || task.status || '')}"></span><span class="tnum">#${esc(taskNumber(task))}</span><span class="tk-title">${prio}<span class="tk-name">${esc(taskName(task))}</span>${steps}</span><span class="tk-src"><span class="src-mark mini ${esc(source.type)}" aria-hidden="true">${esc((source.name || '?')[0])}</span>${esc(task.local ? (task.projectSlug || 'Rex Desk') : task.projectName || source.name)}</span><span class="tk-status">${esc(task.statusName || task.status || '')}</span>${who}${due}</button>`;
}
export function tasksStage(ctx) {
  const { ui, esc } = ctx, everything = (ui.snap.tasks || []).filter(task => !task.demo && (task.active || task.local)), filter = String(ui.taskFilter || '').toLowerCase();
  const sources = ui.snap.config?.sources || [], syncs = new Map((ui.snap.sync || []).map(item => [item.sourceId, item]));
  const pick = ui.taskSource || 'all', inSource = task => pick === 'all' || (pick === 'local' ? task.local : task.sourceId === pick);
  const showDone = ui.taskDone === true, all = everything.filter(inSource).filter(task => showDone || task.status !== 'done');
  const shown = all.filter(task => !filter || `${taskNumber(task)} ${taskName(task)} ${task.title} ${task.statusName || task.status || ''} ${task.projectName || ''} ${(task.tags || []).join(' ')}`.toLowerCase().includes(filter));
  ensureNames(ctx, shown.filter(task => !task.local));
  const count = test => everything.filter(test).filter(task => showDone || task.status !== 'done').length;
  // Left: where tasks come from.
  const item = (id, mark, name, number, extra = '') => `<button class="tk-source${pick === id ? ' on' : ''}" data-action="task-source" data-source="${esc(id)}" aria-pressed="${pick === id}"><span class="src-mark mini ${esc(mark)}" aria-hidden="true">${esc(name[0])}</span><span class="tk-sname">${esc(name)}</span>${extra}<span class="tk-count">${number}</span></button>`;
  const connected = sources.map(source => { const sync = syncs.get(source.id); return item(source.id, source.type, source.name, count(task => task.sourceId === source.id), sync?.error ? `<span class="dot bad" title="${esc(sync.error)}"></span>` : ''); }).join('');
  const missing = [['flow', 'Flow'], ['morningmate', 'Morningmate'], ['orbit', 'Orbit']].filter(([type]) => !sources.some(source => source.type === type))
    .map(([type, name]) => type === 'orbit' ? `<button class="tk-connect" data-action="task-connect" data-service="orbit"><span class="src-mark mini orbit" aria-hidden="true">O</span>Connect ${name}</button>` : `<a class="tk-connect" href="/classic#connections"><span class="src-mark mini ${type}" aria-hidden="true">${name[0]}</span>Connect ${name}</a>`).join('');
  const side = `<aside class="tk-side"><h3>Sources</h3>${item('all', 'all', 'All tasks', count(() => true))}${item('local', 'local', 'Rex Desk tasks', count(task => task.local))}${connected}
    ${missing ? `<h3>Connect</h3>${missing}` : ''}<button class="btn small tk-manage" data-action="task-connect">Manage sources</button>
    <label class="tk-donebox"><input type="checkbox" data-task-done ${showDone ? 'checked' : ''}> Show done tasks</label></aside>`;
  // Right: add, then the tasks, Rex Desk ones by status and tracker ones by source.
  const projects = ui.memory?.projects || [];
  const add = pick === 'all' || pick === 'local' ? `<form class="tadd" data-task-add><input name="title" type="text" maxlength="200" placeholder="Add a task and press Enter" autocomplete="off" aria-label="New task title">${projects.length ? pickerHtml(ctx, { id: 'task-add-project', label: 'Project', value: ui.lastTaskProject || '', compact: true, items: [{ value: '', label: 'No project' }, ...projects.map(project => ({ value: project.slug, label: project.slug }))] }) : ''}<button class="btn primary small">Add</button></form>` : '';
  const head = '<div class="tk-head" aria-hidden="true"><span></span><span>#</span><span>Task</span><span>Project</span><span>Status</span><span>Agent</span><span>Due</span></div>';
  const group = (title, list) => list.length ? `<section class="tk-group"><h3>${esc(title)} <span>${list.length}</span></h3>${list.map(task => taskRow(ctx, task)).join('')}</section>` : '';
  const local = shown.filter(task => task.local), order = (left, right) => PRIORITY.findIndex(([key]) => key === left.priority) - PRIORITY.findIndex(([key]) => key === right.priority);
  const groups = STATUS.map(([status, label]) => group(label, local.filter(task => task.status === status).sort(order))).join('')
    + sources.map(source => group(source.name, shown.filter(task => task.sourceId === source.id))).join('');
  const empty = pick === 'local' ? '<div class="empty"><h2>No Rex Desk tasks yet</h2><p>Add one above, or ask an agent to make tasks for a project.</p></div>' : filter ? '<div class="empty"><h2>Nothing matches</h2><p>Try other words.</p></div>' : '<div class="empty"><h2>No tasks</h2><p>Add one above, connect a source on the left, or press Sync.</p></div>';
  return { title: 'Tasks', meta: `${everything.length} tasks`, top: true,
    members: `<div class="members tbar"><input id="task-filter" type="search" placeholder="Search tasks, numbers, tags…" value="${esc(ui.taskFilter || '')}" autocomplete="off"></div>`,
    feed: `<div class="page tk">${side}<div class="tk-main">${add}${shown.length ? `<div class="tk-list">${head}${groups}</div>` : empty}</div></div>` };
}

// The test evidence of one task: what agents shared and what their runs on it recorded, newest first.
function evidenceHtml(ctx, task) {
  const { ui, esc } = ctx, runs = new Set((ui.snap.runs || []).filter(run => run.taskId === task.id).map(run => run.id));
  const items = (ui.snap.artifacts || []).filter(item => item.taskId === task.id || runs.has(item.runId)).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const when = at => at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const card = item => {
    const url = `/artifacts/${item.runId}/${encodeURIComponent(item.file)}`, type = item.type || '', result = item.result || (/^Passing/.test(item.title || '') ? 'passed' : /^Failing/.test(item.title || '') ? 'failed' : '');
    const look = /^image\//.test(type) ? `<img src="${esc(url)}" alt="${esc(item.title)}" loading="lazy">` : /^video\//.test(type) ? `<video src="${esc(url)}" preload="metadata" muted></video>` : '';
    return `<li><a class="${look ? 'ev-thumb' : 'ev-file'}" href="${esc(url)}" target="_blank" rel="noopener noreferrer"${item.page ? ` data-page-open="${esc(url)}"` : ''}>${look || esc((item.file.split('.').pop() || 'file').toUpperCase())}</a>${result === 'passed' || result === 'failed' ? `<span class="ev-res ${result}">${result === 'passed' ? 'Passed' : 'Failed'}</span>` : ''}<b>${esc(item.title || item.file)}</b>${item.note ? `<small>${esc(item.note)}</small>` : ''}<small>${esc([item.from, when(item.createdAt)].filter(Boolean).join(' · '))}</small></li>`;
  };
  return `<section class="tp-sec lt-sec"><h3>Test evidence${items.length ? ` <span>${items.length}</span>` : ''}</h3>${items.length ? `<ul class="tp-ev">${items.slice(0, 60).map(card).join('')}</ul>` : '<p class="muted small">Nothing yet. When an agent tests this task, its screenshots, recordings and test results show here.</p>'}</section>`;
}
export function taskStage(ctx) {
  const { ui, esc, markdown } = ctx, task = (ui.snap.tasks || []).find(item => item.id === ui.view.id);
  if (!task) return { title: 'Task', meta: '', feed: '<div class="empty"><h2>That task is gone.</h2></div>' };
  if (task.local) return localTaskStage(ctx, task);
  ensureNames(ctx, [task]);
  const on = agentOnTask(ui, task), agents = ui.snap.specialists || [], rooms = ui.snap.rooms || [];
  const assign = on?.agent
    ? `<p class="assigned"><span class="dot working"></span><strong>${esc(on.agent.name)}</strong> is working on this. <button class="btn small" data-open="run" data-id="${esc(on.run.id)}">Open the work</button></p>`
    : agents.length ? `<div class="assign"><label>Assign to${pickerHtml(ctx, { id: 'assign-agent', label: 'Assign to', searchable: agents.length > 6, value: agents.find(agent => agent.status?.state !== 'busy')?.id || '', items: agents.map(agent => ({ value: agent.id, label: agent.name, hint: agent.projectSlug, meta: agent.status?.state === 'busy' ? 'busy' : '', disabled: agent.status?.state === 'busy' })) })}</label>
        <label>Tell this room${pickerHtml(ctx, { id: 'assign-room', label: 'Tell this room', value: '', items: [{ value: '', label: 'No room' }, ...rooms.map(room => ({ value: room.id, label: room.name, hint: `${room.members.length} agents` }))] })}</label>
        <button class="btn primary" data-action="task-assign" data-id="${esc(task.id)}">Assign</button></div>` : '<p class="muted">Create an agent first (the + next to Agents), then assign this task to it.</p>';
  const source = (ui.snap.config?.sources || []).find(item => item.id === task.sourceId) || { type: task.source || '', name: task.sourceName || '' };
  const rank = (ui.snap.priorities || []).findIndex(item => item.taskId === task.id || item.id === task.id), jev = task.jev || task.priority?.jev || null;
  const when = value => value ? new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const fact = (label, value) => value ? `<div class="tp-fact"><span>${label}</span><b>${value}</b></div>` : '';
  const comments = (task.comments || []).filter(item => item && (item.text || item.content || item.body));
  const side = `<aside class="tp-side">
    <section class="tp-box"><h3>Work on it</h3>${assign}</section>
    <section class="tp-box">
      ${fact('Status', esc(task.statusName || task.status || ''))}
      ${fact('Source', `<span class="src-mark mini ${esc(source.type)}" aria-hidden="true">${esc((source.name || '?')[0])}</span> ${esc(source.name)}`)}
      ${fact('Project', esc(task.projectName || ''))}
      ${fact('Reporter', esc(task.reporter || ''))}
      ${fact('Assignees', esc((task.assignees || []).join(', ')))}
      ${fact('Due', esc(when(task.dueDate)))}
      ${fact('Created', esc(when(task.createdAt)))}
      ${rank >= 0 ? fact('Jev rank', `#${rank + 1} in the queue`) : ''}
      ${task.url ? `<a class="btn small tp-open" href="${esc(task.url)}" target="_blank" rel="noopener noreferrer">Open in ${esc(source.name || 'the tracker')}</a>` : ''}
    </section></aside>`;
  const main = `<div class="tp-main"><div class="tp-head"><span class="tnum">#${esc(taskNumber(task))}</span><h1>${esc(taskName(task))}</h1>${task.titleEn && task.titleEn !== task.title ? `<p class="orig">${esc(task.title)}</p>` : ''}</div>
    ${jev?.summary || jev?.reason ? `<p class="tp-jev">${esc(jev.summary || jev.reason)}</p>` : ''}
    <section class="tp-sec"><h3>Description</h3><div class="md tp-desc">${markdown(String(task.description || 'No description.').slice(0, 12000))}</div></section>
    ${evidenceHtml(ctx, task)}
    ${comments.length ? `<section class="tp-sec"><h3>Comments <span>${comments.length}</span></h3><ol class="lt-comments">${comments.slice(-30).map(item => `<li><div><strong>${esc(item.author || item.by || item.name || 'Someone')}</strong> <time>${esc(when(item.createdAt || item.at || item.date))}</time></div><div class="md">${markdown(String(item.text || item.content || item.body).slice(0, 3000))}</div></li>`).join('')}</ol></section>` : ''}</div>`;
  return { title: `#${taskNumber(task)} ${taskName(task)}`, meta: task.statusName || task.status || '', top: true, feed: `<div class="page tp">${main}${side}</div>` };
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
  document.addEventListener('click', event => { if (ctx.ui.agentsPop && !event.target.closest('.agents-pop-host, .pop')) { ctx.ui.agentsPop = false; fillAgentsPop(ctx); } });
  // The agents popup: an AI or model picked for a member is saved on that agent at once.
  document.addEventListener('change', async event => {
    const match = /^ra-(provider|model)-(.+)$/.exec(event.target.id || ''); if (!match) return;
    const [, field, id] = match, agent = id === 'main' ? ctx.ui.snap.mainAgent : (ctx.ui.snap.specialists || []).find(item => item.id === id); if (!agent) return;
    if (field === 'provider' && (agent.provider || 'claude') === event.target.value) return;
    try {
      await ctx.api(`/specialists/${id}`, { method: 'PUT', data: field === 'provider' ? { provider: event.target.value } : { model: event.target.value } });
      delete ctx.ui.picks?.[`ra-provider-${id}`]; delete ctx.ui.picks?.[`ra-model-${id}`];
      ctx.toast(field === 'provider' ? `${agent.name} now runs on ${event.target.value === 'codex' ? 'Codex' : event.target.value === 'gemini' ? 'Gemini' : 'Claude Code'}.` : `${agent.name}'s model saved.`);
      await ctx.refresh({ full: true }); fillAgentsPop(ctx);
    } catch (error) { ctx.toast(error.message, true); }
  });
  document.addEventListener('keydown', event => { if (event.target.id === 'room-name' && event.key === 'Enter') { event.preventDefault(); event.target.blur(); } });
}

// ---------- actions ----------
// The AI and model of each member, in a popup above the message box. Filled when it opens, and again after a change is saved.
function fillAgentsPop(ctx) {
  const pop = document.getElementById('agents-pop'), room = (ctx.ui.snap.rooms || []).find(item => item.id === ctx.ui.view.id); if (!pop || !room) return;
  pop.hidden = !ctx.ui.agentsPop; pop.innerHTML = ctx.ui.agentsPop ? roomAgentsHtml(ctx, room) : '';
}
export async function roomAction(ctx, action, target) {
  const { ui, api, toast, refresh } = ctx;
  if (action === 'agents-pop') { ui.agentsPop = !ui.agentsPop; fillAgentsPop(ctx); return; }
  if (action === 'side-tab') { ui.sideTab = target.dataset.tab; ctx.render(); return; }
  if (action === 'room-shared') { ui.roomShared = target.dataset.tab; ctx.render(); return; }
  if (action === 'info-toggle') { ui.infoOpen = ui.infoOpen === false; ctx.render(); return; }
  if (action === 'room-image') { document.getElementById('room-image-input')?.click(); return; }
  if (action === 'room-delete') {
    const room = ui.snap.rooms.find(item => item.id === ui.view.id);
    if (room && confirm(`Delete the room "${room.name}" and its messages? The agents and their sessions stay.`)) { await api(`/rooms/${room.id}`, { method: 'DELETE' }); ctx.open('main'); }
    return;
  }
  if (action === 'room-stop') { await api(`/runs/${target.dataset.run}/stop`, { method: 'POST', data: {} }); toast('Stopped.'); await refresh(); return; }
  if (action === 'room-remove') { await api(`/rooms/${ui.view.id}/members/${target.dataset.id}`, { method: 'DELETE' }); await refresh(); }
  else if (action === 'task-assign') {
    const agentId = document.getElementById('assign-agent')?.value, roomId = document.getElementById('assign-room')?.value || '';
    if (!agentId) return toast('Pick an agent first.', true);
    const given = await api(`/specialists/${agentId}/assign`, { method: 'POST', data: { taskId: target.dataset.id, roomId } }); if (given?.queued) ctx.toast(given.message);
    toast('Assigned. The agent starts on it now.'); await refresh();
  }
}

// ---------- a Rex Desk task, edited in place ----------
function localTaskStage(ctx, task) {
  const { ui, esc, markdown } = ctx, agents = ui.snap.specialists || [], tasks = (ui.snap.tasks || []).filter(item => item.local);
  const on = agentOnTask(ui, task), parent = task.parentTaskId && tasks.find(item => item.id === task.parentTaskId), children = tasks.filter(item => item.parentTaskId === task.id);
  const blockers = (task.blockedBy || []).map(id => tasks.find(item => item.id === id)).filter(Boolean);
  const projects = ui.memory?.projects || [], when = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const field = (label, control) => `<label class="lt-field"><span>${label}</span>${control}</label>`;
  const side = `<aside class="lt-side">
    ${field('Status', pickerHtml(ctx, { id: 'lt-status', label: 'Status', value: task.status, items: STATUS.map(([value, label]) => ({ value, label })) }))}
    ${field('Priority', pickerHtml(ctx, { id: 'lt-priority', label: 'Priority', value: task.priority || 'normal', items: PRIORITY.map(([value, label]) => ({ value, label })) }))}
    ${field('Agent', pickerHtml(ctx, { id: 'lt-assignee', label: 'Agent', value: task.assignee || '', items: [{ value: '', label: 'Nobody yet' }, ...agents.map(agent => ({ value: agent.id, label: agent.name, hint: agent.projectSlug }))] }))}
    ${field('Project', pickerHtml(ctx, { id: 'lt-project', label: 'Project', value: task.projectSlug || '', items: [{ value: '', label: 'No project' }, ...projects.map(project => ({ value: project.slug, label: project.slug }))] }))}
    ${field('Due', `<input id="lt-due" type="date" value="${esc(task.dueDate || '')}">`)}
    ${field('Tags', `<input id="lt-tags" type="text" value="${esc((task.tags || []).join(', '))}" placeholder="ui, bug" autocomplete="off">`)}
    <p class="lt-made">Made by ${esc(task.createdBy || 'you')} · ${esc(when(task.createdAt))}</p>
    <button class="btn small danger" data-action="lt-delete" data-id="${esc(task.id)}">Delete task</button>
  </aside>`;
  const checklist = `<section class="lt-sec"><h3>Checklist${task.checklist?.length ? ` <span>${task.checklist.filter(item => item.done).length} of ${task.checklist.length}</span>` : ''}</h3>
    <ul class="lt-check">${(task.checklist || []).map((item, index) => `<li><label><input type="checkbox" data-lt-check="${index}" ${item.done ? 'checked' : ''}><span>${esc(item.text)}</span></label><button class="ag-x" data-action="lt-check-remove" data-index="${index}" aria-label="Remove this item" title="Remove"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></li>`).join('')}</ul>
    <form class="lt-inline" data-lt-check-add><input name="text" type="text" maxlength="300" placeholder="Add a step…" autocomplete="off" aria-label="Add a checklist step"></form></section>`;
  const links = parent || children.length || blockers.length ? `<section class="lt-sec"><h3>Linked tasks</h3><ul class="lt-links">${parent ? `<li>Part of <a href="#" data-open="task" data-id="${esc(parent.id)}">#${esc(parent.taskNumber)} ${esc(parent.title)}</a></li>` : ''}${children.map(child => `<li>Subtask <a href="#" data-open="task" data-id="${esc(child.id)}">#${esc(child.taskNumber)} ${esc(child.title)}</a> · ${esc(child.statusName)}</li>`).join('')}${blockers.map(blocker => `<li>Waits for <a href="#" data-open="task" data-id="${esc(blocker.id)}">#${esc(blocker.taskNumber)} ${esc(blocker.title)}</a> · ${esc(blocker.statusName)}</li>`).join('')}</ul></section>` : '';
  const comments = `<section class="lt-sec"><h3>Comments</h3>${(task.comments || []).length ? `<ol class="lt-comments">${task.comments.map(comment => `<li><div><strong>${esc(comment.by)}</strong> <time>${esc(when(comment.at))}</time></div><div class="md">${markdown(comment.text)}</div></li>`).join('')}</ol>` : '<p class="muted small">No comments yet. Agents write here what they did and found.</p>'}
    <form class="lt-inline" data-lt-comment><textarea name="text" rows="2" placeholder="Write a comment…" aria-label="Write a comment"></textarea><button class="btn small">Comment</button></form></section>`;
  const work = on?.agent ? `<p class="assigned"><span class="dot working"></span><strong>${esc(on.agent.name)}</strong> is working on this. <button class="btn small" data-open="run" data-id="${esc(on.run.id)}">Open the work</button></p>`
    : task.assignee && agents.some(agent => agent.id === task.assignee) ? `<p class="lt-start"><button class="btn primary small" data-action="lt-start" data-id="${esc(task.id)}">Start ${esc(agents.find(agent => agent.id === task.assignee).name)} on this</button></p>` : '';
  const main = `<div class="lt-main"><textarea id="lt-title" class="lt-title" rows="1" maxlength="200" aria-label="Task title">${esc(task.title)}</textarea>
    ${work}<section class="lt-sec"><h3>Description</h3><textarea id="lt-desc" class="lt-desc" placeholder="What needs doing, and how to tell it is done.">${esc(task.description || '')}</textarea></section>${checklist}${evidenceHtml(ctx, task)}${links}${comments}</div>`;
  return { title: `#${task.taskNumber} ${task.title}`, meta: `Rex Desk task · ${task.statusName}`, top: true, feed: `<div class="page lt" data-lt="${esc(task.id)}">${main}${side}</div>` };
}
// Every change saves at once: pickers when chosen, text when you leave the field.
export function initLocalTasks(ctx) {
  const { api, toast, refresh, ui } = ctx;
  const current = () => (ui.snap.tasks || []).find(item => item.id === ui.view.id && item.local);
  const save = async data => { const task = current(); if (!task) return; try { await api(`/local-tasks/${encodeURIComponent(task.id)}`, { method: 'PUT', data }); await refresh(); } catch (error) { toast(error.message, true); await refresh({ full: true }); } };
  document.addEventListener('change', event => {
    const id = event.target.id, value = event.target.value;
    if (id === 'lt-status') void save({ status: value });
    else if (id === 'lt-priority') void save({ priority: value });
    else if (id === 'lt-assignee') void save({ assignee: value });
    else if (id === 'lt-project') void save({ project: value });
    else if (id === 'lt-due') void save({ dueDate: value });
    else if (id === 'task-add-project') ui.lastTaskProject = value;
    else if (event.target.dataset.ltCheck !== undefined) { const task = current(); if (task) void save({ checklist: task.checklist.map((item, index) => index === Number(event.target.dataset.ltCheck) ? { ...item, done: event.target.checked } : item) }); }
  });
  document.addEventListener('focusout', event => {
    const task = current(); if (!task) return;
    if (event.target.id === 'lt-title' && event.target.value.trim() && event.target.value.trim() !== task.title) void save({ title: event.target.value });
    if (event.target.id === 'lt-desc' && event.target.value !== (task.description || '')) void save({ description: event.target.value });
    if (event.target.id === 'lt-tags' && event.target.value !== (task.tags || []).join(', ')) void save({ tags: event.target.value });
  });
  document.addEventListener('keydown', event => {
    if (event.target.id === 'lt-title' && event.key === 'Enter') { event.preventDefault(); event.target.blur(); }
    if (event.target.closest?.('[data-lt-comment]') && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); event.target.form.requestSubmit(); }
  });
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (form.matches('[data-task-add]')) {
      event.preventDefault(); const title = form.title.value.trim(); if (!title) return;
      try { await api('/local-tasks', { method: 'POST', data: { title, project: ui.lastTaskProject || '' } }); form.title.value = ''; ui.taskSource = ui.taskSource === 'all' || !ui.taskSource ? ui.taskSource : 'local'; await refresh(); document.querySelector('[data-task-add] input')?.focus(); } catch (error) { toast(error.message, true); }
    } else if (form.matches('[data-lt-check-add]')) {
      event.preventDefault(); const task = current(), text = form.text.value.trim(); if (!task || !text) return;
      form.text.value = ''; await api(`/local-tasks/${encodeURIComponent(task.id)}`, { method: 'PUT', data: { checklist: [...(task.checklist || []), { text, done: false }] } }).catch(error => toast(error.message, true));
      await refresh({ full: true }); document.querySelector('[data-lt-check-add] input')?.focus();
    } else if (form.matches('[data-lt-comment]')) {
      event.preventDefault(); const task = current(), text = form.text.value.trim(); if (!task || !text) return;
      try { await api(`/local-tasks/${encodeURIComponent(task.id)}/comments`, { method: 'POST', data: { text } }); form.text.value = ''; document.activeElement?.blur(); await refresh({ full: true }); } catch (error) { toast(error.message, true); }
    }
  }, true);
  document.addEventListener('click', async event => {
    const target = event.target.closest?.('[data-action]'); if (!target) return;
    const action = target.dataset.action;
    if (action === 'task-source') { event.stopPropagation(); ui.taskSource = target.dataset.source; ctx.render(); return; }
    const task = current(); if (!task) return;
    if (action === 'lt-check-remove') { event.stopPropagation(); void save({ checklist: task.checklist.filter((_, index) => index !== Number(target.dataset.index)) }); }
    else if (action === 'lt-delete') {
      event.stopPropagation(); if (!confirm(`Delete #${task.taskNumber} "${task.title}"? Its comments go with it.`)) return;
      try { await api(`/local-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }); ctx.open('tasks'); } catch (error) { toast(error.message, true); }
    } else if (action === 'lt-start') {
      event.stopPropagation();
      try { await api(`/specialists/${task.assignee}/assign`, { method: 'POST', data: { taskId: task.id, roomId: '' } }); toast('Started.'); await refresh(); } catch (error) { toast(error.message, true); }
    }
  }, true);
}

// ---------- where tasks come from: Rex Desk (built in), Orbit, Flow, Morningmate ----------
const SERVICE = { orbit: 'Orbit', flow: 'Flow', morningmate: 'Morningmate' };
function connectionsDialog(ctx, startWith = '') {
  const { ui, esc, api, toast, refresh } = ctx;
  document.querySelector('.dialog-back.sources')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back sources';
  const draw = (mode = 'list', editing = null) => {
    const sources = ui.snap.config?.sources || [], syncs = new Map((ui.snap.sync || []).map(item => [item.sourceId, item]));
    const row = source => { const sync = syncs.get(source.id); return `<li><span class="src-mark ${esc(source.type)}" aria-hidden="true">${esc((SERVICE[source.type] || '?')[0])}</span><span class="src-text"><b>${esc(source.name)}</b><small>${esc(SERVICE[source.type] || source.type)} · ${sync?.error ? `<span class="bad">${esc(sync.error)}</span>` : sync ? `${sync.count} tasks` : 'not synced yet'}${source.hasKey ? '' : ' · no key'}</small></span>${source.type === 'orbit' ? `<button type="button" class="btn small" data-src-edit="${esc(source.id)}">Change</button>` : ''}<button type="button" class="btn small quiet danger" data-src-remove="${esc(source.id)}">Remove</button></li>`; };
    const list = `<h2>Task sources</h2><p class="muted">Agents read tasks from these. Each agent uses only the sources you tick on its card.</p>
      <ul class="src-list"><li><span class="src-mark local" aria-hidden="true">R</span><span class="src-text"><b>Rex Desk tasks</b><small>Built in · kept on this computer · ${(ui.snap.tasks || []).filter(task => task.local).length} tasks</small></span></li>${sources.map(row).join('')}</ul>
      <div class="src-add"><span class="muted">Connect another:</span><button type="button" class="btn small primary" data-src-new="orbit">Orbit goal (tasks)</button><a class="btn small" href="/classic#connections">Flow or Morningmate</a></div>
      <h3 class="src-h">Orbit account</h3><div class="src-account" data-orbit-account><p class="muted">Checking…</p></div>
      <div class="row"><button type="button" class="btn" data-close>Done</button></div>`;
    const form = `<h2>${editing ? `Change ${esc(editing.name)}` : 'Connect an Orbit goal'}</h2><p class="muted">Brings one goal's tasks into Tasks. For your goals, notes and knowledge in every agent, use the Orbit account sign-in instead. One Orbit goal per connection. In Orbit open the goal, then Settings → API → Generate Project Key, and paste the key (it starts with dgm_).</p>
      <label>Name<input name="name" type="text" maxlength="80" value="${esc(editing?.name || 'Orbit')}" required></label>
      <label>Project key<input name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${editing?.hasKey ? 'Saved. Paste a new key to replace it.' : 'dgm_…'}" ${editing ? '' : 'required'}></label>
      <label>Bring in<select name="statusFilter">${[['active', 'Work that is on: To do, In progress, In review, Blocked'], ['unfinished', 'Everything not done, with the backlog'], ['all', 'Everything, done too']].map(([value, label]) => `<option value="${value}" ${(editing?.statusFilter || 'active') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <details><summary>Orbit address</summary><label>Address<input name="baseUrl" type="url" value="${esc(editing?.baseUrl || 'https://orbitkh.vercel.app')}"></label></details>
      <div class="row"><button class="btn primary">${editing ? 'Save and sync' : 'Connect and sync'}</button><button type="button" class="btn" data-src-back>Back</button></div>`;
    back.innerHTML = `<form class="dialog src-dialog" data-mode="${mode}" ${editing ? `data-id="${esc(editing.id)}"` : ''}>${mode === 'list' ? list : form}</form>`;
    (back.querySelector('input[name=apiKey]') || back.querySelector('button'))?.focus();
  };
  draw(startWith ? 'form' : 'list'); document.body.append(back); void drawOrbitAccount(ctx, back);
  back.addEventListener('click', async event => {
    const target = event.target;
    if (target === back || target.closest('[data-close]')) { back.remove(); return; }
    if (target.closest('[data-src-back]')) { draw(); void drawOrbitAccount(ctx, back); return; }
    if (target.closest('[data-orbit-signin]')) { void orbitSignIn(ctx, back); return; }
    if (target.closest('[data-orbit-signout]')) { await api('/orbit/account', { method: 'DELETE' }); void drawOrbitAccount(ctx, back); return; }
    const create = target.closest('[data-src-new]'); if (create) { draw('form'); return; }
    const edit = target.closest('[data-src-edit]'); if (edit) { draw('form', (ui.snap.config?.sources || []).find(item => item.id === edit.dataset.srcEdit)); return; }
    const remove = target.closest('[data-src-remove]');
    if (remove) {
      const source = (ui.snap.config?.sources || []).find(item => item.id === remove.dataset.srcRemove);
      if (!source || !confirm(`Remove ${source.name}? Its tasks leave the list; nothing changes in ${SERVICE[source.type] || 'the tracker'}.`)) return;
      try { await api(`/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' }); await refresh({ full: true }); draw(); } catch (error) { toast(error.message, true); }
    }
  });
  back.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target; if (form.dataset.mode !== 'form') return;
    const data = Object.fromEntries(new FormData(form)), button = form.querySelector('.btn.primary');
    button.disabled = true; button.textContent = 'Checking the key…';
    try {
      const result = await api('/sources/orbit', { method: 'POST', data: { ...data, id: form.dataset.id || '' } });
      toast(result.sync?.error ? `Connected, but the sync failed: ${result.sync.error}` : `${result.source.name}: ${result.sync?.count ?? 0} tasks brought in.`, Boolean(result.sync?.error));
      await refresh({ full: true }); draw();
    } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = form.dataset.id ? 'Save and sync' : 'Connect and sync'; }
  });
}
document.addEventListener('click', event => { const button = event.target.closest?.('[data-action="task-connect"]'); if (!button) return; event.stopPropagation(); const ctx = window.__rexCtx; if (ctx) connectionsDialog(ctx, button.dataset.service || ''); }, true);

// Media, Files and Links tabs, each with how many there are.
export function sharedTabButtons(shared, tab, action = 'side-tab') {
  const count = sharedCount(shared);
  return [['media', 'Media'], ['files', 'Files'], ['links', 'Links']].map(([key, label]) => `<button type="button" class="tab ${tab === key ? 'on' : ''}" data-action="${action}" data-tab="${key}">${label}${count[key] ? `<span class="tcount quiet">${count[key]}</span>` : ''}</button>`).join('');
}

// The task connectors, as cards at the top of Tasks: Rex Desk (built in), Flow, Morningmate and Orbit.
// A connected one shows how many tasks it brought in and filters the list when clicked; the others offer to connect.
function connectorsHtml(ctx, tasks) {
  const { ui, esc } = ctx, sources = ui.snap.config?.sources || [], syncs = new Map((ui.snap.sync || []).map(item => [item.sourceId, item])), pick = ui.taskSource || 'all';
  const count = id => tasks.filter(task => id === 'local' ? task.local : task.sourceId === id).length, many = id => `${count(id)} task${count(id) === 1 ? '' : 's'}`;
  const card = ({ id, mark, name, kind, detail, bad = false, action }) => `<div class="cn-card${pick === id ? ' on' : ''}${id ? '' : ' off'}">${id ? `<button type="button" class="cn-main" data-action="task-source" data-source="${esc(id)}" aria-pressed="${pick === id}">` : '<div class="cn-main">'}<span class="src-mark ${esc(mark)}" aria-hidden="true">${esc(kind[0])}</span><span class="cn-text"><b>${esc(name)}</b><small class="${bad ? 'bad' : ''}">${esc(detail)}</small></span>${id ? '</button>' : '</div>'}${action || ''}</div>`;
  const cards = [card({ id: 'local', mark: 'local', name: 'Rex Desk tasks', kind: 'Rex', detail: `Built in · ${many('local')}` })];
  for (const source of sources) {
    const sync = syncs.get(source.id);
    cards.push(card({ id: source.id, mark: source.type, name: source.name, kind: SERVICE[source.type] || source.type,
      detail: sync?.error ? sync.error : `${SERVICE[source.type] || source.type} · ${many(source.id)}${sync?.at ? '' : ' · not synced yet'}`, bad: Boolean(sync?.error),
      action: source.type === 'orbit' ? '<button type="button" class="btn small quiet" data-action="task-connect">Manage</button>' : '<a class="btn small quiet" href="/classic#connections">Manage</a>' }));
  }
  for (const [type, hint] of [['flow', 'Issues assigned to you in Flow'], ['morningmate', 'Issues assigned to you in Morningmate'], ['orbit', 'Tasks of an Orbit goal']])
    if (!sources.some(source => source.type === type)) cards.push(card({ id: '', mark: type, name: SERVICE[type], kind: SERVICE[type], detail: hint,
      action: type === 'orbit' ? '<button type="button" class="btn small primary" data-action="task-connect" data-service="orbit">Connect</button>' : '<a class="btn small primary" href="/classic#connections">Connect</a>' }));
  return `<section class="cn"><div class="cn-head"><h2>Connectors</h2><button type="button" class="btn small" data-action="task-connect">Manage sources</button></div><div class="cn-grid">${cards.join('')}</div></section>`;
}

// ---------- away mode: the agents keep going while you are away ----------
function awayDialog(ctx, room) {
  const { esc, api, toast, refresh } = ctx;
  const back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog away-dialog"><h2>Away mode</h2>
    <p class="muted">The agents in ${esc(room.name)} find unfinished tasks, try to finish them, and work together with each other while you are away. ${esc(room.members.some(member => member.id === 'main') ? 'Rex Agent' : room.members[0]?.name || 'The first agent')} leads: it checks in on a schedule and hands out the next step. Risky things (push, merge, deleting data, production, messages to other people) wait for you. Writing in the room ends it, and you get a "While you were away" summary.</p>
    <label>What should they work on? (optional)<textarea name="goal" rows="2" maxlength="600" placeholder="Leave empty to let them find unfinished tasks. Or: finish the database move, then test the login"></textarea></label>
    <div class="away-row"><label>For<select name="hours"><option value="0">Until I am back</option><option value="1">1 hour</option><option value="3">3 hours</option><option value="8" selected>8 hours</option><option value="24">24 hours</option></select></label>
    <label>Check in every<select name="every"><option value="auto" selected>Auto: the lead decides</option><option value="10">10 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option></select></label></div>
    <div class="row"><button class="btn primary">Start away mode</button><button type="button" class="btn" data-close>Cancel</button></div></form>`;
  document.body.append(back); back.querySelector('textarea').focus();
  back.addEventListener('click', event => { if (event.target === back || event.target.closest('[data-close]')) back.remove(); });
  back.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
    try { await api(`/rooms/${room.id}/away`, { method: 'PUT', data: { on: true, goal: data.goal, hours: Number(data.hours), every: data.every === 'auto' ? 'auto' : Number(data.every) } }); back.remove(); toast('Away mode is on. See you later.'); await refresh(); }
    catch (error) { toast(error.message, true); }
  });
}
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-action="away-start"],[data-action="away-stop"]'); if (!button) return;
  event.stopPropagation(); const ctx = window.__rexCtx; if (!ctx) return;
  const room = (ctx.ui.snap.rooms || []).find(item => item.id === ctx.ui.view.id); if (!room) return;
  if (button.dataset.action === 'away-start') return awayDialog(ctx, room);
  try { await ctx.api(`/rooms/${room.id}/away`, { method: 'PUT', data: { on: false } }); await ctx.refresh(); } catch (error) { ctx.toast(error.message, true); }
}, true);

document.addEventListener('change', event => { if (!event.target.matches?.('[data-task-done]')) return; const ctx = window.__rexCtx; if (!ctx) return; ctx.ui.taskDone = event.target.checked; ctx.render(); });

// The Orbit account (goals, notes, knowledge for every agent): sign in once with a short code approved on Orbit.
async function drawOrbitAccount(ctx, back) {
  const box = back.querySelector('[data-orbit-account]'); if (!box) return;
  const account = await ctx.api('/orbit/account').catch(() => ({ connected: false }));
  box.innerHTML = account.connected
    ? `<p><span class="dot good"></span> Connected since ${ctx.esc(new Date(account.since).toLocaleDateString([], { month: 'short', day: 'numeric' }))}. Every agent can search and read your Orbit goals, notes and knowledge.</p><button type="button" class="btn small quiet danger" data-orbit-signout>Disconnect</button>`
    : '<p class="muted">Give every agent your Orbit goals, notes and knowledge (search, read, add notes). You approve it once in Orbit; no key to copy.</p><button type="button" class="btn small primary" data-orbit-signin>Sign in to Orbit</button>';
}
async function orbitSignIn(ctx, back) {
  const box = back.querySelector('[data-orbit-account]'); if (!box) return;
  try {
    const login = await ctx.api('/orbit/account/start', { method: 'POST', data: {} });
    box.innerHTML = `<p>Open Orbit and approve this code:</p><p class="orbit-code">${ctx.esc(login.userCode)}</p><p><a class="btn small primary" href="${ctx.esc(login.url)}" target="_blank" rel="noopener noreferrer">Open Orbit to approve</a> <span class="muted small">Waiting for you to approve…</span></p>`;
    window.open(login.url, '_blank', 'noopener');
    const until = Date.now() + login.expiresIn * 1000;
    while (Date.now() < until && document.body.contains(box)) {
      await new Promise(resolve => setTimeout(resolve, login.interval * 1000));
      const result = await ctx.api('/orbit/account/poll', { method: 'POST', data: {} });
      if (result.connected) { ctx.toast('Orbit connected. Agents can use your goals and notes from their next reply.'); return drawOrbitAccount(ctx, back); }
    }
    if (document.body.contains(box)) box.innerHTML = '<p class="bad">The code expired before it was approved.</p><button type="button" class="btn small" data-orbit-signin>Try again</button>';
  } catch (error) { ctx.toast(error.message, true); void drawOrbitAccount(ctx, back); }
}

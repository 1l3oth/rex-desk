// Worktrees: the history of git worktrees in the person's projects, and the tasks that live in each one.
// The same card shows on the Worktrees screen and inside a chat, where an agent posts it with desk_worktree.

const taskName = task => task.titleEn || task.title;
const taskNumber = task => String(task.taskNumber || task.externalId || '');
const BRANCH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3.4-11.2 6.8"/></svg>';
const since = at => { if (!at) return ''; const minutes = Math.max(1, Math.round((Date.now() - Date.parse(at)) / 60000)); return minutes < 60 ? `${minutes} min ago` : minutes < 2880 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`; };
const all = ui => ui.snap?.worktrees || [];
const byId = (ui, id) => all(ui).find(item => item.id === id);

export const WORKTREE_ICON = BRANCH;

function taskRow(ctx, item, taskId) {
  const { esc, ui } = ctx, task = (ui.snap.tasks || []).find(entry => entry.id === taskId);
  const label = task ? `${taskName(task)}` : 'A task that is no longer here', number = task ? taskNumber(task) : '';
  return `<li class="wt-task">${task ? `<button type="button" class="wt-task-open" data-open="task" data-id="${esc(task.id)}" title="Open the task">` : '<span class="wt-task-open">'}${number ? `<span class="tnum">#${esc(number)}</span>` : ''}<span class="wt-task-name">${esc(label)}</span>${task?.status ? `<span class="wt-task-state">${esc(String(task.statusName || task.status).replace(/_/g, ' '))}</span>` : ''}${task ? '</button>' : '</span>'}
    <button type="button" class="wt-x" data-wt-act="remove" data-wt="${esc(item.id)}" data-task="${esc(taskId)}" title="Take this task out of the worktree" aria-label="Take ${esc(label)} out of the worktree">×</button></li>`;
}

// One worktree. compact: the card inside a chat message.
export function worktreeCard(ctx, item, { compact = false, side = false } = {}) {
  const { esc, ui } = ctx, gone = item.state === 'gone', tasks = item.tasks || [];
  const free = (ui.snap.tasks || []).filter(task => task.active && !task.demo && !tasks.includes(task.id));
  const who = [item.project, item.createdBy ? `made by ${item.createdBy}` : '', since(item.createdAt)].filter(Boolean).join(' · ');
  return `<article class="wt-card${gone ? ' gone' : ''}${compact ? ' compact' : ''}${side ? ' side' : ''}" data-wt-id="${esc(item.id)}">
    <header class="wt-head"><span class="wt-icon">${BRANCH}</span><div class="wt-title"><b title="${esc(item.branch || '')}">${esc(item.branch || 'No branch (detached)')}</b><small>${esc(who)}</small></div>
      <span class="chip ${gone ? '' : 'good'}">${gone ? 'Removed' : 'In use'}</span></header>
    <button type="button" class="wt-path" data-wt-act="copy" data-path="${esc(item.path)}" title="Copy the folder">${esc(item.path)}</button>
    <div class="wt-tasks"><span class="wt-label">Tasks in it <span class="cnt">${tasks.length}</span></span>
      ${tasks.length ? `<ul>${tasks.map(taskId => taskRow(ctx, item, taskId)).join('')}</ul>` : '<p class="muted small wt-none">No task yet.</p>'}
      ${gone || !free.length ? '' : `<label class="wt-add"><span class="sr">Add a task to this worktree</span><select data-wt-add="${esc(item.id)}"><option value="">+ Add a task</option>${free.map(task => `<option value="${esc(task.id)}">#${esc(taskNumber(task))} ${esc(taskName(task)).slice(0, 80)}</option>`).join('')}</select></label>`}
    </div>
    ${compact ? `<footer class="wt-foot"><button type="button" class="btn small" data-open="worktrees" data-id="${esc(item.id)}">All worktrees</button></footer>` : ''}
  </article>`;
}

export function worktreesStage(ctx) {
  const { ui, esc } = ctx, items = all(ui), filter = ui.wtProject || '';
  const projects = [...new Set(items.map(item => item.project).filter(Boolean))].sort();
  const shown = items.filter(item => !filter || item.project === filter), active = shown.filter(item => item.state !== 'gone'), gone = shown.filter(item => item.state === 'gone');
  const chips = projects.length > 1 ? `<div class="wt-filter" role="group" aria-label="Project">${['', ...projects].map(name => `<button type="button" class="chip-btn small${name === filter ? ' on' : ''}" data-wt-act="filter" data-project="${esc(name)}">${esc(name || 'All projects')}</button>`).join('')}</div>` : '';
  const grid = list => `<div class="wt-grid">${list.map(item => worktreeCard(ctx, item)).join('')}</div>`;
  const feed = `<div class="page wt-page">${chips}
    ${items.length ? '' : '<div class="empty"><h2>No worktrees yet</h2><p>Worktrees your agents make, and the ones Rex Desk finds in your projects, show here with the tasks that live in each one.</p></div>'}
    ${active.length ? `<h3 class="wt-sec">In use <span class="cnt">${active.length}</span></h3>${grid(active)}` : ''}
    ${gone.length ? `<h3 class="wt-sec">History <span class="cnt">${gone.length}</span></h3><p class="muted small">Worktrees that were removed. Their tasks stay listed so you can see where the work happened.</p>${grid(gone)}` : ''}
  </div>`;
  return { title: 'Worktrees', meta: `${active.length} in use · ${gone.length} removed`, feed, top: true, actions: '<button class="btn small" data-wt-act="rescan">Refresh</button>' };
}

// Cards inside chat messages: a message carries [[worktree:ID]] and the card is drawn from the latest data.
export function fillWorktreeEmbeds(ctx) {
  for (const slot of document.querySelectorAll('.wt-embed[data-worktree]')) {
    const item = byId(ctx.ui, slot.dataset.worktree);
    const html = item ? worktreeCard(ctx, item, { compact: true }) : '<p class="muted small">This worktree is not in the history any more.</p>';
    if (slot.dataset.html !== html && !slot.contains(document.activeElement)) { slot.innerHTML = html; slot.dataset.html = html; }
  }
}

export function wireWorktrees(ctx) {
  document.addEventListener('click', async event => {
    const target = event.target.closest?.('[data-wt-act]'); if (!target) return;
    event.preventDefault();
    const { api, toast, refresh, ui } = ctx, act = target.dataset.wtAct;
    try {
      if (act === 'copy') { await navigator.clipboard.writeText(target.dataset.path); toast('Folder copied.'); }
      else if (act === 'filter') { ui.wtProject = target.dataset.project || ''; ctx.render(); }
      else if (act === 'rescan') { await api('/worktrees'); await refresh(); toast('Worktrees refreshed.'); }
      else if (act === 'changes') { ui.wtChanges?.delete(target.dataset.wt); ctx.render(); }
      else if (act === 'remove') { await api(`/worktrees/${target.dataset.wt}/tasks`, { method: 'POST', data: { taskId: target.dataset.task, remove: true } }); await refresh(); }
    } catch (error) { toast(error.message, true); }
  });
  document.addEventListener('change', async event => {
    const id = event.target.dataset?.wtAdd; if (!id || !event.target.value) return;
    const { api, toast, refresh } = ctx;
    try { await api(`/worktrees/${id}/tasks`, { method: 'POST', data: { taskId: event.target.value } }); toast('Task added. Whoever works on it is told to work in this worktree.'); event.target.blur(); await refresh(); }
    catch (error) { toast(error.message, true); }
  });
}

// Ctrl+Shift+Up / Down: the previous or next chat in the sidebar, the way it is listed.
export function wireChatSwitch() {
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const items = [...document.querySelectorAll('#rail .item[data-open]')]; if (!items.length) return;
    event.preventDefault();
    const at = items.findIndex(item => item.classList.contains('active'));
    const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].click(); items[next].scrollIntoView({ block: 'nearest' });
    setTimeout(() => document.getElementById('draft')?.focus(), 60);
  });
}

// The worktrees of one chat: shown or made there, or holding a task that is worked on there. Active ones first.
export function chatWorktrees(ui, { runId = '', agentId = '', roomId = '' }) {
  const tasks = new Map((ui.snap?.tasks || []).map(task => [task.id, task]));
  const mine = item => (runId && (item.chats || []).includes(`run:${runId}`)) || (roomId && (item.chats || []).includes(`room:${roomId}`))
    || (item.tasks || []).some(id => { const task = tasks.get(id); return task && ((roomId && task.roomWork?.roomId === roomId) || (agentId && !roomId && task.chatWork?.agentId === agentId)); });
  return all(ui).filter(mine).sort((left, right) => (left.state === 'gone') - (right.state === 'gone'));
}
// The Worktrees tab beside a personal or group chat, like a source control panel: each worktree's branch, the branch it
// tracks, its added and removed lines, the tasks in it, and every changed file (click one to open it).
const FILE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const STATUS = { M: 'Changed', A: 'Added', U: 'New file', D: 'Deleted', R: 'Renamed' };
function loadChanges(ctx, item) {
  const cache = ctx.ui.wtChanges ||= new Map(), known = cache.get(item.id);
  if (item.state === 'gone' || known?.loading || (known && Date.now() - known.at < 15000)) return known?.data;
  cache.set(item.id, { ...known, loading: true, at: Date.now() });
  ctx.api(`/worktrees/${item.id}/changes`).then(data => { cache.set(item.id, { data, at: Date.now() }); ctx.render(); })
    .catch(error => { cache.set(item.id, { data: { error: error.message, files: [] }, at: Date.now() }); ctx.render(); });
  return known?.data;
}
function scmBlock(ctx, item) {
  const { esc, ui } = ctx, gone = item.state === 'gone', data = loadChanges(ctx, item), tasks = item.tasks || [];
  const free = (ui.snap.tasks || []).filter(task => task.active && !task.demo && !tasks.includes(task.id));
  const lines = (plus, minus) => `<span class="scm-n"><span class="plus">+${plus}</span> <span class="minus">-${minus}</span></span>`;
  const sync = data && (data.ahead || data.behind) ? `<span class="scm-sync" title="Commits not pushed / not pulled yet">${data.ahead ? `↑${data.ahead}` : ''}${data.behind ? ` ↓${data.behind}` : ''}</span>` : '';
  const files = !data ? '<p class="muted small scm-wait">Reading changes…</p>' : data.error ? `<p class="muted small">${esc(data.error)}</p>`
    : data.files.length ? `<ul class="scm-files">${data.files.map(file => `<li><button type="button" class="scm-file" data-file-open="${esc(file.path)}" title="${esc(`${STATUS[file.status] || ''}: ${file.dir ? `${file.dir}/` : ''}${file.name}`)}"><span class="scm-ficon">${FILE}</span><span class="scm-fname">${esc(file.name)}</span><span class="scm-dir">${esc(file.dir)}</span>${lines(file.added, file.removed)}<span class="scm-st s-${file.status}">${file.status}</span></button></li>`).join('')}</ul>`
    : '<p class="muted small scm-clean">No uncommitted changes.</p>';
  return `<details class="scm${gone ? ' gone' : ''}" ${gone ? '' : 'open'} data-wt-id="${esc(item.id)}">
    <summary><span class="scm-branch"><span class="scm-bicon">${BRANCH}</span><b title="${esc(item.branch || '')}">${esc(item.branch || 'No branch')}</b></span>${gone ? '<span class="chip">Removed</span>' : data && !data.error ? lines(data.added, data.removed) : ''}</summary>
    ${data?.upstream ? `<div class="scm-up"><span aria-hidden="true">→</span><b>${esc(data.upstream)}</b>${sync}</div>` : ''}
    <button type="button" class="scm-path" data-wt-act="copy" data-path="${esc(item.path)}" title="Copy the folder">${esc(item.path)}</button>
    <div class="scm-sec"><span>Tasks <span class="cnt">${tasks.length}</span></span></div>
    ${tasks.length ? `<ul class="scm-tasks">${tasks.map(taskId => taskRow(ctx, item, taskId)).join('')}</ul>` : ''}
    ${gone || !free.length ? '' : `<label class="wt-add"><span class="sr">Add a task to this worktree</span><select data-wt-add="${esc(item.id)}"><option value="">+ Add a task</option>${free.map(task => `<option value="${esc(task.id)}">#${esc(taskNumber(task))} ${esc(taskName(task)).slice(0, 80)}</option>`).join('')}</select></label>`}
    ${gone ? '' : `<div class="scm-sec"><span>Changes <span class="cnt">${data?.files?.length ?? '…'}</span></span><button type="button" class="scm-refresh" data-wt-act="changes" data-wt="${esc(item.id)}" title="Read the changes again" aria-label="Read the changes again">↻</button></div>${files}`}
  </details>`;
}
export function worktreeSideHtml(ctx, list) {
  const body = list.length ? list.map(item => scmBlock(ctx, item)).join('')
    : '<p class="muted small wt-side-empty">No worktree in this chat yet. When an agent makes one or shows one here, it is listed in this tab with its tasks and changes.</p>';
  return `<div class="side-body wt-side" id="side-body">${body}<div class="prow"><button class="btn small" data-open="worktrees" data-id="">All worktrees</button></div></div>`;
}

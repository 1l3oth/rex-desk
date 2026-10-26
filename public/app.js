const app = document.querySelector('#app');
const repositoryInfo = new Map(), inspecting = new Map(), previewTimers = new Map(), connectingSources = new Set();
const loadingTasks = new Set(), taskErrors = new Map();
const providerName = provider => provider === 'codex' ? 'Codex' : 'Claude Code';
const samePath = (left, right) => String(left || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === String(right || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const taskImage = (task, address) => `/api/task-image?task=${encodeURIComponent(task.id)}&url=${encodeURIComponent(address)}`;
const taskFile = (task, address) => `/api/task-file?task=${encodeURIComponent(task.id)}&url=${encodeURIComponent(address)}`;
// Attachments the viewer can show, judged by name; the server checks the real bytes before serving.
const mediaKind = name => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) ? 'image' : /\.(mp4|webm|mov|m4v)$/i.test(name) ? 'video' : '';
const viewable = (kind, src, name, original = '') => `data-view="${kind}" data-view-src="${esc(src)}" data-view-name="${esc(name)}"${original ? ` data-view-original="${esc(original)}"` : ''}`;
const ui = { page: 'inbox', view: 'list', selectedTask: '', selectedRun: '', tab: 'brief', search: '', source: '', category: '', snapshot: null, runEvents: new Map(), journals: new Map(), transcripts: new Map(), openOps: new Set(), openRuns: [], layout: 'grid', runSide: 'runs', selectedDecision: '', draft: null, busy: false, agents: null, agentsLoading: false, agentsError: '', setupOpen: '', setupPrompt: '', autoTour: false,
  sort: 'priority', found: null, foundLoading: false, orcaScreens: new Map(), orcaOpen: new Set(), detailLayout: 'tabs', tabSecond: 'messages', splitRatio: 0.5, sideWidth: 0, proofWidth: 0, dragging: false, missedRender: false };
const labels = { queued: 'Queued', starting: 'Preparing', running: 'Working', waiting: 'Needs you', needs_evidence: 'Needs evidence', ready_for_review: 'Ready for review', published: 'PR created', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted', finished: 'Finished', qa_passed: 'QA passed', qa_failed: 'QA failed', qa_blocked: 'QA blocked' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const button = (label, action, style = '', extra = '') => `<button class="button ${style}" data-action="${action}" ${extra}>${label}</button>`;
const sourceLogo = source => `<span class="source-logo ${source}">${source === 'flow' ? 'f' : 'm'}</span>`;
const tag = state => `<span class="tag ${esc(state)}">${esc(labels[state] || state)}</span>`;
const time = value => value ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const relative = value => { if (!value) return 'Not synced'; const minutes = Math.floor((Date.now() - new Date(value)) / 60000); return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`; };
const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const artifactUrl = artifact => `/artifacts/${artifact.runId}/${encodeURIComponent(artifact.file)}`;
const taskRun = task => ui.snapshot.runs.find(run => run.id === task.runId) || ui.snapshot.runs.find(run => run.taskId === task.id);
const selectedTask = () => ui.snapshot.tasks.find(task => task.id === ui.selectedTask);
const selectedRun = () => ui.snapshot.runs.find(run => run.id === ui.selectedRun);
const pending = runId => ui.snapshot.interactions.filter(item => item.state === 'pending' && (!runId || item.runId === runId));

async function api(endpoint, { method = 'GET', data } = {}) {
  const response = await fetch(`/api${endpoint}`, { method, headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
let toastTimer;
function toast(message, error = false) {
  const element = document.querySelector('#toast'); element.textContent = message;
  element.className = `show${error ? ' error' : ''}`; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.className = '', error ? 9000 : 4500);
}
async function action(callback) {
  try { return await callback(); } catch (error) { toast(error.message, true); return undefined; }
}
function filteredTasks() {
  return ui.snapshot.tasks.filter(task => (!ui.source || task.source === ui.source) && (!ui.category || task.category === ui.category)
    && (!ui.search || ui.search.toLowerCase().split(/\s+/).filter(Boolean).every(term => searchText(task).includes(term))));
}
function searchText(task) {
  return [task.title, task.externalId, task.taskNumber, task.projectName, task.category, task.statusName, task.reporter, task.section, task.description,
    ...(task.fields || []).map(field => field.value)].join(' ').toLowerCase();
}
function navigate(page, { runId, taskId } = {}) {
  if (ui.page === 'settings' && page !== 'settings') ui.draft = null;
  ui.page = page;
  if (runId) openRun(runId);
  if (taskId) ui.selectedTask = taskId;
  if (page === 'settings' && !ui.draft) ui.draft = structuredClone(ui.snapshot.config);
  render(); void loadMessages();
}
// Open runs and the pane layout are a per-browser convenience, so they live in localStorage.
const paneLimits = { single: 1, split: 2, grid: 4 };
function saveWorkspace() {
  try { localStorage.setItem('rex-desk-workspace', JSON.stringify({ openRuns: ui.openRuns, layout: ui.layout, layoutChosen: ui.layoutChosen, selectedRun: ui.selectedRun, sort: ui.sort, sideWidth: ui.sideWidth, proofWidth: ui.proofWidth, detailLayout: ui.detailLayout, tabSecond: ui.tabSecond, splitRatio: ui.splitRatio })); } catch {}
}
function restoreWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem('rex-desk-workspace') || '{}'); ui.openRuns = Array.isArray(saved.openRuns) ? saved.openRuns : []; ui.layoutChosen = Boolean(saved.layoutChosen); ui.layout = ui.layoutChosen && paneLimits[saved.layout] ? saved.layout : 'single'; ui.selectedRun = saved.selectedRun || '';
    ui.sort = saved.sort === 'tracker' ? 'tracker' : 'priority'; ui.sideWidth = Number(saved.sideWidth) || 0; ui.proofWidth = Number(saved.proofWidth) || 0; ui.detailLayout = detailLayouts.includes(saved.detailLayout) ? saved.detailLayout : 'tabs';
    ui.tabSecond = detailTabNames[saved.tabSecond] ? saved.tabSecond : 'messages'; ui.splitRatio = Math.min(0.8, Math.max(0.2, Number(saved.splitRatio) || 0.5));
  } catch {}
  applySizes();
}
// The sidebar width and the issue panel split are CSS variables on the root, so they survive every render.
const detailLayouts = ['tabs', 'columns', 'rows'], detailTabNames = { brief: 'Issue brief', messages: 'Messages', proof: 'Evidence' };
const otherTab = key => key === 'brief' ? 'messages' : 'brief';
const compactQuery = matchMedia('(max-width: 700px)');
const detailLayout = () => compactQuery.matches ? 'tabs' : ui.detailLayout;
function shownTabs() {
  if (detailLayout() === 'tabs') return [ui.tab];
  if (ui.tab === ui.tabSecond) ui.tabSecond = otherTab(ui.tab);
  return [ui.tab, ui.tabSecond];
}
function resetDetailTab() { if (detailLayout() === 'tabs' || ui.tabSecond !== 'brief') ui.tab = 'brief'; }
const sideLimits = () => [220, Math.max(220, innerWidth - 408)];
function applySizes() {
  const root = document.documentElement.style;
  if (ui.sideWidth) root.setProperty('--side-width', `${ui.sideWidth}px`); else root.removeProperty('--side-width');
  if (ui.proofWidth) root.setProperty('--proof-width', `${ui.proofWidth}px`); else root.removeProperty('--proof-width');
  root.setProperty('--split-first', `${Math.round(ui.splitRatio * 1000) / 10}%`);
}
function setSideWidth(width) {
  const [min, max] = sideLimits();
  ui.sideWidth = width ? Math.round(Math.min(max, Math.max(min, width))) : 0; applySizes();
  document.querySelector('.side-resizer')?.setAttribute('aria-valuenow', String(Math.round(document.querySelector('.side')?.getBoundingClientRect().width || ui.sideWidth)));
}
// The proof column keeps at least 200px, and the conversation beside it at least 320px.
function setProofWidth(width, pane) {
  const box = (pane || document.querySelector('.pane'))?.getBoundingClientRect(), max = box ? Math.max(200, box.width - 320) : 900;
  ui.proofWidth = width ? Math.round(Math.min(max, Math.max(200, width))) : 0; applySizes();
  for (const handle of document.querySelectorAll('[data-resize="proof"]')) handle.setAttribute('aria-valuenow', String(ui.proofWidth || 260));
}
// Each panel keeps at least 220px across (120px stacked) when the issue area allows it.
function setSplitRatio(ratio) {
  const box = document.querySelector('.detail-split')?.getBoundingClientRect(), rows = ui.detailLayout === 'rows';
  const size = box ? (rows ? box.height : box.width) : 0, floor = size ? Math.min(0.5, (rows ? 120 : 220) / size) : 0.2;
  ui.splitRatio = Math.min(Math.min(0.8, 1 - floor), Math.max(Math.max(0.2, floor), ratio)); applySizes();
  document.querySelector('.split-divider')?.setAttribute('aria-valuenow', String(Math.round(ui.splitRatio * 100)));
}
function openRun(runId) {
  if (!ui.openRuns.includes(runId)) ui.openRuns.push(runId);
  ui.selectedRun = runId; ui.flashRun = runId; saveWorkspace();
}
function closeRun(runId) {
  ui.openRuns = ui.openRuns.filter(id => id !== runId); ui.runEvents.delete(runId); ui.transcripts.delete(runId);
  if (ui.selectedRun === runId) ui.selectedRun = ui.openRuns.at(-1) || '';
  saveWorkspace();
}
// The focused run always shows; the remaining panes fill in tab order.
function visibleRuns() {
  const open = ui.openRuns.map(id => ui.snapshot.runs.find(run => run.id === id)).filter(Boolean), limit = paneLimits[ui.layout];
  const shown = open.slice(0, limit), focused = open.find(run => run.id === ui.selectedRun);
  if (focused && !shown.includes(focused)) shown[limit - 1] = focused;
  return shown;
}
async function refresh({ force = false } = {}) {
  ui.snapshot = await api('/state');
  ui.openRuns = ui.openRuns.filter(id => ui.snapshot.runs.some(run => run.id === id));
  if (!ui.openRuns.includes(ui.selectedRun)) ui.selectedRun = ui.openRuns.at(-1) || '';
  if (!ui.selectedTask && ui.snapshot.tasks.length) ui.selectedTask = ui.snapshot.tasks[0].id;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  // A render mid-drag would replace the handle under the pointer; it runs when the drag ends.
  if (ui.dragging) { ui.missedRender = true; return; }
  if (force || (ui.page !== 'settings' && !typing && !document.querySelector('dialog[open]'))) { render(); await loadMessages(); }
  else if (ui.page === 'settings') { const database = document.querySelector('[data-database]'); if (database && !database.contains(document.activeElement)) database.innerHTML = renderDatabase(); }
}
function render() {
  const state = ui.snapshot;
  if (!state) return;
  const pages = [['inbox', 'inbox', 'My issues'], ['runs', 'agents', 'Agent runs'], ['board', 'board', 'Kanban'], ['decisions', 'question', 'Needs you'], ['evidence', 'play', 'Evidence']];
  const steps = setupSteps(), remaining = steps.filter(step => !step.done && !step.optional).length;
  const waiting = pending().length, active = state.runs.filter(run => ['running', 'waiting', 'starting', 'queued'].includes(run.state)).length;
  const board = ui.page === 'board' || ui.page === 'inbox' && ui.view === 'board';
  const side = ui.page === 'runs' ? renderRunSide() : ui.page === 'inbox' && !board ? renderIssueSide() : '';
  const navButton = ([page, glyph, label]) => `<button class="activity-button ${ui.page === page || page === 'board' && board ? 'active' : ''}" data-page="${page}" ${ui.page === page ? 'aria-current="page"' : ''} aria-label="${label}" title="${label}">${icon(glyph)}${page === 'decisions' && waiting ? `<span class="count" aria-hidden="true">${waiting}</span>` : ''}${page === 'runs' && active ? `<span class="count quiet" aria-hidden="true">${active}</span>` : ''}${page === 'setup' && remaining ? `<span class="count quiet" aria-hidden="true">${remaining}</span>` : ''}</button>`;
  const database = state.database || {}, cloud = { connected: 'Turso synced', syncing: 'Turso uploading', connecting: 'Turso connecting', offline: 'Turso offline', error: 'Turso needs attention' }[database.state] || 'Local only';
  const synced = state.sync.length ? relative(state.sync.map(item => item.at).sort().at(-1)) : '';
  app.innerHTML = `<div class="shell${side ? ' with-side' : ''}"><nav class="activity" aria-label="Workspace"><span class="brand-mark" title="Rex Desk" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${pages.map(navButton).join('')}<span class="activity-spacer"></span>${[['setup', 'compass', 'Setup'], ['settings', 'settings', 'Settings']].map(navButton).join('')}${themeButton()}</nav>
    ${side ? `<aside class="side" aria-label="${ui.page === 'runs' ? 'Agent runs' : 'Assigned issues'}">${side}</aside>${sideResizer()}` : ''}
    <main class="main page-${ui.page}${board ? ' page-board' : ''}" id="main" tabindex="-1">${ui.page === 'setup' ? renderSetup(steps) : ui.page === 'settings' ? renderSettings() : ui.page === 'decisions' ? renderDecisions() : ui.page === 'runs' ? renderWorkspace() : ui.page === 'evidence' ? renderEvidence() : board ? renderBoardPage() : renderInboxMain()}</main>
    <footer class="statusbar"><span class="status-local"><span class="dot"></span>Running on this computer</span><span class="status-${esc(database.state || 'local')}">${cloud}${database.pending ? ` · ${Number(database.pending)} waiting` : ''}</span><span>${active} active · ${state.config.concurrency} worker${state.config.concurrency === 1 ? '' : 's'}</span>${waiting ? `<span class="status-need">${plural(waiting, 'decision')} waiting</span>` : ''}<span class="status-right">${providerName(state.config.provider)} default${synced ? ` · Synced ${synced}` : ''}</span></footer></div>`;
  if (ui.page === 'settings') for (const repository of ui.draft.repositories) previewBranch(repository.id);
  restoreTranscript();
  if (ui.flashRun) { const flashed = ui.flashRun; setTimeout(() => { if (ui.flashRun === flashed) ui.flashRun = ''; document.querySelector(`[data-pane-run="${flashed}"]`)?.classList.remove('flash'); }, 900); }
  if (['setup', 'settings'].includes(ui.page) && !ui.agents && !ui.agentsLoading && !ui.agentsError) void loadAgents();
  if (ui.page === 'settings' && !ui.github) void loadGithub();
  if (ui.page === 'settings') void loadAutostart();
}
function heading(title, subtitle, controls = '') {
  return `<header class="titlebar"><div class="titlebar-text"><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${controls}</div></header>`;
}
function viewSwitch(board) {
  return `<div class="view-switch" aria-label="Task view"><button data-action="view-list" class="${!board ? 'active' : ''}">${icon('inbox')}List</button><button data-action="view-board" class="${board ? 'active' : ''}">${icon('board')}Kanban</button></div>`;
}
function issueActions() {
  const jev = ui.snapshot.jev || {}, running = jev.running, realTasks = ui.snapshot.tasks.filter(task => !task.demo);
  return `${button(`${icon('sync')} Sync tasks`, 'sync', `small${ui.busy ? ' busy' : ''}`, ui.busy ? 'disabled' : '')}${button(`${icon('agents')} ${running ? `Ranking ${jev.done || 0} / ${jev.total || 0}` : 'Prioritize'}`, 'prioritize', `primary small${running ? ' busy' : ''}`, running || !realTasks.length ? 'disabled' : 'title="Jev rates each issue; Rex Desk ranks them. Shift-click to re-check all."')}`;
}
// Jev's ranking for every assigned issue, by task ID.
const priorityMap = () => new Map((ui.snapshot.priorities || []).map(item => [item.taskId, item]));
function orderedTasks() {
  const tasks = filteredTasks(), ranking = priorityMap();
  if (ui.sort !== 'priority' || !ranking.size) return tasks;
  const position = new Map((ui.snapshot.priorities || []).map((item, index) => [item.taskId, index]));
  return [...tasks].sort((left, right) => (position.get(left.id) ?? 1e9) - (position.get(right.id) ?? 1e9));
}
// The one issue to run next, or what is needed before Jev can say.
function nextUp() {
  const jev = ui.snapshot.jev || {}, real = ui.snapshot.tasks.filter(task => !task.demo);
  if (!real.length) return '';
  if (!jev.configured) return `<div class="next-up empty">${icon('agents')}<span>Let Jev rank your issues so you know what to run first.</span>${settingsLink('jev', 'Add OpenRouter key')}</div>`;
  const top = (ui.snapshot.priorities || []).find(item => item.group === 'next' && item.analyzed);
  if (!top) return `<div class="next-up empty">${icon('agents')}<span>${jev.running ? 'Jev is ranking your issues…' : 'No ranking yet.'}</span>${jev.running ? '' : button('Prioritize', 'prioritize', 'small')}</div>`;
  const task = ui.snapshot.tasks.find(item => item.id === top.taskId);
  if (!task) return '';
  return `<div class="next-up"><div class="next-up-head"><span>Next up</span><span class="rank-chip sev-${Math.round(top.severity ?? 0)}">1</span></div><button class="next-up-title" data-task="${esc(task.id)}">${sourceLogo(task.source)}<span>${esc(task.title)}</span></button><p>${esc(top.reasons.join(' · '))}</p>${button(`${icon(top.action === 'verify' ? 'check' : 'play')} ${top.action === 'verify' ? 'Verify fix' : 'Fix with agent'}`, 'run-next', 'small primary', `data-task-id="${esc(task.id)}" data-mode="${top.action === 'verify' ? 'verify' : 'fix'}"`)}</div>`;
}
function renderPriority(task) {
  const item = priorityMap().get(task.id), jev = ui.snapshot.jev || {};
  if (!item?.analyzed) return item?.error ? `<section class="issue-section"><h3>Priority</h3><p class="error-text">Jev could not rate this issue: ${esc(item.error)}</p></section>` : '';
  const total = (ui.snapshot.priorities || []).filter(entry => entry.group === 'next').length;
  const place = item.rank ? `#${item.rank} of ${total} to run` : { running: 'Agent working', done: 'Agent finished', later: 'Later' }[item.group] || '';
  return `<section class="issue-section jev-priority"><div class="issue-section-heading"><h3>Priority</h3>${button(`${icon('sync')} Re-check`, 'prioritize-one', 'small quiet', `data-task-id="${esc(task.id)}"${jev.running ? ' disabled' : ''}`)}</div><p><strong>${esc(place)}</strong> · ${esc(item.reasons.join(' · '))}${item.web !== null ? ` · checkable in a browser ${Math.round(item.web * 100)}%` : ''}</p><small class="muted">Rated by Jev${item.model ? ` (${esc(item.model)})` : ''}${item.at ? ` · ${esc(relative(item.at).toLowerCase())}` : ''}</small></section>`;
}
function sourceCounts() {
  return `<div class="connection-strip">${['morningmate', 'flow'].map(source => `<span class="source-word">${sourceLogo(source)}<strong>${source === 'flow' ? 'Flow' : 'Morningmate'}</strong><span>${ui.snapshot.tasks.filter(task => task.source === source).length}</span></span>`).join('')}<span class="muted">${ui.snapshot.sync.length ? `Synced ${relative(ui.snapshot.sync.map(item => item.at).sort().at(-1))}` : 'Not synced yet'}</span></div>`;
}
function workspaceNotices() {
  const demo = ui.snapshot.tasks.some(task => task.demo);
  const jev = ui.snapshot.jev || {};
  return `${renderSetupBanner()}${demo ? `<div class="notice">${icon('question')}<span>Demo workspace. These issues are synthetic. Connect your projects to run real agents.</span>${button('Remove demo', 'remove-demo', 'small quiet')}</div>` : ''}
    ${ui.snapshot.sync.filter(item => item.error).map(item => `<div class="notice">${icon('question')}<span><strong>${esc(item.name)} sync failed.</strong> ${esc(item.error)}</span>${button('Settings', 'settings', 'small quiet')}</div>`).join('')}
    ${jev.state === 'error' && jev.error ? `<div class="notice">${icon('question')}<span><strong>Jev could not rate ${plural(jev.failed || 1, 'issue')}.</strong> ${esc(jev.error)}</span>${settingsLink('jev', 'Jev settings')}</div>` : ''}`;
}
// Issues page: the list lives in the sidebar, the selected issue fills the main area.
function renderIssueSide() {
  const tasks = orderedTasks(), ranked = (ui.snapshot.priorities || []).some(item => item.analyzed);
  return `<div class="side-head"><h2>Assigned <span class="count-label">${ui.snapshot.tasks.length}</span></h2>${viewSwitch(false)}</div>
    ${assignedTo()}<div class="side-actions">${issueActions()}</div>${nextUp()}${toolbar()}
    <div class="task-section-title"><label class="sort-control"><span>Order</span><select id="task-sort" class="filter-select" aria-label="Order issues"><option value="priority" ${ui.sort === 'priority' ? 'selected' : ''}>By priority${ranked ? '' : ' (not ranked yet)'}</option><option value="tracker" ${ui.sort === 'tracker' ? 'selected' : ''}>As in tracker</option></select></label><span id="task-count">${tasks.length}</span></div>
    <div id="task-list" class="task-list">${tasks.length ? tasks.map(renderTaskRow).join('') : emptyTasks()}</div>${sourceCounts()}`;
}
function renderInboxMain() {
  const notices = workspaceNotices();
  return `${notices.trim() ? `<div class="notices">${notices}</div>` : ''}${renderTaskDetail()}`;
}
function renderBoardPage() {
  return `${heading('Assigned to you', `${ui.snapshot.tasks.length} issues by progress`, `${viewSwitch(true)}${issueActions()}`)}<div class="notices">${workspaceNotices()}</div>${toolbar()}<div id="task-board">${renderBoard(filteredTasks())}</div>`;
}
function toolbar() {
  const categories = [...new Set(ui.snapshot.tasks.map(task => task.category).filter(Boolean))];
  return `<div class="pane-toolbar"><label class="search-field">${icon('search')}<input id="task-search" aria-label="Search issues" placeholder="Search issues…" value="${esc(ui.search)}"></label><select class="filter-select" id="source-filter" aria-label="Filter by source"><option value="">All sources</option><option value="morningmate" ${ui.source === 'morningmate' ? 'selected' : ''}>Morningmate</option><option value="flow" ${ui.source === 'flow' ? 'selected' : ''}>Flow</option></select>${categories.length ? `<select class="filter-select" id="category-filter" aria-label="Filter by category"><option value="">All categories</option>${categories.map(category => `<option ${category === ui.category ? 'selected' : ''}>${esc(category)}</option>`).join('')}</select>` : ''}</div>`;
}
function emptyTasks() {
  const connected = ui.snapshot.config.sources.length;
  return `<div class="setup-empty"><div class="empty">${icon('inbox')}<h2>${connected ? 'No assigned issues here' : 'Bring your issues into one place'}</h2><p>${connected ? 'Sync your projects, or change the filters. Only tasks assigned to your configured account appear.' : 'Connect Flow or Morningmate, choose your projects, and let an agent handle the investigation.'}</p><div class="actions">${button(connected ? 'Sync tasks' : 'Connect a project', connected ? 'sync' : 'settings', 'primary')}${!connected ? button('Explore demo', 'demo') : ''}</div></div></div>`;
}
function renderTaskStates(task, run = taskRun(task)) {
  return `<span class="task-states"><span class="state-pair"><span>Tracker:</span>${tag(task.statusName || task.status)}</span>${run ? `<span class="state-pair"><span>Agent:</span>${tag(run.state)}</span>` : ''}</span>`;
}
// Whose issues these are, and how many of them name that person as an assignee.
function assignedTo() {
  const lines = (ui.snapshot.sync || []).filter(item => item.account && !item.error);
  if (!lines.length) return '';
  return `<div class="assigned-to">${lines.map(item => { const checked = item.verified ?? item.count, all = checked === item.count; return `<p title="Rex Desk asks the tracker for tasks whose Assignee column contains this account, then checks each task again before keeping it.">${icon(all ? 'check' : 'alert')}<span>Assigned to <strong>${esc(item.accountName || item.account)}</strong>${item.accountName ? ` · ${esc(item.account)}` : ''}${item.accountSource ? ` · ${esc(item.accountSource)}` : ''}</span><small>${checked} of ${item.count} issues list this account as an assignee</small></p>`; }).join('')}</div>`;
}
// One line per issue: number, title, and the agent's state as a dot. Tracker status and category live in the preview.
function renderTaskRow(task) {
  const run = taskRun(task), hint = [task.statusName || task.status, task.category, run && `Agent: ${labels[run.state] || run.state}`].filter(Boolean).join(' · ');
  const item = priorityMap().get(task.id), chip = item?.rank ? `<span class="rank-chip sev-${Math.round(item.severity ?? 0)}" title="${esc(`Priority ${item.rank}: ${item.reasons.join(' · ')}`)}">${item.rank}</span>` : item?.group === 'later' ? '<span class="rank-chip later" title="Waiting or not actionable">–</span>' : '<span class="rank-chip none" aria-hidden="true"></span>';
  return `<div class="task-row ${task.id === ui.selectedTask ? 'selected' : ''}${item?.group === 'later' ? ' later' : ''}">${chip}<button class="task-open" data-task="${esc(task.id)}" title="${esc(hint)}">${sourceLogo(task.source)}<span class="task-number">${esc(task.taskNumber || task.externalId)}</span><span class="task-title">${esc(task.title)}</span>${task.demo ? '<span class="demo-label">Demo</span>' : ''}<span class="state-dot ${run ? esc(run.state) : 'none'}" aria-hidden="true"></span>${run ? `<span class="sr-only">Agent ${esc(labels[run.state] || run.state)}</span>` : ''}</button></div>`;
}
function renderTaskDetail() {
  const task = selectedTask();
  if (!task) return `<section class="detail-pane no-selection"><div class="empty">${icon('file')}<h2>Select an issue</h2><p>Its brief, agent messages, decisions, and proof will appear here.</p></div></section>`;
  const run = taskRun(task), link = safeUrl(task.url), layout = detailLayout(), [first, second] = shownTabs();
  const body = layout === 'tabs'
    ? `${detailTabList(first, run)}<div class="detail-body" role="tabpanel" aria-label="${detailTabNames[first]}">${renderDetailContent(first, task, run)}</div>`
    : `<div class="detail-split ${layout}">${detailPanel('first', first, second, task, run)}<div class="split-divider" role="separator" tabindex="0" data-resize="split" aria-orientation="${layout === 'rows' ? 'horizontal' : 'vertical'}" aria-label="Resize panels" aria-valuemin="20" aria-valuemax="80" aria-valuenow="${Math.round(ui.splitRatio * 100)}" title="Drag to resize · double-click to reset"></div>${detailPanel('second', second, first, task, run)}</div>`;
  return `<section class="detail-pane${layout === 'tabs' ? '' : ' split'}" aria-label="Selected issue"><div class="detail-top"><div class="detail-reference">${sourceLogo(task.source)}<span>${esc(task.sourceName)} · #${esc(task.taskNumber || task.externalId)}</span>${task.demo ? '<span class="demo-label">Demo</span>' : ''}${renderTaskStates(task, run)}${detailLayoutSwitch()}</div><h2>${esc(task.title)}</h2>${renderIssueProperties(task, run)}</div>
    ${body}
    <div class="detail-bottom"><p>${run?.branch ? `${icon('branch')} <code>${esc(run.branch)}</code>` : link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Open original issue</a>` : 'One issue. One isolated worktree.'}</p><div class="actions">${issueRunActions(task, run)}</div></div></section>`;
}
function renderDetailContent(key, task, run) {
  if (key === 'brief') return `${renderPriority(task)}${renderIssueBrief(task)}${run ? renderRunPath(run) : ''}${run?.error ? `<p class="error-text">${esc(run.error)}</p>` : ''}`;
  if (key === 'messages') return run ? `<div class="issue-conversation" id="messages-${run.id}">${renderMessages(run.id)}</div>` : '<p class="empty-small">Start an agent to begin the conversation.</p>';
  return renderProof(run?.id);
}
// Tabs drag onto the issue to open a second panel; in split view each panel has its own tabs, and choosing the other panel's tab swaps them.
function detailTabList(active, run, slot = '', other = '') {
  const waiting = run ? pending(run.id).length : 0, rows = detailLayout() === 'rows';
  const name = slot ? `${slot === 'first' ? (rows ? 'Top' : 'Left') : (rows ? 'Bottom' : 'Right')} panel` : 'Issue details';
  return `<div class="tabs" role="tablist" aria-label="${name}">${Object.entries(detailTabNames).map(([key, label]) => `<button type="button" class="tab${active === key ? ' active' : ''}${other === key ? ' elsewhere' : ''}" role="tab" aria-selected="${active === key}" data-tab="${key}"${slot ? ` data-slot="${slot}"` : ''} title="${other === key ? 'Shown in the other panel · click to swap' : slot ? 'Drag onto a panel to show it there' : 'Drag onto the issue to open it beside this panel'}">${label}${key === 'messages' && waiting ? ` (${waiting})` : ''}</button>`).join('')}</div>`;
}
function detailPanel(slot, key, other, task, run) {
  return `<div class="split-pane" data-slot="${slot}">${detailTabList(key, run, slot, other)}<div class="split-body show-${key}" role="tabpanel" aria-label="${detailTabNames[key]}">${renderDetailContent(key, task, run)}</div></div>`;
}
function detailLayoutSwitch() {
  if (compactQuery.matches) return '';
  return `<div class="layout-switch detail-layout" role="group" aria-label="Issue panel layout">${[['tabs', 'single', 'One panel with tabs'], ['columns', 'split', 'Two panels side by side'], ['rows', 'rows', 'Two panels stacked']].map(([value, glyph, label]) => `<button type="button" class="${ui.detailLayout === value ? 'active' : ''}" data-action="detail-layout" data-layout="${value}" aria-label="${label}" aria-pressed="${ui.detailLayout === value}" title="${label}"><span class="layout-glyph ${glyph}" aria-hidden="true"><i></i><i></i><i></i><i></i></span></button>`).join('')}</div>`;
}
function sideResizer() {
  const [min, max] = sideLimits(), width = Math.min(max, Math.max(min, ui.sideWidth || (innerWidth <= 1100 ? 260 : 300)));
  return `<div class="side-resizer" role="separator" tabindex="0" data-resize="side" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${width}" title="Drag to resize · double-click to reset"></div>`;
}
function setDetailLayout(layout) {
  if (!detailLayouts.includes(layout)) return;
  // Opening a split from tabs keeps the brief first and shows the tab you were reading beside it.
  if (layout !== 'tabs' && ui.detailLayout === 'tabs') { ui.tabSecond = ui.tab !== 'brief' ? ui.tab : ui.tabSecond !== 'brief' ? ui.tabSecond : 'messages'; ui.tab = 'brief'; }
  ui.detailLayout = layout; saveWorkspace(); render(); void loadMessages();
}
function placeTab(slot, key) {
  const [first, second] = shownTabs();
  if (slot === 'first') { ui.tab = key; ui.tabSecond = second === key ? first : second; }
  else { ui.tabSecond = key; ui.tab = first === key ? second : first; }
}
function dropTab(key, zone) {
  if (zone.layout) {
    const partner = ui.tab !== key ? ui.tab : ui.tabSecond !== key ? ui.tabSecond : otherTab(key);
    ui.detailLayout = zone.layout;
    if (zone.slot === 'first') { ui.tab = key; ui.tabSecond = partner; } else { ui.tab = partner; ui.tabSecond = key; }
  } else placeTab(zone.slot, key);
  saveWorkspace(); render(); void loadMessages();
}
// The tracker's own statuses for this connection's projects, grouped as the tracker groups them; ticked ones are the only ones synced.
const statusGroups = { 0: 'Pending', 1: 'Progress', 2: 'Done', 3: 'On hold', 4: 'Feedback' };
const finishedName = name => /(^|\s)(complete|completed|done|closed|resolved|finished|fixed)(\s|$)|완료|完了|해결/i.test(String(name).replace(/[_-]+/g, ' '));
function statusPicker(source, prefix) {
  const options = new Map();
  for (const record of ui.snapshot.statuses || []) if ((source.projectIds || []).includes(String(record.projectId))) for (const option of record.data?.options || []) if (option.optionName && !options.has(option.optionName)) options.set(option.optionName, String(option.optionCategory ?? ''));
  if (!options.size) return '<p class="muted status-picker-empty">Sync once to choose exact statuses.</p>';
  const chosen = source.statuses?.length ? new Set(source.statuses) : new Set([...options].filter(([name, group]) => ['0', '1'].includes(group) && !finishedName(name)).map(([name]) => name));
  const groups = [...new Set([...options.values()])].sort();
  return `<fieldset class="status-picker"><legend>Statuses to sync</legend><p class="muted">${source.statuses?.length ? 'Only the ticked statuses are synced.' : 'Not chosen yet: the ticked boxes show the default. Change any box to sync exactly those.'}</p>${groups.map(group => `<div class="status-group"><strong>${esc(statusGroups[group] || `Group ${group}`)}</strong>${[...options].filter(([, value]) => value === group).map(([name]) => `<label class="status-option"><input type="checkbox" data-status-name="${esc(name)}" ${chosen.has(name) ? 'checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>`).join('')}<input type="hidden" name="${prefix}.statuses" value="${esc((source.statuses || []).join('\n'))}"></fieldset>`;
}
function renderIssueProperties(task, run) {
  const account = (ui.snapshot.sync || []).find(item => item.sourceId === task.sourceId)?.account || '', people = (ui.snapshot.directories || []).find(item => item.id === task.sourceId)?.employees || [];
  const assignees = (task.assignees || []).map(id => { const person = people.find(employee => employee.id === id || employee.email === id); return `${person?.name || id}${id === account ? ' (you)' : ''}`; }).join(', ');
  const rows = [['Status', task.statusName || task.status], ['Project', task.projectName], assignees && ['Assignees', assignees], task.parentTitle && ['Parent task', task.parentTitle], task.section && ['Group', task.section],
    ['Reporter', task.reporter], ['Created', task.createdAt], task.dueDate && ['Due', task.dueDate], ...(task.fields || []).map(field => [field.name, field.value]),
    task.category && ['Category', task.category], run && ['Agent', providerName(run.provider)]].filter(row => row && row[1]);
  return `<dl class="issue-properties">${rows.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
}
function renderIssueImages(task, images, label) {
  const shown = images.map(item => ({ ...item, url: safeUrl(item.url), thumbnail: safeUrl(item.thumbnail) })).filter(item => item.url);
  if (!shown.length) return '';
  return `<div class="issue-images" aria-label="${esc(label)}">${shown.map(item => `<figure><a href="${esc(taskImage(task, item.url))}" target="_blank" rel="noopener" data-original="${esc(item.url)}" ${viewable('image', taskImage(task, item.url), item.name, item.url)}><img loading="lazy" decoding="async" src="${esc(taskImage(task, item.thumbnail || item.url))}" alt="${esc(item.name)}" ${item.width && item.height ? `width="${item.width}" height="${item.height}"` : ''}></a><figcaption>${esc(item.name)}${item.width ? ` · ${item.width}×${item.height}` : ''}</figcaption></figure>`).join('')}</div>`;
}
function renderIssueFiles(task, files) {
  const shown = files.map(item => ({ ...item, url: safeUrl(item.url) })).filter(item => item.url);
  return shown.length ? `<ul class="issue-files">${shown.map(item => { const kind = mediaKind(item.name);
    return kind ? `<li><button type="button" class="file-view" ${viewable(kind, taskFile(task, item.url), item.name, item.url)}>${icon(kind === 'video' ? 'play' : 'image')}${esc(item.name)}</button><a class="file-original" href="${esc(item.url)}" target="_blank" rel="noopener">Original</a></li>`
      : `<li><a href="${esc(item.url)}" target="_blank" rel="noopener">${icon('file')}${esc(item.name)}</a></li>`; }).join('')}</ul>` : '';
}
function renderComment(task, comment) {
  return `<article class="comment${comment.system ? ' system' : ''}"><header><strong>${esc(comment.author || 'Tracker')}</strong><time>${esc(comment.at)}</time></header>${comment.text ? `<p>${esc(comment.text)}</p>` : ''}${renderIssueImages(task, comment.images || [], 'Comment images')}${renderIssueFiles(task, comment.files || [])}</article>`;
}
function renderIssueBrief(task) {
  if (task.detailLoaded === false) return taskErrors.has(task.id)
    ? `<div class="detail-state" role="alert"><p class="error-text">${esc(taskErrors.get(task.id))}</p>${button(`${icon('sync')} Retry loading details`, 'retry-task-detail', 'small')}</div>`
    : `<div class="detail-state" role="status"><span class="spinner" aria-hidden="true"></span>Loading the full description, screenshots, and comments…</div>`;
  const images = task.images || task.contentImages || [], files = task.files || task.contentFiles || [];
  const comments = (task.comments || []).filter(comment => !comment.system), activity = (task.comments || []).filter(comment => comment.system);
  return `<section class="issue-section" aria-labelledby="issue-description"><div class="issue-section-heading"><h3 id="issue-description">Description</h3>${task.demo ? '' : button(`${icon('sync')} Refresh`, 'refresh-task-detail', 'quiet small', loadingTasks.has(task.id) ? 'disabled' : 'title="Reload this issue from the tracker"')}</div>
    <div class="description">${task.description ? esc(task.description) : '<span class="muted">No written description. Check the screenshots or open the original issue.</span>'}</div></section>
    ${images.length ? `<section class="issue-section"><h3>Screenshots <span class="count-label">${images.length}</span></h3>${renderIssueImages(task, images, 'Issue screenshots')}</section>` : ''}
    ${files.length ? `<section class="issue-section"><h3>Attachments <span class="count-label">${files.length}</span></h3>${renderIssueFiles(task, files)}</section>` : ''}
    ${comments.length || activity.length ? `<section class="issue-section"><h3>Comments <span class="count-label">${comments.length}</span></h3>${comments.length ? comments.map(comment => renderComment(task, comment)).join('') : '<p class="muted">No comments yet.</p>'}${activity.length ? `<details class="tracker-activity"><summary>${activity.length} tracker update${activity.length === 1 ? '' : 's'}</summary>${activity.map(comment => renderComment(task, comment)).join('')}</details>` : ''}</section>` : ''}`;
}
async function loadTaskDetail() {
  const task = selectedTask();
  if (!task || task.detailLoaded !== false || loadingTasks.has(task.id) || taskErrors.has(task.id)) return;
  loadingTasks.add(task.id);
  try {
    const detail = await api(`/tasks/${encodeURIComponent(task.id)}`);
    taskErrors.delete(task.id);
    ui.snapshot.tasks = ui.snapshot.tasks.map(item => item.id === task.id ? detail : item);
    if (ui.page === 'inbox' && ui.selectedTask === task.id && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) render();
  } catch (error) { taskErrors.set(task.id, error.message); if (ui.page === 'inbox' && ui.selectedTask === task.id) render(); }
  finally { loadingTasks.delete(task.id); }
}
function renderRunPath(run) {
  const stages = ['Queued', 'Investigating', 'Fixing', 'Verifying', 'Review'];
  const index = ['ready_for_review', 'published'].includes(run.state) ? 4 : run.verification ? 3 : run.state === 'queued' ? 0 : 1;
  return `<ol class="run-path" aria-label="Agent workflow">${stages.map((stage, position) => `<li class="${position <= index ? 'done' : ''}">${stage}</li>`).join('')}</ol>`;
}
function boardStage(task) {
  const run = taskRun(task);
  if (run?.state === 'published') return 4;
  if (run?.state === 'ready_for_review' || run?.state === 'qa_passed') return 3;
  if (run && ['qa_failed', 'qa_blocked'].includes(run.state)) return 2;
  if (run && ['waiting', 'failed', 'interrupted', 'needs_evidence'].includes(run.state)) return 2;
  if (run && ['running', 'starting'].includes(run.state)) return 1;
  const mapping = ui.snapshot.config.sources.find(source => source.id === task.sourceId)?.statusMap || {};
  const status = String(task.statusName || task.status).toLowerCase();
  if (status === String(mapping.done || '').toLowerCase() || /^(complete|completed|done)$/.test(status)) return 4;
  if (status === String(mapping.review || '').toLowerCase() || /^(feedback|review)$/.test(status)) return 3;
  if (/^(hold|blocked)$/.test(status)) return 2;
  if (status === String(mapping.working || '').toLowerCase() || /^(progress|in.progress|working)$/.test(status)) return 1;
  return 0;
}
function renderBoard(tasks) {
  return `<div class="board" aria-label="Task progress board">${['Inbox', 'Working', 'Needs attention', 'Review', 'PR / completed'].map((name, position) => {
    const column = tasks.filter(task => boardStage(task) === position);
    return `<section class="board-column"><h2 class="board-heading">${name}<span>${column.length}</span></h2>${column.length ? column.map(task => `<button class="board-task" data-task="${esc(task.id)}" data-from-board="1"><strong>${esc(task.title)}</strong><span class="task-meta">${sourceLogo(task.source)}<span class="mono">#${esc(task.taskNumber || task.externalId)}</span><span>${esc(task.category || 'Unsorted')}</span></span><span class="task-meta">${renderTaskStates(task)}${task.demo ? '<span class="demo-label">Demo</span>' : ''}</span></button>`).join('') : '<p class="board-empty">No issues</p>'}</section>`;
  }).join('')}</div>`;
}
function messageText(message) {
  if (message.text || message.message) return message.text || message.message;
  if (message.kind === 'verification-started') return `Running regression checks: ${message.command}`;
  if (message.kind === 'verification-result') return `Tests ${message.passed ? 'passed' : 'failed'}. ${message.command}`;
  if (message.kind === 'tracker-status') return message.result?.skipped ? message.result.reason : `Tracker status updated: ${message.phase}`;
  return message.kind.replaceAll('-', ' ');
}
const toolName = name => String(name || 'tool').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
const clip = (value, size) => { const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''; return text.length > size ? `${text.slice(0, size)}\n… ${text.length - size} more characters` : text; };
// Prefer the field that says what the call does over the IDs it targets. An agent may pass a plain script or an
// argument list instead of an object, so that text is the summary itself rather than its first character.
const summaryText = value => typeof value === 'string' ? value
  : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(' ') : '';
const toolSummary = input => {
  const direct = summaryText(input);
  const fields = direct ? [] : Object.entries(input || {}).map(([key, value]) => [key, summaryText(value)]).filter(([, value]) => value.trim());
  const preferred = fields.find(([key]) => ['category', 'command', 'message', 'text', 'question', 'title', 'url', 'query', 'instructions', 'description'].includes(key)) || fields.find(([key]) => !/id$/i.test(key)) || fields[0];
  const line = (direct || (preferred ? preferred[1] : '')).replace(/\s+/g, ' ').trim();
  const plain = line.replace(/\*\*|`/g, '');
  return plain.length > 90 ? `${plain.slice(0, 89)}…` : plain;
};
const resultText = content => Array.isArray(content) ? content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n') : content;
// A safe markdown subset: everything is escaped first, then fenced code, inline code, bold, headings and bullets are restored.
function inlineMarkdown(text) {
  return esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function renderMarkdown(text) {
  const lines = String(text ?? '').split('\n'), blocks = [];
  const tableRow = line => /^\s*\|.*\|\s*$/.test(line), cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const code = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      index++; blocks.push({ block: true, html: `<pre class="md-code">${esc(code.join('\n'))}</pre>` }); continue;
    }
    if (tableRow(line) && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1] || '')) {
      const rows = []; while (index < lines.length && tableRow(lines[index])) rows.push(lines[index++]);
      const [head, , ...body] = rows;
      blocks.push({ block: true, html: `<div class="md-table"><table><thead><tr>${cells(head).map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${cells(row).map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` }); continue;
    }
    const heading = line.match(/^#{1,6} (.+)/);
    blocks.push({ block: false, html: heading ? `<strong class="md-heading">${inlineMarkdown(heading[1])}</strong>` : inlineMarkdown(line.replace(/^(\s*)[-*] /, '$1• ')) }); index++;
  }
  // Text lines keep their line breaks (the container preserves whitespace); tables and code blocks bring their own spacing.
  return blocks.map((item, position) => item.html + (!item.block && blocks[position + 1] && !blocks[position + 1].block ? '\n' : '')).join('');
}
const duration = ms => { const minutes = Math.max(0, Math.round(ms / 60000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; };
// What moved in this run, from recorded data: categorized issues, dispatched workers, finished tool calls, elapsed time.
function progressText(run) {
  const parts = [];
  if (run.role === 'coordinator') {
    const ids = run.taskIds || [], workers = ui.snapshot.runs.filter(item => item.parentRunId === run.id).length;
    parts.push(`${ui.snapshot.tasks.filter(task => ids.includes(task.id) && task.category).length} / ${ids.length} categorized`);
    if (workers) parts.push(plural(workers, 'worker'));
  }
  const calls = transcript(ui.runEvents.get(run.id) || []).filter(item => item.role === 'tool');
  if (calls.length) parts.push(`${calls.filter(call => call.result !== undefined).length} / ${calls.length} tool calls`);
  parts.push(duration((run.endedAt && doneStates.includes(run.state) ? new Date(run.endedAt) : Date.now()) - new Date(run.turnStartedAt || run.startedAt || run.createdAt)));
  return parts.join(' · ');
}
// Claude and Codex record their operations differently; both become agent text, tool calls with their results, and the deliberate messages.
function transcript(events) {
  const items = [], calls = new Map();
  for (const event of events) {
    if (event.kind === 'agent-operation' && event.type === 'assistant') {
      for (const block of event.content || []) {
        if (block.type === 'text' && block.text?.trim()) items.push({ role: 'agent', text: block.text, at: event.createdAt });
        if (block.type === 'tool_use') { const call = { role: 'tool', key: block.id, name: toolName(block.name), input: block.input, at: event.createdAt }; calls.set(block.id, call); items.push(call); }
      }
    } else if (event.kind === 'agent-operation' && event.type === 'tool-result') {
      for (const block of Array.isArray(event.content) ? event.content : []) {
        const call = calls.get(block.tool_use_id); if (call) { call.result = resultText(block.content); call.error = block.is_error; }
      }
    } else if (event.kind === 'agent-operation' && event.item) {
      const item = event.item;
      if (item.type === 'agentMessage') { if (event.method === 'item/completed' && item.text?.trim()) items.push({ role: 'agent', text: item.text, at: event.createdAt }); continue; }
      if (item.type === 'userMessage') continue;
      const known = calls.get(item.id);
      const call = known || { role: 'tool', key: item.id, name: item.type === 'mcpToolCall' ? toolName(item.tool) : item.type === 'commandExecution' ? 'command' : item.type, input: item.arguments || (item.command ? { command: item.command } : item.changes ? { files: item.changes.map(change => change.path) } : {}), at: event.createdAt };
      if (event.method === 'item/completed') { call.result = item.aggregatedOutput ?? item.result ?? item.error ?? item.status; call.error = item.status === 'failed'; }
      if (!known) { calls.set(item.id, call); items.push(call); }
    } else if (event.kind === 'human-message') items.push({ role: 'human', text: event.text, at: event.createdAt });
    else if (event.kind === 'turn-start') items.push({ role: 'status', text: `${event.resumed ? 'Resumed' : 'Started'} with ${providerName(event.provider)}`, at: event.createdAt });
    else if (event.kind === 'agent-result') items.push({ role: 'status', text: `Turn ended${event.subtype && event.subtype !== 'success' ? ` · ${event.subtype}` : ''}${event.cost ? ` · $${Number(event.cost).toFixed(2)}` : ''}`, at: event.createdAt });
    else if (event.visible || event.kind === 'error') items.push({ role: 'message', event });
  }
  return items;
}
function renderTranscriptItem(item) {
  if (item.role === 'human') return `<article class="message human-text"><div class="message-label"><strong>You</strong><time>${time(item.at)}</time></div><div class="md">${renderMarkdown(item.text)}</div></article>`;
  if (item.role === 'agent') return `<article class="message agent-text"><div class="message-label">${icon('agents')}<strong>Agent</strong><time>${time(item.at)}</time></div><div class="md">${renderMarkdown(item.text)}</div></article>`;
  if (item.role === 'tool') return `<details class="tool-call${item.error ? ' failed' : ''}" data-op="${esc(item.key)}" ${ui.openOps.has(item.key) ? 'open' : ''}><summary>${icon(item.result === undefined ? 'clock' : item.error ? 'alert' : 'check')}<strong>${esc(item.name)}</strong><span>${esc(toolSummary(item.input))}</span><time>${time(item.at)}</time></summary><pre>${esc(clip(item.input, 4000))}</pre>${item.result !== undefined ? `<pre class="tool-result">${esc(clip(item.result, 6000))}</pre>` : ''}</details>`;
  if (item.role === 'status') return `<p class="transcript-status">${esc(item.text)} · ${time(item.at)}</p>`;
  const message = item.event;
  return `<article class="message"><div class="message-label">${icon(message.kind === 'error' ? 'question' : 'agents')}<strong>${message.kind === 'error' ? 'Run needs attention' : message.kind === 'message' ? 'Agent' : 'Verification'}</strong><time>${time(message.createdAt)}</time></div><div class="md">${renderMarkdown(messageText(message))}</div>${message.kind === 'error' && /not signed in|not logged in|\/login/i.test(messageText(message)) ? button(`${icon('compass')} Fix agent sign-in`, 'setup', 'small') : ''}</article>`;
}
function renderMessages(runId) {
  const loaded = ui.runEvents.has(runId), items = transcript(ui.runEvents.get(runId) || []);
  const decisions = pending(runId).map(renderDecision).join(''), run = ui.snapshot.runs.find(item => item.id === runId);
  // A working run always shows that it is alive and when it last did something, even before its first tool call.
  const events = ui.runEvents.get(runId) || [], last = events.at(-1)?.createdAt;
  const live = run && ['starting', 'running'].includes(run.state) ? `<p class="transcript-status live" role="status"><span class="spinner" aria-hidden="true"></span>${run.state === 'starting' ? 'Preparing the agent' : `${providerName(run.provider)} is working`}${last ? ` · last activity ${time(last)}` : ''}</p>` : '';
  const terminal = run?.sessionId?.startsWith('orca:') ? orcaTerminal(run) : '';
  return `${terminal}<div class="transcript" data-transcript="${runId}">${items.length ? items.map(renderTranscriptItem).join('') : `<p class="empty-small">${loaded ? 'The agent\'s messages and tool calls appear here as it works.' : 'Loading the conversation…'}</p>`}${decisions}${live}</div>`;
}
function orcaTerminal(run) {
  const screen = ui.orcaScreens.get(run.id);
  return `<details class="orca-terminal" data-orca-panel="${run.id}" ${ui.orcaOpen.has(run.id) ? 'open' : ''}><summary>${icon('terminal')}<strong>Terminal</strong><span data-orca-status="${run.id}">${esc(screen?.error || (screen ? (screen.status === 'running' ? 'Live' : screen.status || 'Ended') : 'Connecting…'))}</span></summary><pre class="orca-screen" data-orca-screen="${run.id}" tabindex="0" aria-label="Orca terminal output">${esc((screen?.lines || []).join('\n'))}</pre></details>`;
}
async function pollOrcaScreens() {
  for (const element of document.querySelectorAll('[data-orca-screen]')) {
    const runId = element.dataset.orcaScreen, run = ui.snapshot?.runs.find(item => item.id === runId);
    if (!run || !ui.orcaOpen.has(runId) || (ui.orcaScreens.has(runId) && doneStates.includes(run.state))) continue;
    try { const screen = await api(`/runs/${runId}/terminal`); ui.orcaScreens.set(runId, screen); }
    catch (error) { ui.orcaScreens.set(runId, { ...(ui.orcaScreens.get(runId) || { lines: [] }), error: error.message }); }
    const screen = ui.orcaScreens.get(runId), target = document.querySelector(`[data-orca-screen="${runId}"]`);
    if (!target) continue;
    const pinned = target.scrollHeight - target.scrollTop - target.clientHeight < 30;
    target.textContent = (screen.lines || []).join('\n'); if (pinned) target.scrollTop = target.scrollHeight;
    const status = document.querySelector(`[data-orca-status="${runId}"]`); if (status) status.textContent = screen.error || (screen.status === 'running' ? 'Live' : screen.status || 'Ended');
  }
  setTimeout(pollOrcaScreens, 2000);
}
// Each transcript stays pinned to its newest entry unless the reader scrolled up in that pane.
function restoreTranscript() {
  for (const box of document.querySelectorAll('.transcript[data-transcript]')) {
    const state = ui.transcripts.get(box.dataset.transcript) || { stick: true, top: 0 };
    box.scrollTop = state.stick ? box.scrollHeight : state.top;
  }
}
function renderDecision(item) {
  const request = item.request || {};
  const originRun = ui.snapshot.runs.find(run => run.id === item.runId);
  const originTask = ui.snapshot.tasks.find(task => task.id === originRun?.taskId);
  const originTitle = originTask ? `${originTask.sourceName} #${originTask.taskNumber || originTask.externalId} · ${originTask.title}` : originRun?.title || 'Agent conversation';
  const schema = request.requestedSchema;
  const properties = schema?.properties || {};
  const questions = request.questions || [];
  const fields = Object.entries(properties).map(([key, property]) => renderQuestionField(key, property, schema?.required?.includes(key))).join('')
    + questions.map(question => renderQuestionField(question.id || question.question, { type: 'string', title: question.question,
      enum: question.options?.map(option => option.label), description: question.options?.map(option => `${option.label}: ${option.description || ''}`).join('\n') }, true)).join('');
  const details = item.kind === 'approval' ? request.command || request.input || request : null;
  const link = request.mode === 'url' ? safeUrl(request.url) : '';
  return `<form class="decision ${esc(item.kind)}" data-interaction="${item.id}"><div class="decision-context"><button class="decision-run-link" type="button" data-run="${esc(item.runId)}">${icon('branch')}<span>${esc(originTitle)}</span></button><small>${item.kind === 'approval' ? 'Approval' : 'Question'} · Run ${esc(item.runId.slice(0, 8))} · ${originRun?.provider === 'claude' ? 'Claude Code' : originRun?.provider === 'codex' ? 'Codex' : 'External AI'}</small></div><h3>${icon(item.kind === 'approval' ? 'check' : 'question')}<span>${esc(String(item.title).replace(/mcp__[a-z0-9_]+?__/gi, ''))}</span></h3>${details ? `<pre>${esc(typeof details === 'string' ? details : JSON.stringify(details, null, 2))}</pre>` : ''}${link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener">Open ${esc(new URL(link).hostname)}</a></p>` : ''}${fields}<div class="actions"><button class="button primary small" type="submit" name="decision" value="accept">${item.kind === 'approval' ? 'Approve once' : 'Send answer'}</button>${request.allowAlways ? `<button class="button small" type="submit" name="decision" value="always" formnovalidate title="Stop asking about ${esc(toolName(request.tool))} until this run ends">Always allow for this run</button>` : ''}<button class="button small" type="submit" name="decision" value="decline" formnovalidate>Decline</button><button class="button quiet small" type="submit" name="decision" value="cancel" formnovalidate>Cancel request</button></div></form>`;
}
function renderQuestionField(key, property, required) {
  const extra = `name="${esc(key)}" aria-label="${esc(property.title || key)}" data-type="${esc(property.type)}" ${required ? 'required' : ''}`;
  let control;
  if (property.type === 'boolean') control = `<select ${extra}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select>`;
  else if (property.enum) control = `<select ${extra}><option value="">Choose…</option>${property.enum.map(value => `<option>${esc(value)}</option>`).join('')}<option value="__custom">Write another answer…</option></select><input name="${esc(key)}__custom" class="hidden custom-answer" placeholder="Your answer" aria-label="Custom answer">`;
  else control = `<input ${extra} type="${['number', 'integer'].includes(property.type) ? 'number' : 'text'}" ${property.type === 'number' ? 'step="any"' : ''} placeholder="Your answer">`;
  return `<label class="field"><span>${esc(property.title || key)}</span>${control}${property.description ? `<small>${esc(property.description)}</small>` : ''}</label>`;
}
const doneStates = ['ready_for_review', 'published', 'failed', 'stopped', 'interrupted', 'finished', 'qa_passed', 'qa_failed', 'qa_blocked'];
// Issues a developer marked complete are QA work, so verifying comes first; open bugs lead with a fix.
const awaitsQa = task => /complet|done|resolved|verif|\bqa\b|feedback/i.test(String(task.statusName || task.status || ''));
function issueRunActions(task, run, primaryClass = 'primary small') {
  const live = run && !doneStates.includes(run.state), disabled = task.demo ? 'disabled title="Connect real tasks to run an agent"' : '';
  if (live) return button('Open run', 'open-task-run', primaryClass);
  const verifyFirst = awaitsQa(task);
  return `${button(`${icon('copy')} Copy handoff`, 'copy-handoff', 'small quiet', `type="button" data-task-id="${esc(task.id)}" title="Copy this issue and the Rex Desk working rules, to paste into any agent session"`)}${run ? button('Last run', 'open-task-run', 'small quiet') : ''}${button(`${icon('check')} Verify fix`, 'launch-verify', verifyFirst ? primaryClass : 'small', disabled)}${button(`${icon('play')} Fix with agent`, 'launch-task', verifyFirst ? 'small' : primaryClass, disabled)}`;
}
const verdictLabels = { pass: 'Fix works', fail: 'Still broken', blocked: 'Could not check' };
function renderQa(run) {
  const qa = run.qa;
  const site = safeUrl(run.qaUrl), signIn = site ? `<div class="qa-site">${icon('link')}<code title="${esc(site)}">${esc(site)}</code>${button(`${icon('link')} Sign in to ${esc(new URL(site).host)}`, 'qa-sign-in', 'small quiet', `type="button" data-url="${esc(site)}"`)}</div>` : '';
  if (!qa) return `<p class="muted">${site ? 'Testing on the site the agent chose, with your saved sign-in…' : 'The agent is finding where this project runs for this issue…'}</p>${signIn}${renderProof(run.id)}`;
  const done = run.trackerPhase === 'done', reopened = run.trackerPhase === 'working';
  return `<div class="qa-verdict ${esc(qa.verdict)}"><strong>${verdictLabels[qa.verdict] || esc(qa.verdict)}</strong><div class="md">${renderMarkdown(qa.summary)}</div>${qa.reason ? `<small>${esc(qa.reason)}</small>` : ''}</div>${signIn}
    ${qa.comment ? `<div class="qa-comment"><div class="qa-comment-head"><span>Tracker comment</span>${button(`${icon('copy')} Copy`, 'copy-text', 'small quiet', `type="button" data-text="${esc(qa.comment)}"`)}</div><div class="md">${renderMarkdown(qa.comment)}</div></div>` : ''}
    <div class="actions">${qa.verdict === 'pass' ? button(done ? `${icon('check')} Marked done` : 'Mark done in tracker', 'qa-tracker', 'small primary', `data-phase="done"${done ? ' disabled' : ''}`) : ''}${qa.verdict === 'fail' ? button(reopened ? `${icon('check')} Reopened` : 'Reopen in tracker', 'qa-tracker', 'small', `data-phase="working"${reopened ? ' disabled' : ''}`) : ''}</div>${renderProof(run.id)}`;
}
// Git checkouts found beside the configured ones, so another project is one click away instead of a typed path.
function foundRepositories() {
  if (ui.foundLoading) return '<p class="muted">Looking for other repositories on this computer…</p>';
  if (!ui.found) return `<div class="actions">${button('Find repositories on this computer', 'find-repositories', 'small', 'type="button"')}</div>`;
  const configured = new Set(ui.draft.repositories.map(item => String(item.path || '').toLowerCase()));
  const rest = ui.found.filter(item => !configured.has(item.path.toLowerCase()));
  if (!rest.length) return '<p class="muted">No other Git checkout was found beside the ones above.</p>';
  return `<div class="settings-card"><div class="settings-card-header"><strong>Found on this computer</strong><small class="muted">${rest.length} more</small></div><ul class="found-repositories">${rest.map(item =>
    `<li><span><strong>${esc(item.name)}</strong> <code>${esc(item.path)}</code><small class="muted">${esc(item.branch)}${item.remote ? ` · ${esc(item.remote)}` : ''}</small></span>${button('Add', 'add-found-repository', 'small', `type="button" data-path="${esc(item.path)}" data-name="${esc(item.name)}"`)}</li>`).join('')}</ul></div>`;
}
function qaSitesList() {
  const sites = [...new Set(ui.snapshot.runs.filter(run => run.role === 'verifier' && safeUrl(run.qaUrl)).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).map(run => new URL(run.qaUrl).origin))].slice(0, 6);
  return sites.length ? `<div class="qa-sites"><span>Sites QA checks used</span><ul>${sites.map(site => `<li><code>${esc(site)}</code>${button('Sign in', 'qa-sign-in', 'small quiet', `type="button" data-url="${esc(site)}"`)}</li>`).join('')}</ul></div>` : '<p class="muted">No QA check has run yet. Sites the agent chooses appear here.</p>';
}
function testAccountRow(account, index) {
  const prefix = `testAccounts.${index}`;
  return `<div class="settings-card" data-test-account="${account.id}"><div class="settings-card-header"><strong>Sign-in ${index + 1}</strong>${button(`${icon('close')} Remove`, 'remove-test-account', 'quiet small', `type="button" data-id="${account.id}"`)}</div><div class="field-row three">${inputField('Site', `${prefix}.site`, account.site || '', 'The server this account exists on, for example morningmate.info or 127.0.0.1. Leave blank for the account to use wherever no other matches.', 'text', 'morningmate.info')}${inputField('Account', `${prefix}.username`, account.username || '', '', 'text', 'name@example.com')}<label class="field"><span>Password</span><input type="password" name="${prefix}.password" autocomplete="new-password" value="${esc(account.password || '')}" placeholder="${account.hasPassword ? 'Saved · type to replace' : 'Password'}"><small>Encrypted. Agents type it with a placeholder and never see it.</small></label></div></div>`;
}
function qaSessionText() {
  const session = ui.snapshot.qaSession;
  return session?.open ? 'Sign-in window is open. Sign in, then close it.' : session?.savedAt ? `Sign-in saved ${relative(session.savedAt).toLowerCase()}.` : 'No sign-in saved yet.';
}
function scheduleText() {
  const last = ui.snapshot.schedule;
  if (!last) return 'Has not run yet.';
  if (last.state === 'armed') return 'Starts at the next scheduled time.';
  if (last.state === 'started') return `Last run ${last.date}: a main agent started for ${plural(last.issues || 0, 'new issue')}.`;
  return `Last run ${last.date}: ${last.reason || last.state}`;
}
// While the test-site sign-in window is open, keep the saved-session line current.
async function watchQaSession() {
  clearTimeout(ui.qaTimer);
  ui.snapshot.qaSession = (await api('/state')).qaSession;
  for (const element of document.querySelectorAll('[data-qa-session]')) element.textContent = qaSessionText();
  if (ui.snapshot.qaSession?.open) ui.qaTimer = setTimeout(watchQaSession, 3000);
}
async function loadAutostart() {
  const box = document.querySelector('#autostart'); if (!box) return;
  const status = await api('/autostart').catch(() => ({ supported: false }));
  box.checked = Boolean(status.enabled); box.disabled = !status.supported;
}
function renderProof(runId) {
  if (!runId) return '<p class="empty-small">Recorded browser tests, screenshots, and reports appear here after an agent starts working.</p>';
  const run = ui.snapshot.runs.find(item => item.id === runId);
  const artifacts = ui.snapshot.artifacts.filter(item => item.runId === runId);
  return `${renderRisk(run)}${run?.checks ? `<div class="check-list">${(run.role === 'verifier' ? [['recordedVideo', 'Browser recording saved'], ['browserAssertionPassed', 'Expected behavior asserted']] : [['testsPassed', 'Tests pass for the current code'], ['recordedVideo', 'Browser recording saved'], ['browserAssertionPassed', 'Browser assertion matches current code']]).map(([key, title]) => `<div class="check-row ${run.checks[key] ? '' : 'missing'}">${icon(run.checks[key] ? 'check' : 'clock')}<span>${title}</span></div>`).join('')}</div>` : ''}
    ${artifacts.length ? artifacts.map(artifact => `<div class="proof-item"><a href="${artifactUrl(artifact)}" target="_blank" rel="noopener">${icon(artifact.type === 'video/webm' ? 'play' : 'file')}${esc(artifact.title)}</a><small>${relative(artifact.createdAt)}</small>${artifact.type === 'video/webm' ? `<video controls preload="metadata" src="${artifactUrl(artifact)}"></video>` : artifact.type === 'image/png' ? `<img src="${artifactUrl(artifact)}" alt="${esc(artifact.title)}" loading="lazy" ${viewable('image', artifactUrl(artifact), artifact.title)}>` : ''}<div class="proof-links">${artifact.type === 'video/webm' ? `<button type="button" class="link-button" ${viewable('video', artifactUrl(artifact), artifact.title)}>View larger</button>` : ''}<a href="${artifactUrl(artifact)}?download" download>Download</a></div></div>`).join('') : '<p class="empty-small">No evidence yet. The agent must record its browser test and run verification.</p>'}`;
}
// An inbox of requests: every waiting decision in a list, the selected one answered beside it.
function renderDecisions() {
  const items = pending();
  if (!items.length) return `${heading('Needs you', 'Answer a question or approve a specific action. Agents continue from your response.')}<div class="panel"><div class="empty">${icon('check')}<h2>No decisions waiting</h2><p>Questions, tool permissions, and pull request approvals will appear here when an agent needs you.</p></div></div>`;
  const current = items.find(item => item.id === ui.selectedDecision) || items[0];
  return `${heading('Needs you', `${plural(items.length, 'request')} waiting. Agents continue from your response.`)}<div class="decision-split"><ul class="decision-list" aria-label="Waiting requests">${items.map(item => {
    const run = ui.snapshot.runs.find(entry => entry.id === item.runId);
    return `<li><button class="decision-item${item.id === current.id ? ' active' : ''}" data-action="select-decision" data-id="${item.id}" aria-current="${item.id === current.id}"><span class="state-dot waiting"></span><span><strong>${esc(String(item.title).replace(/mcp__[a-z0-9_]+?__/gi, ''))}</strong><small>${item.kind === 'approval' ? 'Approval' : 'Question'} · ${esc(run?.title || 'Agent conversation')}</small></span><time>${item.createdAt ? relative(item.createdAt) : ''}</time></button></li>`;
  }).join('')}</ul><div class="decision-detail">${renderDecision(current)}</div></div>`;
}
const activeStates = ['running', 'waiting', 'starting', 'queued'];
const runGroups = [['Needs you', run => run.state === 'waiting' || pending(run.id).length], ['Working', run => activeStates.includes(run.state)], ['Review', run => ['ready_for_review', 'needs_evidence', 'qa_passed', 'qa_failed', 'qa_blocked'].includes(run.state)], ['Done', () => true]];
// Agent runs page: every run in the sidebar, the open ones side by side in the main area.
function sideSwitch() {
  return `<div class="view-switch" role="group" aria-label="Sidebar">${[['runs', 'agents', 'Runs'], ['issues', 'inbox', 'Issues']].map(([value, glyph, label]) => `<button class="${ui.runSide === value ? 'active' : ''}" data-action="run-side" data-side="${value}" aria-pressed="${ui.runSide === value}">${icon(glyph)}${label}</button>`).join('')}</div>`;
}
// Issues beside the live panes: pick, analyze, or start an agent without leaving the workspace.
function renderWorkspaceIssues() {
  const tasks = filteredTasks(), task = selectedTask(), run = task && taskRun(task);
  return `<div class="side-head"><h2>Issues <span class="count-label">${ui.snapshot.tasks.length}</span></h2>${sideSwitch()}</div><div class="side-actions">${issueActions()}</div>${toolbar()}
    <div id="task-list" class="task-list">${tasks.length ? tasks.map(renderTaskRow).join('') : emptyTasks()}</div>
    ${task ? `<section class="issue-preview" aria-label="Selected issue"><div class="detail-reference">${sourceLogo(task.source)}<span class="mono">#${esc(task.taskNumber || task.externalId)}</span>${renderTaskStates(task, run)}</div><h3>${esc(task.title)}</h3><dl class="detail-properties"><dt>Project</dt><dd>${esc(task.projectName || '—')}</dd><dt>Category</dt><dd>${esc(task.category || 'Not analyzed yet')}</dd>${run?.branch ? `<dt>Branch</dt><dd><code>${esc(run.branch)}</code></dd>` : ''}</dl><div class="actions">${issueRunActions(task, run, 'small primary')}${button('Full issue', 'open-issue', 'small quiet')}</div></section>` : ''}`;
}
function renderRunSide() {
  if (ui.runSide === 'issues') return renderWorkspaceIssues();
  const runs = [...ui.snapshot.runs].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))), placed = new Set();
  const groups = runGroups.map(([name, test]) => { const items = runs.filter(run => !placed.has(run.id) && test(run)); items.forEach(run => placed.add(run.id)); return [name, items]; }).filter(([, items]) => items.length);
  const live = runs.filter(run => activeStates.includes(run.state) || pending(run.id).length);
  return `<div class="side-head"><h2>Runs <span class="count-label">${runs.length}</span></h2>${sideSwitch()}</div>${live.length > 1 ? `<div class="side-actions">${button(`${icon('board')} Watch ${Math.min(live.length, 4)} live runs side by side`, 'open-live', 'small')}</div>` : ''}
    ${runs.length ? groups.map(([name, items]) => `<div class="run-group"><h3>${name}<span>${items.length}</span></h3>${items.map(run => `<button class="run-item${ui.openRuns.includes(run.id) ? ' open' : ''}${run.id === ui.selectedRun ? ' focused' : ''}" data-run="${run.id}"><span class="state-dot ${esc(run.state)}"></span><span class="run-item-text"><strong>${esc(run.title)}</strong><small>${providerName(run.provider)} · ${run.role === 'coordinator' ? `${(run.taskIds || []).length} issues` : esc(run.branch ? run.branch.split('/').at(-1) : labels[run.state] || run.state)}</small></span><time>${relative(run.createdAt)}</time></button>`).join('')}</div>`).join('') : `<p class="side-empty">No agent runs yet. Select issues and choose Analyze & run.</p>`}`;
}
function layoutSwitch() {
  return `<div class="layout-switch" role="group" aria-label="Pane layout">${[['single', 'One pane'], ['split', 'Two panes side by side'], ['grid', 'Up to four panes']].map(([value, label]) => `<button class="${ui.layout === value ? 'active' : ''}" data-action="set-layout" data-layout="${value}" aria-label="${label}" aria-pressed="${ui.layout === value}" title="${label}"><span class="layout-glyph ${value}" aria-hidden="true"><i></i><i></i><i></i><i></i></span></button>`).join('')}</div>`;
}
function renderWorkspace() {
  const open = ui.openRuns.map(id => ui.snapshot.runs.find(run => run.id === id)).filter(Boolean), shown = visibleRuns();
  if (!open.length) return `${workspaceNotices()}<div class="workspace-empty empty">${icon('agents')}<h2>${ui.snapshot.runs.length ? 'Open runs to watch them side by side' : 'No agent runs yet'}</h2><p>${ui.snapshot.runs.length ? 'Choose a run in the list. Up to four stay live here at once, each with its own conversation, approvals, and proof.' : 'Sync your assigned issues, then use Analyze & run to start a main agent.'}</p>${ui.snapshot.runs.length ? '' : button('Open my issues', 'inbox', 'primary small')}</div>`;
  return `<div class="tabstrip"><div class="run-tabs" role="tablist" aria-label="Open runs">${open.map((run, index) => `<div class="run-tab${run.id === ui.selectedRun ? ' active' : ''}${shown.includes(run) ? ' shown' : ''}"><button role="tab" aria-selected="${run.id === ui.selectedRun}" data-action="focus-run" data-id="${run.id}" title="${esc(run.title)}${index < 9 ? ` · Alt+${index + 1}` : ''}"><span class="state-dot ${esc(run.state)}"></span>${esc(run.role === 'coordinator' ? 'Main agent' : run.title)}</button><button class="run-tab-close" data-action="close-run" data-id="${run.id}" aria-label="Close ${esc(run.title)}">${icon('close')}</button></div>`).join('')}</div><div class="tabstrip-tools"><span>${shown.length} of ${open.length} shown${open.length > 1 ? ` · Alt+1–${Math.min(open.length, 9)} switches` : ''}</span>${layoutSwitch()}</div></div>
    <div class="panes count-${shown.length}">${shown.map(renderPane).join('')}</div>`;
}
function renderPane(run) {
  const waiting = pending(run.id).length, workers = ui.snapshot.runs.filter(item => item.parentRunId === run.id);
  const journal = `<details class="activity-link" data-journal="${run.id}"><summary>Work journal</summary><div class="journal" id="journal-${run.id}">${renderJournal(run.id)}</div></details>`;
  // The main agent only earns a side column once it has dispatched workers; otherwise the transcript keeps the width.
  const proof = run.role === 'coordinator' && !workers.length ? '' : `<aside class="pane-proof"><h3>${run.role === 'coordinator' ? 'Dispatch' : run.role === 'verifier' ? 'QA result' : 'Worktree & proof'}</h3>${run.role === 'coordinator' ? renderDispatch(workers) : run.role === 'verifier' ? renderQa(run) : renderRunFacts(run)}${run.prUrl ? `<p><a href="${esc(safeUrl(run.prUrl))}" target="_blank" rel="noopener">Open draft pull request</a></p>` : ''}${run.role === 'worker' ? renderProof(run.id) : ''}${journal}</aside>`;
  return `<section class="pane${run.id === ui.selectedRun ? ' focused' : ''}${run.id === ui.flashRun ? ' flash' : ''}${waiting ? ' needs-you' : ''}" data-pane-run="${run.id}" aria-label="${esc(run.title)}">
    <header class="pane-head"><span class="state-dot ${esc(run.state)}"></span><h2>${esc(run.title)}</h2><span class="pane-provider">${providerName(run.provider)}</span>${tag(run.state)}<span class="pane-actions">${run.worktree ? button(icon('terminal'), 'open-orca', 'small quiet icon-only', 'aria-label="Open in Orca" title="Open a plain terminal in this worktree in Orca"') : ''}${button(icon('close'), 'close-run', 'small quiet icon-only', `data-id="${run.id}" aria-label="Close pane"`)}</span></header>
    <div class="pane-sub">${run.role === 'verifier' ? (run.qaUrl ? `${icon('link')}<code title="${esc(run.qaUrl)}">${esc(run.qaUrl)}</code>` : '<span>Finding the test site</span>') : run.branch ? `${icon('branch')}<code title="${esc(run.branch)}">${esc(run.branch)}</code>` : `<span>${run.role === 'coordinator' ? `Analyzing ${plural((run.taskIds || []).length, 'issue')}` : 'Worktree preparing'}</span>`}<span class="pane-progress">${esc(progressText(run))}</span></div>
    ${run.execution === 'orca' ? `<div class="run-status-strip pane-notice">${icon('terminal')}<span>Runs in an Orca terminal. Tool approvals happen there; questions, evidence, and PR approval stay here.</span></div>` : ''}
    ${run.error ? `<div class="notice pane-notice">${icon('alert')}<span>${esc(run.error)}</span>${/not signed in|not logged in|\/login/i.test(run.error) ? button('Fix agent sign-in', 'setup', 'small') : ''}</div>` : ''}
    <div class="pane-body"><div class="pane-conversation" id="messages-${run.id}">${renderMessages(run.id)}${proof ? '' : journal}</div>${proof ? `<div class="proof-resizer" role="separator" tabindex="0" data-resize="proof" aria-orientation="vertical" aria-label="Resize the ${run.role === 'verifier' ? 'QA result' : 'proof'} column" aria-valuemin="200" aria-valuenow="${ui.proofWidth || 260}" title="Drag to resize · double-click to reset"></div>` : ''}${proof}</div>${renderPaneFooter(run)}</section>`;
}
// A live run can only be stopped; a finished one takes a follow-up in place, continuing with the same agent.
function renderPaneFooter(run) {
  if (run.external) return '';
  if (run.execution === 'orca' && run.sessionId?.startsWith('orca:') && ['running', 'waiting'].includes(run.state)) return `<form class="pane-foot composer" data-say="${run.id}"><input name="text" required aria-label="Message to ${esc(run.title)}" placeholder="Message the agent…" autocomplete="off"><button class="button small primary" type="submit">Send</button>${button('Stop', 'stop-run', 'small quiet danger', 'type="button"')}</form>`;
  if (activeStates.includes(run.state)) return `<footer class="pane-foot"><span>${run.state === 'waiting' ? 'Waiting for your answer above' : 'Working. Follow-ups open when this turn ends.'}</span>${button('Stop', 'stop-run', 'small quiet danger')}</footer>`;
  const review = run.state === 'ready_for_review';
  return `<form class="pane-foot composer" data-composer="${run.id}"><input name="prompt" required aria-label="Follow-up for ${esc(run.title)}" placeholder="${review ? 'Request changes…' : 'Continue with a follow-up…'}" autocomplete="off"><button class="button small" type="submit">${review ? 'Request changes' : 'Send'}</button>${button('Switch agent', 'resume-run', 'small quiet', 'type="button" title="Continue with another provider or execution"')}${button('Copy handoff', 'copy-handoff', 'small quiet', `type="button" data-run-id="${run.id}" title="Copy this run's context and the Rex Desk working rules, to paste into any agent session"`)}${review ? button('Create draft PR', 'publish-run', 'small primary', 'type="button"') : ''}</form>`;
}
function renderDispatch(workers) {
  return `<ul class="dispatch-list">${workers.map(worker => `<li><button data-run="${worker.id}"><span class="state-dot ${esc(worker.state)}"></span><span>${esc(worker.title)}</span></button></li>`).join('')}</ul>`;
}
function renderRunFacts(run) {
  return run.worktree ?`<dl class="detail-properties"><dt>Base</dt><dd>${esc(run.baseBranch)}</dd><dt>PR target</dt><dd>${esc(run.targetBranch)}</dd><dt>Port</dt><dd>${run.port}</dd><dt>Folder</dt><dd><code title="${esc(run.worktree)}">${esc(run.worktree).replace(/([\\/])/g, '$1<wbr>')}</code></dd></dl>` : '';
}
function journalText(event) {
  if (event.text || event.message || event.result) return event.text || event.message || event.result;
  const { sequence, kind, visible, createdAt, ...rest } = event;
  return JSON.stringify(rest.item || rest.content || rest, null, 2);
}
function renderJournal(runId) {
  const journal = ui.journals.get(runId) || [];
  return journal.length ? journal.map(event => `<div class="journal-entry"><div><time>${esc(time(event.createdAt))}</time><span>${esc(event.kind.replaceAll('-', ' '))}</span></div><pre>${esc(journalText(event))}</pre></div>`).join('') : '<p class="empty-small">Open the journal to load recorded operations.</p>';
}
function renderEvidence() {
  const runs = ui.snapshot.runs.filter(run => ui.snapshot.artifacts.some(item => item.runId === run.id));
  return `${heading('Evidence', 'Review recordings and actual test output before publishing a fix.')}<div class="evidence-grid">${runs.length ? runs.map(run => `<section class="evidence-card"><h3>${esc(run.title)}</h3>${tag(run.state)}${renderProof(run.id)}${button('Open run', 'open-evidence-run', 'small', `data-id="${run.id}"`)}</section>`).join('') : `<div class="panel"><div class="empty">${icon('play')}<h2>Proof belongs to the fix</h2><p>Browser recordings, screenshots, Playwright traces, and portable reports will appear after an agent verifies an issue.</p></div></div>`}</div>`;
}

function inputField(label, name, value, hint = '', type = 'text', placeholder = '') {
  const hintId = `hint-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return `<label class="field"><span>${label}</span><input name="${esc(name)}" aria-label="${esc(label)}" ${hint ? `aria-describedby="${hintId}"` : ''} value="${esc(value)}" type="${type}" placeholder="${esc(placeholder)}" ${type === 'password' ? 'autocomplete="new-password"' : ''}>${hint ? `<small id="${hintId}">${hint}</small>` : ''}</label>`;
}
function orcaReadiness(status, repositoryId) {
  if (!status) return '<p class="muted orca-status">Checking Orca…</p>';
  if (!status.available) return `<p class="error-text orca-status">${esc(status.error || 'Orca CLI is unavailable.')}</p>`;
  if (status.ready) return `<p class="muted orca-status">${icon('check')} Orca shows Rex worktrees for ${esc(status.repository.name)}. The agent opens in a new Orca terminal tab.</p>`;
  return `<div class="setup-callout orca-status">${icon('alert')}<span>${status.repository?.registered ? `Orca hides external worktrees for ${esc(status.repository.name)}.` : 'This repository is not in Orca yet.'} Rex Desk can ${status.repository?.registered ? 'show its worktrees there' : 'add it and show its worktrees'}.</span>${button('Show Rex worktrees in Orca', 'orca-show', 'small', `type="button" data-repository="${esc(repositoryId)}"`)}</div>`;
}
async function updateOrcaReadiness(form) {
  const target = form?.querySelector('#orca-readiness'); if (!target) return;
  const repositoryId = form.elements.repositoryId?.value || selectedRun()?.repositoryId || ui.snapshot.config.repositories[0]?.id;
  if (!repositoryId) { target.innerHTML = ''; return; }
  target.innerHTML = orcaReadiness(null);
  const status = await api(`/orca?repositoryId=${encodeURIComponent(repositoryId)}`).catch(error => ({ available: false, error: error.message }));
  if (target.isConnected) target.innerHTML = orcaReadiness(status, repositoryId);
}
function providerSelect(name, value) { return `<select name="${name}"><option value="claude" ${value === 'claude' ? 'selected' : ''}>Claude Code</option><option value="codex" ${value === 'codex' ? 'selected' : ''}>Codex</option></select>`; }
function renderSettings() {
  const config = ui.draft || ui.snapshot.config;
  return `${heading('Settings', 'Connect your projects once. Change accounts, keys, repositories, and agent defaults here.')}
    <div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections"><a href="#connections">Connections</a><a href="#jev">Jev priority</a><a href="#qa">QA verification</a><a href="#schedule">Schedule</a><a href="#repositories">Repositories</a><a href="#github">GitHub</a><a href="#agents">Agents & workflow</a><a href="#agent-sign-in">Agent sign-in</a><a href="#cloud-backup">Cloud backup</a><a href="#appearance">Appearance</a><a href="#ai-connection">AI connection</a></nav>
    <form id="settings-form"><section class="settings-section" id="connections"><h2>Flow & Morningmate</h2><p>Only issues assigned to your account in these project IDs are imported. API keys stay encrypted on this computer.</p>${config.sources.map((source, index) => renderSourceSettings(source, index)).join('')}${button(`${icon('plus')} Add connection`, 'add-source', '', 'type="button"')}</section>
    <section class="settings-section" id="jev"><h2>Jev priority</h2><p>Jev, TypeSafe AI's decision model, rates each assigned issue through your OpenRouter key: severity, next step (fix, verify, or wait), effort, and whether it can be checked in a browser. Rex Desk ranks the issues from those answers and the due date. You choose what to run. The same key gives each new run an English branch name that describes the issue.</p><div class="settings-card"><label class="field"><span>OpenRouter API key</span><input type="password" name="jev.apiKey" autocomplete="off" spellcheck="false" placeholder="${config.jev?.hasKey ? 'Saved · type a new key to replace it' : ui.snapshot.jev?.keySource === 'environment' ? 'Using OPENROUTER_API_KEY from the environment' : 'sk-or-…'}"><small>Stored encrypted on this computer and sent only to OpenRouter.</small></label>${config.jev?.hasKey ? '<label class="field check"><input type="checkbox" name="jev.clearKey"><span>Remove the saved key</span></label>' : ''}${inputField('Jev model', 'jev.model', config.jev?.model || '', 'Blank uses the newest Jev release.', 'text', '~typesafe/jev-latest')}<label class="field check"><input type="checkbox" name="jev.auto" ${config.jev?.auto !== false ? 'checked' : ''}><span>Rate new and changed issues after each sync</span></label></div></section>
    <section class="settings-section" id="qa"><h2>QA verification</h2><p>Re-test fixes developers marked complete. For each issue the agent finds where the project runs, such as the dev or QA server for its product and region, opens it in a recorded browser with your sign-in, checks the expected behavior, and reports pass, fail, or blocked. It never changes code.</p><div class="settings-card">${qaSitesList()}<p class="muted">Save one sign-in per test server. Agents are given the one whose site matches the page they are on, and none of them is ever typed into a live production site.</p>${config.testAccounts.map(testAccountRow).join('')}<div class="actions">${button('Add a sign-in', 'add-test-account', 'small', 'type="button"')}</div><div class="actions">${button(`${icon('link')} Open sign-in browser`, 'qa-sign-in', 'small', 'type="button"')}<small class="muted" data-qa-session>${qaSessionText()}</small></div><small class="muted">Sign in to the test sites you use, then close the window. The session stays on this computer and is used only by QA checks. Production sites need this saved sign-in: the test account above is not used there.</small></div></section>
    <section class="settings-section" id="schedule"><h2>Schedule</h2><p>Let Rex Desk start work on its own while this computer is on. At the set time it syncs, a main agent sorts new issues, and it starts up to your daily limit. Approvals and results wait in Needs you.</p><div class="settings-card"><label class="field check"><input type="checkbox" name="schedule.enabled" ${config.schedule?.enabled ? 'checked' : ''}><span>Start work automatically on a schedule</span></label><div class="field-row">${inputField('Time', 'schedule.time', config.schedule?.time || '09:00', '', 'time')}${inputField('Most runs per day', 'schedule.maxRuns', config.schedule?.maxRuns || 6, 'Caps agent cost. 1–20.', 'number')}</div><fieldset class="day-picker"><legend>Days</legend>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => `<label><input type="checkbox" name="schedule.days" value="${index}" ${(config.schedule?.days || [1, 2, 3, 4, 5]).includes(index) ? 'checked' : ''}><span>${day}</span></label>`).join('')}</fieldset><label class="field check"><input type="checkbox" name="schedule.verify" ${config.schedule?.verify !== false ? 'checked' : ''}><span>QA checks for issues awaiting verification</span></label><label class="field check"><input type="checkbox" name="schedule.fix" ${config.schedule?.fix ? 'checked' : ''}><span>Code fixes for open bugs (needs a source repository)</span></label><div class="actions">${button('Run now', 'schedule-run', 'small', 'type="button"')}<small class="muted" data-schedule-status>${esc(scheduleText())}</small></div><label class="field check"><input type="checkbox" id="autostart"><span>Start Rex Desk when I sign in to Windows, so the schedule runs without opening the app</span></label></div></section>
    <section class="settings-section" id="repositories"><h2>Source repositories</h2><p>Each worker uses a new worktree. Commands run there; your current checkout stays where it is.</p>${config.repositories.map((repository, index) => renderRepositorySettings(repository, index)).join('')}${button(`${icon('plus')} Add repository`, 'add-repository', '', 'type="button"')}${foundRepositories()}</section>
    <section class="settings-section" id="github"><h2>GitHub</h2><p>Draft PRs, pushes, and clones use the active account. Sign in as many accounts as you need; Rex Desk uses the GitHub CLI login and never stores a GitHub token.</p><div class="settings-card" data-github="full">${renderGithub()}</div></section>
    <section class="settings-section" id="agents"><h2>Agents & workflow</h2><p>Use your installed Claude Code and Codex sign-ins. You can override the provider for each run.</p><div class="settings-card"><div class="field-row">${inputField('Your name', 'name', config.name)}<label class="field"><span>Default agent</span>${providerSelect('provider', config.provider)}</label></div><p class="muted">Every run opens in its own Orca terminal, so you can watch it work and answer its tool approvals there. Questions, evidence, and PR approval stay in Rex Desk.</p><div class="field-row">${inputField('Parallel workers', 'concurrency', config.concurrency, 'Main agent runs separately. Start with 1 or 2 workers.', 'number')}${inputField('Sync interval (minutes)', 'syncMinutes', config.syncMinutes, 'Set 0 to sync manually.', 'number')}</div>${inputField('Branch prefix', 'branchPrefix', config.branchPrefix, 'For example: temp/rex. Git branch names cannot begin with /.')}<div class="field-row">${inputField('Claude model (optional)', 'model.claude', config.models?.claude || '', 'Blank uses Claude Code’s default. Use opus, sonnet, haiku, or a full ID such as claude-opus-5-5; “opus 5.5” is saved as claude-opus-5-5.', 'text', 'Claude Code default')}${inputField('Codex model (optional)', 'model.codex', config.models?.codex || '', 'Use a model available to your signed-in account.')}</div><label class="field check"><input type="checkbox" name="requireVideo" ${config.requireVideo ? 'checked' : ''}><span>Require a browser recording and passing browser assertion before review</span></label><label class="field check"><input type="checkbox" name="reportToOrbit" ${config.reportToOrbit ? 'checked' : ''}><span>Let verified agents send their final report through my installed Orbit MCP</span></label><label class="field check"><input type="checkbox" name="autoPrLowRisk" ${config.autoPrLowRisk ? 'checked' : ''}><span>Automatically push and create a draft PR for verified low-risk fixes (risk 1–2/10)</span></label><small class="muted">Automatic PRs require a small style, markup, documentation, or test-only change, passing tests, current evidence, and no human-review flag. Application code, sensitive changes, and higher scores require review. Tracker changes still require approval. Nothing is merged automatically.</small></div>${button('Check installed tools', 'diagnostics', '', 'type="button"')}<div id="diagnostics"></div></section>
    <section class="settings-section" id="agent-sign-in"><h2>Agent sign-in</h2><p>Rex Desk runs Claude Code and Codex with the profile folder you choose here. The choice is saved immediately and used for every new run.</p><div data-agent-profiles>${renderAgentProfiles()}</div></section>
    <section class="settings-section" id="cloud-backup"><h2>Cloud backup</h2><p>Work history, settings, and evidence records are written locally first, then copied to your Turso database. If Turso is offline, changes wait in a local outbox and upload automatically.</p><div data-database>${renderDatabase()}</div></section>
    <section class="settings-section" id="appearance"><h2>Appearance</h2><p>Choose a theme for this browser. Your choice takes effect immediately.</p><label class="field"><span>Color theme</span><select id="theme-preference">${[['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => `<option value="${value}" ${window.rexTheme.preference === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></section>
    <section class="settings-section" id="ai-connection"><h2>Connect an existing AI</h2><p>Rex-managed agents connect automatically. To let another Claude Code, Codex, or cloud AI read tasks and ask you questions, give it the setup prompt below. Local setup needs no key.</p>${renderMcpSetup()}<details class="manual-ids"><summary>Manual connection details</summary>${button(`${icon('link')} Show URL and access token`, 'mcp-setup', 'small', 'type="button"')}<div id="mcp-setup"></div></details></section>
    <div class="settings-save"><small id="settings-status">Changes are saved only when you choose Save settings.</small><button type="submit" class="button primary">Save settings</button></div></form></div>`;
}
function renderDatabase() {
  const database = ui.snapshot.database || {}, labels = { connected: 'Connected', syncing: 'Uploading', connecting: 'Connecting', offline: 'Offline', error: 'Needs attention', local: 'Local only' };
  const tone = { connected: 'finished', syncing: 'running', connecting: 'running', offline: 'waiting', error: 'failed', local: '' }[database.state] || '';
  return `<div class="settings-card"><div class="database-status"><span class="tag ${tone}">${esc(labels[database.state] || database.state || 'Local only')}</span><dl><div><dt>Pending uploads</dt><dd>${Number(database.pending || 0)}</dd></div><div><dt>Last upload</dt><dd>${database.lastSyncedAt ? `${esc(time(database.lastSyncedAt))} · ${esc(relative(database.lastSyncedAt))}` : 'Not yet'}</dd></div><div><dt>Workspace</dt><dd class="mono">${esc(String(database.workspace || '').slice(0, 8))}</dd></div></dl></div>
    ${database.error ? `<p class="error-text" role="alert">${esc(database.error)}</p>` : ''}
    <div class="field-row"><label class="field"><span>Database URL</span><input id="database-url" value="${esc(database.url || '')}" placeholder="libsql://your-database.turso.io" autocomplete="off" spellcheck="false"></label><label class="field"><span>${database.configured ? 'Database token · saved' : 'Database token'}</span><input id="database-token" type="password" autocomplete="new-password" placeholder="${database.configured ? 'Leave blank to keep the saved token' : 'Paste a Turso database token'}"></label></div>
    <div class="actions">${button(database.configured ? 'Save connection' : 'Connect Turso', 'database-connect', '', 'type="button"')}${database.configured ? button(`${icon('sync')} Upload now & verify`, 'database-sync', 'primary', 'type="button"') : ''}</div>
    <small class="muted">The token is encrypted on this computer and never shown again. A local SQLite backup is saved before any database change.</small></div>`;
}
function renderSourceSettings(source, index) {
  const prefix = `source.${source.id}`;
  return `<div class="settings-card"><div class="settings-card-header"><strong>Connection ${index + 1}</strong>${button(`${icon('close')} Remove`, 'remove-source', 'quiet small', `type="button" data-id="${source.id}"`)}</div><div class="field-row">${inputField('Connection name', `${prefix}.name`, source.name)}<label class="field"><span>Service</span><select name="${prefix}.type"><option value="morningmate" ${source.type === 'morningmate' ? 'selected' : ''}>Morningmate</option><option value="flow" ${source.type === 'flow' ? 'selected' : ''}>Flow</option></select></label></div>${inputField('API base URL', `${prefix}.baseUrl`, source.baseUrl, '', 'url')}${inputField(source.hasKey ? 'API key · saved' : 'API key', `${prefix}.apiKey`, source.apiKey || '', source.hasKey ? 'Leave blank to keep the saved key. Enter a new key to replace it.' : 'Use a user API key from your service’s developer portal.', 'password', source.hasKey ? 'Saved key is not sent back to the browser' : 'Paste your API key')}
    <label class="field check"><input type="checkbox" name="${prefix}.clearKey"><span>Delete the saved key</span></label><div class="actions connection-actions">${button(connectingSources.has(source.id) ? 'Loading projects & people…' : 'Connect & load projects / people', 'connect-source', '', `type="button" data-id="${source.id}" ${connectingSources.has(source.id) ? 'disabled' : ''}`)}</div><div data-source-catalog="${source.id}">${renderSourceCatalog(source)}</div><label class="field"><span>Task status to sync</span><select name="${prefix}.statusFilter">${[['active', 'Request + In progress'], ['unfinished', 'All unfinished (includes review and hold)'], ['all', 'All statuses']].map(([value, label]) => `<option value="${value}" ${(source.statusFilter || 'active') === value ? 'selected' : ''}>${label}</option>`).join('')}</select><small>Completed tasks, and statuses named like "Development Completed", are excluded by default.</small></label>${statusPicker(source, prefix)}<details class="manual-ids"><summary>Enter IDs manually</summary><div class="field-row">${inputField('Project IDs', `${prefix}.projectIds`, source.projectIds.join(', '), 'Normally filled by selecting projects above.')}${inputField('Your user ID (optional)', `${prefix}.userId`, source.userId, 'Normally filled by selecting an employee. Blank uses the API account.')}</div></details><label class="field"><span>Source repository</span><select name="${prefix}.repositoryId"><option value="">Choose a repository…</option>${ui.draft.repositories.map(repository => `<option value="${repository.id}" ${repository.id === source.repositoryId ? 'selected' : ''}>${esc(repository.name || repository.path || 'New repository · choose its folder in Source repositories')}</option>`).join('')}</select><small>New issues from this connection use this repository by default.</small></label><details><summary class="muted">Tracker status mapping</summary><p class="muted">Optional API status values. Unmapped phases leave tracker status unchanged.</p><div class="field-row three">${inputField('Working', `${prefix}.status.working`, source.statusMap?.working || '', '', 'text', 'progress')}${inputField('Review', `${prefix}.status.review`, source.statusMap?.review || '', '', 'text', 'feedback')}${inputField('Done', `${prefix}.status.done`, source.statusMap?.done || '', '', 'text', 'complete')}</div></details></div>`;
}
function sourceDirectory(sourceId) { return ui.snapshot.directories?.find(item => item.sourceId === sourceId); }
function renderSourceCatalog(source) {
  const directory = sourceDirectory(source.id);
  const agents = `<div class="agent-lookup"><span>Find choices through your installed service MCP:</span>${button('Find with Claude Code', 'source-agent', 'small quiet', `type="button" data-id="${source.id}" data-provider="claude"`)}${button('Find with Codex', 'source-agent', 'small quiet', `type="button" data-id="${source.id}" data-provider="codex"`)}</div>`;
  if (!directory) return `<p class="discovery-status muted">Connect to load project names and employee accounts. Choose them before syncing.</p>${agents}`;
  const selected = new Set(source.projectIds), employeeId = source.userId || '', employees = directory.employees;
  return `<div class="source-catalog"><p class="discovery-status muted">${directory.origin === 'mcp' ? 'Agent found these choices. Review them before saving.' : 'Connected. Select projects and the employee whose assigned tasks you want.'}</p>${Object.entries(directory.errors || {}).map(([kind, error]) => `<p class="error-text">${esc(kind)}: ${esc(error)}</p>`).join('')}<fieldset class="project-picker"><legend>Projects to sync</legend>${directory.projects.length > 1 ? `<div class="actions project-bulk">${button('Select all', 'select-projects', 'small quiet', `type="button" data-id="${source.id}" data-all="true"`)}${button('Clear', 'select-projects', 'small quiet', `type="button" data-id="${source.id}"`)}<small class="muted">Only issues assigned to you are imported from selected projects.</small></div>` : ''}${directory.projects.length ? `<input type="search" class="catalog-search" aria-label="Search projects for ${esc(source.name)}" placeholder="Search projects" data-catalog-search="${source.id}"><div class="project-options">${directory.projects.map(project => `<label class="project-choice"><input type="checkbox" data-source-project="${source.id}" value="${esc(project.id)}" ${selected.has(project.id) ? 'checked' : ''}><span>${esc(project.name)}<small>${esc(project.id)}</small></span></label>`).join('')}</div>` : '<p class="muted">No projects returned. Check access, reload, or use the MCP agent below.</p>'}</fieldset><div class="field"><span>Assigned employee</span>${picker({ value: employeeId, label: `Assigned employee for ${source.name}`, placeholder: 'Search name, email, or team', attrs: `data-source-employee="${source.id}"`, empty: 'No colleague matches. Reload the directory or use the API account.',
    options: [{ value: '', label: 'Use signed-in API account', detail: directory.accountId || '' }, ...employees.map(employee => ({ value: employee.id, label: `${employee.name}${employee.id === directory.accountId ? ' (me)' : ''}`, detail: [employee.email || employee.id, employee.department].filter(Boolean).join(' · ') })),
      ...(employeeId && !employees.some(employee => employee.id === employeeId) ? [{ value: employeeId, label: employeeId, detail: 'Saved account' }] : [])] })}<small>${employees.length} people loaded. Sync matches this task assignee, rather than the post author.</small></div>${agents}</div>`;
}
async function connectSource(sourceId, provider) {
  readSettings();
  const source = ui.draft.sources.find(item => item.id === sourceId);
  if (!source || connectingSources.has(sourceId)) return;
  const sentKey = source.apiKey || '';
  connectingSources.add(sourceId); updateSourceCard(sourceId);
  try {
    const result = await api(provider ? '/sources/setup-agent' : '/sources/connect', { method: 'POST', data: provider ? { source, provider } : source });
    readSettings();
    const current = ui.draft?.sources.find(item => item.id === sourceId), form = document.querySelector('#settings-form');
    const keyField = form?.elements[`source.${sourceId}.apiKey`];
    if (current) { current.hasKey = result.source.hasKey; current.clearKey = false; }
    // A key typed after the request started is newer than the saved one; keep it for the next save.
    if (current && keyField?.value === sentKey) { current.apiKey = ''; keyField.value = ''; }
    if (form?.elements[`source.${sourceId}.clearKey`]) form.elements[`source.${sourceId}.clearKey`].checked = false;
    ui.snapshot.config.sources = [...ui.snapshot.config.sources.filter(item => item.id !== sourceId), result.source];
    if (result.directory) ui.snapshot.directories = [...(ui.snapshot.directories || []).filter(item => item.sourceId !== sourceId), result.directory];
    toast(provider ? 'Connection agent queued. Check Agent runs for questions and results.' : 'Connection saved. Choose projects and an employee, then Save settings.');
    // First connection with a single project: select it. With several, the picker offers Select all instead of guessing.
    if (!provider && current && !current.projectIds.length && result.directory?.projects?.length === 1) {
      current.projectIds = result.directory.projects.map(project => project.id);
      const field = form?.elements[`source.${sourceId}.projectIds`]; if (field) field.value = current.projectIds.join(', ');
      toast('Connected. Your only project is selected; choose the assignee, then Save settings.');
    }
  } catch (error) { toast(error.message, true); }
  finally { connectingSources.delete(sourceId); if (ui.page === 'settings') { readSettings(); updateSourceCard(sourceId); } }
}
function updateSourceCard(sourceId) {
  const source = ui.draft?.sources.find(item => item.id === sourceId), catalog = document.querySelector(`[data-source-catalog="${sourceId}"]`);
  const control = document.querySelector(`[data-action="connect-source"][data-id="${sourceId}"]`);
  if (!source || !catalog) { render(); return; }
  if (!catalog.contains(document.activeElement)) catalog.innerHTML = renderSourceCatalog(source);
  if (control) { control.disabled = connectingSources.has(sourceId); control.textContent = connectingSources.has(sourceId) ? 'Loading projects & people…' : 'Connect & load projects / people'; }
  const label = document.querySelector(`[name="source.${sourceId}.apiKey"]`)?.closest('.field')?.querySelector('span');
  if (label) label.textContent = source.hasKey ? 'API key · saved' : 'API key';
}
function renderRisk(run) {
  if (!run?.risk) return '';
  const risk = run.risk;
  return `<section class="risk-assessment" aria-label="Code risk assessment"><div class="risk-heading"><h3>${risk.requiresHumanReview ? 'Review before creating a PR' : 'Low-risk draft PR eligible'}</h3><span class="tag ${risk.score <= 2 ? 'finished' : risk.score <= 5 ? 'waiting' : 'failed'}" title="Estimated code risk">Risk ${risk.score}/10 · ${esc(risk.level)}</span></div><p>${esc(risk.reason)}</p><small>${plural(risk.files.length, 'changed file')} · ${risk.changedLines} added/removed lines${risk.agentScore ? ` · Agent score ${risk.agentScore}/10` : ''}</small>${risk.safeguards.length || risk.factors.length ? `<details><summary>Review reasons</summary><ul>${[...risk.safeguards, ...risk.factors].map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></details>` : ''}<small>${risk.requiresHumanReview ? 'Review the diff before approving the draft PR.' : ui.snapshot.config.autoPrLowRisk ? 'Automatic draft PRs are enabled. Tests and evidence must match the current code.' : 'Automatic draft PRs are off. Create a draft PR after reviewing the evidence.'}</small></section>`;
}
function themeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return button(icon(dark ? 'sun' : 'moon'), 'toggle-theme', 'quiet icon-only', `type="button" aria-label="Switch to ${dark ? 'light' : 'dark'} mode" title="Switch to ${dark ? 'light' : 'dark'} mode"`);
}
function repositoryBranches(repository) {
  const info = repositoryInfo.get(repository.id);
  return `<div class="field-row">${[['baseBranch', 'Start from branch'], ['targetBranch', 'Default PR target']].map(([key, label]) => {
    const branches = info?.branches || [], value = repository[key] || '';
    if (!branches.length) return inputField(label, `repository.${repository.id}.${key}`, value, 'Inspect a repository to choose its branches.', 'text', 'Select after inspection');
    const options = branches.some(branch => branch.name === value) ? branches : [...branches, ...(value ? [{ name: value }] : [])];
    return `<div class="field"><span>${label}</span>${picker({ name: `repository.${repository.id}.${key}`, value, label: `${label} for ${repository.name || 'repository'}`, placeholder: `Search ${branches.length} branches`, empty: 'No branch matches. Fetch the remote, then inspect again.',
      options: options.map(branch => ({ value: branch.name, label: branch.name, detail: branch.local && branch.remote ? 'local and remote' : branch.local ? 'local' : branch.remote ? 'remote' : 'saved' })) })}<small>${key === 'baseBranch' ? 'Workers branch from this version of the project.' : 'You can change this before creating the PR.'}</small></div>`;
  }).join('')}</div>`;
}
function repositoryDiscovery(repository) {
  const info = repositoryInfo.get(repository.id);
  if (inspecting.has(repository.id)) return '<p class="discovery-status muted" role="status">Checking Git, GitHub account, and remote branches…</p>';
  if (info?.error) return `<p class="discovery-status error-text" role="alert">${esc(info.error)}</p>`;
  if (!info) return '<p class="discovery-status muted">Choose or paste a source folder. Git and GitHub details load automatically.</p>';
  return `<div class="repository-details"><dl><dt>GitHub account</dt><dd>${info.github.accounts.length ? info.github.accounts.map(account => `${esc(account.login)} on ${esc(account.host)}${account.state === 'success' ? ' · signed in' : ' · sign-in needs attention'}`).join('<br>') : 'Not signed in'}</dd><dt>Repository</dt><dd>${esc(info.github.repository?.name || info.name)}</dd><dt>Remote</dt><dd class="mono">${esc(info.remoteUrl || 'No remote configured')}</dd><dt>Git commit author</dt><dd>${esc([info.gitAuthor.name, info.gitAuthor.email].filter(Boolean).join(' · ') || 'Not configured')}</dd><dt>Current checkout</dt><dd class="mono">${esc(info.currentBranch || 'Detached HEAD')} · ${info.branches.length} branches</dd></dl>${info.warnings.map(warning => `<p class="muted">${esc(warning)}</p>`).join('')}${info.flow?.available ? button('Use Flow / Morningmate Tomcat setup', 'flow-preset', 'small', `type="button" data-id="${repository.id}"`) : ''}${info.electron && !repository.electronRuntime ? button(`Use isolated Electron app (${esc(info.electron.version)})`, 'electron-preset', 'small', `type="button" data-id="${repository.id}"`) : ''}</div>`;
}
// What runs use for this repository: Settings first, else what its own files say, else the worker proposes a test command for one approval.
function repositoryAutomatic(repository) {
  const found = ui.snapshot.detection?.[repository.id] || repositoryInfo.get(repository.id)?.suggested || {}, from = found.from || {};
  const preview = repository.devCommand ? ['Preview', repository.devCommand, 'Settings'] : repository.flowRuntime || found.flow ? ['Preview', 'Isolated Flow / Morningmate Tomcat', repository.flowRuntime ? 'Settings' : from.flowRuntime || 'detected']
    : repository.electronRuntime || found.electron ? ['Preview', 'Isolated Electron app', repository.electronRuntime ? 'Settings' : from.electronRuntime || 'detected'] : found.devCommand ? ['Preview', found.devCommand, from.devCommand] : ['Preview', 'None found', 'Browser proof needs a preview; set one below if the project has one'];
  const row = (key, label, none) => repository[key] ? [label, repository[key], 'Settings'] : found[key] ? [label, found[key], from[key]] : [label, none, ''];
  const rows = [row('setupCommand', 'Setup', 'None needed'), preview, row('testCommand', 'Tests', 'The worker proposes a command; you approve it once and it is saved')];
  return `<div class="repository-automatic" data-automatic="${repository.id}"><span>Runs use</span><dl>${rows.map(([label, value, source]) => `<dt>${label}</dt><dd><code>${esc(value)}</code>${source ? `<small>${esc(source === 'Settings' ? 'from Settings' : `from ${source}`)}</small>` : ''}</dd>`).join('')}</dl></div>`;
}
function commandField(repository, key, label, hint) {
  const found = ui.snapshot.detection?.[repository.id]?.[key] || repositoryInfo.get(repository.id)?.suggested?.[key] || '';
  return inputField(label, `repository.${repository.id}.${key}`, repository[key], hint, 'text', found ? `Automatic: ${found}` : 'Automatic');
}
function renderRepositorySettings(repository, index) {
  const prefix = `repository.${repository.id}`;
  return `<div class="settings-card" data-repository="${repository.id}"><div class="settings-card-header"><strong>Repository ${index + 1}</strong>${button(`${icon('close')} Remove`, 'remove-repository', 'quiet small', `type="button" data-id="${repository.id}"`)}</div><div class="field-row">${inputField('Repository name', `${prefix}.name`, repository.name)}${inputField('Local repository path', `${prefix}.path`, repository.path, '', 'text', 'F:\\your-project')}</div><div class="actions repository-actions">${button('Choose folder', 'browse-repository', '', `type="button" data-id="${repository.id}"`)}${button('Inspect repository', 'inspect-repository', '', `type="button" data-id="${repository.id}"`)}</div><div data-discovery="${repository.id}">${repositoryDiscovery(repository)}</div><div data-branches="${repository.id}">${repositoryBranches(repository)}</div>${inputField('AI branch pattern', `${prefix}.branchPattern`, repository.branchPattern || '', 'Blank uses {prefix}/{type}/{title}. The worker sets {title} to a short English summary and {type} to fix, feature, refactor, chore, or docs. Also available: {number} (tracker issue number), {source}, {taskId}, {runId}. A taken name gets -2.', 'text', '{prefix}/{type}/{title}')}<div class="branch-preview"><span>Example branch</span><code data-branch-preview="${repository.id}">${esc(repository.branchPattern ? 'Loading preview…' : `${ui.draft.branchPrefix}/fix/download-button-blank-preview`)}</code></div>${renderFlowSettings(repository)}${renderElectronSettings(repository)}${repositoryAutomatic(repository)}<details class="command-overrides"${repository.setupCommand || repository.devCommand || repository.testCommand ? ' open' : ''}><summary>Override commands</summary><p class="muted">Leave a field blank to keep the automatic value. A typed command is used instead.</p>${commandField(repository, 'setupCommand', 'Worktree setup command', 'Installs dependencies in each new worktree.')}${commandField(repository, 'devCommand', 'Preview command', 'Include {port}; PORT is also set. A preview command replaces the detected Tomcat or Electron preview.')}${commandField(repository, 'testCommand', 'Test command', 'Runs in the worktree before a fix counts as verified.')}${inputField('Initial browser path', `${prefix}.browserPath`, repository.browserPath || '/', 'Path opened on the isolated preview server.', 'text', '/')}</details></div>`;
}
const profileFields = [['default_region', 'Region'], ['product_name', 'Product name'], ['default_countryCode', 'Country'], ['default_langCode', 'Language']];
function runtimeProfiles(repository) {
  return repository.flowRuntime?.profiles?.length ? repository.flowRuntime.profiles : [
    { id: 'morningmate', name: 'Morningmate', product: 'morningmate', overrides: { default_region: 'ap-northeast-1', product_name: 'MORNINGMATE', default_countryCode: 'JP', default_langCode: 'en' }, seedPath: '' },
    { id: 'flow', name: 'Flow', product: 'flow', overrides: { default_region: 'ap-northeast-2', product_name: 'FLOW', default_countryCode: 'KR', default_langCode: 'ko' }, seedPath: '' }];
}
function renderRuntimeProfiles(repository) {
  const prefix = `repository.${repository.id}.flow`, profiles = runtimeProfiles(repository), seed = repositoryInfo.get(repository.id)?.flow?.seed || repository.flowRuntime.seed;
  return `<fieldset class="runtime-profiles"><legend>Product profiles</legend><p class="muted">Each run copies the seed configuration into its own worktree, then switches only these product codes there. Your checkout's configuration files are never changed.${seed ? ` The seed checkout currently starts <strong>${seed.product === 'flow' ? 'Flow' : 'Morningmate'}</strong> (${esc(seed.default_region)}).` : ''}</p>
    ${profiles.map((profile, index) => `<div class="runtime-profile"><div class="runtime-profile-heading"><strong>${esc(profile.name)}</strong><span class="tag">${profile.product === 'flow' ? 'Flow' : 'Morningmate'}</span></div><div class="field-row four">${profileFields.map(([key, label]) => inputField(label, `${prefix}.profile.${index}.${key}`, profile.overrides?.[key] || '')).join('')}</div>${inputField('Separate seed folder (optional)', `${prefix}.profile.${index}.seedPath`, profile.seedPath || '', 'Use when this product needs other database or API settings. Blank uses the seed folder above.', 'text', 'Same as the configuration seed')}</div>`).join('')}
    <label class="field"><span>Default profile for new runs</span><select name="${prefix}.defaultProfile">${profiles.map(profile => `<option value="${esc(profile.id)}" ${profile.id === repository.flowRuntime.defaultProfile ? 'selected' : ''}>${esc(profile.name)}</option>`).join('')}</select><small>You can pick another profile for each run. Two runs with different profiles use separate Tomcat bases and ports.</small></label></fieldset>`;
}
function renderElectronSettings(repository) {
  if (!repository.electronRuntime) return '';
  const prefix = `repository.${repository.id}.electron`, electron = repository.electronRuntime;
  return `<details class="flow-settings" open><summary>Isolated Electron app</summary><p class="muted">Recorded runs open this worktree's own Electron build. Each run gets separate user data, session, logs, and crash dumps. Auto-update, start-at-login, and URL protocol registration are disabled, so your installed app is untouched.</p><div class="field-row three">${inputField('App folder', `${prefix}.appDir`, electron.appDir, 'Relative to the repository.')}${inputField('Electron executable', `${prefix}.electronPath`, electron.electronPath, 'Installed by the worktree setup command.')}${inputField('Launch switches', `${prefix}.args`, electron.args, 'Plain switches only.')}</div>${button('Remove Electron preset', 'remove-electron-preset', 'small quiet', `type="button" data-id="${repository.id}"`)}</details>`;
}
function renderFlowSettings(repository) {
  if (!repository.flowRuntime) return '';
  const prefix = `repository.${repository.id}.flow`, flow = repository.flowRuntime;
  return `<details class="flow-settings" open><summary>Isolated Flow / Morningmate Tomcat</summary><p class="muted">Each run gets its own Tomcat base, logs, temp files, and HTTP port. Debug and AJP ports stay disabled. Database and external service settings come from your selected seed folder.</p>${inputField('Tomcat template folder', `${prefix}.templateBase`, flow.templateBase)}${inputField('Java 8 home', `${prefix}.javaHome`, flow.javaHome)}${inputField('Tomcat installation', `${prefix}.catalinaHome`, flow.catalinaHome)}${inputField('Local configuration seed folder', `${prefix}.seedPath`, flow.seedPath, 'A source checkout with the correct JEX config for this branch. Config and license files are copied, never linked.')}${inputField('Maximum Java heap (MB)', `${prefix}.maxHeapMb`, flow.maxHeapMb, 'Per running Tomcat. Start with one worker on this large project.', 'number')}${renderRuntimeProfiles(repository)}${button('Use custom dev command instead', 'remove-flow-preset', 'small quiet', `type="button" data-id="${repository.id}"`)}</details>`;
}
async function inspectRepositorySettings(repositoryId) {
  readSettings();
  const repository = ui.draft?.repositories.find(item => item.id === repositoryId);
  if (!repository?.path || inspecting.get(repositoryId) === repository.path) return;
  const selectedPath = repository.path;
  inspecting.set(repositoryId, selectedPath);
  const update = () => { const element = document.querySelector(`[data-discovery="${repositoryId}"]`); if (element) element.innerHTML = repositoryDiscovery(repository); };
  update();
  try {
    const info = await api('/repositories/inspect', { method: 'POST', data: { path: selectedPath } });
    readSettings();
    const current = ui.draft?.repositories.find(item => item.id === repositoryId);
    if (!current || current.path !== selectedPath || inspecting.get(repositoryId) !== selectedPath) return;
    repositoryInfo.set(repositoryId, info);
    const form = document.querySelector('#settings-form');
    for (const [key, value] of Object.entries({ path: info.path, name: current.name || info.name, baseBranch: current.baseBranch || info.preferredBranch, targetBranch: current.targetBranch || info.preferredBranch })) {
      current[key] = value;
      const input = form?.elements[`repository.${repositoryId}.${key}`]; if (input) input.value = value;
    }
    const automatic = document.querySelector(`[data-automatic="${repositoryId}"]`); if (automatic) automatic.outerHTML = repositoryAutomatic(current);
    const branches = document.querySelector(`[data-branches="${repositoryId}"]`); if (branches) branches.innerHTML = repositoryBranches(current);
  } catch (error) {
    const field = document.querySelector('#settings-form')?.elements[`repository.${repositoryId}.path`];
    if (field?.value === selectedPath && inspecting.get(repositoryId) === selectedPath) repositoryInfo.set(repositoryId, { error: error.message });
  } finally {
    if (inspecting.get(repositoryId) === selectedPath) { inspecting.delete(repositoryId); update(); }
  }
}
function previewBranch(repositoryId) {
  clearTimeout(previewTimers.get(repositoryId));
  previewTimers.set(repositoryId, setTimeout(async () => {
    const form = document.querySelector('#settings-form'), element = document.querySelector(`[data-branch-preview="${repositoryId}"]`);
    if (!form || !element) return;
    const pattern = form.elements[`repository.${repositoryId}.branchPattern`].value, prefix = form.elements.branchPrefix.value;
    try {
      const result = await api('/repositories/branch-preview', { method: 'POST', data: { pattern, prefix } });
      if (element.isConnected && form.elements[`repository.${repositoryId}.branchPattern`].value === pattern && form.elements.branchPrefix.value === prefix) { element.textContent = result.branch; element.classList.remove('error-text'); }
    } catch (error) { if (element.isConnected && form.elements[`repository.${repositoryId}.branchPattern`].value === pattern) { element.textContent = error.message; element.classList.add('error-text'); } }
  }, 180));
}
function readSettings() {
  const form = document.querySelector('#settings-form');
  if (!form) return ui.draft;
  const data = new FormData(form), draft = ui.draft;
  for (const field of ['name', 'provider', 'branchPrefix']) draft[field] = data.get(field);
  draft.concurrency = Number(data.get('concurrency')); draft.syncMinutes = Number(data.get('syncMinutes'));
  draft.autoPrLowRisk = data.has('autoPrLowRisk'); draft.requireVideo = data.has('requireVideo'); draft.reportToOrbit = data.has('reportToOrbit');
  draft.models = { claude: data.get('model.claude'), codex: data.get('model.codex') };
  draft.jev = { model: String(data.get('jev.model') || ''), auto: data.has('jev.auto'), apiKey: String(data.get('jev.apiKey') || ''), clearKey: data.has('jev.clearKey') };
  draft.testAccounts = draft.testAccounts.map((account, index) => ({ ...account, site: String(data.get(`testAccounts.${index}.site`) || '').trim(), username: String(data.get(`testAccounts.${index}.username`) || '').trim(), password: String(data.get(`testAccounts.${index}.password`) || '') }));
  draft.schedule = { enabled: data.has('schedule.enabled'), time: String(data.get('schedule.time') || '09:00'), days: data.getAll('schedule.days').map(Number), verify: data.has('schedule.verify'), fix: data.has('schedule.fix'), maxRuns: Number(data.get('schedule.maxRuns') || 6) };
  draft.agentProfiles = ui.snapshot.config.agentProfiles; draft.tourDismissed = ui.snapshot.config.tourDismissed;
  draft.sources = draft.sources.map(source => {
    const prefix = `source.${source.id}`, result = { ...source };
    for (const key of ['name', 'type', 'baseUrl', 'apiKey', 'userId', 'repositoryId', 'statusFilter']) result[key] = String(data.get(`${prefix}.${key}`) || '');
    result.statuses = String(data.get(`${prefix}.statuses`) || '').split('\n').filter(Boolean);
    result.projectIds = String(data.get(`${prefix}.projectIds`) || '').split(/[,\s]+/).filter(Boolean);
    result.clearKey = data.has(`${prefix}.clearKey`);
    result.statusMap = Object.fromEntries(['working', 'review', 'done'].map(phase => [phase, String(data.get(`${prefix}.status.${phase}`) || '')]));
    return result;
  });
  draft.repositories = draft.repositories.map(repository => {
    const result = { ...repository }, prefix = `repository.${repository.id}`;
    for (const key of ['name', 'path', 'baseBranch', 'targetBranch', 'branchPattern', 'setupCommand', 'devCommand', 'testCommand', 'browserPath']) result[key] = String(data.get(`${prefix}.${key}`) || '');
    if (repository.electronRuntime) result.electronRuntime = Object.fromEntries(['appDir', 'electronPath', 'args'].map(key => [key, String(data.get(`${prefix}.electron.${key}`) ?? repository.electronRuntime[key] ?? '')]));
    if (repository.flowRuntime) {
      result.flowRuntime = Object.fromEntries(['templateBase', 'javaHome', 'catalinaHome', 'seedPath'].map(key => [key, String(data.get(`${prefix}.flow.${key}`) || '')]));
      result.flowRuntime.maxHeapMb = Number(data.get(`${prefix}.flow.maxHeapMb`));
      result.flowRuntime.profiles = runtimeProfiles(repository).map((profile, index) => ({ ...profile, seedPath: String(data.get(`${prefix}.flow.profile.${index}.seedPath`) ?? profile.seedPath ?? ''),
        overrides: Object.fromEntries(profileFields.map(([key]) => [key, String(data.get(`${prefix}.flow.profile.${index}.${key}`) ?? profile.overrides?.[key] ?? '')])) }));
      result.flowRuntime.defaultProfile = String(data.get(`${prefix}.flow.defaultProfile`) || repository.flowRuntime.defaultProfile || '');
    }
    return result;
  });
  return draft;
}

// ---- Guided setup. Each step reads live settings, so the tour always shows the real remaining work.
async function loadAgents({ refresh = false } = {}) {
  ui.agentsLoading = true; ui.agentsError = ''; updateAgentViews();
  try { ui.agents = await api(`/agents${refresh ? '?refresh' : ''}`); }
  catch (error) { ui.agentsError = error.message; }
  finally { ui.agentsLoading = false; updateAgentViews(); }
}
function updateAgentViews() {
  for (const element of document.querySelectorAll('[data-agent-profiles]')) element.innerHTML = renderAgentProfiles();
  if (['setup', 'inbox'].includes(ui.page) && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) render();
  else document.querySelectorAll('[data-setup-progress]').forEach(element => { element.outerHTML = renderSetupProgress(setupSteps()); });
}
function selectedProfile(provider) {
  const agent = ui.agents?.[provider];
  return agent?.profiles.find(profile => samePath(profile.profile, agent.selected));
}
function setupSteps() {
  const config = ui.snapshot.config, sources = config.sources, keyed = sources.filter(source => source.hasKey), repositories = config.repositories;
  const claude = selectedProfile(config.provider), synced = ui.snapshot.sync;
  return [
    { id: 'agent', title: `Sign in ${providerName(config.provider)}`, done: Boolean(claude?.loggedIn), checking: !ui.agents,
      summary: claude?.loggedIn ? `Using ${claude.label}${claude.account ? ` · ${claude.account}` : ''}` : ui.agents ? `${claude?.label || 'The selected profile'} is not signed in` : 'Checking installed agent profiles…' },
    { id: 'connection', title: 'Connect Flow or Morningmate', done: keyed.length > 0,
      summary: keyed.length ? `${keyed.map(source => source.name).join(', ')} connected` : 'Save a user API key. It stays encrypted on this computer.' },
    { id: 'projects', title: 'Choose projects and assignee', done: keyed.length > 0 && keyed.every(source => source.projectIds.length),
      summary: keyed.length ? `${plural(keyed.reduce((sum, source) => sum + source.projectIds.length, 0), 'project')} selected · ${keyed.every(source => source.userId) ? 'assignee chosen' : 'API account is the assignee'}` : 'Available after connecting a tracker.' },
    { id: 'jev', title: 'Let Jev rank your issues', optional: true, done: Boolean(ui.snapshot.jev?.configured),
      summary: ui.snapshot.jev?.configured ? 'Jev rates new and changed issues after each sync.' : 'Add your OpenRouter key; Jev rates severity, next step, and effort so the list shows what to run first.' },
    { id: 'qa', title: 'Sign in to your test sites', optional: true, done: Boolean(ui.snapshot.qaSession?.savedAt),
      summary: ui.snapshot.qaSession?.savedAt ? 'Sign-in saved. QA checks find each issue’s test site themselves.' : 'For QA checks of fixes developers marked complete. The agent finds each test site.' },
    { id: 'repository', title: 'Add the source repository', optional: true, done: repositories.length > 0 && repositories.every(repository => repository.path && repository.baseBranch) && sources.every(source => source.repositoryId),
      summary: repositories.length ? repositories.map(repository => `${repository.name} · ${repository.baseBranch || 'no base branch'}`).join(', ') : 'Choose the local Git folder. Branches and GitHub account load automatically.' },
    { id: 'commands', title: 'Project commands (automatic)', optional: true, done: repositories.length > 0,
      summary: repositories.length ? 'Read from each project’s own files. The worker proposes a test command when none is found, and you approve it once.' : 'Available after adding a repository.' },
    { id: 'mcp', title: 'Connect your own AI tools', optional: true, done: Boolean(ui.agents?.claude?.mcp),
      summary: ui.agents ? ['claude', 'codex'].map(provider => `${providerName(provider)} ${ui.agents[provider]?.mcp ? 'connected' : 'not connected'}`).join(' · ') : 'Optional. Lets your everyday Claude Code or Codex read tasks and ask you questions.' },
    { id: 'verify', title: 'Sync and check', done: synced.length > 0 && !synced.some(item => item.error) && ui.snapshot.tasks.some(task => !task.demo),
      summary: synced.some(item => item.error) ? synced.filter(item => item.error).map(item => `${item.name}: ${item.error}`).join(' ') : synced.length ? `${ui.snapshot.tasks.filter(task => !task.demo).length} assigned issues synced ${relative(synced.map(item => item.at).sort().at(-1))}` : 'Import your assigned issues once to confirm the connection.' },
  ];
}
function renderSetupProgress(steps) {
  const required = steps.filter(step => !step.optional), done = required.filter(step => step.done).length;
  return `<div class="setup-progress" data-setup-progress><progress value="${done}" max="${required.length}" aria-label="Setup progress"></progress><small>${done} of ${required.length} ready</small></div>`;
}
function renderSetupBanner() {
  const steps = setupSteps(), next = steps.find(step => !step.done && !step.optional && !step.checking);
  if (!next || ui.snapshot.config.tourDismissed && next.id !== 'agent') return '';
  return `<div class="setup-banner">${icon('compass')}<div><strong>${esc(next.title)}</strong><span>${esc(next.summary)}</span></div>${renderSetupProgress(steps)}${button('Continue setup', 'setup', 'small primary')}</div>`;
}
function renderSetup(steps) {
  const open = ui.setupOpen || steps.find(step => !step.done && !step.optional)?.id || 'verify';
  return `<div class="setup-page">${heading('Set up Rex Desk', 'Each step checks your real settings. Finish the required ones once; change anything later in Settings.', `${renderSetupProgress(steps)}${button(`${icon('sync')} Recheck`, 'recheck-setup', 'small', ui.agentsLoading ? 'disabled' : '')}`)}
    <ol class="setup-steps">${steps.map((step, index) => `<li class="setup-step ${step.done ? 'done' : ''} ${open === step.id ? 'open' : ''}" data-step="${step.id}"><button type="button" class="setup-step-header" data-action="open-step" data-step="${step.id}" aria-expanded="${open === step.id}"><span class="step-mark" aria-hidden="true">${step.done ? icon('check') : `<span>${index + 1}</span>`}</span><span class="step-text"><strong>${esc(step.title)}${step.optional ? ' <em>Optional</em>' : ''}</strong><small>${esc(step.summary)}</small></span>${icon('chevron')}</button>${open === step.id ? `<div class="setup-step-body">${renderSetupBody(step)}</div>` : ''}</li>`).join('')}</ol>
    <div class="setup-footer"><span class="muted">${ui.snapshot.config.tourDismissed ? 'The issue list hides setup reminders, except agent sign-in problems.' : 'The issue list shows the next step until required setup is complete.'}</span>${button(ui.snapshot.config.tourDismissed ? 'Show reminders' : 'Hide reminders', 'toggle-tour', 'small quiet')}</div></div>`;
}
function settingsLink(anchor, label) { return button(label, 'settings-anchor', 'small', `type="button" data-anchor="${anchor}"`); }
function renderSetupBody(step) {
  const config = ui.snapshot.config;
  if (step.id === 'agent') return `<p>Agents run with the CLI profile folder selected here. Pick a profile that shows <strong>Signed in</strong>. The choice is saved immediately; no test turn is started.</p><div data-agent-profiles>${renderAgentProfiles()}</div>`;
  if (step.id === 'connection') return `<p>Add your Flow or Morningmate user API key. Rex Desk loads your projects and colleagues from it, so you never type IDs.</p>${config.sources.length ? `<ul class="setup-facts">${config.sources.map(source => `<li>${sourceLogo(source.type)}<strong>${esc(source.name)}</strong><span>${source.hasKey ? 'API key saved' : 'API key missing'}</span></li>`).join('')}</ul>` : ''}<div class="actions">${settingsLink('connections', config.sources.length ? 'Open connections' : 'Add a connection')}</div>`;
  if (step.id === 'projects') return `<p>Choose the projects to watch and whose assigned tasks to import. Only Request and In progress tasks sync by default.</p>${config.sources.length ? `<ul class="setup-facts">${config.sources.map(source => `<li>${sourceLogo(source.type)}<strong>${esc(source.name)}</strong><span>${source.projectIds.length} project${source.projectIds.length === 1 ? '' : 's'} · ${source.userId ? esc(source.userId) : 'API account'} · ${({ active: 'Request + In progress', unfinished: 'All unfinished', all: 'All statuses' })[source.statusFilter || 'active']}</span></li>`).join('')}</ul>` : ''}<div class="actions">${settingsLink('connections', 'Choose projects')}</div>`;
  if (step.id === 'repository') return `<p>Point Rex Desk at the local checkout. Each worker branches from it into its own worktree; your checkout is never switched.</p>${config.repositories.length ? `<ul class="setup-facts">${config.repositories.map(repository => `<li>${icon('branch')}<strong>${esc(repository.name)}</strong><span class="mono">${esc(repository.path)} · from ${esc(repository.baseBranch || '—')} · PR to ${esc(repository.targetBranch || '—')}</span></li>`).join('')}${config.sources.filter(source => !source.repositoryId).map(source => `<li>${icon('alert')}<strong>${esc(source.name)}</strong><span>Choose which repository its issues use.</span></li>`).join('')}</ul>` : ''}<div class="actions">${settingsLink('repositories', config.repositories.length ? 'Open repositories' : 'Add a repository')}</div>`;
  if (step.id === 'commands') return `<p>Rex Desk reads how to install, preview, and test each project from its own files, such as package.json or the Flow WAR layout. When no test command is found, the worker proposes one and you approve it once; it is saved for later runs.</p>${config.repositories.map(repositoryAutomatic).join('')}<div class="actions">${settingsLink('repositories', 'Override commands')}</div>`;
  if (step.id === 'jev') return `<p>Jev, TypeSafe AI's decision model, answers typed questions about each issue through your OpenRouter key. Rex Desk turns the answers into a ranked list with a Next up card; you start the runs.</p><div class="actions">${settingsLink('jev', ui.snapshot.jev?.configured ? 'Jev settings' : 'Add OpenRouter key')}</div>`;
  if (step.id === 'qa') return `<p>QA checks re-test fixes developers marked complete. The agent finds where the project runs for each issue, such as its dev or QA server, and tests it in a recorded browser. Sign in once to the sites you use so it can open signed-in pages. No source code is needed.</p><div class="actions">${button(`${icon('link')} Open sign-in browser`, 'qa-sign-in', 'small', 'type="button"')}<small class="muted" data-qa-session>${qaSessionText()}</small></div>`;
  if (step.id === 'mcp') return `<p>Rex-managed agents connect automatically. This step adds the local Rex Desk tools to the Claude Code and Codex you use every day.</p>${renderMcpSetup()}`;
  if (step.id === 'verify') return `<p>Sync imports your assigned issues. Tool checks confirm Git, GitHub CLI, Claude Code, and Codex are installed.</p><div class="actions">${button(`${icon('sync')} Sync now`, 'sync', 'small primary', ui.busy ? 'disabled' : '')}${button('Check installed tools', 'diagnostics', 'small', 'type="button"')}${ui.snapshot.tasks.some(task => !task.demo) ? button('Open my issues', 'inbox', 'small') : ''}</div><div id="diagnostics"></div>`;
  return '';
}
function renderAgentProfiles() {
  if (!ui.agents) return ui.agentsError ? `<p class="error-text">${esc(ui.agentsError)}</p>${button('Try again', 'recheck-setup', 'small', 'type="button"')}` : '<div class="detail-state" role="status"><span class="spinner" aria-hidden="true"></span>Checking Claude Code and Codex sign-in for each profile…</div>';
  const preferred = ui.snapshot.config.provider;
  return ['claude', 'codex'].sort(provider => provider === preferred ? -1 : 1).map(provider => {
    const agent = ui.agents[provider], current = selectedProfile(provider), signed = agent.profiles.filter(profile => profile.loggedIn);
    const suggestion = !current?.loggedIn && signed[0];
    const command = provider === 'claude' ? `${current?.profile ? `$env:CLAUDE_CONFIG_DIR='${current.profile}'; ` : 'Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; '}claude /login` : `${current?.profile ? `$env:CODEX_HOME='${current.profile}'; ` : ''}codex login`;
    return `<div class="agent-profile"><div class="agent-profile-heading"><strong>${providerName(provider)}</strong>${provider === preferred ? '<span class="tag">Default agent</span>' : ''}${current ? `<span class="tag ${current.loggedIn ? 'finished' : 'failed'}">${current.loggedIn ? 'Signed in' : current.installed ? 'Not signed in' : 'Not installed'}</span>` : ''}</div>
      <label class="field"><span>Profile folder</span><select data-agent-profile="${provider}" aria-label="${providerName(provider)} profile">${agent.profiles.map(profile => `<option value="${esc(profile.profile)}" ${samePath(profile.profile, agent.selected) ? 'selected' : ''}>${esc(profile.label)} · ${profile.loggedIn ? `signed in${profile.account ? ` as ${profile.account}` : ''}` : profile.installed ? 'not signed in' : 'CLI missing'}${profile.origin === 'launch' ? ' · launch terminal' : ''}</option>`).join('')}</select><small>${current ? `${esc(current.profile || (provider === 'claude' ? '~/.claude' : '~/.codex'))}${current.loggedIn ? ` · ${esc([current.method, current.plan, current.organization].filter(Boolean).join(' · '))}` : ''}` : ''}${agent.saved === null ? ' · inherited from the terminal that started Rex Desk' : ''}</small></label>
      ${suggestion ? `<div class="setup-callout">${icon('alert')}<span>${esc(current?.label || 'This profile')} is not signed in. <strong>${esc(suggestion.label)}</strong> is signed in${suggestion.account ? ` as ${esc(suggestion.account)}` : ''}.</span>${button('Use signed-in profile', 'use-agent-profile', 'small primary', `type="button" data-provider="${provider}" data-profile="${esc(suggestion.profile)}"`)}</div>` : ''}
      ${current && !current.loggedIn && !signed.length && current.installed ? `<div class="setup-callout">${icon('terminal')}<span>No ${providerName(provider)} profile is signed in. Sign in once in a terminal, then choose Recheck.</span><code>${esc(command)}</code>${button(`${icon('copy')} Copy`, 'copy-text', 'small', `type="button" data-text="${esc(command)}"`)}</div>` : ''}
      ${current?.error && current.installed && current.loggedIn === false && signed.length ? '' : current?.error ? `<p class="muted">${esc(current.error)}</p>` : ''}</div>`;
  }).join('') + `<div class="actions">${button(`${icon('sync')} Recheck sign-in`, 'recheck-setup', 'small quiet', `type="button" ${ui.agentsLoading ? 'disabled' : ''}`)}</div>`;
}
function renderMcpSetup() {
  const agents = ui.agents;
  return `<div class="mcp-setup"><div class="mcp-install">${['claude', 'codex'].map(provider => `<div><strong>${providerName(provider)}</strong><span>${agents ? agents[provider]?.mcp ? `${icon('check')} rex_desk installed in ${esc(selectedProfile(provider)?.label || 'selected profile')}` : `Not installed in ${esc(selectedProfile(provider)?.label || 'the selected profile')}` : 'Checking…'}</span>${agents && !agents[provider]?.mcp ? button('Install local MCP', 'install-mcp', 'small', `type="button" data-provider="${provider}"`) : ''}</div>`).join('')}</div>
    <div class="prompt-choice"><span>Or give your AI a setup prompt:</span>${button(`${icon('copy')} Copy local setup prompt`, 'copy-setup-prompt', 'small', 'type="button" data-target="local"')}${button(`${icon('copy')} Copy cloud setup prompt`, 'copy-setup-prompt', 'small quiet', 'type="button" data-target="remote"')}</div>
    <small class="muted">The local prompt contains no key. The cloud prompt uses a <code>REX_DESK_TOKEN</code> placeholder; give your AI the token separately only when you choose to.</small>${ui.setupPrompt ? `<pre class="setup-prompt" tabindex="0">${esc(ui.setupPrompt)}</pre>` : ''}</div>`;
}
async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast('Clipboard is unavailable. Select the text and copy it manually.', true); }
}
function renderTaskResults() {
  const tasks = filteredTasks(), list = document.querySelector('#task-list'), board = document.querySelector('#task-board'), count = document.querySelector('#task-count');
  if (list) { const ordered = orderedTasks(); list.innerHTML = ordered.length ? ordered.map(renderTaskRow).join('') : emptyTasks(); }
  if (board) board.innerHTML = renderBoard(tasks);
  if (count) count.textContent = tasks.length;
  return Boolean(list || board);
}

// ---- Searchable picker: a combobox with a filtered listbox. The hidden input carries the form value and fires change.
let pickerSequence = 0;
function picker({ name = '', value = '', options = [], placeholder = 'Search…', label = '', attrs = '', empty = 'No matches' }) {
  const id = `picker-${++pickerSequence}`, current = options.find(option => option.value === value);
  return `<div class="picker" data-picker><input type="hidden" ${name ? `name="${esc(name)}"` : ''} value="${esc(value)}" ${attrs}><input type="text" class="picker-input" role="combobox" aria-expanded="false" aria-controls="${id}" aria-autocomplete="list" autocomplete="off" spellcheck="false" ${label ? `aria-label="${esc(label)}"` : ''} placeholder="${esc(placeholder)}" value="${esc(current?.label ?? value)}" data-label="${esc(current?.label ?? value)}">${icon('chevron')}<ul class="picker-list" id="${id}" role="listbox" hidden>${options.map((option, index) => `<li role="option" id="${id}-${index}" data-value="${esc(option.value)}" data-label="${esc(option.label)}" aria-selected="${option.value === value}"><span>${esc(option.label)}</span>${option.detail ? `<small>${esc(option.detail)}</small>` : ''}</li>`).join('')}<li class="picker-empty" hidden>${esc(empty)}</li></ul></div>`;
}
const pickerParts = element => { const root = element.closest('[data-picker]'); return root && { root, hidden: root.querySelector('input[type=hidden]'), input: root.querySelector('.picker-input'), list: root.querySelector('.picker-list') }; };
const visibleOptions = list => [...list.querySelectorAll('[role=option]')].filter(option => !option.hidden);
function setActive(parts, option) {
  for (const item of parts.list.querySelectorAll('.active')) item.classList.remove('active');
  if (!option) { parts.input.removeAttribute('aria-activedescendant'); return; }
  option.classList.add('active'); parts.input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' });
}
function filterPicker(parts, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const option of parts.list.querySelectorAll('[role=option]')) option.hidden = !terms.every(term => option.textContent.toLowerCase().includes(term));
  const shown = visibleOptions(parts.list);
  parts.list.querySelector('.picker-empty').hidden = shown.length > 0;
  setActive(parts, shown.find(option => option.dataset.value === parts.hidden.value) || shown[0]);
}
function openPicker(parts) {
  if (!parts.list.hidden) return;
  parts.list.hidden = false; parts.input.setAttribute('aria-expanded', 'true'); parts.root.classList.add('open');
  filterPicker(parts, ''); parts.input.select();
}
function closePicker(parts, { restore = true } = {}) {
  parts.list.hidden = true; parts.input.setAttribute('aria-expanded', 'false'); parts.root.classList.remove('open'); setActive(parts, null);
  if (restore) parts.input.value = parts.input.dataset.label;
}
function choosePicker(parts, option) {
  parts.input.dataset.label = option.dataset.label; parts.input.value = option.dataset.label;
  for (const item of parts.list.querySelectorAll('[aria-selected=true]')) item.setAttribute('aria-selected', 'false');
  option.setAttribute('aria-selected', 'true');
  const changed = parts.hidden.value !== option.dataset.value;
  parts.hidden.value = option.dataset.value; closePicker(parts, { restore: false });
  if (changed) parts.hidden.dispatchEvent(new Event('change', { bubbles: true }));
}
document.addEventListener('focusin', event => { if (event.target.classList?.contains('picker-input')) openPicker(pickerParts(event.target)); });
document.addEventListener('focusout', event => {
  if (!event.target.classList?.contains('picker-input')) return;
  const parts = pickerParts(event.target);
  if (!parts.root.contains(event.relatedTarget)) closePicker(parts);
});
document.addEventListener('mousedown', event => {
  const option = event.target.closest('.picker-list [role=option]');
  if (option) { event.preventDefault(); choosePicker(pickerParts(option), option); return; }
  const input = event.target.closest('.picker-input');
  if (input && document.activeElement === input) { const parts = pickerParts(input); if (parts.list.hidden) openPicker(parts); }
});
document.addEventListener('keydown', event => {
  if (!event.target.classList?.contains('picker-input')) return;
  const parts = pickerParts(event.target), shown = visibleOptions(parts.list), active = parts.list.querySelector('.active');
  const position = shown.indexOf(active);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
    event.preventDefault(); openPicker(parts);
    const next = { ArrowDown: position + 1, ArrowUp: position - 1, Home: 0, End: shown.length - 1, PageDown: position + 8, PageUp: position - 8 }[event.key];
    setActive(parts, shown[Math.max(0, Math.min(shown.length - 1, next))]); return;
  }
  if (event.key === 'Enter') { event.preventDefault(); if (active && !parts.list.hidden) choosePicker(parts, active); else openPicker(parts); return; }
  if (event.key === 'Escape' && !parts.list.hidden) { event.preventDefault(); event.stopPropagation(); closePicker(parts); parts.input.select(); }
});
document.addEventListener('input', event => {
  if (!event.target.classList?.contains('picker-input')) return;
  const parts = pickerParts(event.target);
  if (parts.list.hidden) { parts.list.hidden = false; parts.input.setAttribute('aria-expanded', 'true'); parts.root.classList.add('open'); }
  filterPicker(parts, event.target.value);
}, true);

async function loadMessages() {
  if (ui.page === 'inbox') await loadTaskDetail();
  const issueRun = ui.page === 'inbox' && shownTabs().includes('messages') && selectedTask() ? taskRun(selectedTask()) : null;
  const runs = ui.page === 'runs' ? visibleRuns() : issueRun ? [issueRun] : [];
  // Every visible pane refreshes together; raw command and preview output stays in the work journal.
  await Promise.all(runs.map(async run => {
    const events = await api(`/runs/${run.id}/journal`);
    ui.runEvents.set(run.id, events.filter(event => !['command-output', 'dev-output'].includes(event.kind)));
    const target = document.getElementById(`messages-${run.id}`);
    if (target && !target.contains(document.activeElement)) { target.innerHTML = renderMessages(run.id); restoreTranscript(); }
  }));
}
// No repository yet: one box takes a local folder path or a GitHub owner/name (cloned with the signed-in gh account).
function repositorySetup(message) {
  return `<div class="setup-callout repo-setup">${icon('branch')}<span>${message}</span><div class="field-inline"><input name="repositorySource" aria-label="Repository folder or GitHub owner/name" placeholder="Folder path, or owner/name on GitHub" autocomplete="off" spellcheck="false">${button('Add', 'add-repo-inline', 'small primary', 'type="button"')}${button('Browse…', 'browse-repo-inline', 'small', 'type="button"')}</div><div class="repo-github" data-github="compact">${renderGithub(true)}</div></div>`;
}
// GitHub accounts come from the GitHub CLI. Signing in runs GitHub's device flow: approve the shown code on github.com.
function renderGithub(compact = false) {
  const github = ui.github;
  if (!github) return '<p class="muted">Checking GitHub sign-in…</p>';
  if (!github.installed) return '<p class="error-text">GitHub CLI (gh) is not installed on this computer.</p>';
  const login = github.login, waiting = ['waiting', 'starting'].includes(login?.state), active = github.accounts.find(account => account.active);
  const accounts = github.accounts.map(account => `<li><span class="state-dot ${!account.valid ? 'failed' : account.active ? 'finished' : 'none'}"></span><strong>${esc(account.login)}</strong>${account.active ? '<span class="tag finished">Active</span>' : account.valid ? button('Use', 'github-switch', 'small quiet', `type="button" data-user="${esc(account.login)}"`) : '<span class="tag failed">Sign in again</span>'}</li>`).join('');
  const signIn = waiting
    ? `<div class="github-code"><span>Enter this code on GitHub</span><code>${esc(login.code || '…')}</code>${button(`${icon('copy')} Copy`, 'copy-text', 'small', `type="button" data-text="${esc(login.code || '')}"`)}<a class="button small" href="${esc(login.url)}" target="_blank" rel="noopener">Open GitHub</a>${button('Cancel', 'github-cancel', 'small quiet', 'type="button"')}<small>Your browser opened github.com/login/device. Approve the code there; this updates when you are signed in.</small></div>`
    : `<div class="actions">${button(`${icon('link')} ${github.accounts.length ? 'Sign in another GitHub account' : 'Sign in to GitHub'}`, 'github-login', compact ? 'small' : 'small primary', 'type="button"')}${compact ? `<small class="muted">${active ? `Cloning as ${esc(active.login)}` : 'Not signed in to GitHub'}</small>` : ''}</div>`;
  return `${compact ? '' : `<ul class="github-accounts">${accounts || '<li class="muted">No GitHub account signed in.</li>'}</ul>`}${signIn}${login?.state === 'failed' ? `<p class="error-text">${esc(login.error)}</p>` : ''}`;
}
async function loadGithub() {
  const previous = ui.github?.login?.state;
  try { ui.github = await api('/github'); } catch (error) { ui.github = { installed: true, accounts: [], login: { state: 'failed', error: error.message } }; }
  for (const element of document.querySelectorAll('[data-github]')) element.innerHTML = renderGithub(element.dataset.github === 'compact');
  const state = ui.github.login?.state;
  if (['waiting', 'starting'].includes(state)) { clearTimeout(ui.githubTimer); ui.githubTimer = setTimeout(loadGithub, 2000); }
  else if (state === 'done' && previous && previous !== 'done') toast(`Signed in to GitHub${ui.github.login.account ? ` as ${ui.github.login.account}` : ''}. It is now the active account.`);
}
function runtimeProfileField(repository) {
  if (!repository?.flowRuntime) return '';
  return `<label class="field"><span>Runtime profile</span><select name="runtimeProfile">${runtimeProfiles(repository).map(profile => `<option value="${esc(profile.id)}" ${profile.id === repository.flowRuntime.defaultProfile ? 'selected' : ''}>${esc(profile.name)} · ${esc(profile.overrides?.default_region || '')}</option>`).join('')}</select><small>Starts this branch as Flow or Morningmate in its own Tomcat. Change product profiles in Settings.</small></label>`;
}
async function launchDialog({ role = 'worker', resume = false, repositoryId: chosen, mode = 'fix' } = {}) {
  const task = selectedTask(), run = selectedRun();
  const repositoryId = chosen || task?.repositoryId || ui.snapshot.config.repositories[0]?.id;
  const repository = ui.snapshot.config.repositories.find(item => item.id === (resume ? run.repositoryId : repositoryId));
  const dialog = document.querySelector('#launch-dialog');
  if (mode === 'verify') {
    const session = ui.snapshot.qaSession;
    dialog.innerHTML = `<div class="dialog-heading"><h2 id="launch-title">Verify the fix</h2>${button(icon('close'), 'close-dialog', 'quiet icon-only', 'aria-label="Close dialog"')}</div><p>${esc(task?.title)}</p><form id="launch-form" data-role="worker" data-mode="verify"><p class="qa-note">The agent finds where this project runs for the issue, such as its dev or QA server, re-tests it in a recorded browser${session?.savedAt ? ' with your saved sign-in' : ''}, and reports pass, fail, or blocked. It never changes code.${session?.savedAt ? '' : ' No sign-in is saved yet; if the site needs one, the result offers a sign-in button.'}</p><label class="field"><span>Agent</span>${providerSelect('provider', ui.snapshot.config.provider)}</label><label class="field"><span>What to check (optional)</span><textarea name="prompt" placeholder="For example: check the Indonesian label on the org chart page of the Morningmate dev server."></textarea></label><div class="form-error" id="launch-error" role="alert"></div><div class="actions">${button('Cancel', 'close-dialog', '', 'type="button"')}<button class="button primary" type="submit">Start QA check</button></div></form>`;
    if (!dialog.open) dialog.showModal();
    return;
  }
  const title = resume ? 'Continue this run' : 'Start an issue agent';
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="launch-title">${title}</h2>${button(icon('close'), 'close-dialog', 'quiet icon-only', 'aria-label="Close dialog"')}</div><p>${resume ? 'Continue with the same provider, or switch providers and pass the recorded issue context into a new session.' : esc(task?.title)}</p><form id="launch-form" data-role="${role}" data-resume="${resume}"><label class="field"><span>Agent</span>${providerSelect('provider', resume ? run.provider : ui.snapshot.config.provider)}</label>${role === 'worker' ? '<div id="orca-readiness"></div>' : ''}${role === 'worker' && !resume ? (ui.snapshot.config.repositories.length ? `<div class="field"><span>Source repository</span><div class="field-inline"><select name="repositoryId" required aria-label="Source repository"><option value="">Choose a repository…</option>${ui.snapshot.config.repositories.map(item => `<option value="${item.id}" ${item.id === repositoryId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>${button('Add folder…', 'browse-repo-inline', 'small', 'type="button" title="Choose another local Git checkout"')}</div></div>` : `${repositorySetup('No source repository yet. The agent needs the code to work on; branches load automatically.')}<input type="hidden" name="repositoryId" value="">`) : ''}<div id="runtime-profile-field">${role === 'worker' && !resume ? runtimeProfileField(repository) : ''}</div><details class="dialog-more" open><summary>Branches · ${repository?.baseBranch && role !== 'coordinator' ? `starts from ${esc(repository.baseBranch)}` : 'repository default'}; pick the PR target when you publish</summary><div class="field-row">${inputField('Start from branch', 'baseBranch', resume ? run.baseBranch : role === 'coordinator' ? '' : repository?.baseBranch || '', role === 'coordinator' ? 'Blank uses each repository’s default.' : '', 'text', 'Repository default')}${inputField('PR target branch', 'targetBranch', resume ? run.targetBranch : role === 'coordinator' ? '' : repository?.targetBranch || '', 'You can change this before publishing.', 'text', 'Repository default')}</div></details><label class="field"><span>${resume ? 'Follow-up instruction' : 'Additional instruction (optional)'}</span><textarea name="prompt" placeholder="For example: investigate critical issues first, and keep related fixes sequential."></textarea></label><div class="form-error" id="launch-error" role="alert"></div><div class="actions">${button('Cancel', 'close-dialog', '', 'type="button"')}<button class="button primary" type="submit">${resume ? 'Continue run' : 'Start agent'}</button></div></form>`;
  if (resume) { dialog.querySelector('input[name=baseBranch]').readOnly = true; dialog.querySelector('input[name=baseBranch]').title = 'This worktree keeps its original base branch.'; }
  if (!dialog.open) dialog.showModal();
  if (dialog.querySelector('[data-github]')) void loadGithub();
  void updateOrcaReadiness(dialog.querySelector('#launch-form'));
  if (repository) await loadBranches(repository.id);
}
async function loadBranches(repositoryId) {
  await action(async () => {
    const { branches } = await api(`/repositories/${repositoryId}/branches`), form = document.querySelector('#launch-form');
    if (!form) return;
    const names = [...new Set(branches.map(branch => branch.replace(/^origin\//, '')).filter(name => name && name !== 'HEAD'))].sort();
    for (const key of ['baseBranch', 'targetBranch']) {
      const input = form.elements[key];
      if (!input || input.readOnly) continue;
      const field = input.closest('.field'), value = input.value, label = field.querySelector('span')?.textContent || key, hint = field.querySelector('small')?.outerHTML || '';
      const coordinator = form.dataset.role === 'coordinator';
      const options = [...(coordinator ? [{ value: '', label: 'Repository default', detail: 'Each repository uses its saved branch' }] : []), ...names.map(name => ({ value: name, label: name })),
        ...(value && !names.includes(value) ? [{ value, label: value, detail: 'Saved branch' }] : [])];
      const replacement = document.createElement('div');
      replacement.className = 'field';
      replacement.innerHTML = `<span>${esc(label)}</span>${picker({ name: key, value, label, placeholder: `Search ${names.length} branches`, options, empty: 'No branch matches.' })}${hint}`;
      field.replaceWith(replacement);
    }
  });
}
function publishDialog() {
  const run = selectedRun(), dialog = document.querySelector('#publish-dialog');
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="publish-title">Create a draft pull request</h2>${button(icon('close'), 'close-dialog', 'quiet icon-only', 'aria-label="Close dialog"')}</div><p>This pushes <code>${esc(run.branch)}</code> to origin and opens a draft GitHub PR. Review the evidence first.</p><form id="publish-form">${inputField('PR title', 'title', run.title)}${inputField('Target branch', 'targetBranch', run.targetBranch)}<label class="field"><span>PR description</span><textarea name="body" rows="7">${esc(run.summary || '')}</textarea></label><div class="form-error" id="publish-error" role="alert"></div><div class="actions">${button('Cancel', 'close-dialog', '', 'type="button"')}<button class="button primary" type="submit">Push & create draft PR</button></div></form>`;
  dialog.showModal();
}

document.addEventListener('click', event => {
  const target = event.target.closest('button,[data-task],[data-run]'); if (!target) return;
  if (target.dataset.page) { navigate(target.dataset.page); return; }
  if (target.dataset.task) {
    ui.selectedTask = target.dataset.task; resetDetailTab();
    if (target.dataset.fromBoard) { ui.page = 'inbox'; ui.view = 'list'; }
    render(); if (innerWidth <= 700) document.querySelector('.detail-pane')?.scrollIntoView({ block: 'start' }); void loadMessages(); return;
  }
  if (target.dataset.run) { navigate('runs', { runId: target.dataset.run }); return; }
  const name = target.dataset.action; if (!name) return;
  // Run actions in a pane apply to that pane's run.
  const paneRun = target.closest('[data-pane-run]')?.dataset.paneRun; if (paneRun && name !== 'close-run') ui.selectedRun = paneRun;
  if (name === 'retry-task-detail') { taskErrors.delete(ui.selectedTask); render(); void loadTaskDetail(); return; }
  if (name === 'refresh-task-detail') {
    const taskId = ui.selectedTask; loadingTasks.add(taskId); target.disabled = true;
    void action(async () => {
      try { const detail = await api(`/tasks/${encodeURIComponent(taskId)}?refresh`); ui.snapshot.tasks = ui.snapshot.tasks.map(item => item.id === taskId ? detail : item); toast('Issue reloaded from the tracker.'); }
      finally { loadingTasks.delete(taskId); if (ui.page === 'inbox') render(); }
    }); return;
  }
  if (name === 'setup') { ui.setupOpen = ''; navigate('setup'); return; }
  if (name === 'orca-show') {
    target.disabled = true; target.textContent = 'Updating Orca…';
    void action(async () => {
      const status = await api(`/orca?repositoryId=${encodeURIComponent(target.dataset.repository)}`, { method: 'POST' });
      const holder = target.closest('#orca-readiness'); if (holder) holder.innerHTML = orcaReadiness(status, target.dataset.repository);
      toast(status.ready ? 'Orca now shows Rex Desk worktrees for this repository.' : 'Orca did not confirm the change. Check Orca settings.', !status.ready);
    }); return;
  }
  if (name === 'open-orca') {
    void action(async () => { await api(`/runs/${ui.selectedRun}/orca`, { method: 'POST' }); toast('Opened a terminal for this worktree in Orca.'); }); return;
  }
  if (name === 'database-connect' || name === 'database-sync') {
    const label = target.innerHTML; target.disabled = true; target.textContent = name === 'database-sync' ? 'Uploading…' : 'Connecting…';
    void action(async () => {
      try {
        if (name === 'database-connect') {
          const token = document.querySelector('#database-token');
          ui.snapshot.database = await api('/database/connect', { method: 'POST', data: { url: document.querySelector('#database-url').value.trim(), authToken: token.value } });
          token.value = '';
          toast(ui.snapshot.database.state === 'connected' ? 'Turso connected. Existing history was uploaded.' : `Saved. Turso is ${ui.snapshot.database.state}; changes wait in the local outbox.`, ui.snapshot.database.state !== 'connected');
        } else {
          const result = await api('/database/sync', { method: 'POST' }); ui.snapshot.database = result.status;
          toast(result.matched ? `Cloud copy verified: ${result.remoteRecords} records and ${result.remoteEvents} events match.` : `Cloud copy differs: local ${result.localRecords}/${result.localEvents}, Turso ${result.remoteRecords}/${result.remoteEvents}. Upload again or check the database.`, !result.matched);
        }
      } finally { const element = document.querySelector('[data-database]'); if (element && !element.contains(document.activeElement)) element.innerHTML = renderDatabase(); else if (target.isConnected) { target.disabled = false; target.innerHTML = label; } }
    }); return;
  }
  if (name === 'open-step') { ui.setupOpen = target.getAttribute('aria-expanded') === 'true' ? 'none' : target.dataset.step; render(); document.querySelector(`[data-step="${target.dataset.step}"] .setup-step-header`)?.focus(); return; }
  if (name === 'recheck-setup') { void loadAgents({ refresh: true }); return; }
  if (name === 'settings-anchor') { navigate('settings'); requestAnimationFrame(() => document.getElementById(target.dataset.anchor)?.scrollIntoView({ block: 'start' })); return; }
  if (name === 'copy-text') { void copyText(target.dataset.text, 'Command copied.'); return; }
  if (name === 'use-agent-profile') { void saveAgentProfile(target.dataset.provider, target.dataset.profile); return; }
  if (name === 'toggle-tour') {
    void action(async () => { const config = await api('/config', { method: 'PUT', data: { ...ui.snapshot.config, tourDismissed: !ui.snapshot.config.tourDismissed } }); ui.snapshot.config = config; if (ui.draft) ui.draft.tourDismissed = config.tourDismissed; render(); }); return;
  }
  if (name === 'install-mcp') {
    target.disabled = true; target.textContent = 'Installing…';
    void action(async () => {
      try { const result = await api('/agents/mcp', { method: 'POST', data: { provider: target.dataset.provider } }); toast(result.installed ? `Rex Desk MCP is available in ${providerName(target.dataset.provider)}. Restart open sessions to load it.` : 'The CLI finished, but the MCP entry was not found. Use the setup prompt instead.', !result.installed); }
      finally { await loadAgents(); }
    }); return;
  }
  if (name === 'copy-handoff') {
    void action(async () => {
      const { prompt } = await api('/handoff', { method: 'POST', data: { taskId: target.dataset.taskId || selectedTask()?.id, runId: target.dataset.runId || '' } });
      await copyText(prompt, 'Handoff copied. Paste it into any Claude Code or Codex session; it already has the rex_desk tools.');
    });
    return;
  }
  if (name === 'copy-setup-prompt') {
    void action(async () => { const { prompt } = await api('/setup-prompt', { method: 'POST', data: { target: target.dataset.target } }); ui.setupPrompt = prompt; for (const element of document.querySelectorAll('.mcp-setup')) element.outerHTML = renderMcpSetup(); await copyText(prompt, target.dataset.target === 'remote' ? 'Cloud setup prompt copied. Add the token in your AI client separately.' : 'Local setup prompt copied. Paste it into Claude Code or Codex.'); });
    return;
  }
  if (name === 'connect-source') { void connectSource(target.dataset.id); return; }
  if (name === 'source-agent') { void connectSource(target.dataset.id, target.dataset.provider); return; }
  if (name === 'toggle-theme') { window.rexTheme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return; }
  if (name === 'inspect-repository') { void inspectRepositorySettings(target.dataset.id); return; }
  if (name === 'browse-repository') {
    readSettings(); target.disabled = true; target.textContent = 'Choose a folder…';
    void action(async () => {
      try {
        const selected = await api('/repositories/pick', { method: 'POST' });
        const field = document.querySelector('#settings-form')?.elements[`repository.${target.dataset.id}.path`];
        if (selected.path && field) { field.value = selected.path; repositoryInfo.delete(target.dataset.id); await inspectRepositorySettings(target.dataset.id); }
      } finally { if (target.isConnected) { target.disabled = false; target.textContent = 'Choose folder'; } }
    }); return;
  }
  if (name === 'electron-preset' || name === 'remove-electron-preset') {
    readSettings(); const repository = ui.draft.repositories.find(item => item.id === target.dataset.id), info = repositoryInfo.get(repository.id)?.electron;
    if (name === 'electron-preset') {
      repository.electronRuntime = { appDir: info.appDir, electronPath: info.electronPath, args: info.args };
      if (!repository.setupCommand) repository.setupCommand = info.nestedInstall ? `npm ci; npm ci --prefix ${info.appDir}` : 'npm ci';
    } else delete repository.electronRuntime;
    render(); return;
  }
  if (name === 'flow-preset' || name === 'remove-flow-preset') {
    readSettings(); const repository = ui.draft.repositories.find(item => item.id === target.dataset.id);
    if (name === 'flow-preset') repository.flowRuntime = structuredClone(repositoryInfo.get(repository.id).flow);
    else delete repository.flowRuntime;
    render(); return;
  }
  if (name === 'settings' || name === 'inbox') { navigate(name); return; }
  if (name === 'view-list') { ui.view = 'list'; ui.page = 'inbox'; render(); void loadMessages(); return; }
  if (name === 'view-board') { ui.view = 'board'; render(); return; }
  if (name === 'close-dialog') { target.closest('dialog').close(); return; }
  if (name === 'prioritize' || name === 'prioritize-one') {
    if (!ui.snapshot.jev?.configured) { navigate('settings'); document.querySelector('#jev')?.scrollIntoView(); return; }
    const force = name === 'prioritize' && event.shiftKey;
    void action(async () => {
      if (name === 'prioritize-one') await api('/jev/prioritize', { method: 'POST', data: { taskId: target.dataset.taskId } });
      const result = name === 'prioritize-one' ? null : await api('/jev/prioritize', { method: 'POST', data: { force } });
      await refresh({ force: true });
      if (result) toast(result.failed ? `Jev rated ${result.done - result.failed} of ${result.total}; ${result.failed} failed: ${result.error}` : result.total ? `Jev rated ${plural(result.total, 'issue')}. The list is in priority order.` : 'Every issue is already rated. Shift-click Prioritize to re-check all.', Boolean(result?.failed));
    }); return;
  }
  if (name === 'run-next') { ui.selectedTask = target.dataset.taskId; resetDetailTab(); render(); void launchDialog({ mode: target.dataset.mode }); return; }
  if (name === 'launch-task') { void launchDialog(); return; }
  if (name === 'select-projects') {
    const boxes = [...document.querySelectorAll('[data-source-project]')].filter(box => box.dataset.sourceProject === target.dataset.id && !box.closest('[hidden]'));
    for (const box of boxes) box.checked = Boolean(target.dataset.all);
    boxes[0]?.dispatchEvent(new Event('change', { bubbles: true })); return;
  }
  if (name === 'launch-verify') { void launchDialog({ mode: 'verify' }); return; }
  if (name === 'qa-tracker') {
    target.disabled = true;
    void action(async () => {
      try {
        const result = await api(`/runs/${ui.selectedRun}/tracker`, { method: 'POST', data: { phase: target.dataset.phase } });
        toast(result?.skipped ? `${result.reason} Set the status mapping under Settings → Connections → Tracker status mapping.` : target.dataset.phase === 'done' ? 'Tracker updated: done.' : 'Tracker updated: reopened for development.', Boolean(result?.skipped));
        await refresh({ force: true });
      } finally { if (target.isConnected) target.disabled = false; }
    }); return;
  }
  if (name === 'qa-sign-in') {
    void action(async () => {
      const url = target.dataset.url || '';
      ui.snapshot.qaSession = await api('/qa/sign-in', { method: 'POST', data: url ? { url } : {} });
      toast(url ? `A browser window opened at ${new URL(url).host}. Sign in, then close it.` : 'A browser window opened. Go to each test site you use, sign in, then close it.');
      await watchQaSession();
    }); return;
  }
  if (name === 'schedule-run') {
    target.disabled = true;
    void action(async () => {
      try { const result = await api('/schedule/run', { method: 'POST' }); toast(result.state === 'started' ? `Started a main agent for ${plural(result.issues, 'new issue')}.` : result.reason, result.state !== 'started'); await refresh({ force: true }); }
      finally { if (target.isConnected) target.disabled = false; }
    }); return;
  }

  // From the start dialog: browse for a checkout, paste its path, or clone owner/name with the GitHub login; then save it and reopen with its branches.
  if (name === 'add-repo-inline' || name === 'browse-repo-inline') {
    const form = target.closest('form'), role = form?.dataset.role || 'worker', label = target.textContent, source = form?.elements.repositorySource?.value.trim() || '';
    if (name === 'add-repo-inline' && !source) { form?.elements.repositorySource?.focus(); toast('Paste the repository folder, or a GitHub owner/name.', true); return; }
    const github = name === 'add-repo-inline' && !/[\\:]/.test(source) && /^[\w.-]+\/[\w.-]+$|^https:\/\/github\.com\//.test(source);
    target.disabled = true; target.textContent = name === 'browse-repo-inline' ? 'Choose a folder…' : github ? 'Cloning…' : 'Reading…';
    void action(async () => {
      try {
        const folder = name === 'browse-repo-inline' ? (await api('/repositories/pick', { method: 'POST' })).path : github ? (await api('/repositories/clone', { method: 'POST', data: { repository: source } })).path : source;
        if (!folder) return;
        target.textContent = 'Reading branches…';
        const info = await api('/repositories/inspect', { method: 'POST', data: { path: folder } }), config = ui.snapshot.config;
        let repository = config.repositories.find(item => samePath(item.path, info.path));
        if (!repository) {
          repository = { id: crypto.randomUUID(), name: info.name, path: info.path, baseBranch: info.preferredBranch, targetBranch: info.preferredBranch, branchPattern: '', setupCommand: '', devCommand: '', testCommand: '', browserPath: '/' };
          ui.snapshot.config = await api('/config', { method: 'PUT', data: { ...config, repositories: [...config.repositories, repository] } });
          toast(`Added ${info.name} · ${info.branches.length} branch${info.branches.length === 1 ? '' : 'es'}. Its commands come from the project's own files.`);
        }
        await launchDialog({ role, repositoryId: repository.id });
      } finally { if (target.isConnected) { target.disabled = false; target.textContent = label; } }
    }); return;
  }
  if (name === 'resume-run') { void launchDialog({ role: selectedRun().role, resume: true }); return; }
  if (name === 'publish-run') { publishDialog(); return; }
  if (name === 'select-decision') { ui.selectedDecision = target.dataset.id; render(); return; }
  if (name === 'github-login') { target.disabled = true; target.textContent = 'Getting a code…'; void action(async () => { const login = await api('/github/login', { method: 'POST' }); ui.github = { ...(ui.github || { installed: true, accounts: [] }), login }; await loadGithub(); }); return; }
  if (name === 'github-cancel') { void action(async () => { await api('/github/login', { method: 'DELETE' }); await loadGithub(); }); return; }
  if (name === 'github-switch') { void action(async () => { ui.github = await api('/github/switch', { method: 'POST', data: { user: target.dataset.user } }); await loadGithub(); toast(`${target.dataset.user} is now the active GitHub account.`); }); return; }
  if (name === 'run-side') { ui.runSide = target.dataset.side; render(); return; }
  if (name === 'open-issue') { resetDetailTab(); ui.view = 'list'; navigate('inbox'); return; }
  if (name === 'detail-layout') { setDetailLayout(target.dataset.layout); return; }
  if (name === 'focus-run') { ui.selectedRun = target.dataset.id; saveWorkspace(); render(); void loadMessages(); return; }
  if (name === 'close-run') { closeRun(target.dataset.id); render(); void loadMessages(); return; }
  if (name === 'set-layout') { ui.layout = target.dataset.layout; ui.layoutChosen = true; saveWorkspace(); render(); void loadMessages(); return; }
  if (name === 'open-live') { for (const run of ui.snapshot.runs.filter(run => activeStates.includes(run.state) || pending(run.id).length).slice(0, 4).reverse()) openRun(run.id); ui.layout = 'grid'; ui.layoutChosen = true; saveWorkspace(); render(); void loadMessages(); return; }
  if (name === 'open-task-run') { navigate('runs', { runId: taskRun(selectedTask()).id }); return; }
  if (name === 'open-evidence-run') { navigate('runs', { runId: target.dataset.id }); return; }
  if (name === 'add-source') {
    readSettings(); ui.draft.sources.push({ id: crypto.randomUUID(), name: 'Morningmate', type: 'morningmate', baseUrl: 'https://api.morningmate.com', projectIds: [], userId: '', repositoryId: '', statusMap: {} }); render(); return;
  }
  if (name === 'add-test-account') {
    readSettings(); ui.draft.testAccounts.push({ id: crypto.randomUUID(), site: '', username: '', hasPassword: false }); render(); return;
  }
  if (name === 'remove-test-account') {
    readSettings(); ui.draft.testAccounts = ui.draft.testAccounts.filter(item => item.id !== target.dataset.id); render(); return;
  }
  if (name === 'find-repositories') {
    readSettings(); ui.foundLoading = true; render();
    void action(async () => { ui.found = (await api('/repositories/discover')).repositories; }).finally(() => { ui.foundLoading = false; render(); });
    return;
  }
  if (name === 'add-found-repository') {
    readSettings();
    ui.draft.repositories.push({ id: crypto.randomUUID(), name: target.dataset.name, path: target.dataset.path, baseBranch: '', targetBranch: '', branchPattern: '', setupCommand: '', devCommand: '', testCommand: '', browserPath: '/' });
    render(); return;
  }
  if (name === 'add-repository') {
    readSettings(); ui.draft.repositories.push({ id: crypto.randomUUID(), name: '', path: '', baseBranch: '', targetBranch: '', branchPattern: '', setupCommand: '', devCommand: '', testCommand: '', browserPath: '/' }); render(); return;
  }
  if (name === 'remove-source' || name === 'remove-repository') {
    readSettings(); const field = name === 'remove-source' ? 'sources' : 'repositories'; ui.draft[field] = ui.draft[field].filter(item => item.id !== target.dataset.id); render(); return;
  }
  void action(async () => {
    if (name === 'sync') {
      ui.busy = true; render(); const results = await api('/sync', { method: 'POST' });
      const failures = results.filter(result => result.error);
      toast(failures.length ? failures.map(result => `${result.name}: ${result.error}`).join('\n') : `Synced ${results.reduce((sum, result) => sum + result.count, 0)} assigned issues.`, Boolean(failures.length));
      ui.busy = false; await refresh({ force: true });
    }
    if (name === 'demo') { await api('/demo', { method: 'POST' }); await refresh({ force: true }); }
    if (name === 'remove-demo') { await api('/demo', { method: 'DELETE' }); ui.selectedTask = ''; await refresh({ force: true }); }
    if (name === 'stop-run') { await api(`/runs/${ui.selectedRun}/stop`, { method: 'POST' }); await refresh({ force: true }); }
    if (name === 'diagnostics') {
      const result = await api('/diagnostics'); document.querySelector('#diagnostics').innerHTML = `<div class="connection-health">${result.tools.map(tool => `<span class="tag ${tool.available ? 'finished' : 'failed'}">${esc(tool.name)}: ${esc(tool.available ? tool.version : 'Not available')}</span>`).join('')}</div>`;
    }
    if (name === 'mcp-setup') {
      const result = await api('/mcp-config', { method: 'POST' });
      document.querySelector('#mcp-setup').innerHTML = `<div class="help-block"><strong>Connection URL</strong><pre>${esc(result.url)}</pre><label class="field"><span>Access token · keep private</span><input type="password" readonly value="${esc(result.token)}" id="mcp-token" autocomplete="off"></label>${button('Copy access token', 'copy-token', 'small', 'type="button"')}<p>Set <code>REX_DESK_TOKEN</code> in the environment of your AI client.</p><p>External clients can use <code>desk_ask</code> with <code>wait=false</code>, then poll <code>desk_question</code> if they cannot keep a tool call open.</p></div>`;
    }
    if (name === 'copy-token') { await navigator.clipboard.writeText(document.querySelector('#mcp-token').value); toast('Access token copied.'); }
  }).finally(() => { if (ui.busy) { ui.busy = false; render(); } });
});
document.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]'); if (!tab || tabDragEnded) return;
  if (tab.dataset.slot) placeTab(tab.dataset.slot, tab.dataset.tab); else ui.tab = tab.dataset.tab;
  saveWorkspace(); render(); void loadMessages();
});
// Dividers drag with the pointer or move with the arrow keys; Enter or a double-click restores the default size.
let resizing = null, tabDrag = null, tabDragEnded = false;
function layoutSettled() { ui.dragging = false; if (ui.missedRender) { ui.missedRender = false; render(); void loadMessages(); } }
function resetSize(kind) { if (kind === 'side') setSideWidth(0); else if (kind === 'proof') setProofWidth(0); else setSplitRatio(0.5); saveWorkspace(); }
document.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const handle = event.target.closest?.('[data-resize]');
  if (handle) {
    event.preventDefault(); handle.setPointerCapture(event.pointerId); handle.classList.add('active');
    resizing = { kind: handle.dataset.resize, handle }; ui.dragging = true;
    document.body.classList.add('resizing', handle.dataset.resize === 'split' && ui.detailLayout === 'rows' ? 'resizing-rows' : 'resizing-columns');
    return;
  }
  const tab = event.target.closest?.('.detail-pane [data-tab]');
  if (tab && !compactQuery.matches) tabDrag = { key: tab.dataset.tab, tab, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, zone: null };
});
// Where a dragged tab would land: a half of the single panel opens a split on that side; in split view, the panel under the pointer.
function tabDropZone(x, y) {
  const main = document.querySelector('#main')?.getBoundingClientRect(); if (!main) return null;
  const visible = rect => { const left = Math.max(rect.left, main.left), top = Math.max(rect.top, main.top); return { left, top, width: Math.min(rect.right, main.right) - left, height: Math.min(rect.bottom, main.bottom) - top }; };
  const inside = box => box.width > 0 && box.height > 0 && x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height;
  if (detailLayout() === 'tabs') {
    const body = document.querySelector('.detail-body'), box = body && visible(body.getBoundingClientRect());
    if (!box || !inside(box)) return null;
    const dx = (x - box.left) / box.width - 0.5, dy = (y - box.top) / box.height - 0.5, columns = Math.abs(dx) >= Math.abs(dy), slot = (columns ? dx : dy) < 0 ? 'first' : 'second';
    const half = columns ? { ...box, width: box.width / 2, left: slot === 'first' ? box.left : box.left + box.width / 2 } : { ...box, height: box.height / 2, top: slot === 'first' ? box.top : box.top + box.height / 2 };
    return { layout: columns ? 'columns' : 'rows', slot, box: half, label: columns ? (slot === 'first' ? 'Open on the left' : 'Open on the right') : (slot === 'first' ? 'Open above' : 'Open below') };
  }
  for (const pane of document.querySelectorAll('.split-pane')) { const box = visible(pane.getBoundingClientRect()); if (inside(box)) return { slot: pane.dataset.slot, box, label: 'Show here' }; }
  return null;
}
function drawTabDrag(x, y) {
  let zone = document.querySelector('#drop-zone'), chip = document.querySelector('#drag-chip');
  if (!zone) { zone = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'drop-zone', className: 'drop-zone' })); zone.append(document.createElement('span')); }
  if (!chip) chip = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'drag-chip', className: 'drag-chip', textContent: detailTabNames[tabDrag.key] }));
  Object.assign(chip.style, { left: `${x + 12}px`, top: `${y + 14}px` });
  zone.hidden = !tabDrag.zone;
  if (tabDrag.zone) { const { left, top, width, height } = tabDrag.zone.box; Object.assign(zone.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }); zone.firstChild.textContent = tabDrag.zone.label; }
}
function endTabDrag(drop) {
  const drag = tabDrag; tabDrag = null;
  if (!drag?.active) return;
  document.querySelector('#drop-zone')?.remove(); document.querySelector('#drag-chip')?.remove(); document.body.classList.remove('dragging-tab');
  tabDragEnded = true; setTimeout(() => { tabDragEnded = false; });
  if (drop && drag.zone) { ui.dragging = false; ui.missedRender = false; dropTab(drag.key, drag.zone); } else layoutSettled();
}
document.addEventListener('pointermove', event => {
  if (resizing) {
    if (resizing.kind === 'side') setSideWidth(event.clientX - (document.querySelector('.side')?.getBoundingClientRect().left || 48));
    else if (resizing.kind === 'proof') { const pane = resizing.handle.closest('.pane'); setProofWidth(pane.getBoundingClientRect().right - event.clientX, pane); }
    else { const box = document.querySelector('.detail-split')?.getBoundingClientRect(); if (box) setSplitRatio(ui.detailLayout === 'rows' ? (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width); }
    return;
  }
  if (!tabDrag) return;
  if (!tabDrag.active) {
    if (Math.hypot(event.clientX - tabDrag.x, event.clientY - tabDrag.y) < 6) return;
    tabDrag.active = true; ui.dragging = true; document.body.classList.add('dragging-tab');
    try { tabDrag.tab.setPointerCapture(tabDrag.pointer); } catch {}
  }
  tabDrag.zone = tabDropZone(event.clientX, event.clientY); drawTabDrag(event.clientX, event.clientY);
});
function endPointer(event) {
  if (resizing) {
    resizing.handle.classList.remove('active'); resizing = null;
    document.body.classList.remove('resizing', 'resizing-rows', 'resizing-columns'); saveWorkspace(); layoutSettled(); return;
  }
  endTabDrag(event.type === 'pointerup');
}
document.addEventListener('pointerup', endPointer);
document.addEventListener('pointercancel', endPointer);
document.addEventListener('dblclick', event => { const handle = event.target.closest?.('[data-resize]'); if (handle) resetSize(handle.dataset.resize); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && tabDrag?.active) { tabDrag.zone = null; endTabDrag(false); return; }
  const handle = event.target.closest?.('[data-resize]'); if (!handle) return;
  const side = handle.dataset.resize === 'side', rows = handle.dataset.resize === 'split' && ui.detailLayout === 'rows';
  const step = { [rows ? 'ArrowUp' : 'ArrowLeft']: -1, [rows ? 'ArrowDown' : 'ArrowRight']: 1 }[event.key];
  if (!step && !['Home', 'End', 'Enter'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Enter') { resetSize(handle.dataset.resize); return; }
  if (side) { const [min, max] = sideLimits(), width = document.querySelector('.side')?.getBoundingClientRect().width || min; setSideWidth(event.key === 'Home' ? min : event.key === 'End' ? max : width + step * (event.shiftKey ? 64 : 16)); }
  // The proof column sits on the right, so moving its divider left widens it.
  else if (handle.dataset.resize === 'proof') { const pane = handle.closest('.pane'), width = pane.querySelector('.pane-proof')?.getBoundingClientRect().width || 260; setProofWidth(event.key === 'Home' ? 200 : event.key === 'End' ? 10000 : width - step * (event.shiftKey ? 64 : 16), pane); }
  else setSplitRatio(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : ui.splitRatio + step * (event.shiftKey ? 0.1 : 0.05));
  saveWorkspace();
});
compactQuery.addEventListener('change', () => { if (ui.snapshot) { render(); void loadMessages(); } });
document.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.closest('.issue-images')) return;
  const link = image.closest('a'), figure = image.closest('figure');
  figure.classList.add('unavailable');
  image.replaceWith(Object.assign(document.createElement('span'), { className: 'image-missing', textContent: 'Preview unavailable' }));
  if (link?.dataset.original) { link.href = link.dataset.original; link.title = 'Open the original tracker image'; link.removeAttribute('data-view'); }
}, true);
// Attachment viewer: images and videos from the issue or the evidence open here, with the others in the same view one arrow away.
const viewer = { items: [], index: 0, actual: false };
function openViewer(items, index) {
  Object.assign(viewer, { items, index, actual: false });
  const dialog = document.querySelector('#viewer'); renderViewer();
  if (!dialog.open) dialog.showModal();
}
function renderViewer() {
  const dialog = document.querySelector('#viewer'), item = viewer.items[viewer.index], count = viewer.items.length;
  if (!item) return;
  const nav = count > 1 ? `<button type="button" class="viewer-nav prev" data-viewer-step="-1" aria-label="Previous">${icon('chevron')}</button><button type="button" class="viewer-nav next" data-viewer-step="1" aria-label="Next">${icon('chevron')}</button>` : '';
  dialog.innerHTML = `<div class="viewer-head"><span class="viewer-kind">${icon(item.kind === 'video' ? 'play' : 'image')}</span><strong title="${esc(item.name)}">${esc(item.name)}</strong>${count > 1 ? `<span class="viewer-count">${viewer.index + 1} of ${count}</span>` : ''}<div class="actions">${item.kind === 'image' ? `<button type="button" class="button small quiet" data-viewer-zoom>${viewer.actual ? 'Fit to window' : 'Actual size'}</button>` : ''}<a class="button small quiet" href="${esc(item.src)}" download="${esc(item.name)}">Download</a>${item.original ? `<a class="button small quiet" href="${esc(item.original)}" target="_blank" rel="noopener">Original</a>` : ''}<button type="button" class="button quiet icon-only" data-viewer-close aria-label="Close viewer">${icon('close')}</button></div></div>
    <div class="viewer-stage${viewer.actual ? ' actual' : ''}"><p class="viewer-note" role="status">${item.kind === 'video' ? 'Loading the video…' : 'Loading…'}</p>${item.kind === 'video' ? `<video controls autoplay playsinline src="${esc(item.src)}"></video>` : `<img src="${esc(item.src)}" alt="${esc(item.name)}" data-viewer-zoom>`}${nav}</div>`;
}
function stepViewer(step) { if (viewer.items.length > 1) { viewer.index = (viewer.index + step + viewer.items.length) % viewer.items.length; viewer.actual = false; renderViewer(); } }
document.addEventListener('click', event => {
  const trigger = event.target.closest?.('[data-view]');
  if (!trigger || trigger.closest('#viewer')) return;
  event.preventDefault(); event.stopPropagation();
  const scope = trigger.closest('.detail-pane, .pane, .main') || document;
  const triggers = [...scope.querySelectorAll('[data-view]')];
  openViewer(triggers.map(element => ({ kind: element.dataset.view, src: element.dataset.viewSrc, name: element.dataset.viewName, original: element.dataset.viewOriginal || '' })), Math.max(0, triggers.indexOf(trigger)));
}, true);
document.querySelector('#viewer').addEventListener('click', event => {
  const dialog = event.currentTarget;
  if (event.target === dialog || event.target.closest('[data-viewer-close]')) { dialog.close(); return; }
  const step = event.target.closest('[data-viewer-step]'); if (step) { stepViewer(Number(step.dataset.viewerStep)); return; }
  if (event.target.closest('[data-viewer-zoom]')) { viewer.actual = !viewer.actual; renderViewer(); }
});
// Arrow keys move between attachments wherever focus is, except inside a playing video, where they seek.
document.addEventListener('keydown', event => {
  if (!document.querySelector('#viewer')?.open || !['ArrowLeft', 'ArrowRight'].includes(event.key) || event.target.tagName === 'VIDEO') return;
  event.preventDefault(); stepViewer(event.key === 'ArrowLeft' ? -1 : 1);
});
document.querySelector('#viewer').addEventListener('close', event => { event.currentTarget.innerHTML = ''; });
// The stage shows a note until the media is ready, and says plainly when a format cannot play here.
['load', 'loadeddata'].forEach(type => document.querySelector('#viewer').addEventListener(type, event => { if (event.target.closest?.('.viewer-stage')) event.target.closest('.viewer-stage').querySelector('.viewer-note')?.remove(); }, true));
document.querySelector('#viewer').addEventListener('error', event => {
  const stage = event.target.closest?.('.viewer-stage'); if (!stage) return;
  const note = stage.querySelector('.viewer-note') || stage.appendChild(Object.assign(document.createElement('p'), { className: 'viewer-note' }));
  note.textContent = event.target.tagName === 'VIDEO' ? 'This video cannot play here. It may be too large, unavailable, or in a format the window cannot play. Use Download or Original.' : 'This image could not be loaded. Use Original to open it in the tracker.';
  event.target.remove();
}, true);
window.addEventListener('rex-theme', () => {
  const control = document.querySelector('[data-action="toggle-theme"]');
  if (control) control.outerHTML = themeButton();
  const select = document.querySelector('#theme-preference'); if (select) select.value = window.rexTheme.preference;
});
document.addEventListener('input', event => {
  if (event.target.dataset.catalogSearch) {
    const query = event.target.value.toLowerCase();
    for (const label of event.target.closest('.project-picker').querySelectorAll('.project-choice')) label.hidden = !label.textContent.toLowerCase().includes(query);
    return;
  }
  const repositoryId = event.target.closest('[data-repository]')?.dataset.repository;
  if (repositoryId && event.target.name.endsWith('.branchPattern')) previewBranch(repositoryId);
  if (event.target.name === 'branchPrefix') for (const repository of ui.draft.repositories) previewBranch(repository.id);
  if (event.target.id === 'task-search') {
    ui.search = event.target.value;
    if (!renderTaskResults()) { const cursor = event.target.selectionStart; render(); const field = document.querySelector('#task-search'); field.focus(); field.setSelectionRange(cursor, cursor); }
  }
});
async function saveAgentProfile(provider, profile) {
  await action(async () => {
    ui.agents = await api('/agents/profile', { method: 'POST', data: { provider, profile } });
    const state = await api('/state'); ui.snapshot = state; if (ui.draft) ui.draft.agentProfiles = state.config.agentProfiles;
    const chosen = selectedProfile(provider);
    toast(`${providerName(provider)} will use ${chosen?.label || 'the selected profile'}${chosen?.loggedIn ? '' : ' (not signed in yet)'}.`, !chosen?.loggedIn);
    render();
  });
}
document.addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.agentProfile) { void saveAgentProfile(target.dataset.agentProfile, target.value); return; }
  if (target.dataset.sourceProject || target.dataset.sourceEmployee) {
    const sourceId = target.dataset.sourceProject || target.dataset.sourceEmployee;
    const form = document.querySelector('#settings-form');
    if (target.dataset.sourceProject) form.elements[`source.${sourceId}.projectIds`].value = [...form.querySelectorAll('[data-source-project]')].filter(input => input.dataset.sourceProject === sourceId && input.checked).map(input => input.value).join(', ');
    else form.elements[`source.${sourceId}.userId`].value = target.value;
    readSettings(); return;
  }
  if (target.id === 'theme-preference') { window.rexTheme.set(target.value); return; }
  const repositoryId = target.closest('[data-repository]')?.dataset.repository;
  if (repositoryId && target.name.endsWith('.path')) { repositoryInfo.delete(repositoryId); void inspectRepositorySettings(repositoryId); return; }
  if (target.dataset.statusName !== undefined) { const box = target.closest('.status-picker'); box.querySelector('input[type=hidden]').value = [...box.querySelectorAll('[data-status-name]')].filter(item => item.checked).map(item => item.dataset.statusName).join('\n'); readSettings(); return; }
  if (target.id === 'task-sort') { ui.sort = target.value; saveWorkspace(); if (!renderTaskResults()) render(); return; }
  if (target.id === 'source-filter' || target.id === 'category-filter') { ui[target.id === 'source-filter' ? 'source' : 'category'] = target.value; if (!renderTaskResults()) render(); return; }
  if (target.closest('#settings-form') && target.name.endsWith('.type')) {
    const card = target.closest('.settings-card'); const base = card.querySelector('input[name$=".baseUrl"]');
    if (['https://api.morningmate.com', 'https://api.flow.team'].includes(base.value)) base.value = target.value === 'flow' ? 'https://api.flow.team' : 'https://api.morningmate.com';
  }
  if (target.closest('#launch-form') && target.name === 'repositoryId') void updateOrcaReadiness(target.form);
  if (target.closest('#launch-form') && target.name === 'repositoryId') {
    const repository = ui.snapshot.config.repositories.find(item => item.id === target.value);
    const runtimeField = document.querySelector('#runtime-profile-field'); if (runtimeField) runtimeField.innerHTML = runtimeProfileField(repository);
    if (repository) { const form = target.form; for (const key of ['baseBranch', 'targetBranch']) { form.elements[key].value = repository[key]; const shown = form.elements[key].closest('.field')?.querySelector('.picker-input'); if (shown) { shown.value = repository[key]; shown.dataset.label = repository[key]; } } void loadBranches(repository.id); }
  }
  if (target.closest('.decision') && target.tagName === 'SELECT' && target.value === '__custom') target.parentElement.querySelector('.custom-answer')?.classList.remove('hidden');
});
document.addEventListener('scroll', event => {
  const box = event.target; if (!box.dataset?.transcript) return;
  ui.transcripts.set(box.dataset.transcript, { top: box.scrollTop, stick: box.scrollHeight - box.scrollTop - box.clientHeight < 60 });
}, true);
document.addEventListener('toggle', event => {
  const op = event.target.dataset?.op; if (op) { if (event.target.open) ui.openOps.add(op); else ui.openOps.delete(op); }
  const panel = event.target.dataset?.orcaPanel; if (panel) { if (event.target.open) ui.orcaOpen.add(panel); else ui.orcaOpen.delete(panel); }
  const runId = event.target.dataset?.journal;
  if (runId && event.target.open) void action(async () => {
    ui.journals.set(runId, await api(`/runs/${runId}/journal`)); const target = document.getElementById(`journal-${runId}`); if (target) target.innerHTML = renderJournal(runId);
  });
}, true);
// Clicking into a pane focuses its run without rebuilding the page.
document.addEventListener('pointerdown', event => {
  const pane = event.target.closest?.('[data-pane-run]'); if (!pane || pane.dataset.paneRun === ui.selectedRun) return;
  ui.selectedRun = pane.dataset.paneRun; saveWorkspace();
  for (const element of document.querySelectorAll('.pane.focused, .run-tab.active')) element.classList.remove('focused', 'active');
  pane.classList.add('focused'); document.querySelector(`.run-tab [data-id="${pane.dataset.paneRun}"]`)?.closest('.run-tab')?.classList.add('active');
});
// Alt+1…9 brings an open run forward, the way editors switch tabs.
document.addEventListener('keydown', event => {
  if (!event.altKey || event.ctrlKey || event.metaKey || !/^Digit[1-9]$/.test(event.code) || ui.page !== 'runs') return;
  const runId = ui.openRuns[Number(event.code.slice(5)) - 1]; if (!runId) return;
  event.preventDefault(); ui.selectedRun = runId; saveWorkspace(); render(); void loadMessages();
  document.querySelector(`[data-pane-run="${runId}"]`)?.focus?.();
});
document.addEventListener('submit', event => {
  const form = event.target;
  if (!['settings-form', 'launch-form', 'publish-form'].includes(form.id) && !form.dataset.interaction && !form.dataset.composer && !form.dataset.say) return;
  event.preventDefault();
  void action(async () => {
    if (form.dataset.say) {
      const input = form.elements.text, submit = form.querySelector('[type=submit]'); submit.disabled = true;
      try { await api(`/runs/${form.dataset.say}/say`, { method: 'POST', data: { text: input.value } }); input.value = ''; }
      finally { submit.disabled = false; }
      await refresh({ force: true }); document.querySelector(`[data-say="${form.dataset.say}"] input`)?.focus(); return;
    }
    if (form.dataset.composer) {
      const run = ui.snapshot.runs.find(item => item.id === form.dataset.composer), submit = form.querySelector('[type=submit]'); submit.disabled = true;
      try { await api(`/runs/${run.id}/resume`, { method: 'POST', data: { provider: run.provider, prompt: form.elements.prompt.value } }); form.reset(); toast(`Follow-up sent. ${providerName(run.provider)} continues this run.`); }
      finally { submit.disabled = false; }
      await refresh({ force: true }); return;
    }
    if (form.id === 'settings-form') {
      const config = await api('/config', { method: 'PUT', data: readSettings() });
      ui.draft = structuredClone(config); ui.snapshot.config = config; render(); toast('Settings saved.');
      for (const source of config.sources) if (source.hasKey && !sourceDirectory(source.id)) await connectSource(source.id);
      return;
    }
    if (form.id === 'launch-form') {
      const input = Object.fromEntries(new FormData(form));
      try {
        let run;
        if (form.dataset.resume === 'true') run = await api(`/runs/${ui.selectedRun}/resume`, { method: 'POST', data: input });
        else run = await api('/runs', { method: 'POST', data: { ...input, mode: form.dataset.mode || 'fix', taskId: ui.selectedTask, instructions: input.prompt } });
        document.querySelector('#launch-dialog').close(); await refresh(); navigate('runs', { runId: run.id }); toast('Agent run queued.');
      } catch (error) { document.querySelector('#launch-error').textContent = error.message; } return;
    }
    if (form.id === 'publish-form') {
      const submit = form.querySelector('[type=submit]'); submit.disabled = true; submit.textContent = 'Creating draft PR…';
      try { await api(`/runs/${ui.selectedRun}/publish`, { method: 'POST', data: Object.fromEntries(new FormData(form)) }); document.querySelector('#publish-dialog').close(); await refresh({ force: true }); toast('Draft pull request created.'); }
      catch (error) { document.querySelector('#publish-error').textContent = error.message; submit.disabled = false; submit.textContent = 'Push & create draft PR'; } return;
    }
    if (form.dataset.interaction) {
      const decision = event.submitter?.value || 'accept', content = {};
      for (const field of form.querySelectorAll('[data-type]')) {
        let value = field.value;
        if (value === '__custom') value = form.elements[`${field.name}__custom`].value;
        if (value === '') continue;
        content[field.name] = field.dataset.type === 'boolean' ? value === 'true' : ['number', 'integer'].includes(field.dataset.type) ? Number(value) : value;
      }
      const always = decision === 'always';
      await api(`/interactions/${form.dataset.interaction}/answer`, { method: 'POST', data: { action: always ? 'accept' : decision, content: always ? { ...content, always: true } : content } });
      await refresh({ force: true }); toast(always ? 'Allowed for the rest of this run.' : decision === 'accept' ? 'Response sent to the agent.' : 'Request declined or cancelled.');
    }
  });
});

try {
  restoreWorkspace();
  await refresh({ force: true });
  if (!ui.snapshot.config.sources.length && !ui.snapshot.tasks.length) navigate('setup');
  void loadAgents().then(() => {
    const agent = selectedProfile(ui.snapshot.config.provider);
    if (agent && !agent.loggedIn && ui.page === 'inbox' && !ui.autoTour) { ui.autoTour = true; ui.setupOpen = 'agent'; navigate('setup'); toast(`${providerName(ui.snapshot.config.provider)} is not signed in for the selected profile. Choose a signed-in profile to run agents.`, true); }
  });
  void pollOrcaScreens();
  const stream = new EventSource('/api/events');
  let timer;
  stream.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(() => void refresh().catch(error => toast(error.message, true)), 400); });
  stream.onerror = () => { document.querySelector('.local-state')?.setAttribute('title', 'Reconnecting to the local server…'); };
} catch (error) {
  app.innerHTML = `<div class="empty"><h1>Workspace unavailable</h1><p>${esc(error.message)}</p><p>Start Rex Desk with <code>npm start</code>, then reload this page.</p></div>`;
}
// Enter in the repository box adds the repository instead of submitting the start form without one.
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.target.name !== 'repositorySource') return;
  event.preventDefault(); event.target.closest('.repo-setup')?.querySelector('[data-action="add-repo-inline"]')?.click();
});
// Starting at Windows sign-in is a machine setting, applied immediately rather than with Save settings.
document.addEventListener('change', event => {
  if (event.target.id !== 'autostart') return;
  const box = event.target; box.disabled = true;
  void action(async () => {
    try { const status = await api('/autostart', { method: 'POST', data: { enabled: box.checked } }); box.checked = status.enabled; toast(status.enabled ? 'Rex Desk will start in the background when you sign in to Windows.' : 'Rex Desk will no longer start at sign-in.'); }
    finally { box.disabled = false; }
  });
});

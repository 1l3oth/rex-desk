const app = document.querySelector('#app');
const repositoryInfo = new Map(), inspecting = new Map(), previewTimers = new Map(), connectingSources = new Set();
const loadingTasks = new Set(), taskErrors = new Map();
const providerName = provider => provider === 'codex' ? 'Codex' : 'Claude Code';
const samePath = (left, right) => String(left || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === String(right || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const taskImage = (task, address) => `/api/task-image?task=${encodeURIComponent(task.id)}&url=${encodeURIComponent(address)}`;
const ui = { page: 'inbox', view: 'list', selectedTask: '', selectedRun: '', tab: 'brief', checked: new Set(), search: '', source: '', category: '', snapshot: null, messages: [], journal: [], draft: null, busy: false, agents: null, agentsLoading: false, agentsError: '', setupOpen: '', setupPrompt: '', autoTour: false };
const labels = { queued: 'Queued', starting: 'Preparing', running: 'Working', waiting: 'Needs you', needs_evidence: 'Needs evidence', ready_for_review: 'Ready for review', published: 'PR created', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted', finished: 'Finished' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const button = (label, action, style = '', extra = '') => `<button class="button ${style}" data-action="${action}" ${extra}>${label}</button>`;
const sourceLogo = source => `<span class="source-logo ${source}">${source === 'flow' ? 'f' : 'm'}</span>`;
const tag = state => `<span class="tag ${esc(state)}">${esc(labels[state] || state)}</span>`;
const time = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
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
  if (runId) ui.selectedRun = runId;
  if (taskId) ui.selectedTask = taskId;
  if (page === 'settings' && !ui.draft) ui.draft = structuredClone(ui.snapshot.config);
  ui.messages = []; ui.journal = [];
  render(); void loadMessages();
}
async function refresh({ force = false } = {}) {
  ui.snapshot = await api('/state');
  if (!ui.selectedTask && ui.snapshot.tasks.length) ui.selectedTask = ui.snapshot.tasks[0].id;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (force || (ui.page !== 'settings' && !typing && !document.querySelector('dialog[open]'))) { render(); await loadMessages(); }
  else if (ui.page === 'settings') { const database = document.querySelector('[data-database]'); if (database && !database.contains(document.activeElement)) database.innerHTML = renderDatabase(); }
}
function render() {
  const state = ui.snapshot;
  if (!state) return;
  const pages = [['inbox', 'inbox', 'My issues'], ['board', 'board', 'Kanban'], ['decisions', 'question', 'Needs you'], ['runs', 'agents', 'Agent runs'], ['evidence', 'play', 'Evidence'], ['setup', 'compass', 'Setup'], ['settings', 'settings', 'Settings']];
  const steps = setupSteps(), remaining = steps.filter(step => !step.done && !step.optional).length;
  const pageName = pages.find(([page]) => page === ui.page)?.[2] || 'My issues';
  const waiting = pending().length;
  app.innerHTML = `<div class="shell"><aside class="rail"><div class="brand"><div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div><strong>Rex Desk</strong></div>
    <div class="workspace-name">Your QA workspace</div><nav aria-label="Workspace">${pages.map(([page, glyph, label]) => `<button class="nav-button ${ui.page === page ? 'active' : ''}" data-page="${page}" ${ui.page === page ? 'aria-current="page"' : ''} title="${label}">${icon(glyph)}<span>${label}</span>${page === 'decisions' && waiting ? `<span class="count">${waiting}</span>` : ''}${page === 'setup' && remaining ? `<span class="count" title="${remaining} setup steps left">${remaining}</span>` : ''}</button>`).join('')}</nav>
    <div class="rail-bottom"><div class="local-state"><span class="dot"></span>Running on this computer</div><p>Files, keys, and work history<br>stay in your workspace.</p></div></aside>
    <main class="main" id="main" tabindex="-1"><header class="topbar"><div class="breadcrumbs"><span>Workspace</span>${icon('chevron')}<strong>${esc(pageName)}</strong></div><div class="topbar-right">${themeButton()}<span class="muted">${state.config.concurrency} parallel workers</span><span>${state.config.provider === 'claude' ? 'Claude Code' : 'Codex'} default</span><div class="avatar" title="${esc(state.config.name)}">${esc(state.config.name.slice(0, 2).toUpperCase())}</div></div></header>
    <div class="content">${ui.page === 'setup' ? renderSetup(steps) : ui.page === 'settings' ? renderSettings() : ui.page === 'decisions' ? renderDecisions() : ui.page === 'runs' ? renderRuns() : ui.page === 'evidence' ? renderEvidence() : renderInbox()}</div></main></div>`;
  if (ui.page === 'settings') for (const repository of ui.draft.repositories) previewBranch(repository.id);
  if (['setup', 'settings'].includes(ui.page) && !ui.agents && !ui.agentsLoading && !ui.agentsError) void loadAgents();
}
function heading(title, subtitle, controls = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${controls}</div></div>`;
}
function renderInbox() {
  const tasks = filteredTasks();
  const realTasks = ui.snapshot.tasks.filter(task => !task.demo);
  const active = ui.snapshot.runs.filter(run => ['running', 'waiting', 'starting', 'queued'].includes(run.state));
  const controls = `${button(`${icon('sync')} Sync tasks`, 'sync', ui.busy ? 'busy' : '', ui.busy ? 'disabled' : '')}${button(`${icon('agents')} Analyze & run`, 'launch-main', 'primary', !realTasks.length ? 'disabled' : '')}`;
  const demo = ui.snapshot.tasks.some(task => task.demo);
  const board = ui.page === 'board' || ui.view === 'board';
  return `${heading('Assigned to you', `${ui.snapshot.tasks.length} issues across your selected projects${active.length ? ` · ${active.length} active agent${active.length === 1 ? '' : 's'}` : ''}`, controls)}
    ${renderSetupBanner()}${demo ? `<div class="notice">${icon('question')}<span>Demo workspace. These issues are synthetic. Connect your projects to run real agents.</span>${button('Remove demo', 'remove-demo', 'small quiet')}</div>` : ''}
    ${ui.snapshot.sync.filter(item => item.error).map(item => `<div class="notice">${icon('question')}<span><strong>${esc(item.name)} sync failed.</strong> ${esc(item.error)}</span>${button('Settings', 'settings', 'small quiet')}</div>`).join('')}
    <div class="connection-strip">${['morningmate', 'flow'].map(source => `<span class="source-word">${sourceLogo(source)}<strong>${source === 'flow' ? 'Flow' : 'Morningmate'}</strong><span>${ui.snapshot.tasks.filter(task => task.source === source).length} issues</span></span>`).join('<span class="connection-divider"></span>')}
    <span class="muted">${ui.snapshot.sync.length ? `Synced ${relative(ui.snapshot.sync.map(item => item.at).sort().at(-1))}` : 'Connect your first project in Settings'}</span>
    <div class="view-switch" aria-label="Task view"><button data-action="view-list" class="${!board ? 'active' : ''}">${icon('inbox')}List</button><button data-action="view-board" class="${board ? 'active' : ''}">${icon('board')}Kanban</button></div></div>
    ${active.some(run => run.role === 'coordinator') ? `<div class="run-status-strip">${icon('agents')}<strong>Main agent is ${esc(labels[active.find(run => run.role === 'coordinator').state]?.toLowerCase())}</strong><span>It will categorize issues and dispatch workers.</span>${button('Open messages', 'open-main', 'small')}</div>` : ''}
    ${board ? `${toolbar()}<div id="task-board">${renderBoard(tasks)}</div>` : `<div class="workbench"><section class="task-pane" aria-label="Assigned issue list">${toolbar()}<div class="task-section-title"><span>${ui.checked.size ? `${ui.checked.size} selected` : 'Your project issues'}</span><span id="task-count">${tasks.length} issues</span></div><div id="task-list">${tasks.length ? tasks.map(renderTaskRow).join('') : emptyTasks()}</div><div class="task-footer"><span>${ui.checked.size ? 'Analyze uses selected issues' : 'Select issues to run a smaller batch'}</span>${ui.checked.size ? button('Clear selection', 'clear-selection', 'small quiet') : ''}</div></section>${renderTaskDetail()}</div>`}`;
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
function renderTaskRow(task) {
  const run = taskRun(task);
  return `<div class="task-row ${task.id === ui.selectedTask ? 'selected' : ''}"><input type="checkbox" aria-label="Select issue ${esc(task.externalId)}" data-select-task="${esc(task.id)}" ${ui.checked.has(task.id) ? 'checked' : ''}><button class="task-open" data-task="${esc(task.id)}"><span class="task-title">${esc(task.title)}</span><span class="task-meta">${sourceLogo(task.source)}<span class="mono">#${esc(task.taskNumber || task.externalId)}</span><span class="priority-mark ${esc(task.priority)}" title="${esc(task.priority)} priority"></span><span>${esc(task.category || task.fields?.[0]?.value || task.projectName)}</span>${renderTaskStates(task, run)}${task.demo ? '<span class="demo-label">Demo</span>' : ''}</span></button></div>`;
}
function renderTaskDetail() {
  const task = selectedTask();
  if (!task) return `<section class="detail-pane no-selection"><div class="empty">${icon('file')}<h2>Select an issue</h2><p>Its brief, agent messages, decisions, and proof will appear here.</p></div></section>`;
  const run = taskRun(task), link = safeUrl(task.url);
  const tabs = [['brief', 'Issue brief'], ['messages', `Messages${run && pending(run.id).length ? ` (${pending(run.id).length})` : ''}`], ['proof', 'Evidence']];
  return `<section class="detail-pane" aria-label="Selected issue"><div class="detail-top"><div class="detail-reference">${sourceLogo(task.source)}<span>${esc(task.sourceName)} · #${esc(task.taskNumber || task.externalId)}</span>${task.demo ? '<span class="demo-label">Demo</span>' : ''}${renderTaskStates(task, run)}</div><h2>${esc(task.title)}</h2>${renderIssueProperties(task, run)}</div>
    <div class="tabs" role="tablist" aria-label="Issue details">${tabs.map(([key, label]) => `<button class="tab ${ui.tab === key ? 'active' : ''}" role="tab" aria-selected="${ui.tab === key}" data-tab="${key}">${label}</button>`).join('')}</div>
    <div class="detail-body" role="tabpanel">${ui.tab === 'brief' ? `${renderIssueBrief(task)}${run ? renderRunPath(run) : ''}${run?.error ? `<p class="error-text">${esc(run.error)}</p>` : ''}` : ui.tab === 'messages' ? `<div id="messages">${run ? renderMessages(run.id) : '<p class="empty-small">Start an agent to begin the conversation.</p>'}</div>` : renderProof(run?.id)}</div>
    <div class="detail-bottom"><p>${run?.branch ? `${icon('branch')} <code>${esc(run.branch)}</code>` : link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Open original issue</a>` : 'One issue. One isolated worktree.'}</p><div class="actions">${run ? button('Open run', 'open-task-run', 'small') : button(`${icon('play')} Run agent`, 'launch-task', 'primary small', task.demo ? 'disabled title="Connect real tasks to run an agent"' : '')}</div></div></section>`;
}
function renderIssueProperties(task, run) {
  const rows = [['Status', task.statusName || task.status], ['Project', task.projectName], task.parentTitle && ['Parent task', task.parentTitle], task.section && ['Group', task.section],
    ['Reporter', task.reporter], ['Created', task.createdAt], task.dueDate && ['Due', task.dueDate], ...(task.fields || []).map(field => [field.name, field.value]),
    ['Category', task.category || 'Not analyzed yet'], run && ['Agent', providerName(run.provider)]].filter(row => row && row[1]);
  return `<dl class="issue-properties">${rows.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
}
function renderIssueImages(task, images, label) {
  const shown = images.map(item => ({ ...item, url: safeUrl(item.url), thumbnail: safeUrl(item.thumbnail) })).filter(item => item.url);
  if (!shown.length) return '';
  return `<div class="issue-images" aria-label="${esc(label)}">${shown.map(item => `<figure><a href="${esc(taskImage(task, item.url))}" target="_blank" rel="noopener" data-original="${esc(item.url)}"><img loading="lazy" decoding="async" src="${esc(taskImage(task, item.thumbnail || item.url))}" alt="${esc(item.name)}" ${item.width && item.height ? `width="${item.width}" height="${item.height}"` : ''}></a><figcaption>${esc(item.name)}${item.width ? ` · ${item.width}×${item.height}` : ''}</figcaption></figure>`).join('')}</div>`;
}
function renderIssueFiles(files) {
  const shown = files.map(item => ({ ...item, url: safeUrl(item.url) })).filter(item => item.url);
  return shown.length ? `<ul class="issue-files">${shown.map(item => `<li><a href="${esc(item.url)}" target="_blank" rel="noopener">${icon('file')}${esc(item.name)}</a></li>`).join('')}</ul>` : '';
}
function renderComment(task, comment) {
  return `<article class="comment${comment.system ? ' system' : ''}"><header><strong>${esc(comment.author || 'Tracker')}</strong><time>${esc(comment.at)}</time></header>${comment.text ? `<p>${esc(comment.text)}</p>` : ''}${renderIssueImages(task, comment.images || [], 'Comment images')}${renderIssueFiles(comment.files || [])}</article>`;
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
    ${files.length ? `<section class="issue-section"><h3>Attachments <span class="count-label">${files.length}</span></h3>${renderIssueFiles(files)}</section>` : ''}
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
  if (run?.state === 'ready_for_review') return 3;
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
function renderMessages(runId) {
  const messages = ui.messages.filter(message => !message.runId || message.runId === runId);
  return `${pending(runId).map(renderDecision).join('')}${messages.length ? messages.map(message => `<article class="message"><div class="message-label">${icon(message.kind === 'error' ? 'question' : 'agents')}<strong>${message.kind === 'error' ? 'Run needs attention' : message.kind === 'message' ? 'Agent' : 'Verification'}</strong><time>${time(message.createdAt)}</time></div><p>${esc(messageText(message))}</p>${message.kind === 'error' && /not signed in|not logged in|\/login/i.test(messageText(message)) ? button(`${icon('compass')} Fix agent sign-in`, 'setup', 'small') : ''}</article>`).join('') : `<p class="empty-small">Deliberate messages from this agent appear here. Detailed operations stay in the work journal.</p>`}`;
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
  return `<form class="decision ${esc(item.kind)}" data-interaction="${item.id}"><div class="decision-context"><button class="decision-run-link" type="button" data-run="${esc(item.runId)}">${icon('branch')}<span>${esc(originTitle)}</span></button><small>Run ${esc(item.runId.slice(0, 8))} · ${originRun?.provider === 'claude' ? 'Claude Code' : originRun?.provider === 'codex' ? 'Codex' : 'External AI'}</small></div><div class="decision-heading">${icon(item.kind === 'approval' ? 'check' : 'question')}<span>${item.kind === 'approval' ? 'Approval requested' : 'Your answer is needed'} · ${esc(ui.snapshot.runs.find(run => run.id === item.runId)?.provider || 'Agent')}</span></div><h3>${esc(item.title)}</h3>${details ? `<pre>${esc(typeof details === 'string' ? details : JSON.stringify(details, null, 2))}</pre>` : ''}${link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener">Open ${esc(new URL(link).hostname)}</a></p>` : ''}${fields}<div class="actions"><button class="button primary small" type="submit" name="decision" value="accept">${item.kind === 'approval' ? 'Approve once' : 'Send answer'}</button><button class="button small" type="submit" name="decision" value="decline" formnovalidate>Decline</button><button class="button quiet small" type="submit" name="decision" value="cancel" formnovalidate>Cancel request</button></div></form>`;
}
function renderQuestionField(key, property, required) {
  const extra = `name="${esc(key)}" aria-label="${esc(property.title || key)}" data-type="${esc(property.type)}" ${required ? 'required' : ''}`;
  let control;
  if (property.type === 'boolean') control = `<select ${extra}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select>`;
  else if (property.enum) control = `<select ${extra}><option value="">Choose…</option>${property.enum.map(value => `<option>${esc(value)}</option>`).join('')}<option value="__custom">Write another answer…</option></select><input name="${esc(key)}__custom" class="hidden custom-answer" placeholder="Your answer" aria-label="Custom answer">`;
  else control = `<input ${extra} type="${['number', 'integer'].includes(property.type) ? 'number' : 'text'}" ${property.type === 'number' ? 'step="any"' : ''} placeholder="Your answer">`;
  return `<label class="field"><span>${esc(property.title || key)}</span>${control}${property.description ? `<small>${esc(property.description)}</small>` : ''}</label>`;
}
function renderProof(runId) {
  if (!runId) return '<p class="empty-small">Recorded browser tests, screenshots, and reports appear here after an agent starts working.</p>';
  const run = ui.snapshot.runs.find(item => item.id === runId);
  const artifacts = ui.snapshot.artifacts.filter(item => item.runId === runId);
  return `${renderRisk(run)}${run?.checks ? `<div class="check-list">${[['testsPassed', 'Tests pass for the current code'], ['recordedVideo', 'Browser recording saved'], ['browserAssertionPassed', 'Browser assertion matches current code']].map(([key, title]) => `<div class="check-row ${run.checks[key] ? '' : 'missing'}">${icon(run.checks[key] ? 'check' : 'clock')}<span>${title}</span></div>`).join('')}</div>` : ''}
    ${artifacts.length ? artifacts.map(artifact => `<div class="proof-item"><a href="${artifactUrl(artifact)}" target="_blank" rel="noopener">${icon(artifact.type === 'video/webm' ? 'play' : 'file')}${esc(artifact.title)}</a><small>${relative(artifact.createdAt)}</small>${artifact.type === 'video/webm' ? `<video controls preload="metadata" src="${artifactUrl(artifact)}"></video>` : artifact.type === 'image/png' ? `<img src="${artifactUrl(artifact)}" alt="${esc(artifact.title)}" loading="lazy">` : ''}<a href="${artifactUrl(artifact)}?download" download>Download</a></div>`).join('') : '<p class="empty-small">No evidence yet. The agent must record its browser test and run verification.</p>'}`;
}
function renderDecisions() {
  const items = pending();
  return `${heading('Needs you', 'Answer a question or approve a specific action. Agents continue from your response.')}<div class="all-decisions">${items.length ? items.map(renderDecision).join('') : `<div class="panel"><div class="empty">${icon('check')}<h2>No decisions waiting</h2><p>Questions, tool permissions, and pull request approvals will appear here when an agent needs you.</p></div></div>`}</div>`;
}
function renderRuns() {
  const run = selectedRun();
  if (run) return renderRunDetail(run);
  return `${heading('Agent runs', 'Claude Code and Codex share the queue. Each issue keeps its own worktree and history.')}${ui.snapshot.runs.length ? `<div class="run-list">${ui.snapshot.runs.map(item => `<button class="run-row" data-run="${item.id}"><span><strong>${esc(item.title)}</strong><small>${item.provider === 'claude' ? 'Claude Code' : 'Codex'}${item.branch ? ` · ${esc(item.branch)}` : ' · Task analysis and dispatch'}</small></span><span>${tag(item.state)}</span><time class="muted">${relative(item.createdAt)}</time>${icon('chevron')}</button>`).join('')}</div>` : `<div class="panel"><div class="empty">${icon('agents')}<h2>No agent runs yet</h2><p>Sync your assigned issues, then use Analyze & run to start a main agent.</p>${button('Open my issues', 'inbox', 'primary')}</div></div>`}`;
}
function renderRunDetail(run) {
  const active = ['running', 'waiting', 'starting', 'queued'].includes(run.state);
  return `${button(`${icon('chevron')} All runs`, 'all-runs', 'quiet small')}${heading(esc(run.title), `${run.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${esc(run.role === 'coordinator' ? 'Main agent' : run.branch || 'Worktree preparing')}`, `${tag(run.state)}${active ? button('Stop run', 'stop-run', 'danger') : run.external ? '' : button('Continue / switch agent', 'resume-run')}${run.state === 'ready_for_review' ? button('Create draft PR', 'publish-run', 'primary') : ''}`)}
    ${run.error ? `<div class="notice">${icon('alert')}<span>${esc(run.error)}</span>${/not signed in|not logged in|\/login/i.test(run.error) ? button('Fix agent sign-in', 'setup', 'small') : ''}</div>` : ''}
    <div class="run-detail"><section class="panel"><h2>Agent messages</h2><div id="messages">${renderMessages(run.id)}</div><details class="activity-link" id="journal-details"><summary>Work journal · commands and tool activity</summary><div id="journal" class="journal">${renderJournal()}</div></details></section><aside class="panel"><h2>${run.role === 'coordinator' ? 'Dispatch' : 'Worktree & proof'}</h2>${run.worktree ? `<dl class="detail-properties"><dt>Base</dt><dd>${esc(run.baseBranch)}</dd><dt>PR target</dt><dd>${esc(run.targetBranch)}</dd><dt>Preview port</dt><dd>${run.port}</dd><dt>Folder</dt><dd><code>${esc(run.worktree)}</code></dd></dl>` : '<p class="muted">The main agent analyzes tasks and delegates work. It does not edit your source checkout.</p>'}${run.prUrl ? `<p><a href="${esc(safeUrl(run.prUrl))}" target="_blank" rel="noopener">Open draft pull request</a></p>` : ''}${renderProof(run.id)}</aside></div>`;
}
function journalText(event) {
  if (event.text || event.message || event.result) return event.text || event.message || event.result;
  const { sequence, kind, visible, createdAt, ...rest } = event;
  return JSON.stringify(rest.item || rest.content || rest, null, 2);
}
function renderJournal() {
  return ui.journal.length ? ui.journal.map(event => `<div class="journal-entry"><div><time>${esc(time(event.createdAt))}</time><span>${esc(event.kind.replaceAll('-', ' '))}</span></div><pre>${esc(journalText(event))}</pre></div>`).join('') : '<p class="empty-small">Open the journal to load recorded operations.</p>';
}
function renderEvidence() {
  const runs = ui.snapshot.runs.filter(run => ui.snapshot.artifacts.some(item => item.runId === run.id));
  return `${heading('Evidence', 'Review recordings and actual test output before publishing a fix.')}<div class="evidence-grid">${runs.length ? runs.map(run => `<section class="evidence-card"><h3>${esc(run.title)}</h3>${tag(run.state)}${renderProof(run.id)}${button('Open run', 'open-evidence-run', 'small', `data-id="${run.id}"`)}</section>`).join('') : `<div class="panel"><div class="empty">${icon('play')}<h2>Proof belongs to the fix</h2><p>Browser recordings, screenshots, Playwright traces, and portable reports will appear after an agent verifies an issue.</p></div></div>`}</div>`;
}

function inputField(label, name, value, hint = '', type = 'text', placeholder = '') {
  const hintId = `hint-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return `<label class="field"><span>${label}</span><input name="${esc(name)}" aria-label="${esc(label)}" ${hint ? `aria-describedby="${hintId}"` : ''} value="${esc(value)}" type="${type}" placeholder="${esc(placeholder)}" ${type === 'password' ? 'autocomplete="new-password"' : ''}>${hint ? `<small id="${hintId}">${hint}</small>` : ''}</label>`;
}
function providerSelect(name, value) { return `<select name="${name}"><option value="claude" ${value === 'claude' ? 'selected' : ''}>Claude Code</option><option value="codex" ${value === 'codex' ? 'selected' : ''}>Codex</option></select>`; }
function renderSettings() {
  const config = ui.draft || ui.snapshot.config;
  return `${heading('Settings', 'Connect your projects once. Change accounts, keys, repositories, and agent defaults here.')}
    <div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections"><a href="#connections">Connections</a><a href="#repositories">Repositories</a><a href="#agents">Agents & workflow</a><a href="#agent-sign-in">Agent sign-in</a><a href="#cloud-backup">Cloud backup</a><a href="#appearance">Appearance</a><a href="#ai-connection">AI connection</a></nav>
    <form id="settings-form"><section class="settings-section" id="connections"><h2>Flow & Morningmate</h2><p>Only issues assigned to your account in these project IDs are imported. API keys stay encrypted on this computer.</p>${config.sources.map((source, index) => renderSourceSettings(source, index)).join('')}${button(`${icon('plus')} Add connection`, 'add-source', '', 'type="button"')}</section>
    <section class="settings-section" id="repositories"><h2>Source repositories</h2><p>Each worker uses a new worktree. Commands run there; your current checkout stays where it is.</p>${config.repositories.map((repository, index) => renderRepositorySettings(repository, index)).join('')}${button(`${icon('plus')} Add repository`, 'add-repository', '', 'type="button"')}</section>
    <section class="settings-section" id="agents"><h2>Agents & workflow</h2><p>Use your installed Claude Code and Codex sign-ins. You can override the provider for each run.</p><div class="settings-card"><div class="field-row">${inputField('Your name', 'name', config.name)}<label class="field"><span>Default agent</span>${providerSelect('provider', config.provider)}</label></div><div class="field-row">${inputField('Parallel workers', 'concurrency', config.concurrency, 'Main agent runs separately. Start with 1 or 2 workers.', 'number')}${inputField('Sync interval (minutes)', 'syncMinutes', config.syncMinutes, 'Set 0 to sync manually.', 'number')}</div>${inputField('Branch prefix', 'branchPrefix', config.branchPrefix, 'For example: temp/rex. Git branch names cannot begin with /.')}<div class="field-row">${inputField('Claude model (optional)', 'model.claude', config.models?.claude || '', 'Leave blank to use the installed provider’s default.')}${inputField('Codex model (optional)', 'model.codex', config.models?.codex || '', 'Use a model available to your signed-in account.')}</div><label class="field check"><input type="checkbox" name="requireVideo" ${config.requireVideo ? 'checked' : ''}><span>Require a browser recording and passing browser assertion before review</span></label><label class="field check"><input type="checkbox" name="reportToOrbit" ${config.reportToOrbit ? 'checked' : ''}><span>Let verified agents send their final report through my installed Orbit MCP</span></label><label class="field check"><input type="checkbox" name="autoPrLowRisk" ${config.autoPrLowRisk ? 'checked' : ''}><span>Automatically push and create a draft PR for verified low-risk fixes (risk 1–2/10)</span></label><small class="muted">Automatic PRs require a small style, markup, documentation, or test-only change, passing tests, current evidence, and no human-review flag. Application code, sensitive changes, and higher scores require review. Tracker changes still require approval. Nothing is merged automatically.</small></div>${button('Check installed tools', 'diagnostics', '', 'type="button"')}<div id="diagnostics"></div></section>
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
    <label class="field check"><input type="checkbox" name="${prefix}.clearKey"><span>Delete the saved key</span></label><div class="actions connection-actions">${button(connectingSources.has(source.id) ? 'Loading projects & people…' : 'Connect & load projects / people', 'connect-source', '', `type="button" data-id="${source.id}" ${connectingSources.has(source.id) ? 'disabled' : ''}`)}</div><div data-source-catalog="${source.id}">${renderSourceCatalog(source)}</div><label class="field"><span>Task status to sync</span><select name="${prefix}.statusFilter">${[['active', 'Request + In progress'], ['unfinished', 'All unfinished (includes review and hold)'], ['all', 'All statuses']].map(([value, label]) => `<option value="${value}" ${(source.statusFilter || 'active') === value ? 'selected' : ''}>${label}</option>`).join('')}</select><small>Completed tasks are excluded by default.</small></label><details class="manual-ids"><summary>Enter IDs manually</summary><div class="field-row">${inputField('Project IDs', `${prefix}.projectIds`, source.projectIds.join(', '), 'Normally filled by selecting projects above.')}${inputField('Your user ID (optional)', `${prefix}.userId`, source.userId, 'Normally filled by selecting an employee. Blank uses the API account.')}</div></details><label class="field"><span>Source repository</span><select name="${prefix}.repositoryId"><option value="">Choose a repository…</option>${ui.draft.repositories.map(repository => `<option value="${repository.id}" ${repository.id === source.repositoryId ? 'selected' : ''}>${esc(repository.name || repository.path)}</option>`).join('')}</select><small>New issues from this connection use this repository by default.</small></label><details><summary class="muted">Tracker status mapping</summary><p class="muted">Optional API status values. Unmapped phases leave tracker status unchanged.</p><div class="field-row three">${inputField('Working', `${prefix}.status.working`, source.statusMap?.working || '', '', 'text', 'progress')}${inputField('Review', `${prefix}.status.review`, source.statusMap?.review || '', '', 'text', 'feedback')}${inputField('Done', `${prefix}.status.done`, source.statusMap?.done || '', '', 'text', 'complete')}</div></details></div>`;
}
function sourceDirectory(sourceId) { return ui.snapshot.directories?.find(item => item.sourceId === sourceId); }
function renderSourceCatalog(source) {
  const directory = sourceDirectory(source.id);
  const agents = `<div class="agent-lookup"><span>Find choices through your installed service MCP:</span>${button('Find with Claude Code', 'source-agent', 'small quiet', `type="button" data-id="${source.id}" data-provider="claude"`)}${button('Find with Codex', 'source-agent', 'small quiet', `type="button" data-id="${source.id}" data-provider="codex"`)}</div>`;
  if (!directory) return `<p class="discovery-status muted">Connect to load project names and employee accounts. Choose them before syncing.</p>${agents}`;
  const selected = new Set(source.projectIds), employeeId = source.userId || '', employees = directory.employees;
  return `<div class="source-catalog"><p class="discovery-status muted">${directory.origin === 'mcp' ? 'Agent found these choices. Review them before saving.' : 'Connected. Select projects and the employee whose assigned tasks you want.'}</p>${Object.entries(directory.errors || {}).map(([kind, error]) => `<p class="error-text">${esc(kind)}: ${esc(error)}</p>`).join('')}<fieldset class="project-picker"><legend>Projects to sync</legend>${directory.projects.length ? `<input type="search" class="catalog-search" aria-label="Search projects for ${esc(source.name)}" placeholder="Search projects" data-catalog-search="${source.id}"><div class="project-options">${directory.projects.map(project => `<label class="project-choice"><input type="checkbox" data-source-project="${source.id}" value="${esc(project.id)}" ${selected.has(project.id) ? 'checked' : ''}><span>${esc(project.name)}<small>${esc(project.id)}</small></span></label>`).join('')}</div>` : '<p class="muted">No projects returned. Check access, reload, or use the MCP agent below.</p>'}</fieldset><div class="field"><span>Assigned employee</span>${picker({ value: employeeId, label: `Assigned employee for ${source.name}`, placeholder: 'Search name, email, or team', attrs: `data-source-employee="${source.id}"`, empty: 'No colleague matches. Reload the directory or use the API account.',
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
  return `<section class="risk-assessment" aria-label="Code risk assessment"><div class="risk-heading"><h3>Estimated code risk</h3><span class="tag ${risk.score <= 2 ? 'finished' : risk.score <= 5 ? 'waiting' : 'failed'}">${risk.score}/10 · ${esc(risk.level)}</span></div><strong>${risk.requiresHumanReview ? 'Review before creating a PR' : 'Low-risk draft PR eligible'}</strong><p>${esc(risk.reason)}</p><small>${risk.files.length} changed files · ${risk.changedLines} added/removed lines${risk.agentScore ? ` · Agent score ${risk.agentScore}/10` : ''}</small>${risk.safeguards.length || risk.factors.length ? `<details><summary>Review reasons</summary><ul>${[...risk.safeguards, ...risk.factors].map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></details>` : ''}<small>${risk.requiresHumanReview ? 'Review the diff before approving the draft PR.' : ui.snapshot.config.autoPrLowRisk ? 'Automatic draft PRs are enabled. Tests and evidence must match the current code.' : 'Automatic draft PRs are off. Create a draft PR after reviewing the evidence.'}</small></section>`;
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
function renderRepositorySettings(repository, index) {
  const prefix = `repository.${repository.id}`;
  return `<div class="settings-card" data-repository="${repository.id}"><div class="settings-card-header"><strong>Repository ${index + 1}</strong>${button(`${icon('close')} Remove`, 'remove-repository', 'quiet small', `type="button" data-id="${repository.id}"`)}</div><div class="field-row">${inputField('Repository name', `${prefix}.name`, repository.name)}${inputField('Local repository path', `${prefix}.path`, repository.path, '', 'text', 'F:\\your-project')}</div><div class="actions repository-actions">${button('Choose folder', 'browse-repository', '', `type="button" data-id="${repository.id}"`)}${button('Inspect repository', 'inspect-repository', '', `type="button" data-id="${repository.id}"`)}</div><div data-discovery="${repository.id}">${repositoryDiscovery(repository)}</div><div data-branches="${repository.id}">${repositoryBranches(repository)}</div>${inputField('AI branch pattern', `${prefix}.branchPattern`, repository.branchPattern || '', 'Use {prefix}, {source}, {taskId}, {title}, and {runId}. Keep {runId} for unique concurrent branches.', 'text', '{prefix}/{source}-{taskId}/{title}-{runId}')}<div class="branch-preview"><span>Example branch</span><code data-branch-preview="${repository.id}">${esc(repository.branchPattern ? 'Loading preview…' : `${ui.draft.branchPrefix}/morningmate-4821/fix-blank-preview-a1b2c3`)}</code></div>${renderFlowSettings(repository)}${renderElectronSettings(repository)}${inputField('Worktree setup command', `${prefix}.setupCommand`, repository.setupCommand, 'Optional. Install dependencies in the worktree, for example npm ci.')}${inputField('Dev server command', `${prefix}.devCommand`, repository.devCommand, repository.flowRuntime ? 'Flow Tomcat uses its isolated runtime below. This command is used only for a custom preview.' : 'Required for browser tests. Include {port}; PORT is also set in the environment.', 'text', 'npm run dev -- --port {port}')}${inputField('Verification command', `${prefix}.testCommand`, repository.testCommand, 'Set a real test command for this branch. An empty command cannot pass verification.', 'text', 'npm test')}${inputField('Initial browser path', `${prefix}.browserPath`, repository.browserPath || '/', 'Path opened on the isolated preview server.', 'text', '/')}</div>`;
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
  draft.agentProfiles = ui.snapshot.config.agentProfiles; draft.tourDismissed = ui.snapshot.config.tourDismissed;
  draft.sources = draft.sources.map(source => {
    const prefix = `source.${source.id}`, result = { ...source };
    for (const key of ['name', 'type', 'baseUrl', 'apiKey', 'userId', 'repositoryId', 'statusFilter']) result[key] = String(data.get(`${prefix}.${key}`) || '');
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
      summary: keyed.length ? `${keyed.reduce((sum, source) => sum + source.projectIds.length, 0)} projects selected · ${keyed.every(source => source.userId) ? 'assignee chosen' : 'API account is the assignee'}` : 'Available after connecting a tracker.' },
    { id: 'repository', title: 'Add the source repository', done: repositories.length > 0 && repositories.every(repository => repository.path && repository.baseBranch) && sources.every(source => source.repositoryId),
      summary: repositories.length ? repositories.map(repository => `${repository.name} · ${repository.baseBranch || 'no base branch'}`).join(', ') : 'Choose the local Git folder. Branches and GitHub account load automatically.' },
    { id: 'commands', title: 'Set preview and test commands', done: repositories.length > 0 && repositories.every(repository => repository.testCommand && (repository.devCommand || repository.flowRuntime || repository.electronRuntime)),
      summary: repositories.length ? repositories.map(repository => `${repository.name}: ${repository.testCommand ? 'tests set' : 'no test command'}, ${repository.flowRuntime ? 'Tomcat preset' : repository.electronRuntime ? 'Electron preset' : repository.devCommand ? 'preview set' : 'no preview'}`).join('; ') : 'Workers need a real test command and a preview command for recorded proof.' },
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
  return `${heading('Set up Rex Desk', 'Each step checks your real settings. Finish the required ones once; change anything later in Settings.', `${renderSetupProgress(steps)}${button(`${icon('sync')} Recheck`, 'recheck-setup', 'small', ui.agentsLoading ? 'disabled' : '')}`)}
    <ol class="setup-steps">${steps.map((step, index) => `<li class="setup-step ${step.done ? 'done' : ''} ${open === step.id ? 'open' : ''}" data-step="${step.id}"><button type="button" class="setup-step-header" data-action="open-step" data-step="${step.id}" aria-expanded="${open === step.id}"><span class="step-mark" aria-hidden="true">${step.done ? icon('check') : `<span>${index + 1}</span>`}</span><span class="step-text"><strong>${esc(step.title)}${step.optional ? ' <em>Optional</em>' : ''}</strong><small>${esc(step.summary)}</small></span>${icon('chevron')}</button>${open === step.id ? `<div class="setup-step-body">${renderSetupBody(step)}</div>` : ''}</li>`).join('')}</ol>
    <div class="setup-footer"><span class="muted">${ui.snapshot.config.tourDismissed ? 'The issue list hides setup reminders, except agent sign-in problems.' : 'The issue list shows the next step until required setup is complete.'}</span>${button(ui.snapshot.config.tourDismissed ? 'Show reminders' : 'Hide reminders', 'toggle-tour', 'small quiet')}</div>`;
}
function settingsLink(anchor, label) { return button(label, 'settings-anchor', 'small', `type="button" data-anchor="${anchor}"`); }
function renderSetupBody(step) {
  const config = ui.snapshot.config;
  if (step.id === 'agent') return `<p>Agents run with the CLI profile folder selected here. Pick a profile that shows <strong>Signed in</strong>. The choice is saved immediately; no test turn is started.</p><div data-agent-profiles>${renderAgentProfiles()}</div>`;
  if (step.id === 'connection') return `<p>Add your Flow or Morningmate user API key. Rex Desk loads your projects and colleagues from it, so you never type IDs.</p>${config.sources.length ? `<ul class="setup-facts">${config.sources.map(source => `<li>${sourceLogo(source.type)}<strong>${esc(source.name)}</strong><span>${source.hasKey ? 'API key saved' : 'API key missing'}</span></li>`).join('')}</ul>` : ''}<div class="actions">${settingsLink('connections', config.sources.length ? 'Open connections' : 'Add a connection')}</div>`;
  if (step.id === 'projects') return `<p>Choose the projects to watch and whose assigned tasks to import. Only Request and In progress tasks sync by default.</p>${config.sources.length ? `<ul class="setup-facts">${config.sources.map(source => `<li>${sourceLogo(source.type)}<strong>${esc(source.name)}</strong><span>${source.projectIds.length} project${source.projectIds.length === 1 ? '' : 's'} · ${source.userId ? esc(source.userId) : 'API account'} · ${({ active: 'Request + In progress', unfinished: 'All unfinished', all: 'All statuses' })[source.statusFilter || 'active']}</span></li>`).join('')}</ul>` : ''}<div class="actions">${settingsLink('connections', 'Choose projects')}</div>`;
  if (step.id === 'repository') return `<p>Point Rex Desk at the local checkout. Each worker branches from it into its own worktree; your checkout is never switched.</p>${config.repositories.length ? `<ul class="setup-facts">${config.repositories.map(repository => `<li>${icon('branch')}<strong>${esc(repository.name)}</strong><span class="mono">${esc(repository.path)} · from ${esc(repository.baseBranch || '—')} · PR to ${esc(repository.targetBranch || '—')}</span></li>`).join('')}${config.sources.filter(source => !source.repositoryId).map(source => `<li>${icon('alert')}<strong>${esc(source.name)}</strong><span>Choose which repository its issues use.</span></li>`).join('')}</ul>` : ''}<div class="actions">${settingsLink('repositories', config.repositories.length ? 'Open repositories' : 'Add a repository')}</div>`;
  if (step.id === 'commands') return `<p>Verification runs the real test command in each worktree. Recorded browser proof needs a preview command that honors <code>{port}</code>, or the isolated Flow / Morningmate Tomcat preset.</p>${config.repositories.length ? `<ul class="setup-facts">${config.repositories.map(repository => `<li>${icon('terminal')}<strong>${esc(repository.name)}</strong><span class="mono">test: ${esc(repository.testCommand || 'not set')} · preview: ${esc(repository.flowRuntime ? 'Flow Tomcat preset' : repository.electronRuntime ? 'Isolated Electron app' : repository.devCommand || 'not set')}</span></li>`).join('')}</ul>` : ''}<div class="actions">${settingsLink('repositories', 'Set commands')}</div>`;
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
  if (list) list.innerHTML = tasks.length ? tasks.map(renderTaskRow).join('') : emptyTasks();
  if (board) board.innerHTML = renderBoard(tasks);
  if (count) count.textContent = `${tasks.length} issues`;
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
  const run = ui.page === 'runs' ? selectedRun() : selectedTask() ? taskRun(selectedTask()) : null;
  if (!run) return;
  const messages = await api(`/runs/${run.id}/messages`); ui.messages = messages.map(message => ({ ...message, runId: run.id }));
  const target = document.querySelector('#messages'); if (target) target.innerHTML = renderMessages(run.id);
}
function runtimeProfileField(repository) {
  if (!repository?.flowRuntime) return '';
  return `<label class="field"><span>Runtime profile</span><select name="runtimeProfile">${runtimeProfiles(repository).map(profile => `<option value="${esc(profile.id)}" ${profile.id === repository.flowRuntime.defaultProfile ? 'selected' : ''}>${esc(profile.name)} · ${esc(profile.overrides?.default_region || '')}</option>`).join('')}</select><small>Starts this branch as Flow or Morningmate in its own Tomcat. Change product profiles in Settings.</small></label>`;
}
async function launchDialog({ role = 'worker', resume = false } = {}) {
  const task = selectedTask(), run = selectedRun();
  const repositoryId = task?.repositoryId || ui.snapshot.config.repositories[0]?.id;
  const repository = ui.snapshot.config.repositories.find(item => item.id === (resume ? run.repositoryId : repositoryId));
  const count = ui.checked.size || ui.snapshot.tasks.filter(item => !item.demo).length;
  const dialog = document.querySelector('#launch-dialog');
  const title = resume ? 'Continue this run' : role === 'coordinator' ? 'Start the main agent' : 'Start an issue agent';
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="launch-title">${title}</h2>${button(icon('close'), 'close-dialog', 'quiet icon-only', 'aria-label="Close dialog"')}</div><p>${resume ? 'Continue with the same provider, or switch providers and pass the recorded issue context into a new session.' : role === 'coordinator' ? `Analyze ${count} assigned issue${count === 1 ? '' : 's'}, categorize them, and dispatch independent workers.` : esc(task?.title)}</p><form id="launch-form" data-role="${role}" data-resume="${resume}"><label class="field"><span>Agent</span>${providerSelect('provider', resume ? run.provider : ui.snapshot.config.provider)}</label>${role === 'worker' && !resume ? `<label class="field"><span>Source repository</span><select name="repositoryId" required><option value="">Choose a repository…</option>${ui.snapshot.config.repositories.map(item => `<option value="${item.id}" ${item.id === repositoryId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>` : ''}<div id="runtime-profile-field">${role === 'worker' && !resume ? runtimeProfileField(repository) : ''}</div><div class="field-row">${inputField('Start from branch', 'baseBranch', resume ? run.baseBranch : role === 'coordinator' ? '' : repository?.baseBranch || '', role === 'coordinator' ? 'Blank uses each repository’s default.' : '', 'text', 'Repository default')}${inputField('PR target branch', 'targetBranch', resume ? run.targetBranch : role === 'coordinator' ? '' : repository?.targetBranch || '', 'You can change this before publishing.', 'text', 'Repository default')}</div><datalist id="branches"></datalist><label class="field"><span>${resume ? 'Follow-up instruction' : 'Additional instruction (optional)'}</span><textarea name="prompt" placeholder="For example: investigate critical issues first, and keep related fixes sequential."></textarea></label><div class="form-error" id="launch-error" role="alert"></div><div class="actions">${button('Cancel', 'close-dialog', '', 'type="button"')}<button class="button primary" type="submit">${resume ? 'Continue run' : role === 'coordinator' ? 'Analyze & run' : 'Start agent'}</button></div></form>`;
  dialog.querySelectorAll('input[name$=Branch]').forEach(element => element.setAttribute('list', 'branches'));
  if (resume) { dialog.querySelector('input[name=baseBranch]').readOnly = true; dialog.querySelector('input[name=baseBranch]').title = 'This worktree keeps its original base branch.'; }
  dialog.showModal();
  if (repository) await loadBranches(repository.id);
}
async function loadBranches(repositoryId) {
  await action(async () => { const { branches } = await api(`/repositories/${repositoryId}/branches`); const list = document.querySelector('#branches'); if (list) list.innerHTML = branches.map(branch => `<option value="${esc(branch.replace(/^origin\//, ''))}"></option>`).join(''); });
}
function publishDialog() {
  const run = selectedRun(), dialog = document.querySelector('#publish-dialog');
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="publish-title">Create a draft pull request</h2>${button(icon('close'), 'close-dialog', 'quiet icon-only', 'aria-label="Close dialog"')}</div><p>This pushes <code>${esc(run.branch)}</code> to origin and opens a draft GitHub PR. Review the evidence first.</p><form id="publish-form">${inputField('PR title', 'title', run.title)}${inputField('Target branch', 'targetBranch', run.targetBranch)}<label class="field"><span>PR description</span><textarea name="body" rows="7">${esc(run.summary || '')}</textarea></label><div class="form-error" id="publish-error" role="alert"></div><div class="actions">${button('Cancel', 'close-dialog', '', 'type="button"')}<button class="button primary" type="submit">Push & create draft PR</button></div></form>`;
  dialog.showModal();
}

document.addEventListener('click', event => {
  const target = event.target.closest('button,[data-task],[data-run]'); if (!target) return;
  if (target.dataset.page) { ui.selectedRun = ''; navigate(target.dataset.page); return; }
  if (target.dataset.task) {
    ui.selectedTask = target.dataset.task; ui.tab = 'brief'; ui.messages = [];
    if (target.dataset.fromBoard) { ui.page = 'inbox'; ui.view = 'list'; }
    render(); if (innerWidth <= 700) document.querySelector('.detail-pane')?.scrollIntoView({ block: 'start' }); void loadMessages(); return;
  }
  if (target.dataset.run) { navigate('runs', { runId: target.dataset.run }); return; }
  const name = target.dataset.action; if (!name) return;
  if (name === 'retry-task-detail') { taskErrors.delete(ui.selectedTask); render(); void loadTaskDetail(); return; }
  if (name === 'refresh-task-detail') {
    const taskId = ui.selectedTask; loadingTasks.add(taskId); target.disabled = true;
    void action(async () => {
      try { const detail = await api(`/tasks/${encodeURIComponent(taskId)}?refresh`); ui.snapshot.tasks = ui.snapshot.tasks.map(item => item.id === taskId ? detail : item); toast('Issue reloaded from the tracker.'); }
      finally { loadingTasks.delete(taskId); if (ui.page === 'inbox') render(); }
    }); return;
  }
  if (name === 'setup') { ui.selectedRun = ''; ui.setupOpen = ''; navigate('setup'); return; }
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
  if (name === 'settings-anchor') { ui.selectedRun = ''; navigate('settings'); requestAnimationFrame(() => document.getElementById(target.dataset.anchor)?.scrollIntoView({ block: 'start' })); return; }
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
  if (name === 'settings' || name === 'inbox') { ui.selectedRun = ''; navigate(name); return; }
  if (name === 'view-list') { ui.view = 'list'; ui.page = 'inbox'; render(); void loadMessages(); return; }
  if (name === 'view-board') { ui.view = 'board'; render(); return; }
  if (name === 'clear-selection') { ui.checked.clear(); render(); return; }
  if (name === 'close-dialog') { target.closest('dialog').close(); return; }
  if (name === 'launch-main') { void launchDialog({ role: 'coordinator' }); return; }
  if (name === 'launch-task') { void launchDialog(); return; }
  if (name === 'resume-run') { void launchDialog({ role: selectedRun().role, resume: true }); return; }
  if (name === 'publish-run') { publishDialog(); return; }
  if (name === 'all-runs') { ui.selectedRun = ''; render(); return; }
  if (name === 'open-task-run') { navigate('runs', { runId: taskRun(selectedTask()).id }); return; }
  if (name === 'open-evidence-run') { navigate('runs', { runId: target.dataset.id }); return; }
  if (name === 'open-main') { navigate('runs', { runId: ui.snapshot.runs.find(run => run.role === 'coordinator').id }); return; }
  if (name === 'add-source') {
    readSettings(); ui.draft.sources.push({ id: crypto.randomUUID(), name: 'Morningmate', type: 'morningmate', baseUrl: 'https://api.morningmate.com', projectIds: [], userId: '', repositoryId: '', statusMap: {} }); render(); return;
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
  const tab = event.target.closest('[data-tab]'); if (!tab) return; ui.tab = tab.dataset.tab; render(); void loadMessages();
});
document.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.closest('.issue-images')) return;
  const link = image.closest('a'), figure = image.closest('figure');
  figure.classList.add('unavailable');
  image.replaceWith(Object.assign(document.createElement('span'), { className: 'image-missing', textContent: 'Preview unavailable' }));
  if (link?.dataset.original) { link.href = link.dataset.original; link.title = 'Open the original tracker image'; }
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
  if (target.dataset.selectTask) { if (target.checked) ui.checked.add(target.dataset.selectTask); else ui.checked.delete(target.dataset.selectTask); render(); return; }
  if (target.id === 'source-filter' || target.id === 'category-filter') { ui[target.id === 'source-filter' ? 'source' : 'category'] = target.value; if (!renderTaskResults()) render(); return; }
  if (target.closest('#settings-form') && target.name.endsWith('.type')) {
    const card = target.closest('.settings-card'); const base = card.querySelector('input[name$=".baseUrl"]');
    if (['https://api.morningmate.com', 'https://api.flow.team'].includes(base.value)) base.value = target.value === 'flow' ? 'https://api.flow.team' : 'https://api.morningmate.com';
  }
  if (target.closest('#launch-form') && target.name === 'repositoryId') {
    const repository = ui.snapshot.config.repositories.find(item => item.id === target.value);
    const runtimeField = document.querySelector('#runtime-profile-field'); if (runtimeField) runtimeField.innerHTML = runtimeProfileField(repository);
    if (repository) { const form = target.form; form.elements.baseBranch.value = repository.baseBranch; form.elements.targetBranch.value = repository.targetBranch; void loadBranches(repository.id); }
  }
  if (target.closest('.decision') && target.tagName === 'SELECT' && target.value === '__custom') target.parentElement.querySelector('.custom-answer')?.classList.remove('hidden');
});
document.addEventListener('toggle', event => {
  if (event.target.id === 'journal-details' && event.target.open) void action(async () => {
    ui.journal = await api(`/runs/${ui.selectedRun}/journal`); const target = document.querySelector('#journal'); if (target) target.innerHTML = renderJournal();
  });
}, true);
document.addEventListener('submit', event => {
  const form = event.target;
  if (!['settings-form', 'launch-form', 'publish-form'].includes(form.id) && !form.dataset.interaction) return;
  event.preventDefault();
  void action(async () => {
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
        else if (form.dataset.role === 'coordinator') run = await api('/coordinator', { method: 'POST', data: { ...input, taskIds: [...ui.checked].filter(taskId => ui.snapshot.tasks.some(task => task.id === taskId && !task.demo)) } });
        else run = await api('/runs', { method: 'POST', data: { ...input, taskId: ui.selectedTask, instructions: input.prompt } });
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
      await api(`/interactions/${form.dataset.interaction}/answer`, { method: 'POST', data: { action: decision, content } });
      await refresh({ force: true }); toast(decision === 'accept' ? 'Response sent to the agent.' : 'Request declined or cancelled.');
    }
  });
});

try {
  await refresh({ force: true });
  if (!ui.snapshot.config.sources.length && !ui.snapshot.tasks.length) navigate('setup');
  void loadAgents().then(() => {
    const agent = selectedProfile(ui.snapshot.config.provider);
    if (agent && !agent.loggedIn && ui.page === 'inbox' && !ui.autoTour) { ui.autoTour = true; ui.setupOpen = 'agent'; navigate('setup'); toast(`${providerName(ui.snapshot.config.provider)} is not signed in for the selected profile. Choose a signed-in profile to run agents.`, true); }
  });
  const stream = new EventSource('/api/events');
  let timer;
  stream.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(() => void refresh().catch(error => toast(error.message, true)), 400); });
  stream.onerror = () => { document.querySelector('.local-state')?.setAttribute('title', 'Reconnecting to the local server…'); };
} catch (error) {
  app.innerHTML = `<div class="empty"><h1>Workspace unavailable</h1><p>${esc(error.message)}</p><p>Start Rex Desk with <code>npm start</code>, then reload this page.</p></div>`;
}

const app = document.querySelector('#app');
const repositoryInfo = new Map(), inspecting = new Map(), previewTimers = new Map(), connectingSources = new Set();
const loadingTasks = new Set(), taskErrors = new Map();
const ui = { page: 'inbox', view: 'list', selectedTask: '', selectedRun: '', tab: 'brief', checked: new Set(), search: '', source: '', category: '', snapshot: null, messages: [], journal: [], draft: null, busy: false };
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
    && (!ui.search || `${task.title} ${task.externalId} ${task.projectName}`.toLowerCase().includes(ui.search.toLowerCase())));
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
}
function render() {
  const state = ui.snapshot;
  if (!state) return;
  const pages = [['inbox', 'inbox', 'My issues'], ['board', 'board', 'Kanban'], ['decisions', 'question', 'Needs you'], ['runs', 'agents', 'Agent runs'], ['evidence', 'play', 'Evidence'], ['settings', 'settings', 'Settings']];
  const pageName = pages.find(([page]) => page === ui.page)?.[2] || 'My issues';
  const waiting = pending().length;
  app.innerHTML = `<div class="shell"><aside class="rail"><div class="brand"><div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div><strong>Rex Desk</strong></div>
    <div class="workspace-name">Your QA workspace</div><nav aria-label="Workspace">${pages.map(([page, glyph, label]) => `<button class="nav-button ${ui.page === page ? 'active' : ''}" data-page="${page}" ${ui.page === page ? 'aria-current="page"' : ''} title="${label}">${icon(glyph)}<span>${label}</span>${page === 'decisions' && waiting ? `<span class="count">${waiting}</span>` : ''}</button>`).join('')}</nav>
    <div class="rail-bottom"><div class="local-state"><span class="dot"></span>Running on this computer</div><p>Files, keys, and work history<br>stay in your workspace.</p></div></aside>
    <main class="main" id="main" tabindex="-1"><header class="topbar"><div class="breadcrumbs"><span>Workspace</span>${icon('chevron')}<strong>${esc(pageName)}</strong></div><div class="topbar-right">${themeButton()}<span class="muted">${state.config.concurrency} parallel workers</span><span>${state.config.provider === 'claude' ? 'Claude Code' : 'Codex'} default</span><div class="avatar" title="${esc(state.config.name)}">${esc(state.config.name.slice(0, 2).toUpperCase())}</div></div></header>
    <div class="content">${ui.page === 'settings' ? renderSettings() : ui.page === 'decisions' ? renderDecisions() : ui.page === 'runs' ? renderRuns() : ui.page === 'evidence' ? renderEvidence() : renderInbox()}</div></main></div>`;
  if (ui.page === 'settings') for (const repository of ui.draft.repositories) previewBranch(repository.id);
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
    ${demo ? `<div class="notice">${icon('question')}<span>Demo workspace. These issues are synthetic. Connect your projects to run real agents.</span>${button('Remove demo', 'remove-demo', 'small quiet')}</div>` : ''}
    ${ui.snapshot.sync.filter(item => item.error).map(item => `<div class="notice">${icon('question')}<span><strong>${esc(item.name)} sync failed.</strong> ${esc(item.error)}</span>${button('Settings', 'settings', 'small quiet')}</div>`).join('')}
    <div class="connection-strip">${['morningmate', 'flow'].map(source => `<span class="source-word">${sourceLogo(source)}<strong>${source === 'flow' ? 'Flow' : 'Morningmate'}</strong><span>${ui.snapshot.tasks.filter(task => task.source === source).length} issues</span></span>`).join('<span class="connection-divider"></span>')}
    <span class="muted">${ui.snapshot.sync.length ? `Synced ${relative(ui.snapshot.sync.map(item => item.at).sort().at(-1))}` : 'Connect your first project in Settings'}</span>
    <div class="view-switch" aria-label="Task view"><button data-action="view-list" class="${!board ? 'active' : ''}">${icon('inbox')}List</button><button data-action="view-board" class="${board ? 'active' : ''}">${icon('board')}Kanban</button></div></div>
    ${active.some(run => run.role === 'coordinator') ? `<div class="run-status-strip">${icon('agents')}<strong>Main agent is ${esc(labels[active.find(run => run.role === 'coordinator').state]?.toLowerCase())}</strong><span>It will categorize issues and dispatch workers.</span>${button('Open messages', 'open-main', 'small')}</div>` : ''}
    ${board ? `${toolbar()}${renderBoard(tasks)}` : `<div class="workbench"><section class="task-pane" aria-label="Assigned issue list">${toolbar()}<div class="task-section-title"><span>${ui.checked.size ? `${ui.checked.size} selected` : 'YOUR PROJECT ISSUES'}</span><span>${tasks.length} issues</span></div>${tasks.length ? tasks.map(renderTaskRow).join('') : emptyTasks()}<div class="task-footer"><span>${ui.checked.size ? 'Analyze uses selected issues' : 'Select issues to run a smaller batch'}</span>${ui.checked.size ? button('Clear selection', 'clear-selection', 'small quiet') : ''}</div></section>${renderTaskDetail()}</div>`}`;
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
  return `<div class="task-row ${task.id === ui.selectedTask ? 'selected' : ''}"><input type="checkbox" aria-label="Select issue ${esc(task.externalId)}" data-select-task="${esc(task.id)}" ${ui.checked.has(task.id) ? 'checked' : ''}><button class="task-open" data-task="${esc(task.id)}"><span class="task-title">${esc(task.title)}</span><span class="task-meta">${sourceLogo(task.source)}<span class="mono">${esc(task.externalId)}</span><span class="priority-mark ${esc(task.priority)}" title="${esc(task.priority)} priority"></span><span>${esc(task.category || task.projectName)}</span>${renderTaskStates(task, run)}${task.demo ? '<span class="demo-label">Demo</span>' : ''}</span></button></div>`;
}
function renderTaskDetail() {
  const task = selectedTask();
  if (!task) return `<section class="detail-pane no-selection"><div class="empty">${icon('file')}<h2>Select an issue</h2><p>Its brief, agent messages, decisions, and proof will appear here.</p></div></section>`;
  const run = taskRun(task), link = safeUrl(task.url);
  const tabs = [['brief', 'Issue brief'], ['messages', `Messages${run && pending(run.id).length ? ` (${pending(run.id).length})` : ''}`], ['proof', 'Evidence']];
  return `<section class="detail-pane" aria-label="Selected issue"><div class="detail-top"><div class="detail-reference">${sourceLogo(task.source)}<span>${esc(task.sourceName)} / ${esc(task.externalId)}</span>${task.demo ? '<span class="demo-label">Demo</span>' : ''}${renderTaskStates(task, run)}</div><h2>${esc(task.title)}</h2><dl class="detail-properties"><dt>Project</dt><dd>${esc(task.projectName)}</dd><dt>Assigned to</dt><dd>${esc(task.assignees?.join(', ') || 'Your account')}</dd><dt>Category</dt><dd>${esc(task.category || 'Not analyzed yet')}</dd>${run ? `<dt>Agent</dt><dd>${run.provider === 'claude' ? 'Claude Code' : 'Codex'}</dd>` : ''}</dl></div>
    <div class="tabs" role="tablist" aria-label="Issue details">${tabs.map(([key, label]) => `<button class="tab ${ui.tab === key ? 'active' : ''}" role="tab" aria-selected="${ui.tab === key}" data-tab="${key}">${label}</button>`).join('')}</div>
    <div class="detail-body" role="tabpanel">${ui.tab === 'brief' ? `${renderIssueBrief(task)}${run ? renderRunPath(run) : ''}${run?.error ? `<p class="error-text">${esc(run.error)}</p>` : ''}` : ui.tab === 'messages' ? `<div id="messages">${run ? renderMessages(run.id) : '<p class="empty-small">Start an agent to begin the conversation.</p>'}</div>` : renderProof(run?.id)}</div>
    <div class="detail-bottom"><p>${run?.branch ? `${icon('branch')} <code>${esc(run.branch)}</code>` : link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Open original issue</a>` : 'One issue. One isolated worktree.'}</p><div class="actions">${run ? button('Open run', 'open-task-run', 'small') : button(`${icon('play')} Run agent`, 'launch-task', 'primary small', task.demo ? 'disabled title="Connect real tasks to run an agent"' : '')}</div></div></section>`;
}
function renderIssueBrief(task) {
  if (task.detailLoaded === false) return `<div class="description">${taskErrors.has(task.id) ? `<p class="error-text">${esc(taskErrors.get(task.id))}</p>${button('Retry loading details', 'retry-task-detail', 'small')}` : 'Loading the full issue description and attachments…'}</div>`;
  const raw = task.raw?.post || {};
  const images = [...(task.contentImages || []), ...(raw.imageAttachments || [])].map(item => ({ url: safeUrl(item.url || item.ATCH_URL || item.fileUrl), name: item.name || item.ORCP_FILE_NM || 'Issue screenshot' })).filter(item => item.url);
  const files = [...(task.contentFiles || []), ...(raw.attachments || [])].map(item => ({ url: safeUrl(item.url || item.ATCH_URL || item.fileUrl), name: item.name || item.ORCP_FILE_NM || 'Attachment' })).filter(item => item.url);
  return `<div class="description">${esc(task.description || 'This issue has no written description. Check its screenshots or open the original issue.')}</div>${images.length ? `<section class="issue-attachments" aria-label="Issue screenshots">${images.map(item => `<a href="${esc(item.url)}" target="_blank" rel="noopener"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(item.url)}" alt="${esc(item.name)}"><span>${esc(item.name)}</span></a>`).join('')}</section>` : ''}${files.length ? `<div class="issue-files">${files.map(item => `<a href="${esc(item.url)}" target="_blank" rel="noopener">${icon('file')}${esc(item.name)}</a>`).join('')}</div>` : ''}`;
}
async function loadTaskDetail() {
  const task = selectedTask();
  if (!task || task.detailLoaded !== false || loadingTasks.has(task.id) || taskErrors.has(task.id)) return;
  loadingTasks.add(task.id);
  try {
    const detail = await api(`/tasks/${encodeURIComponent(task.id)}`);
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
    return `<section class="board-column"><h2 class="board-heading">${name}<span>${column.length}</span></h2>${column.length ? column.map(task => `<button class="board-task" data-task="${esc(task.id)}" data-from-board="1"><strong>${esc(task.title)}</strong><span class="task-meta">${sourceLogo(task.source)}<span class="mono">${esc(task.externalId)}</span><span>${esc(task.category || 'Unsorted')}</span></span><span class="task-meta">${renderTaskStates(task)}${task.demo ? '<span class="demo-label">Demo</span>' : ''}</span></button>`).join('') : '<p class="board-empty">No issues</p>'}</section>`;
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
  return `${pending(runId).map(renderDecision).join('')}${messages.length ? messages.map(message => `<article class="message"><div class="message-label">${icon(message.kind === 'error' ? 'question' : 'agents')}<strong>${message.kind === 'error' ? 'Run needs attention' : message.kind === 'message' ? 'Agent' : 'Verification'}</strong><time>${time(message.createdAt)}</time></div><p>${esc(messageText(message))}</p></article>`).join('') : `<p class="empty-small">Deliberate messages from this agent appear here. Detailed operations stay in the work journal.</p>`}`;
}
function renderDecision(item) {
  const request = item.request || {};
  const originRun = ui.snapshot.runs.find(run => run.id === item.runId);
  const originTask = ui.snapshot.tasks.find(task => task.id === originRun?.taskId);
  const originTitle = originTask ? `${originTask.sourceName} #${originTask.externalId} ? ${originTask.title}` : originRun?.title || 'Agent conversation';
  const schema = request.requestedSchema;
  const properties = schema?.properties || {};
  const questions = request.questions || [];
  const fields = Object.entries(properties).map(([key, property]) => renderQuestionField(key, property, schema?.required?.includes(key))).join('')
    + questions.map(question => renderQuestionField(question.id || question.question, { type: 'string', title: question.question,
      enum: question.options?.map(option => option.label), description: question.options?.map(option => `${option.label}: ${option.description || ''}`).join('\n') }, true)).join('');
  const details = item.kind === 'approval' ? request.command || request.input || request : null;
  const link = request.mode === 'url' ? safeUrl(request.url) : '';
  return `<form class="decision ${esc(item.kind)}" data-interaction="${item.id}"><div class="decision-context"><button class="decision-run-link" type="button" data-run="${esc(item.runId)}">${icon('branch')}<span>${esc(originTitle)}</span></button><small>Run ${esc(item.runId.slice(0, 8))} ? ${originRun?.provider === 'claude' ? 'Claude Code' : originRun?.provider === 'codex' ? 'Codex' : 'External AI'}</small></div><div class="decision-heading">${icon(item.kind === 'approval' ? 'check' : 'question')}<span>${item.kind === 'approval' ? 'Approval requested' : 'Your answer is needed'} · ${esc(ui.snapshot.runs.find(run => run.id === item.runId)?.provider || 'Agent')}</span></div><h3>${esc(item.title)}</h3>${details ? `<pre>${esc(typeof details === 'string' ? details : JSON.stringify(details, null, 2))}</pre>` : ''}${link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener">Open ${esc(new URL(link).hostname)}</a></p>` : ''}${fields}<div class="actions"><button class="button primary small" type="submit" name="decision" value="accept">${item.kind === 'approval' ? 'Approve once' : 'Send answer'}</button><button class="button small" type="submit" name="decision" value="decline" formnovalidate>Decline</button><button class="button quiet small" type="submit" name="decision" value="cancel" formnovalidate>Cancel request</button></div></form>`;
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
    ${run.error ? `<div class="notice">${icon('question')}<span>${esc(run.error)}</span></div>` : ''}
    <div class="run-detail"><section class="panel"><h2>Agent messages</h2><div id="messages">${renderMessages(run.id)}</div><details class="activity-link" id="journal-details"><summary>Work journal · commands and tool activity</summary><div id="journal" class="journal">${renderJournal()}</div></details></section><aside class="panel"><h2>${run.role === 'coordinator' ? 'Dispatch' : 'Worktree & proof'}</h2>${run.worktree ? `<dl class="detail-properties"><dt>Base</dt><dd>${esc(run.baseBranch)}</dd><dt>PR target</dt><dd>${esc(run.targetBranch)}</dd><dt>Preview port</dt><dd>${run.port}</dd><dt>Folder</dt><dd><code>${esc(run.worktree)}</code></dd></dl>` : '<p class="muted">The main agent analyzes tasks and delegates work. It does not edit your source checkout.</p>'}${run.prUrl ? `<p><a href="${esc(safeUrl(run.prUrl))}" target="_blank" rel="noopener">Open draft pull request</a></p>` : ''}${renderProof(run.id)}</aside></div>`;
}
function renderJournal() {
  return ui.journal.length ? ui.journal.map(event => `<pre>${esc(time(event.createdAt))} · ${esc(event.kind)}\n${esc(event.text || JSON.stringify(event.item || event.content || event, null, 2))}</pre>`).join('') : '<p class="empty-small">Open the journal to load recorded operations.</p>';
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
    <div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections"><a href="#connections">Connections</a><a href="#repositories">Repositories</a><a href="#agents">Agents & workflow</a><a href="#appearance">Appearance</a><a href="#ai-connection">AI connection</a></nav>
    <form id="settings-form"><section class="settings-section" id="connections"><h2>Flow & Morningmate</h2><p>Only issues assigned to your account in these project IDs are imported. API keys stay encrypted on this computer.</p>${config.sources.map((source, index) => renderSourceSettings(source, index)).join('')}${button(`${icon('plus')} Add connection`, 'add-source', '', 'type="button"')}</section>
    <section class="settings-section" id="repositories"><h2>Source repositories</h2><p>Each worker uses a new worktree. Commands run there; your current checkout stays where it is.</p>${config.repositories.map((repository, index) => renderRepositorySettings(repository, index)).join('')}${button(`${icon('plus')} Add repository`, 'add-repository', '', 'type="button"')}</section>
    <section class="settings-section" id="agents"><h2>Agents & workflow</h2><p>Use your installed Claude Code and Codex sign-ins. You can override the provider for each run.</p><div class="settings-card"><div class="field-row">${inputField('Your name', 'name', config.name)}<label class="field"><span>Default agent</span>${providerSelect('provider', config.provider)}</label></div><div class="field-row">${inputField('Parallel workers', 'concurrency', config.concurrency, 'Main agent runs separately. Start with 1 or 2 workers.', 'number')}${inputField('Sync interval (minutes)', 'syncMinutes', config.syncMinutes, 'Set 0 to sync manually.', 'number')}</div>${inputField('Branch prefix', 'branchPrefix', config.branchPrefix, 'For example: temp/rex. Git branch names cannot begin with /.')}<div class="field-row">${inputField('Claude model (optional)', 'model.claude', config.models?.claude || '', 'Leave blank to use the installed provider’s default.')}${inputField('Codex model (optional)', 'model.codex', config.models?.codex || '', 'Use a model available to your signed-in account.')}</div><label class="field check"><input type="checkbox" name="requireVideo" ${config.requireVideo ? 'checked' : ''}><span>Require a browser recording and passing browser assertion before review</span></label><label class="field check"><input type="checkbox" name="reportToOrbit" ${config.reportToOrbit ? 'checked' : ''}><span>Let verified agents send their final report through my installed Orbit MCP</span></label><label class="field check"><input type="checkbox" name="autoPrLowRisk" ${config.autoPrLowRisk ? 'checked' : ''}><span>Automatically push and create a draft PR for verified low-risk fixes (risk 1?2/10)</span></label><small class="muted">Automatic PRs require a small style, markup, documentation, or test-only change, passing tests, current evidence, and no human-review flag. Application code, sensitive changes, and higher scores require review. Tracker changes still require approval. Nothing is merged automatically.</small></div>${button('Check installed tools', 'diagnostics', '', 'type="button"')}<div id="diagnostics"></div></section>
    <section class="settings-section" id="appearance"><h2>Appearance</h2><p>Choose a theme for this browser. Your choice takes effect immediately.</p><label class="field"><span>Color theme</span><select id="theme-preference">${[['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => `<option value="${value}" ${window.rexTheme.preference === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></section>
    <section class="settings-section" id="ai-connection"><h2>Connect an existing AI</h2><p>Rex-managed agents connect automatically. Add this MCP to another Claude Code, Codex, or compatible client to read tasks, send messages, or ask you questions.</p>${button(`${icon('link')} Show MCP connection setup`, 'mcp-setup', '', 'type="button"')}<div id="mcp-setup"></div><div class="help-block">Cloud clients need an authenticated HTTPS route to this computer. The dashboard stays local by default. See README.md for the tunnel boundary and external-agent setup.</div></section>
    <div class="settings-save"><small id="settings-status">Changes are saved only when you choose Save settings.</small><button type="submit" class="button primary">Save settings</button></div></form></div>`;
}
function renderSourceSettings(source, index) {
  const prefix = `source.${source.id}`;
  return `<div class="settings-card"><div class="settings-card-header"><strong>Connection ${index + 1}</strong>${button(`${icon('close')} Remove`, 'remove-source', 'quiet small', `type="button" data-id="${source.id}"`)}</div><div class="field-row">${inputField('Connection name', `${prefix}.name`, source.name)}<label class="field"><span>Service</span><select name="${prefix}.type"><option value="morningmate" ${source.type === 'morningmate' ? 'selected' : ''}>Morningmate</option><option value="flow" ${source.type === 'flow' ? 'selected' : ''}>Flow</option></select></label></div>${inputField('API base URL', `${prefix}.baseUrl`, source.baseUrl, '', 'url')}${inputField(source.hasKey ? 'API key · saved' : 'API key', `${prefix}.apiKey`, source.apiKey || '', source.hasKey ? 'Leave blank to keep the saved key. Enter a new key to replace it.' : 'Use a user API key from your service’s developer portal.', 'password', source.hasKey ? 'Saved key is not sent back to the browser' : 'Paste your API key')}
    <label class="field check"><input type="checkbox" name="${prefix}.clearKey"><span>Delete the saved key</span></label><div class="actions connection-actions">${button(connectingSources.has(source.id) ? 'Loading projects & people?' : 'Connect & load projects / people', 'connect-source', '', `type="button" data-id="${source.id}" ${connectingSources.has(source.id) ? 'disabled' : ''}`)}</div><div data-source-catalog="${source.id}">${renderSourceCatalog(source)}</div><label class="field"><span>Task status to sync</span><select name="${prefix}.statusFilter">${[['active', 'Request + In progress'], ['unfinished', 'All unfinished (includes review and hold)'], ['all', 'All statuses']].map(([value, label]) => `<option value="${value}" ${(source.statusFilter || 'active') === value ? 'selected' : ''}>${label}</option>`).join('')}</select><small>Completed tasks are excluded by default.</small></label><details class="manual-ids"><summary>Enter IDs manually</summary><div class="field-row">${inputField('Project IDs', `${prefix}.projectIds`, source.projectIds.join(', '), 'Normally filled by selecting projects above.')}${inputField('Your user ID (optional)', `${prefix}.userId`, source.userId, 'Normally filled by selecting an employee. Blank uses the API account.')}</div></details><label class="field"><span>Source repository</span><select name="${prefix}.repositoryId"><option value="">Choose a repository…</option>${ui.draft.repositories.map(repository => `<option value="${repository.id}" ${repository.id === source.repositoryId ? 'selected' : ''}>${esc(repository.name || repository.path)}</option>`).join('')}</select><small>New issues from this connection use this repository by default.</small></label><details><summary class="muted">Tracker status mapping</summary><p class="muted">Optional API status values. Unmapped phases leave tracker status unchanged.</p><div class="field-row three">${inputField('Working', `${prefix}.status.working`, source.statusMap?.working || '', '', 'text', 'progress')}${inputField('Review', `${prefix}.status.review`, source.statusMap?.review || '', '', 'text', 'feedback')}${inputField('Done', `${prefix}.status.done`, source.statusMap?.done || '', '', 'text', 'complete')}</div></details></div>`;
}
function sourceDirectory(sourceId) { return ui.snapshot.directories?.find(item => item.sourceId === sourceId); }
function renderSourceCatalog(source) {
  const directory = sourceDirectory(source.id);
  const agents = `<div class="agent-lookup"><span>Find choices through your installed service MCP:</span>${button('Find with Claude Code', 'source-agent', 'small quiet', `type="button" data-id="${source.id}" data-provider="claude"`)}${button('Find with Codex', 'source-agent', 'small quiet', `type="button" data-id="${source.id}" data-provider="codex"`)}</div>`;
  if (!directory) return `<p class="discovery-status muted">Connect to load project names and employee accounts. Choose them before syncing.</p>${agents}`;
  const selected = new Set(source.projectIds), employeeId = source.userId || '', employees = directory.employees;
  return `<div class="source-catalog"><p class="discovery-status muted">${directory.origin === 'mcp' ? 'Agent found these choices. Review them before saving.' : 'Connected. Select projects and the employee whose assigned tasks you want.'}</p>${Object.entries(directory.errors || {}).map(([kind, error]) => `<p class="error-text">${esc(kind)}: ${esc(error)}</p>`).join('')}<fieldset class="project-picker"><legend>Projects to sync</legend>${directory.projects.length ? `<input type="search" class="catalog-search" aria-label="Search projects for ${esc(source.name)}" placeholder="Search projects" data-catalog-search="${source.id}"><div class="project-options">${directory.projects.map(project => `<label class="project-choice"><input type="checkbox" data-source-project="${source.id}" value="${esc(project.id)}" ${selected.has(project.id) ? 'checked' : ''}><span>${esc(project.name)}<small>${esc(project.id)}</small></span></label>`).join('')}</div>` : '<p class="muted">No projects returned. Check access, reload, or use the MCP agent below.</p>'}</fieldset><label class="field"><span>Assigned employee</span><select data-source-employee="${source.id}"><option value="">Use signed-in API account${directory.accountId ? ` · ${esc(directory.accountId)}` : ''}</option>${employees.map(employee => `<option value="${esc(employee.id)}" ${employee.id === employeeId ? 'selected' : ''}>${esc(employee.name)} · ${esc(employee.email || employee.id)}${employee.department ? ` · ${esc(employee.department)}` : ''}${employee.id === directory.accountId ? ' · me' : ''}</option>`).join('')}${employeeId && !employees.some(employee => employee.id === employeeId) ? `<option selected value="${esc(employeeId)}">${esc(employeeId)} · saved account</option>` : ''}</select><small>Sync matches this task assignee, rather than the post author.</small></label>${agents}</div>`;
}
async function connectSource(sourceId, provider) {
  readSettings();
  const source = ui.draft.sources.find(item => item.id === sourceId);
  if (!source || connectingSources.has(sourceId)) return;
  connectingSources.add(sourceId); render();
  try {
    const result = await api(provider ? '/sources/setup-agent' : '/sources/connect', { method: 'POST', data: provider ? { source, provider } : source });
    readSettings();
    const current = ui.draft?.sources.find(item => item.id === sourceId);
    if (current) { current.hasKey = result.source.hasKey; current.apiKey = ''; current.clearKey = false; }
    const form = document.querySelector('#settings-form');
    if (form?.elements[`source.${sourceId}.apiKey`]) form.elements[`source.${sourceId}.apiKey`].value = '';
    if (form?.elements[`source.${sourceId}.clearKey`]) form.elements[`source.${sourceId}.clearKey`].checked = false;
    ui.snapshot.config.sources = [...ui.snapshot.config.sources.filter(item => item.id !== sourceId), result.source];
    if (result.directory) ui.snapshot.directories = [...(ui.snapshot.directories || []).filter(item => item.sourceId !== sourceId), result.directory];
    toast(provider ? 'Connection agent queued. Check Agent runs for questions and results.' : 'Connection saved. Choose projects and an employee, then Save settings.');
  } catch (error) { toast(error.message, true); }
  finally { connectingSources.delete(sourceId); if (ui.page === 'settings') { readSettings(); render(); } }
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
    return `<label class="field"><span>${label}</span><select name="repository.${repository.id}.${key}">${!value ? '<option value="">Choose a branch?</option>' : ''}${options.map(branch => `<option value="${esc(branch.name)}" ${branch.name === value ? 'selected' : ''}>${esc(branch.name)}${branch.local ? ' ? local' : branch.remote ? ' ? remote' : ' ? saved'}</option>`).join('')}</select><small>${key === 'baseBranch' ? 'Workers branch from this version of the project.' : 'You can change this before creating the PR.'}</small></label>`;
  }).join('')}</div>`;
}
function repositoryDiscovery(repository) {
  const info = repositoryInfo.get(repository.id);
  if (inspecting.has(repository.id)) return '<p class="discovery-status muted" role="status">Checking Git, GitHub account, and remote branches?</p>';
  if (info?.error) return `<p class="discovery-status error-text" role="alert">${esc(info.error)}</p>`;
  if (!info) return '<p class="discovery-status muted">Choose or paste a source folder. Git and GitHub details load automatically.</p>';
  return `<div class="repository-details"><dl><dt>GitHub account</dt><dd>${info.github.accounts.length ? info.github.accounts.map(account => `${esc(account.login)} on ${esc(account.host)}${account.state === 'success' ? ' ? signed in' : ' ? sign-in needs attention'}`).join('<br>') : 'Not signed in'}</dd><dt>Repository</dt><dd>${esc(info.github.repository?.name || info.name)}</dd><dt>Remote</dt><dd class="mono">${esc(info.remoteUrl || 'No remote configured')}</dd><dt>Git commit author</dt><dd>${esc([info.gitAuthor.name, info.gitAuthor.email].filter(Boolean).join(' ? ') || 'Not configured')}</dd><dt>Current checkout</dt><dd class="mono">${esc(info.currentBranch || 'Detached HEAD')} ? ${info.branches.length} branches</dd></dl>${info.warnings.map(warning => `<p class="muted">${esc(warning)}</p>`).join('')}${info.flow?.available ? button('Use Flow / Morningmate Tomcat setup', 'flow-preset', 'small', `type="button" data-id="${repository.id}"`) : ''}</div>`;
}
function renderRepositorySettings(repository, index) {
  const prefix = `repository.${repository.id}`;
  return `<div class="settings-card" data-repository="${repository.id}"><div class="settings-card-header"><strong>Repository ${index + 1}</strong>${button(`${icon('close')} Remove`, 'remove-repository', 'quiet small', `type="button" data-id="${repository.id}"`)}</div><div class="field-row">${inputField('Repository name', `${prefix}.name`, repository.name)}${inputField('Local repository path', `${prefix}.path`, repository.path, '', 'text', 'F:\\your-project')}</div><div class="actions repository-actions">${button('Choose folder', 'browse-repository', '', `type="button" data-id="${repository.id}"`)}${button('Inspect repository', 'inspect-repository', '', `type="button" data-id="${repository.id}"`)}</div><div data-discovery="${repository.id}">${repositoryDiscovery(repository)}</div><div data-branches="${repository.id}">${repositoryBranches(repository)}</div>${inputField('AI branch pattern', `${prefix}.branchPattern`, repository.branchPattern || '', 'Use {prefix}, {source}, {taskId}, {title}, and {runId}. Keep {runId} for unique concurrent branches.', 'text', '{prefix}/{source}-{taskId}/{title}-{runId}')}<div class="branch-preview"><span>Example branch</span><code data-branch-preview="${repository.id}">${esc(repository.branchPattern ? 'Loading preview?' : `${ui.draft.branchPrefix}/morningmate-4821/fix-blank-preview-a1b2c3`)}</code></div>${renderFlowSettings(repository)}${inputField('Worktree setup command', `${prefix}.setupCommand`, repository.setupCommand, 'Optional. Install dependencies in the worktree, for example npm ci.')}${inputField('Dev server command', `${prefix}.devCommand`, repository.devCommand, repository.flowRuntime ? 'Flow Tomcat uses its isolated runtime below. This command is used only for a custom preview.' : 'Required for browser tests. Include {port}; PORT is also set in the environment.', 'text', 'npm run dev -- --port {port}')}${inputField('Verification command', `${prefix}.testCommand`, repository.testCommand, 'Set a real test command for this branch. An empty command cannot pass verification.', 'text', 'npm test')}${inputField('Initial browser path', `${prefix}.browserPath`, repository.browserPath || '/', 'Path opened on the isolated preview server.', 'text', '/')}</div>`;
}
function renderFlowSettings(repository) {
  if (!repository.flowRuntime) return '';
  const prefix = `repository.${repository.id}.flow`, flow = repository.flowRuntime;
  return `<details class="flow-settings" open><summary>Isolated Flow / Morningmate Tomcat</summary><p class="muted">Each run gets its own Tomcat base, logs, temp files, and HTTP port. Debug and AJP ports stay disabled. Database and external service settings come from your selected seed folder.</p>${inputField('Tomcat template folder', `${prefix}.templateBase`, flow.templateBase)}${inputField('Java 8 home', `${prefix}.javaHome`, flow.javaHome)}${inputField('Tomcat installation', `${prefix}.catalinaHome`, flow.catalinaHome)}${inputField('Local configuration seed folder', `${prefix}.seedPath`, flow.seedPath, 'A source checkout with the correct JEX config for this branch. Config and license files are copied, never linked.')}${inputField('Maximum Java heap (MB)', `${prefix}.maxHeapMb`, flow.maxHeapMb, 'Per running Tomcat. Start with one worker on this large project.', 'number')}${button('Use custom dev command instead', 'remove-flow-preset', 'small quiet', `type="button" data-id="${repository.id}"`)}</details>`;
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
    if (repository.flowRuntime) {
      result.flowRuntime = Object.fromEntries(['templateBase', 'javaHome', 'catalinaHome', 'seedPath'].map(key => [key, String(data.get(`${prefix}.flow.${key}`) || '')]));
      result.flowRuntime.maxHeapMb = Number(data.get(`${prefix}.flow.maxHeapMb`));
    }
    return result;
  });
  return draft;
}

async function loadMessages() {
  if (ui.page === 'inbox') await loadTaskDetail();
  const run = ui.page === 'runs' ? selectedRun() : selectedTask() ? taskRun(selectedTask()) : null;
  if (!run) return;
  const messages = await api(`/runs/${run.id}/messages`); ui.messages = messages.map(message => ({ ...message, runId: run.id }));
  const target = document.querySelector('#messages'); if (target) target.innerHTML = renderMessages(run.id);
}
async function launchDialog({ role = 'worker', resume = false } = {}) {
  const task = selectedTask(), run = selectedRun();
  const repositoryId = task?.repositoryId || ui.snapshot.config.repositories[0]?.id;
  const repository = ui.snapshot.config.repositories.find(item => item.id === (resume ? run.repositoryId : repositoryId));
  const count = ui.checked.size || ui.snapshot.tasks.filter(item => !item.demo).length;
  const dialog = document.querySelector('#launch-dialog');
  const title = resume ? 'Continue this run' : role === 'coordinator' ? 'Start the main agent' : 'Start an issue agent';
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="launch-title">${title}</h2>${button(icon('close'), 'close-dialog', 'quiet icon-only', 'aria-label="Close dialog"')}</div><p>${resume ? 'Continue with the same provider, or switch providers and pass the recorded issue context into a new session.' : role === 'coordinator' ? `Analyze ${count} assigned issue${count === 1 ? '' : 's'}, categorize them, and dispatch independent workers.` : esc(task?.title)}</p><form id="launch-form" data-role="${role}" data-resume="${resume}"><label class="field"><span>Agent</span>${providerSelect('provider', resume ? run.provider : ui.snapshot.config.provider)}</label>${role === 'worker' && !resume ? `<label class="field"><span>Source repository</span><select name="repositoryId" required><option value="">Choose a repository…</option>${ui.snapshot.config.repositories.map(item => `<option value="${item.id}" ${item.id === repositoryId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>` : ''}<div class="field-row">${inputField('Start from branch', 'baseBranch', resume ? run.baseBranch : role === 'coordinator' ? '' : repository?.baseBranch || '', role === 'coordinator' ? 'Blank uses each repository’s default.' : '', 'text', 'Repository default')}${inputField('PR target branch', 'targetBranch', resume ? run.targetBranch : role === 'coordinator' ? '' : repository?.targetBranch || '', 'You can change this before publishing.', 'text', 'Repository default')}</div><datalist id="branches"></datalist><label class="field"><span>${resume ? 'Follow-up instruction' : 'Additional instruction (optional)'}</span><textarea name="prompt" placeholder="For example: investigate critical issues first, and keep related fixes sequential."></textarea></label><div class="form-error" id="launch-error" role="alert"></div><div class="actions">${button('Cancel', 'close-dialog', '', 'type="button"')}<button class="button primary" type="submit">${resume ? 'Continue run' : role === 'coordinator' ? 'Analyze & run' : 'Start agent'}</button></div></form>`;
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
  if (name === 'retry-task-detail') { taskErrors.delete(ui.selectedTask); void loadTaskDetail(); return; }
  if (name === 'connect-source') { void connectSource(target.dataset.id); return; }
  if (name === 'source-agent') { void connectSource(target.dataset.id, target.dataset.provider); return; }
  if (name === 'toggle-theme') { window.rexTheme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return; }
  if (name === 'inspect-repository') { void inspectRepositorySettings(target.dataset.id); return; }
  if (name === 'browse-repository') {
    readSettings(); target.disabled = true; target.textContent = 'Choose a folder?';
    void action(async () => {
      try {
        const selected = await api('/repositories/pick', { method: 'POST' });
        const field = document.querySelector('#settings-form')?.elements[`repository.${target.dataset.id}.path`];
        if (selected.path && field) { field.value = selected.path; repositoryInfo.delete(target.dataset.id); await inspectRepositorySettings(target.dataset.id); }
      } finally { if (target.isConnected) { target.disabled = false; target.textContent = 'Choose folder'; } }
    }); return;
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
      document.querySelector('#mcp-setup').innerHTML = `<div class="help-block"><strong>Connection URL</strong><pre>${esc(result.url)}</pre><label class="field"><span>Access token · keep private</span><input type="password" readonly value="${esc(result.token)}" id="mcp-token" autocomplete="off"></label>${button('Copy access token', 'copy-token', 'small', 'type="button"')}<p>Set <code>REX_DESK_TOKEN</code> in the environment of your AI client.</p><strong>Codex config.toml</strong><pre>${esc(result.codex)}</pre><strong>Claude Code .mcp.json</strong><pre>${esc(JSON.stringify(result.claude, null, 2))}</pre><p>External clients can use <code>desk_ask</code> with <code>wait=false</code>, then poll <code>desk_question</code> if they cannot keep a tool call open.</p></div>`;
    }
    if (name === 'copy-token') { await navigator.clipboard.writeText(document.querySelector('#mcp-token').value); toast('Access token copied.'); }
  }).finally(() => { if (ui.busy) { ui.busy = false; render(); } });
});
document.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]'); if (!tab) return; ui.tab = tab.dataset.tab; render(); void loadMessages();
});
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
    const cursor = event.target.selectionStart; render(); const field = document.querySelector('#task-search'); field.focus(); field.setSelectionRange(cursor, cursor);
  }
});
document.addEventListener('change', event => {
  const target = event.target;
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
  if (target.id === 'source-filter' || target.id === 'category-filter') { ui[target.id === 'source-filter' ? 'source' : 'category'] = target.value; render(); return; }
  if (target.closest('#settings-form') && target.name.endsWith('.type')) {
    const card = target.closest('.settings-card'); const base = card.querySelector('input[name$=".baseUrl"]');
    if (['https://api.morningmate.com', 'https://api.flow.team'].includes(base.value)) base.value = target.value === 'flow' ? 'https://api.flow.team' : 'https://api.morningmate.com';
  }
  if (target.closest('#launch-form') && target.name === 'repositoryId') {
    const repository = ui.snapshot.config.repositories.find(item => item.id === target.value);
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
  const stream = new EventSource('/api/events');
  let timer;
  stream.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(() => void refresh().catch(error => toast(error.message, true)), 400); });
  stream.onerror = () => { document.querySelector('.local-state')?.setAttribute('title', 'Reconnecting to the local server…'); };
} catch (error) {
  app.innerHTML = `<div class="empty"><h1>Workspace unavailable</h1><p>${esc(error.message)}</p><p>Start Rex Desk with <code>npm start</code>, then reload this page.</p></div>`;
}

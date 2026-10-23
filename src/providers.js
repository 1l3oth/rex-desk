import { now } from './store.js';

const text = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const identity = value => String(value ?? '').trim().toLowerCase();

const readable = value => String(value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
  .replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&')
  .replace(/\\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
export function postContent(record) {
  const original = record.content || record.contents || record.htmlContent || '';
  let content = original;
  for (let attempt = 0; attempt < 2 && typeof content === 'string'; attempt++) {
    try { content = JSON.parse(content); } catch { break; }
  }
  const components = content && typeof content === 'object' ? content.COMPS : null;
  if (!Array.isArray(components)) return { description: readable(original), contentImages: [], contentFiles: [] };
  const paragraphs = [], contentImages = [], contentFiles = [];
  for (const component of components) {
    const detail = component.COMP_DETAIL || {};
    if (component.COMP_TYPE === 'TEXT' && typeof detail.CONTENTS === 'string') paragraphs.push(readable(detail.CONTENTS));
    else if (component.COMP_TYPE === 'IMAGE' && detail.ATCH_URL) contentImages.push({ url: detail.ATCH_URL, name: detail.ORCP_FILE_NM || 'Issue screenshot' });
    else if (/FILE|ATTACHMENT/.test(component.COMP_TYPE || '') && (detail.FILE_DOWN_URL || detail.ATCH_URL)) contentFiles.push({ url: detail.FILE_DOWN_URL || detail.ATCH_URL, name: detail.ORCP_FILE_NM || 'Attachment' });
  }
  return { description: paragraphs.filter(Boolean).join('\n\n'), contentImages, contentFiles };
}
export function matchesTaskStatus(task, filter = 'active') {
  if (filter === 'all') return true;
  const category = String(task.statusCategory || '').toLowerCase();
  const status = String(task.statusName || task.status).trim().toLowerCase().replace(/[_-]+/g, ' ');
  const completed = ['2', 'complete', 'completed', 'done'].includes(category) || /^(complete|completed|done|closed|완료)$/.test(status);
  if (filter === 'unfinished') return !completed;
  return !completed && (['0', '1', 'request', 'progress'].includes(category) || /^(0|1|request|requested|in progress|progress|working|todo|to do|open|요청|진행)$/.test(status));
}

export async function apiRequest(source, key, endpoint, { method = 'GET', body, fetcher = fetch } = {}) {
  const url = new URL(endpoint, source.baseUrl);
  if (url.origin !== new URL(source.baseUrl).origin) throw new Error('API request cannot leave the configured source.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetcher(url, { method, headers: { 'x-flow-api-key': key, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), redirect: 'error' });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retry = response.headers.get('retry-after');
      const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 500 * 2 ** attempt;
      // Long provider backoff belongs to the next sync, not a stuck dashboard request.
      if (delay > 30000) throw new Error(`API rate limited. Retry after ${retry}.`);
      await new Promise(resolve => setTimeout(resolve, Math.max(100, delay)));
      continue;
    }
    const result = await response.json().catch(() => { throw new Error(`API returned HTTP ${response.status} without JSON.`); });
    if (!response.ok || result.success === false || result.response?.success === false) {
      const error = result.error || result.response?.error || {};
      throw new Error(`HTTP ${response.status}: ${error.code || 'API_ERROR'} — ${error.message || result.message || 'Request failed'}`);
    }
    return result.response?.data ?? result.data ?? result;
  }
}

export function taskAssignees(post) {
  const result = new Set();
  const add = value => {
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (typeof value === 'string') { value.split(',').forEach(item => result.add(identity(item))); return; }
    if (!value || typeof value !== 'object') return;
    for (const field of ['workerId', 'userId', 'participantId', 'USER_ID', 'WORKER_ID', 'email', 'customColumnData', 'CUSTOM_COLUMN_DATA']) if (value[field]) add(value[field]);
    for (const field of ['workers', 'workerRecords', 'workerRecord', 'assignees', 'users', 'values', 'data', 'userIds', 'columnData', 'columnDataArray', 'COLUMN_DATA_REC']) if (value[field]) add(value[field]);
  };
  for (const object of [post, post.task, post.taskInfo, post.taskData, ...(post.tasks || [])].filter(Boolean)) {
    for (const field of ['workers', 'workerRecords', 'workerRecord', 'workerIds', 'workerList', 'assignees', 'TASK_WORKER_REC', 'TASK_WORKER_RECORD', 'WORKER_REC', 'WORKER_RECORD']) add(object[field]);
    for (const column of object.columns || object.taskColumns || object.TASK_COLUMN_REC || []) {
      if (/WORKER|ASSIGNEE/i.test(column.defaultColumnType || column.DEFAULT_COLUMN_TYPE || column.columnType || column.columnCode || '')) add(column);
    }
  }
  return [...result].filter(Boolean);
}

export function normalizeTask(source, projectId, post, detail = {}) {
  const record = detail.post || detail;
  const task = record.task || record.taskInfo || record.taskData || record.tasks?.[0] || {};
  const taskId = String(record.taskId || task.taskId || task.TASK_SRNO || post.taskId || post.postId);
  const columns = record.columns || record.TASK_COLUMN_REC || task.columns || task.taskColumns || task.TASK_COLUMN_REC || [];
  const statusColumn = columns.find(column => /STATUS/i.test(column.defaultColumnType || column.DEFAULT_COLUMN_TYPE || column.columnType || ''));
  const statusData = (statusColumn?.columnData || statusColumn?.COLUMN_DATA_REC || [])[0];
  const status = record.taskStatus ?? task.status ?? record.STTS ?? task.STTS ?? post.taskStatus ?? statusData?.customColumnData ?? statusColumn?.optionName ?? 'unknown';
  return { id: `${source.id}:${projectId}:${taskId}`, externalId: taskId, postId: String(post.postId || record.postId),
    sourceId: source.id, source: source.type, sourceName: source.name, projectId: String(projectId),
    projectName: record.projectTitle || post.projectTitle || String(projectId),
    title: text(record.title || post.title || task.content), ...postContent({ ...record, content: record.content || post.content || '' }),
    status: String(status), statusName: statusData?.optionName || statusData?.OPTION_NAME || '', statusCategory: statusData?.optionCategory || statusData?.OPTION_CATEGORY || '', priority: record.priority || record.PRIORITY || task.priority || task.PRIORITY || 'normal',
    assignees: taskAssignees(record), repositoryId: source.repositoryId || '', category: '',
    dueDate: record.scheduleFinishDateTime || record.END_DT || task.endDate || task.END_DT || post.scheduleFinishDateTime || '',
    url: record.connectUrl || record.tinyUrl || '', syncedAt: now(), active: true,
    raw: { post: record, summary: post }, demo: false };
}

export class Sources {
  constructor(store, { fetcher = fetch } = {}) { this.store = store; this.fetcher = fetcher; this.syncing = false; }
  async request(source, endpoint, options = {}) {
    const key = this.store.credential(source.id);
    if (!key) throw new Error(`Add an API key for ${source.name} in Settings.`);
    return apiRequest(source, key, endpoint, { ...options, fetcher: this.fetcher });
  }
  async sync() {
    // Sync reads only the projects and assignee explicitly selected in Settings.
    if (this.syncing) throw new Error('A sync is already running.');
    this.syncing = true;
    const results = [];
    try {
      for (const source of this.store.config().sources) {
        try { results.push(await this.syncSource(source)); }
        catch (error) {
          const result = { sourceId: source.id, name: source.name, error: error.message, at: now() };
          this.store.put('sync', source.id, result); results.push(result);
        }
      }
      return results;
    } finally { this.syncing = false; }
  }
  async directory(sourceId) {
    const source = this.store.config().sources.find(item => item.id === sourceId);
    if (!source) throw new Error('Save or connect this source first.');
    const errors = {};
    const pages = async (endpoint, field) => {
      const rows = [], seen = new Set(); let cursor = 0;
      for (let page = 0; page < 500; page++) {
        if (seen.has(String(cursor))) throw new Error('Directory API repeated a pagination cursor. Try loading again.');
        seen.add(String(cursor));
        const data = await this.request(source, `${endpoint}?cursor=${encodeURIComponent(cursor)}`);
        if (!Array.isArray(data[field])) throw new Error(`Directory API did not return ${field}.`);
        rows.push(...data[field]);
        if (!data.hasNext) return rows;
        if (data.lastCursor === undefined || Number(data.lastCursor) < 0) throw new Error('Directory API omitted its next cursor.');
        cursor = data.lastCursor;
      }
      throw new Error('Directory exceeds 500 pages. Ask your administrator to narrow API access.');
    };
    const attempt = async (key, callback, fallback) => { try { return await callback(); } catch (error) { errors[key] = error.message; return fallback; } };
    const [projects, employees, account] = await Promise.all([
      attempt('projects', () => pages('/user/projects/participants', 'projects'), []),
      attempt('employees', () => pages('/user/employees', 'employees'), []),
      attempt('account', async () => { const data = await this.request(source, '/user/employees/me'); return data.employee || data; }, null),
    ]);
    if (account?.userId && !employees.some(employee => employee.userId === account.userId)) employees.unshift(account);
    return this.saveDirectory(sourceId, { projects: projects.filter(project => project.projectId).map(project => ({ id: String(project.projectId), name: text(project.title || project.projectTitle || project.projectId) })),
      employees: employees.filter(employee => employee.userId).map(employee => ({ id: String(employee.userId), name: text(employee.fullname || employee.name || employee.userId), email: employee.email || '', department: text(employee.divisionName || '') })),
      accountId: account?.userId || '', errors }, 'api');
  }
  saveDirectory(sourceId, input, origin = 'mcp') {
    if (!this.store.config().sources.some(source => source.id === sourceId)) throw new Error('Source connection not found.');
    const clean = (rows, kind) => [...new Map((rows || []).map(row => {
      const id = String(row.id || '').trim();
      if (!id || id.length > 500) throw new Error(`Invalid ${kind} identifier.`);
      return [id, { id, name: text(row.name || id).slice(0, 300), ...(kind === 'employee' ? { email: text(row.email || '').slice(0, 300), department: text(row.department || '').slice(0, 300) } : {}) }];
    })).values()];
    const directory = { id: sourceId, sourceId, projects: clean(input.projects, 'project'), employees: clean(input.employees, 'employee'),
      accountId: String(input.accountId || ''), errors: input.errors || {}, origin, at: now() };
    this.store.put('directory', sourceId, directory); return directory;
  }
  async syncSource(source) {
    if (!source.projectIds.length) throw new Error('Select at least one project ID in Settings.');
    let account = source.userId;
    if (!account) {
      const me = await this.request(source, '/user/employees/me');
      account = (me.employee || me).userId;
    }
    if (!account) throw new Error('Could not identify your user ID. Enter it in Settings.');
    const fetched = [], statusSets = [];
    for (const projectId of source.projectIds) {
      const statuses = await this.request(source, `/user/projects/${encodeURIComponent(projectId)}/columns/status`);
      statusSets.push({ projectId, data: statuses });
      const filtered = await this.filteredProject(source, projectId, account);
      if (filtered !== null) { fetched.push(...filtered); continue; }
      let cursor = 0;
      const cursors = new Set();
      while (true) {
        if (cursors.has(String(cursor))) throw new Error('API repeated a pagination cursor. Cached tasks were preserved.');
        if (cursors.size >= 1000) throw new Error('Project exceeds 1000 pages. Narrow the source project selection.');
        cursors.add(String(cursor));
        const page = await this.request(source, `/user/posts/projects/${encodeURIComponent(projectId)}?pageSize=100&cursor=${encodeURIComponent(cursor)}`);
        if (!Array.isArray(page.posts)) throw new Error('Unexpected task response: expected data.posts.');
        let next = 0;
        const inspectPost = async post => {
          const detail = await this.request(source, `/user/posts/${encodeURIComponent(post.postId)}`);
          const task = normalizeTask(source, projectId, post, detail);
          if (task.assignees.includes(identity(account)) && matchesTaskStatus(task, source.statusFilter)) fetched.push(task);
          const record = detail.post || detail;
          for (const subtask of record.subTasks || []) {
            const child = normalizeTask(source, projectId, { ...post, title: subtask.taskName || subtask.TASK_NM, taskId: subtask.taskId || subtask.TASK_SRNO },
              { ...subtask, taskId: subtask.taskId || subtask.TASK_SRNO, title: subtask.taskName || subtask.TASK_NM, content: `${subtask.content || ''}\nParent issue: ${record.title || post.title}\n${record.content || post.content || ''}`, columns: subtask.taskColumns || subtask.TASK_COLUMN_REC || [] });
            if (child.assignees.includes(identity(account)) && matchesTaskStatus(child, source.statusFilter)) fetched.push({ ...child, parentPostId: String(post.postId) });
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, page.posts.length) }, async () => {
          while (next < page.posts.length) { const post = page.posts[next++]; await inspectPost(post); }
        }));
        if (!page.hasNext) break;
        if (page.lastCursor === undefined || Number(page.lastCursor) < 0) throw new Error('Missing next cursor in API response.');
        cursor = page.lastCursor;
      }
    }
    // Only retire cached tasks after every configured project completed successfully.
    for (const task of this.store.list('task').filter(item => item.sourceId === source.id)) this.store.put('task', task.id, { ...task, active: false });
    for (const task of fetched) {
      const previous = this.store.get('task', task.id);
      this.store.put('task', task.id, { ...task, category: previous?.category || '', runId: previous?.runId });
    }
    for (const set of statusSets) this.store.put('statuses', `${source.id}:${set.projectId}`, set);
    const result = { sourceId: source.id, name: source.name, count: fetched.length, account, at: now() };
    this.store.put('sync', source.id, result);
    return result;
  }
  async filteredProject(source, projectId, account) {
    let definitions;
    try { definitions = await this.request(source, `/user/projects/${encodeURIComponent(projectId)}/columns`); }
    catch (error) { if (/HTTP (404|405):/.test(error.message)) return null; throw error; }
    if (!Array.isArray(definitions.columns)) return null;
    const worker = definitions.columns.find(column => /WORKER|ASSIGNEE/i.test(column.defaultColumnType || ''));
    if (!worker) return null;
    const filterRecords = [{ COLUMN_SRNO: String(worker.columnSrno || worker.columnId), OPERATOR_TYPE: 'IN', FILTER_DATA: String(account) }];
    const tasks = [], cursors = new Set(); let cursor = 0;
    while (true) {
      if (cursors.has(String(cursor)) || cursors.size >= 1000) throw new Error('Filtered task pagination did not finish. Cached tasks were preserved.');
      cursors.add(String(cursor));
      let page;
      try { page = await this.request(source, `/user/posts/projects/${encodeURIComponent(projectId)}/tasks/filter?pageSize=100&cursor=${encodeURIComponent(cursor)}&filterRecords=${encodeURIComponent(JSON.stringify(filterRecords))}`); }
      catch (error) { if (/HTTP (404|405):/.test(error.message)) return null; throw error; }
      if (!Array.isArray(page.tasks)) throw new Error('Filtered task API did not return data.tasks.');
      for (const row of page.tasks) {
        // Filter responses may include a parent only as context for an assigned subtask.
        if (!taskAssignees(row).includes(identity(account))) continue;
        const task = normalizeTask(source, projectId, row, { ...row, title: row.content, content: '' });
        const number = row.columns?.find(column => column.defaultColumnType === 'TASK_NUM')?.columnData?.[0]?.customColumnData;
        if (matchesTaskStatus(task, source.statusFilter)) tasks.push({ ...task, taskNumber: number || '', parentTaskId: row.upTaskId || '', description: '', detailLoaded: false });
      }
      if (!page.hasNext) break;
      if (page.lastCursor === undefined || Number(page.lastCursor) < 0) throw new Error('Filtered task API omitted its next cursor.');
      cursor = page.lastCursor;
    }
    return [...new Map(tasks.map(task => [task.id, task])).values()];
  }
  async taskDetail(taskId) {
    const task = this.store.get('task', taskId);
    if (!task) throw new Error('Task not found.');
    if (task.demo || task.detailLoaded !== false) return task;
    const source = this.store.config().sources.find(item => item.id === task.sourceId);
    if (!source) throw new Error('Source connection no longer exists.');
    const detail = await this.request(source, `/user/posts/${encodeURIComponent(task.postId)}`), record = detail.post || detail;
    const child = record.subTasks?.find(item => String(item.taskId || item.TASK_SRNO) === task.externalId);
    const complete = child ? { ...child, taskId: task.externalId, title: child.taskName || child.TASK_NM,
      content: `${child.content || ''}\nParent issue: ${record.title || ''}\n${record.content || ''}`, connectUrl: record.connectUrl } : record;
    const normalized = normalizeTask(source, task.projectId, { postId: task.postId, taskId: task.externalId }, complete);
    const fresh = { ...task, ...normalized, id: task.id, externalId: task.externalId, taskNumber: task.taskNumber,
      category: task.category, runId: task.runId, parentTaskId: task.parentTaskId, detailLoaded: true };
    this.store.put('task', taskId, fresh); return fresh;
  }
  async updateStatus(task, phase) {
    const source = this.store.config().sources.find(item => item.id === task.sourceId);
    const status = source?.statusMap?.[phase];
    if (!status) return { skipped: true, reason: `No source status mapped for ${phase}.` };
    const data = await this.request(source, `/user/posts/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.externalId)}/status`,
      { method: 'PATCH', body: { status } });
    this.store.put('task', task.id, { ...task, status });
    return data;
  }
}

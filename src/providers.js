import { now } from './store.js';

const text = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const identity = value => String(value ?? '').trim().toLowerCase();

const readable = value => String(value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
  .replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&')
  .replace(/\\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
export function postContent(record) {
  const original = record.content || record.contents || '';
  let content = original;
  for (let attempt = 0; attempt < 2 && typeof content === 'string'; attempt++) {
    try { content = JSON.parse(content); } catch { break; }
  }
  const components = content && typeof content === 'object' ? content.COMPS : null;
  const fallback = readable(record.outContent || '');
  if (!Array.isArray(components)) return { description: fallback || readable(/^\s*\{"COMPS"/.test(String(original)) ? '' : original), contentImages: [], contentFiles: [] };
  const paragraphs = [], contentImages = [], contentFiles = [];
  for (const component of components) {
    const detail = component.COMP_DETAIL || {};
    if (component.COMP_TYPE === 'TEXT' && typeof detail.CONTENTS === 'string') paragraphs.push(readable(detail.CONTENTS));
    else if (component.COMP_TYPE === 'IMAGE' && detail.ATCH_URL) contentImages.push(image(detail, 'Issue screenshot'));
    else if (/FILE|ATTACHMENT/.test(component.COMP_TYPE || '') && (detail.FILE_DOWN_URL || detail.ATCH_URL)) contentFiles.push({ url: detail.FILE_DOWN_URL || detail.ATCH_URL, name: detail.ORCP_FILE_NM || 'Attachment' });
  }
  return { description: paragraphs.filter(Boolean).join('\n\n') || fallback, contentImages, contentFiles };
}
const image = (item, name) => ({ url: item.ATCH_URL || item.url, name: item.ORCP_FILE_NM || item.name || name,
  ...(item.THUM_IMG_PATH ? { thumbnail: item.THUM_IMG_PATH } : {}), ...(Number(item.WIDTH) ? { width: Number(item.WIDTH) } : {}), ...(Number(item.HEIGHT) ? { height: Number(item.HEIGHT) } : {}) });
// The post body and its attachment list repeat the same screenshot, sometimes with a different query string.
export function uniqueImages(...lists) {
  const seen = new Map();
  for (const item of lists.flat()) {
    if (!item?.url) continue;
    const key = String(item.url).split('?')[0], previous = seen.get(key);
    seen.set(key, previous ? { ...item, ...previous, name: previous.name === 'Issue screenshot' ? item.name : previous.name } : item);
  }
  return [...seen.values()];
}
export const flowDate = value => {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2}))?/);
  return match ? `${match[1]}-${match[2]}-${match[3]}${match[4] ? ` ${match[4]}:${match[5]}` : ''}` : String(value || '');
};
function readColumns(columns = []) {
  return columns.map(column => ({ id: String(column.columnId ?? column.columnSrno ?? column.COLUMN_SRNO ?? ''),
    type: String(column.columnType || column.COLUMN_TYPE || ''), role: String(column.defaultColumnType || column.DEFAULT_COLUMN_TYPE || ''),
    values: (column.columnData || column.COLUMN_DATA_REC || []).map(item => ({ option: String(item.optionName ?? item.OPTION_NAME ?? ''),
      user: String(item.userName ?? item.USER_NM ?? ''), data: String(item.customColumnData ?? item.CUSTOM_COLUMN_DATA ?? '') })) }));
}
export function columnNames(columns = []) {
  return Object.fromEntries(columns.map(column => [String(column.columnSrno ?? column.columnId ?? column.COLUMN_SRNO ?? ''), text(column.columnName ?? column.COLUMN_NAME ?? '')])
    .filter(([key, name]) => key && name));
}
// Task columns hold the readable title and tracker properties; the post body holds only the description.
export function taskFields(columns = [], names = {}) {
  const fields = [], meta = {};
  const roles = { TASK_NM: 'title', TASK_NUM: 'taskNumber', RGSR_ID: 'reporter', RGSN_DTTM: 'createdAt', EDTR_DTTM: 'updatedAt', START_DT: 'startDate', END_DT: 'dueDate', PRIORITY: 'priorityName', SECTION: 'section', PROGRESS: 'progress' };
  for (const column of readColumns(columns)) {
    const values = column.values.map(item => column.type === 'USER' ? item.user || item.data : column.type === 'DATE' ? flowDate(item.data)
      : column.type === 'CHECKBOX' ? (/^(y|true|1)$/i.test(item.data) ? 'Yes' : item.data ? 'No' : '') : item.option || item.data).filter(Boolean);
    const value = text(values.join(', '));
    if (roles[column.role]) { if (value) meta[roles[column.role]] = value; continue; }
    if (['STATUS', 'WORKER_ID'].includes(column.role)) continue;
    if (value) fields.push({ name: names[column.id] || `Field ${column.id}`, value });
  }
  return { ...meta, fields };
}
export function taskComments(remarks = []) {
  return remarks.filter(remark => remark.DELETE_YN !== 'Y').map(remark => {
    const system = remark.SYSTEM_REMARK_YN === 'Y';
    const body = postContent({ content: system ? remark.REMARK_CNTN || remark.CNTN || '' : remark.CNTN || remark.REMARK_CNTN || '' });
    return { id: String(remark.COLABO_REMARK_SRNO || ''), author: text(remark.RGSR_NM), at: flowDate(remark.RGSN_DTTM), system, text: body.description,
      images: uniqueImages(body.contentImages, (remark.REMARK_IMG_ATCH_REC || []).map(item => image(item, 'Comment image'))),
      files: [...body.contentFiles, ...(remark.REMARK_ATCH_REC || []).map(item => ({ url: item.FILE_DOWN_URL || item.ATCH_URL, name: item.ORCP_FILE_NM || 'Attachment' }))].filter(item => item.url) };
  }).filter(comment => comment.text || comment.images.length || comment.files.length);
}
// A subtask keeps its own body; the parent issue is appended as separately parsed context.
export function subtaskRecord(child, parent) {
  const own = postContent(child), inherited = postContent(parent);
  return { record: { ...child, taskId: String(child.taskId || child.TASK_SRNO), title: child.taskName || child.TASK_NM, content: '',
    columns: child.taskColumns || child.TASK_COLUMN_REC || child.columns || [], connectUrl: parent.connectUrl, projectColumns: parent.projectColumns },
  content: { description: [own.description, inherited.description && `Parent issue: ${text(parent.title)}\n${inherited.description}`].filter(Boolean).join('\n\n'),
    contentImages: uniqueImages(own.contentImages, inherited.contentImages), contentFiles: [...own.contentFiles, ...inherited.contentFiles] } };
}
export function matchesTaskStatus(task, filter = 'active', statuses = []) {
  if (statuses?.length) return statuses.some(name => name.toLowerCase() === String(task.statusName || '').trim().toLowerCase());
  if (filter === 'all') return true;
  const category = String(task.statusCategory || '').toLowerCase();
  const status = String(task.statusName || task.status).trim().toLowerCase().replace(/[_-]+/g, ' ');
  const completed = ['2', 'complete', 'completed', 'done'].includes(category) || /^(complete|completed|done|closed|완료)$/.test(status);
  if (filter === 'unfinished') return !completed;
  // Trackers often file "Development Completed" or "Resolved" under In progress; by default those wait for QA, not for an agent.
  const finishedName = /(^|\s)(complete|completed|done|closed|resolved|finished|fixed)(\s|$)|완료|完了|해결/.test(status);
  return !completed && !finishedName && (['0', '1', 'request', 'progress'].includes(category) || /^(0|1|request|requested|in progress|progress|working|todo|to do|open|요청|진행)$/.test(status));
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

export function normalizeTask(source, projectId, post, detail = {}, { names, content } = {}) {
  const record = detail.post || detail;
  const task = record.task || record.taskInfo || record.taskData || record.tasks?.[0] || {};
  const taskId = String(record.taskId || task.taskId || task.TASK_SRNO || post.taskId || post.postId);
  const columns = record.columns || record.TASK_COLUMN_REC || task.columns || task.taskColumns || task.TASK_COLUMN_REC || [];
  const statusColumn = columns.find(column => /STATUS/i.test(column.defaultColumnType || column.DEFAULT_COLUMN_TYPE || column.columnType || ''));
  const statusData = (statusColumn?.columnData || statusColumn?.COLUMN_DATA_REC || [])[0];
  const status = record.taskStatus ?? task.status ?? record.STTS ?? task.STTS ?? post.taskStatus ?? statusData?.customColumnData ?? statusColumn?.optionName ?? 'unknown';
  const properties = taskFields(columns, names || columnNames(record.projectColumns));
  const body = content || postContent({ ...record, content: record.content || post.content || '' });
  const images = uniqueImages(body.contentImages, (record.imageAttachments || []).map(item => image(item, 'Issue screenshot')));
  const files = [...body.contentFiles, ...(record.attachments || []).map(item => ({ url: item.FILE_DOWN_URL || item.ATCH_URL, name: item.ORCP_FILE_NM || 'Attachment' }))].filter(item => item.url);
  return { id: `${source.id}:${projectId}:${taskId}`, externalId: taskId, postId: String(post.postId || record.postId),
    sourceId: source.id, source: source.type, sourceName: source.name, projectId: String(projectId),
    projectName: record.projectTitle || post.projectTitle || String(projectId),
    title: text(properties.title || record.title || post.title || task.TASK_NM || task.content) || `Task ${taskId}`,
    description: body.description, contentImages: body.contentImages, contentFiles: body.contentFiles, images, files, comments: taskComments(record.remarks), fields: properties.fields,
    reporter: properties.reporter || text(record.registerName), createdAt: properties.createdAt || flowDate(record.registeredDateTime), updatedAt: properties.updatedAt || flowDate(record.editedDateTime),
    startDate: properties.startDate || '', section: properties.section || text(task.SECTION_NAME), taskNumber: properties.taskNumber || String(task.TASK_NUM || ''),
    status: String(status), statusName: statusData?.optionName || statusData?.OPTION_NAME || '', statusCategory: statusData?.optionCategory || statusData?.OPTION_CATEGORY || '', priority: String(properties.priorityName || record.priority || record.PRIORITY || task.priority || task.PRIORITY || 'normal').toLowerCase(),
    assignees: taskAssignees(record), repositoryId: source.repositoryId || '', category: '',
    dueDate: properties.dueDate || flowDate(record.scheduleFinishDateTime || record.END_DT || task.endDate || task.END_DT || post.scheduleFinishDateTime || ''),
    url: record.connectUrl || record.tinyUrl || '', syncedAt: now(), active: true,
    raw: { post: record, summary: post }, demo: false };
}

export class Sources {
  constructor(store, { fetcher = fetch, onSynced = () => {} } = {}) { this.store = store; this.fetcher = fetcher; this.onSynced = onSynced; this.syncing = false; }
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
    } finally { this.syncing = false; this.onSynced(); }
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
          if (task.assignees.includes(identity(account)) && matchesTaskStatus(task, source.statusFilter, source.statuses)) fetched.push(task);
          const record = detail.post || detail;
          for (const subtask of record.subTasks || []) {
            const nested = subtaskRecord(subtask, { ...record, title: record.title || post.title, content: record.content || post.content || '' });
            const child = normalizeTask(source, projectId, { ...post, title: nested.record.title, taskId: nested.record.taskId }, nested.record, { content: nested.content });
            if (child.assignees.includes(identity(account)) && matchesTaskStatus(child, source.statusFilter, source.statuses)) fetched.push({ ...child, parentPostId: String(post.postId) });
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
      const reusable = previous?.detailLoaded && task.detailLoaded === false && previous.postId === task.postId && (!task.updatedAt || previous.updatedAt === task.updatedAt);
      const detail = reusable ? Object.fromEntries(['description', 'contentImages', 'contentFiles', 'images', 'files', 'comments', 'url', 'detailLoadedAt'].map(key => [key, previous[key]])) : {};
      this.store.put('task', task.id, { ...task, ...detail, ...(reusable ? { detailLoaded: true, raw: { ...task.raw, post: previous.raw?.post } } : {}), category: previous?.category || '', runId: previous?.runId });
    }
    for (const set of statusSets) this.store.put('statuses', `${source.id}:${set.projectId}`, set);
    const employee = (this.store.get('directory', source.id)?.employees || []).find(item => identity(item.id) === identity(account) || identity(item.email) === identity(account));
    const result = { sourceId: source.id, name: source.name, count: fetched.length, account, accountName: employee?.name || '', accountSource: source.userId ? 'chosen in Settings' : 'owner of the API key',
      verified: fetched.filter(task => task.assignees.includes(identity(account))).length, at: now() };
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
    const names = columnNames(definitions.columns);
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
        const task = normalizeTask(source, projectId, row, { ...row, title: '', content: '' }, { names });
        if (matchesTaskStatus(task, source.statusFilter, source.statuses)) tasks.push({ ...task, parentTaskId: row.upTaskId && row.upTaskId !== '-1' ? row.upTaskId : '', parentTitle: text(row.upTaskName), description: '', detailLoaded: false });
      }
      if (!page.hasNext) break;
      if (page.lastCursor === undefined || Number(page.lastCursor) < 0) throw new Error('Filtered task API omitted its next cursor.');
      cursor = page.lastCursor;
    }
    return [...new Map(tasks.map(task => [task.id, task])).values()];
  }
  async taskDetail(taskId, { refresh = false } = {}) {
    const task = this.store.get('task', taskId);
    if (!task) throw new Error('Task not found.');
    if (task.demo || (!refresh && task.detailLoaded !== false)) return task;
    const source = this.store.config().sources.find(item => item.id === task.sourceId);
    if (!source) throw new Error('Source connection no longer exists.');
    const detail = await this.request(source, `/user/posts/${encodeURIComponent(task.postId)}`), record = detail.post || detail;
    const child = record.subTasks?.find(item => String(item.taskId || item.TASK_SRNO) === task.externalId);
    const nested = child ? subtaskRecord(child, record) : null;
    const normalized = normalizeTask(source, task.projectId, { postId: task.postId, taskId: task.externalId }, nested ? nested.record : record, nested ? { content: nested.content } : {});
    const kept = Object.fromEntries(['title', 'taskNumber', 'projectName', 'reporter', 'createdAt', 'updatedAt', 'startDate', 'dueDate', 'section', 'status', 'statusName', 'statusCategory']
      .filter(key => task[key] && (!normalized[key] || ['title', 'taskNumber', 'projectName', 'status', 'statusName', 'statusCategory'].includes(key))).map(key => [key, task[key]]));
    const fresh = { ...task, ...normalized, ...kept, fields: normalized.fields.length ? normalized.fields : task.fields || [],
      comments: child ? task.comments || [] : normalized.comments, raw: { ...task.raw, post: record },
      id: task.id, externalId: task.externalId, category: task.category, runId: task.runId, parentTaskId: task.parentTaskId,
      parentTitle: task.parentTitle, assignees: task.assignees?.length ? task.assignees : normalized.assignees, detailLoaded: true, detailLoadedAt: now() };
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

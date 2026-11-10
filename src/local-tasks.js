import { randomUUID } from 'node:crypto';

// Rex Desk's own task list, for work that lives in no tracker: a personal project, an idea, a step an agent splits off.
// Modelled on Orbit's tasks: a status workflow, tags, a checklist, subtasks and blockers, an assigned agent, and comments.
// A local task is an ordinary task record (source "local"), so it can be assigned, dispatched and ranked like a synced one.
export const LOCAL_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'];
export const STATUS_NAMES = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done' };
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
// A run moving through its phases moves its local task along the same way a tracker status would.
const PHASE_STATUS = { working: 'in_progress', review: 'in_review', done: 'done' };

const now = () => new Date().toISOString();
const text = (value, limit) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, limit);
const list = (value, limit = 20, size = 60) => [...new Set([].concat(value || []).flatMap(item => String(item).split(',')).map(item => item.trim().slice(0, size)).filter(Boolean))].slice(0, limit);
const day = value => { const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || '')); return match ? match[1] : ''; };

export class LocalTasks {
  constructor(store) { this.store = store; }
  all() { return this.store.list('task').filter(task => task.local); }
  get(id) {
    const key = String(id || '').replace(/^#/, ''), task = this.store.get('task', key) || this.all().find(item => item.taskNumber === key || item.taskNumber === key.toUpperCase());
    if (!task?.local) throw new Error(`No Rex Desk task "${id}". Tasks from Flow or Morningmate are changed in their tracker.`);
    return task;
  }
  nextNumber() { return Math.max(0, ...this.all().map(task => Number(String(task.taskNumber).replace(/^L/, '')) || 0)) + 1; }
  project(slug) { const value = text(slug, 80).toLowerCase(); return value; }
  agentId(value) {
    if (!value) return '';
    const key = String(value).replace(/^@/, '').toLowerCase(), agent = this.store.list('specialist').find(item => [item.id, item.name, item.slug].some(field => String(field || '').toLowerCase() === key));
    if (!agent) throw new Error(`No agent "${value}". Use an agent's name or handle.`);
    return agent.id;
  }
  checkLinks(task, { parentTaskId, blockedBy }) {
    if (parentTaskId) { const parent = this.get(parentTaskId); if (parent.id === task.id) throw new Error('A task cannot be its own parent.'); }
    for (const id of blockedBy || []) if (this.get(id).id === task.id) throw new Error('A task cannot block itself.');
  }
  fields(input, previous = {}) {
    const status = input.status !== undefined ? String(input.status) : previous.status || 'todo';
    if (!LOCAL_STATUSES.includes(status)) throw new Error(`Status must be one of: ${LOCAL_STATUSES.join(', ')}.`);
    const priority = input.priority !== undefined ? String(input.priority || 'normal') : previous.priority || 'normal';
    if (!PRIORITIES.includes(priority)) throw new Error(`Priority must be one of: ${PRIORITIES.join(', ')}.`);
    const pick = (key, make) => input[key] !== undefined ? make(input[key]) : previous[key];
    return {
      title: pick('title', value => text(value, 200)), description: pick('description', value => text(value, 20000)), status, statusName: STATUS_NAMES[status], priority,
      projectSlug: pick('project', value => this.project(value)) ?? '', dueDate: pick('dueDate', day) ?? '', tags: pick('tags', value => list(value)) ?? [],
      checklist: pick('checklist', value => [].concat(value || []).map(item => typeof item === 'string' ? { text: text(item, 300), done: false } : { text: text(item.text, 300), done: Boolean(item.done) }).filter(item => item.text).slice(0, 50)) ?? [],
      parentTaskId: pick('parentTaskId', value => value ? this.get(value).id : '') ?? '', blockedBy: pick('blockedBy', value => [].concat(value || []).filter(Boolean).map(id => this.get(id).id)) ?? [],
      assignee: pick('assignee', value => this.agentId(value)) ?? '',
    };
  }
  create(input = {}, { by = 'you' } = {}) {
    const fields = this.fields(input);
    if (!fields.title) throw new Error('Give the task a title.');
    const number = this.nextNumber(), id = `local:${randomUUID()}`;
    const task = { id, local: true, source: 'local', sourceId: 'local', sourceName: 'Rex Desk', externalId: String(number), taskNumber: `L${number}`, ...fields,
      projectName: fields.projectSlug, comments: [], active: true, detailLoaded: true, createdBy: text(by, 60), createdAt: now(), updatedAt: now() };
    this.checkLinks(task, fields);
    this.store.put('task', id, task); return task;
  }
  update(id, input = {}, { by = 'you', force = false } = {}) {
    const task = this.get(id), fields = this.fields(input, task);
    if (!fields.title) throw new Error('A task needs a title.');
    this.checkLinks(task, fields);
    // Like Orbit, a task is not done while a blocker or a subtask is still open, unless the caller insists.
    if (fields.status === 'done' && task.status !== 'done' && !force) {
      const open = [...fields.blockedBy.map(blocker => this.store.get('task', blocker)), ...this.all().filter(item => item.parentTaskId === task.id)].filter(item => item && item.status !== 'done');
      if (open.length) throw new Error(`Still open: ${open.map(item => `#${item.taskNumber} ${item.title}`).join(', ')}. Finish those first, or pass force.`);
    }
    const updated = { ...task, ...fields, projectName: fields.projectSlug, updatedAt: now(), updatedBy: text(by, 60), ...(fields.status === 'done' && task.status !== 'done' ? { doneAt: now() } : {}) };
    if (input.comment) updated.comments = [...(task.comments || []), { by: text(by, 60), text: text(input.comment, 4000), at: now() }].slice(-200);
    this.store.put('task', task.id, updated); return updated;
  }
  comment(id, body, { by = 'you' } = {}) {
    const task = this.get(id), note = text(body, 4000);
    if (!note) throw new Error('Write the comment first.');
    const updated = { ...task, comments: [...(task.comments || []), { by: text(by, 60), text: note, at: now() }].slice(-200), updatedAt: now() };
    this.store.put('task', task.id, updated); return updated;
  }
  remove(id) {
    const task = this.get(id);
    for (const child of this.all().filter(item => item.parentTaskId === task.id)) this.store.put('task', child.id, { ...child, parentTaskId: '' });
    for (const other of this.all().filter(item => item.blockedBy?.includes(task.id))) this.store.put('task', other.id, { ...other, blockedBy: other.blockedBy.filter(blocker => blocker !== task.id) });
    this.store.delete('task', task.id); return { removed: true };
  }
  // The run's phase moves the task: working is In progress, review is In review, done is Done.
  phase(task, phase) {
    const status = PHASE_STATUS[phase]; if (!status) return { skipped: true, reason: `No status for ${phase}.` };
    return { status, task: this.update(task.id, { status }, { by: 'agent run', force: true }) };
  }
}

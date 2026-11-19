import { randomUUID } from 'node:crypto';

// Rex Desk's own task list, for work that lives in no tracker: a personal project, an idea, a step an agent splits off.
// Modelled on Orbit's tasks: a status workflow, tags, a checklist, subtasks and blockers, an assigned agent, and comments.
// A local task is an ordinary task record (source "local"), so it can be assigned, dispatched and ranked like a synced one.
export const LOCAL_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'];
export const STATUS_NAMES = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done' };
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
// A run moving through its phases moves its local task along the same way a tracker status would.
const PHASE_STATUS = { working: 'in_progress', review: 'in_review', done: 'done' };
// How long adding a task waits for the cloud to hand out its number before counting on this computer.
const CLAIM_MS = 5000;

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
      projectSlug: (input.project !== undefined ? this.project(input.project) : previous.projectSlug) ?? '', dueDate: pick('dueDate', day) ?? '', tags: pick('tags', value => list(value)) ?? [],
      checklist: pick('checklist', value => [].concat(value || []).map(item => typeof item === 'string' ? { text: text(item, 300), done: false } : { text: text(item.text, 300), done: Boolean(item.done) }).filter(item => item.text).slice(0, 50)) ?? [],
      parentTaskId: pick('parentTaskId', value => value ? this.get(value).id : '') ?? '', blockedBy: pick('blockedBy', value => [].concat(value || []).filter(Boolean).map(id => this.get(id).id)) ?? [],
      assignee: pick('assignee', value => this.agentId(value)) ?? '',
    };
  }
  // The number comes from the account's cloud database when it is on, so two computers adding a task at the same moment get
  // different numbers. Without the cloud (or when it is slow) this computer counts on; a number that turns out to be taken
  // twice is settled once the computers see each other's tasks (settle).
  async number(id) {
    const floor = this.nextNumber(), cloud = this.store.cloud;
    if (!cloud?.ready || !cloud.claimNumber) return floor;
    let timer;
    try {
      const claimed = await Promise.race([cloud.claimNumber('task', id, floor), new Promise(resolve => { timer = setTimeout(resolve, CLAIM_MS, null); })]);
      return Number.isInteger(claimed) ? Math.max(claimed, this.nextNumber()) : this.nextNumber();
    } catch { return this.nextNumber(); } finally { clearTimeout(timer); }
  }
  async create(input = {}, { by = 'you' } = {}) {
    const fields = this.fields(input);
    if (!fields.title) throw new Error('Give the task a title.');
    const id = `local:${randomUUID()}`, number = await this.number(id);
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
  // Two tasks with one number (made at once while a computer was offline, or before tasks were shared): the one that holds the
  // number in the cloud keeps it, else the older one. The later one gets a new number, changed only by the computer that made
  // it so the two computers never both renumber it, with a comment saying what it was called before.
  async settle() {
    if (this.settling) return this.settling;
    this.settling = (async () => {
      const groups = new Map();
      for (const task of this.all()) groups.set(task.taskNumber, [...(groups.get(task.taskNumber) || []), task]);
      const twice = [...groups.values()].filter(group => group.length > 1);
      const cloud = this.store.cloud;
      // This computer's numbers go to the cloud once each (per start), so the cloud also knows numbers given out without it.
      const claimed = this.claimed ||= new Set(), mine = this.all().filter(task => task.node === this.store.nodeId && !claimed.has(`${task.id} ${task.taskNumber}`));
      if (cloud?.ready && cloud.claimTaken && mine.length) await cloud.claimTaken('task', mine.map(task => ({ number: Number(String(task.taskNumber).replace(/^L/, '')) || 0, id: task.id })).filter(item => item.number))
        .then(() => { for (const task of mine) claimed.add(`${task.id} ${task.taskNumber}`); }, () => {});
      if (!twice.length) return [];
      const owners = await cloud?.numberOwners?.('task').catch(() => null), moved = [];
      for (const group of twice) {
        const number = Number(String(group[0].taskNumber).replace(/^L/, '')), owner = owners?.get(number);
        const keep = group.find(task => task.id === owner) || [...group].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id))[0];
        for (const task of group) {
          if (task.id === keep.id || task.node !== this.store.nodeId) continue;
          const fresh = this.store.get('task', task.id); if (!fresh || fresh.taskNumber !== task.taskNumber) continue;
          const next = await this.number(task.id);
          const note = { by: 'Rex Desk', text: `Renumbered from ${task.taskNumber} to L${next}: another computer gave ${task.taskNumber} to "${keep.title}" first.`, at: now() };
          moved.push(this.store.put('task', task.id, { ...fresh, taskNumber: `L${next}`, externalId: String(next), renumberedFrom: task.taskNumber, comments: [...(fresh.comments || []), note].slice(-200), updatedAt: now() }));
        }
      }
      return moved;
    })().finally(() => { this.settling = null; });
    return this.settling;
  }
  // The run's phase moves the task: working is In progress, review is In review, done is Done.
  phase(task, phase) {
    const status = PHASE_STATUS[phase]; if (!status) return { skipped: true, reason: `No status for ${phase}.` };
    return { status, task: this.update(task.id, { status }, { by: 'agent run', force: true }) };
  }
}

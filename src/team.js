// The team: one agent (Rex Agent, or an agent that manages a project) gives tasks to the other agents and stays free to
// talk with the person. Each task has a clear state, the same ones A2A uses:
//
//   queued    the worker is busy; the task starts when it is free
//   working   the worker is on it
//   needs-manager   the worker asked a question; the manager answers it (or asks the person)
//   done / failed / canceled
//
// The manager never waits: the result is put in its chat and handed to it when the worker's turn ends.
import crypto from 'node:crypto';

const now = () => new Date().toISOString();
const open = new Set(['queued', 'working', 'needs-manager']);
export const MAX_OPEN_TASKS = 8;   // per manager: more than this and the manager is flooding its team
const short = id => String(id).slice(0, 8);
const clip = (text, size) => { const value = String(text || '').trim(); return value.length > size ? `${value.slice(0, size)}…` : value; };

export class Team {
  constructor(desk) { this.desk = desk; }
  get store() { return this.desk.store; }
  agentOf(runId) { const run = this.store.get('run', runId); return run ? run.roomAgent || run.specialistId || (run.role === 'coordinator' && run.main ? 'main' : '') : ''; }
  nameOf(agentId) { return agentId === 'main' ? 'Rex Agent' : this.store.get('specialist', agentId)?.name || 'an agent'; }
  find(wanted) {
    const key = String(wanted || '').trim().toLowerCase().replace(/^@/, '');
    return this.store.list('specialist').find(agent => agent.id !== 'main' && agent.kind !== 'main' && [agent.id, agent.name, agent.handle].some(value => String(value || '').toLowerCase() === key)) || null;
  }
  tasks(filter = () => true) { return this.store.list('team-task').filter(filter).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  get(managerId, taskId) {
    const key = String(taskId || '').toLowerCase();
    const task = this.tasks(item => item.managerId === managerId).find(item => item.id === key || short(item.id) === key);
    if (!task) throw new Error('No such task of yours. See them with desk_team.');
    return task;
  }
  view(task) { return { id: short(task.id), agent: task.workerName, title: task.title, state: task.state, ...(task.question ? { question: task.question } : {}), ...(task.answer ? { result: clip(task.answer, 6000) } : {}), since: task.createdAt }; }

  // Who the manager can give work to, and what each is doing for it.
  overview(runId) {
    const managerId = this.agentOf(runId); if (!managerId) throw new Error('Only an agent in a chat has a team.');
    const mine = this.tasks(item => item.managerId === managerId);
    return {
      agents: this.store.list('specialist').filter(agent => agent.id !== 'main' && agent.kind !== 'main' && agent.id !== managerId).map(agent => {
        const run = agent.runId ? this.store.get('run', agent.runId) : null;
        return { name: agent.name, for: clip(agent.purpose || agent.projectName || '', 160), busy: Boolean(run && this.desk.live.has(run.id)), openTasks: this.tasks(item => item.workerId === agent.id && open.has(item.state)).length };
      }),
      tasks: [...mine.filter(item => open.has(item.state)), ...mine.filter(item => !open.has(item.state)).slice(-5)].map(item => this.view(item)),
    };
  }

  async delegate(runId, { agent, task, title = '' }) {
    const managerId = this.agentOf(runId); if (!managerId) throw new Error('Only an agent in a chat can give a task.');
    const text = String(task || '').trim().slice(0, 8000); if (text.length < 3) throw new Error('Say what the task is.');
    const worker = this.find(agent); if (!worker) throw new Error(`No agent "${agent}" here. See your team with desk_team.`);
    if (worker.id === managerId) throw new Error('That is you. Do it yourself, or give it to another agent.');
    // A worker in the middle of a task from this agent does not hand work back up: that is how two agents end up waiting on each other.
    if (this.tasks(item => item.workerId === managerId && item.managerId === worker.id && open.has(item.state)).length) throw new Error(`${worker.name} gave you a task that is still open. Finish it, or ask with a line starting "NEED:".`);
    if (this.tasks(item => item.managerId === managerId && open.has(item.state)).length >= MAX_OPEN_TASKS) throw new Error(`You already have ${MAX_OPEN_TASKS} tasks open. Wait for results, or cancel one.`);
    const record = { id: crypto.randomUUID(), managerId, managerRunId: runId, workerId: worker.id, workerName: worker.name, title: clip(String(title || text).replace(/\s+/g, ' '), 80), text, state: 'queued', createdAt: now() };
    this.store.put('team-task', record.id, record);
    await this.startNext(worker.id);
    const state = this.store.get('team-task', record.id).state;
    return { id: short(record.id), agent: worker.name, state, note: state === 'working' ? `${worker.name} is on it. End your reply; the result reaches you when it is done.` : `${worker.name} is busy; this starts when it is free. End your reply; the result reaches you when it is done.` };
  }

  // One task at a time for each worker: the oldest waiting one starts when the worker is free.
  async startNext(workerId) {
    if (this.tasks(item => item.workerId === workerId && item.state === 'working').length) return;
    const worker = this.store.get('specialist', workerId), run = worker?.runId ? this.store.get('run', worker.runId) : null;
    if (run && this.desk.live.has(run.id)) return;
    const next = this.tasks(item => item.workerId === workerId && item.state === 'queued')[0]; if (!next) return;
    const manager = this.nameOf(next.managerId);
    const prompt = `Task ${short(next.id)} from ${manager}, who is managing this work for the person: ${next.title}\n\n${next.text}\n\nDo it now. Your last reply of this turn goes back to ${manager} as the result, so end with what you did and what you found. If you cannot go on without an answer, end your reply with a line that starts with "NEED:" and your question; ${manager} answers it.`;
    this.store.put('team-task', next.id, { ...next, state: 'working', startedAt: now() });
    try {
      const started = await this.desk.specialistTurn(workerId, { prompt, quiet: true });
      const runIdNow = started?.id || this.store.get('specialist', workerId)?.runId || '';
      this.store.put('team-task', next.id, { ...this.store.get('team-task', next.id), runId: runIdNow });
      if (runIdNow) this.store.event(runIdNow, 'message', { text: `**Task from ${manager}: ${next.title}**\n\n${clip(next.text, 2000)}`, team: short(next.id) }, true);
    } catch (error) { this.finish(next.id, 'failed', `It could not start: ${error.message}`); }
  }

  // A worker's turn ended: its task is done, or it asked its manager something.
  turnEnded(runId, failure = '') {
    const task = this.tasks(item => item.runId === runId && item.state === 'working')[0];
    if (!task) { const agentId = this.agentOf(runId); if (agentId) void this.startNext(agentId).catch(() => {}); return; }
    const said = this.store.events(runId, { visible: true, limit: 80 }).filter(event => event.kind === 'agent-text' && event.text && String(event.createdAt || '') >= task.startedAt).map(event => String(event.text).trim());
    if (failure) return this.finish(task.id, 'failed', `It did not work: ${failure}`);
    const last = said.at(-1) || '';
    if (!last) return this.finish(task.id, 'failed', 'It ended without an answer.');
    const question = last.match(/^\s*NEED:\s*([\s\S]+)$/m)?.[1]?.trim();
    if (question) return this.finish(task.id, 'needs-manager', last, clip(question, 2000));
    this.finish(task.id, 'done', last);
  }

  finish(taskId, state, answer = '', question = '') {
    const task = this.store.get('team-task', taskId); if (!task) return;
    const next = { ...task, state, answer: clip(answer, 12000), question, endedAt: now() };
    this.store.put('team-task', taskId, next);
    this.tell(next);
    if (state !== 'needs-manager') void this.startNext(task.workerId).catch(() => {});
  }

  // The result goes in the manager's chat for the person to read, and is handed to the manager: now if it is idle, else with its next step.
  tell(task) {
    const desk = this.desk, manager = this.store.get('run', task.managerRunId) || (task.managerId !== 'main' && this.store.get('run', this.store.get('specialist', task.managerId)?.runId)); if (!manager) return;
    const head = task.state === 'done' ? 'done' : task.state === 'needs-manager' ? 'needs an answer' : task.state === 'canceled' ? 'canceled' : 'failed';
    this.store.event(manager.id, 'message', { text: `**${task.workerName} · ${task.title} · ${head}**\n\n${clip(task.question || task.answer, 6000)}`, team: short(task.id) }, true);
    const prompt = task.state === 'needs-manager'
      ? `${task.workerName} cannot go on with task ${short(task.id)} (${task.title}) and asks:\n${task.question}\n\nAnswer with desk_team_answer if you know. If only the person can decide, ask them, then pass the answer on.`
      : `Task ${short(task.id)} that you gave ${task.workerName} (${task.title}) ended: ${head}.\n${clip(task.answer, 6000)}\n\nCarry on: use the result, give the next task if there is one, and tell the person the outcome in a line or two when it matters to them.`;
    const current = this.store.get('run', manager.id);
    if (desk.live.has(manager.id) || desk.closed) { this.store.put('run', manager.id, { ...current, queued: [...(current.queued || []), prompt] }); return; }
    void desk.resume(manager.id, { prompt, silent: true }).catch(error => this.store.event(manager.id, 'error', { message: error.message }, true));
  }

  async answer(runId, { id, text }) {
    const task = this.get(this.agentOf(runId), id), reply = String(text || '').trim().slice(0, 6000);
    if (task.state !== 'needs-manager') throw new Error(`That task is ${task.state}; it is not waiting for an answer.`);
    if (!reply) throw new Error('Say the answer.');
    this.store.put('team-task', task.id, { ...task, state: 'working', question: '', startedAt: now() });
    const prompt = `${this.nameOf(task.managerId)} answers your question on task ${short(task.id)} (${task.title}):\n${reply}\n\nCarry on with the task. Your last reply of this turn goes back as the result.`;
    try { await this.desk.specialistTurn(task.workerId, { prompt, quiet: true }); } catch (error) { this.finish(task.id, 'failed', `It could not carry on: ${error.message}`); throw error; }
    return { id: short(task.id), state: 'working' };
  }

  async cancel(runId, { id }) {
    const task = this.get(this.agentOf(runId), id);
    if (!open.has(task.state)) throw new Error(`That task already ended (${task.state}).`);
    const wasWorking = task.state === 'working';
    this.store.put('team-task', task.id, { ...task, state: 'canceled', endedAt: now() });
    if (wasWorking && task.runId && this.desk.live.has(task.runId)) await this.desk.stop(task.runId).catch(() => {});
    void this.startNext(task.workerId).catch(() => {});
    return { id: short(task.id), state: 'canceled' };
  }
}

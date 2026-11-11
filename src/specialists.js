import { randomUUID } from 'node:crypto';
import { modelName, thisComputer } from './store.js';
import { modelList } from './choices.js';
import { redactText } from './memory.js';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const EVIDENCE_RULE = 'Whenever you test something (run the tests, check it in a browser or the app), share the proof with desk_share_evidence: a screenshot or a short screen recording of what you saw, or the test output file, marked passed or failed, with one line on what you tested. It is posted in the chat you are talking in and kept on the task, so the person can check your work without asking.';

const now = () => new Date().toISOString();
const slugOf = name => String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const atomic = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, text); renameSync(temporary, file); };

// A specialist is the identity of one agent for one project: its name, what it knows, its rules, and which model it uses.
// The identity card is saved in .rexdesk/agents so every other agent can read it. A duplicate shares the project but is its own agent.
export class Specialists {
  constructor(desk) { this.desk = desk; this.store = desk.store; this.memory = desk.memory; }

  list() { return this.store.list('specialist').filter(item => item.kind !== 'main').sort((left, right) => left.name.localeCompare(right.name)); }
  // The main agent as a room member. Its session is the main agent's run, so it answers in rooms with everything it knows.
  ensureMain() {
    const existing = this.store.get('specialist', 'main');
    // The main agent is called Rex Agent (@rex); a record saved under its old name is renamed once.
    if (existing && existing.name === 'Main agent') { const renamed = { ...existing, name: 'Rex Agent', slug: 'rex' }; this.store.put('specialist', 'main', renamed); for (const run of this.store.list('run').filter(item => item.title === 'Main agent')) this.store.put('run', run.id, { ...run, title: 'Rex Agent' }); return renamed; }
    if (existing) return existing;
    const item = { id: 'main', kind: 'main', name: 'Rex Agent', slug: 'rex', projectSlug: 'all projects', projectPath: '', repositoryId: '', purpose: 'Knows every project and agent, and helps the person decide who does what.', rules: '', unsure: [], provider: 'claude', model: '', createdBy: 'Rex Desk', cloneOf: '', runId: '', roomSeen: {}, createdAt: now(), updatedAt: now() };
    this.store.put('specialist', 'main', item); return item;
  }
  get(id) { const item = this.store.get('specialist', id); if (!item) throw new Error('Specialist not found.'); return item; }
  cardFile(item) { return this.memory.file('agents', `${item.slug}.md`); }

  // The model must be one of the listed ones. A value typed by hand in an older version ("Opus 5.5") is turned into the listed id, or dropped.
  cleanModel(value, { strict = false } = {}) {
    const text = String(value || '').trim();
    if (!text) return '';
    const list = modelList(this.store), id = modelName('claude', text);
    if (list.some(item => item.id === text)) return text;
    if (list.some(item => item.id === id)) return id;
    const byName = list.find(item => item.label.toLowerCase() === text.toLowerCase()); if (byName) return byName.id;
    if (strict) throw new Error('Choose a model from the list.');
    return '';
  }
  // A saved model that the current list does not have is set back to the default, so an agent never fails to start on it.
  normalizeModels() { for (const agent of this.store.list('specialist')) { const model = this.cleanModel(agent.model); if (model !== (agent.model || '')) this.store.put('specialist', agent.id, { ...agent, model }); } }
  checkName(name, exceptId = '') {
    const text = String(name || '').trim().replace(/\s+/g, ' ');
    if (!text) throw new Error('Give the agent a name.');
    if (text.length > 40) throw new Error('Keep the name under 40 characters.');
    const slug = slugOf(text);
    if (!slug) throw new Error('Use letters or numbers in the name.');
    if (this.list().some(item => item.id !== exceptId && (item.slug === slug || item.name.toLowerCase() === text.toLowerCase()))) throw new Error(`An agent named "${text}" already exists. Choose another name.`);
    return { name: text, slug };
  }

  // The project must be one Rex Desk has in memory, so the specialist starts from what is already known about it.
  create({ name, projectSlug, rules = '', unsure = [], provider, model = '', by = 'you', cloneOf = '' }) {
    const project = this.memory.list().find(item => item.slug === String(projectSlug || '').toLowerCase());
    if (!project) throw new Error(`No project "${projectSlug}" in memory. Scan this computer first, then pick one of the projects.`);
    const { name: clean, slug } = this.checkName(name);
    const repository = this.store.config().repositories.find(item => path.resolve(item.path).toLowerCase() === path.resolve(project.path).toLowerCase());
    const item = { id: randomUUID(), name: clean, slug, projectSlug: project.slug, projectPath: project.path, repositoryId: repository?.id || '', purpose: project.purpose || '',
      rules: String(rules).slice(0, 4000), unsure: [].concat(unsure).map(text => String(text).trim().slice(0, 300)).filter(Boolean).slice(0, 12),
      provider: 'claude', model: this.cleanModel(model, { strict: true }), createdBy: String(by).slice(0, 40), cloneOf, runId: '', roomSeen: {}, createdAt: now(), updatedAt: now() };
    this.store.put('specialist', item.id, item); this.writeCard(item); return item;
  }
  update(id, { rules, unsure, provider, model, taskSources, profile }) {
    const item = this.get(id);
    const updated = { ...item, ...(rules !== undefined ? { rules: String(rules).slice(0, 4000) } : {}), ...(unsure !== undefined ? { unsure: [].concat(unsure).map(text => String(text).trim().slice(0, 300)).filter(Boolean).slice(0, 12) } : {}),
      ...(model !== undefined ? { model: this.cleanModel(model, { strict: true }) } : {}), ...(taskSources !== undefined ? { taskSources: this.cleanSources(taskSources) } : {}), ...(profile !== undefined ? { profile: String(profile || '').slice(0, 500) } : {}), updatedAt: now() };
    this.store.put('specialist', id, updated); this.writeCard(updated); return updated;
  }
  // Renaming moves the card too; the run history and the project stay as they are.
  rename(id, name) {
    const item = this.get(id), { name: clean, slug } = this.checkName(name, id);
    if (slug !== item.slug) rmSync(this.cardFile(item), { force: true });
    const updated = { ...item, name: clean, slug, updatedAt: now() };
    this.store.put('specialist', id, updated); this.writeCard(updated); return updated;
  }
  // A duplicate has the same project, rules and notes, a new name, and no conversation of its own yet: it starts fresh from the card.
  duplicate(id, name) {
    const item = this.get(id);
    return this.create({ name, projectSlug: item.projectSlug, rules: item.rules, unsure: item.unsure, provider: item.provider, model: item.model, by: 'you', cloneOf: item.id });
  }
  remove(id) {
    const item = this.get(id);
    if (this.store.list('run').some(run => run.specialistId === id && ['starting', 'running', 'waiting', 'queued', 'verifying'].includes(run.state))) throw new Error('This agent is working. Stop its run first.');
    rmSync(this.cardFile(item), { force: true }); this.store.delete('specialist', id); return { removed: true };
  }

  // What the agent is doing right now, for the chat: working on a task, answering a message, waiting for the person, or idle.
  status(agent) {
    if (this.desk.peers?.isRemote(agent)) return this.desk.peers.statusOf(agent);
    if (agent.kind === 'main') {
      const run = this.store.list('run').filter(item => item.role === 'coordinator' && (item.main ? item.computer === thisComputer() : item.roomAgent === 'main')).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
      if (run?.state === 'waiting') return { state: 'waiting', label: 'Needs you', runId: run.id };
      if (run && ['starting', 'running', 'queued', 'verifying'].includes(run.state)) return { state: 'replying', label: 'Working…', runId: run.id };
      return { state: 'idle', label: 'Idle', runId: run?.id || '' };
    }
    const working = ['starting', 'running', 'queued', 'verifying'], runs = this.store.list('run').filter(run => run.specialistId === agent.id);
    const task = runs.find(run => run.role === 'worker' && [...working, 'waiting'].includes(run.state));
    if (task) {
      const record = this.store.get('task', task.taskId) || {};
      return task.state === 'waiting' ? { state: 'waiting', label: 'Needs you', taskId: task.taskId, runId: task.id }
        : { state: 'busy', label: `Working on #${record.taskNumber || record.externalId || ''} ${record.titleEn || record.title || ''}`.replace(/\s+/g, ' ').trim(), taskId: task.taskId, runId: task.id };
    }
    const sessions = runs.filter(run => run.role === 'specialist'), personal = sessions.find(run => !run.roomAgent);
    const waiting = sessions.find(run => run.state === 'waiting'), active = sessions.find(run => working.includes(run.state));
    if (waiting) return { state: 'waiting', label: 'Needs you', runId: waiting.id };
    if (active) return { state: 'replying', label: active.roomAgent ? 'Replying in a room…' : 'Replying…', runId: active.id };
    return { state: 'idle', label: 'Idle', runId: personal?.id || sessions[0]?.id || '' };
  }
  // Lessons the agent learned from the person's corrections. Kept on the agent (newest last, at most 30) and given to it with every turn.
  learn(agentId, text, by = 'agent') {
    if (agentId === 'main') this.ensureMain();
    const agent = this.get(agentId), lesson = redactText(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, 300);
    if (!lesson) throw new Error('Write the lesson first.');
    const lessons = (agent.lessons || []).filter(item => item.text.toLowerCase() !== lesson.toLowerCase());
    const updated = { ...agent, lessons: [...lessons, { text: lesson, at: now(), by: String(by).slice(0, 40) }].slice(-30), updatedAt: now() };
    this.store.put('specialist', agentId, updated); if (agent.kind !== 'main') this.writeCard(updated); return { saved: true, lessons: updated.lessons.length };
  }
  forget(agentId, index) {
    const agent = this.get(agentId), lessons = [...(agent.lessons || [])];
    if (!lessons[index]) throw new Error('That lesson is gone.');
    lessons.splice(index, 1); const updated = { ...agent, lessons, updatedAt: now() };
    this.store.put('specialist', agentId, updated); if (agent.kind !== 'main') this.writeCard(updated); return updated;
  }
  lessonsText(agentId) {
    const agent = agentId && this.store.get('specialist', agentId), lessons = agent?.lessons || [];
    return lessons.length ? `Lessons you learned from the person (follow them):\n${lessons.map(item => `- ${item.text}`).join('\n')}` : '';
  }
  // The agent's own folder. It is named by id, so renaming the agent never loses its session.
  homeDirectory(agent) { return this.memory.file('agents', 'home', agent.id); }
  // Where an agent's tasks come from: "local" (Rex Desk tasks) and/or connected trackers by id. Names are accepted too.
  cleanSources(value) {
    const sources = this.store.config().sources;
    return [...new Set([].concat(value || []).map(item => String(item).trim()).filter(Boolean).map(item => {
      const key = item.toLowerCase();
      if (['local', 'rex desk', 'rex desk tasks', 'here'].includes(key)) return 'local';
      const found = sources.find(source => [source.id, source.name, source.type].some(field => String(field || '').toLowerCase() === key));
      if (!found) throw new Error(`No task source "${item}". Use "local" or one of: ${sources.map(source => source.name).join(', ') || 'no trackers connected'}.`);
      return found.id;
    }))];
  }
  sourceNames(agent) {
    const sources = this.store.config().sources;
    return (agent.taskSources || []).map(id => id === 'local' ? 'Rex Desk tasks (kept here)' : sources.find(source => source.id === id)?.name || 'a tracker that was removed');
  }
  tasksText(agent) {
    const names = this.sourceNames(agent);
    return names.length ? `Your tasks come from: ${names.join(' and ')}. Read them with desk_tasks; it lists only those. Create and update Rex Desk tasks with desk_create_task and desk_update_task.`
      : 'Nobody has told you where this project keeps its tasks yet. Before looking for tasks, ask the person (desk_ask) whether they live in a connected tracker, in Rex Desk tasks, or somewhere else, and save the answer with desk_set_task_sources. Never assume Flow or Morningmate.';
  }
  identity(agent) {
    return [`You are ${agent.name}, the specialist agent for the project "${agent.projectSlug}" at ${agent.projectPath}. You keep one conversation of your own, and you take part in the person's group chats when you are mentioned.`,
      agent.purpose ? `What the project is for: ${agent.purpose}` : '', agent.rules ? `Rules from the person:\n${agent.rules}` : '', agent.unsure?.length ? `Still unsure about: ${agent.unsure.join('; ')}` : '', this.tasksText(agent),
      this.memory.chatStyle(), this.memory.person() ? `What you know about the person (all agents share this). Follow "How to explain things to me" in every answer:\n${this.memory.person()}` : '', this.lessonsText(agent.id), "Notice what the person likes and dislikes from how they react to you: corrections, praise, frustration, things they ask for again. Save what you notice with desk_learn_person; lessons about your own work go to desk_learn. Preferences can change with time and events: treat the notes about the person as hints, prefer the newest, and when what the person says now differs, follow what they say now and update the note with replaces.", this.memory.secondBrain(),
      "When the person corrects you or tells you how they want something done, save one short, general lesson with desk_learn (for example \"Morningmate QA issues: check global/release, not global/develop\"), then follow it. Never save secrets.",
      EVIDENCE_RULE,
      this.memory.workflowText(agent.projectSlug), "When the person tells you how work on a project is done (which branch to start from, where a pull request goes, how to test or sign in, who reviews, what to never touch), or answers a question about it, or corrects a step you took, save it at once with desk_learn_workflow as one short rule. Every agent on that project, now and later, gets these rules, so nobody asks the person the same thing again or repeats the mistake. Before you ask the person how something is done on a project, check its workflow rules first. If a new answer changes an old rule, pass replaces.",
      `Read your project's memory first: desk_memory("${agent.projectSlug}"). Here you only read the project and answer; you never edit the original checkout. Code changes happen on a task, in its own worktree, after the person assigns it. Always call a task by its English name. Do only what the person asks, for the tasks they name: do not widen the scope to sub-tasks, related tasks or other projects without asking first. Use desk_rooms and desk_room_history to read any group chat you are in.`].filter(Boolean).join('\n');
  }
  writeCard(item) {
    const lines = [`# ${item.name}`, '', `- Project: ${item.projectSlug} (\`${item.projectPath}\`)`, `- Agent: Claude Code${item.model ? ` · ${item.model}` : ''}`,
      `- Created by: ${item.createdBy}${item.cloneOf ? ` · duplicate of ${this.store.get('specialist', item.cloneOf)?.name || 'another agent'}` : ''}`, `- Updated: ${item.updatedAt}`, '',
      '## What this project is for', '', item.purpose || 'Not recorded yet.', '', '## Rules from the person', '', item.rules || 'None yet.', '',
      '## Still not sure about', '', item.unsure.length ? item.unsure.map(text => `- ${text}`).join('\n') : 'Nothing open.', '', '## Tasks come from', '', this.sourceNames(item).join(', ') || 'Not set yet.', '',
      '## Lessons learned', '', (item.lessons || []).length ? item.lessons.map(lesson => `- ${lesson.text}`).join('\n') : 'None yet.', '',
      '## Read first', '', `- Project memory: \`projects/${item.projectSlug}.md\` (set up, test, run, and the project's own instructions)`, '- The repository\'s own CLAUDE.md and AGENTS.md before changing anything', ''];
    atomic(this.cardFile(item), lines.join('\n'));
  }
}

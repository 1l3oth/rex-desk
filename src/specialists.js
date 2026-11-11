import { aiProvider } from './codex.js';
import { randomUUID } from 'node:crypto';
import { modelName, thisComputer } from './store.js';
import { modelList } from './choices.js';
import { redactText } from './memory.js';
import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const EXPLAINER = path.join(os.homedir(), '.agents', 'skills', 'code-explainer-page');
// Explaining an idea, a cause or how something works: a picture page in eli5 style, the way the person likes to learn.
export const LOOP_EVERY = [15, 30, 60, 120, 240, 1440];
const LOOP_DEFAULT = { on: true, every: 60, prompt: '' };
const cleanLoop = loop => ({ ...(loop.on !== undefined ? { on: Boolean(loop.on) } : {}), ...(loop.every !== undefined ? { every: LOOP_EVERY.includes(Number(loop.every)) ? Number(loop.every) : 60 } : {}), ...(loop.prompt !== undefined ? { prompt: String(loop.prompt || '').slice(0, 2000) } : {}) });
export const ELI5_RULE = 'When you explain to the person how something works, why something broke, what a choice means, or anything longer than a few lines, explain like they are five: big pictures, few words. Make one self-contained HTML page named eli5-<short-topic>.html in your work folder (inline CSS and inline SVG drawings only, no external files, no emoji; a few numbered picture steps, each with one or two plain sentences; light and dark friendly), never open it yourself, and show it with desk_show_page beside a two or three line answer in the chat. For your own code changes use the code explainer page instead. Short answers and yes/no questions stay plain chat.';
// When the person asks what you changed, they get a page to read, not a wall of text.
const EXPLAIN_RULE = existsSync(path.join(EXPLAINER, 'scripts', 'render.mjs'))
  ? ` When the person asks what you changed or to explain your changes or the code, make a code explainer page: follow ${path.join(EXPLAINER, 'SKILL.md')} (read it first), render the page with \`node "${path.join(EXPLAINER, 'scripts', 'render.mjs')}" <spec.json> --out <folder>/code-explainer-<slug>.html\` (never --open), then show it with desk_show_page and write two or three plain lines beside it.`
  : ' When the person asks what you changed or to explain your changes or the code, make one self-contained HTML page (inline CSS and JS, no internet) with the changed code, plain notes beside the lines and a short picture of the idea, then show it with desk_show_page and write two or three plain lines beside it.';
export const EVIDENCE_RULE = 'Whenever you test something (run the tests, check it in a browser or the app), share the proof with desk_share_evidence: a screenshot or a short screen recording of what you saw, or the test output file, marked passed or failed, with one line on what you tested. It is posted in the chat you are talking in and kept on the task, so the person can check your work without asking.' + EXPLAIN_RULE;

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
    const item = { id: 'main', kind: 'main', name: 'Rex Agent', slug: 'rex', projectSlug: 'all projects', projectPath: '', repositoryId: '', purpose: 'Knows every project and agent, and helps the person decide who does what.', rules: '', unsure: [], provider: this.store.config().provider, model: '', createdBy: 'Rex Desk', cloneOf: '', runId: '', roomSeen: {}, createdAt: now(), updatedAt: now() };
    this.store.put('specialist', 'main', item); return item;
  }
  get(id) { const item = this.store.get('specialist', id); if (!item) throw new Error('Specialist not found.'); return item; }
  cardFile(item) { return this.memory.file('agents', `${item.slug}.md`); }

  // The model must be one of the listed ones. A value typed by hand in an older version ("Opus 5.5") is turned into the listed id, or dropped.
  cleanModel(value, { strict = false, provider = 'claude' } = {}) {
    const text = String(value || '').trim();
    if (!text) return '';
    const list = modelList(this.store, provider), id = modelName(provider, text);
    if (list.some(item => item.id === text)) return text;
    if (list.some(item => item.id === id)) return id;
    const byName = list.find(item => item.label.toLowerCase() === text.toLowerCase()); if (byName) return byName.id;
    if (provider === 'codex' && !list.length) return text;
    if (strict) throw new Error('Choose a model from the list.');
    return '';
  }
  // A saved model that the current list does not have is set back to the default, so an agent never fails to start on it.
  normalizeModels() { for (const agent of this.store.list('specialist')) { const model = this.cleanModel(agent.model, { provider: agent.provider }); if (model !== (agent.model || '')) this.store.put('specialist', agent.id, { ...agent, model }); } }
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
      provider: aiProvider(provider || this.store.config().provider), model: this.cleanModel(model, { strict: true, provider: provider || this.store.config().provider }), createdBy: String(by).slice(0, 40), cloneOf, runId: '', roomSeen: {}, loop: { ...LOOP_DEFAULT }, createdAt: now(), updatedAt: now() };
    this.store.put('specialist', item.id, item); this.writeCard(item); return item;
  }
  update(id, { rules, unsure, provider, model, taskSources, profile, loop }) {
    const item = this.get(id);
    const selectedProvider = aiProvider(provider || item.provider || 'claude');
    const updated = { ...item, provider: selectedProvider, ...(selectedProvider !== item.provider ? { model: '', profile: '' } : {}), ...(rules !== undefined ? { rules: String(rules).slice(0, 4000) } : {}), ...(unsure !== undefined ? { unsure: [].concat(unsure).map(text => String(text).trim().slice(0, 300)).filter(Boolean).slice(0, 12) } : {}),
      ...(model !== undefined ? { model: this.cleanModel(model, { strict: true, provider: selectedProvider }) } : {}), ...(taskSources !== undefined ? { taskSources: this.cleanSources(taskSources) } : {}), ...(profile !== undefined ? { profile: String(profile || '').slice(0, 500) } : {}), ...(loop !== undefined ? { loop: { ...this.loopOf(item), ...cleanLoop(loop) } } : {}), updatedAt: now() };
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
    return names.length ? `Your tasks come from: ${names.join(' and ')}. Read them with desk_tasks; it lists only those. Create and update Rex Desk tasks with desk_create_task and desk_update_task. To work on one of your tasks (or start it again after a failed run), start it yourself with desk_take_task; in a room you then do it right there in the room. Never ask Rex Agent or the person to start a run for you.`
      : 'Nobody has told you where this project keeps its tasks yet. Before looking for tasks, ask the person (desk_ask) whether they live in a connected tracker, in Rex Desk tasks, or somewhere else, and save the answer with desk_set_task_sources. Never assume Flow or Morningmate.';
  }
  // Each agent's own loop: every so often it looks at its own tasks and starts work, following its project's workflow.
  loopOf(agent) { return { ...LOOP_DEFAULT, ...(agent?.loop || {}) }; }
  // The tasks that are this agent's to look at: from the sources chosen for its project, Rex Desk tasks given to it or to nobody on its project, never done ones.
  ownTasks(agent) {
    const sources = agent.taskSources || [];
    return this.store.list('task').filter(task => !task.demo && (task.active || task.local) && task.status !== 'done')
      .filter(task => task.local ? sources.includes('local') && (task.assignee === agent.id || (!task.assignee && (!task.projectSlug || task.projectSlug === agent.projectSlug))) : sources.includes(task.sourceId));
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

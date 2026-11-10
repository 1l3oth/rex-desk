import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const now = () => new Date().toISOString();
const slugOf = name => String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const atomic = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, text); renameSync(temporary, file); };

// A specialist is the identity of one agent for one project: its name, what it knows, its rules, and which model it uses.
// The identity card is saved in .rexdesk/agents so every other agent can read it. A duplicate shares the project but is its own agent.
export class Specialists {
  constructor(desk) { this.desk = desk; this.store = desk.store; this.memory = desk.memory; }

  list() { return this.store.list('specialist').sort((left, right) => left.name.localeCompare(right.name)); }
  get(id) { const item = this.store.get('specialist', id); if (!item) throw new Error('Specialist not found.'); return item; }
  cardFile(item) { return this.memory.file('agents', `${item.slug}.md`); }

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
    if (provider && !['claude', 'codex'].includes(provider)) throw new Error('Choose Claude Code or Codex.');
    const { name: clean, slug } = this.checkName(name);
    const repository = this.store.config().repositories.find(item => path.resolve(item.path).toLowerCase() === path.resolve(project.path).toLowerCase());
    const item = { id: randomUUID(), name: clean, slug, projectSlug: project.slug, projectPath: project.path, repositoryId: repository?.id || '', purpose: project.purpose || '',
      rules: String(rules).slice(0, 4000), unsure: [].concat(unsure).map(text => String(text).trim().slice(0, 300)).filter(Boolean).slice(0, 12),
      provider: provider || this.store.config().provider, model: String(model || '').slice(0, 80), createdBy: String(by).slice(0, 40), cloneOf, createdAt: now(), updatedAt: now() };
    this.store.put('specialist', item.id, item); this.writeCard(item); return item;
  }
  update(id, { rules, unsure, provider, model }) {
    const item = this.get(id);
    if (provider !== undefined && !['claude', 'codex'].includes(provider)) throw new Error('Choose Claude Code or Codex.');
    const updated = { ...item, ...(rules !== undefined ? { rules: String(rules).slice(0, 4000) } : {}), ...(unsure !== undefined ? { unsure: [].concat(unsure).map(text => String(text).trim().slice(0, 300)).filter(Boolean).slice(0, 12) } : {}),
      ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model: String(model).slice(0, 80) } : {}), updatedAt: now() };
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

  writeCard(item) {
    const lines = [`# ${item.name}`, '', `- Project: ${item.projectSlug} (\`${item.projectPath}\`)`, `- Agent: ${item.provider === 'codex' ? 'Codex' : 'Claude Code'}${item.model ? ` · ${item.model}` : ''}`,
      `- Created by: ${item.createdBy}${item.cloneOf ? ` · duplicate of ${this.store.get('specialist', item.cloneOf)?.name || 'another agent'}` : ''}`, `- Updated: ${item.updatedAt}`, '',
      '## What this project is for', '', item.purpose || 'Not recorded yet.', '', '## Rules from the person', '', item.rules || 'None yet.', '',
      '## Still not sure about', '', item.unsure.length ? item.unsure.map(text => `- ${text}`).join('\n') : 'Nothing open.', '',
      '## Read first', '', `- Project memory: \`projects/${item.projectSlug}.md\` (set up, test, run, and the project's own instructions)`, '- The repository\'s own CLAUDE.md and AGENTS.md before changing anything', ''];
    atomic(this.cardFile(item), lines.join('\n'));
  }
}

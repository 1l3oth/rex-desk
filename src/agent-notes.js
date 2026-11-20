// Each agent's soul (who it is; changes need the person's OK) and memory (its own notebook it writes and tidies), L49.
// Kept as database records, one per agent per kind, with a history row for every change, so they sync through the cloud to
// every computer like agents and tasks do (loose files did not, L44). Rex Agent's stay on each computer (store.js isPrivate).
// The agent sees and edits them as Markdown; the card can export them as SOUL.md and MEMORY.md.
import { randomUUID } from 'node:crypto';

export const NOTE_CAP = 8 * 1024;
export const NOTE_KINDS = ['soul', 'memory'];
const HISTORY = 30;
const now = () => new Date().toISOString();
// Text that looks like a key, token or password is refused: these notes travel to the cloud and into every session.
const SECRET = [
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b(password|passwd|pwd|api[_ -]?key|secret|access[_ -]?token|auth[_ -]?token|bearer)\b\s*[:=]\s*["']?[^\s"']{6,}/i,
];
export const looksSecret = text => SECRET.some(pattern => pattern.test(String(text || '')));

export class AgentNotes {
  constructor(desk) { this.desk = desk; this.store = desk.store; }
  key(agentId, kind) { if (!NOTE_KINDS.includes(kind)) throw new Error('Pick soul or memory.'); return `${agentId}:${kind}`; }
  agent(agentId) { if (agentId === 'main') { this.desk.specialists.ensureMain(); return this.store.get('specialist', 'main') || { id: 'main', name: 'Rex Agent' }; } return this.desk.specialists.get(agentId); }
  // The first soul is the agent's card as it is: what it is for, the person's rules, what it is still unsure about.
  seed(agent) {
    return [`# ${agent.name}`, agent.purpose ? `## What I am for\n${agent.purpose}` : '', agent.projectSlug ? `## My project\n${agent.projectSlug}` : '',
      agent.rules ? `## Rules from the person\n${agent.rules}` : '', agent.unsure?.length ? `## Still unsure\n${agent.unsure.map(item => `- ${item}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
  }
  get(agentId, kind) {
    const saved = this.store.get('agentnote', this.key(agentId, kind));
    if (saved) return saved;
    if (kind === 'soul') { const agent = this.agent(agentId); return this.put(agentId, 'soul', this.seed(agent), { by: 'Rex Desk', why: 'Started from the agent card' }); }
    return { id: this.key(agentId, kind), agentId, kind, text: '', at: '', by: '' };
  }
  text(agentId, kind) { return this.get(agentId, kind).text || ''; }
  check(text) {
    const value = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (Buffer.byteLength(value) > NOTE_CAP) throw new Error(`That is ${Math.ceil(Buffer.byteLength(value) / 1024)} KB; the limit is 8 KB. Tidy first: rewrite it shorter, keep what still matters, drop what is done or out of date.`);
    if (looksSecret(value)) throw new Error('That looks like a key, token or password. Never keep secrets here; write where it is kept instead (for example "the key is in the .env file").');
    return value;
  }
  put(agentId, kind, text, { by = '', why = '' } = {}) {
    const value = this.check(text), id = this.key(agentId, kind), before = this.store.get('agentnote', id);
    if (before && before.text === value) return before;
    if (before) {
      const historyId = `${id}:${randomUUID()}`;
      this.store.put('agentnotehist', historyId, { id: historyId, agentId, kind, text: before.text, by: before.by, at: before.at, replacedAt: now(), replacedBy: by });
      const old = this.history(agentId, kind).slice(HISTORY); for (const item of old) this.store.delete('agentnotehist', item.id);
    }
    const saved = { id, agentId, kind, text: value, at: now(), by: String(by).slice(0, 40), ...(why ? { why: String(why).slice(0, 200) } : {}), ...(before?.pending && kind === 'soul' ? { pending: before.pending } : {}) };
    this.store.put('agentnote', id, saved); return saved;
  }
  history(agentId, kind) { const prefix = `${this.key(agentId, kind)}:`; return this.store.list('agentnotehist').filter(item => item.id.startsWith(prefix)).sort((left, right) => String(right.replacedAt).localeCompare(String(left.replacedAt))); }
  restore(agentId, kind, historyId, by = 'you') {
    const item = this.store.get('agentnotehist', historyId); if (!item || item.agentId !== agentId || item.kind !== kind) throw new Error('That earlier version is gone.');
    return this.put(agentId, kind, item.text, { by, why: `Put back the version from ${item.at || 'before'}` });
  }
  // The agent's notebook: add a note, replace one section (a "## Heading" and what follows it), or rewrite all of it to tidy.
  writeMemory(agentId, { action = 'add', text = '', section = '' } = {}, by = '') {
    const current = this.text(agentId, 'memory'), body = String(text || '').trim();
    if (!body && action !== 'rewrite') throw new Error('Write what to keep.');
    let next = current;
    if (action === 'rewrite') next = body;
    else if (action === 'replace') {
      const heading = String(section || '').replace(/^#+\s*/, '').trim(); if (!heading) throw new Error('Name the section to replace (its ## heading).');
      const pattern = new RegExp(`(^|\\n)## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n[\\s\\S]*?(?=\\n## |$)`, 'i');
      const block = `## ${heading}\n${body.replace(/^## [^\n]*\n/, '')}`;
      next = pattern.test(current) ? current.replace(pattern, (match, start) => `${start}${block}`) : `${current}\n\n${block}`.trim();
    } else next = `${current}\n${body.startsWith('-') || body.startsWith('#') ? body : `- ${body}`}`.trim();
    return this.put(agentId, 'memory', next, { by, why: action });
  }
  // An agent may only propose a new soul: it waits on the card (and a question in the chat) for the person's yes.
  propose(agentId, text, reason = '', by = '') {
    const value = this.check(text), current = this.get(agentId, 'soul');
    if (value === current.text) throw new Error('That is the soul as it is now.');
    const pending = { text: value, reason: String(reason || '').slice(0, 300), by: String(by).slice(0, 40), at: now() };
    this.store.put('agentnote', current.id, { ...current, pending }); return pending;
  }
  decide(agentId, accept, by = 'you') {
    const current = this.get(agentId, 'soul'); if (!current.pending) throw new Error('No change is waiting.');
    const { pending, ...rest } = current; this.store.put('agentnote', current.id, rest);
    return accept ? this.put(agentId, 'soul', pending.text, { by: pending.by || by, why: `Accepted by the person${pending.reason ? `: ${pending.reason}` : ''}` }) : rest;
  }
  // An agent deleted: its soul, memory and their history go too, here and in the cloud.
  remove(agentId) {
    for (const kind of NOTE_KINDS) { const id = this.key(agentId, kind); if (this.store.get('agentnote', id)) this.store.delete('agentnote', id); for (const item of this.history(agentId, kind)) this.store.delete('agentnotehist', item.id); }
  }
  exported(agentId) { return { soul: this.text(agentId, 'soul'), memory: this.text(agentId, 'memory') }; }
  summary(agentId) {
    const soul = this.store.get('agentnote', this.key(agentId, 'soul')), memory = this.store.get('agentnote', this.key(agentId, 'memory'));
    return { soulAt: soul?.at || '', soulPending: Boolean(soul?.pending), memoryAt: memory?.at || '', memoryBytes: Buffer.byteLength(memory?.text || '') };
  }
  // What the agent reads at the start of a session, after a fresh start or handoff, and again whenever it changed.
  contextText(agentId) {
    if (!agentId) return '';
    let soul = ''; try { soul = this.text(agentId, 'soul'); } catch { return ''; }
    const memory = this.text(agentId, 'memory'), bytes = Buffer.byteLength(memory);
    return [soul ? `Your soul (who you are; to change it, propose with desk_soul_memory action "propose" and the person decides):\n${soul}` : '',
      `Your memory (your own notebook, ${Math.round(bytes / 1024 * 10) / 10} of 8 KB; write it with desk_soul_memory):\n${memory || '(empty)'}`,
      'Write to your memory with desk_soul_memory after a decision, a correction from the person, a finding worth keeping, or a finished task: short notes, not a diary. Tidy it (rewrite) when it gets long. Never write keys, tokens or passwords there. Lessons from the person stay in desk_learn.'].filter(Boolean).join('\n\n');
  }
}

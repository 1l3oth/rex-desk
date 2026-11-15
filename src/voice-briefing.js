// Voice mode's briefing: what Rex needs to answer at once, gathered by code (no AI, milliseconds) the moment the person
// turns Voice mode on, while the body's opening animation plays. Like revising before an exam: the person, their agents and
// what each is doing, the chats of the last few days and how they ended, what waits for the person, and recent tasks. It
// goes to the agent with the first spoken question, so the agent answers from it instead of going to look; for anything
// not in it, the agent says it will check, and checks.
import { existsSync, readFileSync } from 'node:fs';

const DAYS = 3;
const clip = (text, size) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > size ? `${value.slice(0, size - 1)}…` : value; };
const ago = when => {
  const minutes = Math.round((Date.now() - Date.parse(when || 0)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  return minutes < 2 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
};

export function voiceBriefing({ store, memoryDirectory = '', now = Date.now() }) {
  const since = now - DAYS * 86400000, recent = item => Date.parse(item?.updatedAt || item?.createdAt || 0) > since;
  const agents = store.list('specialist').filter(agent => agent && !agent.deleted);
  const agentName = id => (id === 'main' ? 'Rex Agent' : agents.find(agent => agent.id === id)?.name || '');
  const lastSaid = (runId, kind) => store.events(runId, { visible: true, limit: 40 }).filter(event => event.kind === kind && (event.text || event.result)).at(-1);
  const lines = [`# Briefing for Voice mode (made ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')})`];

  // Who the person is, from the memory every agent shares.
  const profile = memoryDirectory && existsSync(`${memoryDirectory}/user.md`) ? readFileSync(`${memoryDirectory}/user.md`, 'utf8') : '';
  const name = store.config().profile?.name || store.config().name || '';
  if (name || profile.trim()) lines.push('', '## The person', name ? `Name: ${name}` : '', clip(profile.replace(/^# .*$/m, ''), 1200));

  // Every agent: what it is for and what it is doing now.
  const runs = store.list('run').filter(Boolean).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  if (agents.length) {
    lines.push('', `## Agents (${agents.length})`);
    for (const agent of agents.slice(0, 25)) {
      const run = runs.find(item => item.specialistId === agent.id);
      const doing = run ? `${run.state || 'idle'}${run.updatedAt ? `, last active ${ago(run.updatedAt)}` : ''}` : 'no chat yet';
      lines.push(`- ${agent.name}${agent.projectSlug ? ` (${agent.projectSlug})` : ''}: ${clip(agent.purpose || '', 90)} [${doing}]`);
    }
  }

  // The chats of the last few days: what the person asked last and what the agent said last.
  const chats = runs.filter(recent).slice(0, 10);
  if (chats.length) {
    lines.push('', `## Chats in the last ${DAYS} days (newest first)`);
    for (const run of chats) {
      const who = agentName(run.roomAgent || run.specialistId) || (run.main || run.role === 'coordinator' ? 'Rex Agent' : run.title || 'An agent');
      const asked = lastSaid(run.id, 'human-message'), answered = lastSaid(run.id, 'agent-text');
      lines.push(`- ${who}, ${run.state || ''}, ${ago(run.updatedAt)}${run.error ? `, error: ${clip(run.error, 100)}` : ''}`);
      if (asked) lines.push(`  You asked: ${clip(asked.text, 160)}`);
      if (answered) lines.push(`  It said: ${clip(answered.text, 260)}`);
    }
  }

  // What waits for the person: questions and approvals.
  const waiting = store.list('interaction').filter(item => item?.state === 'pending').slice(0, 10);
  if (waiting.length) {
    lines.push('', `## Waiting for the person (${waiting.length})`);
    for (const item of waiting) lines.push(`- ${agentName(store.get('run', item.runId)?.specialistId) || 'An agent'} asks: ${clip(item.title || item.request?.message || item.kind, 140)}`);
  }

  // Tasks touched lately.
  const tasks = store.list('task').filter(recent).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))).slice(0, 10);
  if (tasks.length) {
    lines.push('', '## Recent tasks');
    for (const task of tasks) lines.push(`- #${task.taskNumber || task.externalId || ''} ${clip(task.titleEn || task.title, 100)}${task.deskStatus || task.status ? ` [${task.deskStatus || task.status}]` : ''}`);
  }
  return lines.filter(line => line !== '').join('\n');
}

// How to talk in Voice mode, given with the briefing and, shorter, with every spoken message after it.
export const VOICE_RULE = `The person is talking to you out loud in Voice mode: what you write is spoken to them as you write it.
- Answer like a person on a call: short, warm, plain words, one to three sentences. No lists, tables, headings, code or links.
- Talk in your reply itself, as plain text. Do not use desk_message or desk_ask while in Voice mode: ask your questions out loud in the reply and wait for the answer.
- Answer from the briefing below first; it is current. Do not look things up that it already answers.
- If the answer is not in it, say so in a few words first ("Let me check that for you.") and then check, so they are never left in silence.
- When they ask you to do something that takes more than a moment (look into a project, search files or logs, run or check something), start it with desk_background, giving it everything it needs, then say in one short sentence that you are on it ("Sure, I'm on it.") and end your reply. Do not do the steps yourself and do not use the Agent tool: the person must stay free to talk to you while it runs. Its result is said to them when it is done, and given to you with their next message.
- Quick things you can do in one step (making a group chat, telling an agent something, answering from the briefing) you do yourself, at once.
- Never mention jobs, helpers, subagents or models to the person: it is just you doing it.`;
export const VOICE_REMINDER = '(Voice mode: you are heard, not read. Answer short and spoken, as plain text in your reply (not desk_message or desk_ask), from the briefing when you can. For anything that takes more than a moment, start it with desk_background, say you are on it, and end your reply; never mention it.)';
// With the report when Voice mode opens: read it, keep it for later, and only greet. The person may not ask about any of it.
export const VOICE_GREETING = `That was the report for this call; keep it in mind for what they ask. Do not summarise it, list anything from it, or start any work.
Just greet the person in one short, warm sentence, like picking up a call (for example "Hey, welcome back! What's on your mind?"), and wait for them to talk.
Do not use any tool for this reply.`;

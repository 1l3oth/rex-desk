import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentsFromEvents, subagentsPanel } from '../public/chat-subagents.js';

const at = n => `2026-11-16T09:0${n}:00.000Z`;
const events = [
  { kind: 'agent-tool', tool: 'Agent', id: 'a1', input: { description: 'Find the bug', prompt: 'Look in src' }, createdAt: at(1) },
  { kind: 'agent-tool', tool: 'Read', id: 'r1', parent: 'a1', input: { file: 'src/x.js' }, createdAt: at(2) },
  { kind: 'subagent-done', id: 'a1', text: 'Found it', failed: false, createdAt: at(3) },
  { kind: 'agent-tool', tool: 'Agent', id: 'a2', input: { description: 'Second one' }, createdAt: at(4) },
  { kind: 'agent-tool', tool: 'Agent', id: 'a3', parent: 'a2', input: { description: 'Nested' }, createdAt: at(5) },
];
const ctx = { esc: text => String(text), markdown: text => text, ui: {} };

test('every sub-agent of a chat is listed with its steps and report; a nested one is a step of its parent', () => {
  const subs = subagentsFromEvents(events, { who: 'Bug_Fix' });
  assert.deepEqual(subs.map(item => item.id), ['a1', 'a2']);
  assert.equal(subs[0].steps.length, 1); assert.equal(subs[0].done, true); assert.equal(subs[0].result, 'Found it'); assert.equal(subs[0].who, 'Bug_Fix');
  assert.equal(subs[1].steps.length, 1); assert.equal(subs[1].done, false);
});

test('the Sub-agents tab shows newest first, with a jump button only where the chat can show the card', () => {
  const subs = subagentsFromEvents(events);
  const html = subagentsPanel(subs, ctx, { jump: true });
  assert.ok(html.indexOf('data-sub="a2"') < html.indexOf('data-sub="a1"'));
  assert.match(html, /data-action="sub-jump"/); assert.doesNotMatch(subagentsPanel(subs, ctx), /sub-jump/);
  assert.match(subagentsPanel([], ctx), /No sub-agents yet/);
});

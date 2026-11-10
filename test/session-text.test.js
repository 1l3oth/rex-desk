import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../src/orca.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-session-'));
const claude = text => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }, { type: 'tool_use', name: 'Bash' }] } }) + '\n';
const codex = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';

test('a new session log is read from its start, one whole line at a time', () => {
  const file = path.join(dir, 'new.jsonl'); writeFileSync(file, claude('First reply.') + JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n' + '{"type":"assis');
  const saved = {}; const session = new AgentSession({ provider: 'claude', cwd: 'x', since: new Date(Date.now() - 1000).toISOString(), state: { file }, persist: state => Object.assign(saved, state) });
  assert.deepEqual(session.texts(), ['First reply.'], 'thinking, tool calls and the half-written line are not text');
  appendFileSync(file, 'tant","message":{"content":[{"type":"text","text":"Second."}]}}\n');
  assert.deepEqual(session.texts(), ['Second.'], 'the finished line is read once it is complete');
  assert.deepEqual(session.texts(), []);
  assert.ok(saved.offset > 0);
});

test('a reopened session log does not replay earlier turns', () => {
  const file = path.join(dir, 'old.jsonl'); writeFileSync(file, codex('Old answer.'));
  const session = new AgentSession({ provider: 'codex', cwd: 'x', since: new Date(Date.now() + 3600000).toISOString(), state: { file }, persist: () => {} });
  assert.deepEqual(session.texts(), []);
  appendFileSync(file, codex('New answer.'));
  assert.deepEqual(session.texts(), ['New answer.']);
});

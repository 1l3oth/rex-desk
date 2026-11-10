import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup(role = 'worker') {
  const store = new Store(temporary('switch')), desk = new Desk(store, { root: temporary('root') });
  desk.closed = true; // no agent is started in these tests
  store.put('run', 'run-1', { id: 'run-1', title: 'Fix', state: 'finished', provider: 'codex', role, prompt: 'Dispatch the issues.', instructions: 'Investigate.', sessionId: 'orca:abc', createdAt: now() });
  store.event('run-1', 'message', { text: 'The cause is in PostHeader.js line 88.' }, true);
  store.event('run-1', 'human-message', { text: 'Fix it, keep tests green.' }, true);
  return { store, desk };
}

test('an older Codex run resumes as Claude Code and is handed the recorded chat', async () => {
  const { store, desk } = setup();
  await desk.resume('run-1', { prompt: 'Go on.' });
  const run = store.get('run', 'run-1');
  assert.equal(run.provider, 'claude');
  assert.equal(run.sessionId, undefined, 'the other CLI cannot reopen the old session');
  assert.match(run.instructions, /Codex: The cause is in PostHeader\.js line 88\./);
  assert.match(run.instructions, /Human: Fix it, keep tests green\./);
  assert.match(run.instructions, /Go on\./);
  const events = store.events('run-1', { visible: true });
  assert.ok(events.some(item => item.kind === 'message' && /PostHeader/.test(item.text)) && events.some(item => item.kind === 'human-message' && /keep tests green/.test(item.text)), 'the history is still on the run');
  assert.ok(events.some(item => item.kind === 'provider-switch' && item.to === 'claude'));
});

test('resuming a Claude Code run keeps the session and adds no handover', async () => {
  const { store, desk } = setup();
  store.put('run', 'run-1', { ...store.get('run', 'run-1'), provider: 'claude' });
  await desk.resume('run-1', { prompt: 'Go on.' });
  const run = store.get('run', 'run-1');
  assert.equal(run.provider, 'claude');
  assert.equal(run.sessionId, 'orca:abc');
  assert.ok(!/conversation so far/.test(run.instructions));
});

test('a main agent that switches provider gets the handover and the follow-up in its prompt', async () => {
  const { store, desk } = setup('coordinator');
  await desk.resume('run-1', { prompt: 'Only dispatch the Gmail issue.' });
  const run = store.get('run', 'run-1');
  assert.match(run.prompt, /Dispatch the issues\./);
  assert.match(run.prompt, /conversation so far/);
  assert.match(run.prompt, /Only dispatch the Gmail issue\./);
});

test('a follow-up sent on resume appears in the chat history', async () => {
  const { store, desk } = setup();
  await desk.resume('run-1', { prompt: 'Please also check the Safari case.' });
  const events = store.events('run-1', { visible: true });
  assert.equal(events.at(-1).kind, 'human-message');
  assert.equal(events.at(-1).text, 'Please also check the Safari case.');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/store.js';
import { Notifier } from '../src/notify.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup(options = {}) {
  const store = new Store(temporary('notify')), shown = [];
  const notifier = new Notifier(store, { show: (title, body) => shown.push([title, body]), minGapMs: 0, ...options }).start();
  store.put('run', 'r1', { id: 'r1', title: 'Main agent', main: true, state: 'running', createdAt: now() });
  return { store, shown, notifier };
}

test('a new question tells the person when the window is not in front, and only once', () => {
  const { store, shown } = setup();
  const ask = { id: 'q1', runId: 'r1', kind: 'question', title: 'Which clone should the agent use?', state: 'pending', createdAt: now() };
  store.put('interaction', 'q1', ask); store.put('interaction', 'q1', ask);
  assert.equal(shown.length, 1);
  assert.match(shown[0][0], /Needs your answer · Main agent/); assert.match(shown[0][1], /Which clone/);
  store.put('interaction', 'q2', { ...ask, id: 'q2', kind: 'approval', title: 'Approve Bash' });
  assert.match(shown[1][0], /Needs your OK/);
});

test('nothing is shown while Rex Desk is the focused window, or when notifications are off', () => {
  const focused = setup({ focused: () => true });
  focused.store.put('interaction', 'q1', { id: 'q1', runId: 'r1', kind: 'question', title: 'x', state: 'pending', createdAt: now() });
  assert.equal(focused.shown.length, 0);
  const off = setup({ enabled: () => false });
  off.store.put('interaction', 'q1', { id: 'q1', runId: 'r1', kind: 'question', title: 'x', state: 'pending', createdAt: now() });
  assert.equal(off.shown.length, 0);
});

test('an agent that finishes its turn shows its last words; a failure shows the error', () => {
  const { store, shown } = setup();
  store.event('r1', 'agent-text', { text: 'Created Dara for authentication.' }, true);
  store.put('run', 'r1', { ...store.get('run', 'r1'), state: 'finished' });
  assert.deepEqual(shown.at(-1), ['Main agent replied', 'Created Dara for authentication.']);
  store.put('run', 'r1', { ...store.get('run', 'r1'), state: 'running' });
  store.put('run', 'r1', { ...store.get('run', 'r1'), state: 'failed', error: 'Not signed in' });
  assert.deepEqual(shown.at(-1), ['Main agent stopped', 'Not signed in']);
});

test('toasts closer together than the gap are dropped', () => {
  const { store, shown } = setup({ minGapMs: 60000 });
  store.put('interaction', 'a', { id: 'a', runId: 'r1', kind: 'question', title: 'one', state: 'pending', createdAt: now() });
  store.put('interaction', 'b', { id: 'b', runId: 'r1', kind: 'question', title: 'two', state: 'pending', createdAt: now() });
  assert.equal(shown.length, 1);
});

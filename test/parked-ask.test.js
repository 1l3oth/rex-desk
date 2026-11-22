import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/store.js';
import { Desk, answerText } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('an agent asks, keeps working, and gets the answer later in its chat', async () => {
  const dir = temporary('parked'); let store = new Store(dir); let desk = new Desk(store, { root: temporary('root') });
  store.put('run', 'run-1', { id: 'run-1', title: 'Agent', role: 'specialist', state: 'running', createdAt: now() });
  const asked = desk.beginAsk('run-1', { kind: 'question', title: 'Which branch?', request: { requestedSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } } }, { parked: true });
  // The agent is not put on hold: its run keeps running and nothing waits on a promise.
  assert.equal(asked.promise, null); assert.equal(desk.run('run-1').state, 'running');
  // Its turn ends and the server restarts: the question stays in Needs you.
  desk.cancelQuestions('run-1'); assert.equal(store.get('interaction', asked.id).state, 'pending');
  store.close(); store = new Store(dir); desk = new Desk(store, { root: temporary('root') });
  assert.equal(store.get('interaction', asked.id).state, 'pending');
  // Hours later the person answers while the agent is idle: the answer starts a new turn in its chat.
  const resumed = []; desk.resume = async (runId, options) => { resumed.push({ runId, ...options }); };
  store.put('run', 'run-1', { ...store.get('run', 'run-1'), state: 'finished' });
  assert.deepEqual(desk.answer(asked.id, { action: 'accept', content: { answer: 'release/0.0.105' } }), { answered: true, delivered: true });
  assert.equal(resumed.length, 1); assert.equal(resumed[0].runId, 'run-1');
  assert.match(resumed[0].prompt, /Which branch\?/); assert.match(resumed[0].prompt, /release\/0\.0\.105/);
  assert.equal(store.get('interaction', asked.id).state, 'answered');
  store.close();
});

test('an answer to a working agent waits in its queue', () => {
  const store = new Store(temporary('parked-live')); const desk = new Desk(store, { root: temporary('root') });
  store.put('run', 'run-2', { id: 'run-2', title: 'Agent', role: 'specialist', state: 'running', createdAt: now() });
  const asked = desk.beginAsk('run-2', { kind: 'approval', title: 'Delete old builds?' }, { parked: true });
  desk.live.set('run-2', {}); desk.resume = async () => { throw new Error('should not start a turn'); };
  desk.answer(asked.id, { action: 'decline' });
  assert.match(store.get('run', 'run-2').queued.at(-1), /Delete old builds\?.*No/s);
  desk.live.delete('run-2'); store.close();
});

test('answers read as plain words', () => {
  assert.equal(answerText({ action: 'accept' }), 'Yes (approved).');
  assert.equal(answerText({ action: 'decline' }), 'No (declined).');
  assert.equal(answerText({ action: 'accept', content: { answer: 'main' } }), 'main');
});

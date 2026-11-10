import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { MAX_HOPS } from '../src/rooms.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup() {
  const store = new Store(temporary('rooms')), desk = new Desk(store, { root: temporary('root') });
  const run = (id, title, state = 'running') => store.put('run', id, { id, title, state, provider: 'claude', execution: 'orca', createdAt: now() });
  run('run-a', 'flow-was'); run('run-b', 'desktop'); run('run-c', 'studybook', 'finished');
  const room = desk.rooms.create('Cross-project bug', ['run-a', 'run-b', 'run-c']);
  return { store, desk, room };
}

test('a message reaches only the agents it names', async () => {
  const { desk, room } = setup();
  await desk.rooms.post(room.id, { text: 'Anyone seen this?' });
  assert.equal(desk.rooms.unread('run-a'), 0);
  await desk.rooms.post(room.id, { text: '@desktop does the export use v2?' });
  assert.equal(desk.rooms.unread('run-b'), 1);
  assert.equal(desk.rooms.unread('run-a'), 0);
  const inbox = desk.rooms.read(room.id, 'run-b');
  assert.equal(inbox.mentions.length, 1);
  assert.equal(inbox.mentions[0].from, 'You');
  assert.equal(desk.rooms.unread('run-b'), 0);
});

test('an unknown name is an error, not a silent miss', async () => {
  const { desk, room } = setup();
  await assert.rejects(desk.rooms.post(room.id, { fromRunId: 'run-a', text: 'hi', to: ['nobody'] }), /not in this room/);
});

test('an agent cannot mention itself or post from outside the room', async () => {
  const { desk, room, store } = setup();
  await assert.rejects(desk.rooms.post(room.id, { fromRunId: 'run-a', text: 'hi', to: ['flow-was'] }), /yourself/);
  store.put('run', 'run-x', { id: 'run-x', title: 'x', state: 'running', createdAt: now() });
  await assert.rejects(desk.rooms.post(room.id, { fromRunId: 'run-x', text: 'hi', to: [] }), /not in that room/);
});

test('agent-to-agent threads pause after the hop limit and a person resets the count', async () => {
  const { desk, room } = setup();
  let parent = (await desk.rooms.post(room.id, { text: '@flow-was start' })).id, sender = 'run-a', target = 'desktop';
  let paused = false;
  for (let hop = 1; hop <= MAX_HOPS + 2; hop += 1) {
    const result = await desk.rooms.post(room.id, { fromRunId: sender, text: `ping ${hop}`, to: [target], replyTo: parent });
    parent = result.id; if (result.paused) { paused = true; break; }
    [sender, target] = sender === 'run-a' ? ['run-b', 'flow-was'] : ['run-a', 'desktop'];
  }
  assert.equal(paused, true);
  assert.ok(desk.rooms.messages(room.id).some(item => item.from.type === 'system' && /paused/.test(item.text)));
  const human = await desk.rooms.post(room.id, { text: '@flow-was go on', replyTo: parent });
  assert.equal(desk.rooms.messages(room.id).find(item => item.id === human.id).hops, 0);
});

test('a finished agent gets an approval card, never an automatic restart', async () => {
  const { desk, room, store } = setup();
  await desk.rooms.post(room.id, { text: '@studybook can you check the quiz copy?' });
  const wakes = desk.rooms.wakes();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].runId, 'run-c');
  assert.equal(store.get('run', 'run-c').state, 'finished');
  assert.deepEqual(desk.rooms.dismissWake(wakes[0].id), { dismissed: true });
  assert.equal(desk.rooms.wakes().length, 0);
});

test('the snapshot carries rooms for the dashboard', async () => {
  const { desk, room } = setup();
  await desk.rooms.post(room.id, { text: 'hello @desktop' });
  const snapshot = desk.snapshot();
  assert.equal(snapshot.rooms[0].members.length, 3);
  assert.equal(snapshot.messages.length, 1);
});

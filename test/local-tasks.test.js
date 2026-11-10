import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup() {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop', description: 'Online shop' }));
  const store = new Store(temporary('local')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  desk.memory.scan({ roots: [projects] });
  return { desk, store };
}

test('Rex Desk tasks are numbered, follow the Orbit status workflow, and stay apart from tracker tasks', () => {
  const { desk, store } = setup();
  const agent = desk.specialists.create({ name: 'Shopkeeper', projectSlug: 'shop' });
  const first = desk.localTasks.create({ title: 'Add a dark theme', project: 'shop', tags: 'ui, theme', checklist: ['Pick colors', 'Ship it'], assignee: 'shopkeeper' }, { by: 'you' });
  assert.equal(first.taskNumber, 'L1'); assert.equal(first.status, 'todo'); assert.equal(first.statusName, 'To do');
  assert.deepEqual(first.tags, ['ui', 'theme']); assert.equal(first.checklist.length, 2); assert.equal(first.assignee, agent.id);
  const child = desk.localTasks.create({ title: 'Write the CSS', parentTaskId: 'L1' });
  assert.equal(child.taskNumber, 'L2'); assert.equal(child.parentTaskId, first.id);
  assert.throws(() => desk.localTasks.update('L1', { status: 'done' }), /Still open: #L2/);
  desk.localTasks.update('L2', { status: 'done', comment: 'Done in theme.css' }, { by: 'Shopkeeper' });
  const done = desk.localTasks.update('L1', { status: 'done' });
  assert.equal(done.status, 'done'); assert.ok(done.doneAt);
  assert.equal(desk.localTasks.get('L2').comments[0].by, 'Shopkeeper');
  assert.throws(() => desk.localTasks.update('L1', { status: 'finished' }), /Status must be one of/);
  store.put('task', 'flow:1', { id: 'flow:1', sourceId: 'flow-1', title: 'Tracker issue', active: true });
  assert.throws(() => desk.localTasks.update('flow:1', { title: 'x' }), /changed in their tracker/);
  desk.localTasks.remove('L2'); assert.equal(desk.localTasks.all().length, 1);
});

test('an agent records where its tasks come from, and its prompt says so', () => {
  const { desk } = setup();
  const agent = desk.specialists.create({ name: 'Shopkeeper', projectSlug: 'shop' });
  assert.match(desk.specialists.tasksText(agent), /Never assume Flow or Morningmate/);
  const updated = desk.specialists.update(agent.id, { taskSources: ['Rex Desk tasks'] });
  assert.deepEqual(updated.taskSources, ['local']);
  assert.match(desk.specialists.identity(updated), /Your tasks come from: Rex Desk tasks/);
  assert.throws(() => desk.specialists.update(agent.id, { taskSources: ['Jira'] }), /No task source "Jira"/);
});

test('a run on a Rex Desk task moves the task along without asking', async () => {
  const { desk, store } = setup();
  const task = desk.localTasks.create({ title: 'Fix the cart total' });
  store.put('run', 'r1', { id: 'r1', taskId: task.id, state: 'running', checks: {} });
  assert.deepEqual(await desk.status('r1', 'working'), { status: 'in_progress' });
  assert.equal(desk.localTasks.get(task.id).status, 'in_progress');
});

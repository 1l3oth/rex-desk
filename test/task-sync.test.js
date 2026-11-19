import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { TursoSync } from '../src/turso.js';
import { Desk } from '../src/coordinator.js';

// Two computers of one account, both running, with one stand-in cloud database between them.
const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-tasksync-${label}-`));
function fakeTurso() {
  const remote = new DatabaseSync(':memory:');
  const clientFactory = () => ({
    async batch(statements) {
      remote.exec('BEGIN');
      try { for (const statement of statements) typeof statement === 'string' ? remote.exec(statement) : remote.prepare(statement.sql).run(...statement.args); remote.exec('COMMIT'); }
      catch (error) { remote.exec('ROLLBACK'); throw error; }
    },
    async execute({ sql, args }) { return { rows: remote.prepare(sql).all(...args) }; },
    close() {},
  });
  return { remote, clientFactory };
}
async function account() {
  const turso = fakeTurso(), url = 'libsql://rex-tasks.example.invalid';
  const make = async (name, from) => {
    const directory = temporary(name);
    if (from) for (const file of ['workspace.id', 'vault.key']) copyFileSync(path.join(from, file), path.join(directory, file));
    const store = new Store(directory);
    store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 60000 });
    await store.cloud.connect({ url, authToken: 'token' });
    const desk = new Desk(store, { root: temporary(`${name}-root`), memoryDirectory: temporary(`${name}-memory`), runnerFactory: () => ({ start: async () => {}, interrupt: async () => {} }) });
    return { desk, store, directory };
  };
  const home = await make('home');
  const work = await make('work', home.directory);
  // One look at the cloud, as the running loop does every few seconds (Peers.pullTurso).
  const sync = async () => { for (const side of [home, work]) await side.store.cloud.flush(); for (const side of [home, work]) await side.desk.peers.pullTurso(); };
  const close = async () => { for (const side of [home, work]) { side.desk.closed = true; side.desk.peers.stop?.(); await side.store.cloud.close(); side.store.close(); } };
  return { turso, home, work, sync, close };
}
const local = store => store.list('task').filter(task => task.local).map(task => `${task.taskNumber} ${task.title}`).sort();

test('a Rex Desk task added, changed, commented on or deleted on one running computer reaches the other one', async () => {
  const { turso, home, work, sync, close } = await account();
  assert.notEqual(home.store.nodeId, work.store.nodeId, 'two computers');
  const made = await home.desk.localTasks.create({ title: 'Sync task A' });
  assert.equal(made.taskNumber, 'L1');
  await sync();
  assert.equal(work.store.get('task', made.id)?.title, 'Sync task A', 'the other computer has it');

  await work.desk.localTasks.update(made.taskNumber, { status: 'in_progress', title: 'Sync task A (edited at work)' });
  work.desk.localTasks.comment(made.id, 'comment from work');
  await sync();
  const there = home.store.get('task', made.id);
  assert.equal(there.status, 'in_progress'); assert.equal(there.title, 'Sync task A (edited at work)');
  assert.deepEqual(there.comments.map(item => item.text), ['comment from work']);

  // A comment on each computer before either has seen the other's: both are kept on both.
  work.desk.localTasks.comment(made.id, 'second from work');
  await new Promise(resolve => setTimeout(resolve, 5));
  home.desk.localTasks.comment(made.id, 'comment from home');
  await sync(); await sync();
  const want = ['comment from work', 'second from work', 'comment from home'];
  assert.deepEqual(work.store.get('task', made.id).comments.map(item => item.text), want);
  assert.deepEqual(home.store.get('task', made.id).comments.map(item => item.text), want);

  work.desk.localTasks.remove(made.id);
  await sync();
  assert.equal(home.store.get('task', made.id), undefined, 'a delete reaches the other computer');

  // A tracker task is each computer's own copy of its tracker: it stays out of the shared records.
  home.store.put('task', 'flow:1', { id: 'flow:1', source: 'flow', title: 'From Flow' });
  await sync();
  assert.equal(work.store.get('task', 'flow:1'), undefined);
  assert.equal(turso.remote.prepare("SELECT COUNT(*) AS n FROM rex_shared WHERE kind='task' AND id NOT LIKE 'local:%'").get().n, 0);
  await close();
});

test('two computers adding a task at the same moment get different numbers', async () => {
  const { home, work, sync, close } = await account();
  for (let round = 0; round < 5; round++) {
    const [left, right] = await Promise.all([home.desk.localTasks.create({ title: `Parallel home ${round}` }), work.desk.localTasks.create({ title: `Parallel work ${round}` })]);
    assert.notEqual(left.taskNumber, right.taskNumber, `round ${round}`);
  }
  await sync();
  assert.deepEqual(local(home.store), local(work.store));
  assert.equal(new Set(home.store.list('task').map(task => task.taskNumber)).size, 10, 'every number once');
  await close();
});

test('a number both computers gave out while offline is settled: the earlier task keeps it, the later one is renumbered once', async () => {
  const { home, work, sync, close } = await account();
  home.store.cloud.ready = false; work.store.cloud.ready = false;
  const first = await home.desk.localTasks.create({ title: 'Offline home' });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await work.desk.localTasks.create({ title: 'Offline work' });
  assert.equal(first.taskNumber, second.taskNumber, 'both said L1 while offline');
  home.store.cloud.ready = true; work.store.cloud.ready = true;
  await sync();
  await Promise.all([home.desk.localTasks.settle(), work.desk.localTasks.settle()]);
  await sync();
  assert.equal(home.store.get('task', first.id).taskNumber, 'L1');
  const moved = home.store.get('task', second.id);
  assert.equal(moved.taskNumber, 'L2'); assert.equal(moved.renumberedFrom, 'L1');
  assert.match(moved.comments.at(-1).text, /Renumbered from L1 to L2/);
  assert.deepEqual(local(home.store), local(work.store));
  // The next task anywhere does not take a settled number again.
  const next = await home.desk.localTasks.create({ title: 'After' });
  assert.equal(next.taskNumber, 'L3');
  await close();
});

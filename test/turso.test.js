import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { TursoSync } from '../src/turso.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const until = async (check, message) => {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(message);
};
// An in-memory stand-in for the libsql web client: same batch/execute surface, and it can go offline.
function fakeTurso() {
  const remote = new DatabaseSync(':memory:'), network = { online: false, clients: 0 };
  const guard = () => { if (!network.online) throw new Error('fetch failed: token secret-turso-token rejected'); };
  const clientFactory = () => {
    network.clients++;
    return {
      async batch(statements) {
        guard(); remote.exec('BEGIN');
        try { for (const statement of statements) typeof statement === 'string' ? remote.exec(statement) : remote.prepare(statement.sql).run(...statement.args); remote.exec('COMMIT'); }
        catch (error) { remote.exec('ROLLBACK'); throw error; }
      },
      async execute({ sql, args }) { guard(); return { rows: remote.prepare(sql).all(...args) }; },
      close() {},
    };
  };
  return { remote, network, clientFactory };
}

test('an offline start queues every write, retries on its own, and verifies the cloud copy', async () => {
  const directory = temporary('turso'), turso = fakeTurso();
  const store = new Store(directory);
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 40 });
  const status = await store.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  assert.equal(status.state, 'offline');
  assert.doesNotMatch(status.error, /secret-turso-token/);
  assert.ok(readdirSync(path.join(directory, 'backups')).some(name => name.startsWith('before-turso-')));
  store.put('task', 'task-1', { id: 'task-1', title: 'Queued while offline' });
  store.event('run-1', 'message', { text: 'Recorded offline' }, true);
  assert.ok(store.cloud.status().pending > 0);
  turso.network.online = true;
  await until(() => store.cloud.status().pending === 0 && store.cloud.status().state === 'connected', 'Outbox did not drain after the network returned');
  const verification = await store.cloud.verify();
  assert.equal(verification.matched, true);
  assert.equal(verification.localEvents, 1);
  // Concurrent retries share one connection attempt instead of replacing the client mid-flush.
  const before = turso.network.clients;
  store.cloud.ready = false;
  await Promise.all([store.cloud.open(), store.cloud.open(), store.cloud.retry()]);
  assert.equal(turso.network.clients, before + 1);
  await store.cloud.close(); store.close();
});

test('a fresh workspace restores records, events, and its access token from Turso', async () => {
  const original = temporary('turso-a'), restored = temporary('turso-b'), turso = fakeTurso();
  turso.network.online = true;
  const first = new Store(original);
  first.cloud = new TursoSync(first, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await first.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  first.put('task', 'task-1', { id: 'task-1', title: 'Survives a new computer' });
  first.put('run', 'run-1', { id: 'run-1', state: 'running', createdAt: new Date().toISOString() });
  first.event('run-1', 'message', { text: 'Visible history' }, true);
  await first.cloud.flush();
  const token = first.token;
  await first.cloud.close(); first.close();
  // Restore needs the same workspace identity, vault key, and encrypted connection; nothing else is copied.
  for (const file of ['workspace.id', 'vault.key', 'turso.connection']) copyFileSync(path.join(original, file), path.join(restored, file));
  const second = new Store(restored);
  second.cloud = new TursoSync(second, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await second.cloud.open();
  assert.equal(second.get('task', 'task-1').title, 'Survives a new computer');
  assert.equal(second.get('run', 'run-1').state, 'interrupted', 'Restored runs need an explicit resume');
  assert.equal(second.events('run-1', { visible: true })[0].text, 'Visible history');
  assert.equal(second.token, token);
  assert.equal((await second.cloud.verify()).matched, true);
  assert.ok(existsSync(path.join(restored, 'turso.migrated')));
  await second.cloud.close(); second.close();
});

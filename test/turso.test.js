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

test('a reinstall gets back the files too: chat pictures, room pictures, evidence and the memory folder', async () => {
  const original = temporary('files-a'), restored = temporary('files-b'), memory = temporary('files-memory'), turso = fakeTurso();
  turso.network.online = true;
  const { mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  mkdirSync(path.join(original, 'uploads', 'u1'), { recursive: true }); writeFileSync(path.join(original, 'uploads', 'u1', 'shot.png'), 'picture bytes');
  mkdirSync(path.join(original, 'room-images'), { recursive: true }); writeFileSync(path.join(original, 'room-images', 'room-1.png'), 'room picture');
  mkdirSync(path.join(original, 'artifacts', 'run-1'), { recursive: true }); writeFileSync(path.join(original, 'artifacts', 'run-1', 'screen.png'), 'evidence'); writeFileSync(path.join(original, 'artifacts', 'run-1', 'Page.jsp'), 'a copy of source code');
  writeFileSync(path.join(memory, 'user.md'), '# About the person\n- Likes short answers');
  mkdirSync(path.join(memory, 'node_modules'), { recursive: true }); writeFileSync(path.join(memory, 'node_modules', 'skip.js'), 'never uploaded');
  const first = new Store(original);
  first.cloud = new TursoSync(first, { clientFactory: turso.clientFactory, retryMs: 1000 }); first.cloud.files.memoryDirectory = memory;
  await first.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  first.event('run-1', 'human-message', { text: 'Keep me' }, true); first.event('run-1', 'human-message', { text: 'Unsend me' }, true);
  first.unsendEvent('run-1', first.events('run-1').at(-1).sequence);
  await first.cloud.flush(); await first.cloud.files.run();
  assert.equal(turso.remote.prepare('SELECT COUNT(*) AS n FROM rex_files').get().n, 4, 'node_modules and copies of source code in evidence are skipped');
  assert.doesNotMatch(String(turso.remote.prepare("SELECT data FROM rex_files WHERE path='memory/user.md'").get().data), /short answers/, 'files are sealed with the vault key');
  await first.cloud.close(); first.close();
  // Uninstall: the data folder and the memory folder are gone. Only the workspace identity and key come back (from the passphrase).
  rmSync(memory, { recursive: true, force: true });
  for (const file of ['workspace.id', 'vault.key']) copyFileSync(path.join(original, file), path.join(restored, file));
  const second = new Store(restored);
  second.cloud = new TursoSync(second, { clientFactory: turso.clientFactory, retryMs: 1000 }); second.cloud.files.memoryDirectory = memory;
  await second.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  assert.equal(readFileSync(path.join(restored, 'uploads', 'u1', 'shot.png'), 'utf8'), 'picture bytes');
  assert.equal(readFileSync(path.join(restored, 'room-images', 'room-1.png'), 'utf8'), 'room picture');
  assert.match(readFileSync(path.join(memory, 'user.md'), 'utf8'), /short answers/);
  assert.equal(readFileSync(path.join(restored, 'artifacts', 'run-1', 'screen.png'), 'utf8'), 'evidence');
  assert.deepEqual(second.events('run-1', { visible: true }).map(event => event.text), ['Keep me'], 'an unsent message stays unsent');
  await second.cloud.close(); second.close();
});

test('a large backup comes down in pages', async () => {
  const original = temporary('pages-a'), restored = temporary('pages-b'), turso = fakeTurso();
  turso.network.online = true;
  const first = new Store(original);
  first.cloud = new TursoSync(first, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await first.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  for (let index = 0; index < 4500; index++) first.event('run-1', 'agent-text', { text: `line ${index}` }, true);
  for (let index = 0; index < 1200; index++) first.put('task', `task-${index}`, { id: `task-${index}` });
  await first.cloud.flush(); await first.cloud.close(); first.close();
  for (const file of ['workspace.id', 'vault.key']) copyFileSync(path.join(original, file), path.join(restored, file));
  const second = new Store(restored);
  second.cloud = new TursoSync(second, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await second.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  assert.equal(second.events('run-1', { limit: 10000 }).length, 4500);
  assert.equal(second.list('task').length, 1200);
  assert.equal((await second.cloud.verify()).matched, true);
  await second.cloud.close(); second.close();
});

test('a restore on the same machine takes back its computer id; a second machine gets its own and never overwrites the other\'s chats', async () => {
  const original = temporary('node-a'), turso = fakeTurso();
  turso.network.online = true;
  const first = new Store(original);
  first.cloud = new TursoSync(first, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await first.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  first.put('specialist', 'agent-1', { id: 'agent-1', name: 'Dara' });
  first.put('peers', 'main', { name: 'Work', remote: false, peers: [], cursors: {}, files: {} });
  first.event('run-1', 'message', { text: 'From the first computer' }, true);
  await first.cloud.flush(); await first.cloud.presence('Work', {});
  const firstNode = first.nodeId;
  await first.cloud.close(); first.close();
  const restore = async () => {
    const directory = temporary('node-b');
    for (const file of ['workspace.id', 'vault.key', 'turso.connection']) copyFileSync(path.join(original, file), path.join(directory, file));
    const store = new Store(directory);
    store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 1000 });
    await store.cloud.open(); return store;
  };
  // A reinstall on this machine: the agents stay this computer's own.
  const again = await restore();
  assert.equal(again.nodeId, firstNode);
  assert.equal(again.get('peers', 'main').name, 'Work');
  await again.cloud.close(); again.close();
  // Another machine while the first one is in use: its own id, its own name, messages numbered apart.
  turso.remote.prepare('UPDATE rex_presence SET host=? WHERE node=?').run('SOME-OTHER-PC', firstNode);
  const second = await restore();
  assert.notEqual(second.nodeId, firstNode);
  assert.equal(second.get('peers', 'main').name, '');
  second.event('run-2', 'message', { text: 'From the second computer' }, true);
  await second.cloud.flush();
  const rows = turso.remote.prepare('SELECT sequence FROM rex_events ORDER BY sequence').all().map(row => Number(row.sequence));
  assert.equal(rows.length, 2); assert.ok(rows[1] >= 1e9);
  await second.cloud.close(); second.close();
});

test('signing in again keeps this computer\'s own name instead of taking the other computer\'s', async () => {
  const turso = fakeTurso(); turso.network.online = true;
  const store = new Store(temporary('pull-name'));
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await store.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  store.put('peers', 'main', { name: 'Laptop', remote: false, peers: [], cursors: {}, files: {} });
  await store.cloud.flush();
  turso.remote.prepare("UPDATE rex_records SET value=? WHERE kind='peers' AND id='main'").run(JSON.stringify({ name: 'Work', peers: [] }));
  assert.equal((await store.cloud.pullLatest()).pulled, true);
  assert.equal(store.get('peers', 'main').name, 'Laptop');
  await store.cloud.close(); store.close();
});

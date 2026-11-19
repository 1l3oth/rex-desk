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

test('a backup to your own Turso database keeps no files in it, and a reinstall still gets back files an older version put there', async () => {
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
  assert.equal(turso.remote.prepare('SELECT COUNT(*) AS n FROM rex_files').get().n, 0, 'files never go into the database');
  // Versions before this one did keep files in the database (sealed with the vault key): those still come back on a reinstall.
  const { readFileSync: read } = await import('node:fs');
  const older = [['data/uploads/u1/shot.png', path.join(original, 'uploads', 'u1', 'shot.png')], ['data/room-images/room-1.png', path.join(original, 'room-images', 'room-1.png')],
    ['data/artifacts/run-1/screen.png', path.join(original, 'artifacts', 'run-1', 'screen.png')], ['memory/user.md', path.join(memory, 'user.md')]];
  const workspace = first.cloud.workspace;
  for (const [key, file] of older) { const data = read(file); turso.remote.prepare('INSERT INTO rex_files(workspace,path,size,data,updated_at) VALUES(?,?,?,?,?)').run(workspace, key, data.length, first.encryptBytes(data), new Date().toISOString()); }
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

test('the cloud check passes when another computer added its own chats, and uploads again what is missing', async () => {
  const turso = fakeTurso(); turso.network.online = true;
  const store = new Store(temporary('verify-two'));
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await store.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  store.put('task', 'here', { id: 'here', title: 'From this computer' });
  store.event('run-1', 'message', { text: 'Here' }, true);
  await store.cloud.flush();
  const workspace = store.cloud.workspace;
  turso.remote.prepare('INSERT INTO rex_records(workspace,kind,id,value) VALUES(?,?,?,?)').run(workspace, 'task', 'there', '{"id":"there"}');
  turso.remote.prepare('INSERT INTO rex_events(workspace,sequence,run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?,?,?)').run(workspace, 999, 'run-2', 'message', 1, '{}', '');
  assert.equal((await store.cloud.verify()).matched, true, 'the other computer\'s chats are not a difference');
  turso.remote.prepare("DELETE FROM rex_records WHERE workspace=? AND id='here'").run(workspace);
  const result = await store.cloud.verify();
  assert.equal(result.matched, true, 'a missing record is uploaded again');
  assert.ok(turso.remote.prepare("SELECT 1 FROM rex_records WHERE workspace=? AND id='here'").get(workspace));
  await store.cloud.close(); store.close();
});

test('signing in again leaves a chat that is still working on this computer running', async () => {
  const turso = fakeTurso(); turso.network.online = true;
  const store = new Store(temporary('pull-live'));
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await store.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  store.put('run', 'working', { id: 'working', state: 'running', host: { pid: process.pid } });
  store.put('run', 'gone', { id: 'gone', state: 'running' });
  await store.cloud.flush();
  await store.cloud.pullLatest();
  assert.equal(store.get('run', 'working').state, 'running');
  assert.equal(store.get('run', 'gone').state, 'interrupted');
  await store.cloud.close(); store.close();
});

test('signing in takes the cloud copy of records, and never overwrites messages by their number (agents chats come by id through rex_chat)', async () => {
  const turso = fakeTurso(); turso.network.online = true;
  const store = new Store(temporary('pull-merge'));
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await store.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  store.put('specialist', 'secret-agent', { id: 'secret-agent', name: 'Private', noCloud: true });
  store.put('run', 'private-run', { id: 'private-run', specialistId: 'secret-agent', state: 'done' });
  store.event('private-run', 'message', { text: 'Never in the cloud' }, true);
  store.put('task', 'shared', { id: 'shared', title: 'Old title' });
  store.event('run-1', 'message', { text: 'Here' }, true);
  await store.cloud.flush();
  assert.equal(store.isPrivate('run', store.get('run', 'private-run')), true);
  const workspace = store.cloud.workspace;
  turso.remote.prepare("UPDATE rex_records SET value=? WHERE workspace=? AND kind='task' AND id='shared'").run('{"id":"shared","title":"Renamed on the other computer"}', workspace);
  turso.remote.prepare('INSERT INTO rex_events(workspace,sequence,run_id,kind,visible,value,created_at) VALUES(?,?,?,?,?,?,?)').run(workspace, 5, 'run-2', 'message', 1, '{"text":"From the other computer"}', '');
  // Messages are numbered per computer: the backup's numbers say nothing about this computer's own messages.
  let fetched = 0; const execute = store.cloud.client.execute.bind(store.cloud.client);
  store.cloud.client.execute = async query => { const result = await execute(query); if (/SELECT \* FROM rex_events/.test(query.sql)) fetched += result.rows.length; return result; };
  const result = await store.cloud.pullLatest();
  assert.equal(result.pulled, true);
  assert.equal(fetched, 0);
  assert.equal(store.get('task', 'shared').title, 'Renamed on the other computer');
  assert.equal(store.events('run-2', { visible: true }).length, 0, "the other computer's numbered backup row is not taken as a message here");
  assert.ok(store.get('run', 'private-run'), 'a chat kept out of the cloud is not deleted by the pull');
  assert.equal(store.events('private-run', { visible: true })[0].text, 'Never in the cloud');
  assert.equal(store.events('run-1', { visible: true })[0].text, 'Here');
  await store.cloud.close(); store.close();
});

test('shared agents and computers belong to one account: another account (or a development copy) in the same database stays out of view', async () => {
  const turso = fakeTurso(); turso.network.online = true;
  const store = new Store(temporary('shared-workspace'));
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await store.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  const workspace = store.cloud.workspace, add = (id, node, owner) => turso.remote.prepare('INSERT INTO rex_shared(kind,id,value,deleted,v,node,workspace) VALUES(?,?,?,?,?,?,?)').run('specialist', id, JSON.stringify({ id, name: id }), 0, '00000000a.0001.x', node, owner);
  add('mine', 'other-laptop', workspace); add('theirs', 'dev-copy', 'another-workspace');
  turso.remote.prepare('INSERT INTO rex_presence(node,name,at,agents,host,workspace) VALUES(?,?,?,?,?,?)').run('dev-copy', 'Dev', Date.now(), '{}', 'X', 'another-workspace');
  turso.remote.prepare('INSERT INTO rex_presence(node,name,at,agents,host,workspace) VALUES(?,?,?,?,?,?)').run('other-laptop', 'Laptop', Date.now(), '{}', 'Y', workspace);
  assert.deepEqual((await store.cloud.pullShared('0')).map(row => row.id), ['mine']);
  assert.deepEqual((await store.cloud.presence('Here', {})).map(row => row.name), ['Laptop']);
  await store.cloud.close(); store.close();
});

test('a part left out of the backup is deleted from the cloud, skipped from then on, and sent back when turned on again', async () => {
  const directory = temporary('parts'), turso = fakeTurso(); turso.network.online = true;
  const store = new Store(directory);
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 40 });
  await store.cloud.connect({ url: 'libsql://rex-parts.example.invalid', authToken: 'parts-token' });
  store.put('task', 'task-1', { id: 'task-1', title: 'A task' });
  store.put('specialist', 'agent-1', { id: 'agent-1', name: 'Agent' });
  store.event('run-1', 'message', { text: 'Hello' }, true);
  await store.cloud.flush();
  const count = (sql, ...args) => turso.remote.prepare(sql).get(...args).n;
  assert.equal(count("SELECT COUNT(*) n FROM rex_records WHERE kind='task'"), 1);
  assert.equal(count('SELECT COUNT(*) n FROM rex_events'), 1);
  assert.deepEqual(store.cloud.status().parts, { chats: true, rooms: true, tasks: true, files: true });

  // Off: the cloud copy goes, new ones are not sent, and the cloud check still passes.
  store.cloud.setParts({ tasks: false, chats: false }); await store.cloud.flush();
  assert.equal(count("SELECT COUNT(*) n FROM rex_records WHERE kind='task'"), 0);
  assert.equal(count('SELECT COUNT(*) n FROM rex_events'), 0);
  store.put('task', 'task-2', { id: 'task-2', title: 'Stays here' }); store.event('run-1', 'message', { text: 'Not sent' }, true);
  await store.cloud.flush();
  assert.equal(count("SELECT COUNT(*) n FROM rex_records WHERE kind='task'"), 0);
  assert.equal(count('SELECT COUNT(*) n FROM rex_events'), 0);
  assert.equal(count("SELECT COUNT(*) n FROM rex_records WHERE kind='specialist'"), 1, 'agents always go up');
  assert.equal((await store.cloud.verify()).matched, true);
  assert.equal(store.list('task').length, 2, 'nothing is deleted on this computer');

  // On again: this computer's copy goes back up.
  store.cloud.setParts({ tasks: true, chats: true }); await store.cloud.flush();
  assert.equal(count("SELECT COUNT(*) n FROM rex_records WHERE kind='task'"), 2);
  assert.equal(count('SELECT COUNT(*) n FROM rex_events'), 2);
  await store.cloud.close(); store.close();
});

test('a full cloud space says so plainly, warns once at 80% and at 95%, and pauses file uploads without stopping the sync', async () => {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-space-')));
  const sync = new TursoSync(store, { clientFactory: fakeTurso().clientFactory, retryMs: 1000 });
  try {
    // The database hit its size limit: a plain message, the changes stay queued.
    sync.fail(new Error('SQLite error: database size limit exceeded'));
    assert.equal(sync.state, 'full'); assert.match(sync.error, /cloud space is full[\s\S]*stays on this computer/);
    sync.fail(new Error('fetch failed'));
    assert.equal(sync.state, 'offline', 'any other trouble is still offline');
    // Warnings: once when crossing 80%, once when crossing 95%, again after it went back under.
    const heard = []; sync.onSpace = level => heard.push(level);
    let used = 0;
    sync.account = { summary: () => null, signedIn: true, saved: { token: 'k' }, fetcher: async () => ({ ok: true, status: 200, json: async () => ({ plan: 'cloud', space: { paid: true, packs: 0, files: { used, limit: 1000 } } }) }), base: 'https://api.example' };
    const look = async value => { used = value; sync.spaceAt = 0; await sync.checkSpace(); };
    await look(500); await look(850); await look(870); await look(960); await look(980); await look(100); await look(820);
    assert.deepEqual(heard, [80, 95, 80]);
    assert.equal(sync.status().space.files.used, 820);
    // Files: full means stop uploading files and say why; going back under lets them go on.
    sync.files.full = true;
    sync.files.hosted = () => true;
    assert.match((await sync.files.backup()).skipped, /full/);
    await look(100);
    assert.equal(sync.files.full, false, 'room again: files go up again');
  } finally { sync.close?.(); store.close(); }
});

test("an agent's chat goes through rex_chat by message id: the other computer gets every message once, an unsent one goes away, Rex Agent stays home", async () => {
  const turso = fakeTurso(); turso.network.online = true;
  const open = async label => { const store = new Store(temporary(label)); store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 1000 }); await store.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' }); return store; };
  const work = await open('chat-work'), home = await open('chat-home');
  home.cloud.workspace = work.cloud.workspace;
  work.put('specialist', 'dara', { id: 'dara', name: 'Dara', runId: 'chat-1' });
  work.put('run', 'chat-1', { id: 'chat-1', role: 'specialist', specialistId: 'dara' });
  work.event('chat-1', 'human-message', { text: 'Fix the refunds' }, true);
  work.event('chat-1', 'agent-text', { text: 'Done' }, true);
  work.put('run', 'main-1', { id: 'main-1', role: 'coordinator', main: true });
  work.event('main-1', 'human-message', { text: 'Only on this computer' }, true);
  await work.cloud.flush();
  assert.equal(turso.remote.prepare("SELECT COUNT(*) AS n FROM rex_events WHERE run_id='main-1'").get().n, 0, "Rex Agent's chat is not backed up");
  const rows = await home.cloud.pullChat('');
  assert.deepEqual(rows.map(row => JSON.parse(row.value).text), ['Fix the refunds', 'Done']);
  home.applyChatEvents(rows); home.applyChatEvents(rows);
  assert.deepEqual(home.events('chat-1', { visible: true }).map(event => event.text), ['Fix the refunds', 'Done'], 'each message once, even read twice');
  const first = work.events('chat-1', { visible: true })[0];
  work.unsendEvent('chat-1', first.sequence);
  await work.cloud.flush();
  home.applyChatEvents(await home.cloud.pullChat(rows.at(-1).v));
  assert.deepEqual(home.events('chat-1', { visible: true }).map(event => event.text), ['Done'], 'an unsent message goes away everywhere');
  await work.cloud.close(); await home.cloud.close(); work.close(); home.close();
});

test('two computers that ended up with one id split again: the later hostname takes a new id and sends its own messages again', async () => {
  const turso = fakeTurso(); turso.network.online = true;
  const store = new Store(temporary('clash'));
  store.cloud = new TursoSync(store, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await store.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  store.event('run-1', 'message', { text: 'Written here' }, true);
  await store.cloud.presence('Work', {});
  const shared = store.nodeId;
  assert.equal(store.nodeId, shared, 'Its own heartbeat is no clash');
  turso.remote.prepare('UPDATE rex_presence SET host=?, at=? WHERE node=?').run('~LATER-PC', Date.now(), shared);
  await store.cloud.presence('Work', {});
  assert.equal(store.nodeId, shared, 'The computer whose name sorts first keeps the id');
  turso.remote.prepare('UPDATE rex_presence SET host=?, at=? WHERE node=?').run('0-EARLIER-PC', Date.now(), shared);
  await store.cloud.presence('Work', {});
  assert.notEqual(store.nodeId, shared, 'The other one takes a new id');
  const row = store.db.prepare('SELECT uid, pushed FROM events WHERE run_id=?').get('run-1');
  assert.ok(row.uid.startsWith(`${store.nodeId}.`), 'Its messages carry the new id');
  assert.equal(row.pushed, null, 'and go up again');
  await store.cloud.close(); store.close();
});

test('a restore never takes an id whose computer left no hostname', async () => {
  const original = temporary('nohost'), turso = fakeTurso(); turso.network.online = true;
  const first = new Store(original);
  first.cloud = new TursoSync(first, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await first.cloud.connect({ url: 'libsql://rex-test.example.invalid', authToken: 'secret-turso-token' });
  first.put('specialist', 'agent-1', { id: 'agent-1', name: 'Dara', node: first.nodeId });
  await first.cloud.flush(); await first.cloud.presence('Work', {});
  const firstNode = first.nodeId;
  await first.cloud.close(); first.close();
  turso.remote.prepare('UPDATE rex_presence SET host=NULL, at=? WHERE node=?').run(Date.now() - 3600000, firstNode);
  const directory = temporary('nohost-b');
  for (const file of ['workspace.id', 'vault.key', 'turso.connection']) copyFileSync(path.join(original, file), path.join(directory, file));
  const second = new Store(directory);
  second.cloud = new TursoSync(second, { clientFactory: turso.clientFactory, retryMs: 1000 });
  await second.cloud.open();
  assert.notEqual(second.nodeId, firstNode);
  await second.cloud.close(); second.close();
});

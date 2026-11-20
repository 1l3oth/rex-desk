import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const DAY = 86400000, old = days => new Date(Date.now() - days * DAY);
const write = (file, bytes, age = 0) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.alloc(bytes, path.basename(file).length)); if (age) utimesSync(file, old(age), old(age)); return file; };

test('Storage lists Rex Desk folders with sizes, deletes files (and their cloud copy), and each clean-up frees what it says', () => {
  const before = process.env.REX_DESK_VERSION; process.env.REX_DESK_VERSION = '0.0.87';
  const store = new Store(temporary('storage')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const queued = [], forgotten = [];
  store.cloud = { enabled: true, workspace: 'w1', enqueue: (sql, args) => queued.push([sql, args]), files: { forget: keys => forgotten.push(...keys) }, schedule() {}, record() {}, remove() {}, event() {}, chatEvent() {}, shared() {}, status: () => ({}) };
  const uploads = store.media('uploads'), artifacts = store.media('artifacts');
  const agent = desk.specialists.create({ name: 'Dara', purpose: 'Tests storage.' }), runId = 'run-1';
  store.put('run', runId, { id: runId, specialistId: agent.id, createdAt: new Date().toISOString() });
  // Two copies of one file (a duplicate), an old screenshot and a new one, three backups, and two app copies.
  write(path.join(uploads, 'a', 'notes.txt'), 50000, 10); write(path.join(uploads, 'b', 'notes.txt'), 50000, 1);
  const shot = write(path.join(artifacts, runId, 'old-shot.png'), 300000, 90); write(path.join(artifacts, runId, 'new-shot.png'), 200000, 2);
  store.put('artifact', 'a1', { id: 'a1', runId, file: 'old-shot.png', type: 'image/png' });
  for (const [name, age] of [['b1.sqlite', 90], ['b2.sqlite', 60], ['b3.sqlite', 40]]) write(path.join(store.directory, 'backups', name), 10000, age);
  write(path.join(store.directory, 'runtime', '0.0.86', 'app.js'), 70000); write(path.join(store.directory, 'runtime', '0.0.87', 'app.js'), 80000);
  // Raw agent output: two hidden records from 40 days ago and one today, and a chat message from 40 days ago.
  for (const visible of [false, false, false, true]) store.event(runId, visible ? 'human-message' : 'agent-raw', { text: 'x'.repeat(20000) }, visible);
  store.db.prepare("UPDATE events SET created_at = ? WHERE sequence IN (SELECT sequence FROM events ORDER BY sequence LIMIT 2) OR kind = 'human-message'").run(old(40).toISOString());

  const usage = desk.storage.usage();
  assert.ok(usage.kinds.find(kind => kind.id === 'raw').bytes >= 60000, 'raw agent output is counted');
  assert.equal(usage.places.find(place => place.id === 'uploads').bytes, 100000);
  assert.equal(usage.places.find(place => place.id === 'artifacts').bytes, 500000);
  // The browser: folders with their totals, the agent a file belongs to, and the app copy agents use now is locked.
  const top = desk.storage.list('artifacts');
  assert.deepEqual(top.items.map(item => [item.name, item.size, item.owner?.name]), [[runId, 500000, 'Dara']]);
  assert.equal(desk.storage.list('runtime').items.find(item => item.name === '0.0.87').locked, true);
  assert.throws(() => desk.storage.list('artifacts', '../..'), /gone/);
  assert.throws(() => desk.storage.list('vault'), /not one of Rex Desk/);
  assert.throws(() => desk.storage.remove([{ place: 'runtime', path: '0.0.87' }]), /stays/);
  assert.throws(() => desk.storage.remove([{ place: 'uploads', path: '' }]), /whole Rex Desk folder/);
  assert.equal(desk.storage.search('shot').length, 2);

  const ids = Object.fromEntries(desk.storage.suggestions().map(item => [item.id, item]));
  assert.equal(ids['old-media'].bytes, 300000); assert.equal(ids.duplicates.bytes, 50000); assert.equal(ids['old-backups'].bytes, 20000); assert.equal(ids['old-copies'].bytes, 70000);
  assert.equal(ids['raw-output'].count, 2);

  // Deleting a folder frees its size, and the cloud copy goes too.
  const gone = desk.storage.remove([{ place: 'uploads', path: 'b' }]);
  assert.deepEqual(gone, { freed: 50000, removed: 1 });
  assert.ok(queued.some(([sql, args]) => /DELETE FROM rex_files/.test(sql) && args[1] === 'data/uploads/b/%'));
  assert.ok(forgotten.includes('data/uploads/b/'));
  // Clean-ups.
  assert.equal(desk.storage.clean('old-media').freed >= 300000, true); assert.equal(existsSync(shot), false);
  assert.equal(store.get('artifact', 'a1'), undefined, 'the deleted screenshot is no longer listed as evidence');
  desk.storage.clean('old-backups'); assert.deepEqual(desk.storage.list('backups').items.map(item => item.name), ['b3.sqlite']);
  desk.storage.clean('old-copies'); assert.deepEqual(desk.storage.list('runtime').items.map(item => item.name), ['0.0.87']);
  desk.storage.clean('raw-output');
  assert.deepEqual(store.db.prepare('SELECT kind, visible FROM events ORDER BY sequence').all().map(row => [row.kind, Number(row.visible)]), [['agent-raw', 0], ['human-message', 1]], 'old raw output goes; today\'s and every chat message stay');
  assert.ok(queued.some(([sql]) => /DELETE FROM rex_events WHERE workspace=\? AND visible=0/.test(sql)), 'the cloud copy of the raw output goes too');
  assert.equal(desk.storage.suggestions().find(item => item.id === 'raw-output').bytes, 0);
  assert.throws(() => desk.storage.clean('everything'), /No such/);
  store.cloud = null; store.close();
  if (before === undefined) delete process.env.REX_DESK_VERSION; else process.env.REX_DESK_VERSION = before;
});

test('a file deleted in Storage is remembered, so a chat never fetches a copy of it back', () => {
  const store = new Store(temporary('storage-gone')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  write(path.join(store.media('uploads'), 'u1', 'photo.png'), 2000); write(path.join(store.media('artifacts'), 'r1', 'a.png'), 2000);
  desk.storage.remove([{ place: 'uploads', path: path.join('u1', 'photo.png') }, { place: 'artifacts', path: 'r1' }]);
  assert.equal(desk.storage.gone('data/uploads/u1/photo.png'), true);
  assert.equal(desk.storage.gone('data/artifacts/r1/a.png'), true, 'a file in a deleted folder');
  assert.equal(desk.storage.gone('data/uploads/u2/photo.png'), false);
  store.close();
});

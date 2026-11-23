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

test('Storage lists Rex Desk folders with sizes, deletes files (and their cloud copy), and each clean-up frees what it says', async () => {
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

  const usage = await desk.storage.usage();
  assert.ok(usage.kinds.find(kind => kind.id === 'raw').bytes >= 60000, 'raw agent output is counted');
  assert.equal(usage.places.find(place => place.id === 'uploads').bytes, 100000);
  assert.equal(usage.places.find(place => place.id === 'artifacts').bytes, 500000);
  // The browser: folders with their totals, the agent a file belongs to, and the app copy agents use now is locked.
  const top = await desk.storage.list('artifacts');
  assert.deepEqual(top.items.map(item => [item.name, item.size, item.owner?.name]), [[runId, 500000, 'Dara']]);
  assert.equal((await desk.storage.list('runtime')).items.find(item => item.name === '0.0.87').locked, true);
  await assert.rejects(() => desk.storage.list('artifacts', '../..'), /gone/);
  await assert.rejects(() => desk.storage.list('vault'), /not one of Rex Desk/);
  assert.throws(() => desk.storage.remove([{ place: 'runtime', path: '0.0.87' }]), /stays/);
  assert.throws(() => desk.storage.remove([{ place: 'uploads', path: '' }]), /whole Rex Desk folder/);
  assert.equal((await desk.storage.search('shot')).length, 2);
  // The page itself opens without hashing: duplicates wait for Find duplicates.
  const page = await desk.storage.summary();
  assert.equal(page.suggestions.find(item => item.id === 'duplicates').bytes, null);
  assert.equal((await desk.storage.summary({ findDuplicates: true })).suggestions.find(item => item.id === 'duplicates').bytes, 50000);

  const ids = Object.fromEntries((await desk.storage.suggestions()).map(item => [item.id, item]));
  assert.equal(ids['old-media'].bytes, 300000); assert.equal(ids.duplicates.bytes, 50000); assert.equal(ids['old-backups'].bytes, 20000); assert.equal(ids['old-copies'].bytes, 70000);
  assert.equal(ids['raw-output'].count, 2);

  // Deleting a folder frees its size, and the cloud copy goes too.
  const gone = desk.storage.remove([{ place: 'uploads', path: 'b' }]);
  assert.deepEqual(gone, { freed: 50000, removed: 1 });
  assert.ok(queued.some(([sql, args]) => /DELETE FROM rex_files/.test(sql) && args[1] === 'data/uploads/b/%'));
  assert.ok(forgotten.includes('data/uploads/b/'));
  // Clean-ups.
  assert.equal((await desk.storage.clean('old-media')).freed >= 300000, true); assert.equal(existsSync(shot), false);
  assert.equal(store.get('artifact', 'a1'), undefined, 'the deleted screenshot is no longer listed as evidence');
  await desk.storage.clean('old-backups'); assert.deepEqual((await desk.storage.list('backups')).items.map(item => item.name), ['b3.sqlite']);
  await desk.storage.clean('old-copies'); assert.deepEqual((await desk.storage.list('runtime')).items.map(item => item.name), ['0.0.87']);
  await desk.storage.clean('raw-output');
  assert.deepEqual(store.db.prepare('SELECT kind, visible FROM events ORDER BY sequence').all().map(row => [row.kind, Number(row.visible)]), [['agent-raw', 0], ['human-message', 1]], 'old raw output goes; today\'s and every chat message stay');
  assert.ok(queued.some(([sql]) => /DELETE FROM rex_events WHERE workspace=\? AND visible=0/.test(sql)), 'the cloud copy of the raw output goes too');
  assert.equal((await desk.storage.suggestions()).find(item => item.id === 'raw-output').bytes, 0);
  await assert.rejects(() => desk.storage.clean('everything'), /No such/);
  desk.storage.close(); store.cloud = null; store.close();
  if (before === undefined) delete process.env.REX_DESK_VERSION; else process.env.REX_DESK_VERSION = before;
});

test('a file deleted in Storage is remembered, so a chat never fetches a copy of it back', () => {
  const store = new Store(temporary('storage-gone')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  write(path.join(store.media('uploads'), 'u1', 'photo.png'), 2000); write(path.join(store.media('artifacts'), 'r1', 'a.png'), 2000);
  desk.storage.remove([{ place: 'uploads', path: path.join('u1', 'photo.png') }, { place: 'artifacts', path: 'r1' }]);
  assert.equal(desk.storage.gone('data/uploads/u1/photo.png'), true);
  assert.equal(desk.storage.gone('data/artifacts/r1/a.png'), true, 'a file in a deleted folder');
  assert.equal(desk.storage.gone('data/uploads/u2/photo.png'), false);
  desk.storage.close(); store.close();
});

test('Storage counts in a worker thread, so the desk keeps answering while a big desk is counted', async () => {
  const empty = new Store(temporary('storage-empty')), fresh = new Desk(empty, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const first = await fresh.storage.summary({ wait: false });
  assert.equal(first.usage, null, 'the very first look answers at once, before any count'); assert.equal(first.counting, true); assert.ok(first.places.length);
  fresh.storage.close(); empty.close();
  const store = new Store(temporary('storage-busy')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const uploads = store.media('uploads');
  for (let index = 0; index < 600; index += 1) write(path.join(uploads, `u${index % 60}`, `f${index}.bin`), 2048);
  for (let index = 0; index < 300; index += 1) store.event('run-busy', 'agent-raw', { text: 'y'.repeat(40000) }, false);
  // The longest gap between timer ticks on this thread while the page counts.
  let last = Date.now(), worst = 0; const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  const page = await desk.storage.summary({ findDuplicates: true });
  clearInterval(tick);
  assert.equal(page.usage.places.find(place => place.id === 'uploads').bytes, 600 * 2048);
  assert.ok(page.usage.kinds.find(kind => kind.id === 'raw').bytes >= 300 * 40000);
  assert.ok(worst < 250, `the desk's thread stayed free (longest pause ${worst} ms)`);
  // A second look comes back at once from the count just made.
  const started = Date.now(); await desk.storage.summary({ wait: false }); assert.ok(Date.now() - started < 50);
  // After a restart the page opens with the count kept on disk, and counts again behind it.
  const again = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const reopened = await again.storage.summary({ wait: false });
  assert.equal(reopened.usage.places.find(place => place.id === 'uploads').bytes, 600 * 2048);
  assert.equal(reopened.counting, true);
  again.storage.close();
  desk.storage.close(); store.close();
});
test('Keep chat history deletes older messages here and in the cloud, on its own; memory, tasks and pins stay', () => {
  const store = new Store(temporary('history')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const queued = [];
  store.cloud = { enabled: true, workspace: 'w1', enqueue: (sql, args) => queued.push([sql, args]), files: { forget() {} }, schedule() {}, record() {}, remove() {}, event() {}, chatEvent() {}, shared() {} };
  const agent = desk.specialists.create({ name: 'Dara', purpose: 'Keeps history.' });
  desk.specialists.learn(agent.id, 'Short replies.', 'you');
  store.put('task', 't1', { id: 't1', local: true, title: 'Old task', status: 'todo', createdAt: old(400).toISOString() });
  store.put('pin', 'p1', { id: 'p1', chat: `agent:${agent.id}`, kind: 'link', url: 'https://example.com', pinnedAt: old(400).toISOString() });
  for (const [text, age] of [['very old', 400], ['old', 100], ['new', 2]]) { store.event('run-h', 'human-message', { text }, true); store.db.prepare('UPDATE events SET created_at = ? WHERE sequence = (SELECT MAX(sequence) FROM events)').run(old(age).toISOString()); }
  // Run and approval history is not chat: it stays however old it is.
  for (const kind of ['approval', 'verification-result', 'phase']) { store.event('run-h', kind, { text: kind }, false); store.db.prepare('UPDATE events SET created_at = ? WHERE sequence = (SELECT MAX(sequence) FROM events)').run(old(400).toISOString()); }
  assert.equal(desk.storage.historyDays(), 0, 'Forever by default');
  assert.equal(desk.storage.historyTick(), null, 'Forever deletes nothing');
  assert.throws(() => desk.storage.setHistory(7), /Pick how long/);
  const result = desk.storage.setHistory(365);
  assert.equal(result.removed, 1); assert.equal(store.config().keepHistory, 365);
  assert.deepEqual(store.events('run-h', { visible: true }).map(event => event.text), ['old', 'new']);
  assert.match(queued.at(-1)[0], /DELETE FROM rex_events WHERE workspace=\? AND created_at < \?/);
  // Later, by the timer: a shorter setting deletes more, at most once every 6 hours.
  store.saveConfig({ ...store.config(), keepHistory: 90 });
  assert.equal(desk.storage.historyTick(Date.now()).removed, 1);
  assert.deepEqual(store.events('run-h', { visible: true }).map(event => event.text), ['new']);
  assert.equal(desk.storage.historyTick(Date.now() + 3600000), null, 'not again within 6 hours');
  assert.ok(store.get('task', 't1')); assert.ok(store.get('pin', 'p1'));
  assert.match(desk.specialists.lessonsText(agent.id), /Short replies/, 'lessons stay');
  assert.deepEqual(store.events('run-h', { visible: false }).map(event => event.kind).filter(kind => kind !== 'human-message'), ['approval', 'verification-result', 'phase'], 'run and approval history stays');
  assert.match(queued.at(-1)[0], /AND kind IN [(]/, 'the cloud copy deletes chat messages only');
  desk.storage.setHistory(0); assert.equal(store.config().keepHistory, 0);
});

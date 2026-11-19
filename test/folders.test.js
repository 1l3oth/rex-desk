import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { development, pointerHome, checkTarget, planDataMove, followDataMove, planMemoryMove, followMemoryMove, memoryFolder, moveMedia } from '../src/folders.js';

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'rex-folders-'));

test('a planned data move copies everything on the next start and later starts follow it', async () => {
  const root = temp(), home = path.join(root, 'home'), data = path.join(root, 'old'), to = path.join(root, 'new', 'Rex Desk');
  mkdirSync(path.join(data, 'workspaces', 'w1'), { recursive: true });
  writeFileSync(path.join(data, 'accounts.json'), '{}'); writeFileSync(path.join(data, 'workspaces', 'w1', 'desk.sqlite'), 'db');
  writeFileSync(path.join(data, 'runtime.lock'), '1');
  assert.equal(planDataMove(data, to), to);
  let waited = false;
  assert.equal(await followDataMove(data, { home, waitForOld: async () => { waited = true; } }), to);
  assert.ok(waited, 'It waits for the old server to let go first');
  assert.equal(readFileSync(path.join(to, 'workspaces', 'w1', 'desk.sqlite'), 'utf8'), 'db');
  assert.ok(!existsSync(path.join(to, 'runtime.lock')) && !existsSync(path.join(to, 'move-pending.json')));
  assert.ok(existsSync(path.join(data, 'accounts.json')), 'The old folder stays as a backup');
  assert.equal(readFileSync(path.join(home, '.rexdesk', 'data-folder.txt'), 'utf8'), to, 'The desktop app finds the new folder');
  assert.equal(await followDataMove(data, { home }), to, 'Later starts with the old folder land in the new one');
});

test('a move into a folder with files, or into itself, is refused', () => {
  const root = temp(), full = path.join(root, 'full'); mkdirSync(full); writeFileSync(path.join(full, 'x.txt'), 'x');
  assert.throws(() => checkTarget(root, full), /inside the current one/);
  assert.throws(() => checkTarget(path.join(root, 'a'), full), /empty folder/);
  assert.throws(() => checkTarget(root, 'relative\\folder'), /full folder path/);
  assert.throws(() => checkTarget(root, root), /already where it is/);
});

test('a failed data move keeps the old folder and says why', async () => {
  const root = temp(), data = path.join(root, 'old'), to = path.join(root, 'new'); mkdirSync(data); writeFileSync(path.join(data, 'accounts.json'), '{}');
  planDataMove(data, to); mkdirSync(to); writeFileSync(path.join(to, 'other.txt'), 'someone else');
  assert.equal(await followDataMove(data, { home: path.join(root, 'home') }), data);
  assert.match(readFileSync(path.join(data, 'move-pending.failed.json'), 'utf8'), /empty folder/);
});

test('a data move reports its progress, and a move that stopped the server twice is given up so Rex Desk opens', async () => {
  const root = temp(), data = path.join(root, 'old'), to = path.join(root, 'new');
  mkdirSync(path.join(data, 'workspaces', 'w1'), { recursive: true });
  for (let i = 0; i < 45; i++) writeFileSync(path.join(data, 'workspaces', 'w1', `f${i}.txt`), `file ${i}`);
  writeFileSync(path.join(data, 'accounts.json'), '{}');
  planDataMove(data, to);
  const seen = [];
  assert.equal(await followDataMove(data, { home: path.join(root, 'home'), progress: (done, total) => seen.push([done, total]) }), to);
  assert.deepEqual(seen.at(-1), [46, 46]); assert.ok(seen.length > 2, 'progress comes in steps');
  assert.equal(readFileSync(path.join(to, 'workspaces', 'w1', 'f44.txt'), 'utf8'), 'file 44');

  const other = temp(), stuck = path.join(other, 'old'); mkdirSync(stuck); writeFileSync(path.join(stuck, 'accounts.json'), '{}');
  planDataMove(stuck, path.join(other, 'new'));
  const pending = path.join(stuck, 'move-pending.json');
  writeFileSync(pending, JSON.stringify({ ...JSON.parse(readFileSync(pending, 'utf8')), tries: 2 }));
  assert.equal(await followDataMove(stuck, { home: path.join(other, 'home') }), stuck);
  assert.match(readFileSync(path.join(stuck, 'move-pending.failed.json'), 'utf8'), /stopped while moving/);
  assert.ok(!existsSync(pending));
});

test('moved data is not left compressed by Windows', { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { uncompress } = await import('../src/folders.js');
  const folder = temp(); writeFileSync(path.join(folder, 'desk.sqlite'), 'x'.repeat(200000));
  execFileSync('compact.exe', ['/c', '/s', '/i', '/q'], { cwd: folder, windowsHide: true });
  const state = () => execFileSync('compact.exe', [path.join(folder, 'desk.sqlite')], { encoding: 'utf8', windowsHide: true });
  assert.match(state(), /\bC desk\.sqlite/);
  await uncompress(folder);
  assert.doesNotMatch(state(), /\bC desk\.sqlite/);
});

test('the AI memory moves on the next start and is read from its new place', async () => {
  const home = temp(), env = { REX_DESK_VERSION: '0.0.10' }, brain = path.join(home, '.rexdesk'), to = path.join(home, 'Brain');
  mkdirSync(path.join(brain, 'agents'), { recursive: true }); writeFileSync(path.join(brain, 'user.md'), 'about me'); writeFileSync(path.join(brain, 'data-folder.txt'), 'X:\\data');
  assert.equal(memoryFolder(env, home), brain);
  planMemoryMove(to, { env, home });
  assert.equal(await followMemoryMove({ env, home }), to);
  assert.equal(readFileSync(path.join(to, 'user.md'), 'utf8'), 'about me');
  assert.ok(!existsSync(path.join(to, 'data-folder.txt')), 'Pointer files stay behind');
  assert.equal(memoryFolder(env, home), to);
  assert.throws(() => planMemoryMove(path.join(home, 'Other'), { env: { REX_DESK_MEMORY: brain }, home }), /REX_DESK_MEMORY/);
});

test('files from agents move at once, and new files go to the new folder', async () => {
  const root = temp(), store = new Store(path.join(root, 'data')), to = path.join(root, 'Downloads', 'Rex Desk');
  mkdirSync(path.join(store.directory, 'artifacts', 'run-1'), { recursive: true }); writeFileSync(path.join(store.directory, 'artifacts', 'run-1', 'shot.png'), 'png');
  assert.equal(store.media('artifacts'), path.join(store.directory, 'artifacts'), 'Without a choice, files stay in the data folder');
  await moveMedia(store, to);
  assert.equal(readFileSync(path.join(to, 'artifacts', 'run-1', 'shot.png'), 'utf8'), 'png');
  assert.ok(!existsSync(path.join(store.directory, 'artifacts', 'run-1', 'shot.png')), 'The old copy is removed');
  assert.equal(store.media('uploads'), path.join(to, 'uploads'));
  assert.equal(store.config().mediaDirectory, undefined, 'The choice is not in the shared settings the cloud copies to other computers');
  store.close?.();
  const reopened = new Store(path.join(root, 'data'));
  assert.equal(reopened.media('uploads'), path.join(to, 'uploads'), 'The choice survives a restart');
  reopened.close?.();
});

test('a files folder chosen on another computer never breaks this one', () => {
  const root = temp(), here = path.join(root, 'here-files');
  mkdirSync(here, { recursive: true });
  const fromOther = new Store(path.join(root, 'a'));
  fromOther.put('config', 'main', { ...fromOther.get('config', 'main'), mediaDirectory: path.join(root, 'missing-drive', 'Rex Desk') });
  assert.equal(fromOther.media('artifacts'), path.join(fromOther.directory, 'artifacts'), 'A folder this computer does not have is ignored');
  fromOther.close?.();
  const older = new Store(path.join(root, 'b'));
  older.put('config', 'main', { ...older.get('config', 'main'), mediaDirectory: here });
  assert.equal(older.media('artifacts'), path.join(here, 'artifacts'), 'A choice made here before the change is kept');
  older.put('config', 'main', { ...older.get('config', 'main'), mediaDirectory: path.join(root, 'missing-drive') });
  assert.equal(older.media('uploads'), path.join(here, 'uploads'), 'A later cloud copy of the settings does not move it');
  older.close?.();
});

test('a development copy keeps its own home folder; the installed app and a checkout on 4317 use the real one', () => {
  const home = temp();
  assert.equal(development({}), true, 'npm start in a checkout');
  assert.equal(pointerHome(home, {}), path.join(home, '.rexdesk-dev'));
  assert.equal(memoryFolder({}, home), path.join(home, '.rexdesk-dev'));
  for (const env of [{ REX_DESK_VERSION: '0.0.10' }, { PORT: '4317' }, { REX_RESTART_AFTER: '123' }]) {
    assert.equal(development(env), false, JSON.stringify(env));
    assert.equal(pointerHome(home, env), path.join(home, '.rexdesk'));
  }
  assert.equal(development({ PORT: '4318', REX_RESTART_AFTER: '123' }), true, 'a development copy that updated itself stays development');
});

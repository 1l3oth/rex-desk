import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { checkTarget, planDataMove, followDataMove, planMemoryMove, followMemoryMove, memoryFolder, moveMedia } from '../src/folders.js';

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

test('the AI memory moves on the next start and is read from its new place', () => {
  const home = temp(), env = {}, brain = path.join(home, '.rexdesk'), to = path.join(home, 'Brain');
  mkdirSync(path.join(brain, 'agents'), { recursive: true }); writeFileSync(path.join(brain, 'user.md'), 'about me'); writeFileSync(path.join(brain, 'data-folder.txt'), 'X:\\data');
  assert.equal(memoryFolder(env, home), brain);
  planMemoryMove(to, { env, home });
  assert.equal(followMemoryMove({ env, home }), to);
  assert.equal(readFileSync(path.join(to, 'user.md'), 'utf8'), 'about me');
  assert.ok(!existsSync(path.join(to, 'data-folder.txt')), 'Pointer files stay behind');
  assert.equal(memoryFolder(env, home), to);
  assert.throws(() => planMemoryMove(path.join(home, 'Other'), { env: { REX_DESK_MEMORY: brain }, home }), /REX_DESK_MEMORY/);
});

test('files from agents move at once, and new files go to the new folder', () => {
  const root = temp(), store = new Store(path.join(root, 'data')), to = path.join(root, 'Downloads', 'Rex Desk');
  mkdirSync(path.join(store.directory, 'artifacts', 'run-1'), { recursive: true }); writeFileSync(path.join(store.directory, 'artifacts', 'run-1', 'shot.png'), 'png');
  assert.equal(store.media('artifacts'), path.join(store.directory, 'artifacts'), 'Without a choice, files stay in the data folder');
  moveMedia(store, to);
  assert.equal(store.config().mediaDirectory, to);
  assert.equal(readFileSync(path.join(to, 'artifacts', 'run-1', 'shot.png'), 'utf8'), 'png');
  assert.ok(!existsSync(path.join(store.directory, 'artifacts', 'run-1', 'shot.png')), 'The old copy is removed');
  assert.equal(store.media('uploads'), path.join(to, 'uploads'));
  store.close?.();
});

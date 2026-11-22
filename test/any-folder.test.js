import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { inspectRepository } from '../src/repositories.js';
import { Store } from '../src/store.js';

// Any folder can be a project, not only a Git one: no branches, no remote, no GitHub.
test('a folder that is not Git is inspected as a plain project', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-plain-'));
  try {
    const found = await inspectRepository(dir);
    assert.equal(found.git, false);
    assert.equal(found.path, path.resolve(dir));
    assert.deepEqual(found.branches, []);
    assert.equal(found.remote, '');
    assert.equal(found.github.repository, null);
    await assert.rejects(inspectRepository(path.join(dir, 'missing')), /not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a plain project is saved without branches', () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-plain-'));
  try {
    const store = new Store(path.join(dir, 'data'));
    const saved = store.saveConfig({ ...store.publicConfig(), repositories: [{ name: 'Captures', path: path.join(dir, 'cap'), plain: true }] });
    assert.equal(saved.repositories[0].plain, true);
    assert.equal(saved.repositories[0].baseBranch, ''); store.close?.();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('the desk adds a plain folder as a project and refuses to publish from it', async () => {
  const { Desk } = await import('../src/coordinator.js');
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-plain-'));
  try {
    const store = new Store(path.join(dir, 'data')); const desk = new Desk(store, { root: path.join(dir, 'root') });
    const folder = path.join(dir, 'Captures'); mkdirSync(folder);
    const added = await desk.addProject(folder);
    const repository = store.config().repositories.find(item => item.path.toLowerCase() === path.resolve(folder).toLowerCase());
    assert.ok(added.project, 'the plain folder is a project an agent can be made for'); assert.ok(repository); assert.equal(repository.plain, true); assert.equal(repository.baseBranch, ''); assert.ok(added);
    await assert.rejects(desk.publishChecks({ plain: true }), /Not a Git folder/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('one worker at a time in a plain folder, even when the folder is added twice', async () => {
  const { Desk } = await import('../src/coordinator.js');
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-plain-'));
  try {
    const store = new Store(path.join(dir, 'data')); const desk = new Desk(store, { root: path.join(dir, 'root') });
    const folder = path.join(dir, 'Captures'); mkdirSync(folder);
    const saved = store.saveConfig({ ...store.publicConfig(), concurrency: 5, repositories: [{ name: 'One', path: folder, plain: true }, { name: 'Two', path: `${folder}${path.sep}`, plain: true }] });
    const [first, second] = saved.repositories; assert.ok(second && first.id !== second.id, 'two entries for one folder');
    store.put('run', 'a', { id: 'a', role: 'worker', repositoryId: first.id, state: 'running', worktree: folder }); desk.live.set('a', { controller: new AbortController() });
    store.put('run', 'b', { id: 'b', role: 'worker', repositoryId: second.id, state: 'queued' });
    await desk.drain();
    assert.equal(store.get('run', 'b').state, 'queued', 'the second worker waits for the first');
    // The same folder reached through a junction is the same folder.
    const link = path.join(dir, 'CapturesLink'); symlinkSync(folder, link, 'junction');
    store.saveConfig({ ...store.publicConfig(), repositories: [...store.config().repositories, { name: 'Three', path: link, plain: true }] });
    const third = store.config().repositories.find(item => item.name === 'Three');
    store.put('run', 'c', { id: 'c', role: 'worker', repositoryId: third.id, state: 'queued' });
    await desk.drain();
    assert.equal(store.get('run', 'c').state, 'queued', 'a junction to a busy folder waits too');
    rmSync(link, { force: true });
    desk.live.clear(); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a plain folder that became a Git project takes the branch Git reports as its base', async () => {
  const { Desk } = await import('../src/coordinator.js');
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-plain-'));
  const store = new Store(path.join(dir, 'data'));
  const desk = new Desk(store, { root: path.join(dir, 'root'), runnerFactory: () => ({ async start() {}, async interrupt() {} }), memoryDirectory: path.join(dir, 'memory') });
  try {
    const folder = path.join(dir, 'Captures'); mkdirSync(folder);
    const saved = store.saveConfig({ ...store.publicConfig(), repositories: [{ name: 'Captures', path: folder, plain: true }] });
    const git = (...args) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe' });
    git('init', '-b', 'trunk'); writeFileSync(path.join(folder, 'a.txt'), 'a'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'a');
    store.put('task', 't1', { id: 't1', title: 'Fix it', taskNumber: 'L1' });
    store.put('run', 'r', { id: 'r', role: 'worker', taskId: 't1', repositoryId: saved.repositories[0].id, state: 'starting', baseBranch: '', targetBranch: '' });
    const controller = new AbortController(); desk.live.set('r', { controller });
    await desk.execute('r', controller).catch(() => {});
    const repository = store.config().repositories[0];
    assert.ok(!repository.plain); assert.equal(repository.baseBranch, 'trunk');
    assert.equal(store.get('run', 'r').baseBranch, 'trunk', 'the queued run uses the detected branch');
    assert.equal(store.get('run', 'r').targetBranch, 'trunk');
  } finally { await desk.shutdown?.().catch(() => {}); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

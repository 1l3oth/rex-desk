import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
    desk.live.clear(); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

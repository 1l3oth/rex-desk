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

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { workFolder, runtimeFolder } from '../src/work-folder.js';
import { WORKTREE_RULE } from '../src/coordinator.js';

test('an agent\'s work folder sits next to its project on the same drive; without a project it is in the data folder', () => {
  const project = path.join(os.tmpdir(), 'dev', 'products', 'rex-desk'), data = path.join(os.tmpdir(), 'data');
  assert.equal(workFolder(project, data), path.join(os.tmpdir(), 'dev', 'products', 'rex-desk-work'));
  assert.equal(path.parse(workFolder(project)).root, path.parse(project).root, 'same drive as the project');
  assert.equal(workFolder('', data), path.join(data, 'work'));
  assert.match(WORKTREE_RULE, /work folder next to the project/); assert.match(WORKTREE_RULE, /never on drive C:/);
});

test('the runtime copy goes on the drive with the most free space among the data folder and the projects', () => {
  const data = String.raw`C:\Users\me\Rex Desk`, onD = String.raw`D:\dev\app`, onE = String.raw`E:\work\site`;
  const space = { c: 6, d: 700, e: 40 }, free = folder => (space[path.parse(path.resolve(folder)).root[0].toLowerCase()] ?? 0) * 2 ** 30;
  if (process.platform !== 'win32') return; // drive letters only exist on Windows
  assert.equal(runtimeFolder(data, [onE, onD], { free }), path.join(String.raw`D:\dev\app-work`, 'runtime'));
  assert.equal(runtimeFolder(data, [], { free }), path.join(data, 'runtime'), 'no projects: the data folder');
  assert.equal(runtimeFolder(data, [onD], { free: folder => folder === data ? 900 * 2 ** 30 : 10 }), path.join(data, 'runtime'), 'the data drive wins when it has the most room');
});

test('the old runtime copy in the data folder stays while an agent runs from a copy, and goes once none does', async () => {
  const { mkdtempSync, mkdirSync, existsSync, writeFileSync } = await import('node:fs');
  const { Store } = await import('../src/store.js');
  const { Desk } = await import('../src/coordinator.js');
  const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
  const store = new Store(temporary('old-runtime')), desk = new Desk(store, { root: temporary('root'), runnerFactory: () => ({}), memoryDirectory: temporary('memory') });
  const old = path.join(store.directory, 'runtime', '1.0.0'); mkdirSync(old, { recursive: true }); writeFileSync(path.join(old, 'ready'), 'x');
  desk.runtimeAt = path.join(temporary('project-work'), 'runtime'); desk.runtime = { node: 'n', script: 's', cwd: 'c' };
  store.put('run', 'live', { id: 'live', state: 'running', host: { pid: process.pid, outside: true } });
  assert.equal(desk.dropOldRuntime(), false); assert.ok(existsSync(old), 'a live agent may still run from it');
  store.put('run', 'live', { id: 'live', state: 'done', host: { pid: 999999, outside: true } });
  assert.equal(desk.dropOldRuntime(), true); assert.ok(!existsSync(path.join(store.directory, 'runtime')));
  await desk.shutdown(); store.close();
});

test('an agent\'s temp folder is never C:\'s temp: a work folder that cannot be made stops the run with a plain reason', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { Store } = await import('../src/store.js');
  const { Desk } = await import('../src/coordinator.js');
  const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
  const store = new Store(temporary('temp-fail')), desk = new Desk(store, { root: temporary('root'), runnerFactory: () => ({}), memoryDirectory: temporary('memory') });
  const project = path.join(temporary('proj'), 'app');
  assert.deepEqual(desk.workTemp(project), { TMP: path.join(`${project}-work`, 'tmp'), TEMP: path.join(`${project}-work`, 'tmp'), TMPDIR: path.join(`${project}-work`, 'tmp') });
  const blocked = path.join(temporary('blocked'), 'site'); writeFileSync(`${blocked}-work`, 'a file where the folder should be');
  assert.throws(() => desk.workTemp(blocked), /could not make the agent's work folder/);
  await desk.shutdown(); store.close();
});

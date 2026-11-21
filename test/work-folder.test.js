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

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorktree } from '../src/processes.js';
import { worktreeList, removeMerged, inside } from '../src/worktree-cleanup.js';
import { workFolder } from '../src/work-folder.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

test('each task gets one worktree folder inside the project\'s work folder, and only merged, clean ones are removed', async () => {
  const root = temporary('tidy'), project = path.join(root, 'app');
  git(root, 'init', '-q', '-b', 'master', project);
  git(project, 'config', 'user.email', 't@t'); git(project, 'config', 'user.name', 't');
  writeFileSync(path.join(project, 'a.txt'), 'a'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'first');
  const trees = path.join(workFolder(project), 'worktrees'), repository = { path: project, baseBranch: 'master' };
  assert.equal(trees, path.join(root, 'app-work', 'worktrees'));
  const merged = await createWorktree(repository, trees, 'fix/merged', { name: '101' });
  const dirty = await createWorktree(repository, trees, 'fix/dirty', { name: '102' });
  const open = await createWorktree(repository, trees, 'fix/open', { name: '103' });
  const fresh = await createWorktree(repository, trees, 'fix/fresh', { name: '104' });
  const again = await createWorktree(repository, trees, 'fix/again', { name: '101' });
  assert.equal(merged.directory, path.join(trees, '101')); assert.equal(again.directory, path.join(trees, '101-2'), 'a second run of a task gets its own folder');
  for (const tree of [merged.directory, dirty.directory, open.directory]) { writeFileSync(path.join(tree, `${path.basename(tree)}.txt`), 'x'); git(tree, 'add', '.'); git(tree, 'commit', '-qm', 'work'); }
  git(project, 'merge', '-q', '--no-edit', 'fix/merged'); git(project, 'merge', '-q', '--no-edit', 'fix/dirty');
  writeFileSync(path.join(dirty.directory, 'unsaved.txt'), 'not committed');
  const items = (await worktreeList(project)).filter(item => inside(trees, item.path));
  assert.equal(items.length, 5);
  const result = await removeMerged(project, items, { base: 'master', keep: item => item.path === again.directory });
  assert.deepEqual(result.removed.map(item => path.basename(item.path)), ['101']);
  assert.ok(!existsSync(merged.directory), 'the merged, clean worktree is gone');
  const why = Object.fromEntries(result.kept.map(item => [path.basename(item.path), item.reason]));
  assert.match(why['102'], /uncommitted/); assert.match(why['103'], /not merged/); assert.ok(why['104'], 'a fresh worktree with no work stays'); assert.match(why['101-2'], /still working/);
});

test('a project can name its own work folder', () => {
  const project = path.join(os.tmpdir(), 'site'), own = path.join(os.tmpdir(), 'elsewhere', 'site-work');
  assert.equal(workFolder(project, os.tmpdir(), [{ path: project, workFolder: own }]), own);
  assert.equal(workFolder(project, os.tmpdir(), [{ path: path.join(os.tmpdir(), 'other'), workFolder: own }]), path.join(os.tmpdir(), 'site-work'));
});

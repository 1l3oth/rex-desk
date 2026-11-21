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

test('a merged worktree stays while it holds ignored files or a live chat works in it', async () => {
  const { Store } = await import('../src/store.js');
  const { Desk } = await import('../src/coordinator.js');
  const root = temporary('tidy-keep'), project = path.join(root, 'app');
  git(root, 'init', '-q', '-b', 'master', project);
  git(project, 'config', 'user.email', 't@t'); git(project, 'config', 'user.name', 't');
  writeFileSync(path.join(project, '.gitignore'), '.env\n'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'first');
  const trees = path.join(workFolder(project), 'worktrees'), repository = { path: project, baseBranch: 'master' };
  const made = {};
  for (const name of ['201', '202', '203']) {
    made[name] = (await createWorktree(repository, trees, `fix/${name}`, { name })).directory;
    writeFileSync(path.join(made[name], `${name}.txt`), 'x'); git(made[name], 'add', '.'); git(made[name], 'commit', '-qm', 'work');
    git(project, 'merge', '-q', '--no-edit', `fix/${name}`);
  }
  git(project, 'commit', '-q', '--allow-empty', '-m', 'later'); git(project, 'update-ref', 'refs/remotes/origin/master', 'master');
  writeFileSync(path.join(made['201'], '.env'), 'KEY=local');
  const store = new Store(temporary('tidy-keep-store'));
  store.saveConfig({ ...store.publicConfig(), repositories: [{ name: 'app', path: project, baseBranch: 'master' }] });
  store.put('run', 'chat', { id: 'chat', role: 'specialist', state: 'waiting', cwd: path.join(made['202'], 'src'), projectPath: project });
  const desk = new Desk(store, { root: temporary('tidy-keep-root'), runnerFactory: () => ({}), memoryDirectory: temporary('tidy-keep-memory') });
  const [result] = await desk.tidyWorktrees();
  assert.deepEqual(result.removed.map(item => path.basename(item.path)), ['203']);
  const why = Object.fromEntries(result.kept.map(item => [path.basename(item.path), item.reason]));
  assert.match(why['201'], /ignored/); assert.match(why['202'], /still working/);
  assert.ok(existsSync(path.join(made['201'], '.env')), 'the ignored file is still there');
  await desk.shutdown(); store.close();
});

test('a chat that resumes in a worktree during the Git checks keeps it', async () => {
  const root = temporary('tidy-race'), project = path.join(root, 'app');
  git(root, 'init', '-q', '-b', 'master', project);
  git(project, 'config', 'user.email', 't@t'); git(project, 'config', 'user.name', 't');
  writeFileSync(path.join(project, 'a.txt'), 'a'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'first');
  const trees = path.join(workFolder(project), 'worktrees');
  const tree = (await createWorktree({ path: project, baseBranch: 'master' }, trees, 'fix/race', { name: '301' })).directory;
  writeFileSync(path.join(tree, 'b.txt'), 'b'); git(tree, 'add', '.'); git(tree, 'commit', '-qm', 'work');
  git(project, 'merge', '-q', '--no-edit', 'fix/race'); git(project, 'commit', '-q', '--allow-empty', '-m', 'later');
  let asked = 0;
  const result = await removeMerged(project, await worktreeList(project), { base: 'master', keep: () => asked++ > 0 });
  assert.equal(asked, 2, 'asked again right before removing');
  assert.equal(result.removed.length, 0); assert.match(result.kept[0].reason, /still working/);
  assert.ok(existsSync(tree));
});

test('removal holds a lock through its last live check, and an agent starting in the worktree waits for it', async () => {
  const { lockFile, lockedFolder, takeLock, waitUnlocked } = await import('../src/worktree-cleanup.js');
  const root = temporary('tidy-lock'), project = path.join(root, 'app');
  git(root, 'init', '-q', '-b', 'master', project);
  git(project, 'config', 'user.email', 't@t'); git(project, 'config', 'user.name', 't');
  writeFileSync(path.join(project, 'a.txt'), 'a'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'first');
  const trees = path.join(workFolder(project), 'worktrees'), made = [];
  for (const name of ['401', '402']) {
    const tree = (await createWorktree({ path: project, baseBranch: 'master' }, trees, `fix/${name}`, { name })).directory; made.push(tree);
    writeFileSync(path.join(tree, `${name}.txt`), 'b'); git(tree, 'add', '.'); git(tree, 'commit', '-qm', 'work');
    git(project, 'merge', '-q', '--no-edit', `fix/${name}`);
  }
  git(project, 'commit', '-q', '--allow-empty', '-m', 'later');
  const other = takeLock(made[1]);
  assert.equal(takeLock(made[1]), null, 'one cleanup at a time');
  const lockedAtLastCheck = [];
  const result = await removeMerged(project, await worktreeList(project), { base: 'master', keep: item => { lockedAtLastCheck.push(existsSync(lockFile(item.path))); return false; } });
  assert.deepEqual(result.removed.map(item => path.basename(item.path)), ['401']);
  assert.match(result.kept[0].reason, /another cleanup/);
  assert.deepEqual(lockedAtLastCheck.slice(0, 2), [false, true], 'the last live check runs under the lock');
  assert.ok(!existsSync(lockFile(made[0])), 'the lock is gone after removal');
  assert.equal(lockedFolder(path.join(made[1], 'src')), made[1], 'a folder inside a locked worktree is locked');
  let waited = false;
  const start = waitUnlocked([path.join(made[1], 'src')], { everyMs: 20 }).then(() => { waited = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(waited, false, 'an agent does not start while the worktree is being removed');
  other(); await start; assert.equal(waited, true);
});

test('the tidy script reads the project from any position and --apply keeps worktrees live runs use', async () => {
  const { parseArgs, liveFolders } = await import('../scripts/tidy-worktrees.mjs');
  const project = path.join(os.tmpdir(), 'app');
  assert.equal(parseArgs([project]).project, project, 'without --base the first argument is the project');
  assert.deepEqual(parseArgs(['--base', 'origin/main', project, '--apply']), { apply: true, base: 'origin/main', data: '', project });
  assert.equal(parseArgs(['--apply', '--data', 'D:\\data', project]).project, project);
  const { Store } = await import('../src/store.js');
  const data = temporary('tidy-data'), store = new Store(data);
  store.put('run', 'live', { id: 'live', state: 'waiting', cwd: path.join(project, 'x') });
  store.put('run', 'old', { id: 'old', state: 'done', worktree: path.join(project, 'y') });
  store.close();
  assert.deepEqual(liveFolders(data), [path.resolve(project, 'x').toLowerCase()]);
  // A signed-in account keeps its runs in its own database (workspaces\<id>); those count too.
  const account = new Store(path.join(data, 'workspaces', 'acc1'));
  account.put('run', 'chat', { id: 'chat', state: 'running', worktree: path.join(project, 'z') });
  account.close();
  writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({ workspaces: [{ id: 'acc1', dir: path.join('workspaces', 'acc1') }] }));
  assert.deepEqual(liveFolders(data).sort(), [path.resolve(project, 'x'), path.resolve(project, 'z')].map(folder => folder.toLowerCase()).sort());
  assert.throws(() => liveFolders(temporary('tidy-empty')), /No Rex Desk database/);
});

test('a project can name its own work folder', () => {
  const project = path.join(os.tmpdir(), 'site'), own = path.join(os.tmpdir(), 'elsewhere', 'site-work');
  assert.equal(workFolder(project, os.tmpdir(), [{ path: project, workFolder: own }]), own);
  assert.equal(workFolder(project, os.tmpdir(), [{ path: path.join(os.tmpdir(), 'other'), workFolder: own }]), path.join(os.tmpdir(), 'site-work'));
});

test('a project\'s work folder is saved from Settings, Projects, and the agents\' worktrees follow it', async () => {
  const { Store } = await import('../src/store.js');
  const { Desk } = await import('../src/coordinator.js');
  const store = new Store(temporary('work-config')), project = temporary('work-project'), own = path.join(temporary('own-work'), 'site-work');
  const save = repository => store.saveConfig({ ...store.publicConfig(), repositories: [{ name: 'site', path: project, baseBranch: 'master', ...repository }] });
  save({ workFolder: own });
  assert.equal(store.config().repositories[0].workFolder, own);
  const desk = new Desk(store, { root: temporary('work-root'), runnerFactory: () => ({}), memoryDirectory: temporary('work-memory') });
  assert.equal(desk.worktreeRootFor(store.config().repositories[0]), path.join(own, 'worktrees'));
  assert.throws(() => save({ workFolder: 'relative\work' }), /full path of the work folder/);
  if (process.platform === 'win32') {
    const other = /^c:/i.test(project) ? 'D:\\site-work' : 'C:\\site-work';
    assert.throws(() => save({ workFolder: other }), /same drive as the project/);
  }
  save({ workFolder: '' });
  assert.equal(store.config().repositories[0].workFolder, undefined, 'empty goes back to the folder next to the project');
  assert.equal(desk.worktreeRootFor(store.config().repositories[0]), path.join(`${project}-work`, 'worktrees'));
  await desk.shutdown(); store.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { git } from '../src/processes.js';
import { parseWorktreeList, worktreeId } from '../src/worktrees.js';
import { markdown } from '../public/chat-markdown.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('reads git worktree list output, main checkout first', () => {
  const list = parseWorktreeList('worktree C:/repo\nHEAD abc\nbranch refs/heads/master\n\nworktree C:/repo-wt/one\nHEAD def\nbranch refs/heads/temp/rex/one\n\nworktree C:/gone\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(list.map(item => [item.path, item.branch || '', Boolean(item.prunable)]), [['C:/repo', 'master', false], ['C:/repo-wt/one', 'temp/rex/one', false], ['C:/gone', '', true]]);
});

test('a chat message with a worktree marker draws a card slot', () => {
  const html = markdown('**Worktree: temp/rex/one**\nMade for the login fix.\n[[worktree:abc123def456]]');
  assert.match(html, /<div class="wt-embed" data-worktree="abc123def456"><\/div>/);
  assert.doesNotMatch(html, /\[\[worktree/);
});

test('worktree history: found from git, tasks live in one worktree, shown in chat, kept after removal', async () => {
  const directory = temporary('worktrees'), repository = path.join(directory, 'source'); mkdirSync(repository);
  await git(repository, ['init', '-b', 'master']); await git(repository, ['config', 'user.name', 'Test']); await git(repository, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(repository, 'a.txt'), 'a'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'Fixture']);
  const first = path.join(directory, 'wt-one'), second = path.join(directory, 'wt-two');
  await git(repository, ['worktree', 'add', '-b', 'temp/rex/one', first]); await git(repository, ['worktree', 'add', '-b', 'temp/rex/two', second]);
  const store = new Store(path.join(directory, 'data'));
  store.saveConfig({ ...defaults, repositories: [{ id: 'repository-1', name: 'Fixture', path: repository, baseBranch: 'master', targetBranch: 'master' }], sources: [] });
  const desk = new Desk(store, { root: directory, runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  try {
    for (const [id, number] of [['task-1', 'L1'], ['task-2', 'L2']]) store.put('task', id, { id, title: `Fix ${number}`, taskNumber: number, source: 'local', active: true });
    const listed = await desk.worktrees.list();
    assert.deepEqual(listed.map(item => item.branch).sort(), ['temp/rex/one', 'temp/rex/two']);
    assert.equal(listed[0].project, 'Fixture');

    const one = worktreeId(first), two = worktreeId(second);
    desk.worktrees.addTask(one, 'task-1'); desk.worktrees.addTask(one, 'task-2');
    assert.match(desk.worktrees.briefFor('task-2'), /lives in the worktree .*wt-one.* together with #L1 Fix L1/);
    // A task lives in one worktree at a time.
    desk.worktrees.addTask(two, 'task-2');
    assert.deepEqual(store.get('worktree', one).tasks, ['task-1']);
    assert.deepEqual(store.get('worktree', two).tasks, ['task-2']);

    store.put('run', 'run-1', { id: 'run-1', role: 'specialist', state: 'finished', title: 'Chat', createdAt: new Date().toISOString() });
    const shown = await desk.worktreeAction('run-1', { worktree: 'temp/rex/one', note: 'Made for the login fix.' });
    assert.equal(shown.where, 'chat');
    const said = store.events('run-1', { visible: true }).find(event => event.kind === 'message');
    assert.match(said.text, new RegExp(`\[\[worktree:${one}\]\]`));
    await assert.rejects(desk.worktreeAction('run-1', { worktree: path.join(directory, 'nowhere') }), /No worktree/);

    // The side panel's source control list: changed and new files with their lines; the chat it was shown in lists it.
    writeFileSync(path.join(first, 'a.txt'), 'a\nb\nc'); writeFileSync(path.join(first, 'new.txt'), 'x\ny');
    const changes = await desk.worktrees.changes(one);
    assert.equal(changes.branch, 'temp/rex/one');
    assert.deepEqual(changes.files.map(file => [file.name, file.status, file.added, file.removed]).sort(), [['a.txt', 'M', 3, 1], ['new.txt', 'U', 2, 0]]);
    assert.ok(store.get('worktree', one).chats.includes('run:run-1'));

    await git(repository, ['worktree', 'remove', second]);
    const after = await desk.worktrees.scan({ force: true });
    const gone = after.find(item => item.id === two);
    assert.equal(gone.state, 'gone'); assert.deepEqual(gone.tasks, ['task-2']);
    assert.equal(desk.worktrees.briefFor('task-2'), '', 'a removed worktree is history, not a place to work');
  } finally { await desk.shutdown(); store.close(); }
});

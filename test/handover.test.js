import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../src/processes.js';
import { saveWork, pickUp } from '../src/handover.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
// A shared repository, the clone on the computer the agent leaves (with the agent's own worktree), and the clone it moves to.
async function setup() {
  const origin = temporary('ho-origin'), seed = temporary('ho-seed');
  await git(origin, ['init', '--bare', '-b', 'master']);
  await git(seed, ['init', '-b', 'master']); await git(seed, ['config', 'core.autocrlf', 'false']); await git(seed, ['config', 'user.email', 'qa@example.invalid']); await git(seed, ['config', 'user.name', 'QA']);
  writeFileSync(path.join(seed, 'app.txt'), 'one\n'); await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'start']);
  await git(seed, ['remote', 'add', 'origin', origin]); await git(seed, ['push', '-q', 'origin', 'master']);
  const clone = async label => { const folder = temporary(label); await git(folder, ['clone', '-q', '-c', 'core.autocrlf=false', origin, '.']); await git(folder, ['config', 'user.email', 'qa@example.invalid']); await git(folder, ['config', 'user.name', 'QA']); return folder; };
  const home = await clone('ho-home'), work = await clone('ho-work');
  const worktree = path.join(temporary('ho-wt'), 'agent');
  await git(home, ['worktree', 'add', '-q', '-b', 'rex/desky/cart', worktree, 'origin/master']);
  await git(worktree, ['config', 'user.email', 'qa@example.invalid']); await git(worktree, ['config', 'user.name', 'QA']);
  writeFileSync(path.join(worktree, 'app.txt'), 'one\ntwo\n'); await git(worktree, ['commit', '-qam', 'cart: part one']);
  return { home, work, worktree };
}

test('before an agent moves, its unsaved work becomes a WIP commit on its own branch and arrives on the other computer', async () => {
  const { home, work, worktree } = await setup();
  writeFileSync(path.join(worktree, 'app.txt'), 'one\ntwo\nthree (not committed yet)\n'); writeFileSync(path.join(worktree, 'new.txt'), 'a new file\n');
  const saved = await saveWork({ worktree, project: home, agentName: 'Desky', to: 'Work' });
  assert.equal(saved.branch, 'rex/desky/cart'); assert.ok(saved.committed, 'a WIP commit was made'); assert.ok(saved.bundle.length > 0);
  assert.equal(await git(worktree, ['status', '--porcelain']), '', 'nothing left uncommitted');
  assert.match(await git(worktree, ['log', '-1', '--format=%s']), /^WIP: Desky moves to Work/);
  assert.equal(await git(home, ['rev-parse', '--abbrev-ref', 'HEAD']), 'master', 'the shared folder was not touched');
  // On the other computer: unpacked into a worktree of the agent's own, on the same branch, with every change.
  const directory = path.join(temporary('ho-there'), 'desky-cart');
  const picked = await pickUp({ project: work, branch: saved.branch, head: saved.head, bundle: saved.bundle, directory });
  assert.equal(picked.branch, 'rex/desky/cart'); assert.equal(picked.head, saved.head);
  assert.equal(readFileSync(path.join(directory, 'app.txt'), 'utf8'), 'one\ntwo\nthree (not committed yet)\n'); assert.ok(existsSync(path.join(directory, 'new.txt')));
  assert.equal(await git(work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'master', 'the folder there was not switched either');
});

// No worktree of its own: someone else's changes in the shared folder never block the move and stay exactly as they were.
test('an agent with no worktree and no changes of its own moves, and the others\' changes in the shared folder stay untouched', async () => {
  const { home } = await setup();
  writeFileSync(path.join(home, 'app.txt'), 'changed by someone\n'); writeFileSync(path.join(home, 'theirs.txt'), 'their new file\n');
  const before = await git(home, ['status', '--porcelain']), head = await git(home, ['rev-parse', 'HEAD']);
  const saved = await saveWork({ worktree: '', project: home, agentName: 'Desky', ownFiles: [path.join(home, 'elsewhere.txt')] });
  assert.deepEqual(saved, { nothing: true, others: 2 });
  assert.equal(await git(home, ['status', '--porcelain']), before, 'the folder is as it was');
  assert.equal(await git(home, ['rev-parse', 'HEAD']), head, 'nothing was committed');
  assert.equal(await git(home, ['branch', '--list', 'rex-handover/*']), '', 'no branch was made');
});

test('an agent with no worktree carries only the files it changed itself, and the shared folder stays as it was', async () => {
  const { home, work } = await setup();
  writeFileSync(path.join(home, 'app.txt'), 'changed by someone else\n');
  writeFileSync(path.join(home, 'mine.txt'), 'written by Desky\n'); writeFileSync(path.join(home, 'notes.md'), 'someone else\'s note\n');
  const before = await git(home, ['status', '--porcelain']), head = await git(home, ['rev-parse', 'HEAD']), index = await git(home, ['diff', '--cached', '--name-only']);
  const saved = await saveWork({ worktree: '', project: home, agentName: 'Desky', to: 'Work', ownFiles: [path.join(home, 'mine.txt')] });
  assert.equal(saved.branch, 'rex-handover/desky'); assert.deepEqual(saved.files, ['mine.txt']); assert.equal(saved.others, 2); assert.ok(saved.bundle.length > 0);
  assert.equal(await git(home, ['status', '--porcelain']), before, 'nobody\'s files changed in the shared folder');
  assert.equal(await git(home, ['rev-parse', 'HEAD']), head); assert.equal(await git(home, ['rev-parse', '--abbrev-ref', 'HEAD']), 'master');
  assert.equal(await git(home, ['diff', '--cached', '--name-only']), index, 'nothing was staged');
  assert.deepEqual((await git(home, ['diff', '--name-only', head, saved.head])).split('\n'), ['mine.txt'], 'the commit holds only its own file');
  const directory = path.join(temporary('ho-own'), 'desky');
  const picked = await pickUp({ project: work, branch: saved.branch, head: saved.head, bundle: saved.bundle, directory });
  assert.equal(picked.head, saved.head);
  assert.equal(readFileSync(path.join(directory, 'mine.txt'), 'utf8'), 'written by Desky\n');
  assert.equal(existsSync(path.join(directory, 'notes.md')), false, 'someone else\'s file did not travel');
  assert.equal(readFileSync(path.join(directory, 'app.txt'), 'utf8'), 'one\n', 'someone else\'s change did not travel');
});

test('a file holding someone else\'s lines (before or after the agent\'s edit) and others\' unpushed commits never travel', async () => {
  const { home } = await setup();
  writeFileSync(path.join(home, 'theirs.txt'), 'their commit\n'); await git(home, ['add', 'theirs.txt']); await git(home, ['commit', '-qm', 'someone else, not pushed']);
  writeFileSync(path.join(home, 'mine.txt'), 'written by Desky\n');
  // Someone else wrote shared.txt first; Desky edited it last. Both changes are in the file, so it stays whole.
  writeFileSync(path.join(home, 'shared.txt'), 'someone else\nDesky\n');
  const saved = await saveWork({ worktree: '', project: home, agentName: 'Desky', ownFiles: [
    { file: path.join(home, 'mine.txt'), lines: ['+written by Desky'], complete: true },
    { file: path.join(home, 'shared.txt'), lines: ['+Desky'], complete: true }] });
  assert.deepEqual(saved.files, ['mine.txt']); assert.deepEqual(saved.mixed, ['shared.txt'], 'the move names the file it left behind');
  assert.equal(saved.others, 2, 'shared.txt and the unpushed theirs.txt stay');
  assert.deepEqual((await git(home, ['diff', '--name-only', 'origin/master', saved.head])).split('\n'), ['mine.txt'], 'the commit sits on origin/master, without the unpushed commit');
  assert.equal(saved.base, await git(home, ['rev-parse', 'origin/master']));
  // A file whose diff was cut off (or is a secret file) cannot be shown to be Desky's alone, so it stays too.
  const cut = await saveWork({ worktree: '', project: home, agentName: 'Desky', ownFiles: [{ file: path.join(home, 'mine.txt'), lines: ['+written by Desky'], complete: false }] });
  assert.equal(cut.nothing, true); assert.deepEqual(cut.mixed, ['mine.txt']);
});

test('work is never committed on master or a release branch: the move stops with a reason and nothing is committed', async () => {
  const { home, worktree } = await setup();
  // Its worktree on a protected branch (master, main, release/...) with changes.
  await git(worktree, ['checkout', '-q', '-B', 'release/2.0', 'origin/master']); writeFileSync(path.join(worktree, 'app.txt'), 'on a release branch\n');
  await assert.rejects(saveWork({ worktree, project: home, agentName: 'Desky' }), /on release\/2\.0, where work is never committed/);
  assert.match(await git(worktree, ['status', '--porcelain']), /app\.txt/);
  // A clean shared folder and no worktree: nothing to save, the move may go on.
  await git(home, ['checkout', '-q', '--', 'app.txt']);
  assert.deepEqual(await saveWork({ worktree: '', project: home, agentName: 'Desky' }), { nothing: true });
});

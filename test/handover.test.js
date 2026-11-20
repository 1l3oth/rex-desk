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

test('work is never committed in a shared folder or on master: the move stops with a reason and nothing is committed', async () => {
  const { home, worktree } = await setup();
  // No worktree of its own, and the shared folder has changes (maybe someone else's).
  writeFileSync(path.join(home, 'app.txt'), 'changed by someone\n');
  await assert.rejects(saveWork({ worktree: '', project: home, agentName: 'Desky' }), /no worktree of its own[\s\S]*someone else's/);
  assert.match(await git(home, ['status', '--porcelain']), /app\.txt/, 'left as it was');
  // Its worktree on a protected branch (master, main, release/...) with changes.
  await git(worktree, ['checkout', '-q', '-B', 'release/2.0', 'origin/master']); writeFileSync(path.join(worktree, 'app.txt'), 'on a release branch\n');
  await assert.rejects(saveWork({ worktree, project: home, agentName: 'Desky' }), /on release\/2\.0, where work is never committed/);
  assert.match(await git(worktree, ['status', '--porcelain']), /app\.txt/);
  // A clean shared folder and no worktree: nothing to save, the move may go on.
  await git(home, ['checkout', '-q', '--', 'app.txt']);
  assert.deepEqual(await saveWork({ worktree: '', project: home, agentName: 'Desky' }), { nothing: true });
});

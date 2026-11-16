import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../src/processes.js';
import { pullLiveCheckout } from '../src/live-checkout.js';

const make = async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-live-')), bare = path.join(base, 'origin.git'), live = path.join(base, 'live'), other = path.join(base, 'other');
  await git(base, ['init', '--bare', '-b', 'master', bare]);
  for (const folder of [live, other]) { mkdirSync(folder); }
  await git(live, ['init', '-b', 'master']); await git(live, ['config', 'user.email', 'a@b.c']); await git(live, ['config', 'user.name', 'a']);
  writeFileSync(path.join(live, 'a.txt'), '1'); await git(live, ['add', '.']); await git(live, ['commit', '-m', 'one']); await git(live, ['remote', 'add', 'origin', bare]); await git(live, ['push', 'origin', 'master']);
  await git(other, ['clone', bare, '.']); await git(other, ['config', 'user.email', 'a@b.c']); await git(other, ['config', 'user.name', 'a']);
  const push = async file => { mkdirSync(path.dirname(path.join(other, file)), { recursive: true }); writeFileSync(path.join(other, file), String(Math.random())); await git(other, ['add', '.']); await git(other, ['commit', '-m', file]); await git(other, ['push', 'origin', 'HEAD:master']); };
  return { live, push };
};

test('a push to Rex Desk itself fast-forwards the live checkout and says what to do next', async () => {
  const { live, push } = await make();
  await push('public/x.js');
  assert.match(await pullLiveCheckout({ root: live, repositoryPath: live, target: 'master' }), /Refresh the page/);
  await push('src/y.js');
  assert.match(await pullLiveCheckout({ root: live, repositoryPath: live, target: 'master' }), /needs a restart/);
});

test('another project, a dirty folder or another branch is left alone with a reason', async () => {
  const { live, push } = await make();
  await push('public/x.js');
  assert.equal(await pullLiveCheckout({ root: live, repositoryPath: path.join(live, '..', 'other'), target: 'master' }), '');
  writeFileSync(path.join(live, 'a.txt'), 'edited');
  assert.match(await pullLiveCheckout({ root: live, repositoryPath: live, target: 'master' }), /not committed/);
  await git(live, ['checkout', '--', 'a.txt']);
  assert.match(await pullLiveCheckout({ root: live, repositoryPath: live, target: 'develop' }), /not develop/);
});

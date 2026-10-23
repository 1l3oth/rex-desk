import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessRisk, automaticPrAllowed } from '../src/risk.js';
import { git } from '../src/processes.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
async function repository(files) {
  const directory = temporary('risk');
  await git(directory, ['init', '-b', 'develop']);
  await git(directory, ['config', 'user.name', 'Rex Desk Test']); await git(directory, ['config', 'user.email', 'qa@example.invalid']);
  writeFileSync(path.join(directory, 'README.md'), 'base\n');
  await git(directory, ['add', '.']); await git(directory, ['commit', '-m', 'base']);
  const baseCommit = await git(directory, ['rev-parse', 'HEAD']);
  for (const [name, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); writeFileSync(path.join(directory, name), content); }
  await git(directory, ['add', '.']); await git(directory, ['commit', '-m', 'change']);
  return { worktree: directory, baseCommit };
}
const low = { score: 1, requiresHumanReview: false, reason: 'One stylesheet rule changed and the browser assertion covers it.' };

test('risk floors override an optimistic agent score for application, sensitive, and broad changes', async () => {
  const style = await assessRisk(await repository({ 'web/app.css': '.button{color:red}\n' }), low, 'fp');
  assert.equal(style.score, 1);
  assert.equal(style.requiresHumanReview, false);
  const code = await assessRisk(await repository({ 'src/app.js': 'export const fixed = true;\n' }), low, 'fp');
  assert.equal(code.score, 4);
  assert.equal(code.requiresHumanReview, true);
  const sensitive = await assessRisk(await repository({ 'src/WEB-INF/jex/config/jex.content.user.xml': '<jex/>' }), low, 'fp');
  assert.ok(sensitive.score >= 7);
  const broad = await assessRisk(await repository(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`docs/page-${index}.md`, 'text\n']))), low, 'fp');
  assert.ok(broad.score >= 6);
  const silent = await assessRisk(await repository({ 'web/app.css': 'x\n' }), undefined, 'fp');
  assert.equal(silent.score, 10);
  await assert.rejects(assessRisk({ worktree: '.', baseCommit: 'HEAD' }, { score: 0, requiresHumanReview: false, reason: 'x' }, 'fp'), /score 1–10/);
});

test('automatic draft PRs need the setting, verified current evidence, a 1–2 score, and no review flag', () => {
  const run = { state: 'ready_for_review', checks: { testsPassed: true, recordedVideo: true, browserAssertionPassed: true },
    risk: { score: 2, requiresHumanReview: false, fingerprint: 'current' }, verification: { fingerprint: 'current' } };
  const config = { autoPrLowRisk: true, requireVideo: true };
  assert.equal(automaticPrAllowed(config, run, 'current'), true);
  assert.equal(automaticPrAllowed({ ...config, autoPrLowRisk: false }, run, 'current'), false, 'Off by default');
  assert.equal(automaticPrAllowed(config, run, 'changed'), false, 'Code changed after verification');
  assert.equal(automaticPrAllowed(config, { ...run, risk: { ...run.risk, score: 3 } }, 'current'), false);
  assert.equal(automaticPrAllowed(config, { ...run, risk: { ...run.risk, requiresHumanReview: true } }, 'current'), false);
  assert.equal(automaticPrAllowed(config, { ...run, checks: { ...run.checks, recordedVideo: false } }, 'current'), false);
  assert.equal(automaticPrAllowed({ ...config, requireVideo: false }, { ...run, checks: { ...run.checks, recordedVideo: false } }, 'current'), true);
  assert.equal(automaticPrAllowed(config, { ...run, state: 'needs_evidence' }, 'current'), false);
});

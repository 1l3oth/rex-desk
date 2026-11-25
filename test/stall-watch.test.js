import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchStalls, stopStallWatch, doing, step, waitStep } from '../src/stall-watch.js';

test('a stuck server writes to the log how long it was stuck and what it was doing', async () => {
  const logFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-stall-')), 'server-error.log');
  watchStalls({ logFile, threshold: 400, every: 50 });
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    doing('cloud sync: uploading everything');
    const until = Date.now() + 1600; while (Date.now() < until) { /* the main thread is blocked, as a big disk read would */ }
    doing('GET /api/state');
    for (let i = 0; i < 40 && !(existsSync(logFile) && /was stuck/.test(readFileSync(logFile, 'utf8'))); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const log = readFileSync(logFile, 'utf8');
    assert.match(log, /Rex Desk server was stuck for \d+\.\ds while: cloud sync: uploading everything/);
  } finally { stopStallWatch(); }
});

test('a freeze names the database step really running with its time, and a slow step is logged by name', async () => {
  const logFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-stall-')), 'server-error.log');
  watchStalls({ logFile, threshold: 400, every: 50 });
  const block = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* a slow database call */ } };
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    step('sync chat: applyChatEvents (500 rows, page 1)', () => block(80));
    // A step that already ended is cleared: a later freeze is never blamed on it.
    step('sync chat: save read position', () => block(1600));
    for (let i = 0; i < 40 && !(existsSync(logFile) && /was stuck/.test(readFileSync(logFile, 'utf8'))); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const log = readFileSync(logFile, 'utf8');
    assert.match(log, /was stuck for \d+\.\ds while: sync chat: save read position \(step running \d+ ms\)/);
    assert.match(log, /Slow step: sync chat: save read position took 1[56]\d\d ms/);
    assert.doesNotMatch(log, /applyChatEvents/, 'a quick step is not logged');
    assert.equal(await waitStep('sync chat: cloud page 1', async () => 7), 7);
  } finally { stopStallWatch(); }
});

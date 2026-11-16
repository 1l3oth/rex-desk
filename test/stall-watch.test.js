import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchStalls, stopStallWatch, doing } from '../src/stall-watch.js';

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

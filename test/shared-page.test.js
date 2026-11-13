import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { evidenceId } from '../src/peers.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('a page an agent shared on another computer opens here from the shared copy of the chat', () => {
  const store = new Store(temporary('shared-page')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const runId = randomUUID(), name = '1794542525961-eli5-sync.html', html = '<!doctype html><title>Plan</title><p>Hello</p>';
  store.put('chatfile', evidenceId(runId, name), { id: evidenceId(runId, name), path: `evidence:${runId}/${name}`, name, size: html.length, data: Buffer.from(html).toString('base64'), at: new Date().toISOString() });
  const file = path.join(store.directory, 'artifacts', runId, name);
  assert.equal(existsSync(file), false);
  const opened = desk.files.open(file, runId);
  assert.equal(opened.kind, 'html');
  assert.match(opened.text, /Hello/);
  desk.closed = true;
});

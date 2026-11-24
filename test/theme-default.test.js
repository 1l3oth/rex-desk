import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const themeSource = readFileSync(path.join(here, '..', 'public', 'theme.js'), 'utf8');

// A fresh install's data folder does not exist yet; an existing install's does.
const freshDir = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-fresh-')), 'brand-new');
const existingDir = () => mkdtempSync(path.join(os.tmpdir(), 'rex-desk-existing-'));

const newFlag = html => /<html lang="en" data-rex-new="(true|false)"/.exec(html)?.[1];

test('a brand-new install is flagged new once, then the marker is consumed', async () => {
  const dir = freshDir();
  assert.equal(existsSync(dir), false, 'the data folder does not exist before the first launch');
  const app = await createApp({ dataDirectory: dir, port: 0 });
  try {
    const first = await (await fetch(app.address + '/')).text();
    assert.equal(newFlag(first), 'true', 'the first page of a brand-new install is flagged new');
    const second = await (await fetch(app.address + '/')).text();
    assert.equal(newFlag(second), 'false', 'the next page is no longer new: the marker was consumed');
  } finally { await app.close(); }
});

test('an existing install is never flagged new, with or without saved data', async () => {
  const dir = existingDir();
  const app = await createApp({ dataDirectory: dir, port: 0 });
  try {
    const page = await (await fetch(app.address + '/')).text();
    assert.equal(newFlag(page), 'false', 'a data folder that already existed is not a new install');
  } finally { await app.close(); }
});

// theme.js runs in the browser: it reads the <html data-rex-new> attribute (from the server) and a saved choice from localStorage.
function runTheme({ rexNew, saved }) {
  const store = new Map(); if (saved) store.set('rex-desk-skin', saved);
  const root = { dataset: {}, classList: { add() {} } };
  if (rexNew !== undefined) root.dataset.rexNew = rexNew ? 'true' : 'false';
  const context = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: { documentElement: root },
    location: { search: '' },
    URLSearchParams, Event: class { constructor() {} },
    dispatchEvent() {},
  };
  context.window = context;
  vm.runInNewContext(themeSource, context);
  return { skin: root.dataset.skin, saved: store.get('rex-desk-skin') };
}

test('theme.js defaults a new install to Water Festival and saves it, but leaves everyone else on Midnight', () => {
  assert.deepEqual(runTheme({ rexNew: true }), { skin: 'waterfest', saved: 'waterfest' }, 'a new install opens on Water Festival and it sticks');
  assert.equal(runTheme({ rexNew: false }).skin, 'midnight', 'an existing install with no saved choice starts on Midnight');
  assert.equal(runTheme({}).skin, 'midnight', 'with no new-install flag at all, Midnight');
});

test('a saved choice always wins, even on a new install', () => {
  assert.equal(runTheme({ rexNew: true, saved: 'forest' }).skin, 'forest', 'a saved look beats the new-install default');
  assert.equal(runTheme({ rexNew: false, saved: 'sunset' }).skin, 'sunset', 'an existing person keeps their saved look');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('a desk an agent starts (a test, a script) never copies the installed runtime, even with the app\'s settings inherited', async () => {
  process.env.REX_DESK_VERSION = '9.9.9';
  try {
    const store = new Store(temporary('own-runtime'));
    const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(!existsSync(path.join(store.directory, 'runtime')), 'No runtime copy beside a desk that is not the installed server');
    desk.closed = true; desk.close?.();
  } finally { delete process.env.REX_DESK_VERSION; }
});

test('a dev run from a checkout (inherited app version, its own REX_DATA_DIR) never makes the runtime copy: agents run from the dev folder', async () => {
  const { createApp } = await import('../src/server.js');
  const data = temporary('dev-data'), saved = { ...process.env };
  Object.assign(process.env, { REX_DESK_VERSION: '9.9.9', REX_DESK_EXE: path.join(temporary('install'), 'rex-desk.exe'), REX_DATA_DIR: data });
  let app;
  try {
    app = await createApp({ port: 0 });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(!existsSync(path.join(data, 'runtime')), 'no runtime copy for a dev or test run');
    assert.equal(app.desk?.runtime ?? null, null);
  } finally {
    for (const name of ['REX_DESK_VERSION', 'REX_DESK_EXE', 'REX_DATA_DIR']) if (name in saved) process.env[name] = saved[name]; else delete process.env[name];
    await app?.close();
  }
});

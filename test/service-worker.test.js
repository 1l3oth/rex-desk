import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

// L88: the phone keeps the app's own files saved, so only data crosses the relay. The worker carries the running build in
// its cache name, and never saves pages or the data API, so a new release refreshes and a signed-out phone sees no data.
test('the phone service worker is served with the build written in and caches only app files', async () => {
  const app = await createApp({ dataDirectory: temporary('sw'), port: 0 });
  try {
    const response = await fetch(app.address + '/sw.js');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /javascript/);
    assert.equal(response.headers.get('cache-control'), 'no-cache', 'the worker itself revalidates so a new build is taken');
    const body = await response.text();
    assert.ok(!body.includes('__REX_BUILD__'), 'the build placeholder is filled in');
    assert.ok(!body.includes('__REX_PRECACHE__'), 'the precache list is filled in');
    assert.match(body, /rexdesk-app-/, 'the cache is named after the build');
    // The app shell is precached at install, so the next open needs none of it from the relay.
    assert.match(body, /"\/chat\.css"/);
    assert.match(body, /"\/chat\.js"/);
    assert.ok(!body.includes('"/chat.html"'), 'pages are not precached');
    // Pages and the data API stay on the network, so a new version loads and nothing private is saved.
    assert.match(body, /request\.mode === 'navigate'/);
    assert.match(body, /\/api\//);
  } finally { await app.close(); }
});

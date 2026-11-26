import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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
    assert.match(body, /APP_FILES\.has\(url\.pathname\)/, 'only files on the list are ever saved');
  } finally { await app.close(); }
});

// The worker itself, run against a stand-in browser: its caches, fetch and events (L88 review).
function workerWorld(source, network) {
  const store = new Map(), listeners = {}, fetched = [];
  const cache = { put: async (key, response) => { store.set(typeof key === 'string' ? key : new URL(key.url).pathname, response); }, add: async key => { const response = await world.fetch(key); store.set(key, response); } };
  const world = {
    self: { location: new URL('http://desk.test/sw.js'), addEventListener: (type, handler) => { listeners[type] = handler; }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async key => store.get(typeof key === 'string' ? key : new URL(key.url).pathname) },
    fetch: async (input) => { const url = typeof input === 'string' ? input : input.url; fetched.push(new URL(url, 'http://desk.test').pathname); return network(new URL(url, 'http://desk.test')); },
    URL, Map, Set, Promise, Boolean, console,
  };
  vm.runInNewContext(source, world);
  const event = shape => { let answer = null; listeners.fetch({ ...shape, respondWith: value => { answer = value; }, waitUntil() {} }); return answer; };
  const install = async () => { const waits = []; listeners.install({ waitUntil: value => waits.push(value) }); await Promise.all(waits); };
  return { store, fetched, event, install };
}
const asset = (path, clientId) => ({ request: { method: 'GET', mode: 'no-cors', url: `http://desk.test${path}` }, clientId });
const answer = (body, { redirected = false, build = '' } = {}) => ({ status: 200, type: 'basic', redirected, body, clone() { return this; }, headers: { get: name => name === 'X-Rex-Build' ? build : null } });

test('the phone worker keeps only listed app files, never a redirect, and gives a page only files of its own build (L88 review)', async () => {
  const app = await createApp({ dataDirectory: temporary('sw-world'), port: 0 });
  let source; try { source = await (await fetch(app.address + '/sw.js')).text(); } finally { await app.close(); }
  const build = /const BUILD = '([^']*)'/.exec(source)[1];
  let version = 'one';
  const world = workerWorld(source, url => url.pathname === '/chat.css' ? answer('signin page', { redirected: true }) : url.pathname === '/' ? answer('<html>', { build }) : answer(`${url.pathname} ${version}`));
  await world.install();
  assert.ok(world.store.has('/chat.js'), 'an app file is saved at install');
  assert.ok(!world.store.has('/chat.css'), 'a redirect is never saved in place of the file');
  // An image of an agent's chat ends in .png but is not an app file: the worker leaves it alone.
  assert.equal(world.event(asset('/artifacts/run-1/shot.png', 'page-1')), null);
  // A page of this build gets the saved copy.
  await world.event({ request: { method: 'GET', mode: 'navigate', url: 'http://desk.test/' }, resultingClientId: 'page-1' });
  version = 'two';
  assert.equal((await world.event(asset('/chat.js', 'page-1'))).body, '/chat.js one');
  // A page of the next build, still answered by this worker during the update, gets the computer's files.
  const next = workerWorld(source, url => url.pathname === '/' ? answer('<html>', { build: 'next-build' }) : answer(`${url.pathname} ${version}`));
  await next.install(); version = 'three';
  await next.event({ request: { method: 'GET', mode: 'navigate', url: 'http://desk.test/' }, resultingClientId: 'page-2' });
  assert.equal(next.event(asset('/chat.js', 'page-2')), null, 'not answered from the saved copy');
});

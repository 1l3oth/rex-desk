import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApp } from '../src/server.js';
import { baseState, webPushHtml, webPushState, turnOnWebPush, testWebPush, checkWebPush } from '../public/chat-webpush.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const esc = text => String(text).replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`);

// ---------- the service worker: push and tap ----------
async function workerSource() {
  const app = await createApp({ dataDirectory: temporary('wp-sw'), port: 0 });
  try { return await (await fetch(app.address + '/sw.js')).text(); } finally { await app.close(); }
}
function worker(source, windows = []) {
  const listeners = {}, shown = [], opened = [];
  const world = {
    self: { location: new URL('https://desk.test/sw.js'), addEventListener: (type, handler) => { listeners[type] = handler; }, skipWaiting() {},
      registration: { showNotification: async (title, options) => { shown.push({ title, ...options }); } },
      clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async url => { opened.push(url); } } },
    caches: { open: async () => ({}), keys: async () => [], delete: async () => true, match: async () => null },
    fetch: async () => ({}), URL, Map, Set, Promise, Boolean, String, console, encodeURIComponent,
  };
  vm.runInNewContext(source, world);
  const fire = async (type, shape) => { const waits = []; listeners[type]({ ...shape, waitUntil: value => waits.push(value) }); await Promise.all(waits); };
  return { shown, opened, fire };
}
const data = value => ({ json: () => (typeof value === 'string' ? JSON.parse(value) : value) });
const win = (url, visible = true) => { const w = { url, visibilityState: visible ? 'visible' : 'hidden', focused: 0, messages: [], focus: async () => { w.focused++; }, postMessage: message => w.messages.push(message) }; return w; };

test('a push shows its notice, tagged by message, opening its chat; quiet when that chat is on screen', async () => {
  const source = await workerSource();
  const notice = { title: 'Rex Agent asked you', body: 'Can I push?', tag: 'tag-1', kind: 'mention', target: { type: 'room', id: 'r 1' } };
  const away = worker(source, [win('https://desk.test/#/main')]);
  await away.fire('push', { data: data(notice) });
  assert.equal(away.shown.length, 1);
  assert.equal(away.shown[0].title, 'Rex Agent asked you'); assert.equal(away.shown[0].body, 'Can I push?');
  assert.equal(away.shown[0].tag, 'tag-1'); assert.equal(away.shown[0].silent, false); assert.equal(away.shown[0].data.hash, '#/room/r%201');
  const looking = worker(source, [win('https://desk.test/#/room/r%201')]);
  await looking.fire('push', { data: data(notice) });
  assert.equal(looking.shown.length, 1, 'still shows a notice'); assert.equal(looking.shown[0].silent, true, 'but a quiet one');
  const hidden = worker(source, [win('https://desk.test/#/room/r%201', false)]);
  await hidden.fire('push', { data: data(notice) }); assert.equal(hidden.shown[0].silent, false);
});

test('a push that cannot be read still shows a plain notice', async () => {
  const w = worker(await workerSource());
  await w.fire('push', { data: data('not json') });
  await w.fire('push', { data: null });
  assert.equal(JSON.stringify(w.shown.map(item => [item.title, item.body, item.data.hash])), JSON.stringify([['Rex Desk', 'Open Rex Desk to read it.', '#/main'], ['Rex Desk', 'Open Rex Desk to read it.', '#/main']]));
});

test('a tap focuses an open Rex Desk on that chat, or opens it there', async () => {
  const source = await workerSource(), open = win('https://desk.test/#/main', false);
  const withPage = worker(source, [open]); let closed = 0;
  await withPage.fire('notificationclick', { notification: { data: { hash: '#/run/abc' }, close: () => { closed++; } } });
  assert.equal(closed, 1); assert.equal(open.focused, 1); assert.equal(JSON.stringify(open.messages), JSON.stringify([{ type: 'rex-open', hash: '#/run/abc' }])); assert.equal(withPage.opened.length, 0);
  const none = worker(source, []);
  await none.fire('notificationclick', { notification: { data: { hash: '#/inbox' }, close() {} } });
  assert.equal(JSON.stringify(none.opened), JSON.stringify(['/#/inbox']));
});

// ---------- the Turn on button ----------
const base = { phone: true, ios: false, standalone: false, secure: true, worker: true, push: true, notices: true, permission: 'default' };
test('each device gets the right state before anything is asked', () => {
  assert.equal(baseState({ ...base, phone: false }), 'computer');
  assert.equal(baseState(base, { signedIn: false }), 'signed-out');
  assert.equal(baseState({ ...base, ios: true }), 'ios-home');
  assert.equal(baseState({ ...base, ios: true, standalone: true, push: false }), 'ios-old');
  assert.equal(baseState({ ...base, ios: true, standalone: true }), 'off');
  assert.equal(baseState({ ...base, secure: false }), 'insecure');
  assert.equal(baseState({ ...base, push: false }), 'unsupported');
  assert.equal(baseState({ ...base, permission: 'denied' }), 'blocked');
  assert.equal(baseState(base), 'off');
});

function browser({ ua = 'Mozilla/5.0 (Linux; Android 14) Mobile', permission = 'default', answer = 'granted', standalone = false } = {}) {
  const saved = new Map(), calls = [];
  let sub = null;
  const w = {
    navigator: { userAgent: ua, maxTouchPoints: 5, standalone, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => sub, subscribe: async options => { calls.push(['subscribe', options.userVisibleOnly, options.applicationServerKey.length]); sub = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'k', auth: 'a' } }) }; return sub; } } }), getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }) } },
    Notification: { permission, requestPermission: async () => { calls.push(['ask']); w.Notification.permission = answer; return answer; } },
    PushManager: function () {}, isSecureContext: true, matchMedia: () => ({ matches: standalone }),
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
  };
  return { w, calls, saved };
}
const key = Buffer.alloc(65, 4).toString('base64url');
const desk = (routes, log = []) => ({ redraws: 0, api: async (path, options = {}) => { log.push(path); const out = routes[path]; if (out instanceof Error) throw out; return typeof out === 'function' ? out(options) : out; }, redraw() { this.redraws++; } });
const reset = () => Object.assign(webPushState, { name: '', note: '', checked: false, key: '', busy: '' });

test('nothing is asked on load; the tap asks, saves the phone, sends a test, and only then says On', async () => {
  reset(); const b = browser(), log = [];
  const ctx = desk({ '/notices/webpush': { signedIn: true, publicKey: key }, '/notices/webpush/phone': { id: 'phone-1' }, '/notices/webpush/test': { sent: 1 } }, log);
  await checkWebPush(ctx, b.w);
  assert.equal(webPushState.name, 'off'); assert.deepEqual(b.calls, [], 'no permission asked on load');
  assert.match(webPushHtml(esc, '', b.w), /data-action="nt-wp-on"[^>]*>Turn on</);
  const states = []; ctx.redraw = () => states.push(webPushState.busy || webPushState.name);
  await turnOnWebPush(ctx, b.w);
  assert.deepEqual(b.calls, [['ask'], ['subscribe', true, 65]]);
  assert.deepEqual(log, ['/notices/webpush', '/notices/webpush/phone', '/notices/webpush/test']);
  assert.deepEqual(states, ['allow', 'save', 'test', 'on'], 'shows each step, On only at the end');
  assert.equal(b.saved.get('rex-webpush-phone'), 'phone-1');
  const html = webPushHtml(esc, '', b.w);
  assert.match(html, /On for this phone/); assert.match(html, /Send a test/); assert.match(html, /Test sent/);
});

test('while it works the button shows its step and cannot be pressed again', () => {
  reset(); Object.assign(webPushState, { name: 'off', busy: 'save' });
  const html = webPushHtml(esc, '', browser().w);
  assert.match(html, /<button type="button" class="btn small" disabled>Turning on…<\/button>/);
  assert.doesNotMatch(html, /data-action="nt-wp-on"/);
});

test('Block, dismiss and a failed save each say what to do', async () => {
  reset(); webPushState.key = key;
  const blocked = browser({ answer: 'denied' });
  await turnOnWebPush(desk({}), blocked.w);
  assert.equal(webPushState.name, 'blocked');
  assert.match(webPushHtml(esc, '', blocked.w), /blocked for Rex Desk[\s\S]*Tap the lock[\s\S]*Check again/);
  reset(); webPushState.key = key;
  await turnOnWebPush(desk({}), browser({ answer: 'default' }).w);
  assert.equal(webPushState.name, 'off'); assert.match(webPushState.note, /Press Turn on and choose Allow/);
  reset(); webPushState.key = key; const failing = browser();
  await turnOnWebPush(desk({ '/notices/webpush/phone': new Error('Rex Desk could not reach its account service, so the phone notification did not go out.') }), failing.w);
  assert.equal(webPushState.name, 'error');
  const html = webPushHtml(esc, '', failing.w);
  assert.match(html, /Not turned on/); assert.match(html, /could not reach its account service/); assert.match(html, /Try again/);
  assert.equal(failing.saved.size, 0, 'nothing saved as on');
});

test('signed out, iPhone outside the Home Screen, and a computer each explain themselves without a button', async () => {
  reset(); const b = browser();
  await checkWebPush(desk({ '/notices/webpush': { signedIn: false, publicKey: '' } }), b.w);
  let html = webPushHtml(esc, 'Sign in to Rex Desk to get phone notifications.', b.w);
  assert.equal(webPushState.name, 'signed-out'); assert.match(html, /Sign in to Rex Desk to get phone notifications\./); assert.match(html, /ntfy app under Other ways still works/);
  assert.equal((html.match(/Sign in to Rex Desk/g) || []).length, 1, 'said once'); assert.doesNotMatch(html, /<button/);
  reset(); const iphone = browser({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
  await checkWebPush(desk({ '/notices/webpush': { signedIn: true, publicKey: key } }), iphone.w);
  html = webPushHtml(esc, '', iphone.w);
  assert.equal(webPushState.name, 'ios-home'); assert.match(html, /Home Screen first/); assert.match(html, /Tap the Share button/); assert.doesNotMatch(html, /<button/);
  assert.deepEqual(iphone.calls, []);
  reset(); const pc = browser({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), log = [];
  await checkWebPush(desk({}, log), pc.w);
  html = webPushHtml(esc, '', pc.w);
  assert.equal(webPushState.name, 'computer'); assert.match(html, /Turned on from your phone/); assert.deepEqual(log, [], 'a computer asks nothing');
});

test('a phone already turned on shows On after a reload, and a test to a removed phone turns it back off', async () => {
  reset(); const b = browser({ permission: 'granted' });
  b.saved.set('rex-webpush-phone', 'phone-1');
  await b.w.navigator.serviceWorker.ready.then(reg => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(65) }));
  await checkWebPush(desk({ '/notices/webpush': { signedIn: true, publicKey: key } }), b.w);
  assert.equal(webPushState.name, 'on');
  await testWebPush(desk({ '/notices/webpush/test': new Error('This phone is no longer turned on. Turn it on again.') }), b.w);
  assert.equal(webPushState.name, 'off'); assert.equal(b.saved.has('rex-webpush-phone'), false);
});

// ---------- the desk routes the phone page uses ----------
test('the desk turns a phone on through the account service and sends its test to that phone only', async () => {
  const app = await createApp({ dataDirectory: temporary('wp-routes'), port: 0 });
  try {
    const calls = [];
    const push = app.desk.notifier.webPush;
    push.token = () => 'desk-key'; push.base = 'https://api.test';
    push.fetcher = async (url, init) => {
      const pathname = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null; calls.push([init.method, pathname, body?.locked?.map(item => item.phone) || body?.endpoint || '']);
      const reply = pathname === '/v1/push/key' ? { publicKey: key } : pathname === '/v1/push/phones' && init.method === 'POST' ? { id: 'p2', name: body.name } : pathname === '/v1/push/phones' ? { phones: [{ id: 'p1', keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } }, { id: 'p2', keys: { p256dh: (await import('node:crypto')).createECDH('prime256v1').generateKeys().toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } }] } : { sent: body.locked.map(item => item.phone), gone: [], failed: [] };
      return new Response(JSON.stringify(reply), { status: 200 });
    };
    const call = async (pathname, data) => { const r = await fetch(app.address + pathname, { method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-rex-desk': '1' }, ...(data ? { body: JSON.stringify(data) } : {}) }); return [r.status, await r.json()]; };
    assert.deepEqual(await call('/api/notices/webpush'), [200, { signedIn: true, publicKey: key }]);
    assert.deepEqual(await call('/api/notices/webpush/phone', { subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'k', auth: 'a' } }, name: 'Android phone' }), [200, { id: 'p2', name: 'Android phone' }]);
    const [status, result] = await call('/api/notices/webpush/test', { phone: 'p2' });
    assert.equal(status, 200); assert.equal(result.sent, 1);
    assert.deepEqual(calls.find(([, pathname]) => pathname === '/v1/push/send')[2], ['p2'], 'the test goes only to the new phone');
    push.token = () => '';
    assert.deepEqual(await call('/api/notices/webpush'), [200, { signedIn: false, publicKey: '' }]);
    const [failed, error] = await call('/api/notices/webpush/test', { phone: 'p2' });
    assert.equal(failed, 400); assert.equal(error.error, 'Sign in to Rex Desk to get phone notifications.');
  } finally { await app.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createECDH } from 'node:crypto';
import { createApp } from '../src/server.js';
import { WebPush } from '../src/webpush.js';
import { webPushState, webPushList, checkWebPush, turnOnWebPush, loadPhones, removePhone, signOutPhone, phonesHtml, webPushHtml } from '../public/chat-webpush.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const esc = text => String(text).replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`);
const key = Buffer.alloc(65, 4).toString('base64url');
const PHONE = 'rex-webpush-phone';

// A phone's browser: its saved phone id, its push subscription (which can be dropped), and session storage.
function browser({ ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', permission = 'granted', subscribed = true, unsubscribe = true } = {}) {
  const saved = new Map(), session = new Map(), calls = [];
  const make = () => ({ unsubscribe: async () => { calls.push('unsubscribe'); if (unsubscribe instanceof Error) throw unsubscribe; if (unsubscribe) sub = null; return unsubscribe; }, toJSON: () => ({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'k', auth: 'a' } }) });
  let sub = subscribed ? make() : null;
  const pushManager = { getSubscription: async () => sub, subscribe: async () => { calls.push('subscribe'); sub = make(); return sub; } };
  const w = {
    navigator: { userAgent: ua, maxTouchPoints: 5, standalone: true, serviceWorker: { ready: Promise.resolve({ pushManager }), getRegistration: async () => ({ pushManager }) } },
    Notification: { permission, requestPermission: async () => 'granted' }, PushManager: function () {}, isSecureContext: true, matchMedia: () => ({ matches: true }),
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) },
    sessionStorage: { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) },
  };
  return { w, saved, session, calls, subscribed: () => Boolean(sub) };
}
const desk_ = (routes, log = []) => desk(routes, log);
const desk = (routes, log = []) => ({ api: async (pathname, options = {}) => { log.push(`${options.method || 'GET'} ${pathname}`); const out = typeof routes[pathname] === 'function' ? routes[pathname](options) : routes[pathname]; if (out instanceof Error) throw out; return out; }, redraw() {} });
const reset = () => {
  Object.assign(webPushState, { name: '', note: '', checked: false, key: '', busy: '' });
  Object.assign(webPushList, { phones: null, asked: false, signedIn: true, loading: false, error: '', removing: '', note: '', noteBad: false });
};
const two = [{ id: 'p1', name: 'iPhone', created: '2026-11-20T08:00:00.000Z' }, { id: 'p2', name: 'Android phone', created: '2026-11-26T08:00:00.000Z' }];

// ---------- the list in Notifications settings ----------
test('the list says what is going on while loading, empty, signed out and when it failed to load', async () => {
  reset(); const b = browser();
  let release; const slow = new Promise(resolve => { release = resolve; });
  const loading = loadPhones(desk({ '/notices/webpush/phones': () => slow.then(() => ({ signedIn: true, phones: [] })) }));
  assert.match(phonesHtml(esc, b.w), /Looking up your phones…/);
  release(); await loading;
  assert.match(phonesHtml(esc, b.w), /No phone gets notices yet\. Turn them on from Rex Desk on the phone\./);

  reset(); await loadPhones(desk({ '/notices/webpush/phones': { signedIn: false, phones: [] } }));
  assert.match(phonesHtml(esc, b.w), /Sign in to Rex Desk to see the phones that get notices\./);
  webPushState.name = 'signed-out';
  assert.equal(phonesHtml(esc, b.w), '', 'the Turn on row already says to sign in on a phone');

  reset(); await loadPhones(desk({ '/notices/webpush/phones': { signedIn: true, phones: null, error: 'Rex Desk could not reach its account service to list your phones.' } }));
  const failed = phonesHtml(esc, b.w);
  assert.match(failed, /Could not load your phones: Rex Desk could not reach its account service to list your phones\./);
  assert.match(failed, /data-action="nt-wp-list"[^>]*>Try again</);
  assert.doesNotMatch(failed, /No phone gets notices/, 'a failure never looks like an empty list');

  reset(); await loadPhones(desk({ '/notices/webpush/phones': new TypeError('Failed to fetch') }));
  assert.match(phonesHtml(esc, b.w), /Could not load your phones: Failed to fetch/);
});

test('each phone shows its name, when it was added, This phone on the one in hand, and Remove', async () => {
  reset(); const b = browser(); b.saved.set(PHONE, 'p2');
  await loadPhones(desk({ '/notices/webpush/phones': { signedIn: true, phones: [...two, { id: 'p3', name: '<b>x</b>', created: '' }] } }));
  const html = phonesHtml(esc, b.w);
  assert.equal((html.match(/data-action="nt-wp-remove"/g) || []).length, 3);
  assert.match(html, /<b>iPhone<\/b><small>Added Nov 20, 2026<\/small>/);
  assert.match(html, /<b>Android phone <span class="nt-wp-me">This phone<\/span><\/b><small>Added Nov 26, 2026<\/small>/);
  assert.equal((html.match(/This phone/g) || []).length, 1, 'only the phone in hand is marked');
  assert.match(html, /&#60;b&#62;x&#60;\/b&#62;/, 'names are escaped'); assert.doesNotMatch(html, /Added <\/small>|Added Invalid/);
  const computer = browser({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  assert.doesNotMatch(phonesHtml(esc, computer.w), /This phone/, 'a computer marks none');
});

// ---------- Remove ----------
test('Remove shows its progress, then the real list; a failure says why and keeps the phone listed', async () => {
  reset(); const b = browser(), log = []; let phones = [...two]; const seen = [];
  const ctx = desk({ '/notices/webpush/phones': () => ({ signedIn: true, phones }), '/notices/webpush/phones/p1': () => { seen.push(phonesHtml(esc, b.w)); phones = phones.filter(p => p.id !== 'p1'); return { removed: 'p1' }; } }, log);
  await loadPhones(ctx);
  await removePhone(ctx, 'p1', b.w);
  assert.match(seen[0], /Removing…/); assert.equal((seen[0].match(/disabled/g) || []).length, 2, 'no second Remove while one works');
  assert.deepEqual(log, ['GET /notices/webpush/phones', 'DELETE /notices/webpush/phones/p1', 'GET /notices/webpush/phones'], 'the list is asked again, not guessed');
  const after = phonesHtml(esc, b.w);
  assert.doesNotMatch(after, /data-id="p1"/); assert.match(after, /data-id="p2"/); assert.match(after, /Removed\. That phone gets no more notices\./);

  const failing = desk({ '/notices/webpush/phones': () => ({ signedIn: true, phones }), '/notices/webpush/phones/p2': new Error('Rex Desk could not reach its account service, so the phone was not removed. Try again when online.') });
  await removePhone(failing, 'p2', b.w);
  const kept = phonesHtml(esc, b.w);
  assert.match(kept, /data-id="p2"/); assert.match(kept, /class="small warn-text nt-wp-note"[^>]*>Rex Desk could not reach its account service, so the phone was not removed/);
  assert.doesNotMatch(kept, /Removed\./, 'no false success');
});

test('removing the phone in hand turns it off here too, and Turn on works again', async () => {
  reset(); const b = browser(); b.saved.set(PHONE, 'p1'); let phones = [two[0]];
  const ctx = desk({ '/notices/webpush': { signedIn: true, publicKey: key }, '/notices/webpush/phones': () => ({ signedIn: true, phones }), '/notices/webpush/phones/p1': () => { phones = []; return { removed: 'p1' }; },
    '/notices/webpush/phone': () => { phones = [{ ...two[0], id: 'p9' }]; return { id: 'p9' }; }, '/notices/webpush/test': { sent: 1 } });
  await checkWebPush(ctx, b.w); assert.equal(webPushState.name, 'on');
  await removePhone(ctx, 'p1', b.w);
  assert.equal(webPushState.name, 'off'); assert.equal(b.saved.has(PHONE), false); assert.equal(b.subscribed(), false, 'the phone stops listening');
  assert.match(webPushHtml(esc, '', b.w), /Turned off for this phone\. Press Turn on to get notices again\./);
  assert.match(webPushHtml(esc, '', b.w), /data-action="nt-wp-on"[^>]*>Turn on</);
  await turnOnWebPush(ctx, b.w);
  assert.equal(webPushState.name, 'on'); assert.equal(b.saved.get(PHONE), 'p9'); assert.ok(b.calls.includes('subscribe'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(phonesHtml(esc, b.w), /data-id="p9"/, 'the list is asked again after turning on');
});

test('a phone removed from a computer, or pushed out by an 11th phone, shows Off on its own screen', async () => {
  reset(); const b = browser(); b.saved.set(PHONE, 'p-old');
  const eleven = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: 'Phone', created: `2026-11-${10 + i}T00:00:00.000Z` }));
  await checkWebPush(desk({ '/notices/webpush': { signedIn: true, publicKey: key }, '/notices/webpush/phones': { signedIn: true, phones: eleven } }), b.w);
  assert.equal(webPushState.name, 'off'); assert.equal(b.saved.has(PHONE), false);
  assert.match(webPushHtml(esc, '', b.w), /This phone was removed from your phones, so it gets no notices\. Press Turn on to get them again\./);
  assert.match(webPushHtml(esc, '', b.w), /data-action="nt-wp-on"/);
  assert.equal((phonesHtml(esc, b.w).match(/nt-wp-phone"/g) || []).length, 10, 'the list shows exactly what the account has');
  // A list that could not load does not turn a working phone off.
  reset(); const c = browser(); c.saved.set(PHONE, 'p1');
  await checkWebPush(desk({ '/notices/webpush': { signedIn: true, publicKey: key }, '/notices/webpush/phones': new TypeError('Failed to fetch') }), c.w);
  assert.equal(webPushState.name, 'on'); assert.equal(c.saved.get(PHONE), 'p1');
});

// ---------- sign-out on a phone ----------
test('signing out removes the phone from the account and the phone stops listening', async () => {
  reset(); const b = browser(), log = []; b.saved.set(PHONE, 'p1');
  const out = await signOutPhone(desk({ '/notices/webpush/phones/p1': { removed: 'p1' } }, log).api, b.w);
  assert.deepEqual(log, ['DELETE /notices/webpush/phones/p1']);
  assert.deepEqual(out, { left: '', removed: true, stopped: true });
  assert.equal(b.subscribed(), false); assert.equal(b.saved.has(PHONE), false); assert.equal(b.session.size, 0, 'nothing left to say');
  // A computer, or a phone that never turned this on: nothing is called.
  const none = browser({ subscribed: false }), quiet = [];
  assert.deepEqual(await signOutPhone(desk({}, quiet).api, none.w), { left: '', removed: true, stopped: true }); assert.deepEqual(quiet, []);
});

test('offline or a failing delete: the phone still stops listening, signs out, and says what is left', async () => {
  for (const failure of [new TypeError('Failed to fetch'), new Error('Rex Desk could not reach its account service, so the phone was not removed. Try again when online.')]) {
    reset(); const b = browser(); b.saved.set(PHONE, 'p1');
    const out = await signOutPhone(desk({ '/notices/webpush/phones/p1': failure }).api, b.w);
    assert.equal(out.removed, false); assert.equal(out.stopped, true); assert.equal(b.subscribed(), false); assert.equal(b.saved.has(PHONE), false);
    assert.match(out.left, /This phone no longer gets Rex Desk notices\. It may still be listed under your phones until the next notice clears it/);
    assert.equal(b.session.get('rex-signout-note'), out.left, 'the sign-in page says it once');
  }
  // A desk that does not answer at all is not waited on for ever.
  reset(); const hung = browser(); hung.saved.set(PHONE, 'p1'); const started = Date.now();
  const out = await signOutPhone(() => new Promise(() => {}), hung.w);
  assert.ok(Date.now() - started < 8000); assert.equal(out.stopped, true);
  // The desk already ended this phone's sign-in (no desk call possible), and the phone cannot stop listening.
  reset(); const stuck = browser({ unsubscribe: new Error('nope') }); stuck.saved.set(PHONE, 'p1');
  const both = await signOutPhone(null, stuck.w);
  assert.equal(both.removed, false); assert.equal(both.stopped, false);
  assert.match(both.left, /This phone may still get Rex Desk notices\. Remove it in Settings, Notifications on a computer/);
});

test('every sign-out on a phone goes through signOutPhone first', async () => {
  const { readFile } = await import('node:fs/promises');
  const chat = await readFile(new URL('../public/chat.js', import.meta.url), 'utf8'), settings = await readFile(new URL('../public/chat-settings.js', import.meta.url), 'utf8');
  assert.match(chat, /profile-logout[^\n]*await signOutPhone\(api\); await api\('\/auth\/logout'/);
  assert.match(chat, /await signOutPhone\(null\)[^\n]*location\.href = '\/signin'/, 'an ended sign-in too');
  assert.match(settings, /data-st-signout[^\n]*await signOutPhone\(api\); await api\('\/auth\/logout'/);
  assert.match(settings, /const phone = await signOutPhone\(api\);\s*await api\('\/database\/account-signout'/);
  const signin = await readFile(new URL('../public/chat-signin.js', import.meta.url), 'utf8');
  assert.match(signin, /sessionStorage\.getItem\('rex-signout-note'\)/);
});

// ---------- the desk: list, remove and its kept list ----------
const realKeys = () => ({ p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') });
function account(phones) {
  const calls = [];
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url), body = init.body ? JSON.parse(init.body) : null; calls.push(`${init.method} ${pathname}`);
    const reply = (status, data) => new Response(JSON.stringify(data), { status });
    if (pathname === '/v1/push/phones' && init.method === 'GET') return reply(200, { phones });
    const del = pathname.match(/^\/v1\/push\/phones\/(.+)$/);
    if (del) { const id = decodeURIComponent(del[1]); if (!phones.some(p => p.id === id)) return reply(404, { error: { code: 'phone_not_found', message: 'That phone is not on this account.' } }); phones.splice(phones.findIndex(p => p.id === id), 1); return reply(200, { removed: id }); }
    if (pathname === '/v1/push/send') { if (body.locked.some(item => !phones.some(p => p.id === item.phone))) return reply(404, { error: { code: 'phone_not_found', message: 'That phone is not on this account.' } }); return reply(200, { sent: body.locked.map(item => item.phone), gone: [], failed: [] }); }
    return reply(404, {});
  };
  return { calls, fetcher, phones };
}

test('the desk lists the phones without their keys and removes one; an already gone phone counts as removed', async () => {
  const app = await createApp({ dataDirectory: temporary('wp-phones'), port: 0 });
  try {
    const acc = account([{ id: 'p1', name: 'iPhone', keys: realKeys(), created: '2026-11-20T08:00:00.000Z' }, { id: 'p 2', name: 'Android phone', keys: realKeys(), created: '2026-11-26T08:00:00.000Z' }]);
    const push = app.desk.notifier.webPush; push.token = () => 'desk-key'; push.base = 'https://api.test'; push.fetcher = acc.fetcher;
    const call = async (pathname, method = 'GET') => { const r = await fetch(app.address + pathname, { method, headers: { 'x-rex-desk': '1' } }); return [r.status, await r.json()]; };
    const [status, listed] = await call('/api/notices/webpush/phones');
    assert.equal(status, 200); assert.deepEqual(listed, { signedIn: true, phones: [{ id: 'p1', name: 'iPhone', created: '2026-11-20T08:00:00.000Z' }, { id: 'p 2', name: 'Android phone', created: '2026-11-26T08:00:00.000Z' }] });
    assert.doesNotMatch(JSON.stringify(listed), /p256dh|auth/, 'keys never go to the page');
    assert.deepEqual(await call('/api/notices/webpush/phones/p%202', 'DELETE'), [200, { removed: 'p 2' }]);
    assert.deepEqual(await call('/api/notices/webpush/phones/p%202', 'DELETE'), [200, { removed: 'p 2' }], 'removed twice is still removed');
    assert.ok(acc.calls.includes('DELETE /v1/push/phones/p%202'));
    push.fetcher = async () => { throw new TypeError('fetch failed'); };
    const [downStatus, down] = await call('/api/notices/webpush/phones/p1', 'DELETE');
    assert.equal(downStatus, 400); assert.equal(down.error, 'Rex Desk could not reach its account service, so the phone was not removed. Try again when online.');
    assert.deepEqual(await call('/api/notices/webpush/phones'), [200, { signedIn: true, phones: null, error: 'Rex Desk could not reach its account service to list your phones.' }]);
    push.token = () => '';
    assert.deepEqual(await call('/api/notices/webpush/phones'), [200, { signedIn: false, phones: [] }]);
  } finally { await app.close(); }
});

test('after a phone is added or removed the next notice asks for the list again, and a stale list on another computer is refreshed', async () => {
  const acc = account([{ id: 'p1', name: 'iPhone', keys: realKeys() }, { id: 'p2', name: 'Android phone', keys: realKeys() }]);
  const now = 0; const here = new WebPush({ token: () => 'k', base: 'https://api.test', fetcher: acc.fetcher, now: () => now });
  await here.send({ source: 'a', body: 'one' });
  await here.send({ source: 'b', body: 'two' });
  assert.equal(acc.calls.filter(c => c === 'GET /v1/push/phones').length, 1, 'kept between notices');
  await here.removePhone('p2');
  const after = await here.send({ source: 'c', body: 'three' });
  assert.equal(acc.calls.filter(c => c === 'GET /v1/push/phones').length, 2, 'asked again after Remove'); assert.equal(after.sent, 1);
  // Another computer still holds a list with a phone this one removed.
  acc.phones.push({ id: 'p3', name: 'Phone', keys: realKeys() });
  const other = new WebPush({ token: () => 'k', base: 'https://api.test', fetcher: acc.fetcher, now: () => now });
  await other.list();
  acc.phones.splice(acc.phones.findIndex(p => p.id === 'p1'), 1); // removed from this computer meanwhile
  acc.calls.length = 0;
  const result = await other.send({ source: 'd', body: 'four' });
  assert.deepEqual(acc.calls, ['POST /v1/push/send', 'GET /v1/push/phones', 'POST /v1/push/send'], 'refused once, list asked again, sent once more');
  assert.equal(result.sent, 1, 'only the phone still on the account gets it'); assert.deepEqual(other.phones.map(p => p.id), ['p3']);
  assert.equal(other.phones.some(p => p.id === 'p1'), false);
});

// ---------- review polish: Khmer desk messages, and no warning on a computer that never had a phone ----------
test('the desk\'s own messages show in Khmer; messages from the account service stay as they came', async () => {
  const { useLanguage } = await import('../public/i18n.js');
  const { readFileSync } = await import('node:fs');
  const km = JSON.parse(readFileSync(new URL('../public/i18n/km.json', import.meta.url), 'utf8'));
  const desk = ['Rex Desk could not reach its account service, so the phone notification did not go out.', 'Rex Desk could not reach its account service to list your phones.',
    'Rex Desk could not reach its account service, so the phone was not removed. Try again when online.', 'The phone notification did not reach any phone. Rex Desk will try with the next one.',
    'Too many phone notifications in a minute; some were held back.', 'The test did not reach this phone. Try again.', 'This phone is no longer turned on. Turn it on again.', 'That phone has keys Rex Desk cannot use.'];
  const sources = ['src/webpush.js', 'src/server.js'].map(file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join(' ');
  for (const text of desk) { assert.ok(km[text], `Khmer for: ${text}`); assert.ok(sources.includes(text), `the desk really sends: ${text}`); }
  useLanguage('km', km);
  try {
    const phone = browser({ ua: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
    reset(); webPushState.name = 'error'; webPushState.note = desk[0];
    assert.match(webPushHtml(esc, desk[3], phone.w), new RegExp(km[desk[0]]), 'the Turn on note');
    assert.match(webPushHtml(esc, desk[3], phone.w), new RegExp(km[desk[3]]), 'the desk warning');
    reset(); await loadPhones(desk_({ '/notices/webpush/phones': { signedIn: true, phones: null, error: desk[1] } }));
    assert.match(phonesHtml(esc, phone.w), new RegExp(km[desk[1]]), 'the list error');
    reset(); await loadPhones(desk_({ '/notices/webpush/phones': { signedIn: true, phones: [two[0]] } }));
    await removePhone(desk_({ '/notices/webpush/phones': { signedIn: true, phones: [two[0]] }, '/notices/webpush/phones/p1': new Error(desk[2]) }), 'p1', phone.w);
    assert.match(phonesHtml(esc, phone.w), new RegExp(km[desk[2]]), 'the Remove error');
    reset(); webPushState.name = 'error'; webPushState.note = 'Phone notifications are not part of this plan.';
    assert.match(webPushHtml(esc, '', phone.w), /Phone notifications are not part of this plan\./, 'an account service message is shown as it came');
    const computer = browser({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }); reset(); webPushState.name = 'computer';
    assert.match(webPushHtml(esc, '', computer.w), new RegExp(km['Turn on from your phone']));
  } finally { useLanguage('en'); }
});

test('a computer shows the desk\'s sign-in warning only when the account had a phone turned on', async () => {
  const computer = browser({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), phone = browser({ ua: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
  const warn = 'Sign in to Rex Desk to get phone notifications.';
  reset(); webPushState.name = 'computer';
  const never = webPushHtml(esc, warn, computer.w, { seen: false });
  assert.match(never, /Turn on from your phone/); assert.doesNotMatch(never, /warn-text/, 'never had a phone: no amber line');
  assert.match(webPushHtml(esc, warn, computer.w, { seen: true }), /class="small warn-text nt-wp-note">Sign in to Rex Desk to get phone notifications\./, 'had a phone and now cannot send: says so');
  reset(); webPushState.name = 'off';
  assert.match(webPushHtml(esc, 'The phone notification did not reach any phone. Rex Desk will try with the next one.', phone.w, { seen: false }), /warn-text nt-wp-note">The phone notification did not reach any phone/, 'the phone itself always shows it');
  // The desk keeps what it saw at each look: a phone saved or listed sets it, an empty list clears it, signed out keeps it.
  const app = await createApp({ dataDirectory: temporary('wp-seen'), port: 0 });
  try {
    const acc = account([]); const push = app.desk.notifier.webPush; push.token = () => 'k'; push.base = 'https://api.test'; push.fetcher = acc.fetcher;
    const seen = async () => app.desk.notifier.summary().prefs.webPushSeen;
    assert.equal(Boolean(await seen()), false);
    acc.phones.push({ id: 'p1', name: 'iPhone', keys: realKeys(), created: '2026-11-20T08:00:00.000Z' });
    await push.phonesList(); assert.equal(await seen(), true);
    push.token = () => ''; await push.send({ source: 'x', body: 'y' }); assert.equal(await seen(), true, 'signed out keeps what it last saw');
    push.token = () => 'k'; acc.phones.length = 0; await push.phonesList(); assert.equal(await seen(), false, 'all phones removed: no more warning');
    acc.phones.push({ id: 'p2', name: 'Phone', keys: realKeys() }); push.forget(); await push.send({ source: 'z', body: 'w' }); assert.equal(await seen(), true, 'a notice that finds phones sets it too');
  } finally { await app.close(); }
});

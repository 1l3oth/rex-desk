import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, hkdfSync } from 'node:crypto';
import { encrypt, fitPayload, noticeTag, WebPush, PLAIN_BYTES, PUSH_BYTES, SIGN_IN_FIRST, HIDDEN_TEXT } from '../src/webpush.js';
import { Notifier } from '../src/notify.js';

// RFC 8291 Appendix A: the standard's sample values.
const RFC = {
  plain: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const b = text => Buffer.from(text, 'base64url');

// The phone's side, written apart from src/webpush.js: unlock a notice with the phone's private key.
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic), uaPublic = ecdh.getPublicKey();
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce); decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  assert.equal(padded.at(-1), 2);
  return padded.subarray(0, -1);
}
const phone = () => { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = Buffer.alloc(16, 5); return { priv: ecdh.getPrivateKey(), auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }; };

test('encryption matches the standard\'s sample values exactly (RFC 8291)', () => {
  const body = encrypt(b(RFC.plain), { p256dh: RFC.uaPublic, auth: RFC.auth }, { asPrivate: RFC.asPrivate, salt: b(RFC.salt) });
  assert.equal(body.toString('base64url'), RFC.body);
  assert.equal(decrypt(b(RFC.body), b(RFC.uaPrivate), b(RFC.auth)).toString(), 'When I grow up, I want to be a watermelon');
});

test('a real notice opens on the phone with its own key, and fits the 4096-byte limit', () => {
  const p = phone(), text = JSON.stringify({ title: 'Rex Agent', body: 'Done.' });
  const body = encrypt(text, p.keys);
  assert.equal(decrypt(body, p.priv, p.auth).toString(), text);
  assert.equal(encrypt('x'.repeat(PLAIN_BYTES), p.keys).length, PUSH_BYTES);
  assert.throws(() => encrypt('x'.repeat(PLAIN_BYTES + 1), p.keys), /too long/);
  assert.throws(() => encrypt('x', { p256dh: 'AAAA', auth: p.keys.auth }), /keys/);
});

test('long text is cut by whole letters to fit once locked, Khmer included', () => {
  const khmer = 'សួស្តី​ពិភពលោក '.repeat(400), out = fitPayload({ title: 'ភ្នាក់ងារ', body: khmer, tag: 't' });
  const size = Buffer.byteLength(JSON.stringify(out));
  assert.ok(size <= PLAIN_BYTES && size > PLAIN_BYTES - 40, String(size));
  assert.ok(out.body.endsWith('…'));
  assert.ok(khmer.startsWith(out.body.slice(0, -1)));
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(khmer)].map(part => part.segment);
  assert.ok(segments.slice(0, segments.length).some((_, i) => segments.slice(0, i).join('') === out.body.slice(0, -1)), 'cut on a whole letter');
  const p = phone(); assert.ok(encrypt(JSON.stringify(out), p.keys).length <= PUSH_BYTES);
  assert.deepEqual(fitPayload({ title: 'a', body: 'short' }), { title: 'a', body: 'short' });
});

test('the same message gives the same tag on every computer', () => {
  assert.equal(noticeTag('msg:42'), noticeTag('msg:42'));
  assert.notEqual(noticeTag('msg:42'), noticeTag('msg:43'));
  assert.match(noticeTag('msg:42'), /^[A-Za-z0-9_-]{22}$/);
});

// A stand-in for the account service (rex-desk-api push routes): records calls and unlocks what it is sent.
function standIn({ phones = [], send = () => ({ sent: [], gone: [], failed: [] }), status = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, auth: init.headers.authorization, body });
    const reply = status !== 200 ? { error: { code: 'x', message: 'Server said no.' } } : path === '/v1/push/phones' ? { phones: phones.map(p => ({ id: p.id, name: 'Phone', keys: p.keys })) } : send(body);
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetcher };
}

test('a notice goes to each phone once, locked for that phone, with preview text', async () => {
  const one = { id: 'p1', ...phone() }, two = { id: 'p2', ...phone() };
  const api = standIn({ phones: [one, two, one], send: body => ({ sent: body.locked.map(item => item.phone), gone: [], failed: [] }) });
  const push = new WebPush({ token: () => 'key', base: 'https://api.test', fetcher: api.fetcher });
  const result = await push.send({ source: 'msg:1', kind: 'mention', title: 'Rex Agent asked you', body: 'Can I push?', target: { type: 'room', id: 'r1' } });
  assert.deepEqual(result, { sent: 2, gone: 0, failed: 0, repeat: false });
  const send = api.calls.find(call => call.path === '/v1/push/send');
  assert.equal(send.auth, 'Bearer key');
  assert.deepEqual(send.body.locked.map(item => item.phone), ['p1', 'p2']);
  assert.equal(send.body.notice, noticeTag('msg:1')); assert.equal(send.body.topic, noticeTag('msg:1')); assert.equal(send.body.urgency, 'high');
  const opened = JSON.parse(decrypt(b(send.body.locked[1].body), two.priv, two.auth).toString());
  assert.deepEqual(opened, { title: 'Rex Agent asked you', body: 'Can I push?', tag: noticeTag('msg:1'), kind: 'mention', target: { type: 'room', id: 'r1' } });
  assert.equal(JSON.stringify(send.body).includes('Can I push'), false, 'the text only leaves locked');
});

test('preview off sends no message text at all', async () => {
  const one = { id: 'p1', ...phone() }, api = standIn({ phones: [one], send: body => ({ sent: ['p1'], gone: [], failed: [] }) });
  await new WebPush({ token: () => 'key', base: 'https://api.test', fetcher: api.fetcher }).send({ source: 's', title: 'Rex Agent replied', body: 'The secret plan', preview: false });
  const opened = JSON.parse(decrypt(b(api.calls.at(-1).body.locked[0].body), one.priv, one.auth).toString());
  assert.equal(opened.body, HIDDEN_TEXT);
  assert.equal(JSON.stringify(opened).includes('secret'), false);
});

test('signed out: no call at all, and the status says to sign in', async () => {
  const api = standIn(), push = new WebPush({ token: () => '', base: 'https://api.test', fetcher: api.fetcher });
  assert.deepEqual(await push.send({ source: 's', body: 'x' }), { sent: 0, reason: 'signed_out' });
  assert.equal(api.calls.length, 0); assert.equal(push.status, SIGN_IN_FIRST);
  const expired = new WebPush({ token: () => 'old', base: 'https://api.test', fetcher: standIn({ status: 401 }).fetcher });
  assert.equal((await expired.send({ source: 's' })).reason, 'signed_out'); assert.equal(expired.status, SIGN_IN_FIRST);
});

test('no phones: the list is asked once in 10 minutes, not once per notice', async () => {
  let now = 0; const api = standIn({ phones: [] }), push = new WebPush({ token: () => 'key', base: 'https://api.test', fetcher: api.fetcher, now: () => now });
  for (let i = 0; i < 5; i++) assert.equal((await push.send({ source: `s${i}` })).reason, 'no_phones');
  assert.equal(api.calls.length, 1);
  now = 10 * 60_000; await push.send({ source: 'later' }); assert.equal(api.calls.length, 2);
  push.forget(); await push.send({ source: 'again' }); assert.equal(api.calls.length, 3);
});

test('a failed send is reported plainly, once, with no retry; a gone phone is dropped', async () => {
  const one = { id: 'p1', ...phone() }, two = { id: 'p2', ...phone() };
  const api = standIn({ phones: [one, two], send: () => ({ sent: [], gone: ['p2'], failed: [{ phone: 'p1', status: 503 }] }) });
  const push = new WebPush({ token: () => 'key', base: 'https://api.test', fetcher: api.fetcher });
  assert.deepEqual(await push.send({ source: 's' }), { sent: 0, gone: 1, failed: 1, repeat: false });
  assert.match(push.status, /did not reach any phone/);
  assert.equal(api.calls.filter(call => call.path === '/v1/push/send').length, 1);
  assert.deepEqual(push.phones.map(p => p.id), ['p1']);
  const down = new WebPush({ token: () => 'key', base: 'https://api.test', fetcher: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal((await down.send({ source: 's' })).reason, 'offline'); assert.match(down.status, /could not reach/);
  const refused = new WebPush({ token: () => 'key', base: 'https://api.test', fetcher: standIn({ status: 503 }).fetcher });
  assert.equal((await refused.send({ source: 's' })).sent, 0); assert.equal(refused.status, 'Server said no.');
});

// The notifier: web push sits next to ntfy and never replaces or breaks it.
const memoryStore = () => { const rows = new Map(); const key = (k, id) => `${k}\n${id}`; return { get: (k, id) => rows.get(key(k, id)), put: (k, id, v) => { rows.set(key(k, id), v); return v; }, delete: (k, id) => rows.delete(key(k, id)), list: k => [...rows.entries()].filter(([name]) => name.startsWith(`${k}\n`)).map(([, v]) => v), on() {}, events: () => [] }; };

test('the notifier sends web push next to ntfy, skips the chat being looked at, and a failure breaks neither', async () => {
  const store = memoryStore(); let focused = false, viewing = '';
  const sent = [], ntfy = [];
  const notifier = new Notifier(store, { show: () => {}, focused: () => focused, viewing: () => viewing, enabled: () => true });
  notifier.fetch = async (url, init) => { ntfy.push(url); return new Response('', { status: 200 }); };
  notifier.webPush = { send: async notice => { sent.push(notice); throw new Error('boom'); }, status: 'The phone notification did not reach any phone.' };
  store.put('prefs', 'notify', { id: 'notify', push: { on: true, topic: 'rexdesk-test' } });
  const one = notifier.notify({ kind: 'mention', title: 'A asked you', body: 'Hi', target: { type: 'room', id: 'r1' }, source: 'msg:1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1); assert.equal(sent[0].source, 'msg:1'); assert.equal(sent[0].preview, true);
  assert.equal(ntfy.length, 1, 'ntfy still went out');
  assert.equal(store.get('notice', one.id).title, 'A asked you', 'the in-app notice is kept');
  focused = true; viewing = 'room:r1';
  notifier.notify({ kind: 'mention', title: 'A asked you', body: 'Again', target: { type: 'room', id: 'r1' }, source: 'msg:2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1, 'no phone notice for the chat on screen');
  store.put('prefs', 'notify', { id: 'notify', preview: false, push: { on: false, topic: 'rexdesk-test' } }); focused = false; viewing = '';
  notifier.notify({ kind: 'reply', title: 'B replied', body: 'Text', target: { type: 'run', id: 'x' }, source: 'run:x:1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2); assert.equal(sent[1].preview, false); assert.equal(ntfy.length, 1, 'ntfy off stays off');
  assert.equal(notifier.summary().prefs.webPushError, 'The phone notification did not reach any phone.');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PhoneRelay, relayProblem } from '../src/phone-relay.js';
import { relayFrame, readRelayFrame, RELAY_OP } from '../src/phone-relay-frame.js';

function fakeDesk(port) {
  const rows = new Map(), events = [];
  const store = { nodeId: 'node-1', get: (kind, key) => rows.get(`${kind}/${key}`), put: (kind, key, value) => (rows.set(`${kind}/${key}`, value), value), event: (...args) => events.push(args) };
  return { desk: { store, port, net: { token: () => 'account-token' }, peers: { self: { name: 'Laptop' } } }, events };
}
// A stand-in for the relay's WebSocket: frames the desk sends are kept, and the test plays the relay's frames into it.
function fakeSocket() {
  const listeners = {}, sent = [];
  const socket = { readyState: 1, sent, addEventListener: (name, fn) => { listeners[name] = fn; }, send: frame => sent.push(readRelayFrame(frame)), close() {}, emit: (name, event) => listeners[name]?.(event) };
  socket.play = (op, streamId, payload) => socket.emit('message', { data: relayFrame(op, streamId, payload) });
  return socket;
}
const waitFor = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('timed out'); };

test('the relay connection says hello with the account and plays phone requests against the desk', async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; });
    request.on('end', () => { seen.push({ method: request.method, url: request.url, headers: request.headers, body: raw }); response.writeHead(201, { 'content-type': 'text/plain' }); response.end('hello phone'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { desk } = fakeDesk(server.address().port), socket = fakeSocket();
    let dialled; const relay = new PhoneRelay(desk, { socket: (url, token) => { dialled = token; return socket; } });
    relay.setEnabled(true); socket.emit('open');
    assert.equal(dialled, 'account-token');
    const hello = socket.sent[0];
    assert.equal(hello.op, RELAY_OP.HELLO);
    assert.deepEqual(JSON.parse(hello.payload), { token: 'account-token', desk: 'node-1', name: 'Laptop' });
    socket.play(RELAY_OP.WELCOME, 0, Buffer.from(JSON.stringify({ url: 'https://web.rexdesk.app/d/node-1' })));
    assert.equal(relay.view().state, 'online');

    // The phone cannot pass itself off as relayed: its own x-rex-relay headers are replaced by the desk's.
    socket.play(RELAY_OP.REQ, 7, Buffer.from(JSON.stringify({ method: 'POST', path: '/api/x?a=1', headers: { 'x-rex-relay': 'forged', 'content-type': 'text/plain', connection: 'close' }, device: { id: 'phone-1', name: 'Pixel' } })));
    socket.play(RELAY_OP.REQ_BODY, 7, Buffer.from('hi '));
    socket.play(RELAY_OP.REQ_BODY, 7, Buffer.from('desk'));
    socket.play(RELAY_OP.REQ_BODY, 7);
    await waitFor(() => socket.sent.some(frame => frame.op === RELAY_OP.RES_BODY && frame.streamId === 7 && !frame.payload.length));
    assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].url, '/api/x?a=1'); assert.equal(seen[0].body, 'hi desk');
    assert.equal(seen[0].headers['x-rex-relay-device'], 'phone-1');
    assert.ok(relay.isRelayed({ headers: seen[0].headers }));
    assert.equal(relay.isRelayed({ headers: { 'x-rex-relay': 'forged' } }), false);
    const head = socket.sent.find(frame => frame.op === RELAY_OP.RES && frame.streamId === 7);
    assert.equal(JSON.parse(head.payload).status, 201);
    assert.equal(Buffer.concat(socket.sent.filter(frame => frame.op === RELAY_OP.RES_BODY && frame.streamId === 7).map(frame => frame.payload)).toString(), 'hello phone');

    socket.play(RELAY_OP.PING, 0, Buffer.from('p'));
    assert.equal(socket.sent.at(-1).op, RELAY_OP.PONG);
    relay.stop();
  } finally { server.close(); }
});

test('a new phone gets one 6-digit code and comes in only after the person approves that code', () => {
  const { desk, events } = fakeDesk(0), relay = new PhoneRelay(desk, { socket: () => fakeSocket() });
  const phone = { id: 'phone-1', name: 'Pixel', account: 'user-2' };
  assert.equal(relay.approved('phone-1', 'user-2'), false);
  const first = relay.pendingFor(phone), again = relay.pendingFor(phone);
  assert.match(first.code, /^\d{6}$/); assert.equal(again.code, first.code);
  assert.equal(events.filter(([, kind]) => kind === 'phone-approval').length, 1);
  // The screens and the snapshot get a short reference, never the phone's own id (which works like its key).
  const [waiting] = relay.view().pending, ref = waiting.id;
  assert.notEqual(ref, 'phone-1'); assert.ok(!JSON.stringify(relay.view()).includes('phone-1')); assert.ok(!JSON.stringify(desk.store.get('phone-relay', 'main')).includes('phone-1'));
  assert.throws(() => relay.approve('phone-1', first.code), /no longer waiting/);
  assert.throws(() => relay.approve(ref, first.code === '000000' ? '111111' : '000000'));
  assert.equal(relay.approved('phone-1', 'user-2'), false);
  relay.approve(ref, first.code);
  assert.equal(relay.approved('phone-1', 'user-2'), true); assert.equal(relay.approved(ref, 'user-2'), false);
  assert.deepEqual(relay.view().pending, []);
  assert.equal(relay.view().devices[0].id, ref);
  relay.forget(ref);
  assert.equal(relay.approved('phone-1', 'user-2'), false);
});

test('an approval from before accounts were kept lets the phone in under no account: it pairs again', () => {
  const { desk } = fakeDesk(0), relay = new PhoneRelay(desk, { socket: () => fakeSocket() });
  const key = createHash('sha256').update('rex-phone:old-phone').digest('hex');
  relay.save({ devices: [{ key, ref: key.slice(0, 20), name: 'Old phone', at: '2026-11-01T00:00:00.000Z' }] });
  const as = account => ({ headers: { 'x-rex-relay': relay.secret, 'x-rex-relay-device': 'old-phone', ...(account ? { 'x-rex-relay-account': account } : {}) } });
  for (const account of ['user-1', 'user-2']) {
    assert.equal(relay.approved('old-phone', account), false, `no stored account: not accepted under ${account}`);
    assert.equal(relay.admit(as(account)).ok, false);
  }
  assert.equal(relay.approved('old-phone'), false); assert.equal(relay.admit(as('')).missing, true, 'no account from the relay: no code can let it in');
  // Pairing again binds the phone to the account it is on now.
  const waiting = relay.pendingFor({ ...relay.admit(as('user-2')).phone }); relay.approve(waiting.ref, waiting.code);
  assert.equal(relay.admit(as('user-2')).ok, true); assert.equal(relay.admit(as('user-1')).ok, false);
  assert.equal(relay.settings().devices.length, 1, 'the new approval replaces the old one');
});

test('a waiting code belongs to the phone id and its account: the same id under another account gets its own code', () => {
  const { desk } = fakeDesk(0), relay = new PhoneRelay(desk, { socket: () => fakeSocket() });
  const mine = relay.pendingFor({ id: 'phone-1', name: 'Pixel', account: 'user-2' });
  const copied = relay.pendingFor({ id: 'phone-1', name: 'Pixel', account: 'user-3' });
  assert.notEqual(copied.ref, mine.ref); assert.equal(relay.pendingFor({ id: 'phone-1', name: 'Pixel', account: 'user-2' }).ref, mine.ref, 'same id and account: same wait');
  assert.equal(relay.view().pending.length, 2);
  // Approving the first one's code lets in only that account.
  relay.approve(mine.ref, mine.code);
  assert.equal(relay.approved('phone-1', 'user-2'), true); assert.equal(relay.approved('phone-1', 'user-3'), false);
  assert.deepEqual(relay.view().pending.map(item => item.id), [copied.ref], 'the other account still waits for its own code');
  assert.throws(() => relay.approve(copied.ref, mine.code === copied.code ? String((Number(mine.code) + 1) % 1000000).padStart(6, '0') : mine.code), /no longer waiting/);
});

test('removing a phone ends its open requests at once', () => {
  const { desk } = fakeDesk(1), socket = fakeSocket(), relay = new PhoneRelay(desk, { socket: () => socket });
  relay.pendingFor({ id: 'phone-1', name: 'Pixel' }); const { id: ref, code } = relay.view().pending[0]; relay.approve(ref, code);
  relay.setEnabled(true); socket.emit('open');
  const destroyed = [];
  // A live-updates request of that phone, and one of another phone.
  relay.streams.set(5, { key: relay.settings().devices[0].key, request: { destroy: () => destroyed.push(5) } });
  relay.streams.set(6, { key: 'other', request: { destroy: () => destroyed.push(6) } });
  relay.forget(ref);
  assert.deepEqual(destroyed, [5]); assert.ok(relay.streams.has(6)); assert.ok(!relay.streams.has(5));
  assert.ok(socket.sent.some(frame => frame.op === RELAY_OP.ABORT && frame.streamId === 5));
  relay.stop();
});

test('a relay "not paid" or "signed out" close stops the desk dialling again', () => {
  for (const [code, state] of [[4002, 'not-paid'], [4003, 'signed-out'], [4001, 'replaced']]) {
    const { desk } = fakeDesk(1), sockets = [];
    const relay = new PhoneRelay(desk, { socket: () => { const socket = fakeSocket(); sockets.push(socket); return socket; } });
    relay.setEnabled(true); sockets[0].emit('close', { code });
    assert.equal(relay.view().state, state);
    assert.equal(relay.timer, null);
    relay.stop();
  }
  const { desk } = fakeDesk(1), socket = fakeSocket(), relay = new PhoneRelay(desk, { socket: () => socket });
  relay.setEnabled(true); socket.emit('close', { code: 1006 });
  assert.equal(relay.view().state, 'offline'); assert.ok(relay.timer); relay.stop();
});

test('a failed relay connect says why: not signed in, plan, server unreachable, or the error itself', () => {
  assert.deepEqual(relayProblem({ code: 4002, opened: true }), { reason: 'not-paid', detail: '' });
  assert.deepEqual(relayProblem({ code: 4003, opened: true }), { reason: 'signed-out', detail: '' });
  assert.equal(relayProblem({ code: 1006, error: 'getaddrinfo ENOTFOUND api.rexdesk.dev' }).reason, 'unreachable');
  assert.deepEqual(relayProblem({ code: 1011, reason: 'relay restarting', opened: true }), { reason: 'other', detail: 'relay restarting' });
  const { desk, events } = fakeDesk(1), socket = fakeSocket(), relay = new PhoneRelay(desk, { socket: () => socket });
  relay.setEnabled(true); socket.emit('error', { message: 'connect ECONNREFUSED' }); socket.emit('close', { code: 1006 });
  assert.equal(relay.view().state, 'offline');
  assert.deepEqual(relay.view().problem, { reason: 'unreachable', detail: 'connect ECONNREFUSED' }, 'the real error is kept');
  assert.ok(events.some(([, kind, data]) => kind === 'phone-relay-error' && /ECONNREFUSED/.test(data.message)), 'and logged');
  relay.stop();
  const signedOut = fakeDesk(1), gone = fakeSocket(), other = new PhoneRelay(signedOut.desk, { socket: () => gone });
  other.setEnabled(true); gone.emit('open'); gone.emit('close', { code: 4003 });
  assert.equal(other.view().state, 'signed-out'); assert.equal(other.view().problem.reason, 'signed-out');
  const page = readFileSync(new URL('../public/chat-devices.js', import.meta.url), 'utf8');
  assert.match(page, /web\.rexdesk\.app/); assert.doesNotMatch(page, /app\.rexdesk\.dev/);
  assert.match(page, /problem\?\.reason === 'unreachable'/, 'the status line shows the reason');
});

test('a phone signed in to the desk\'s own account comes in with no code; another account or a forged header still needs it', () => {
  const { desk } = fakeDesk(1), socket = fakeSocket(), relay = new PhoneRelay(desk, { socket: () => socket });
  relay.setEnabled(true);
  const ask = account => ({ headers: { 'x-rex-relay': relay.secret, 'x-rex-relay-device': 'new-phone', ...(account ? { 'x-rex-relay-account': account } : {}) } });
  assert.equal(relay.sameAccount(ask('user-1')), false, 'no WELCOME yet: the desk does not know its account');
  socket.emit('message', { data: relayFrame(RELAY_OP.WELCOME, 0, Buffer.from(JSON.stringify({ url: 'https://web.rexdesk.app', account: 'user-1' }))) });
  assert.equal(relay.sameAccount(ask('user-1')), true, 'same account: straight in');
  assert.equal(relay.sameAccount(ask('user-2')), false, 'another account needs the code');
  assert.equal(relay.sameAccount(ask('')), false, 'an older relay that sends no account needs the code');
  assert.equal(relay.sameAccount({ headers: { 'x-rex-relay': 'forged', 'x-rex-relay-account': 'user-1' } }), false, 'only requests the relay played count');
  relay.save({ askCode: true }); assert.equal(relay.sameAccount(ask('user-1')), false, 'the person can still ask for the code');
  relay.save({ askCode: false });
  // Same-account trust rests on the relay's account alone: no phone id is needed, and an approval cannot stand in for it.
  assert.deepEqual(relay.admit({ headers: { 'x-rex-relay': relay.secret, 'x-rex-relay-account': 'user-1' } }), { ok: true }, 'same account with no phone id');
  assert.equal(relay.admit({ headers: { 'x-rex-relay': relay.secret, 'x-rex-relay-account': 'user-2' } }).missing, true, 'another account still needs a phone id');
  // A code approval keeps the account it was made under: the same cookie id under another account needs a new code.
  const waiting = relay.pendingFor({ id: 'their-phone', name: 'Pixel', account: 'user-2' }); relay.approve(waiting.ref, waiting.code);
  const as = account => ({ headers: { 'x-rex-relay': relay.secret, 'x-rex-relay-device': 'their-phone', ...(account ? { 'x-rex-relay-account': account } : {}) } });
  assert.equal(relay.admit(as('user-2')).ok, true, 'approved phone, same account as when approved');
  assert.equal(relay.admit(as('user-3')).ok, false, 'the copied id under another account');
  assert.equal(relay.admit(as('')).ok, false, 'the copied id with no account');
  assert.equal(relay.setAskCode(true).askCode, true); assert.equal(relay.admit({ headers: { 'x-rex-relay': relay.secret, 'x-rex-relay-account': 'user-1' } }).ok, false, 'askCode on: the same account needs the code too');
  assert.equal(relay.setAskCode(false).askCode, false, 'off again');
  socket.emit('close', { code: 1006 }); relay.stop();
  assert.equal(relay.account, '', 'a closed connection forgets the account');
});

test('the desk copies the relay\'s account into the request and drops one the phone sent', async () => {
  const server = http.createServer((request, response) => { response.end(JSON.stringify({ account: request.headers['x-rex-relay-account'] || '' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { desk } = fakeDesk(server.address().port), socket = fakeSocket(), relay = new PhoneRelay(desk, { socket: () => socket });
    relay.setEnabled(true);
    const body = async (streamId, meta) => {
      socket.play(RELAY_OP.REQ, streamId, Buffer.from(JSON.stringify({ method: 'GET', path: '/x', end: true, device: { id: 'p1' }, headers: { 'x-rex-relay-account': 'user-1' }, ...meta })));
      for (let i = 0; i < 50 && !socket.sent.some(frame => frame.op === RELAY_OP.RES_BODY && frame.streamId === streamId && frame.payload.length); i++) await new Promise(resolve => setTimeout(resolve, 20));
      return JSON.parse(socket.sent.find(frame => frame.op === RELAY_OP.RES_BODY && frame.streamId === streamId && frame.payload.length).payload.toString()).account;
    };
    assert.equal(await body(1, {}), '', 'a header the phone set itself is not passed on');
    assert.equal(await body(3, { account: { id: 'user-1' } }), 'user-1', 'the relay\'s account is');
    relay.stop();
  } finally { server.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PhoneRelay } from '../src/phone-relay.js';
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
    const relay = new PhoneRelay(desk, { socket: () => socket });
    relay.setEnabled(true); socket.emit('open');
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
  const phone = { id: 'phone-1', name: 'Pixel' };
  assert.equal(relay.approved('phone-1'), false);
  const first = relay.pendingFor(phone), again = relay.pendingFor(phone);
  assert.match(first.code, /^\d{6}$/); assert.equal(again.code, first.code);
  assert.equal(events.filter(([, kind]) => kind === 'phone-approval').length, 1);
  assert.deepEqual(relay.view().pending.map(item => item.id), ['phone-1']);
  assert.throws(() => relay.approve('phone-1', first.code === '000000' ? '111111' : '000000'));
  assert.equal(relay.approved('phone-1'), false);
  relay.approve('phone-1', first.code);
  assert.equal(relay.approved('phone-1'), true);
  assert.deepEqual(relay.view().pending, []);
  relay.forget('phone-1');
  assert.equal(relay.approved('phone-1'), false);
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

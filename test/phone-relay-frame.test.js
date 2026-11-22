import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayFrame, readRelayFrame, RELAY_OP } from '../src/phone-relay-frame.js';

test('relay frames use a one-byte operation and big-endian stream id', () => {
  const frame = relayFrame(RELAY_OP.REQ_BODY, 0x01020304, Buffer.from([0, 255]));
  assert.deepEqual(frame, Buffer.from([0x11, 1, 2, 3, 4, 0, 255]));
  assert.deepEqual(readRelayFrame(frame), { op: RELAY_OP.REQ_BODY, streamId: 0x01020304, payload: Buffer.from([0, 255]) });
});

test('relay frames reject truncated and invalid headers', () => {
  assert.throws(() => readRelayFrame(Buffer.alloc(4)), RangeError);
  assert.throws(() => relayFrame(256, 0), RangeError);
  assert.throws(() => relayFrame(1, -1), RangeError);
});

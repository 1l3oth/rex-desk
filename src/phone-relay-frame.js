// Binary framing shared by the phone relay and the desk connection.
export const RELAY_OP = Object.freeze({ HELLO: 1, WELCOME: 2, PING: 3, PONG: 4, REQ: 16, REQ_BODY: 17, RES: 18, RES_BODY: 19, WS_OPEN: 32, WS_OPEN_ACK: 33, WS_TEXT: 34, WS_BIN: 35, WS_CLOSE: 36, ABORT: 48, SYNC: 64 });

export function relayFrame(op, streamId, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(op) || op < 0 || op > 255 || !Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) throw new RangeError('Invalid relay frame header');
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(5 + bytes.length);
  frame.writeUInt8(op, 0); frame.writeUInt32BE(streamId, 1); bytes.copy(frame, 5);
  return frame;
}

export function readRelayFrame(frame) {
  const bytes = Buffer.from(frame);
  if (bytes.length < 5) throw new RangeError('Incomplete relay frame');
  return { op: bytes.readUInt8(0), streamId: bytes.readUInt32BE(1), payload: bytes.subarray(5) };
}

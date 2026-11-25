import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createApp, serveFile } from '../src/server.js';
import { PhoneRelay } from '../src/phone-relay.js';
import { relayFrame, readRelayFrame, RELAY_OP } from '../src/phone-relay-frame.js';
import { PeerFiles, servableFile } from '../src/peer-files.js';

// L112 review: the computer that holds a file must never hand out anything outside its data folders (a link or a Windows
// junction inside them included) nor a file over the relay limit; the computer that asks must count what arrives instead of
// trusting the reported size, and must never overwrite a file made here while the copy was on its way. No AI runs.
const runnerFactory = () => ({ async start() {}, async interrupt() {}, close() {} });
const ACCOUNT = 'user-1', RUN = '96246b25-cf97-4d17-a70b-9b3e290bf160';
const tempDir = name => mkdtempSync(path.join(process.env.TEMP || process.cwd(), name));
const fakeSocket = () => { const listeners = {}, socket = { readyState: 1, onSend: () => {}, addEventListener: (name, fn) => { listeners[name] = fn; }, send: frame => socket.onSend(readRelayFrame(frame)), close() {}, emit: (name, event) => listeners[name]?.(event) }; socket.play = (op, id, payload) => socket.emit('message', { data: relayFrame(op, id, payload) }); return socket; };
// A link, or a junction when this Windows account may not make file links.
function link(target, at, kind) { try { symlinkSync(target, at, kind); return true; } catch (error) { if (kind === 'dir') { symlinkSync(target, at, 'junction'); return true; } if (error.code === 'EPERM') return false; throw error; } }

test('the holding computer serves only regular files inside its data folders, never through a link or junction, and never over the limit', async () => {
  const dir = tempDir('rex-peer-guard-');
  const memory = process.env.REX_DESK_MEMORY; process.env.REX_DESK_MEMORY = path.join(dir, 'memory');
  let desk;
  try {
    desk = await createApp({ dataDirectory: path.join(dir, 'b'), port: 0, requireAccount: false, runnerFactory });
    const socket = fakeSocket(), relay = new PhoneRelay(desk.desk, { socket: () => socket, port: () => desk.server.address().port });
    desk.desk.phoneRelay = relay; desk.desk.net.token = () => 'desk-b-token';
    relay.save({ enabled: true, askCode: true }); relay.start(); socket.emit('open');
    socket.play(RELAY_OP.WELCOME, 0, Buffer.from(JSON.stringify({ url: 'https://app.rexdesk.dev', account: ACCOUNT })));
    const outside = path.join(dir, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'secret.txt'), 'not for other computers');
    const folder = path.join(desk.store.media('artifacts'), RUN); mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'ok.txt'), 'fine'); mkdirSync(path.join(folder, 'sub'));
    link(outside, path.join(folder, 'escape'), 'dir');
    const fileLink = link(path.join(outside, 'secret.txt'), path.join(folder, 'secret-link.txt'), 'file');
    const base = `http://127.0.0.1:${desk.server.address().port}`;
    const ask = key => fetch(`${base}/api/peer/file?key=${encodeURIComponent(key)}`, { headers: { 'x-rex-relay': relay.secret, 'x-rex-relay-device': 'desk.node-a', 'x-rex-relay-account': ACCOUNT } });

    const ok = await ask(`data/artifacts/${RUN}/ok.txt`); assert.equal(ok.status, 200); assert.equal(await ok.text(), 'fine');
    const junction = await ask(`data/artifacts/${RUN}/escape/secret.txt`); assert.equal(junction.status, 404, 'a junction out of the folder is refused');
    assert.doesNotMatch(await junction.text(), /not for other computers/);
    if (fileLink) assert.equal((await ask(`data/artifacts/${RUN}/secret-link.txt`)).status, 404, 'a file link out of the folder is refused');
    assert.equal((await ask(`data/artifacts/${RUN}/sub`)).status, 404, 'a folder is not a file');
    assert.equal(servableFile(desk.store, `data/artifacts/${RUN}/escape/secret.txt`), null);

    // A junction at a media folder itself (uploads pointing out of the data folder) is refused too.
    const uploads = desk.store.media('uploads'); rmdirSync(uploads);
    mkdirSync(path.join(outside, RUN)); writeFileSync(path.join(outside, RUN, 'secret.txt'), 'not for other computers');
    link(outside, uploads, 'dir');
    try {
      const media = await ask(`data/uploads/${RUN}/secret.txt`); assert.equal(media.status, 404, 'a junction at the uploads folder is refused');
      assert.doesNotMatch(await media.text(), /not for other computers/);
      assert.equal(servableFile(desk.store, `data/uploads/${RUN}/secret.txt`), null);
    } finally { rmdirSync(uploads); }

    desk.desk.peerFiles.max = 3;
    const big = await ask(`data/artifacts/${RUN}/ok.txt`);
    assert.equal(big.status, 413, 'over the limit is refused before any byte is served'); assert.equal(big.headers.get('x-rex-file-size'), '4');
  } finally {
    await desk?.close?.();
    if (memory === undefined) delete process.env.REX_DESK_MEMORY; else process.env.REX_DESK_MEMORY = memory;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ }
  }
});

test('a served file stops at the size checked on its opened handle, even when it grows meanwhile', async () => {
  const dir = tempDir('rex-peer-grow-');
  try {
    const file = path.join(dir, 'growing.mp4'); writeFileSync(file, '0123456789');
    const sent = [], head = {}; let done;
    const finished = new Promise(resolve => { done = resolve; });
    const sink = new Writable({ write(chunk, _e, next) { sent.push(chunk); next(); }, final(next) { next(); done(); } });
    sink.writeHead = (status, headers) => Object.assign(head, { status, headers });
    serveFile({ headers: {} }, sink, file, { max: 1000 });
    // The file grows right after the check, before the stream has read anything.
    appendFileSync(file, 'MORE BYTES THAT WERE NEVER CHECKED');
    await finished;
    assert.equal(head.status, 200); assert.equal(head.headers['Content-Length'], 10);
    assert.equal(Buffer.concat(sent).toString(), '0123456789', 'only the checked 10 bytes went out');
    // Over max on the opened handle: refused before any byte.
    const big = []; let ended; const over = new Promise(resolve => { ended = resolve; });
    const refuse = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, writeHead(status) { this.statusCode = status; }, end(body) { big.push(body); ended(); } };
    serveFile({ headers: {} }, refuse, file, { max: 5 }); await over;
    assert.equal(refuse.statusCode, 413); assert.equal(refuse.headers['x-rex-file-size'], '44');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A PeerFiles of a computer that has no files, asking one other computer through a fetcher the test plays.
function asker(dir, fetcher, max) {
  const store = { nodeId: 'node-a', media: folder => path.join(dir, folder), get: () => null };
  return new PeerFiles({ store, peers: { settings: () => ({ peers: [{ id: 'node-b' }] }) }, net: { token: () => 'token' } }, { fetcher, max, base: 'https://relay.test' });
}
const lying = (bytes, said) => async () => new Response(new Uint8Array(bytes), { status: 206, headers: { 'content-range': `bytes 0-${said - 1}/${said}` } });

test('the asking computer counts the bytes that arrive and stops over the limit, whatever size was reported', async () => {
  const dir = tempDir('rex-peer-size-');
  try {
    const key = `data/artifacts/${RUN}/lie.png`, file = path.join(dir, 'artifacts', RUN, 'lie.png');
    // Says 100 bytes, sends 5000: keep stops at its limit and leaves nothing behind.
    const kept = asker(dir, lying(5000, 100), 1000);
    assert.equal(await kept.keep(key), false); assert.equal(existsSync(file), false);
    assert.deepEqual(readdirSync(path.dirname(file)), [], 'no partial file is left');
    // Streamed to a browser: no more than the limit passes, the answer is cut, and why says too large.
    const piped = asker(dir, lying(5000, 100), 1000), sent = [];
    const sink = new Writable({ write(chunk, _e, done) { sent.push(chunk); done(); } }); sink.writeHead = () => {};
    assert.equal(await piped.pipe(key, { headers: {}, method: 'GET' }, sink), true);
    assert.ok(Buffer.concat(sent).length <= 100, `only the bytes it said it sends passed (${Buffer.concat(sent).length})`);
    assert.equal(piped.why(key)?.reason, 'too-big');
    // A whole-file answer with no size said still stops at the limit.
    const unsized = asker(dir, async () => new Response(new Uint8Array(5000), { status: 206, headers: { 'content-range': 'bytes 0-' } }), 1000), got = [];
    const sink2 = new Writable({ write(chunk, _e, done) { got.push(chunk); done(); } }); sink2.writeHead = () => {};
    await unsized.pipe(key, { headers: {}, method: 'GET' }, sink2);
    assert.ok(Buffer.concat(got).length <= 1000); assert.equal(unsized.why(key)?.reason, 'too-big');
    // The holding computer refused it (413): said as too large.
    const refused = asker(dir, async () => new Response('{}', { status: 413, headers: { 'x-rex-file-size': '2000000000' } }), 1000);
    assert.equal(await refused.keep(key), false); assert.equal(refused.why(key)?.reason, 'too-big'); assert.match(refused.say(key), /too large/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a copy that arrives after a file of the same name was made here never overwrites it', async () => {
  const dir = tempDir('rex-peer-race-');
  try {
    const key = `data/uploads/${RUN}/same.png`, file = path.join(dir, 'uploads', RUN, 'same.png');
    let controller, asked;
    const answered = new Promise(resolve => { asked = resolve; });
    const peer = asker(dir, async () => { asked(); return new Response(new ReadableStream({ start(c) { controller = c; } }), { status: 206, headers: { 'content-range': 'bytes 0-5/6' } }); }, 1000);
    const keeping = peer.keep(key);
    await answered; await new Promise(resolve => setTimeout(resolve, 20));
    controller.enqueue(new TextEncoder().encode('rem'));
    // Meanwhile this computer makes its own file with that name.
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'made here');
    controller.enqueue(new TextEncoder().encode('ote')); controller.close();
    assert.equal(await keeping, true, 'the file is here');
    assert.equal(readFileSync(file, 'utf8'), 'made here', 'the local file wins');
    assert.deepEqual(readdirSync(path.dirname(file)), ['same.png'], 'the temp copy is gone');
    // Only part of the file (a 206 for bytes 0-2 of 6) is never saved as the whole file.
    const part = asker(dir, async () => new Response('rem', { status: 206, headers: { 'content-range': 'bytes 0-2/6' } }), 1000);
    assert.equal(await part.keep(`data/uploads/${RUN}/part.png`), false); assert.equal(existsSync(path.join(path.dirname(file), 'part.png')), false);
    // Says the whole 6 bytes, sends 3: the byte count does not match, nothing is published.
    const short = asker(dir, async () => new Response('rem', { status: 206, headers: { 'content-range': 'bytes 0-5/6' } }), 1000);
    assert.equal(await short.keep(`data/uploads/${RUN}/short.png`), false); assert.equal(existsSync(path.join(path.dirname(file), 'short.png')), false);
    assert.deepEqual(readdirSync(path.dirname(file)), ['same.png'], 'no partial or temp file is left');
    // And with nothing in the way, the copy is published.
    const fresh = asker(dir, async () => new Response('remote', { status: 206, headers: { 'content-range': 'bytes 0-5/6' } }), 1000);
    assert.equal(await fresh.keep(`data/uploads/${RUN}/new.png`), true);
    assert.equal(readFileSync(path.join(path.dirname(file), 'new.png'), 'utf8'), 'remote');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { PhoneRelay } from '../src/phone-relay.js';
import { relayFrame, readRelayFrame, RELAY_OP } from '../src/phone-relay-frame.js';
import { PEER_FILE_MAX } from '../src/peer-files.js';

// L112: a video an agent made on one computer (40 MB, over the 25 MB cloud backup limit, so never backed up) would not open
// from the person's other computer or the phone, and the Media grid stayed blank. Now the computer the phone is on asks the
// computer that has the file, through the account relay. Here desk B holds the files and answers through its real relay
// code (PhoneRelay, frames and all); a small stand-in plays the relay's part between the two desks (api.rexdesk.dev
// /v1/relay/peer/<computer>/file, which forwards to that computer's line). No AI runs.
const runnerFactory = () => ({ async start() {}, async interrupt() {}, close() {} });
const ACCOUNT = 'user-1', RUN = '96246b25-cf97-4d17-a70b-9b3e290bf160', VIDEO = '1795570251060-stanford-agents.mp4', PICTURE = '1795570000000-cover.png';
// The real video when this computer has it (Rex's ReelHome evidence), or 40 MB of stand-in bytes.
const REAL = 'D:\\Rex Desk\\artifacts\\96246b25-cf97-4d17-a70b-9b3e290bf160\\1795570251060-stanford-agents.mp4';

function fakeSocket() {
  const listeners = {}, socket = { readyState: 1, onSend: () => {}, addEventListener: (name, fn) => { listeners[name] = fn; }, send: frame => socket.onSend(readRelayFrame(frame)), close() {}, emit: (name, event) => listeners[name]?.(event) };
  socket.play = (op, streamId, payload) => socket.emit('message', { data: relayFrame(op, streamId, payload) });
  return socket;
}
// The relay's part: the Worker checks the caller's sign-in, the target computer's Durable Object turns the request into REQ
// frames on that computer's line and the RES and RES_BODY frames back into a streamed response. 503 when that computer is off.
function fakeRelay(holders) {
  let next = 0; const streams = new Map(), asked = [];
  for (const [node, socket] of holders) socket.onSend = frame => {
    const stream = streams.get(frame.streamId); if (!stream) return;
    if (frame.op === RELAY_OP.RES) { const head = JSON.parse(frame.payload); stream.head(head); }
    else if (frame.op === RELAY_OP.RES_BODY) { if (frame.payload.length) stream.controller.enqueue(new Uint8Array(frame.payload)); else { stream.controller.close(); streams.delete(frame.streamId); } }
    else if (frame.op === RELAY_OP.ABORT) { stream.controller.error(new Error('aborted')); streams.delete(frame.streamId); }
    void node;
  };
  const fetcher = async (url, { headers = {} } = {}) => {
    const address = new URL(url), [, , , , node] = address.pathname.split('/');
    asked.push({ node, key: address.searchParams.get('key'), range: headers.range || '' });
    if (headers.authorization !== 'Bearer desk-a-token') return new Response('', { status: 401 });
    const socket = holders.get(decodeURIComponent(node)); if (!socket) return new Response('desk offline', { status: 503 });
    const streamId = (next += 2);
    return new Promise(resolve => {
      const stream = {}; let controller;
      const body = new ReadableStream({ start(c) { controller = c; }, cancel() { socket.play(RELAY_OP.ABORT, streamId, Buffer.from('{}')); streams.delete(streamId); } });
      stream.controller = { enqueue: chunk => controller.enqueue(chunk), close: () => controller.close(), error: error => controller.error(error) };
      stream.head = head => { const out = new Headers(); for (const [key, value] of Object.entries(head.headers || {})) out.set(key, String(value)); resolve(new Response([204, 304].includes(head.status) ? null : body, { status: head.status, headers: out })); };
      streams.set(streamId, stream);
      socket.play(RELAY_OP.REQ, streamId, Buffer.from(JSON.stringify({ method: 'GET', path: `/api/peer/file?key=${encodeURIComponent(address.searchParams.get('key'))}`, headers: headers.range ? { range: headers.range } : {}, device: { id: `desk.${address.searchParams.get('from')}`, name: 'A phone' }, account: { id: ACCOUNT }, end: true })));
    });
  };
  return { fetcher, asked };
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('a 40 MB video and a picture made on the other computer open here through the relay, and the reason shows when they cannot', { timeout: 180000 }, async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-peer-files-'));
  const memory = process.env.REX_DESK_MEMORY; process.env.REX_DESK_MEMORY = path.join(dir, 'memory');
  let deskA, deskB, browser;
  try {
    // Desk B: the computer the agent works on. It holds the files and is on the relay with the same account.
    deskB = await createApp({ dataDirectory: path.join(dir, 'b'), port: 0, requireAccount: false, runnerFactory });
    const folderB = path.join(deskB.store.media('artifacts'), RUN); mkdirSync(folderB, { recursive: true });
    const video = path.join(folderB, VIDEO);
    if (existsSync(REAL)) copyFileSync(REAL, video); else writeFileSync(video, randomBytes(40 * 1024 * 1024));
    const picture = randomBytes(300 * 1024); writeFileSync(path.join(folderB, PICTURE), picture);
    const videoBytes = readFileSync(video), size = videoBytes.length;
    assert.ok(size > 25 * 1024 * 1024, 'the video is over the cloud backup limit, like the real one');
    const socketB = fakeSocket(), relayB = new PhoneRelay(deskB.desk, { socket: () => socketB, port: () => deskB.server.address().port });
    deskB.desk.phoneRelay = relayB; deskB.desk.net.token = () => 'desk-b-token';
    relayB.save({ enabled: true, askCode: true }); relayB.start(); socketB.emit('open');
    socketB.play(RELAY_OP.WELCOME, 0, Buffer.from(JSON.stringify({ url: 'https://app.rexdesk.dev', account: ACCOUNT })));
    assert.equal(relayB.view().state, 'online');

    // Desk A: the computer the phone is on. It has the chat (and its Media list) but not the files.
    const relay = fakeRelay(new Map([[deskB.store.nodeId, socketB]]));
    deskA = await createApp({ dataDirectory: path.join(dir, 'a'), port: 0, requireAccount: false, runnerFactory, peerFetcher: relay.fetcher });
    deskA.desk.net.token = () => 'desk-a-token';
    deskA.desk.peers.cloudSeen = new Map([[deskB.store.nodeId, { node: deskB.store.nodeId, name: 'Rex Laptop', at: Date.now(), agents: {} }]]);
    deskA.store.put('artifact', 'video-1', { id: 'video-1', runId: RUN, file: VIDEO, title: 'Stanford free AI agents course', type: 'video/mp4', createdAt: new Date().toISOString() });
    const base = deskA.address || `http://127.0.0.1:${deskA.server.address().port}`, localVideo = path.join(deskA.store.media('artifacts'), RUN, VIDEO);
    assert.equal(existsSync(localVideo), false);

    // The picture (a Media grid thumbnail) comes over whole and is kept here.
    const thumb = await fetch(`${base}/artifacts/${RUN}/${PICTURE}`);
    assert.equal(thumb.status, 200); assert.equal(sha(Buffer.from(await thumb.arrayBuffer())), sha(picture));
    assert.ok(existsSync(path.join(deskA.store.media('artifacts'), RUN, PICTURE)), 'the thumbnail is kept on this computer');

    // The video plays straight from the other computer, a range at a time, and seeking works.
    const first = await fetch(`${base}/artifacts/${RUN}/${VIDEO}`, { headers: { range: 'bytes=0-1023' } });
    assert.equal(first.status, 206); assert.equal(first.headers.get('content-range'), `bytes 0-1023/${size}`);
    assert.equal(sha(Buffer.from(await first.arrayBuffer())), sha(videoBytes.subarray(0, 1024)));
    const middle = Math.floor(size / 2), seek = await fetch(`${base}/artifacts/${RUN}/${VIDEO}`, { headers: { range: `bytes=${middle}-${middle + 65535}` } });
    assert.equal(seek.status, 206); assert.equal(sha(Buffer.from(await seek.arrayBuffer())), sha(videoBytes.subarray(middle, middle + 65536)));
    const whole = await fetch(`${base}/artifacts/${RUN}/${VIDEO}`);
    assert.equal(whole.status, 200); assert.equal(Number(whole.headers.get('content-length')), size);
    assert.equal(sha(Buffer.from(await whole.arrayBuffer())), sha(videoBytes), 'all 40 MB arrive unchanged');
    assert.equal(existsSync(localVideo), false, 'a big video is streamed, not copied to this computer');

    // The file window: opening it says what it is, and its player reads it through /api/files/raw.
    const opened = await (await fetch(`${base}/api/files/open?path=${encodeURIComponent(`/artifacts/${RUN}/${VIDEO}`)}`)).json();
    assert.equal(opened.kind, 'video'); assert.equal(opened.size, size); assert.equal(opened.remote, true);
    const raw = await fetch(`${base}/api/files/raw?path=${encodeURIComponent(opened.path)}`, { headers: { range: 'bytes=100-199' } });
    assert.equal(raw.status, 206); assert.equal(sha(Buffer.from(await raw.arrayBuffer())), sha(videoBytes.subarray(100, 200)));

    // On a phone-size browser: the file window opens the video and it plays from the other computer.
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, bypassCSP: true })).newPage();
    await page.goto(`${base}/`); await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    await page.waitForFunction(() => document.querySelector('#draft, .composer, main'), null, { timeout: 20000 });
    await page.evaluate(file => { const link = document.createElement('a'); link.dataset.fileOpen = file; link.href = file; link.id = 'open-l112'; link.textContent = 'video'; document.body.append(link); }, `/artifacts/${RUN}/${VIDEO}`);
    await page.locator('#open-l112').click();
    const player = page.locator('.fw-media video');
    await player.waitFor({ state: 'attached', timeout: 20000 });
    const played = await player.evaluate(async element => {
      element.muted = true;
      await new Promise((resolve, reject) => { if (element.readyState >= 1) resolve(); element.addEventListener('loadedmetadata', resolve, { once: true }); element.addEventListener('error', () => reject(new Error(`video error ${element.error?.code}`)), { once: true }); setTimeout(() => reject(new Error('no metadata')), 30000); });
      element.currentTime = Math.min(30, element.duration / 2);
      await new Promise(resolve => { element.addEventListener('seeked', resolve, { once: true }); setTimeout(resolve, 15000); });
      return { duration: element.duration, at: element.currentTime, width: element.videoWidth, ready: element.readyState };
    }).catch(error => ({ error: error.message }));
    if (existsSync(REAL)) {
      assert.ok(!played.error, played.error); assert.ok(played.duration > 60, `the real 1:33 video reports its length (${played.duration})`);
      assert.ok(played.width > 0 && played.ready >= 1, 'a frame is there after seeking');
    }
    await page.screenshot({ path: path.join(process.env.REX_SHOT_DIR || dir, 'l112-phone-video.png') });

    // Desk B goes offline: the reason says which computer and what to do, instead of "could not be fetched".
    socketB.readyState = 3; const offline = fakeRelay(new Map());
    deskA.desk.peerFiles.fetcher = offline.fetcher;
    const other = `${RUN}/1795570300000-other.mp4`;
    const gone = await fetch(`${base}/api/files/open?path=${encodeURIComponent(`/artifacts/${other}`)}`);
    const said = (await gone.json()).error;
    assert.match(said, /on Rex Laptop, which is offline/);
    const page404 = await fetch(`${base}/artifacts/${other}`);
    assert.equal(page404.status, 404); assert.match(await page404.text(), /which is offline/);

    // Too large to pass through: said with its size.
    deskA.desk.peerFiles.fetcher = async () => new Response('x', { status: 206, headers: { 'content-range': `bytes 0-0/${PEER_FILE_MAX + 1}` } });
    const huge = await (await fetch(`${base}/api/files/open?path=${encodeURIComponent(`/artifacts/${RUN}/1795570400000-huge.mp4`)}`)).json();
    assert.match(huge.error, /too large to open from another computer/);

    // Desk B hands its files only to its own account's computers: a phone (not named desk.) still needs its code there.
    const phoneAsk = await fetch(`${deskB.address || `http://127.0.0.1:${deskB.server.address().port}`}/api/peer/file?key=${encodeURIComponent(`data/artifacts/${RUN}/${PICTURE}`)}`, { headers: { 'x-rex-relay': relayB.secret, 'x-rex-relay-device': 'abc123', 'x-rex-relay-account': ACCOUNT } });
    assert.equal(phoneAsk.status, 403);
    const otherAccount = await fetch(`${deskB.address || `http://127.0.0.1:${deskB.server.address().port}`}/api/peer/file?key=${encodeURIComponent(`data/artifacts/${RUN}/${PICTURE}`)}`, { headers: { 'x-rex-relay': relayB.secret, 'x-rex-relay-device': 'desk.someone', 'x-rex-relay-account': 'user-2' } });
    assert.notEqual(otherAccount.status, 200);
    const escape = await fetch(`${deskB.address || `http://127.0.0.1:${deskB.server.address().port}`}/api/peer/file?key=${encodeURIComponent('data/artifacts/../desk.sqlite')}`, { headers: { 'x-rex-relay': relayB.secret, 'x-rex-relay-device': 'desk.node-a', 'x-rex-relay-account': ACCOUNT } });
    assert.equal(escape.status, 404);
  } finally {
    await browser?.close(); await deskA?.close?.(); await deskB?.close?.();
    if (memory === undefined) delete process.env.REX_DESK_MEMORY; else process.env.REX_DESK_MEMORY = memory;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ }
  }
});

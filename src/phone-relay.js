// The phone reaches this desk through api.rexdesk.dev, with no Tailscale and no setup: the desk keeps one outgoing
// WebSocket open to the relay, and every page load, API call and live update from the phone comes down it as frames
// (phone-relay-frame.js). Each one is played against this desk's own server, so the phone sees the same app as here.
// A phone the desk has never seen gets a 6-digit code: the same code shows on the desk, and only the person's OK there lets it in.
import http from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { relayFrame, readRelayFrame, RELAY_OP } from './phone-relay-frame.js';

export const RELAY_URL = 'wss://api.rexdesk.dev/v1/relay/desk';
const PENDING_MS = 10 * 60000, MAX_PENDING = 5, MAX_BODY = 50 * 1024 * 1024, CHUNK = 64 * 1024;
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
// Headers that belong to one hop, or that only this desk may set on a relayed request.
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'content-length']);
const OWN = /^x-rex-relay/i;
const same = (left, right) => { const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || '')); return a.length === b.length && a.length > 0 && timingSafeEqual(a, b); };
const cleanId = value => String(value || '').replace(/[^\w.-]/g, '').slice(0, 80);
const cleanName = value => String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80) || 'A phone';
const json = value => Buffer.from(JSON.stringify(value));
// A phone's id works like a key: whoever holds it is that phone. So the desk keeps only its hash, and the screens (and the
// snapshot other devices see) only a short reference to that hash, which cannot be sent back as an id.
const keyOf = id => createHash('sha256').update(`rex-phone:${id}`).digest('hex');
const refOf = key => key.slice(0, 20);

const STOP_CODES = { 4001: 'replaced', 4002: 'not-paid', 4003: 'signed-out' };
// Why the last try to reach the relay failed, for the line under the switch: the relay's own stop codes first; a socket that
// never opened could not reach the server (or it refused the handshake); anything after it opened is shown with its own words.
export function relayProblem({ code, reason = '', error = '', opened = false } = {}) {
  if (STOP_CODES[code]) return { reason: STOP_CODES[code], detail: '' };
  const detail = String(reason || error || (code ? `closed with code ${code}` : '')).slice(0, 200);
  return { reason: opened ? 'other' : 'unreachable', detail };
}
export class PhoneRelay {
  constructor(desk, { url = RELAY_URL, socket = (target, token) => new WebSocket(target, { headers: { authorization: `Bearer ${token}` } }), port = () => desk.port } = {}) {
    this.desk = desk; this.url = url; this.makeSocket = socket; this.port = port;
    // Only requests carrying this secret count as relayed. It never leaves this process.
    this.secret = randomBytes(24).toString('base64url');
    this.streams = new Map(); this.socket = null; this.state = 'off'; this.tries = 0; this.timer = null; this.publicUrl = ''; this.problem = null; this.account = '';
  }
  get store() { return this.desk.store; }
  settings() { return this.store.get('phone-relay', 'main') || { enabled: false, devices: [], pending: [] }; }
  save(patch) { return this.store.put('phone-relay', 'main', { ...this.settings(), ...patch }); }

  // ---------- which phones may come in ----------
  isRelayed(request) { return same(request.headers['x-rex-relay'], this.secret); }
  device(request) { return { id: cleanId(request.headers['x-rex-relay-device']), name: cleanName(decodeURIComponent(String(request.headers['x-rex-relay-name'] || ''))) }; }
  // A phone signed in to the same Rex Desk account as this desk comes in with no code. Both accounts come from the relay
  // itself, never from the phone: the desk's in WELCOME (checked against the desk's own sign-in on this socket) and the
  // phone's in each request's frame (from the phone's checked session). The phone's own x-rex-relay-* headers are dropped.
  // askCode: the person can still ask for the code from every new phone.
  sameAccount(request) {
    const account = cleanId(request.headers['x-rex-relay-account']);
    return this.isRelayed(request) && Boolean(account) && account === this.account && !this.settings().askCode;
  }
  // A code-approved phone is known by the id the relay sends for it. That id comes from a cookie the desk cannot check, so
  // an approval also keeps the account the relay saw then: the same id under another account (or with none) needs a new code.
  approved(deviceId, account = '') {
    const key = deviceId ? keyOf(deviceId) : ''; if (!key) return false;
    return this.settings().devices.some(item => item.key === key && (!item.account || item.account === cleanId(account)));
  }
  // Whether a relayed request may come in. The same account needs nothing else: trust there rests on the relay's checked
  // account alone, never on the phone's id. Any other phone needs its id and an approval made with the code.
  admit(request) {
    if (this.sameAccount(request)) return { ok: true };
    const phone = this.device(request), account = cleanId(request.headers['x-rex-relay-account']);
    if (!phone.id) return { ok: false, missing: true };
    if (this.approved(phone.id, account)) return { ok: true };
    return { ok: false, phone: { ...phone, account } };
  }
  // The code a new phone shows, kept for ten minutes. Asking again within that time shows the same code.
  pendingFor({ id, name, account = '' }) {
    const at = Date.now(), live = this.settings().pending.filter(item => item.until > at);
    const key = keyOf(id); let item = live.find(entry => entry.key === key);
    if (!item) {
      item = { key, ref: refOf(key), name, account: cleanId(account), code: String(randomInt(0, 1000000)).padStart(6, '0'), createdAt: new Date(at).toISOString(), until: at + PENDING_MS };
      live.push(item); while (live.length > MAX_PENDING) live.shift();
      this.store.event('', 'phone-approval', { device: item.ref, name, code: item.code }, true);
    }
    this.save({ pending: live }); return item;
  }
  // The screens pass the short reference ("id" in what they get); never the phone's own id.
  pending() { const at = Date.now(); return this.settings().pending.filter(item => item.until > at).map(({ ref, name, code, createdAt }) => ({ id: ref, name, code, createdAt })); }
  approve(ref, code) {
    const settings = this.settings(), item = settings.pending.find(entry => entry.ref === ref && entry.until > Date.now());
    if (!item || !same(String(code || ''), item.code)) throw new Error('That phone is no longer waiting. Open Rex Desk on the phone again for a new code.');
    this.save({ pending: settings.pending.filter(entry => entry.ref !== ref), devices: [...settings.devices.filter(entry => entry.key !== item.key), { key: item.key, ref: item.ref, name: item.name, account: item.account || '', at: new Date().toISOString() }] });
    return { approved: true };
  }
  deny(ref) { this.save({ pending: this.settings().pending.filter(entry => entry.ref !== ref) }); return { denied: true }; }
  // A removed phone is cut off at once: its open requests (the live updates stay open) end too.
  forget(ref) {
    const gone = this.settings().devices.filter(entry => entry.ref === ref);
    this.save({ devices: this.settings().devices.filter(entry => entry.ref !== ref) });
    for (const [streamId, stream] of this.streams) if (gone.some(entry => entry.key === stream.key)) { this.streams.delete(streamId); stream.request?.destroy(); this.send(RELAY_OP.ABORT, streamId); }
    return { removed: true };
  }
  view() { const settings = this.settings(); return { enabled: Boolean(settings.enabled), state: this.state, problem: this.state === 'online' ? null : this.problem, url: this.publicUrl, devices: settings.devices.map(({ ref, name, at }) => ({ id: ref, name, at })), pending: this.pending() }; }

  // ---------- the connection to the relay ----------
  setEnabled(on) { this.save({ enabled: Boolean(on) }); if (on) this.start(); else this.stop(); return this.view(); }
  start() {
    if (this.socket || !this.settings().enabled || this.desk.closed) return;
    const token = this.desk.net?.token?.(); if (!token) { this.state = 'signed-out'; return; }
    this.state = 'connecting';
    // The relay checks the sign-in on the upgrade itself, so the token rides on the handshake; HELLO repeats it with the desk's name.
    let socket; try { socket = this.makeSocket(this.url, token); } catch (error) { this.failed({ error: error.message }); this.state = 'offline'; return this.retry(); }
    this.socket = socket; socket.binaryType = 'arraybuffer';
    let opened = false, error = '';
    socket.addEventListener('open', () => opened = true);
    socket.addEventListener('open', () => this.send(RELAY_OP.HELLO, 0, json({ token, desk: this.store.nodeId, name: this.desk.peers?.self?.name || '' })));
    socket.addEventListener('message', event => { try { this.onFrame(readRelayFrame(Buffer.from(event.data))); } catch (error) { this.store.event('', 'phone-relay-error', { message: error.message }); } });
    // The relay closes with 4001 when a newer connection of this desk took over, 4002 when the plan has no relay and 4003 when the sign-in
    // is no longer good. Those do not get better by dialling again, so the desk waits for the switch or a new sign-in instead.
    socket.addEventListener('close', event => { if (this.socket !== socket) return; this.socket = null; this.account = ''; this.dropStreams(); this.failed({ code: event?.code, reason: event?.reason, error, opened }); const stay = STOP_CODES[event?.code]; this.state = stay || 'offline'; if (!stay) this.retry(); });
    // The error itself is kept for the close that always follows it, which says what went wrong.
    socket.addEventListener('error', event => { error = String(event?.message || event?.error?.message || 'connection error'); });
  }
  failed(what) {
    this.problem = relayProblem(what);
    const message = [this.problem.reason, this.problem.detail].filter(Boolean).join(': ');
    this.store.event('', 'phone-relay-error', { message }); console.warn(`Phone relay: ${message}`);
  }
  stop() {
    clearTimeout(this.timer); this.timer = null; const socket = this.socket; this.socket = null; this.account = ''; this.dropStreams();
    try { socket?.close(); } catch {} this.state = 'off';
  }
  retry() {
    if (!this.settings().enabled || this.desk.closed || this.timer) return;
    const wait = RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)];
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, wait); this.timer.unref?.();
  }
  send(op, streamId, payload) { if (this.socket?.readyState === 1) this.socket.send(relayFrame(op, streamId, payload)); }
  dropStreams() { for (const stream of this.streams.values()) stream.request?.destroy(); this.streams.clear(); }

  onFrame({ op, streamId, payload }) {
    if (op === RELAY_OP.WELCOME) { this.state = 'online'; this.tries = 0; this.problem = null; try { const hello = JSON.parse(payload.toString('utf8')); this.publicUrl = String(hello.url || ''); this.account = cleanId(hello.account); } catch {} return; }
    if (op === RELAY_OP.PING) return this.send(RELAY_OP.PONG, streamId, payload);
    if (op === RELAY_OP.REQ) return this.openStream(streamId, JSON.parse(payload.toString('utf8')));
    if (op === RELAY_OP.REQ_BODY) return this.bodyChunk(streamId, payload);
    if (op === RELAY_OP.ABORT) { this.streams.get(streamId)?.request?.destroy(); this.streams.delete(streamId); return; }
    // The app's live updates use server-sent events over plain HTTP, so a WebSocket from the phone is refused.
    if (op === RELAY_OP.WS_OPEN) return this.send(RELAY_OP.WS_CLOSE, streamId, json({ code: 1003, reason: 'Not used by Rex Desk.' }));
  }
  // One request from the phone: played against this desk's own server, marked as relayed, with the phone's device id.
  openStream(streamId, meta) {
    if (this.streams.has(streamId)) return;
    const headers = {};
    for (const [key, value] of Object.entries(meta.headers || {})) if (!HOP.has(key.toLowerCase()) && !OWN.test(key)) headers[key.toLowerCase()] = String(value);
    Object.assign(headers, { 'x-rex-relay': this.secret, 'x-rex-relay-device': cleanId(meta.device?.id), 'x-rex-relay-name': encodeURIComponent(cleanName(meta.device?.name)), 'x-rex-relay-account': cleanId(meta.account?.id ?? meta.account) });
    const method = /^[A-Z]{3,7}$/.test(String(meta.method)) ? meta.method : 'GET', route = String(meta.path || '/');
    if (!route.startsWith('/')) return this.send(RELAY_OP.ABORT, streamId);
    const device = cleanId(meta.device?.id), stream = { size: 0, key: device ? keyOf(device) : '' }; this.streams.set(streamId, stream);
    stream.request = http.request({ host: '127.0.0.1', port: this.port(), method, path: route, headers }, response => {
      const out = {}; for (const [key, value] of Object.entries(response.headers)) if (!HOP.has(key)) out[key] = value;
      this.send(RELAY_OP.RES, streamId, json({ status: response.statusCode, headers: out }));
      response.on('data', chunk => { for (let at = 0; at < chunk.length; at += CHUNK) this.send(RELAY_OP.RES_BODY, streamId, chunk.subarray(at, at + CHUNK)); });
      response.on('end', () => { this.send(RELAY_OP.RES_BODY, streamId); this.streams.delete(streamId); });
      response.on('error', () => this.fail(streamId));
    });
    stream.request.on('error', () => this.fail(streamId));
    // A request with no body (most GETs) says so at once instead of sending an empty body piece.
    if (meta.end) stream.request.end();
  }
  // The body comes in pieces; an empty piece ends it.
  bodyChunk(streamId, chunk) {
    const stream = this.streams.get(streamId); if (!stream?.request) return;
    if (!chunk.length) return void stream.request.end();
    stream.size += chunk.length;
    if (stream.size > MAX_BODY) return this.fail(streamId);
    stream.request.write(chunk);
  }
  fail(streamId) { const stream = this.streams.get(streamId); if (!stream) return; this.streams.delete(streamId); stream.request?.destroy(); this.send(RELAY_OP.ABORT, streamId); }
}

// What a phone the desk does not know yet sees: the code to check against the one on the desk. It asks again every few seconds.
export function waitingPage(code) {
  const digits = String(code).replace(/\D/g, '').slice(0, 6);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="4"><title>Approve this phone</title><link rel="stylesheet" href="/login.css"></head><body><main class="login"><h1>Approve this phone on your desk</h1><p>Rex Desk on your computer shows the same code. Check it matches, then press Approve there.</p><p class="code" aria-label="Code">${digits.slice(0, 3)} ${digits.slice(3)}</p></main></body></html>`;
}

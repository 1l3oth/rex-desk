// The phone reaches this desk through api.rexdesk.dev, with no Tailscale and no setup: the desk keeps one outgoing
// WebSocket open to the relay, and every page load, API call and live update from the phone comes down it as frames
// (phone-relay-frame.js). Each one is played against this desk's own server, so the phone sees the same app as here.
// A phone the desk has never seen gets a 6-digit code: the same code shows on the desk, and only the person's OK there lets it in.
import http from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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

export class PhoneRelay {
  constructor(desk, { url = RELAY_URL, socket = (target) => new WebSocket(target), port = () => desk.port } = {}) {
    this.desk = desk; this.url = url; this.makeSocket = socket; this.port = port;
    // Only requests carrying this secret count as relayed. It never leaves this process.
    this.secret = randomBytes(24).toString('base64url');
    this.streams = new Map(); this.socket = null; this.state = 'off'; this.tries = 0; this.timer = null; this.publicUrl = '';
  }
  get store() { return this.desk.store; }
  settings() { return this.store.get('phone-relay', 'main') || { enabled: false, devices: [], pending: [] }; }
  save(patch) { return this.store.put('phone-relay', 'main', { ...this.settings(), ...patch }); }

  // ---------- which phones may come in ----------
  isRelayed(request) { return same(request.headers['x-rex-relay'], this.secret); }
  device(request) { return { id: cleanId(request.headers['x-rex-relay-device']), name: cleanName(decodeURIComponent(String(request.headers['x-rex-relay-name'] || ''))) }; }
  approved(deviceId) { return Boolean(deviceId) && this.settings().devices.some(item => item.id === deviceId); }
  // The code a new phone shows, kept for ten minutes. Asking again within that time shows the same code.
  pendingFor({ id, name }) {
    const at = Date.now(), live = this.settings().pending.filter(item => item.until > at);
    let item = live.find(entry => entry.id === id);
    if (!item) {
      item = { id, name, code: String(randomInt(0, 1000000)).padStart(6, '0'), createdAt: new Date(at).toISOString(), until: at + PENDING_MS };
      live.push(item); while (live.length > MAX_PENDING) live.shift();
      this.store.event('', 'phone-approval', { device: id, name, code: item.code }, true);
    }
    this.save({ pending: live }); return item;
  }
  pending() { const at = Date.now(); return this.settings().pending.filter(item => item.until > at).map(({ id, name, code, createdAt }) => ({ id, name, code, createdAt })); }
  approve(deviceId, code) {
    const settings = this.settings(), item = settings.pending.find(entry => entry.id === deviceId && entry.until > Date.now());
    if (!item || !same(String(code || ''), item.code)) throw new Error('That phone is no longer waiting. Open Rex Desk on the phone again for a new code.');
    this.save({ pending: settings.pending.filter(entry => entry.id !== deviceId), devices: [...settings.devices.filter(entry => entry.id !== deviceId), { id: item.id, name: item.name, at: new Date().toISOString() }] });
    return { approved: true };
  }
  deny(deviceId) { this.save({ pending: this.settings().pending.filter(entry => entry.id !== deviceId) }); return { denied: true }; }
  forget(deviceId) { this.save({ devices: this.settings().devices.filter(entry => entry.id !== deviceId) }); return { removed: true }; }
  view() { const settings = this.settings(); return { enabled: Boolean(settings.enabled), state: this.state, url: this.publicUrl, devices: settings.devices, pending: this.pending() }; }

  // ---------- the connection to the relay ----------
  setEnabled(on) { this.save({ enabled: Boolean(on) }); if (on) this.start(); else this.stop(); return this.view(); }
  start() {
    if (this.socket || !this.settings().enabled || this.desk.closed) return;
    const token = this.desk.net?.token?.(); if (!token) { this.state = 'signed-out'; return; }
    this.state = 'connecting';
    let socket; try { socket = this.makeSocket(this.url); } catch { return this.retry(); }
    this.socket = socket; socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => this.send(RELAY_OP.HELLO, 0, json({ token, desk: this.store.nodeId, name: this.desk.peers?.self?.name || '' })));
    socket.addEventListener('message', event => { try { this.onFrame(readRelayFrame(Buffer.from(event.data))); } catch (error) { this.store.event('', 'phone-relay-error', { message: error.message }); } });
    socket.addEventListener('close', () => { if (this.socket !== socket) return; this.socket = null; this.dropStreams(); this.state = 'offline'; this.retry(); });
    socket.addEventListener('error', () => {});
  }
  stop() {
    clearTimeout(this.timer); this.timer = null; const socket = this.socket; this.socket = null; this.dropStreams();
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
    if (op === RELAY_OP.WELCOME) { this.state = 'online'; this.tries = 0; try { this.publicUrl = String(JSON.parse(payload.toString('utf8')).url || ''); } catch {} return; }
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
    Object.assign(headers, { 'x-rex-relay': this.secret, 'x-rex-relay-device': cleanId(meta.device?.id), 'x-rex-relay-name': encodeURIComponent(cleanName(meta.device?.name)) });
    const method = /^[A-Z]{3,7}$/.test(String(meta.method)) ? meta.method : 'GET', route = String(meta.path || '/');
    if (!route.startsWith('/')) return this.send(RELAY_OP.ABORT, streamId);
    const stream = { size: 0 }; this.streams.set(streamId, stream);
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

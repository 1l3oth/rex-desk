import { createCipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { ACCOUNT_API } from './rexdesk-account.js';

// Phone notifications without ntfy (web push). The phones are kept by the Rex Desk account service (api.rexdesk.dev):
// only each phone's push address and keys. This computer locks every notice with the phone's own keys (RFC 8291,
// aes128gcm) before it leaves, so neither the account service nor Apple, Google or Mozilla can read it. Nothing here logs
// notice text or phone keys.

// A push service takes 4096 bytes. The lock adds 86 bytes of header, 1 end mark and a 16-byte tag.
export const PUSH_BYTES = 4096;
const OVERHEAD = 86 + 1 + 16;
export const PLAIN_BYTES = PUSH_BYTES - OVERHEAD;
const PHONES_MS = 10 * 60_000;
export const SIGN_IN_FIRST = 'Sign in to Rex Desk to get phone notifications.';
export const HIDDEN_TEXT = 'Open Rex Desk to read it.';

const b64u = value => Buffer.from(value).toString('base64url');
const fromB64u = text => Buffer.from(String(text || ''), 'base64url');
const hkdf = (salt, ikm, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

// RFC 8291 with RFC 8188 (one record). asPrivate and salt are only passed by tests (the standard's sample values).
export function encrypt(plain, { p256dh, auth }, { asPrivate, salt = randomBytes(16) } = {}) {
  const uaPublic = fromB64u(p256dh), secret = fromB64u(auth), data = Buffer.from(plain);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || secret.length !== 16) throw new Error('That phone has keys Rex Desk cannot use.');
  if (data.length > PLAIN_BYTES) throw new Error('The notice is too long for a phone notification.');
  const ecdh = createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(fromB64u(asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(), shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(secret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(PUSH_BYTES, 16); head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, sealed]);
}

// Text cut by whole letters (a Khmer letter with its marks stays together) so the notice fits once locked.
const graphemes = text => typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment) : Array.from(text);
export function fitPayload(notice) {
  const encode = value => Buffer.from(JSON.stringify(value));
  if (encode(notice).length <= PLAIN_BYTES) return notice;
  const fit = (field, other) => {
    const parts = graphemes(String(other[field] || ''));
    let low = 0, high = parts.length;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (encode({ ...other, [field]: `${parts.slice(0, mid).join('')}…` }).length <= PLAIN_BYTES) low = mid; else high = mid - 1; }
    return { ...other, [field]: low < parts.length ? `${parts.slice(0, low).join('')}…` : parts.join('') };
  };
  let out = fit('body', notice);
  if (encode(out).length > PLAIN_BYTES) out = fit('title', { ...out, body: '' });
  return out;
}

// One id per message that every computer of the account works out the same way, so two computers make one notice and a
// repeat replaces the old one on the phone (its tag).
export function noticeTag(source) { return createHash('sha256').update(String(source)).digest('base64url').slice(0, 22); }

export class WebPush {
  constructor({ token = () => '', base = ACCOUNT_API, fetcher = fetch, now = Date.now } = {}) {
    Object.assign(this, { token, base, fetcher, now }); this.phones = null; this.phonesAt = 0; this.status = ''; this.busy = null;
  }
  async call(method, pathname, body) {
    const token = this.token(); if (!token) throw Object.assign(new Error(SIGN_IN_FIRST), { code: 'signed_out' });
    let response;
    try {
      response = await this.fetcher(`${typeof this.base === 'function' ? this.base() : this.base}${pathname}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    } catch { throw Object.assign(new Error('Rex Desk could not reach its account service, so the phone notification did not go out.'), { code: 'offline' }); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw Object.assign(new Error(SIGN_IN_FIRST), { code: 'signed_out' });
    if (!response.ok) throw Object.assign(new Error(data.error?.message || `The account service answered ${response.status}.`), { code: data.error?.code || String(response.status) });
    return data;
  }
  // The account's phones, asked at most every 10 minutes (also when there are none), so a notice makes no needless call.
  // forget() makes the next notice ask again, for when a phone is turned on or off here.
  forget() { this.phones = null; this.phonesAt = 0; }
  async list() {
    if (this.phones && this.now() - this.phonesAt < PHONES_MS) return this.phones;
    this.busy ??= this.call('GET', '/v1/push/phones').then(data => {
      const seen = new Set(); this.phones = (data.phones || []).filter(phone => phone?.id && phone.keys && !seen.has(phone.id) && seen.add(phone.id)); this.phonesAt = this.now(); return this.phones;
    }).finally(() => { this.busy = null; });
    return this.busy;
  }
  // Sends one notice to every phone of the account. Never throws and never retries: the result and status say what happened.
  async send({ source, kind = 'reply', title = 'Rex Desk', body = '', target = null, preview = true }) {
    if (!this.token()) { this.status = SIGN_IN_FIRST; return { sent: 0, reason: 'signed_out' }; }
    try {
      const phones = await this.list();
      if (!phones.length) { this.status = ''; return { sent: 0, reason: 'no_phones' }; }
      const tag = noticeTag(source || `${kind}\n${title}\n${body}`);
      const payload = fitPayload({ title: String(title || 'Rex Desk'), body: preview ? String(body || '') : HIDDEN_TEXT, tag, kind, ...(target ? { target } : {}) });
      const plain = JSON.stringify(payload);
      const locked = phones.map(phone => ({ phone: phone.id, body: b64u(encrypt(plain, phone.keys)) }));
      const urgency = kind === 'ask' || kind === 'mention' || kind === 'failed' ? 'high' : 'normal';
      const result = await this.call('POST', '/v1/push/send', { notice: tag, urgency, ttl: 3600, topic: tag, locked });
      if (result.gone?.length) this.phones = this.phones?.filter(phone => !result.gone.includes(phone.id)) || null;
      const sent = result.sent?.length || 0, failed = result.failed?.length || 0;
      this.status = result.repeat || sent || !failed ? '' : 'The phone notification did not reach any phone. Rex Desk will try with the next one.';
      return { sent, gone: result.gone?.length || 0, failed, repeat: Boolean(result.repeat) };
    } catch (error) {
      if (error.code === 'phone_not_found') this.forget();
      this.status = error.code === 'too_many' ? 'Too many phone notifications in a minute; some were held back.' : error.message;
      return { sent: 0, reason: error.code || 'failed' };
    }
  }
}

import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

// Cloud backup with a Rex Desk account: the person signs in once in the browser (Google or GitHub), and the Rex Desk
// service makes their private database and hands this computer its address and a key. Nothing is typed.
// The key stops working after about 30 days, so this computer keeps its sign-in (encrypted) and asks for a fresh key in time.
export const ACCOUNT_API = (process.env.REX_DESK_API || 'https://api.rexdesk.dev').replace(/\/$/, '');
const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Rex Desk</title><body style="font:18px system-ui;padding:40px;background:#16181d;color:#e6e8eb">Signed in. You can close this tab and go back to Rex Desk.</body>';
const BAD_PAGE = '<!doctype html><meta charset="utf-8"><body style="font:18px system-ui;padding:40px">This sign-in is not the one Rex Desk is waiting for. Start it again from Rex Desk.</body>';

async function call(fetcher, base, method, pathname, { token, body } = {}) {
  let response;
  try {
    response = await fetcher(`${base}${pathname}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  } catch { throw new Error('Rex Desk could not reach its account service. Check the internet connection and try again.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `The Rex Desk account service answered ${response.status}.`), { status: response.status, code: data.error?.code || '' });
  return data;
}

// Opens a one-time address on this computer for the browser to come back to. The code it brings is worth nothing without
// the secret made here (the verifier), which never leaves this computer except to trade the code for the sign-in.
export function accountSignIn({ timeoutMs = 270000, base = ACCOUNT_API, fetcher = fetch, provider = '' } = {}) {
  const state = randomBytes(16).toString('hex'), verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let finish, fail; const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; }); result.catch(() => {});
  const server = http.createServer((request, response) => {
    const query = new URL(request.url, 'http://127.0.0.1').searchParams;
    if (query.get('state') !== state || !query.get('code')) { response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(BAD_PAGE); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
    call(fetcher, base, 'POST', '/desktop/exchange', { body: { code: query.get('code'), verifier } }).then(finish, fail);
  });
  const timer = setTimeout(() => fail(new Error('The Rex Desk sign-in took too long. Try again.')), timeoutMs);
  const close = () => { clearTimeout(timer); server.close(); };
  result.then(close, close);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const url = `${base}/desktop/start?${new URLSearchParams({ port: String(server.address().port), state, challenge, ...(['google', 'github'].includes(provider) ? { provider } : {}) })}`;
      // session: { token, expiresAt, user: { id, email, name, image } }
      resolve({ url, session: result, cancel: () => { fail(new Error('The Rex Desk sign-in was cancelled.')); } });
    });
  });
}

// The person's own cloud database: made the first time, and a fresh key every time. { url, authToken, expiresAt, database, created }
export const accountDatabase = (token, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'POST', '/v1/sync/database', { token });
// Who signed in, and whether their cloud database exists yet: { user, plan, sync: { on, since } }. Makes nothing.
// Buying cloud backup from inside the app, with the account's own sign-in: what comes back is an address to open (Stripe's
// payment page or its page to change the card or cancel), or, for a pack, the new space right away.
export const billingCheckout = (token, offer, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'POST', '/v1/billing/checkout', { token, body: { offer } });
export const billingPortal = (token, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'POST', '/v1/billing/portal', { token, body: {} });
export const billingDetails = (token, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'GET', '/v1/billing/details', { token });
export const billingPack = (token, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'POST', '/v1/billing/pack', { token, body: {} });
export const accountMe = (token, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'GET', '/v1/me', { token });
// False only when the account service cannot be reached at all (no internet, or the service is down).
export async function accountReachable({ base = ACCOUNT_API, fetcher = fetch } = {}) {
  try { await fetcher(`${base}/health`, { signal: AbortSignal.timeout(8000) }); return true; } catch { return false; }
}
export const accountSignOut =(token, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'DELETE', '/v1/session', { token });

const SOON = 7 * 86400000, WAIT = 10 * 60000;

// This workspace's Rex Desk account sign-in, kept encrypted beside the database connection.
export class AccountLink {
  constructor(store, { fetcher = fetch, base = ACCOUNT_API } = {}) {
    this.store = store; this.fetcher = fetcher; this.base = base; this.lastTry = 0;
    this.file = path.join(store.directory, 'rexdesk.account');
    if (existsSync(this.file)) { try { this.saved = JSON.parse(store.decrypt(readFileSync(this.file, 'utf8'))); } catch { this.saved = null; } }
  }
  get signedIn() { return Boolean(this.saved?.token); }
  // What the screens may show. Never the sign-in itself.
  summary() { return this.signedIn ? { email: this.saved.user?.email || '', name: this.saved.user?.name || '', url: this.saved.url || '', keyExpiresAt: this.saved.keyExpiresAt || '' } : null; }
  save(session, database) {
    this.saved = { token: session.token, expiresAt: session.expiresAt, user: session.user, url: database.url, keyExpiresAt: database.expiresAt };
    writeFileSync(this.file, this.store.encrypt(JSON.stringify(this.saved)), { mode: 0o600 });
  }
  clear() { this.saved = null; rmSync(this.file, { force: true }); }
  // The account's private file folder on the account service (users/<id>/ in a private bucket). The bytes are already
  // encrypted on this computer; the service only ever stores them.
  async fileCall(method, pathname, body) {
    let response;
    try { response = await this.fetcher(`${this.base}/v1/files${pathname}`, { method, headers: { authorization: `Bearer ${this.saved?.token || ''}`, ...(body ? { 'content-type': 'application/octet-stream' } : {}) }, ...(body ? { body } : {}), signal: AbortSignal.timeout(120000) }); }
    catch { throw new Error('Rex Desk could not reach its account service to back up files.'); }
    if (response.ok) return response;
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { this.clear(); this.ended = 'Your Rex Desk account sign-in ended. Sign in again in Settings to keep cloud backup running.'; }
    throw Object.assign(new Error(data.error?.message || `The Rex Desk account service answered ${response.status}.`), { status: response.status, code: data.error?.code || '' });
  }
  static filePath = key => `/${key.split('/').map(encodeURIComponent).join('/')}`;
  async putFile(key, bytes) { await this.fileCall('PUT', AccountLink.filePath(key), bytes); }
  async getFile(key) { try { return Buffer.from(await (await this.fileCall('GET', AccountLink.filePath(key))).arrayBuffer()); } catch (error) { if (error.status === 404) return null; throw error; } }
  async deleteFile(key) { await this.fileCall('DELETE', AccountLink.filePath(key)); }
  async listFiles() {
    const files = []; let cursor = '';
    do { const page = await (await this.fileCall('GET', cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')).json(); files.push(...page.files); cursor = page.cursor || ''; } while (cursor);
    return files;
  }
  async signOut() {
    const token = this.saved?.token; this.clear();
    if (token) await accountSignOut(token, this).catch(() => {});
  }
  // True when the backup runs on this account's database and its key is about to stop working, or already did.
  // Asked at most once every ten minutes, so a long outage does not turn into a stream of requests.
  due(connection, { failing = false, now = Date.now() } = {}) {
    if (!this.signedIn || !connection || connection.url !== this.saved.url || now - this.lastTry < WAIT) return false;
    return failing || !this.saved.keyExpiresAt || new Date(this.saved.keyExpiresAt).getTime() - now < SOON;
  }
  // A sign-in saved without its database (signing in to the app saves only the account) while this workspace syncs to the
  // account's own database: the database is looked up once and recorded, so files go to and come from the account's folder.
  // Only for a connection that is already there, at most once every ten minutes; a database of the person's own never matches.
  async adoptDatabase(connection, now = Date.now()) {
    if (!this.signedIn || this.saved.url || !connection?.url || now - (this.lastAdopt || 0) < WAIT) return false;
    this.lastAdopt = now;
    // The sign-in this lookup is for: when the account is signed out or switched while it runs, the answer belongs to the
    // old account and is dropped, so a new sign-in never gets the old account's database (and its files never go there).
    const asked = this.saved;
    try {
      const database = await accountDatabase(asked.token, this);
      if (this.saved !== asked || database.url !== connection.url) return false;
      this.saved = { ...this.saved, url: database.url, keyExpiresAt: database.expiresAt };
      writeFileSync(this.file, this.store.encrypt(JSON.stringify(this.saved)), { mode: 0o600 });
      return true;
    } catch { return false; }
  }
  // A fresh key for the same database, or null when it could not be had right now.
  async freshKey(now = Date.now()) {
    this.lastTry = now;
    const asked = this.saved;
    try {
      const database = await accountDatabase(asked.token, this);
      if (this.saved !== asked || database.url !== this.saved.url) return null;
      this.saved.keyExpiresAt = database.expiresAt;
      writeFileSync(this.file, this.store.encrypt(JSON.stringify(this.saved)), { mode: 0o600 });
      return database.authToken;
    } catch (error) {
      // The sign-in itself ended (signed out everywhere, or the account was deleted): stop asking.
      if (error.status === 401 && this.saved === asked) { this.clear(); this.ended = 'Your Rex Desk account sign-in ended. Sign in again in Settings to keep cloud backup running.'; }
      return null;
    }
  }
}

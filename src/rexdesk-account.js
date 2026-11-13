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
export function accountSignIn({ timeoutMs = 270000, base = ACCOUNT_API, fetcher = fetch } = {}) {
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
      const url = `${base}/desktop/start?${new URLSearchParams({ port: String(server.address().port), state, challenge })}`;
      // session: { token, expiresAt, user: { id, email, name, image } }
      resolve({ url, session: result, cancel: () => { fail(new Error('The Rex Desk sign-in was cancelled.')); } });
    });
  });
}

// The person's own cloud database: made the first time, and a fresh key every time. { url, authToken, expiresAt, database, created }
export const accountDatabase = (token, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'POST', '/v1/sync/database', { token });
export const accountSignOut = (token, { base = ACCOUNT_API, fetcher = fetch } = {}) => call(fetcher, base, 'DELETE', '/v1/session', { token });

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
  // A fresh key for the same database, or null when it could not be had right now.
  async freshKey(now = Date.now()) {
    this.lastTry = now;
    try {
      const database = await accountDatabase(this.saved.token, this);
      if (database.url !== this.saved.url) return null;
      this.saved.keyExpiresAt = database.expiresAt;
      writeFileSync(this.file, this.store.encrypt(JSON.stringify(this.saved)), { mode: 0o600 });
      return database.authToken;
    } catch (error) {
      // The sign-in itself ended (signed out everywhere, or the account was deleted): stop asking.
      if (error.status === 401) { this.clear(); this.ended = 'Your Rex Desk account sign-in ended. Sign in again in Settings to keep cloud backup running.'; }
      return null;
    }
  }
}

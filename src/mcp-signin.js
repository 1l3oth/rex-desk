// Rex Desk owns the sign-in of remote MCP servers (L30), the way the MCP authorization spec says: it reads the server's
// protected-resource and authorization-server metadata, registers itself as a public client (dynamic client registration),
// opens the browser with PKCE (S256) and the resource parameter, and catches the answer on a one-time local port. The tokens
// stay encrypted on this computer (never in the cloud copy), are refreshed before they run out, and go only to the exact
// address they were made for, as an Authorization header on the connections Rex Desk itself makes. No agent gets them, and
// no CLI file is touched.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { discoverOAuthServerInfo, extractWWWAuthenticateParams, registerClient, startAuthorization, exchangeAuthorization, refreshAuthorization, selectResourceURL } from '@modelcontextprotocol/sdk/client/auth.js';

const KIND = 'mcpauth';
const EARLY_MS = 10 * 60000, TICK_MS = 60000, WAIT_MS = 5 * 60000, ASK_MS = 30000;
// The server said this sign-in is over (not a network blip): only a new sign-in helps.
const OVER = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
export const SIGN_IN_HELP = 'Needs sign-in. Ask the person to press Sign in for it in Rex Desk, Settings, Connectors. Rex Desk does the whole sign-in: never tell them to use a terminal, /mcp or a config file.';

// What the person reads when a sign-in fails: always Rex Desk's own words. What the server wrote can hold sensitive values
// (tokens, codes, addresses with keys), so only its OAuth error code picks the message (RFC 6749, RFC 7591).
const FAILED = 'The sign-in failed. Try again.';
const BY_CODE = {
  access_denied: 'The sign-in was refused. Try again and allow Rex Desk.',
  invalid_grant: 'The sign-in was no longer valid. Try again.',
  invalid_client: 'The server did not accept Rex Desk as an app. Try again.',
  unauthorized_client: 'The server does not let Rex Desk sign in this way.',
  invalid_client_metadata: 'The server did not let Rex Desk register to sign in.',
  invalid_redirect_uri: 'The server did not accept the address Rex Desk uses to finish the sign-in.',
  invalid_scope: 'The server refused the access Rex Desk asked for.',
  invalid_request: 'The server did not accept the sign-in request.',
  invalid_target: 'The server did not accept the sign-in request.',
  unsupported_grant_type: 'The server does not offer this kind of sign-in.',
  unsupported_response_type: 'The server does not offer this kind of sign-in.',
  server_error: 'The sign-in server had a problem. Try again later.',
  temporarily_unavailable: 'The sign-in server is busy. Try again later.',
};
// A message Rex Desk wrote itself, so it may be shown as it is.
class Plain extends Error {}
export const signInError = error => {
  if (error instanceof Plain) return error.message;
  const code = String(error?.errorCode || error?.constructor?.errorCode || '');
  return Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : FAILED;
};
export const addressOf = config => {
  if (!config?.url) return '';
  try { const url = new URL(String(config.url)); url.hash = ''; return url.href; } catch { return ''; }
};
const idOf = url => createHash('sha256').update(url).digest('hex').slice(0, 24);
const local = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
// Only https; plain http only to this computer, and only when the owner allowed it (tests and local servers under test).
function safeAddress(value, what, loopback = false) {
  let url; try { url = new URL(String(value)); } catch { throw new Plain(`The ${what} is not a valid address, so Rex Desk does not sign in there.`); }
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:' && local(url))) throw new Plain(`The ${what} is not a secure address, so Rex Desk does not sign in there.`);
  return url;
}
// An address that carries a credential of its own (a user and password, or a key or token in the query) is the person's
// typed key, not something to sign in to: such an address is refused, so this flow never sends it around or keeps it.
const CARRIES = /auth|token|key|secret|passw|credential|sig|code/i;
export const carriesCredential = url => Boolean(url.username || url.password || [...url.searchParams.keys()].some(name => CARRIES.test(name)));
export const MOVED_SIGN_IN = 'The sign-in server tried to send Rex Desk to another address, so Rex Desk stopped there to keep your sign-in safe.';
// The fetch for a request that carries a code, a PKCE verifier, a refresh token or a registration: only to the one address
// found at sign-in, over https, never following a redirect, and never waiting long.
function pinnedTo(address, what, { fetcher, loopback, ms = ASK_MS }) {
  const home = safeAddress(address, what, loopback); home.hash = '';
  if (carriesCredential(home)) throw new Plain(`The ${what} has a key or password in it, so Rex Desk does not sign in there.`);
  return async (target, init = {}) => {
    const to = new URL(String(target)); to.hash = '';
    if (to.href !== home.href) throw new Plain(MOVED_SIGN_IN);
    const limit = AbortSignal.timeout(ms), signal = init.signal ? AbortSignal.any([init.signal, limit]) : limit;
    const response = await fetcher(to.href, { ...init, redirect: 'manual', signal });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) { await response.body?.cancel?.().catch(() => {}); throw new Plain(MOVED_SIGN_IN); }
    return response;
  };
}
// Discovery sends no secret, but each request it makes is bounded too.
const timed = (fetcher, ms = ASK_MS) => (target, init = {}) => fetcher(target, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });
const page = text => `<!doctype html><meta charset="utf-8"><title>Rex Desk</title><body style="font:18px system-ui;padding:40px">${text}</body>`;

export class McpSignIn {
  constructor(store, { fetcher = fetch, changed = () => {}, loopback = false, askMs = ASK_MS } = {}) {
    this.store = store; this.fetcher = fetcher; this.changed = changed; this.loopback = loopback; this.ms = askMs; this.waiting = new Map(); this.refreshing = new Map(); this.timer = null;
  }
  record(url) { return url ? this.store.get(KIND, idOf(url)) || null : null; }
  secret(record) { try { return JSON.parse(this.store.decrypt(record.sealed)); } catch { return null; } }
  save(url, name, secret, status = 'connected') {
    const id = idOf(url);
    this.store.put(KIND, id, { id, url, name, status, expiresAt: secret.expiresAt || 0, sealed: this.store.encrypt(JSON.stringify(secret)), at: new Date().toISOString() });
  }
  expire(record) {
    const now = this.store.get(KIND, record.id); if (!now || now.status === 'expired') return;
    this.store.put(KIND, record.id, { ...now, status: 'expired', at: new Date().toISOString() }); this.changed(now.url);
  }
  // Every secret held for a server's address, so it can be taken out of whatever that server sends back.
  secrets(config) { const record = this.record(addressOf(config)), held = record && this.secret(record); return held ? [held.accessToken, held.refreshToken, held.client?.client_secret, held.client?.registration_access_token].filter(Boolean) : []; }
  // What the pages show: no token and no address, ever.
  state(url) {
    const record = this.record(url);
    return { state: record?.status || '', waiting: this.waiting.has(url), link: this.waiting.get(url)?.link || '', error: this.waiting.get(url)?.error || '' };
  }
  expired() { return this.store.list(KIND).filter(record => record.status === 'expired').map(({ id, name, at }) => ({ id, name, at })); }

  // ---- signing in ----
  async discover(url) {
    // The server's 401 may name where its metadata is; without that the well-known addresses are tried (the SDK does both).
    let challenge = {};
    try {
      const response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), signal: AbortSignal.timeout(15000), redirect: 'manual' });
      challenge = extractWWWAuthenticateParams(response); await response.body?.cancel?.().catch(() => {});
    } catch { /* discovery below reports a server that cannot be reached */ }
    const info = await discoverOAuthServerInfo(url, { resourceMetadataUrl: challenge.resourceMetadataUrl, fetchFn: timed(this.fetcher, this.ms) });
    const metadata = info.authorizationServerMetadata;
    if (!metadata) throw new Plain('This server does not say how to sign in to it.');
    // Every address the server named is checked like the one the person added: secure, and with no key or password in it.
    this.endpoint(info.authorizationServerUrl, 'sign-in server');
    for (const [key, what] of [['authorization_endpoint', 'sign-in page'], ['token_endpoint', 'token address']]) this.endpoint(metadata[key], what);
    if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Plain('This server does not offer the safe sign-in (PKCE) that MCP requires.');
    if (!metadata.registration_endpoint) throw new Plain('This server lets only apps it approved sign in, so Rex Desk cannot sign in to it yet.');
    this.endpoint(metadata.registration_endpoint, 'registration address');
    const resource = await selectResourceURL(url, {}, info.resourceMetadata);
    if (resource) this.endpoint(info.resourceMetadata.resource, 'server address');
    return { server: info.authorizationServerUrl, metadata, resource: resource ? String(info.resourceMetadata.resource) : url, scope: challenge.scope || info.resourceMetadata?.scopes_supported?.join(' ') || undefined };
  }
  // Starts a sign-in and gives back the page to open. done resolves when the browser came back and the tokens are saved.
  async start(name, address) {
    const url = addressOf({ url: address }); if (!url) throw new Plain('This server has no web address to sign in to.');
    const couldNot = error => new Error(error instanceof Plain ? error.message : `Rex Desk could not start the sign-in. ${signInError(error)}`);
    let found;
    try {
      if (carriesCredential(safeAddress(url, 'server address', this.loopback))) throw new Plain('This address has a key or password in it, so Rex Desk does not sign in there.');
      this.cancel(url); found = await this.discover(url);
    } catch (error) { throw couldNot(error); }
    const state = randomBytes(24).toString('base64url');
    let answer, fail; const code = new Promise((resolve, reject) => { answer = resolve; fail = reject; });
    // Handled from the start: a failure before anyone waits on it is never left unhandled.
    code.catch(() => {});
    const listener = http.createServer((request, response) => {
      const say = (status, text) => response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(page(text));
      // A request whose address cannot be read is answered and ignored; the sign-in keeps waiting for the real one.
      let asked; try { asked = new URL(request.url, 'http://127.0.0.1'); } catch { return say(400, 'This is not the sign-in Rex Desk is waiting for. Start it again from Rex Desk.'); }
      if (asked.pathname !== '/callback') return say(404, 'Nothing here.');
      const issuer = asked.searchParams.get('iss');
      if (asked.searchParams.get('state') !== state || (issuer && issuer !== found.metadata.issuer)) return say(400, 'This is not the sign-in Rex Desk is waiting for. Start it again from Rex Desk.');
      if (!asked.searchParams.get('code')) { say(400, 'The sign-in did not finish. You can close this tab and try again from Rex Desk.'); fail(Object.assign(new Error('refused'), { errorCode: asked.searchParams.get('error') || '' })); return; }
      say(200, 'Signed in. You can close this tab and go back to Rex Desk.');
      answer(asked.searchParams.get('code'));
    });
    listener.on('clientError', (error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n'); else socket.destroy(); });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`;
    let timer = null; const close = () => { clearTimeout(timer); listener.close(); };
    try {
      // Registration is bounded by its own fetch (pinnedTo); the wait for the browser starts once the answer is waited on.
      const client = await registerClient(found.server, { metadata: found.metadata, scope: found.scope, fetchFn: this.pinned(found.metadata.registration_endpoint, 'registration address'),
        clientMetadata: { client_name: 'Rex Desk', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
      const { authorizationUrl, codeVerifier } = await startAuthorization(found.server, { metadata: found.metadata, clientInformation: client, redirectUrl: redirectUri, scope: found.scope, state, resource: found.resource });
      // The page handed to the screen is the checked sign-in page with Rex Desk's own sign-in values added, nothing else.
      const opened = new URL(authorizationUrl), home = this.endpoint(found.metadata.authorization_endpoint, 'sign-in page');
      if (opened.origin !== home.origin || opened.pathname !== home.pathname) throw new Plain('The sign-in page this server named does not match, so Rex Desk stopped.');
      const attempt = { link: authorizationUrl.toString(), error: '', cancel: () => fail(new Plain('The sign-in was cancelled.')) };
      this.waiting.set(url, attempt);
      attempt.done = code.then(async value => {
        const tokens = await exchangeAuthorization(found.server, { metadata: found.metadata, clientInformation: client, authorizationCode: value, codeVerifier, redirectUri, resource: found.resource, fetchFn: this.pinned(found.metadata.token_endpoint, 'token address') });
        if (this.waiting.get(url) !== attempt) return;
        this.save(url, name, this.kept({ server: found.server, metadata: found.metadata, resource: found.resource, client }, tokens));
        this.waiting.delete(url); this.changed(url);
      }).catch(error => {
        if (this.waiting.get(url) !== attempt) return;
        // The reason stays on the row until the next try, in Rex Desk's own words.
        this.waiting.set(url, { error: signInError(error), link: '', cancel: () => {}, failed: true }); this.changed(url);
      }).finally(close);
      timer = setTimeout(() => fail(new Plain('The sign-in took too long. Try again.')), WAIT_MS); timer.unref?.();
      return { url: attempt.link, done: attempt.done };
    } catch (error) { close(); throw couldNot(error); }
  }
  // A discovered address: secure, and with no credential of its own, so nothing the server named carries one onward.
  endpoint(value, what) { const url = safeAddress(value, what, this.loopback); if (carriesCredential(url)) throw new Plain(`The ${what} this server named has a key or password in it, so Rex Desk does not sign in there.`); return url; }
  pinned(address, what) { return pinnedTo(address, what, { fetcher: this.fetcher, loopback: this.loopback, ms: this.ms }); }
  cancel(url) { const attempt = this.waiting.get(url); if (!attempt) return; this.waiting.delete(url); attempt.cancel(); }
  signOut(url) { this.cancel(url); const record = this.record(url); if (record) { this.store.delete(KIND, record.id); this.changed(url); } }
  kept(base, tokens, before = {}) {
    return { ...base, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || before.refreshToken || '', expiresAt: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : 0 };
  }

  // ---- keeping it alive ----
  // One refresh at a time for a server: the refresh token is replaced each time, so two at once would lose the sign-in.
  refresh(url) {
    let running = this.refreshing.get(url);
    if (!running) { running = this.renew(url).finally(() => this.refreshing.delete(url)); this.refreshing.set(url, running); }
    return running;
  }
  async renew(url) {
    const record = this.record(url), secret = record && this.secret(record);
    if (!secret || record.status === 'expired') return false;
    if (!secret.refreshToken) { if (secret.expiresAt && secret.expiresAt <= Date.now()) this.expire(record); return false; }
    try {
      const tokens = await refreshAuthorization(secret.server, { metadata: secret.metadata, clientInformation: secret.client, refreshToken: secret.refreshToken, resource: secret.resource, fetchFn: this.pinned(secret.metadata?.token_endpoint, 'token address') });
      // Signed out or signed in again while this ran: the old answer is dropped.
      if (this.store.get(KIND, record.id)?.sealed !== record.sealed) return false;
      this.save(url, record.name, this.kept(secret, tokens, secret));
      return true;
    } catch (error) {
      if (OVER.has(error?.errorCode || error?.constructor?.errorCode) && this.store.get(KIND, record.id)?.sealed === record.sealed) this.expire(record);
      return false;
    }
  }
  async tick() {
    await Promise.all(this.store.list(KIND).filter(record => record.status === 'connected' && record.expiresAt && record.expiresAt - Date.now() < EARLY_MS).map(record => this.refresh(record.url)));
  }
  startTimer() { if (this.timer) return; this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS); this.timer.unref?.(); void this.tick().catch(() => {}); }
  stop() { clearInterval(this.timer); this.timer = null; for (const url of [...this.waiting.keys()]) this.cancel(url); }

  // A server's config with this computer's sign-in on it. Only the exact address the sign-in was made for gets the token.
  async authorize(config) {
    const url = addressOf(config); let record = this.record(url);
    if (!record || record.status === 'expired') return config;
    if (record.expiresAt && record.expiresAt - Date.now() < EARLY_MS) { await this.refresh(url); record = this.record(url); }
    const secret = record && record.status === 'connected' && this.secret(record);
    if (!secret) return config;
    const headers = Object.fromEntries(Object.entries(config.headers || {}).filter(([key]) => key.toLowerCase() !== 'authorization'));
    return { ...config, type: config.type || 'http', headers: { ...headers, Authorization: `Bearer ${secret.accessToken}` } };
  }
  // Refused even with a renewed token: this sign-in is over, so the person is asked to sign in again.
  rejected(config) { const record = this.record(addressOf(config)); if (record) this.expire(record); }
  // The server refused the token: try a fresh one. True when it is worth trying the server again.
  async refused(config) {
    const url = addressOf(config), record = this.record(url);
    if (!record || record.status === 'expired') return false;
    const renewed = await this.refresh(url);
    if (!renewed && !this.secret(record)?.refreshToken) this.expire(record);
    return renewed;
  }
}

// Rex Desk owns the sign-in of remote MCP servers (L30), the way the MCP authorization spec says: it reads the server's
// protected-resource and authorization-server metadata, registers itself as a public client (dynamic client registration),
// opens the browser with PKCE (S256) and the resource parameter, and catches the answer on a one-time local port. The tokens
// stay encrypted on this computer (never in the cloud copy), are refreshed before they run out, and go only to the exact
// address they were made for, as an Authorization header on the connections Rex Desk makes for agents. No CLI file is touched.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { discoverOAuthServerInfo, extractWWWAuthenticateParams, registerClient, startAuthorization, exchangeAuthorization, refreshAuthorization, selectResourceURL } from '@modelcontextprotocol/sdk/client/auth.js';

const KIND = 'mcpauth';
const EARLY_MS = 10 * 60000, TICK_MS = 60000, WAIT_MS = 5 * 60000;
// The server said this sign-in is over (not a network blip): only a new sign-in helps.
const OVER = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
export const SIGN_IN_HELP = 'Needs sign-in. Ask the person to press Sign in for it in Rex Desk, Settings, Connectors. Rex Desk does the whole sign-in: never tell them to use a terminal, /mcp or a config file.';

export const addressOf = config => {
  if (!config?.url) return '';
  try { const url = new URL(String(config.url)); url.hash = ''; return url.href; } catch { return ''; }
};
const idOf = url => createHash('sha256').update(url).digest('hex').slice(0, 24);
const local = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
function safeAddress(value, what) {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local(url))) throw new Error(`The ${what} is not a secure address, so Rex Desk does not sign in there.`);
  return url;
}
const page = text => `<!doctype html><meta charset="utf-8"><title>Rex Desk</title><body style="font:18px system-ui;padding:40px">${text}</body>`;

export class McpSignIn {
  constructor(store, { fetcher = fetch, changed = () => {} } = {}) {
    this.store = store; this.fetcher = fetcher; this.changed = changed; this.waiting = new Map(); this.refreshing = new Map(); this.timer = null;
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
  // What the pages show: no token, ever.
  state(url) {
    const record = this.record(url);
    return { state: record?.status || '', waiting: this.waiting.has(url), link: this.waiting.get(url)?.link || '', error: this.waiting.get(url)?.error || '' };
  }
  expired() { return this.store.list(KIND).filter(record => record.status === 'expired').map(({ id, name, url, at }) => ({ id, name, url, at })); }

  // ---- signing in ----
  async discover(url) {
    // The server's 401 may name where its metadata is; without that the well-known addresses are tried (the SDK does both).
    let challenge = {};
    try {
      const response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), signal: AbortSignal.timeout(15000) });
      challenge = extractWWWAuthenticateParams(response); await response.body?.cancel?.().catch(() => {});
    } catch { /* discovery below reports a server that cannot be reached */ }
    const info = await discoverOAuthServerInfo(url, { resourceMetadataUrl: challenge.resourceMetadataUrl, fetchFn: this.fetcher });
    const metadata = info.authorizationServerMetadata;
    if (!metadata) throw new Error('This server does not say how to sign in to it.');
    for (const [key, what] of [['authorization_endpoint', 'sign-in page'], ['token_endpoint', 'token address']]) safeAddress(metadata[key], what);
    if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('This server does not offer the safe sign-in (PKCE) that MCP requires.');
    if (!metadata.registration_endpoint) throw new Error('This server lets only apps it approved sign in, so Rex Desk cannot sign in to it yet.');
    safeAddress(metadata.registration_endpoint, 'registration address');
    const resource = await selectResourceURL(url, {}, info.resourceMetadata);
    return { server: info.authorizationServerUrl, metadata, resource: resource ? String(info.resourceMetadata.resource) : url, scope: challenge.scope || info.resourceMetadata?.scopes_supported?.join(' ') || undefined };
  }
  // Starts a sign-in and gives back the page to open. done resolves when the browser came back and the tokens are saved.
  async start(name, address) {
    const url = addressOf({ url: address }); if (!url) throw new Error('This server has no web address to sign in to.');
    safeAddress(url, 'server address');
    this.cancel(url);
    const found = await this.discover(url);
    const state = randomBytes(24).toString('base64url');
    let answer, fail; const code = new Promise((resolve, reject) => { answer = resolve; fail = reject; });
    const listener = http.createServer((request, response) => {
      const asked = new URL(request.url, 'http://127.0.0.1');
      const say = (status, text) => response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(page(text));
      if (asked.pathname !== '/callback') return say(404, 'Nothing here.');
      const issuer = asked.searchParams.get('iss');
      if (asked.searchParams.get('state') !== state || (issuer && issuer !== found.metadata.issuer)) return say(400, 'This is not the sign-in Rex Desk is waiting for. Start it again from Rex Desk.');
      if (!asked.searchParams.get('code')) { say(400, 'The sign-in did not finish. You can close this tab and try again from Rex Desk.'); fail(new Error('The sign-in was refused or did not finish. Try again.')); return; }
      say(200, 'Signed in. You can close this tab and go back to Rex Desk.');
      answer(asked.searchParams.get('code'));
    });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`;
    const timer = setTimeout(() => fail(new Error('The sign-in took too long. Try again.')), WAIT_MS); timer.unref?.();
    const close = () => { clearTimeout(timer); listener.close(); };
    try {
      const client = await registerClient(found.server, { metadata: found.metadata, scope: found.scope, fetchFn: this.fetcher,
        clientMetadata: { client_name: 'Rex Desk', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
      const { authorizationUrl, codeVerifier } = await startAuthorization(found.server, { metadata: found.metadata, clientInformation: client, redirectUrl: redirectUri, scope: found.scope, state, resource: found.resource });
      const attempt = { link: authorizationUrl.toString(), error: '', cancel: () => fail(new Error('The sign-in was cancelled.')) };
      this.waiting.set(url, attempt);
      attempt.done = code.then(async value => {
        const tokens = await exchangeAuthorization(found.server, { metadata: found.metadata, clientInformation: client, authorizationCode: value, codeVerifier, redirectUri, resource: found.resource, fetchFn: this.fetcher });
        if (this.waiting.get(url) !== attempt) return;
        this.save(url, name, this.kept({ server: found.server, metadata: found.metadata, resource: found.resource, client }, tokens));
        this.waiting.delete(url); this.changed(url);
      }).catch(error => {
        if (this.waiting.get(url) !== attempt) return;
        // The reason stays on the row until the next try; nothing the server sent with a token is in it.
        this.waiting.set(url, { error: String(error?.message || 'The sign-in failed.').slice(0, 200), link: '', cancel: () => {}, failed: true }); this.changed(url);
      }).finally(close);
      return { url: attempt.link, done: attempt.done };
    } catch (error) { close(); throw new Error(`Rex Desk could not start the sign-in: ${String(error?.message || error).slice(0, 200)}`); }
  }
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
      const tokens = await refreshAuthorization(secret.server, { metadata: secret.metadata, clientInformation: secret.client, refreshToken: secret.refreshToken, resource: secret.resource, fetchFn: this.fetcher });
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
  async authorizeAll(servers) { return Object.fromEntries(await Promise.all(Object.entries(servers).map(async ([name, config]) => [name, await this.authorize(config)]))); }
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

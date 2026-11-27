// The connector catalog (public/connectors/catalog.json) and the check that runs before anything is saved.
// Each item's `connect` says how the vendor's own docs connect it (remote MCP, local command, token, webhook). That is a
// hint for the page; probe() decides: it really connects, and only a passing probe is saved. A failed probe saves nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connectServer, plainError } from './toolbox.js';
import { assertBotFree, botIdOf } from './bot-use.js';
import { KEY_FLOOR, KEY_TOO_SHORT } from './mcp-guard.js';
import { addressOf, preRegisteredOAuthClient } from './mcp-signin.js';

// A field that holds a secret, so a value too short to tell from ordinary text is refused (L30). An address, a folder or a
// webhook is not a key, so it is never length-checked.
const SECRET_FIELD = /key|token|secret|passw/i;

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'connectors', 'catalog.json');
let cached = null;
// An item marked "hidden" is left out everywhere (picker, Market, check and save) until it can really connect.
export function loadCatalog(file = FILE) { if (!cached || file !== FILE) { const raw = JSON.parse(readFileSync(file, 'utf8')), data = { ...raw, items: (raw.items || []).filter(item => !item.hidden) }; if (file !== FILE) return data; cached = data; } return cached; }
export const catalogItem = (id, catalog = loadCatalog()) => catalog.items.find(item => item.id === id) || null;
export function catalogItemByUrl(url, catalog = loadCatalog()) {
  const target = addressOf({ url }).replace(/\/$/, '');
  if (!target) return null;
  return catalog.items.find(item => item.connect?.kind === 'remote-mcp' && addressOf({ url: item.connect.url }).replace(/\/$/, '') === target) || null;
}

const FIELD = /^[a-zA-Z]+\??$/;
const optional = name => name.endsWith('?');
const bare = name => name.replace(/\?$/, '');
// The values the person typed, only the fields this item has, trimmed. A missing required field is an error before any call.
export function readValues(item, input = {}) {
  const values = {};
  for (const name of item.connect.fields || []) {
    if (!FIELD.test(name)) continue;
    const key = bare(name), value = String(input[key] ?? '').trim();
    if (!value && !optional(name) && key !== 'host') throw new Error(`Fill in ${LABELS[key] || key}.`);
    if (value && SECRET_FIELD.test(key) && value.length < KEY_FLOOR) throw new Error(KEY_TOO_SHORT);
    values[key] = value;
  }
  return values;
}
export const LABELS = { apiKey: 'the API key', token: 'the token', botToken: 'the bot token', webhookUrl: 'the webhook address', folder: 'the folder', host: 'the address' };
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
// A token never shows up in an error the page gets back.
const scrub = (text, values) => Object.values(values).filter(value => value && value.length > 5).reduce((out, value) => out.split(value).join('***'), String(text || ''));

// The MCP server config Claude Code and the toolbox use for this item, or null when it is not an MCP server.
export function serverConfig(item, values = {}) {
  const connect = item.connect;
  if (connect.kind === 'local-mcp') {
    const env = Object.fromEntries(Object.entries(connect.env || {}).map(([key, value]) => [key, fill(value, values)]));
    return { command: connect.command, args: (connect.args || []).map(arg => fill(arg, values)), ...(Object.keys(env).length ? { env } : {}) };
  }
  if (connect.kind !== 'remote-mcp') return null;
  let url = connect.url;
  if (values.host) { const host = values.host.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new Error('The address is a host name, like gitlab.example.com.'); url = url.replace(/^https:\/\/[^/]+/, `https://${host}`); }
  return { type: 'http', url, ...(values.token ? { headers: { Authorization: `Bearer ${values.token}` } } : {}) };
}

// Does the server support OAuth (with dynamic client registration or a pre-registered OAuth client)? Read from its metadata.
async function signInWay(url, fetcher) {
  const target = new URL(url), get = async address => { const response = await fetcher(address, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }); return response.ok ? response.json() : null; };
  const resource = await get(`${target.origin}/.well-known/oauth-protected-resource${target.pathname.replace(/\/$/, '')}`).catch(() => null) || await get(`${target.origin}/.well-known/oauth-protected-resource`).catch(() => null);
  const issuer = resource?.authorization_servers?.[0] || target.origin;
  const issuerUrl = new URL(issuer), issuerPath = issuerUrl.pathname.replace(/\/$/, '');
  const metaUrls = issuerPath
    ? [
        `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
        `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
        `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
        `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
        `${issuerUrl.origin}/.well-known/openid-configuration`,
      ]
    : [
        `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
        `${issuerUrl.origin}/.well-known/openid-configuration`,
      ];
  let meta = null;
  for (const address of metaUrls) { meta = await get(address).catch(() => null); if (meta?.authorization_endpoint) break; }
  return { oauth: Boolean(meta?.authorization_endpoint), register: Boolean(meta?.registration_endpoint), issuer: meta?.issuer || issuer };
}

const result = (ok, method, extra = {}) => ({ ok, method, needs: '', tools: null, error: '', ...extra });

async function probeOAuth(item, config, { fetcher, env, oauthClients, tools = null }) {
  const way = await signInWay(config.url, fetcher).catch(() => ({ oauth: false, register: false, issuer: '' }));
  const extra = tools !== null ? { tools } : {};
  if (way.oauth && way.register) return result(true, 'oauth', { needs: 'sign-in', ...extra });
  if (way.oauth) {
    const pre = preRegisteredOAuthClient({ provider: item.connect.oauth?.provider, issuer: way.issuer, url: config.url, env, oauthClients });
    if (pre?.client) return result(true, 'oauth', { needs: 'sign-in', ...extra });
    if (pre?.provider) return result(false, 'oauth', { error: pre.provider.missingMessage(item.name) });
    return result(false, 'oauth', { error: `${item.name} lets only apps it approved sign in, so Rex Desk cannot connect it yet.` });
  }
  return result(false, 'oauth', { error: `${item.name} asked for a sign-in Rex Desk could not find.` });
}

// Connect for real and say what happened: { ok, method, needs, tools, error }. Nothing is written anywhere.
export async function probe(item, input = {}, { connect = connectServer, fetcher = fetch, env = process.env, oauthClients = {} } = {}) {
  if (!item) return result(false, '', { error: 'Rex Desk does not know that app.' });
  if (item.phase !== 1) return result(false, '', { error: item.note || 'Not ready to connect yet.' });
  let values; try { values = readValues(item, input); } catch (error) { return result(false, '', { error: error.message }); }
  const { kind } = item.connect;
  try {
    if (kind === 'remote-mcp' || kind === 'local-mcp') {
      const config = serverConfig(item, values);
      try {
        const client = await connect(item.id, config);
        try {
          const { tools = [] } = await client.listTools();
          // Some OAuth MCP servers (such as Google Drive) return HTTP 200 on tools/list without auth and require OAuth on tools/call.
          if (kind === 'remote-mcp' && item.connect.auth === 'oauth' && !values.token) {
            return await probeOAuth(item, config, { fetcher, env, oauthClients, tools: tools.length });
          }
          return result(true, kind, { tools: tools.length });
        } finally { await client.close?.().catch(() => {}); }
      } catch (error) {
        const message = String(error?.message || error);
        // No token and the server asks for a sign-in: fine when the server lets a new app register or has a pre-registered OAuth client.
        if (kind === 'remote-mcp' && !values.token && (Number(error?.code) === 401 || /401|unauthori[sz]ed|unauthenticated|invalid_token|authenticat/i.test(message))) {
          return await probeOAuth(item, config, { fetcher, env, oauthClients });
        }
        if (Number(error?.code) === 401 || Number(error?.code) === 403) return result(false, kind, { error: values.token ? `${item.name} did not take that token.` : `${item.name} wants a sign-in Rex Desk could not make.` });
        if (Number(error?.code) >= 400) return result(false, kind, { error: `${item.name} answered with error ${error.code}.` });
        throw error;
      }
    }
    if (kind === 'webhook') {
      if (!/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(values.webhookUrl)) return result(false, kind, { error: 'Paste the whole webhook address. It starts with https://discord.com/api/webhooks/.' });
      const response = await fetcher(values.webhookUrl, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return result(false, kind, { error: response.status === 401 || response.status === 404 ? 'Discord does not know that webhook. Copy it again from the channel settings.' : `Discord answered ${response.status}.` });
      const hook = await response.json().catch(() => ({}));
      return result(true, kind, { label: hook.name || '' });
    }
    if (kind === 'token' && item.id === 'telegram') {
      const response = await fetcher(`https://api.telegram.org/bot${encodeURIComponent(values.botToken)}/getMe`, { signal: AbortSignal.timeout(10000) });
      const data = await response.json().catch(() => ({}));
      return data.ok ? result(true, kind, { label: data.result?.username ? `@${data.result.username}` : '' }) : result(false, kind, { error: 'Telegram does not know that bot token. Copy it again from @BotFather.' });
    }
    if (kind === 'token' && item.id === 'trello') {
      const response = await fetcher(`https://api.trello.com/1/members/me?fields=username&key=${encodeURIComponent(values.apiKey)}&token=${encodeURIComponent(values.token)}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return result(false, kind, { error: 'Trello did not take that key and token. Make the token with the same key.' });
      const data = await response.json().catch(() => ({}));
      return result(true, kind, { label: data.username || '' });
    }
    return result(false, kind, { error: `${item.name} connects in its own place in Settings.` });
  } catch (error) {
    return result(false, kind, { error: scrub(plainError(error?.message || error), values) || 'It did not answer.' });
  }
}

// What Rex Desk saves after a passing probe. MCP items go to Claude Code's own list (user scope), so every agent and the
// toolbox see them; token and webhook items are kept here, the secret encrypted. Returns the saved connection.
export async function saveConnector(item, input, { toolbox, store, probed }) {
  if (!probed?.ok) throw new Error(probed?.error || 'Check it first.');
  const values = readValues(item, input), config = serverConfig(item, values);
  if (config) {
    await toolbox.cli(['mcp', 'add-json', '--scope', 'user', item.id, JSON.stringify(config)]).catch(error => { throw new Error(scrub(error.message, values)); });
    toolbox.lists.delete(item.id); toolbox.failed.delete(item.id); await toolbox.close(item.id);
    return { id: item.id, connectorId: item.id, name: item.name, kind: probed.method, server: item.id };
  }
  // The personal Telegram bot may not be the bug report bot or an agent's own bot (bot-use.js).
  if (item.id === 'telegram') assertBotFree(store, botIdOf(values.botToken), { connectorId: 'telegram' });
  const id = `${item.id}-${Date.now().toString(36)}`, label = probed.label || '';
  store.put('secret', `connector:${id}`, store.encrypt(JSON.stringify(values)));
  const saved = { id, connectorId: item.id, name: label ? `${item.name} ${label}` : item.name, kind: probed.method, at: new Date().toISOString() };
  store.put('connector', id, saved);
  return saved;
}

// The connections the catalog added: MCP servers found in Claude Code's list under a catalog id, and saved token links.
export function catalogConnections({ toolbox, store }, catalog = loadCatalog()) {
  let servers = {}; try { servers = toolbox.servers(); } catch { /* no config */ }
  const mcp = catalog.items.filter(item => item.tier === 'mcp' && servers[item.id]).map(item => ({ id: item.id, connectorId: item.id, name: item.name, kind: 'mcp', server: item.id, error: toolbox.shownError?.(item.id) ?? (toolbox.failed.get(item.id)?.error || '') }));
  const links = (store.list('connector') || []).map(({ id, connectorId, name, kind }) => {
    const link = { id, connectorId, name, kind };
    // Telegram carries whether a chat is linked yet and that chat's display name, so the card can show "Linked to <name>".
    // The chat id itself stays in the encrypted secret and is never exposed. pairCode: the one-time code to send to the bot, while one is waiting.
    if (connectorId === 'telegram') { const secret = store.get('secret', `connector:${id}`); if (secret) { try { const values = JSON.parse(store.decrypt(secret)); link.linked = Boolean(values.chatId); link.linkedName = values.chatName || ''; link.pairCode = values.pairCode && Number(values.pairUntil) > Date.now() ? values.pairCode : ''; } catch { /* ignore */ } } }
    return link;
  });
  return [...mcp, ...links];
}
export async function removeCatalogConnection(id, { toolbox, store }) {
  if (store.get('connector', id)) { store.delete('connector', id); store.delete('secret', `connector:${id}`); return { removed: id }; }
  if (catalogItem(id)) return toolbox.removeServer(id);
  throw new Error('That connection is gone.');
}

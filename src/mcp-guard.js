// What keeps a sign-in where it belongs (L30): a request that carries one goes to the registered address only, and nothing
// that comes back may show it again.

export const MOVED = 'The server tried to send Rex Desk to another address, so Rex Desk stopped there to keep your sign-in safe.';

// The fetch both MCP transports are given when a request carries headers of its own. The MCP SDK follows redirects within
// an origin by itself, so every redirect is stopped here, and so is any other address. One exception, which is how the
// older SSE transport works: messages are posted to the address the server announces on its stream, on the same origin.
export function pinnedFetch(address, { sse = false, fetcher = fetch } = {}) {
  const home = new URL(address); home.hash = '';
  return async (target, init = {}) => {
    const to = new URL(target); to.hash = '';
    const announced = sse && String(init.method || 'GET').toUpperCase() === 'POST' && to.origin === home.origin;
    if (to.href !== home.href && !announced) throw new Error(MOVED);
    const response = await fetcher(target, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new Error(MOVED); }
    return response;
  };
}

// Every credential in a server's headers, without its scheme word (an answer may repeat it with or without). Any length.
const CREDENTIAL = /auth|cookie|token|key|secret|passw|credential/i;
export function headerSecrets(config) {
  return Object.entries(config?.headers || {}).filter(([name]) => CREDENTIAL.test(name)).flatMap(([name, text]) => {
    const value = String(text).trim(), bare = value.replace(/^(bearer|basic|token|apikey)(\s+|$)/i, '');
    const parts = /cookie/i.test(name) ? value.split(';').map(part => part.slice(part.indexOf('=') + 1).trim()) : [];
    return [bare, ...parts].filter(Boolean);
  });
}

// An answer that would show a sign-in where it cannot be taken out without breaking the MCP message (a field name, a type,
// an address, a number): Rex Desk holds the whole answer back instead.
export const UNSAFE = 'The server sent back an answer that could show your sign-in, so Rex Desk held it back.';
export class Unsafe extends Error { constructor() { super(UNSAFE); this.own = true; } }
// Fields the MCP protocol reads (types, names, addresses, cursors): their values are never changed, only checked.
const STRUCTURE = new Set(['type', 'mimeType', 'role', 'uri', 'uriTemplate', 'name', 'method', 'jsonrpc', 'id', 'nextCursor', 'cursor', 'progressToken', 'protocolVersion']);
const WITHHELD = '[Rex Desk held this file back: it could show your sign-in.]';
const BASE64 = /[A-Za-z0-9+/_-]{8,}={0,2}/g;

// Takes secrets out of a decoded MCP answer and keeps its structure: free text has them replaced, a protocol field, field
// name or number that holds one makes the whole answer Unsafe, and base64 data (images, audio, files) that decodes to one
// is withheld as a short text part. A string that is itself JSON is decoded too, so escapes cannot carry a secret through.
export function redactor(secrets) {
  const raw = [...new Set([...secrets].filter(Boolean).map(String))];
  const forms = [...new Set(raw.flatMap(secret => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return [secret, escaped, escaped.replaceAll('/', '\\/'), encodeURIComponent(secret.toWellFormed())];
  }))].sort((left, right) => right.length - left.length);
  if (!forms.length) return value => value;
  // One pass, longest first, so a short secret never cuts up a longer one or the word put in its place.
  const source = forms.map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(source, 'g'), shows = value => new RegExp(source).test(value);
  const bytes = raw.map(secret => Buffer.from(secret));
  // Base64 (either alphabet) that decodes to bytes holding a secret, read from every starting offset.
  const decodes = chunk => {
    for (let offset = 0; offset < 4 && offset < chunk.length; offset++) {
      const decoded = Buffer.from(chunk.slice(offset), 'base64');
      if (bytes.some(secret => decoded.includes(secret))) return true;
    }
    return false;
  };
  const plain = value => value.replace(pattern, '[hidden]').replace(BASE64, chunk => decodes(chunk) ? '[hidden]' : chunk);
  const text = value => {
    if (/^\s*[[{"]/.test(value)) {
      try {
        const inner = JSON.parse(value), cleaned = loose(inner);
        if (JSON.stringify(cleaned) !== JSON.stringify(inner)) return JSON.stringify(cleaned);
      } catch { /* plain words */ }
    }
    return plain(value);
  };
  // Inside a string that is JSON: only words, so anything may be replaced.
  const loose = value => typeof value === 'string' ? text(value)
    : typeof value === 'number' ? (forms.includes(String(value)) ? '[hidden]' : value)
    : Array.isArray(value) ? value.map(loose)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), loose(item)]))
    : value;
  const binary = value => typeof value === 'string' && (shows(value) || decodes(value.replace(/\s+/g, '')));
  // The MCP answer itself.
  const walk = (value, key = '') => {
    if (typeof value === 'string') { if (!STRUCTURE.has(key)) return text(value); if (shows(value)) throw new Unsafe(); return value; }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') { if (forms.includes(String(value))) throw new Unsafe(); return value; }
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (!value || typeof value !== 'object') return value;
    for (const name of Object.keys(value)) if (shows(name)) throw new Unsafe();
    // Image or audio content, and a resource's blob: withheld whole, in a form the protocol still accepts.
    if ((value.type === 'image' || value.type === 'audio') && binary(value.data)) return { type: 'text', text: WITHHELD };
    if (typeof value.blob === 'string' && binary(value.blob)) { const { blob, mimeType, ...rest } = value; return walk({ ...rest, mimeType: 'text/plain', text: WITHHELD }, key); }
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
  };
  return walk;
}

// The error an agent or the screen may see. With a sign-in in play, only the server's own protocol error keeps its words
// (decoded, then cleaned). A failed request can carry the raw answer, escaped or cut short, so it gets fixed words.
export function safeError(error, name, secrets) {
  const message = String(error?.message || ''), code = error?.code;
  if (message.includes(MOVED)) return new Error(`${name}: ${MOVED}`);
  if (error instanceof Unsafe) return Object.assign(new Error(`${name}: ${UNSAFE}`), { own: true });
  if (error?.own || !secrets.size) return error;
  if (error?.name === 'McpError') return Object.assign(new Error(redactor(secrets)(message)), { code });
  const status = Number(code) >= 100 && Number(code) < 600;
  return Object.assign(new Error(`${name}: ${status ? `the server answered with an error (HTTP ${code}).` : 'the server could not be reached or did not answer properly.'}`), { code });
}

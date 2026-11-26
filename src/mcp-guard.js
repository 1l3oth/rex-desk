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
const SHORT = 8;
const WITHHELD = '[Rex Desk held this file back: it could show your sign-in.]';

// Takes secrets out of a decoded MCP answer and keeps its structure: free text has them replaced, a protocol field, field
// name or number that holds one makes the whole answer Unsafe, and base64 data (images, audio, files) that decodes to one
// is withheld as a short text part. A string that is itself JSON is decoded too, so escapes cannot carry a secret through.
export function redactor(secrets) {
  const raw = [...new Set([...secrets].filter(Boolean).map(String))];
  // A short credential (under SHORT characters) blocks an answer only as a whole word: "x" in the field "text" or the
  // type "text" does not, so a normal answer still arrives, while "x" on its own, or encoded on its own, still is held back.
  const short = secret => secret.length < SHORT;
  const formsOf = secret => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    const hex = Buffer.from(secret).toString('hex');
    return [secret, escaped, escaped.replaceAll('/', '\\/'), encodeURIComponent(secret.toWellFormed()), hex, hex.toUpperCase()];
  };
  const listed = [...new Map(raw.flatMap(secret => formsOf(secret).map(form => [form, short(secret)]))).entries()].sort(([left], [right]) => right.length - left.length);
  const forms = listed.map(([form]) => form);
  if (!forms.length) return value => value;
  // One pass, longest first, so a short secret never cuts up a longer one or the word put in its place.
  const quote = form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Free text has every form taken out wherever it stands (replacing never blocks an answer). A field the protocol reads, a
  // field name or a number blocks the whole answer, so there a short form counts only as a whole word.
  const pattern = new RegExp(forms.map(quote).join('|'), 'g');
  const exact = new RegExp(listed.map(([form, alone]) => alone ? `(?<![A-Za-z0-9])${quote(form)}(?![A-Za-z0-9])` : quote(form)).join('|'));
  const shows = value => exact.test(value);
  const bytes = raw.map(secret => Buffer.from(secret));
  const word = byte => (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
  // Decoded bytes hold a secret: anywhere for a long one. A short one counts only in a run that decodes, from its start, to
  // readable text in which it stands with no letter or digit beside it, so random decoded bytes never match by chance.
  const readable = decoded => decoded.length > 0 && decoded.every(byte => (byte >= 32 && byte < 127) || byte === 9 || byte === 10 || byte === 13);
  const holds = (decoded, offset) => bytes.some(secret => {
    if (secret.length >= SHORT) return decoded.includes(secret);
    if (offset || !readable(decoded)) return false;
    for (let at = decoded.indexOf(secret); at !== -1; at = decoded.indexOf(secret, at + 1))
      if (!word(decoded[at - 1] ?? 0) && !word(decoded[at + secret.length] ?? 0)) return true;
    return false;
  });
  // Base64 of the shortest secret, without padding, is the shortest run worth decoding: a short secret is never missed.
  const shortest = Math.max(2, Math.min(...bytes.map(item => Math.ceil(item.length * 4 / 3))));
  const BASE64 = new RegExp(`[A-Za-z0-9+/_-]{${shortest},}={0,2}`, 'g');
  // Base64 (either alphabet) that decodes to bytes holding a secret, read from every starting offset.
  const decodes = chunk => {
    for (let offset = 0; offset < 4 && offset < chunk.length; offset++) {
      if (holds(Buffer.from(chunk.slice(offset), 'base64'), offset)) return true;
    }
    // A short secret's base64 may sit between slashes or dashes, which the run above takes in: each piece is read on its own.
    if (bytes.some(secret => secret.length < SHORT)) for (const piece of chunk.split(/[+/_-]+/)) if (piece !== chunk && piece.length > 1 && holds(Buffer.from(piece, 'base64'), 0)) return true;
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
    : typeof value === 'number' ? (shows(String(value)) ? '[hidden]' : value)
    : Array.isArray(value) ? value.map(loose)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), loose(item)]))
    : value;
  const binary = value => typeof value === 'string' && (shows(value) || decodes(value.replace(/\s+/g, '')));
  // A protocol field (an address, a name, a cursor) is passed on as it is, so it may not hold a secret in any form: written
  // out, escaped, percent-encoded, hex, or base64 anywhere in it (also after percent-decoding, as in a data: or file address).
  const encoded = value => { BASE64.lastIndex = 0; return [...value.matchAll(BASE64)].some(([chunk]) => decodes(chunk)); };
  const hides = value => { let open = value; try { open = decodeURIComponent(value); } catch { /* not percent-encoded */ } return shows(value) || shows(open) || encoded(value) || encoded(open); };
  // The MCP answer itself.
  const walk = (value, key = '') => {
    if (typeof value === 'string') { if (!STRUCTURE.has(key)) return text(value); if (hides(value)) throw new Unsafe(); return value; }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') { if (shows(String(value))) throw new Unsafe(); return value; }
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (!value || typeof value !== 'object') return value;
    for (const name of Object.keys(value)) if (hides(name)) throw new Unsafe();
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

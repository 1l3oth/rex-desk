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

// A header, query, environment or flag name reads as a credential when one of its words is a credential word. Splitting on
// separators and camelCase means a real name (api_key, GITHUB_TOKEN, X-Api-Key, apiKey) matches, while an ordinary setting
// whose word merely begins the same (TOKENIZERS_PARALLELISM, monkey) does not, so it is left alone.
const CREDENTIAL_WORDS = new Set(['auth', 'authorization', 'cookie', 'token', 'tokens', 'key', 'keys', 'apikey', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'credential', 'credentials']);
const wordsOf = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word.toLowerCase());
export const isCredential = name => wordsOf(name).some(word => CREDENTIAL_WORDS.has(word));
export function headerSecrets(config) {
  return Object.entries(config?.headers || {}).filter(([name]) => isCredential(name)).flatMap(([name, text]) => {
    const value = String(text).trim(), bare = value.replace(/^(bearer|basic|token|apikey)(\s+|$)/i, '');
    const parts = /cookie/i.test(name) ? value.split(';').map(part => part.slice(part.indexOf('=') + 1).trim()) : [];
    return [bare, ...parts].filter(Boolean);
  });
}

// The least a pasted key can be and still be told apart from ordinary words (L30). A real secret shorter than this is
// refused on the way in, so a wrong, cut-off or placeholder key is caught at once and hiding one in an answer never has to
// fight normal text.
export const KEY_FLOOR = 8;
export const KEY_TOO_SHORT = 'That key looks too short. A key is at least 8 characters, so paste the whole key.';
// The scheme word in front of an auth value ("Bearer ", "Basic ") is not part of the key.
const bareKey = value => String(value).trim().replace(/^(bearer|basic|token|apikey)\s+/i, '');
// Pull the real secret out of a KEY=value or "Header: value" pair when the name reads as a credential, '' otherwise, so an
// ordinary setting (a port, a region, true/false) is never taken for a key.
const pairSecret = (name, value) => (isCredential(name) ? bareKey(value) : '');

// Every real secret a server config carries, by whatever way a key gets in: the credentials in its headers, the password or
// a credential in its address, and KEY=value settings in its environment or on its command line (NAME=value, --name=value,
// --name value, -H "Header: value") whose name reads as a credential. Scheme words, usernames, ports, regions and plain
// settings are left out, so an ordinary short value is never refused as a key.
export function configSecrets(config) {
  const out = [...headerSecrets(config)];
  try {
    const url = new URL(String(config?.url));
    if (url.password) out.push(decodeURIComponent(url.password));
    for (const [name, value] of url.searchParams) if (isCredential(name) && value) out.push(value);
  } catch { /* no address, or not one that parses */ }
  for (const [name, value] of Object.entries(config?.env && typeof config.env === 'object' ? config.env : {})) out.push(pairSecret(name, value));
  const args = Array.isArray(config?.args) ? config.args.map(String) : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i], next = args[i + 1];
    if (/^(-H|--header)$/.test(arg) && next !== undefined) { const header = next.match(/^\s*([^:\s]+)\s*:\s*(.*)$/); if (header) out.push(pairSecret(header[1], header[2])); i += 1; continue; }
    const pair = arg.match(/^--?([\w-]+)=(.*)$/) || arg.match(/^([A-Za-z_]\w*)=(.*)$/);
    if (pair) { out.push(pairSecret(pair[1], pair[2])); continue; }
    const flag = arg.match(/^--?([A-Za-z][\w-]*)$/);
    if (flag && next !== undefined && !next.startsWith('-')) { const secret = pairSecret(flag[1], next); if (secret) { out.push(secret); i += 1; } }
  }
  return [...new Set(out.filter(Boolean))];
}

// The first real secret too short to tell from ordinary text (1..KEY_FLOOR-1 characters), or '' when every key is long
// enough or none was given. An empty field is no key, so it is never too short.
export function shortKey(config) {
  return configSecrets(config).find(secret => secret.length > 0 && secret.length < KEY_FLOOR) || '';
}

// An answer that would show a sign-in where it cannot be taken out without breaking the MCP message (a field name, a type,
// an address, a number): Rex Desk holds the whole answer back instead.
export const UNSAFE = 'The server sent back an answer that could show your sign-in, so Rex Desk held it back.';
export class Unsafe extends Error { constructor() { super(UNSAFE); this.own = true; } }
// Fields the MCP protocol reads (types, names, addresses, cursors): their values are never changed, only checked.
const STRUCTURE = new Set(['type', 'mimeType', 'role', 'uri', 'uriTemplate', 'name', 'method', 'jsonrpc', 'id', 'nextCursor', 'cursor', 'progressToken', 'protocolVersion']);
const SHORT = KEY_FLOOR;
const WITHHELD = '[Rex Desk held this file back: it could show your sign-in.]';

// Takes secrets out of a decoded MCP answer and keeps its structure: free text has them replaced, a protocol field, field
// name or number that holds one makes the whole answer Unsafe, and base64 data (images, audio, files) that decodes to one
// is withheld as a short text part. A string that is itself JSON is decoded too, so escapes cannot carry a secret through.
export function redactor(secrets) {
  const raw = [...new Set([...secrets].filter(Boolean).map(String))];
  if (!raw.length) return value => value;
  // A short credential (under SHORT characters) is matched in a protocol field only where it stands alone (no letter or
  // digit beside it), so a normal answer still arrives: "x" in the word "text" or in a number never blocks it.
  const short = secret => secret.length < SHORT;
  // A one-character credential is the one that garbles ordinary prose (every "x", every "a"), so it is taken out of free
  // text only where it stands alone; two characters or more are still taken out wherever they sit.
  const tiny = secret => secret.length < 2;
  const quote = form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bound = ([form, alone]) => alone ? `(?<![A-Za-z0-9])${quote(form)}(?![A-Za-z0-9])` : quote(form);
  // Every way a credential can be written into a string field that carries it on: itself, JSON-escaped, percent- or hex-encoded.
  const allForms = secret => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    const hex = Buffer.from(secret).toString('hex');
    return [secret, escaped, escaped.replaceAll('/', '\\/'), encodeURIComponent(secret.toWellFormed()), hex, hex.toUpperCase()];
  };
  // In free prose a short credential is taken out written out only (its base64 is still caught by the decoder below), never
  // by an encoded form whose short hex or percent run collides with ordinary words; a long one by any encoded form.
  const textForms = secret => short(secret) ? [secret, JSON.stringify(secret).slice(1, -1)] : allForms(secret);
  // Build one regex from a set of forms, longest first so a short form never eats a longer one. aloneFn decides which
  // secrets are matched only as a whole run.
  const build = (formsFn, aloneFn, flags) => {
    const map = new Map();
    for (const secret of raw) for (const form of formsFn(secret)) if (!map.has(form)) map.set(form, aloneFn(secret));
    const pairs = [...map.entries()].sort(([left], [right]) => right.length - left.length);
    return pairs.length ? new RegExp(pairs.map(bound).join('|'), flags) : null;
  };
  const pattern = build(textForms, tiny, 'g');   // free prose: a lone 1-char only as a whole word, the rest anywhere
  const field = build(allForms, short, '');      // a string the protocol passes on (an address, a name, a cursor)
  // A number leaks a credential only when the number written out IS the credential; an encoded form landing on an ordinary
  // number (hex "41" for the key "A") is a coincidence, not a leak, so a number is matched against the plain text only.
  const number = build(secret => [secret], short, '');
  const showsField = value => Boolean(field && field.test(value));
  const showsNumber = value => Boolean(number && number.test(value));
  const bytes = raw.map(secret => Buffer.from(secret));
  const word = byte => (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
  // Decoded bytes hold a secret (for free prose and protocol fields): anywhere for a long one. A short one counts only in a
  // run that decodes, from its start, to readable text in which it stands with no letter or digit beside it.
  const readable = decoded => decoded.length > 0 && decoded.every(byte => (byte >= 32 && byte < 127) || byte === 9 || byte === 10 || byte === 13);
  const holds = (decoded, offset) => bytes.some(secret => {
    if (secret.length >= SHORT) return decoded.includes(secret);
    if (offset || !readable(decoded)) return false;
    for (let at = decoded.indexOf(secret); at !== -1; at = decoded.indexOf(secret, at + 1))
      if (!word(decoded[at - 1] ?? 0) && !word(decoded[at + secret.length] ?? 0)) return true;
    return false;
  });
  // A whole binary payload (an image, audio or a file) is withheld as soon as its bytes carry a credential, short ones
  // included: there is no safe way to hand back a file that still contains the sign-in.
  const carries = decoded => bytes.some(secret => decoded.includes(secret));
  // Base64 of the shortest secret, without padding, is the shortest run worth decoding: a short secret is never missed.
  const shortest = Math.max(2, Math.min(...bytes.map(item => Math.ceil(item.length * 4 / 3))));
  const BASE64 = new RegExp(`[A-Za-z0-9+/_-]{${shortest},}={0,2}`, 'g');
  const atOffsets = (chunk, test) => {
    for (let offset = 0; offset < 4 && offset < chunk.length; offset++) if (test(Buffer.from(chunk.slice(offset), 'base64'), offset)) return true;
    return false;
  };
  // Base64 (either alphabet) that decodes to bytes holding a secret, read from every starting offset.
  const decodes = chunk => {
    if (atOffsets(chunk, holds)) return true;
    // A short secret's base64 may sit between slashes or dashes, which the run above takes in: each piece is read on its own.
    if (bytes.some(secret => secret.length < SHORT)) for (const piece of chunk.split(/[+/_-]+/)) if (piece !== chunk && piece.length > 1 && holds(Buffer.from(piece, 'base64'), 0)) return true;
    return false;
  };
  // A binary payload is the base64 of a file, so its real bytes are the straight decode: withheld whenever those bytes carry
  // a credential, whatever the secret's length.
  const payloadDecodes = chunk => carries(Buffer.from(chunk, 'base64'));
  const plain = value => (pattern ? value.replace(pattern, '[hidden]') : value).replace(BASE64, chunk => decodes(chunk) ? '[hidden]' : chunk);
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
    : typeof value === 'number' ? (showsNumber(String(value)) ? '[hidden]' : value)
    : Array.isArray(value) ? value.map(loose)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), loose(item)]))
    : value;
  const binary = value => typeof value === 'string' && (showsField(value) || payloadDecodes(value.replace(/\s+/g, '')));
  // A protocol field (an address, a name, a cursor) is passed on as it is, so it may not hold a secret in any form: written
  // out, escaped, percent-encoded, hex, or base64 anywhere in it (also after percent-decoding, as in a data: or file address).
  const encoded = value => { BASE64.lastIndex = 0; return [...value.matchAll(BASE64)].some(([chunk]) => decodes(chunk)); };
  const hides = value => { let open = value; try { open = decodeURIComponent(value); } catch { /* not percent-encoded */ } return showsField(value) || showsField(open) || encoded(value) || encoded(open); };
  // The MCP answer itself.
  const walk = (value, key = '') => {
    if (typeof value === 'string') { if (!STRUCTURE.has(key)) return text(value); if (hides(value)) throw new Unsafe(); return value; }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') { if (showsNumber(String(value))) throw new Unsafe(); return value; }
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

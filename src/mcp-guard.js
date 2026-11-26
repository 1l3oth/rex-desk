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

// Takes secrets out of a decoded answer: every string and field name in it. A string that is itself JSON is decoded too, so
// escapes cannot carry a secret through.
export function redactor(secrets) {
  const forms = [...new Set([...secrets].filter(Boolean).flatMap(secret => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return [secret, escaped, escaped.replaceAll('/', '\\/'), encodeURIComponent(secret.toWellFormed())];
  }))].sort((left, right) => right.length - left.length);
  if (!forms.length) return value => value;
  // One pass, longest first, so a short secret never cuts up a longer one or the word put in its place.
  const pattern = new RegExp(forms.map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const text = value => {
    if (/^\s*[[{"]/.test(value)) {
      try {
        const inner = JSON.parse(value), cleaned = walk(inner);
        if (JSON.stringify(cleaned) !== JSON.stringify(inner)) return JSON.stringify(cleaned);
      } catch { /* plain words */ }
    }
    return value.replace(pattern, '[hidden]');
  };
  const walk = value => typeof value === 'string' ? text(value)
    : typeof value === 'number' ? (forms.includes(String(value)) ? '[hidden]' : value)
    : Array.isArray(value) ? value.map(walk)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), walk(item)]))
    : value;
  return walk;
}

// The error an agent or the screen may see. With a sign-in in play, only the server's own protocol error keeps its words
// (decoded, then cleaned). A failed request can carry the raw answer, escaped or cut short, so it gets fixed words.
export function safeError(error, name, secrets) {
  const message = String(error?.message || ''), code = error?.code;
  if (message.includes(MOVED)) return new Error(`${name}: ${MOVED}`);
  if (error?.own || !secrets.size) return error;
  if (error?.name === 'McpError') return Object.assign(new Error(redactor(secrets)(message)), { code });
  const status = Number(code) >= 100 && Number(code) < 600;
  return Object.assign(new Error(`${name}: ${status ? `the server answered with an error (HTTP ${code}).` : 'the server could not be reached or did not answer properly.'}`), { code });
}

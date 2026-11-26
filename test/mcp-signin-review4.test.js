import test from 'node:test';
import assert from 'node:assert/strict';
import { McpSignIn, privateHost } from '../src/mcp-signin.js';
import * as guard from '../src/mcp-guard.js';

// L30 review 731d387d: a server-named discovery address or redirect may not reach a private or loopback destination, and a
// short credential must not break ordinary output (a number, prose) while short ones in binary data are still withheld.
const b64 = text => Buffer.from(text).toString('base64');
function memoryStore() {
  const records = new Map();
  return { get: (kind, id) => records.get(id) ?? null, put: (kind, id, value) => records.set(id, value), delete: (kind, id) => records.delete(id), list: () => [...records.values()], encrypt: text => text, decrypt: text => text };
}

test('review 731d387d (1): discovery and its redirects never reach a private or loopback address', async () => {
  for (const privateUrl of ['https://127.0.0.1/meta', 'https://192.168.1.10/meta', 'https://10.0.0.5/meta', 'https://[::1]/meta', 'https://169.254.1.2/meta']) {
    const asked = [];
    const fetcher = async target => {
      const url = String(target); asked.push(url);
      if (url === 'https://mcp.example.test/mcp') return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://meta.example.test/.well-known/oauth-protected-resource"' } });
      if (url === 'https://meta.example.test/.well-known/oauth-protected-resource') return new Response(null, { status: 302, headers: { location: privateUrl } });
      return new Response('{}', { status: 404 });
    };
    const signIn = new McpSignIn(memoryStore(), { fetcher });
    await assert.rejects(() => signIn.start('flow-mcp', 'https://mcp.example.test/mcp'));
    assert.ok(!asked.includes(privateUrl), `never asked ${privateUrl}: ${asked.join(', ')}`);
    signIn.stop();
  }
});

test('review 731d387d (1): privateHost catches loopback, RFC 1918, link-local, IPv6 and mapped forms, but not a public host', () => {
  for (const host of ['localhost', 'a.local', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '172.31.255.1', '169.254.0.1', '::1', '[::1]', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '0.0.0.0'])
    assert.equal(privateHost(host), true, host);
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', 'mcp.notion.so'])
    assert.equal(privateHost(host), false, host);
});

test('review 731d387d (2): a short credential never blocks an ordinary number or garbles a word', () => {
  // The hex of "A" is "41": an ordinary number 41 is not the credential and must pass through untouched.
  assert.equal(guard.redactor(['A'])({ structuredContent: { count: 41 } }).structuredContent.count, 41);
  // A one-letter credential is taken out only where it stands alone, never inside a word.
  assert.equal(guard.redactor(['x'])({ content: [{ type: 'text', text: 'index' }] }).content[0].text, 'index');
  assert.equal(guard.redactor(['x'])({ content: [{ type: 'text', text: 'key is x ok' }] }).content[0].text, 'key is [hidden] ok');
  // The number that IS the credential is still held back.
  assert.throws(() => guard.redactor(['42'])({ structuredContent: { count: 42 } }), /held it back/);
});

test('review 731d387d (2): a short credential sitting in binary data makes the whole payload be withheld', () => {
  // Bytes 0x5a 0x39 ("Z9") buried between non-text bytes: not a readable run, so the old check missed it.
  const data = Buffer.from([0xff, 0x5a, 0x39, 0x00, 0x7f]).toString('base64');
  const image = guard.redactor(['Z9'])({ content: [{ type: 'image', mimeType: 'image/png', data }] });
  assert.equal(image.content[0].type, 'text');
  // A picture with none of the credential bytes is left exactly as it was.
  const plain = b64('a plain picture');
  assert.deepEqual(guard.redactor(['Z9'])({ content: [{ type: 'image', mimeType: 'image/png', data: plain }] }).content[0], { type: 'image', mimeType: 'image/png', data: plain });
});

// L30 review 238e5326: the DNS check uses an injected resolver so it is deterministic and tied to each request, the hex
// canonical of IPv4-mapped IPv6 is caught, and a private HTTPS server the person set up can run its own same-origin sign-in.
test('review 238e5326 (1): a public name the resolver maps to a private IP is refused on a discovery redirect', async () => {
  const asked = [];
  const resolver = async host => host === 'sneaky.example.test' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
  const fetcher = async target => {
    const url = String(target); asked.push(url);
    if (url === 'https://mcp.example.test/mcp') return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://meta.example.test/.well-known/oauth-protected-resource"' } });
    if (url === 'https://meta.example.test/.well-known/oauth-protected-resource') return new Response(null, { status: 302, headers: { location: 'https://sneaky.example.test/meta' } });
    return new Response('{}', { status: 404 });
  };
  const signIn = new McpSignIn(memoryStore(), { fetcher, resolver });
  await assert.rejects(() => signIn.start('flow-mcp', 'https://mcp.example.test/mcp'));
  assert.ok(!asked.includes('https://sneaky.example.test/meta'), `never asked the rebinding host: ${asked.join(', ')}`);
  signIn.stop();
});

test('review 238e5326 (1): privateHost catches the hex canonical of an IPv4-mapped IPv6 address', () => {
  assert.equal(privateHost('::ffff:7f00:1'), true, '127.0.0.1');
  assert.equal(privateHost('::ffff:7f00:0001'), true);
  assert.equal(privateHost('::ffff:c0a8:0101'), true, '192.168.1.1');
  assert.equal(privateHost('[::ffff:a00:1]'), true, '10.0.0.1 in brackets');
  assert.equal(privateHost('::ffff:5db8:d822'), false, '93.184.216.34 is public');
});

test('review 238e5326 (2): a private HTTPS server the person set up runs its own same-origin discovery', async () => {
  const asked = [];
  const fetcher = async target => {
    const url = String(target); asked.push(url);
    if (url === 'https://10.1.2.3/mcp') return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://10.1.2.3/.well-known/oauth-protected-resource"' } });
    if (url === 'https://10.1.2.3/.well-known/oauth-protected-resource') return new Response(JSON.stringify({ resource: 'https://10.1.2.3/mcp', authorization_servers: ['https://10.1.2.3'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://10.1.2.3/.well-known/oauth-authorization-server')) return new Response(JSON.stringify({ issuer: 'https://10.1.2.3', authorization_endpoint: 'https://10.1.2.3/authorize', token_endpoint: 'https://10.1.2.3/token', registration_endpoint: 'https://10.1.2.3/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  };
  const signIn = new McpSignIn(memoryStore(), { fetcher });
  await signIn.start('corp', 'https://10.1.2.3/mcp').catch(() => {}); // may fail later at registration; discovery must be allowed
  assert.ok(asked.some(u => u.includes('10.1.2.3/.well-known/')), `same-origin discovery is allowed for the private server: ${asked.join(', ')}`);
  signIn.stop();
});

test('review 238e5326 (2): a private server may not point its sign-in at a different private address', async () => {
  const asked = [];
  const fetcher = async target => {
    const url = String(target); asked.push(url);
    if (url === 'https://10.1.2.3/mcp') return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://10.1.2.3/.well-known/oauth-protected-resource"' } });
    if (url === 'https://10.1.2.3/.well-known/oauth-protected-resource') return new Response(JSON.stringify({ resource: 'https://10.1.2.3/mcp', authorization_servers: ['https://10.9.9.9'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://10.9.9.9/')) return new Response(JSON.stringify({ issuer: 'https://10.9.9.9', authorization_endpoint: 'https://10.9.9.9/authorize', token_endpoint: 'https://10.9.9.9/token', registration_endpoint: 'https://10.9.9.9/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  };
  const signIn = new McpSignIn(memoryStore(), { fetcher });
  await assert.rejects(() => signIn.start('corp', 'https://10.1.2.3/mcp'));
  assert.ok(!asked.some(u => u.startsWith('https://10.9.9.9/')), `the other private host is never asked: ${asked.join(', ')}`);
  signIn.stop();
});

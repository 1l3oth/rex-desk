import test from 'node:test';
import assert from 'node:assert/strict';
import { McpSignIn } from '../src/mcp-signin.js';
import * as guard from '../src/mcp-guard.js';
import * as box from '../src/toolbox.js';

// L30 review 69e39e56: a short credential must not block normal answers, every discovery request and redirect is checked
// before it is made, and the Market shows only an address's origin.
const b64 = text => Buffer.from(text).toString('base64');
function memoryStore() {
  const records = new Map();
  return { get: (kind, id) => records.get(id) ?? null, put: (kind, id, value) => records.set(id, value), delete: (kind, id) => records.delete(id), list: () => [...records.values()], encrypt: text => text, decrypt: text => text };
}

test('review 69e39e56 (1): a one-character credential never blocks a normal answer, and its echoes are still caught', () => {
  for (const secret of ['x', '7', 'ab']) {
    const clean = guard.redactor([secret]);
    const normal = { content: [{ type: 'text', text: 'the next text' }, { type: 'resource', resource: { uri: 'file:///notes/today.md', mimeType: 'text/plain', text: 'a' } }], structuredContent: { text: 'ok', count: 17, items: [{ name: 'box', type: 'object' }] }, nextCursor: 'page-2' };
    const answer = clean(normal);
    assert.equal(answer.content[0].type, 'text', `${secret}: the type stays`);
    assert.equal(answer.content[1].resource.uri, 'file:///notes/today.md');
    assert.deepEqual(Object.keys(answer.structuredContent), ['text', 'count', 'items']);
    assert.equal(answer.structuredContent.count, 17);
    assert.equal(answer.nextCursor, 'page-2');
    // The echoes: on its own in text, base64 on its own in text, alone in an address, a field name or a number.
    assert.match(clean({ content: [{ type: 'text', text: `you sent ${secret} and ${b64(secret)}` }] }).content[0].text, /^you sent \[hidden\] and \[hidden\]$/);
    assert.throws(() => clean({ contents: [{ uri: `file:///a/${secret}`, text: 'a' }] }), /held it back/, `${secret}: in an address`);
    assert.throws(() => clean({ contents: [{ uri: `file:///a/${b64(secret)}`, text: 'a' }] }), /held it back/, `${secret}: base64 in an address`);
    assert.throws(() => clean({ structuredContent: { [secret]: 1 } }), /held it back/, `${secret}: a field name`);
  }
  assert.throws(() => guard.redactor(['7'])({ structuredContent: { count: 7 } }), /held it back/, 'a number that is the credential');
});

test('review 69e39e56 (2): an address the server points discovery at is checked before Rex Desk asks there, and so is each redirect', async () => {
  const cases = [
    ['https://meta.example.test/.well-known/oauth-protected-resource?access_token=abc', null],
    ['http://meta.example.test/.well-known/oauth-protected-resource', null],
    ['https://meta.example.test/.well-known/oauth-protected-resource', 'http://elsewhere.example.test/meta'],
    ['https://meta.example.test/.well-known/oauth-protected-resource', 'https://elsewhere.example.test/meta?api_key=abc'],
  ];
  for (const [advertised, redirect] of cases) {
    const asked = [];
    const fetcher = async (target, init = {}) => {
      const url = String(target); asked.push(url);
      if (url === 'https://mcp.example.test/mcp') return new Response('{}', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${advertised}"` } });
      if (url === advertised && redirect) return new Response(null, { status: 302, headers: { location: redirect } });
      return new Response('{}', { status: 404 });
    };
    const signIn = new McpSignIn(memoryStore(), { fetcher });
    await assert.rejects(() => signIn.start('flow-mcp', 'https://mcp.example.test/mcp'));
    const bad = redirect || advertised;
    assert.ok(!asked.includes(bad), `never asked ${bad}: ${asked.join(', ')}`);
    signIn.stop();
  }
});

test('review 69e39e56 (3): the Market shows only the origin of an address, a command without its values, and errors without addresses', async () => {
  const toolbox = new box.Toolbox({ connect: async () => { throw Object.assign(new Error('could not reach https://tool.example.test/k/PATHKEY/mcp?api_key=QUERYKEY'), { code: 500 }); },
    mcpConfig: () => ({ keyed: { type: 'http', url: 'https://tool.example.test/k/PATHKEY/mcp' }, local: { command: 'npx', args: ['-y', '@scope/tool-mcp', '--api-key', 'ARGKEY', 'TOKEN=ENVKEY'] } }) });
  const overview = await toolbox.overview();
  assert.equal(overview.servers.find(item => item.name === 'keyed').how, 'https://tool.example.test');
  assert.equal(overview.servers.find(item => item.name === 'local').how, 'npx @scope/tool-mcp');
  assert.doesNotMatch(JSON.stringify(overview.servers), /PATHKEY|QUERYKEY|ARGKEY|ENVKEY/);
  await toolbox.closeAll();
});

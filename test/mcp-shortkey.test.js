import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configSecrets, shortKey, KEY_FLOOR, KEY_TOO_SHORT } from '../src/mcp-guard.js';
import { Toolbox, parseInstall } from '../src/toolbox.js';
import { readValues, catalogItem } from '../src/connector-catalog.js';

// L30: a tool key shorter than 8 characters is refused wherever a key gets in, so a wrong, cut-off or placeholder key is
// caught at once. The message never shows the key. Ordinary short settings (a port, a region, a username, true) are not keys.
const tmp = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('shortKey: 7 characters is refused, 8 is accepted, across every way a key gets in', () => {
  assert.equal(KEY_FLOOR, 8);
  for (const [cfg, why] of [
    [{ headers: { Authorization: 'Bearer abcdefg' } }, 'a 7-char header key'],
    [{ url: 'https://h.test/mcp?api_key=abc' }, 'a short key in the address'],
    [{ env: { API_KEY: 'short12' } }, 'a 7-char environment key'],
    [{ args: ['--token', 'abc'] }, 'a short key as a command flag'],
    [{ args: ['-H', 'X-Api-Key: abc'] }, 'a short key in a command header'],
    [{ url: 'https://user:pw@h.test/mcp' }, 'a short password in the address'],
  ]) assert.ok(shortKey(cfg), `${why} is refused`);
  for (const [cfg, why] of [
    [{ headers: { Authorization: 'Bearer abcdefgh' } }, 'an 8-char header key'],
    [{ url: 'https://h.test/mcp?api_key=abcdefgh' }, 'a full key in the address'],
    [{ env: { API_KEY: 'longkey8' } }, 'an 8-char environment key'],
    [{ args: ['--token=abcdefgh'] }, 'a full key as a command flag'],
  ]) assert.equal(shortKey(cfg), '', `${why} is accepted`);
});

test('shortKey: an ordinary short setting or a scheme word is never taken for a key', () => {
  assert.equal(shortKey({ args: ['--port', '8080', '--region', 'us', '--verbose', 'true'] }), '', 'a port, region or flag is not a key');
  assert.equal(shortKey({ url: 'https://user@h.test/mcp' }), '', 'a username is not a key');
  assert.equal(shortKey({ headers: { Authorization: 'Bearer ' } }), '', 'the scheme word alone is not a key');
  assert.deepEqual(configSecrets({ headers: { 'X-Api-Key': 'abcdefgh' }, url: 'https://h.test/mcp?token=zzzzzzzz' } ).sort(), ['abcdefgh', 'zzzzzzzz']);
});

test('toolsOf refuses a short key however it got saved: it never connects, shows the reason, and can be replaced', async () => {
  const box = new Toolbox({ home: tmp('sk-tools'), mcpConfig: () => ({}), bundled: '' });
  let connects = 0;
  box.connectWith = async () => { connects += 1; return { listTools: async () => ({ tools: [{ name: 'whoami' }] }), close: async () => {} }; };
  // An old saved (or agent-added, or synced) server whose key is too short.
  const refused = await box.toolsOf('old', { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer abc' } });
  assert.deepEqual(refused, [], 'nothing is listed');
  assert.equal(connects, 0, 'the short key never reaches a connection, so it cannot leak');
  assert.equal(box.failed.get('old').error, KEY_TOO_SHORT);
  // Pasting a full key in its place connects and clears the reason.
  const tools = await box.toolsOf('old', { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer abcdefgh' } });
  assert.equal(tools.length, 1); assert.equal(connects, 1); assert.equal(box.failed.has('old'), false);
});

test('a pasted JSON block with a short key is refused before anything is saved', () => {
  assert.throws(() => parseInstall('{"mcpServers":{"s":{"url":"https://h.test/mcp?token=abc"}}}'), /at least 8/);
  assert.throws(() => parseInstall('{"mcpServers":{"s":{"url":"https://h.test/mcp","headers":{"Authorization":"Bearer abc"}}}}'), /at least 8/);
  const ok = parseInstall('{"mcpServers":{"s":{"url":"https://h.test/mcp","headers":{"Authorization":"Bearer abcdefgh"}}}}');
  assert.deepEqual(ok.names, ['s'], 'a full key parses into an install call');
});

test('addServer refuses a short key in the address or command, and writes nothing until it is long enough', async () => {
  const box = new Toolbox({ home: tmp('sk-add'), mcpConfig: () => ({}), bundled: '' });
  const written = []; box.cli = async args => { written.push(args); };
  await assert.rejects(() => box.addServer({ name: 'x', url: 'https://h.test/mcp?api_key=abc' }), /at least 8/);
  await assert.rejects(() => box.addServer({ name: 'y', command: 'npx a-server --token abc' }), /at least 8/);
  assert.deepEqual(written, [], 'a too-short key is never written, so what was typed is not lost');
  await box.addServer({ name: 'z', url: 'https://h.test/mcp?api_key=abcdefgh' });
  assert.equal(written.length, 1, 'a full key is written');
});

test('a connector key field under 8 chars is refused by the field; an address is not a key', () => {
  assert.throws(() => readValues(catalogItem('github'), { token: 'ghp_abc' }), /at least 8/);
  assert.doesNotThrow(() => readValues(catalogItem('github'), { token: 'ghp_longtoken' }));
  assert.throws(() => readValues(catalogItem('brave'), { apiKey: 'BSA123' }), /at least 8/);
  assert.doesNotThrow(() => readValues(catalogItem('gitlab'), { host: 'git.io' }), 'an address field is not a key');
});

test('the refusal message never shows the key', () => {
  assert.ok(!KEY_TOO_SHORT.includes('abc'));
  assert.match(KEY_TOO_SHORT, /at least 8 characters/);
});

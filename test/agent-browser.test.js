import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentBrowser, browserChoice, privateHost, NO_BROWSER, OBSCURA_TOOLS } from '../src/agent-browser.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const exe = process.platform === 'win32' ? 'obscura.exe' : 'obscura';

// A pinned build made here: a tar.gz holding the program in a folder, with its real size and sha256.
function build() {
  const source = temporary('browser-src'), out = temporary('browser-pkg');
  mkdirSync(path.join(source, 'obscura-pkg')); writeFileSync(path.join(source, 'obscura-pkg', exe), 'program');
  const archive = path.join(out, 'obscura.tar.gz');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-czf', archive, '-C', source, 'obscura-pkg']);
  const bytes = readFileSync(archive);
  return { bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function desk({ choice = 'obscura', answer = 'accept', bytes, pinned } = {}) {
  const data = temporary('browser-data'), saved = new Map(), asked = [], events = [];
  const store = {
    directory: data,
    config: () => ({ agentBrowser: choice, agentBrowserAt: 'x' }),
    media: name => { const folder = path.join(data, name); mkdirSync(folder, { recursive: true }); return folder; },
    get: (kind, id) => saved.get(`${kind}:${id}`) || null,
    put: (kind, id, value) => saved.set(`${kind}:${id}`, value),
    event: (runId, type, payload) => events.push(payload.text),
  };
  let downloads = 0;
  const fetcher = async () => { downloads += 1; return { ok: true, status: 200, body: (async function* () { yield bytes.subarray(0, 10); yield bytes.subarray(10); })() }; };
  const tools = { obscura: { name: 'Obscura', version: '0.2.7', exe, onDisk: 'small', builds: { here: { url: 'https://example.invalid/obscura.tar.gz', ...pinned } } } };
  const browser = new AgentBrowser({ store, ask: async (runId, question) => { asked.push(question); return { action: answer }; } }, { fetcher, tools, platform: 'here' });
  return { browser, asked, events, data, downloads: () => downloads };
}

test('Obscura is the browser for agents unless the person picks Chromium or Off', () => {
  assert.equal(browserChoice({ config: () => ({}) }), 'obscura');
  assert.equal(browserChoice({ config: () => ({ agentBrowser: 'chromium' }) }), 'chromium');
  assert.equal(browserChoice({ config: () => ({ agentBrowser: 'off' }) }), 'off');
  assert.equal(browserChoice({ config: () => ({ agentBrowser: 'firefox' }) }), 'obscura');
  assert.ok(OBSCURA_TOOLS.length > 10 && OBSCURA_TOOLS.every(tool => tool.name && tool.inputSchema));
});

test('pages on this computer and its local network count as private', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.2', '172.16.0.1', '169.254.1.1', '[::1]', 'printer.local', 'fd12:3456::1']) assert.equal(privateHost(host), true, host);
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', 'www.youtube.com']) assert.equal(privateHost(host), false, host);
});

test('with the browser off, an agent is told so and nothing is asked or downloaded', async () => {
  const pkg = build(), setup = desk({ choice: 'off', bytes: pkg.bytes, pinned: pkg });
  assert.deepEqual(await setup.browser.ensure('run-1', 'obscura'), { off: NO_BROWSER });
  assert.equal(setup.asked.length, 0); assert.equal(setup.downloads(), 0);
});

test('the first use asks in Needs you with the size; a no is kept and nothing is downloaded', async () => {
  const pkg = build(), setup = desk({ answer: 'decline', bytes: pkg.bytes, pinned: pkg });
  const got = await setup.browser.ensure('run-1', 'obscura');
  assert.match(got.off, /said no/);
  assert.equal(setup.asked[0].method, 'browser-download'); assert.equal(setup.asked[0].request.size, pkg.size);
  assert.equal(setup.downloads(), 0);
  await setup.browser.ensure('run-1', 'obscura');
  assert.equal(setup.asked.length, 1, 'not asked again until the setting changes');
});

test('after a yes the pinned build is downloaded, checked and unpacked once', async () => {
  const pkg = build(), setup = desk({ bytes: pkg.bytes, pinned: pkg });
  const got = await setup.browser.ensure('run-1', 'obscura');
  assert.ok(got.exe && existsSync(got.exe) && got.exe.endsWith(exe));
  assert.equal(setup.browser.installed('obscura'), got.exe);
  assert.equal((await setup.browser.ensure('run-1', 'obscura')).exe, got.exe);
  assert.equal(setup.asked.length, 1); assert.equal(setup.downloads(), 1);
  assert.equal(setup.browser.status().tools.obscura.installed, true);
  assert.ok(setup.events.some(text => /ready for agents/.test(text)));
});

test('a download that does not match its sha256 is thrown away and nothing is installed', async () => {
  const pkg = build(), setup = desk({ bytes: pkg.bytes, pinned: { size: pkg.size, sha256: '0'.repeat(64) } });
  await assert.rejects(setup.browser.ensure('run-1', 'obscura'), /checksum/);
  assert.equal(setup.browser.installed('obscura'), '');
  assert.deepEqual(readdirSync(path.join(setup.data, 'tools')), [], 'no archive or half-unpacked folder is left');
});

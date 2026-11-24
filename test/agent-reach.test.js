import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentReach, REACH_TOOLS, reachOn } from '../src/agent-reach.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const pin = bytes => ({ url: 'https://example.invalid/file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

// A pinned uv archive made here, and a stand-in wheel.
function files() {
  const source = temporary('reach-src'), out = temporary('reach-pkg'), name = process.platform === 'win32' ? 'uv.exe' : 'uv';
  mkdirSync(path.join(source, 'uv-pkg')); writeFileSync(path.join(source, 'uv-pkg', name), 'uv');
  const archive = path.join(out, 'uv.tar.gz');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-czf', archive, '-C', source, 'uv-pkg']);
  return { uv: readFileSync(archive), wheel: Buffer.from('wheel') };
}

function setup({ on = {}, answer = 'accept', reply = { ok: true, items: [{ title: 'Me at the zoo', url: 'https://youtu.be/x', text: 'All right, so here we are' }] } } = {}) {
  const data = temporary('reach-data'), saved = new Map(), asked = [], calls = [];
  const store = {
    config: () => ({ agentReach: on, agentReachAt: 'x' }),
    media: name => { const folder = path.join(data, name); mkdirSync(folder, { recursive: true }); return folder; },
    get: (kind, id) => saved.get(`${kind}:${id}`) || null, put: (kind, id, value) => saved.set(`${kind}:${id}`, value), event: () => {},
  };
  const bytes = files(); let downloads = 0;
  const fetcher = async url => { downloads += 1; const body = url.endsWith('.whl') ? bytes.wheel : bytes.uv; return { ok: true, status: 200, body: (async function* () { yield body; })() }; };
  const run = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    if (args[0] === 'tool') { mkdirSync(options.env.UV_TOOL_BIN_DIR, { recursive: true }); writeFileSync(path.join(options.env.UV_TOOL_BIN_DIR, process.platform === 'win32' ? 'agent-reach.exe' : 'agent-reach'), ''); return { stdout: '', stderr: '' }; }
    return { stdout: JSON.stringify(reply), stderr: '' };
  };
  const pins = { wheel: { ...pin(bytes.wheel), url: 'https://example.invalid/agent_reach-1.6.1-py3-none-any.whl' }, uv: { here: pin(bytes.uv) } };
  const reach = new AgentReach({ store, ask: async (runId, question) => { asked.push(question); return { action: answer }; } }, { fetcher, run, platform: 'here', pins });
  return { reach, asked, calls, data, downloads: () => downloads };
}

test('only read-only tools ship, and every platform is on until switched off', () => {
  assert.deepEqual(REACH_TOOLS.map(tool => tool.name).sort(), ['github_read', 'github_search', 'reddit_read', 'reddit_search', 'web_read', 'youtube_read', 'youtube_search', 'youtube_subtitle']);
  assert.ok(REACH_TOOLS.filter(tool => tool.publicOnly).every(tool => tool.channel === 'reddit'));
  assert.deepEqual(reachOn({ config: () => ({}) }), { youtube: true, github: true, reddit: true, web: true });
  assert.deepEqual(reachOn({ config: () => ({ agentReach: { reddit: false } }) }), { youtube: true, github: true, reddit: false, web: true });
});

test('the first use asks, downloads the pinned files, installs inside the data folder, then reads a YouTube transcript', async () => {
  const { reach, asked, calls, data, downloads } = setup();
  const got = await reach.call('run-1', 'youtube_subtitle', { target: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', lang: 'en' });
  assert.equal(asked.length, 1); assert.equal(asked[0].method, 'tool-download');
  assert.equal(downloads(), 2);
  const install = calls.find(call => call.args[0] === 'tool');
  assert.deepEqual(install.args.slice(0, 4), ['tool', 'install', '--python', '3.12']);
  for (const key of ['USERPROFILE', 'HOME', 'UV_TOOL_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_CACHE_DIR', 'TEMP']) assert.ok(install.env[key].startsWith(data), `${key} stays in the data folder`);
  assert.deepEqual(calls.at(-1).args, ['youtube', 'subtitle', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', '--lang', 'en']);
  assert.match(got.result, /here we are/);
  assert.ok(reach.status().installed);
  await reach.call('run-1', 'youtube_read', { target: 'jNQXAC9IVRw' });
  assert.equal(asked.length, 1, 'asked once'); assert.equal(downloads(), 2, 'downloaded once');
});

test('Reddit is read from public pages only, never with a sign-in', async () => {
  const { reach, calls } = setup({ reply: { ok: true, items: [{ text: "You've been blocked by network security. To continue, log in" }], meta: { access: { mode: 'public' } } } });
  const got = await reach.call('run-1', 'reddit_read', { target: 'https://www.reddit.com/r/learnpython/comments/1fhv6g0/' });
  assert.deepEqual(calls.at(-1).args.slice(-2), ['--backend', 'public-web']);
  assert.ok(!calls.some(call => call.args.includes('login') || call.args.includes('browser')));
  assert.match(got.note, /blocked public reading/);
});

test('a platform switched off, a no to the download, a local address or a flag-like value never runs anything', async () => {
  let setupOff = setup({ on: { youtube: false } });
  assert.equal((await setupOff.reach.call('run-1', 'youtube_search', { query: 'cats' })).off, true);
  assert.equal(setupOff.asked.length, 0);

  const no = setup({ answer: 'decline' });
  assert.equal((await no.reach.call('run-1', 'web_read', { target: 'https://example.com' })).off, true);
  await no.reach.call('run-1', 'web_read', { target: 'https://example.com' });
  assert.equal(no.asked.length, 1, 'a no counts until the setting changes'); assert.equal(no.downloads(), 0);

  setupOff = setup();
  assert.equal((await setupOff.reach.call('run-1', 'web_read', { target: 'http://192.168.1.1/admin' })).failed, true);
  await assert.rejects(setupOff.reach.call('run-1', 'github_search', { query: '--help' }), /dash/);
  await assert.rejects(setupOff.reach.call('run-1', 'twitter_search', { query: 'x' }), /no tool/);
  assert.equal(setupOff.calls.length, 0);
});

test('a download that does not match its pin installs nothing', async () => {
  const { reach } = setup();
  reach.pins = { ...reach.pins, wheel: { ...reach.pins.wheel, sha256: '0'.repeat(64) } };
  await assert.rejects(reach.call('run-1', 'web_read', { target: 'https://example.com' }), /checksum/);
  assert.equal(reach.installed(), ''); assert.equal(existsSync(reach.home()), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { createApp } from '../src/server.js';
import { runOptions } from '../src/choices.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('only listed models, efforts and permission modes are accepted', () => {
  assert.deepEqual(runOptions({ model: 'claude-sonnet-5-5', effort: 'high', permissionMode: 'auto' }), { model: 'claude-sonnet-5-5', effort: 'high', permissionMode: 'auto' });
  assert.deepEqual(runOptions({}), {});
  assert.throws(() => runOptions({ model: 'gpt-5' }), /listed models/);
  assert.throws(() => runOptions({ effort: 'extreme' }), /effort/);
  assert.equal(runOptions({ permissionMode: 'bypassPermissions' }).permissionMode, 'bypassPermissions');
  assert.throws(() => runOptions({ permissionMode: 'dontAsk' }), /Dangerous, Manual, Auto, Plan/);
});

test('the main agent and a resumed run keep the model, effort and mode picked in the input', async () => {
  const store = new Store(temporary('opts')), desk = new Desk(store, { root: temporary('root') });
  desk.closed = true;
  const main = await desk.startMain({ prompt: 'hi', model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'plan' });
  assert.equal(main.model, 'claude-haiku-5-5'); assert.equal(main.effort, 'low'); assert.equal(main.permissionMode, 'plan');
  store.put('run', main.id, { ...main, state: 'finished' });
  await desk.resume(main.id, { prompt: 'again', effort: 'max', permissionMode: 'auto' });
  const run = store.get('run', main.id);
  assert.equal(run.effort, 'max'); assert.equal(run.permissionMode, 'auto'); assert.equal(run.model, 'claude-haiku-5-5', 'a choice not repeated is kept');
  assert.equal(desk.snapshot().choices.models.length, 4);
  await assert.rejects(desk.resume(main.id, { prompt: 'x', model: 'nope' }), /listed models/);
});

test('the Orca launcher passes effort and permission mode, and leaves Manual to Claude Code\'s own default', () => {
  const directory = temporary('launch'), spec = path.join(directory, 'agent.json');
  const probe = 'console.log("args=" + process.argv.slice(2).join(" ")); process.exit(0)';
  const launch = extra => { writeFileSync(spec, JSON.stringify({ runId: 'r', provider: 'claude', cwd: directory, prompt: 'Go', token: 't', mcpUrl: 'http://127.0.0.1:4317/mcp', addDir: 'ART', uploadsDir: 'UP',
    executable: { command: process.execPath, args: ['-e', probe, '--'] }, env: {}, unset: [], ...extra })); return spawnSync(process.execPath, [path.resolve('scripts/orca-agent.mjs'), spec], { encoding: 'utf8' }).stdout; };
  const auto = launch({ effort: 'high', permissionMode: 'auto' });
  assert.match(auto, /--effort high/); assert.match(auto, /--permission-mode auto/); assert.match(auto, /--add-dir ART UP/);
  assert.doesNotMatch(launch({ permissionMode: 'manual' }), /--permission-mode/);
  assert.doesNotMatch(launch({}), /--effort/);
});

test('an uploaded file is saved under the data folder, and the size limit and header are enforced', async () => {
  const app = await createApp({ dataDirectory: temporary('upload'), port: 0 });
  try {
    assert.equal((await fetch(`${app.address}/api/uploads?name=a.txt`, { method: 'POST', body: 'x' })).status, 403, 'needs the dashboard header');
    const response = await fetch(`${app.address}/api/uploads?name=${encodeURIComponent('../../evil name.txt')}`, { method: 'POST', headers: { 'x-rex-desk': '1' }, body: 'hello' });
    const saved = await response.json();
    assert.equal(saved.name, 'evil name.txt', 'path parts are stripped from the name');
    assert.ok(saved.path.startsWith(path.join(app.store.directory, 'uploads')));
    assert.equal(readFileSync(saved.path, 'utf8'), 'hello'); assert.equal(saved.size, 5);
    assert.ok(existsSync(saved.path));
  } finally { await app.close(); }
});

test('a room picture is stored, served back as the same bytes, and only pictures under 5 MB are accepted', async () => {
  const app = await createApp({ dataDirectory: temporary('roompic'), port: 0 });
  try {
    const room = app.desk.rooms.create('Pictures', []), png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const head = { 'x-rex-desk': '1', 'Content-Type': 'image/png' };
    assert.equal((await fetch(`${app.address}/api/rooms/${room.id}/image`, { method: 'POST', headers: { ...head, 'Content-Type': 'text/html' }, body: '<b>x</b>' })).status, 400);
    const saved = await (await fetch(`${app.address}/api/rooms/${room.id}/image`, { method: 'POST', headers: head, body: png })).json();
    assert.equal(saved.image, `${room.id}.png`);
    const back = Buffer.from(await (await fetch(`${app.address}/api/rooms/${room.id}/image`)).arrayBuffer());
    assert.ok(back.equals(png), 'the picture comes back unchanged');
    assert.equal((await fetch(`${app.address}/api/rooms/${room.id}`, { method: 'PUT', headers: { 'x-rex-desk': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) })).status, 200);
  } finally { await app.close(); }
});

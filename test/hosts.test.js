import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { hostAlive } from '../src/hosts.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('on Windows, agents run from a private copy of the app, so an update installs while they work', async () => {
  const { prepareRuntime, HostRunner } = await import('../src/hosts.js');
  const { mkdirSync, readFileSync } = await import('node:fs');
  const install = temporary('install'), runtime = path.join(temporary('data'), 'runtime');
  mkdirSync(path.join(install, 'node')); writeFileSync(path.join(install, 'node', 'node.exe'), 'node');
  mkdirSync(path.join(install, 'app', 'src'), { recursive: true }); writeFileSync(path.join(install, 'app', 'src', 'agent-host.js'), 'host');
  mkdirSync(path.join(install, 'app', '.local')); writeFileSync(path.join(install, 'app', '.local', 'log.txt'), 'not copied');
  const where = { execPath: path.join(install, 'node', 'node.exe'), appRoot: path.join(install, 'app'), platform: 'win32' };
  assert.equal(await prepareRuntime(runtime, { ...where, version: '' }), null, 'a checkout (no installed version) runs as before');
  assert.equal(await prepareRuntime(runtime, { ...where, version: '1.0.0', platform: 'darwin' }), null, 'only Windows needs it');
  const first = await prepareRuntime(runtime, { ...where, version: '1.0.0' });
  assert.equal(readFileSync(first.node, 'utf8'), 'node'); assert.equal(readFileSync(first.script, 'utf8'), 'host');
  assert.ok(first.node.startsWith(runtime) && !existsSync(path.join(first.cwd, '.local')));
  const second = await prepareRuntime(runtime, { ...where, version: '1.0.1' });
  assert.deepEqual(readdirSync(runtime), ['1.0.1'], 'the older copy goes once no agent uses it');

  // An agent started with the copy runs its program and script from there, and says so, so an update does not wait for it.
  const spawned = [], saved = [];
  const runner = new HostRunner({ run: { id: 'r1' } }, { directory: temporary('hosts'), runtime: second, onState: state => saved.push(state), spawner: (node, args, options) => { spawned.push({ node, args, options }); return { pid: 4242, unref() {} }; } });
  runner.follow = () => Promise.resolve();
  await runner.start('Go');
  assert.equal(spawned[0].node, second.node); assert.equal(spawned[0].args[0], second.script); assert.equal(spawned[0].options.cwd, second.cwd);
  assert.equal(saved.at(-1).outside, true);
});
const sdkModule = fileURLToPath(new URL('./fixtures/fake-sdk.mjs', import.meta.url));
const waitFor = async (check, what, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out waiting for ${what}`); };
const said = (store, runId) => store.events(runId, { visible: true }).filter(event => event.kind === 'agent-text').map(event => event.text);
function open(directory) {
  const store = new Store(directory), desk = new Desk(store, { root: path.dirname(directory) });
  desk.hostOptions = { sdkModule, pollMs: 50 }; desk.agents.ensureSignedIn = async () => {}; desk.mcpUrl = 'http://127.0.0.1:9/mcp';
  return { store, desk };
}

test('an agent in its own process keeps working through a Rex Desk restart, and its reply still arrives', async () => {
  const directory = path.join(temporary('host'), 'data'), release = path.join(path.dirname(directory), 'release');
  let { store, desk } = open(directory);
  const run = await desk.startWebTask(`compare prices release=${release}`);
  await waitFor(() => said(store, run.id).includes('step one'), 'the first step');
  const pid = store.get('run', run.id).host.pid;
  assert.ok(hostAlive(pid), 'the agent runs in a process of its own');

  // Rex Desk closes for an update: the agent's process keeps going.
  await desk.shutdown(); store.close();
  assert.ok(hostAlive(pid), 'closing Rex Desk leaves the agent working');
  ({ store, desk } = open(directory));
  assert.equal(store.get('run', run.id).reattach, 'host');
  desk.reattachHosts();
  writeFileSync(release, 'go');
  await waitFor(() => store.get('run', run.id).state === 'finished', 'the reply to finish');
  assert.deepEqual(said(store, run.id).filter(text => text.startsWith('step')), ['step one', 'step two']);
  assert.equal(store.get('run', run.id).host, undefined);
  await waitFor(() => !hostAlive(pid), 'the agent process to end');
  assert.deepEqual(readdirSync(path.join(directory, 'hosts')), [], 'the journal is cleaned up');
  await desk.shutdown(); store.close();
});

test('a question the agent was waiting on is asked again after a restart, and the answer reaches it', async () => {
  const directory = path.join(temporary('host-ask'), 'data');
  let { store, desk } = open(directory);
  store.saveConfig({ ...store.publicConfig(), permissionMode: 'default' });
  const run = await desk.startWebTask('please-ask-first');
  await waitFor(() => store.list('interaction').find(item => item.runId === run.id && item.state === 'pending'), 'the question');
  await desk.shutdown(); store.close();
  ({ store, desk } = open(directory)); desk.reattachHosts();
  const again = await waitFor(() => store.list('interaction').find(item => item.runId === run.id && item.state === 'pending'), 'the question to be asked again');
  desk.answer(again.id, { action: 'accept', content: {} });
  await waitFor(() => store.get('run', run.id).state === 'finished', 'the reply to finish');
  assert.ok(said(store, run.id).includes('answer was allow'));
  await desk.shutdown(); store.close();
});

test('Stop ends an agent that runs in its own process', async () => {
  const directory = path.join(temporary('host-stop'), 'data'), release = path.join(path.dirname(directory), 'never');
  const { store, desk } = open(directory);
  const run = await desk.startWebTask(`wait release=${release}`);
  await waitFor(() => said(store, run.id).includes('step one'), 'the first step');
  const pid = store.get('run', run.id).host.pid;
  await desk.stop(run.id);
  await waitFor(() => !hostAlive(pid), 'the agent process to end');
  assert.equal(store.get('run', run.id).state, 'stopped');
  await desk.shutdown(); store.close();
});

test('a message that arrives as the reply ends is not lost: it starts the next turn', async () => {
  const directory = path.join(temporary('host-late'), 'data'), release = path.join(path.dirname(directory), 'release');
  const { store, desk } = open(directory);
  const run = await desk.startWebTask(`compare prices release=${release}`);
  await waitFor(() => said(store, run.id).includes('step one'), 'the first step');
  // The agent takes no more steps that read messages, so this one waits in its process until the reply is over.
  await desk.say(run.id, 'one more thing');
  await waitFor(() => store.events(run.id).some(event => event.kind === 'inbox-delivered'), 'the message to reach the agent process');
  writeFileSync(release, 'go');
  await waitFor(() => store.events(run.id).some(event => event.kind === 'inbox-returned'), 'the unread message to come back');
  await waitFor(() => said(store, run.id).filter(text => text === 'step one').length === 2, 'the next turn to start with it');
  await desk.shutdown(); store.close();
});

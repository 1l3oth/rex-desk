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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('a turn cut off by a usage limit moves to another signed-in Claude account and continues', async () => {
  const store = new Store(temporary('acct')), turns = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'),
    runnerFactory: options => ({ start: async prompt => { turns.push({ env: options.agentEnv.CLAUDE_CONFIG_DIR || '', prompt }); if (turns.length === 1) options.event('agent-text', { text: 'Claude AI usage limit reached. Your limit resets at 5pm.' }); else options.event('agent-text', { text: 'Done.' }); }, interrupt() {}, close() {} }) });
  const first = temporary('claude1'), second = temporary('claude2');
  store.saveConfig({ ...store.publicConfig(), agentProfiles: { claude: first } });
  desk.agents.alternative = async (provider, current) => current === first ? { profile: second, label: 'claude2', account: 'second@example.com', plan: 'max' } : null;
  const run = await desk.startMain({ prompt: 'Hello' });
  const waitFor = async predicate => { for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };
  await waitFor(() => turns.length >= 2 && desk.run(run.id).state === 'finished');
  assert.equal(store.config().agentProfiles.claude, second);
  assert.match(turns[1].env, /claude2/);
  assert.ok(store.events(run.id, { limit: 50 }).some(event => event.kind === 'account-switched' && /second@example\.com/.test(event.text)));
  desk.closed = true;
});

test('with automatic switching off, a usage limit only tells the person', async () => {
  const store = new Store(temporary('acct-off')), turns = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'),
    runnerFactory: options => ({ start: async prompt => { turns.push(prompt); options.event('agent-text', { text: 'You have reached your weekly limit.' }); }, interrupt() {}, close() {} }) });
  store.put('accounts', 'auto', { id: 'auto', off: true });
  desk.agents.alternative = async () => { throw new Error('should not look for another account'); };
  const run = await desk.startMain({ prompt: 'Hello' });
  const waitFor = async predicate => { for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };
  await waitFor(() => desk.run(run.id).state === 'finished');
  assert.equal(turns.length, 1);
  assert.ok(store.events(run.id, { limit: 50 }).some(event => event.kind === 'account-limit'));
  desk.closed = true;
});

test('an agent moved to another Claude account takes its conversation along', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const pathModule = (await import('node:path')).default;
  const { carrySession } = await import('../src/agents.js');
  const root = mkdtempSync(pathModule.join(tmpdir(), 'carry-'));
  const first = pathModule.join(root, 'first'), second = pathModule.join(root, 'second'), cwd = pathModule.join(root, 'work');
  const folder = pathModule.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  mkdirSync(pathModule.join(first, 'projects', folder), { recursive: true }); mkdirSync(second, { recursive: true });
  writeFileSync(pathModule.join(first, 'projects', folder, 'abc.jsonl'), '{"hello":1}\n');
  const profiles = [{ profile: first }, { profile: second }];
  assert.equal(carrySession('abc', cwd, second, { profiles }), true);
  assert.equal(readFileSync(pathModule.join(second, 'projects', folder, 'abc.jsonl'), 'utf8'), '{"hello":1}\n');
  assert.equal(carrySession('abc', cwd, second, { profiles }), false, 'already there, nothing to copy');
  assert.equal(carrySession('missing', cwd, second, { profiles }), false);
  assert.ok(!existsSync(pathModule.join(second, 'projects', folder, 'missing.jsonl')));
});

test('a Codex turn cut off by a usage limit moves to another signed-in Codex account and continues with a handoff', async () => {
  const store = new Store(temporary('acct-codex')), turns = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'),
    runnerFactory: options => ({ start: async prompt => { turns.push({ env: options.agentEnv.CODEX_HOME || '', prompt }); if (turns.length === 1) options.event('agent-text', { text: "You've hit your usage limit. Try again later." }); else options.event('agent-text', { text: 'Done.' }); }, interrupt() {}, close() {} }) });
  const first = temporary('codex1'), second = temporary('codex2');
  store.saveConfig({ ...store.publicConfig(), provider: 'codex', agentProfiles: { codex: first } });
  desk.agents.alternative = async (provider, current) => provider === 'codex' && current === first ? { profile: second, label: 'codex2', account: 'second@example.com', plan: 'plus' } : null;
  const run = await desk.startMain({ prompt: 'Hello', provider: 'codex' });
  const waitFor = async predicate => { for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };
  await waitFor(() => turns.length >= 2 && desk.run(run.id).state === 'finished');
  assert.equal(store.config().agentProfiles.codex, second);
  assert.match(turns[1].env, /codex2/);
  assert.ok(store.events(run.id, { limit: 50 }).some(event => event.kind === 'account-switched' && /Codex/.test(event.text) && /second@example\.com/.test(event.text)));
  desk.closed = true;
});

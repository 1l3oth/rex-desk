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

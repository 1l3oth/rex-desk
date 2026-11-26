import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { canonical, AgentProfiles, inheritedProfile } from '../src/agents.js';

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

// L40: the switch kept working only once. Three limits in a row each move to a free account and say so; when none is free it
// says so and carries on at the reset; a second agent hitting the limit on the old account never marks the new one full.
const keyOf = value => canonical(value || '');
function threeAccounts(store, desk) {
  const accounts = [temporary('claudeA'), temporary('claudeB'), temporary('claudeC')], names = ['a@example.com', 'b@example.com', 'c@example.com'];
  store.saveConfig({ ...store.publicConfig(), agentProfiles: { claude: accounts[0] } });
  desk.agents.alternative = async (provider, current) => {
    const limited = store.get('accounts', 'limited')?.until || {};
    const index = accounts.findIndex(profile => keyOf(profile) !== keyOf(current) && !((limited[keyOf(profile)] || 0) > Date.now()));
    return index < 0 ? null : { profile: accounts[index], label: names[index], account: names[index] };
  };
  return { accounts, names };
}
const waitFor = async predicate => { for (let attempt = 0; attempt < 400; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };

test('three usage limits in a row switch three times, each time to a free account, and say so each time', async () => {
  const store = new Store(temporary('acct-three')), turns = [];
  let accounts;
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'),
    runnerFactory: options => ({ start: async () => {
      turns.push(options.agentEnv.CLAUDE_CONFIG_DIR || '');
      // Before the third limit, account A's window resets.
      if (turns.length === 3) { const record = store.get('accounts', 'limited'); const { [keyOf(accounts[0])]: _reset, ...rest } = record.until; store.put('accounts', 'limited', { ...record, until: rest }); }
      if (turns.length <= 3) options.event('agent-text', { text: 'Claude AI usage limit reached. Your limit resets at 5pm.' }); else options.event('agent-text', { text: 'Done.' });
    }, interrupt() {}, close() {} }) });
  ({ accounts } = threeAccounts(store, desk));
  const run = await desk.startMain({ prompt: 'Hello' });
  await waitFor(() => turns.length >= 4 && desk.run(run.id).state === 'finished');
  const used = turns.map(dir => accounts.findIndex(profile => keyOf(profile) === keyOf(dir)));
  assert.deepEqual(used, [0, 1, 2, 0], 'A, then B, then C, then A again after its reset');
  const switched = store.events(run.id, { limit: 100 }).filter(event => event.kind === 'account-switched');
  assert.equal(switched.length, 3, 'every switch is said in the chat');
  assert.match(switched[2].text, /a@example\.com/);
  desk.closed = true;
});

test('when every account is full the chat says so and carries on at the reset, never a silent stop', async () => {
  const store = new Store(temporary('acct-none')), turns = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'),
    runnerFactory: options => ({ start: async () => { turns.push(1); options.event('agent-text', { text: 'You have reached your weekly limit.' }); }, interrupt() {}, close() {} }) });
  threeAccounts(store, desk);
  const run = await desk.startMain({ prompt: 'Hello' });
  await waitFor(() => turns.length >= 3 && store.events(run.id, { limit: 100 }).some(event => event.kind === 'account-limit'));
  await waitFor(() => desk.run(run.id).state === 'finished');
  assert.equal(turns.length, 3, 'A, B and C each tried once');
  const notice = store.events(run.id, { limit: 100 }).find(event => event.kind === 'account-limit');
  assert.match(notice.text, /Every signed-in Claude( Code)? account has hit its usage limit. It carries on by itself at/);
  assert.ok(desk.run(run.id).resumeAt, 'a time to carry on is set');
  desk.closed = true;
});

test('a second agent hitting the limit on the old account does not mark the new account full', async () => {
  const store = new Store(temporary('acct-second')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), runnerFactory: () => ({ start: async () => {}, interrupt() {}, close() {} }) });
  const { accounts } = threeAccounts(store, desk);
  // The first agent already moved everyone to B; the second agent's turn had started on A and now hits A's limit.
  store.saveConfig({ ...store.publicConfig(), agentProfiles: { claude: accounts[1] } });
  store.put('accounts', 'limited', { id: 'limited', until: { [keyOf(accounts[0])]: Date.now() + 3600000 } });
  const started = new Date(Date.now() - 5000).toISOString();
  store.put('run', 'second', { id: 'second', role: 'coordinator', main: true, provider: 'claude', state: 'running', turnStartedAt: started, turnAccount: accounts[0], createdAt: started });
  store.event('second', 'agent-text', { text: 'Claude AI usage limit reached.' }, true);
  desk.drain = async () => {};
  assert.equal(await desk.switchIfLimited('second'), true);
  const limited = store.get('accounts', 'limited').until;
  assert.ok(!limited[keyOf(accounts[1])], 'B is still free');
  assert.equal(keyOf(store.config().agentProfiles.claude), keyOf(accounts[1]), 'it moves to B, the free one');
  desk.closed = true;
});

// L119: a saved AI profile whose folder later disappears must not block other settings saves, must fall back to the default,
// and the account tab shows a note. A folder the person chooses now that does not exist is still refused.
test('L119: a saved Codex profile whose folder is gone does not block switching the Claude account', () => {
  const store = new Store(temporary('l119-save'));
  const claude1 = temporary('c1'), claude2 = temporary('c2'), codexDir = path.join(temporary('codexroot'), 'codex-work');
  mkdirSync(codexDir, { recursive: true });
  store.saveConfig({ ...store.publicConfig(), agentProfiles: { claude: claude1, codex: codexDir } });
  rmSync(codexDir, { recursive: true, force: true }); // the Codex folder later disappears
  // The exact save that "Use" on another Claude account (and auto-switch) make: it must not throw now.
  assert.doesNotThrow(() => store.saveConfig({ ...store.publicConfig(), agentProfiles: { ...store.config().agentProfiles, claude: claude2 } }));
  assert.equal(store.config().agentProfiles.claude, claude2, 'the Claude switch took');
  assert.equal(store.config().agentProfiles.codex, path.resolve(codexDir), 'the gone Codex profile is kept, not blanked or throwing');
});

test('L119: choosing a folder that does not exist is still refused', () => {
  const store = new Store(temporary('l119-refuse'));
  const gone = path.join(temporary('nope'), 'never-made');
  assert.throws(() => store.saveConfig({ ...store.publicConfig(), agentProfiles: { codex: gone } }), /folder does not exist/);
});

test('L119: an agent falls back to the default when its saved profile folder is gone', () => {
  const store = new Store(temporary('l119-sel')), agents = new AgentProfiles(store);
  const codexDir = path.join(temporary('codexroot2'), 'codex-work');
  mkdirSync(codexDir, { recursive: true });
  store.saveConfig({ ...store.publicConfig(), agentProfiles: { codex: codexDir } });
  rmSync(codexDir, { recursive: true, force: true });
  assert.equal(agents.selected('codex'), inheritedProfile('codex'), 'a gone profile falls back to the inherited default, so agents still start');
  assert.notEqual(agents.selected('codex'), path.resolve(codexDir));
});

test('L119: auto-switch on a Claude usage limit still works when a saved Codex folder is gone', async () => {
  const store = new Store(temporary('l119-auto')), turns = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'),
    runnerFactory: options => ({ start: async prompt => { turns.push({ env: options.agentEnv.CLAUDE_CONFIG_DIR || '', prompt }); if (turns.length === 1) options.event('agent-text', { text: 'Claude AI usage limit reached. Your limit resets at 5pm.' }); else options.event('agent-text', { text: 'Done.' }); }, interrupt() {}, close() {} }) });
  const first = temporary('claude1'), second = temporary('claude2'), codexDir = path.join(temporary('codexroot3'), 'codex-work');
  mkdirSync(codexDir, { recursive: true });
  store.saveConfig({ ...store.publicConfig(), agentProfiles: { claude: first, codex: codexDir } });
  rmSync(codexDir, { recursive: true, force: true }); // the gone Codex profile that used to break every switch
  desk.agents.alternative = async (provider, current) => current === first ? { profile: second, label: 'claude2', account: 'second@example.com', plan: 'max' } : null;
  const run = await desk.startMain({ prompt: 'Hello' });
  const waitFor = async predicate => { for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };
  await waitFor(() => turns.length >= 2 && desk.run(run.id).state === 'finished');
  assert.equal(store.config().agentProfiles.claude, second, 'the auto-switch moved the Claude account');
  assert.equal(store.config().agentProfiles.codex, path.resolve(codexDir), 'the gone Codex profile stayed, it did not block the switch');
  desk.closed = true;
});

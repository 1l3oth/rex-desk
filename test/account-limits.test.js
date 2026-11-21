import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { AgentProfiles } from '../src/agents.js';

test("an account that hit its limit is skipped until Claude's reset time, and choosing it clears that", () => {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-limits-'))), agents = new AgentProfiles(store);
  const until = profile => Object.entries(store.get('accounts', 'limited').until).find(([key]) => key.endsWith(profile))?.[1];
  try {
    const soon = Date.now() + 10 * 60000;
    agents.markLimited('C:\\Users\\me\\.config\\claude2', soon);
    assert.equal(until('claude2'), soon, 'limited until the reset Claude reported, not 5 hours');
    agents.markLimited('C:\\Users\\me\\.config\\claude1');
    assert.ok(Math.abs(until('claude1') - (Date.now() + 5 * 3600000)) < 5000, 'without a reported reset: 5 hours');
    agents.markLimited('C:\\Users\\me\\.config\\claude3', Date.now() - 1000);
    assert.ok(until('claude3') > Date.now() + 4 * 3600000, 'a reset time already past is not trusted');
    agents.clearLimited('C:\\Users\\me\\.config\\claude2');
    assert.equal(until('claude2'), undefined, 'the person picked it: the mark is gone');
    assert.ok(until('claude1'), 'the other marks stay');
  } finally { store.close(); }
});

test('the first-run sign-in runs hidden and reports how far it got, without the CLI output', async () => {
  const { EventEmitter } = await import('node:events');
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-signin-'))), calls = [];
  const agents = new AgentProfiles(store, { spawnHidden: (...args) => { calls.push(args); return child; } });
  try {
    const started = agents.loginHidden({ provider: 'claude', profile: '', executable: { command: 'claude', args: [] }, found: false, install: 'install-claude', name: 'Claude', env: {}, args: ['auth', 'login'] });
    assert.deepEqual([started.started, started.installing, started.background], [true, true, true]);
    assert.equal(calls[0][2].windowsHide, true, 'no window shows');
    assert.equal(agents.loginJob('claude').state, 'installing');
    child.stdout.emit('data', 'installed\nREXDESK-SIGNIN-STARTS\nSee https://evil.example.com/claude.ai/oauth for help\n');
    assert.equal(agents.loginJob('claude').url, '', 'a link on an unknown host is never offered as the sign-in page');
    child.stdout.emit('data', 'See https://chatgpt.com/auth for ChatGPT\n');
    assert.equal(agents.loginJob('claude').url, '', "another AI's sign-in page is not offered for Claude");
    child.stdout.emit('data', 'Open https://claude.ai/oauth?code=1. to sign in\n');
    assert.deepEqual([agents.loginJob('claude').state, agents.loginJob('claude').url], ['signing-in', 'https://claude.ai/oauth?code=1']);
    assert.equal(agents.loginJob('claude').output, undefined, 'the output can hold an account name, so the page never gets it');
    child.emit('exit', 1);
    assert.equal(agents.loginJob('claude').state, 'failed'); assert.match(agents.loginJob('claude').error, /did not finish/);
    assert.equal(agents.loginJob('codex').state, 'none');
  } finally { store.close(); }
});

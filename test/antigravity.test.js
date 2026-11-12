import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient, AntigravityRunner, antigravityModels, antigravityMode, parseAgyModels } from '../src/antigravity.js';
import { aiProvider, providerTitle } from '../src/codex.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agy.mjs');
const factory = options => new AcpClient({ ...options, spawnProcess: (command, args, spawnOptions) => spawn(process.execPath, [fake, ...args], spawnOptions) });
const runner = (run, extra = {}) => {
  const events = [], asks = [];
  const item = new AntigravityRunner({ run, cwd: os.tmpdir(), agentEnv: process.env, clientFactory: factory, model: 'gemini-3.8-flash', event: (kind, data) => events.push({ kind, data }),
    ask: async request => { asks.push(request); return { action: extra.answer || 'accept' }; }, ...extra });
  return { item, events, asks };
};

test('Gemini is a third AI provider', () => {
  assert.equal(aiProvider('gemini'), 'gemini');
  assert.equal(providerTitle('gemini'), 'Gemini (Antigravity)');
  assert.throws(() => aiProvider('other'));
  assert.equal(antigravityMode('acceptEdits'), 'accept-edits');
  assert.equal(antigravityMode('bypassPermissions'), '');
});

test('a Gemini turn streams text, tools and the result, and asks before a tool in Manual mode', async () => {
  const { item, events, asks } = runner({ permissionMode: 'manual', effort: 'max' });
  await item.start('hello');
  const kinds = events.map(event => event.kind);
  assert.deepEqual(kinds.filter(kind => kind !== 'context'), ['session', 'agent-text', 'agent-tool', 'agent-tool-result', 'agent-text', 'agent-result']);
  assert.equal(events[0].data.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(asks.length, 1);
  assert.match(asks[0].title, /git --version/);
  assert.equal(events.find(event => event.kind === 'agent-tool').data.tool, 'run_command');
  assert.equal(events.find(event => event.kind === 'agent-tool-result').data.failed, false);
  const result = events.find(event => event.kind === 'agent-result').data;
  assert.equal(result.result, 'Checking done: hello [initialize,session/new,session/set_config_option,session/set_config_option,session/set_config_option,session/prompt]');
  assert.deepEqual(result.tokens, { input: 900, output: 20, cacheRead: 100, cacheWrite: 0 });
  assert.equal(events.find(event => event.kind === 'context').data.used, 1000);
});

test('a declined Gemini tool is reported as failed', async () => {
  const { item, events } = runner({ permissionMode: 'manual' }, { answer: 'decline' });
  await item.start('hi');
  assert.equal(events.find(event => event.kind === 'agent-tool-result').data.failed, true);
});

test('Dangerous mode starts agy with every tool approved and asks nothing; a saved session is resumed', async () => {
  const { item, events, asks } = runner({ permissionMode: 'bypassPermissions', sessionId: 'abcdabcd-0000-0000-0000-000000000000' });
  await item.start('again');
  assert.equal(asks.length, 0);
  const result = events.find(event => event.kind === 'agent-result').data.result;
  assert.match(result, /session\/resume/);
  assert.doesNotMatch(result, /session\/new/);
  assert.match(result, / skip$/);
  assert.equal(events[0].data.sessionId, 'abcdabcd-0000-0000-0000-000000000000');
});

test('Antigravity models come from the account, and agy models output means signed in', async () => {
  const items = await antigravityModels({ clientFactory: factory });
  assert.deepEqual(items.map(item => item.id), ['gemini-3.8-flash', 'claude-sonnet-4-6']);
  assert.deepEqual(parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n').map(item => item.id), ['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
  assert.deepEqual(parseAgyModels('Error: authentication required'), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient, AntigravityRunner, antigravityModels, antigravityMode, autoUnsupported, parseAgyModels } from '../src/antigravity.js';
import { aiProvider, providerTitle } from '../src/codex.js';
import { modesFor, effortsFor, runOptions, defaultModeFor } from '../src/choices.js';
import { antigravityTool } from '../src/antigravity.js';

test("Gemini's commands and file reads show what they did, and commands reach the terminal panel", () => {
  // Real tool calls from a Gemini (Antigravity) chat.
  const command = antigravityTool('run_command', { CommandLine: 'cd "D:\\dev\\x"; node render.mjs stills 1', WaitMsBeforeAsync: 10000, toolSummary: 'Test render.mjs stills 1' }, 'win32');
  assert.equal(command.tool, 'PowerShell', 'a shell command, so its output shows in the terminal');
  assert.equal(command.input.command, 'cd "D:\\dev\\x"; node render.mjs stills 1');
  assert.equal(command.input.description, 'Test render.mjs stills 1', 'the step line says what the command is for');
  assert.equal(antigravityTool('run_command', { CommandLine: 'ls' }, 'darwin').tool, 'Bash');
  assert.deepEqual(antigravityTool('read_file', { Path: 'D:\\dev\\x\\package.json', StartLine: 1 }), { tool: 'Read', input: { Path: 'D:\\dev\\x\\package.json', StartLine: 1, file_path: 'D:\\dev\\x\\package.json' } });
  assert.equal(antigravityTool('write_to_file', { TargetFile: 'D:\\dev\\x\\a.ts' }).input.file_path, 'D:\\dev\\x\\a.ts');
  assert.deepEqual(antigravityTool('manage_task', { Action: 'status' }), { tool: 'manage_task', input: { Action: 'status' } }, 'other tools stay as they are');
});

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
  assert.deepEqual(kinds.filter(kind => kind !== 'context' && kind !== 'agent-text-partial'), ['session', 'agent-text', 'agent-tool', 'agent-tool-result', 'agent-text', 'agent-result']);
  assert.equal(events[0].data.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(asks.length, 1);
  assert.match(asks[0].title, /git --version/);
  assert.equal(events.find(event => event.kind === 'agent-tool').data.tool, process.platform === 'win32' ? 'PowerShell' : 'Bash', 'run_command shows as a terminal command');
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

test('a Gemini agent with no mode set runs as Dangerous, like Claude, and asks nothing', async () => {
  const { item, events, asks } = runner({});
  await item.start('go');
  assert.equal(asks.length, 0);
  assert.match(events.find(event => event.kind === 'agent-result').data.result, / skip$/);
});

test('Antigravity models come from the account, and agy models output means signed in', async () => {
  const items = await antigravityModels({ clientFactory: factory });
  assert.deepEqual(items.map(item => item.id), ['gemini-3.8-flash', 'claude-sonnet-4-6']);
  assert.deepEqual(parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n').map(item => item.id), ['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
  assert.deepEqual(parseAgyModels('Error: authentication required'), []);
});

test("Rex Desk's own tools run without asking in Manual mode; other MCP tools still ask", async () => {
  const asks = [];
  const item = new AntigravityRunner({ run: { permissionMode: 'manual' }, ask: async request => { asks.push(request); return { action: 'accept' }; } });
  const options = [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }];
  const own = await item.request('session/request_permission', { toolCall: { title: 'MCP Tool desk_message', rawInput: { ServerName: 'rex_desk', ToolName: 'desk_message', Arguments: { text: 'hi' } } }, options });
  assert.equal(own.outcome.optionId, 'allow');
  assert.equal(asks.length, 0);
  await item.request('session/request_permission', { toolCall: { title: 'MCP Tool other', rawInput: { ServerName: 'github', ToolName: 'create_issue' } }, options });
  assert.equal(asks.length, 1);
});

test('Gemini offers its own modes and efforts, not the Claude list', () => {
  assert.deepEqual(modesFor('gemini').map(item => item.label), ['Dangerous', 'Auto', 'Accept edits', 'Ask first', 'Plan']);
  assert.ok(modesFor('gemini').every(item => antigravityMode(item.id) || item.id === 'bypassPermissions'));
  assert.deepEqual(effortsFor('gemini'), ['low', 'medium', 'high']);
  assert.throws(() => runOptions({ provider: 'gemini', effort: 'max' }));
  assert.equal(runOptions({ provider: 'claude', effort: 'max' }).effort, 'max');
});

test('the default mode from Settings is used when nobody picked one, and an AI without it asks first', () => {
  assert.equal(defaultModeFor('claude', ''), 'auto');
  assert.equal(defaultModeFor('gemini', 'auto'), 'auto');
  assert.equal(defaultModeFor('codex', 'auto'), 'manual');
  assert.equal(defaultModeFor('codex', 'plan'), 'plan');
});

test('when agy refuses Auto mode, the turn goes on in Accept edits with one quiet step, and later turns skip Auto', async () => {
  AntigravityRunner.autoRefused = false;
  const agentEnv = { ...process.env, FAKE_AGY_NO_AUTO: '1' };
  const first = runner({ permissionMode: 'auto' }, { agentEnv });
  assert.deepEqual(await first.item.start('hi'), { status: 'completed' }, 'the turn does not fail');
  assert.match(first.events.find(event => event.kind === 'agent-result').data.result, /modes=accept-edits$/);
  const notes = first.events.filter(event => event.kind === 'agent-tool' && event.data.tool === 'Mode');
  assert.equal(notes.length, 1);
  assert.match(notes[0].data.input.description, /Accept edits/);
  assert.equal(first.events.some(event => event.kind === 'error'), false, 'no red error card');
  const second = runner({ permissionMode: 'auto' }, { agentEnv });
  await second.item.start('again');
  assert.equal(second.events.some(event => event.data?.tool === 'Mode'), false, 'the note shows once');
  assert.match(second.events.find(event => event.kind === 'agent-result').data.result, /modes=accept-edits$/);
  AntigravityRunner.autoRefused = false;
  const fine = runner({ permissionMode: 'auto' }, { agentEnv: { ...process.env, FAKE_AGY_NO_AUTO: '' } });
  await fine.item.start('ok');
  assert.equal(fine.events.some(event => event.data?.tool === 'Mode'), false, 'Auto stays when agy accepts it');
});

test('a Gemini Auto error that is not a refusal does not turn Auto off for later turns', async () => {
  AntigravityRunner.autoRefused = false;
  const hiccup = runner({ permissionMode: 'auto' }, { agentEnv: { ...process.env, FAKE_AGY_NO_AUTO: 'Internal error' } });
  assert.deepEqual(await hiccup.item.start('hi'), { status: 'completed' }, 'this turn still goes on in Accept edits');
  assert.equal(AntigravityRunner.autoRefused, false, 'Auto is tried again next turn');
  const next = runner({ permissionMode: 'auto' }, { agentEnv: { ...process.env, FAKE_AGY_NO_AUTO: '' } });
  await next.item.start('again');
  assert.equal(next.events.some(event => event.data?.tool === 'Mode'), false, 'Auto works again');
  assert.equal(autoUnsupported(new Error('Antigravity session/set_config_option timed out.')), false);
  assert.equal(autoUnsupported(new Error('Auto mode is not available: it needs the OS terminal sandbox')), true);
  assert.equal(autoUnsupported(new Error('unsupported mode: auto')), true);
  assert.equal(autoUnsupported(new Error('Auto sandbox initialization failed')), false, 'a passing sandbox failure is not a refusal');
});

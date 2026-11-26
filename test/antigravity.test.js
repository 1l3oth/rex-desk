import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { AcpClient, AntigravityRunner, antigravityModels, antigravityMode, autoUnsupported, parseAgyModels, ensureAntigravityMcp, antigravityMcpInstalled, antigravityMcpPath, antigravityMcpEntry, installedPayload } from '../src/antigravity.js';
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

const tempHome = () => mkdtempSync(path.join(os.tmpdir(), 'rex-gemini-'));

test('Rex Desk adds its own rex_desk entry to agy MCP list when the file is empty', () => {
  const home = tempHome();
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  writeFileSync(antigravityMcpPath(home), ''); // the real bug: an empty file
  assert.equal(antigravityMcpInstalled(home), false);
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), true);
  assert.equal(antigravityMcpInstalled(home), true);
  const data = JSON.parse(readFileSync(antigravityMcpPath(home), 'utf8'));
  assert.deepEqual(data.mcpServers.rex_desk, antigravityMcpEntry({ node: 'node', root: 'D:/rex' }));
});

test('adding rex_desk keeps every other MCP server and backs up the old file', () => {
  const home = tempHome();
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  const before = { mcpServers: { other: { command: 'x', args: ['y'] } }, extra: 1 };
  writeFileSync(antigravityMcpPath(home), JSON.stringify(before));
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), true);
  const data = JSON.parse(readFileSync(antigravityMcpPath(home), 'utf8'));
  assert.deepEqual(data.mcpServers.other, { command: 'x', args: ['y'] }, 'the other server is kept');
  assert.equal(data.extra, 1, 'other keys are kept');
  assert.ok(data.mcpServers.rex_desk, 'rex_desk is added');
  assert.deepEqual(JSON.parse(readFileSync(antigravityMcpPath(home) + '.bak', 'utf8')), before, 'the old file is backed up');
});

test('the write is idempotent: no rewrite when the entry already matches', () => {
  const home = tempHome();
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), true);
  assert.equal(antigravityMcpInstalled(home), true);
  const first = readFileSync(antigravityMcpPath(home), 'utf8');
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), true, 'already-right entry returns true');
  assert.equal(readFileSync(antigravityMcpPath(home), 'utf8'), first, 'no rewrite when the entry already matches');
});

// Review 8db54fc5 (1): the person's file is their own. A broken or unreadable file is never treated as empty and wiped.
test('a broken MCP file is kept untouched, not wiped, because its unparseable servers would be lost', () => {
  const home = tempHome();
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  const broken = '{ "mcpServers": { "other": { "command": "x" }'; // user data, but truncated/invalid JSON
  writeFileSync(antigravityMcpPath(home), broken);
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), false, 'reports not installed instead of destroying the file');
  assert.equal(readFileSync(antigravityMcpPath(home), 'utf8'), broken, 'the broken file is left exactly as it was');
});

test('the recovery backup is written once and never clobbered by a later run', () => {
  const home = tempHome();
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  const before = { mcpServers: { other: { command: 'x', args: ['y'] } } };
  writeFileSync(antigravityMcpPath(home), JSON.stringify(before));
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), true);
  const bak = readFileSync(antigravityMcpPath(home) + '.bak', 'utf8');
  assert.deepEqual(JSON.parse(bak), before, 'first run saves the original as the recovery copy');
  // A later run writes a different entry but must not overwrite the known-good recovery copy.
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/other' }), true);
  assert.equal(readFileSync(antigravityMcpPath(home) + '.bak', 'utf8'), bak, 'the recovery copy is unchanged');
});

test('an unreadable config (a directory in its place) is never wiped', () => {
  const home = tempHome();
  mkdirSync(antigravityMcpPath(home), { recursive: true }); // a directory where the file should be: reading throws
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), false, 'reports not installed instead of destroying it');
  assert.equal(existsSync(antigravityMcpPath(home)), true, 'what was there is left in place');
});

// Review 8db54fc5 (2): the entry must survive updates and work when agy runs it on its own.
test('the entry carries the stable data folder so the proxy finds the sign-in key outside Rex Desk', () => {
  const entry = antigravityMcpEntry({ node: 'node', root: 'D:/rex', env: { REX_DATA_DIR: 'D:/data' } });
  assert.deepEqual(entry.env, { REX_DATA_DIR: 'D:/data' });
  assert.equal(entry.args[0], path.join('D:/rex', 'src', 'stdio.js'));
});

test('installedPayload points at the stable install, not the running runtime copy, only when the files are really there', () => {
  const tmp = tempHome();
  // No REX_DESK_EXE: fall back to the running copy's paths.
  assert.equal(installedPayload({}, 'node'), null);
  // A faked flat install dir with a node binary and src/stdio.js beside the program.
  const install = path.join(tmp, 'install');
  mkdirSync(path.join(install, 'src'), { recursive: true });
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  writeFileSync(path.join(install, nodeName), '');
  writeFileSync(path.join(install, 'src', 'stdio.js'), '');
  const found = installedPayload({ REX_DESK_EXE: path.join(install, 'Rex Desk.exe') }, path.join('C:/runtime/node', nodeName));
  assert.deepEqual(found, { node: path.join(install, nodeName), root: install });
  // A wrong guess (no stdio.js there) returns null, so the caller keeps the running copy's path.
  assert.equal(installedPayload({ REX_DESK_EXE: path.join(tmp, 'empty', 'Rex Desk.exe') }, 'node'), null);
});

test('ensureAntigravityMcp creates the config folder when it does not exist', () => {
  const home = tempHome();
  assert.equal(existsSync(path.join(home, '.gemini', 'config')), false);
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), true);
  assert.equal(antigravityMcpInstalled(home), true);
});

// Review e1711ee8 (1): read and replace are coordinated by a lock, so a live writer never has its entry overwritten.
test('a live writer holding the lock makes ensureAntigravityMcp leave the file untouched', () => {
  const home = tempHome();
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  const before = JSON.stringify({ mcpServers: { other: { command: 'x', args: ['y'] } } });
  const file = antigravityMcpPath(home);
  writeFileSync(file, before);
  writeFileSync(file + '.lock', String(process.pid)); // this live process "holds" the lock
  try {
    assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), false, 'does not write while another writer holds the lock');
    assert.equal(readFileSync(file, 'utf8'), before, 'the file is left exactly as it was');
  } finally { writeFileSync(file + '.lock', ''); }
  // A stale lock (an owner that is gone) is cleared and the write goes through.
  writeFileSync(file + '.lock', '999999999'); // a pid that is not running
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), true, 'a stale lock does not block forever');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).mcpServers.rex_desk, 'rex_desk is added after the stale lock is cleared');
  assert.equal(existsSync(file + '.lock'), false, 'the lock is released');
});

// Review e1711ee8 (2): a rex_desk entry the person owns (not this proxy) keeps its command, args and env.
test('a user-owned rex_desk entry is kept untouched', () => {
  const home = tempHome();
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  const mine = { command: 'my-own-server', args: ['serve', '--port', '9'], env: { MINE: '1' } };
  writeFileSync(antigravityMcpPath(home), JSON.stringify({ mcpServers: { rex_desk: mine } }));
  assert.equal(ensureAntigravityMcp({ home, node: 'node', root: 'D:/rex' }), true);
  assert.deepEqual(JSON.parse(readFileSync(antigravityMcpPath(home), 'utf8')).mcpServers.rex_desk, mine, 'the person-owned entry is left exactly as it was');
  assert.equal(existsSync(antigravityMcpPath(home) + '.bak'), false, 'nothing was rewritten, so no backup was made');
});

// Review e1711ee8 (3): the lookup finds the real shipped payload/app beside payload/node (main.rs:407-410).
test('installedPayload finds the shipped payload/app and payload/node layout', () => {
  const tmp = tempHome();
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const app = path.join(tmp, 'payload', 'app');
  mkdirSync(path.join(app, 'src'), { recursive: true });
  mkdirSync(path.join(tmp, 'payload', 'node'), { recursive: true });
  writeFileSync(path.join(app, 'src', 'stdio.js'), '');
  writeFileSync(path.join(tmp, 'payload', 'node', nodeName), '');
  const found = installedPayload({ REX_DESK_EXE: path.join(tmp, 'Rex Desk.exe') }, path.join('C:/runtime/node', nodeName));
  assert.deepEqual(found, { node: path.join(tmp, 'payload', 'node', nodeName), root: app });
});

// Review e1711ee8 (4): the entry carries this desk's real address, so a standalone agy run does not fall back to 4317.
test('the entry carries REX_DESK_URL so a standalone run reaches the real port', () => {
  const entry = antigravityMcpEntry({ node: 'node', root: 'D:/rex', env: { REX_DESK_URL: 'http://127.0.0.1:4319/mcp', REX_DATA_DIR: 'D:/data' } });
  assert.deepEqual(entry.env, { REX_DATA_DIR: 'D:/data', REX_DESK_URL: 'http://127.0.0.1:4319/mcp' });
  const none = antigravityMcpEntry({ node: 'node', root: 'D:/rex', env: {} });
  assert.equal(none.env, undefined, 'no env is written when there is nothing to carry');
});

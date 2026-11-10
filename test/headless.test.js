import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { ClaudeRunner } from '../src/runners.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const SESSION = '7c3a8d71-d78d-409a-9a84-91fb162c1be3';
const fakeSdk = (messages, seen) => ({ query: ({ prompt, options }) => { seen.push({ prompt, options }); return (async function* () { for (const message of messages) yield message; })(); } });
const turn = [{ type: 'system', subtype: 'init', session_id: SESSION },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Hello there' }] } },
  { type: 'result', subtype: 'success', result: 'ok', is_error: false }];
const runnerFor = (run, seen, events = []) => new ClaudeRunner({ sdk: fakeSdk(turn, seen), run: { id: 'r', role: 'worker', ...run }, cwd: 'x', token: 't', mcpUrl: 'http://127.0.0.1:1/mcp',
  event: (kind, data) => events.push([kind, data]), ask: async () => ({ action: 'accept' }), controller: new AbortController(), uploadsDirectory: 'UP' });

test('headless Claude Code starts dangerous, speaks in the chat, and a hook still refuses Claude-home writes', async () => {
  const seen = [], events = [];
  await runnerFor({ effort: 'high' }, seen, events).start('Go');
  const { options } = seen[0];
  assert.equal(options.permissionMode, 'bypassPermissions'); assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.equal(options.effort, 'high'); assert.deepEqual(options.disallowedTools, ['AskUserQuestion']); assert.ok(options.additionalDirectories.includes('UP'));
  assert.equal(options.resume, undefined);
  assert.ok(events.some(([kind, data]) => kind === 'agent-text' && data.text === 'Hello there'), 'what the agent says reaches the chat');
  assert.ok(events.some(([kind, data]) => kind === 'session' && data.sessionId === SESSION));
  const hook = options.hooks.PreToolUse[0].hooks[0];
  assert.equal((await hook({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/flow/.claude/CLAUDE.md' } })).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await hook({ tool_name: 'Write', tool_input: { file_path: 'F:/project/a.txt' } }), {});
});

test('Manual mode asks through the dashboard, and only a real session id is resumed', async () => {
  const seen = [];
  await runnerFor({ permissionMode: 'manual', sessionId: SESSION }, seen).start('Go');
  assert.equal(seen[0].options.permissionMode, 'default'); assert.equal(seen[0].options.allowDangerouslySkipPermissions, undefined); assert.equal(seen[0].options.resume, SESSION);
  await runnerFor({ sessionId: 'orca:term_1' }, seen).start('Go');
  assert.equal(seen[1].options.resume, undefined, 'an old terminal handle is not a session');
  await runnerFor({ permissionMode: 'plan' }, seen).start('Go');
  assert.equal(seen[2].options.permissionMode, 'plan');
});

test('a message sent while the agent works waits for the end of the turn, then goes in as the next one', async () => {
  const store = new Store(temporary('queue')), starts = [];
  const desk = new Desk(store, { root: temporary('root'), runnerFactory: options => ({ start: prompt => new Promise(resolve => starts.push({ options, prompt, release: resolve })), interrupt() {}, close() {} }) });
  const waitFor = async predicate => { for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };
  try {
    const main = await desk.startMain({ prompt: 'hi' });
    assert.equal(main.execution, 'headless');
    await waitFor(() => starts.length === 1);
    assert.deepEqual(await desk.say(main.id, 'also check the export'), { queued: true });
    assert.deepEqual(store.get('run', main.id).queued, ['also check the export']);
    starts[0].release();
    await waitFor(() => starts.length === 2);
    assert.match(starts[1].prompt, /also check the export/);
    assert.deepEqual(store.get('run', main.id).queued, []);
    assert.equal(store.events(main.id, { visible: true }).filter(item => item.kind === 'human-message' && /export/.test(item.text)).length, 1, 'the message shows once');
    starts[1].release();
    await waitFor(() => store.get('run', main.id).state === 'finished');
    assert.deepEqual(await desk.say(main.id, 'and one more thing'), { sent: true });
    await waitFor(() => starts.length === 3);
    assert.match(starts[2].prompt, /one more thing/);
    starts[2].release();
  } finally { await desk.shutdown(); store.close(); }
});

test('an agent\'s tool calls reach the chat as short steps, without file contents', async () => {
  const seen = [], events = [];
  const messages = [{ type: 'system', subtype: 'init', session_id: SESSION },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__rex_desk_run__desk_create_specialist', input: { project: 'authentication', name: 'Dara', rules: 'Never read .env' } },
      { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'F:/p/a.txt', content: 'SECRET FILE CONTENTS' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'Permission denied' }] }] } },
    { type: 'result', subtype: 'success', result: 'ok', is_error: false }];
  await new ClaudeRunner({ sdk: fakeSdk(messages, seen), run: { id: 'r', role: 'coordinator' }, cwd: 'x', token: 't', mcpUrl: 'http://127.0.0.1:1/mcp', event: (kind, data) => events.push([kind, data]), ask: async () => ({ action: 'accept' }), controller: new AbortController() }).start('Go');
  const steps = events.filter(([kind]) => kind === 'agent-tool').map(([, data]) => data);
  assert.equal(steps[0].tool, 'desk_create_specialist'); assert.equal(steps[0].input.name, 'Dara');
  assert.equal(steps[1].tool, 'Write'); assert.equal(steps[1].input.file_path, 'F:/p/a.txt'); assert.ok(!JSON.stringify(steps[1]).includes('SECRET FILE CONTENTS'), 'contents are never shown');
  assert.equal(steps[2].failed, true); assert.match(steps[2].text, /Permission denied/);
});

test('a resumed headless session is given only what is new, not the whole startup prompt again', async () => {
  const store = new Store(temporary('followup')), starts = [];
  const desk = new Desk(store, { root: temporary('root'), runnerFactory: options => ({ start: prompt => new Promise(resolve => { starts.push({ prompt, release: resolve }); options.event('session', { sessionId: SESSION }); }), interrupt() {}, close() {} }) });
  const waitFor = async predicate => { for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };
  try {
    const main = await desk.startMain({ prompt: 'hi' });
    await waitFor(() => starts.length === 1);
    assert.match(starts[0].prompt, /main agent of Rex Desk/, 'the first turn carries the startup prompt');
    starts[0].release(); await waitFor(() => store.get('run', main.id).state === 'finished');
    await desk.resume(main.id, { prompt: 'next question' });
    await waitFor(() => starts.length === 2);
    assert.match(starts[1].prompt, /next question$/); assert.ok(!/main agent of Rex Desk/.test(starts[1].prompt), 'not the whole startup prompt again');
    assert.match(starts[1].prompt, /Reply like a teammate in a chat/, 'a short reminder of the chat style');
    starts[1].release();
  } finally { await desk.shutdown(); store.close(); }
});

test('after a restart, headless agents that were just cut off pick their session up again; older and terminal ones do not', async () => {
  const store = new Store(temporary('restart')), desk = new Desk(store, { root: temporary('root') });
  desk.closed = true;
  const cut = (id, extra) => store.put('run', id, { id, role: 'coordinator', main: true, title: id, provider: 'claude', execution: 'headless', state: 'interrupted', error: 'Server restarted. Resume this run to continue.', endedAt: new Date().toISOString(), createdAt: new Date().toISOString(), sessionId: SESSION, ...extra });
  cut('fresh'); cut('old', { endedAt: new Date(Date.now() - 3600000).toISOString() }); cut('orca', { execution: 'orca' }); cut('stopped', { error: 'Run stopped.' });
  await desk.resumeInterrupted();
  assert.equal(store.get('run', 'fresh').state, 'queued');
  assert.match(store.get('run', 'fresh').followUp, /Rex Desk restarted/);
  assert.ok(store.events('fresh', { visible: true }).some(item => /picking up where it stopped/.test(item.text || '')));
  for (const id of ['old', 'orca', 'stopped']) assert.equal(store.get('run', id).state, 'interrupted', `${id} is left alone`);
});

test('a shell command and its output reach the chat as a terminal block, with colour codes and secrets removed', async () => {
  const seen = [], events = [], ESC = String.fromCharCode(27);
  const messages = [{ type: 'system', subtype: 'init', session_id: SESSION },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'cat notes.txt && echo done', description: 'x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: false, content: `plain ${ESC}[31mred${ESC}[0m
DB_PASSWORD=hunter2
done` }] } },
    { type: 'result', subtype: 'success', result: 'ok', is_error: false }];
  await new ClaudeRunner({ sdk: fakeSdk(messages, seen), run: { id: 'r', role: 'coordinator' }, cwd: 'x', token: 't', mcpUrl: 'http://127.0.0.1:1/mcp', event: (kind, data) => events.push([kind, data]), ask: async () => ({ action: 'accept' }), controller: new AbortController() }).start('Go');
  const call = events.find(([kind]) => kind === 'agent-tool')[1], result = events.find(([kind]) => kind === 'agent-tool-result')[1];
  assert.equal(call.id, 'b1'); assert.equal(call.input.command, 'cat notes.txt && echo done');
  assert.equal(result.id, 'b1'); assert.equal(result.failed, false);
  assert.ok(result.text.includes('plain red'), 'colour codes are gone'); assert.ok(!result.text.includes(ESC));
  assert.ok(!result.text.includes('hunter2') && result.text.includes('[redacted]'), 'a password in the output is hidden');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeRunner, STUCK_AFTER, endProcessTree } from '../src/runners.js';
import { Store } from '../src/store.js';
import { Desk, BACKGROUND_RULE } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const waitFor = async (check, what) => { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out waiting for ${what}`); };
const cancelWords = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
const refused = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: cancelWords }] } });
const fine = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const fakeSdk = (messages, seen) => ({ query: () => Object.assign((async function* replay() { for (const message of messages) { seen.read = (seen.read || 0) + 1; yield message; } })(), { interrupt: async () => {}, close: () => {} }) });

test('three steps in a row cancelled by Claude Code end the turn and stop only that turn\'s own process tree', async () => {
  const seen = {}, events = [], ended = [], queued = [];
  const messages = [refused('a'), refused('b'), refused('c'), { type: 'result', subtype: 'success', result: 'never read', usage: {} }];
  const runner = new ClaudeRunner({ sdk: fakeSdk(messages, seen), run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: (kind, data) => events.push([kind, data]), requeue: text => queued.push(text), endTree: async pid => { ended.push(pid); } });
  runner.childPid = 4242;
  const result = await runner.start('go');
  assert.equal(STUCK_AFTER, 3);
  assert.deepEqual(result, { status: 'completed', stuck: true });
  assert.deepEqual(events.find(([kind]) => kind === 'steps-stuck')?.[1], { count: 3 });
  assert.deepEqual(ended, [4242], 'its own Claude Code process, by id');
  assert.equal(seen.read, 3, 'the turn stops at the third cancel');
  assert.equal(queued.length, 0, 'no "run it again" note: the fresh chat takes over');
});

test('a step that works in between resets the count, so scattered cancels never count as stuck', async () => {
  const seen = {}, events = [], ended = [];
  const runner = new ClaudeRunner({ sdk: fakeSdk([refused('a'), refused('b'), fine('c'), refused('d'), refused('e'), { type: 'result', subtype: 'success', result: 'done', usage: {} }], seen), run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: (kind, data) => events.push([kind, data]), requeue: () => {}, endTree: async pid => { ended.push(pid); } });
  const result = await runner.start('go');
  assert.equal(result.stuck, undefined);
  assert.ok(!events.some(([kind]) => kind === 'steps-stuck'));
  assert.equal(ended.length, 0);
});

test('the process tree stop never touches Rex Desk itself or a missing id', async () => {
  const calls = [], run = (command, args, options, done) => { calls.push([command, ...args]); done(null, ''); };
  assert.equal(await endProcessTree(process.pid, { platform: 'win32', run }), false);
  assert.equal(await endProcessTree(undefined, { platform: 'win32', run }), false);
  assert.equal(calls.length, 0);
  assert.equal(await endProcessTree(4242, { platform: 'win32', run }), true);
  assert.deepEqual(calls, [['taskkill', '/PID', '4242', '/T', '/F']]);
});

test('a stuck turn starts a fresh chat with a handoff, says so in one line, and carries on by itself', async () => {
  const store = new Store(temporary('stuck')), prompts = [];
  const desk = new Desk(store, { root: temporary('stuck-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) { options.event('agent-text', { text: 'Starting the dev server, then the screenshots.' }); options.event('steps-stuck', { count: 3 }); return; }
    options.event('agent-text', { text: `reply ${prompts.length}` });
  }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('take the screenshots');
    const cleared = await waitFor(() => store.events(run.id, { visible: true }).find(event => event.kind === 'chat-cleared'), 'the fresh start');
    assert.equal(cleared.text, 'Steps kept getting cancelled, so I started a fresh chat.');
    assert.ok(cleared.auto);
    const folder = path.join(store.directory, 'handoffs'), handoff = readFileSync(path.join(folder, readdirSync(folder)[0]), 'utf8');
    assert.match(handoff, /several steps in a row were cancelled/);
    assert.match(handoff, /Starting the dev server/);
    await waitFor(() => prompts.length === 2, 'the fresh session carrying on');
    assert.match(prompts[1], /First read the handoff/);
    assert.match(prompts[1], /stopped that turn's own processes/);
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the carried-on turn');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(prompts.length, 2, 'once, not a loop');
    assert.equal(store.get('run', run.id).stepsStuck, undefined);
    assert.ok(prompts[0].includes(BACKGROUND_RULE), 'agents are told to use the background mode and stop jobs by id');
  } finally { await desk.shutdown(); store.close(); }
});

test('a stuck turn in a room keeps the room reply open, so the resumed answer reaches the room', async () => {
  const store = new Store(temporary('stuck-room')), prompts = [], finished = [];
  const desk = new Desk(store, { root: temporary('stuck-room-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) { options.event('steps-stuck', { count: 3 }); return; }
    options.event('agent-text', { text: 'the answer' });
  }, async interrupt() {} }) });
  const turnFinished = desk.rooms.turnFinished.bind(desk.rooms);
  desk.rooms.turnFinished = async runId => { finished.push(prompts.length); return turnFinished(runId); };
  try {
    const run = await desk.startWebTask('reply in the room');
    await waitFor(() => prompts.length === 2 && store.get('run', run.id).state === 'finished', 'the carried-on turn');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(finished, [2], 'the room turn is finished once, after the resumed answer, not when the stuck turn ended');
  } finally { await desk.shutdown(); store.close(); }
});

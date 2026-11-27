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

// L117: helpers (sub-agents, background jobs) make Claude Code cancel the next step when they report back. Those cancels never
// count as stuck, the turn does not end while a helper sub-agent works, and a real stuck gives one fresh start, then a stop.
const started = (id, type = 'local_agent', tool = '') => ({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: tool, task_type: type, description: `helper ${id}` });
const settled = (id, tool = '') => ({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: tool, status: 'completed', output_file: '', summary: 'done' });
const launch = id => ({ type: 'assistant', message: { model: 'claude', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'research the handbook', prompt: 'go', run_in_background: true } }] } });
const launched = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: a1\noutput_file: D:\\work\\${id}.jsonl\nDo NOT read this file.` }] }] } });
const result = text => ({ type: 'result', subtype: 'success', result: text, num_turns: 1, usage: {} });

test('cancels while a helper of the turn is still running never count as stuck and never end the process tree (L117)', async () => {
  const seen = {}, events = [], ended = [];
  const messages = [started('t1'), refused('a'), refused('b'), refused('c'), refused('d'), settled('t1'), fine('e'), result('done')];
  const runner = new ClaudeRunner({ sdk: fakeSdk(messages, seen), run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: (kind, data) => events.push([kind, data]), requeue: () => {}, endTree: async pid => { ended.push(pid); } });
  runner.childPid = 4242;
  const answer = await runner.start('go');
  assert.equal(answer.stuck, undefined);
  assert.ok(!events.some(([kind]) => kind === 'steps-stuck'));
  assert.equal(ended.length, 0, 'the helpers are never killed');
  assert.equal(seen.read, messages.length);
  assert.deepEqual(events.filter(([kind]) => kind === 'helpers').map(([, data]) => data.running.length), [1, 0]);
});

test('once the helpers are done, three real cancels in a row still count as stuck (L117)', async () => {
  const seen = {}, ended = [];
  const runner = new ClaudeRunner({ sdk: fakeSdk([started('t1', 'local_agent'), refused('a'), settled('t1'), refused('b'), refused('c'), refused('d'), result('never')], seen), run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: () => {}, requeue: () => {}, endTree: async pid => { ended.push(pid); } });
  runner.childPid = 7;
  assert.deepEqual(await runner.start('go'), { status: 'completed', stuck: true });
  assert.deepEqual(ended, [7]);
});

test('the reply does not end the turn while a background sub-agent still works; its finish notice is read first (L117)', async () => {
  const seen = {}, events = [];
  const messages = [launch('ag1'), launched('ag1'), result('I launched a helper.'), refused('x'), refused('y'), refused('z'), started('t9', 'local_agent', 'ag1'), settled('t9', 'ag1'), { type: 'assistant', message: { model: 'claude', content: [{ type: 'text', text: 'The helper is done.' }] } }, result('The helper is done.'), result('never read')];
  const runner = new ClaudeRunner({ sdk: fakeSdk(messages, seen), run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: (kind, data) => events.push([kind, data]), requeue: () => {}, endTree: async () => { throw new Error('never'); } });
  const answer = await runner.start('go');
  assert.equal(answer.stuck, undefined);
  assert.equal(seen.read, messages.length - 1, 'it ends at the result after the helper settled');
  assert.deepEqual(events.filter(([kind]) => kind === 'agent-result').map(([, data]) => data.result), ['I launched a helper.', 'The helper is done.']);
  const running = events.find(([kind, data]) => kind === 'helpers' && data.running.length)?.[1].running[0];
  assert.equal(running.outputFile, 'D:\\work\\ag1.jsonl');
  assert.equal(running.description, 'research the handbook');
});

test('loop guard: a real stuck gives one fresh start; stuck again soon after stops the agent with Continue (L117)', async () => {
  const store = new Store(temporary('stuck-guard')), prompts = [];
  const desk = new Desk(store, { root: temporary('stuck-guard-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt);
    if (prompts.length <= 2) { options.event('agent-text', { text: `try ${prompts.length}` }); options.event('steps-stuck', { count: 3 }); return; }
    options.event('agent-text', { text: 'carried on' });
  }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('write the team handbook');
    const stopped = await waitFor(() => store.events(run.id, { visible: true }).find(event => event.kind === 'stuck-stopped'), 'the loop guard stop');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the stopped turn');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(store.events(run.id, { visible: true }).filter(event => event.kind === 'chat-cleared').length, 1, 'one fresh start, not three');
    assert.equal(prompts.length, 2, 'no silent restart after the second stuck');
    assert.match(stopped.text, /got stuck, so I stopped it/);
    assert.ok(store.get('run', run.id).stuckStopped);
    // The person presses Continue: the agent goes on in the same chat.
    await desk.continueStuck(run.id);
    await waitFor(() => prompts.length === 3, 'Continue');
    assert.match(prompts[2], /The person pressed Continue/);
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the continued turn');
    assert.equal(store.get('run', run.id).stuckStopped, undefined);
  } finally { await desk.shutdown(); store.close(); }
});

test('a stuck again after the person wrote is a new problem: it gets its own fresh start (L117)', async () => {
  const store = new Store(temporary('stuck-spoke'));
  const desk = new Desk(store, { root: temporary('stuck-spoke-root'), runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('look');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the turn');
    const at = Date.now() + 5000;
    store.put('run', run.id, { ...store.get('run', run.id), stuckFreshAt: new Date(at - 60000).toISOString(), autoContinues: 3 });
    store.event(run.id, 'human-message', { text: 'try again' }, true);
    await desk.recoverStuck(run.id, at);
    assert.equal(store.events(run.id, { visible: true }).filter(event => event.kind === 'chat-cleared').length, 1);
    assert.ok(!store.events(run.id, { visible: true }).some(event => event.kind === 'stuck-stopped'));
  } finally { await desk.shutdown(); store.close(); }
});

test('a fresh start lists the helpers it cut off and where their output is, and says not to start them again unseen (L117)', async () => {
  const store = new Store(temporary('stuck-helpers')), prompts = [];
  const helper = { id: 't1', type: 'local_bash', description: 'npm run dev', outputFile: 'D:\\work\\dev.log' };
  const desk = new Desk(store, { root: temporary('stuck-helpers-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) { options.event('helpers', { running: [helper] }); options.event('steps-stuck', { count: 3, helpers: [helper] }); return; }
    options.event('agent-text', { text: 'ok' });
  }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('take the screenshots');
    await waitFor(() => prompts.length === 2, 'the fresh session');
    const folder = path.join(store.directory, 'handoffs'), handoff = readFileSync(path.join(folder, readdirSync(folder)[0]), 'utf8');
    assert.match(handoff, /Helpers that were still running/);
    assert.match(handoff, /background command: npm run dev \(its output so far: D:\\work\\dev\.log\)/);
    assert.match(handoff, /do not start them again without telling the person/);
    assert.match(prompts[1], /do not start them again without telling the person/);
    assert.equal(store.get('run', run.id).helpers, undefined);
  } finally { await desk.shutdown(); store.close(); }
});

test('a background command left running does not hide a real cancel loop: three cancels still count as stuck (L117 review)', async () => {
  const seen = {}, events = [], ended = [];
  const runner = new ClaudeRunner({ sdk: fakeSdk([started('dev', 'local_bash'), refused('a'), refused('b'), refused('c'), result('never')], seen), run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: (kind, data) => events.push([kind, data]), requeue: () => {}, endTree: async pid => { ended.push(pid); } });
  runner.childPid = 9;
  assert.deepEqual(await runner.start('go'), { status: 'completed', stuck: true });
  assert.deepEqual(ended, [9]);
  assert.equal(events.find(([kind]) => kind === 'steps-stuck')[1].helpers[0].type, 'local_bash', 'the job is named for the handoff');
});

test('a dev server with repeated cancels gets its one fresh start, then the stop with Continue (L117 review)', async () => {
  const store = new Store(temporary('stuck-devserver')), prompts = [];
  const desk = new Desk(store, { root: temporary('stuck-devserver-root'), runnerFactory: options => {
    const turn = prompts.length + 1;
    const messages = turn <= 2 ? [started(`dev${turn}`, 'local_bash'), refused('a'), refused('b'), refused('c'), result('never')] : [{ type: 'assistant', message: { model: 'claude', content: [{ type: 'text', text: 'carried on' }] } }, result('carried on')];
    const runner = new ClaudeRunner({ ...options, sdk: fakeSdk(messages, {}), endTree: async () => true });
    const start = runner.start.bind(runner);
    runner.start = prompt => { prompts.push(prompt); return start(prompt); };
    return runner;
  } });
  try {
    const run = await desk.startWebTask('take the screenshots');
    await waitFor(() => store.events(run.id, { visible: true }).some(event => event.kind === 'stuck-stopped'), 'the loop guard stop');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(store.events(run.id, { visible: true }).filter(event => event.kind === 'chat-cleared').length, 1, 'one fresh start');
    assert.equal(prompts.length, 2, 'then a stop, not another restart');
    const folder = path.join(store.directory, 'handoffs'), handoff = readFileSync(path.join(folder, readdirSync(folder)[0]), 'utf8');
    assert.match(handoff, /background command: helper dev1/);
    assert.ok(store.get('run', run.id).stuckStopped);
  } finally { await desk.shutdown(); store.close(); }
});

test('a sub-agent that never reports back holds the turn at most 30 minutes after the reply, then the turn ends and says so (L117 review)', async () => {
  const events = [], timers = []; let closed = false;
  // The stream gives the reply, then waits for ever: the helper's finish notice never comes.
  const messages = [launch('ag1'), launched('ag1'), result('I launched a helper.')];
  const sdk = { query: () => {
    let index = 0;
    const iterator = { next: () => index < messages.length ? Promise.resolve({ value: messages[index++], done: false }) : new Promise(() => {}), return: async () => ({ done: true }) };
    return { [Symbol.asyncIterator]: () => iterator, interrupt: async () => {}, close: () => { closed = true; } };
  } };
  // A fake clock: the 30 minutes pass at once, and the wait asked for is recorded.
  const runner = new ClaudeRunner({ sdk, run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: (kind, data) => events.push([kind, data]), requeue: () => {}, setTimer: (fire, ms) => { timers.push(ms); return setTimeout(fire, 0); }, clearTimer: clearTimeout });
  const answer = await runner.start('go');
  assert.equal(answer.status, 'completed');
  assert.deepEqual(timers, [30 * 60000]);
  assert.ok(closed, 'Claude Code and its helpers are ended');
  const stopped = events.find(([kind]) => kind === 'helpers-stopped')?.[1];
  assert.equal(stopped.helpers[0].description, 'research the handbook');
  assert.equal(stopped.helpers[0].outputFile, 'D:\\work\\ag1.jsonl');
});

test('any word in the 30 minutes starts the wait again, so a slow helper that keeps working is never cut (L117 review)', async () => {
  const timers = [];
  const progress = { type: 'system', subtype: 'task_progress', task_id: 't9', tool_use_id: 'ag1', description: 'still reading', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } };
  const messages = [launch('ag1'), launched('ag1'), result('I launched a helper.'), started('t9', 'local_agent', 'ag1'), progress, settled('t9', 'ag1'), result('done')];
  const runner = new ClaudeRunner({ sdk: fakeSdk(messages, {}), run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: () => {}, requeue: () => {}, setTimer: (fire, ms) => { timers.push(ms); return setTimeout(fire, 60000); }, clearTimer: clearTimeout });
  const answer = await runner.start('go');
  assert.equal(answer.status, 'completed');
  assert.equal(timers.length, 3, 'a fresh 30 minutes after each message while the helper worked');
  assert.equal(runner.helpersQuiet, null);
});

test('the chat says in one line that helpers were stopped, and the next handoff lists them (L117 review)', async () => {
  const store = new Store(temporary('helpers-quiet')), prompts = [];
  const desk = new Desk(store, { root: temporary('helpers-quiet-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) options.event('helpers-stopped', { helpers: [{ id: 't1', type: 'local_agent', description: 'audit the docs', outputFile: 'D:\\work\\audit.jsonl' }] });
  }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('audit');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the turn');
    const line = store.events(run.id, { visible: true }).find(event => event.kind === 'helpers-stopped');
    assert.match(line.text, /did not report back for 30 minutes, so I stopped them/);
    await desk.freshStart(run.id);
    const folder = path.join(store.directory, 'handoffs'), handoff = readFileSync(path.join(folder, readdirSync(folder)[0]), 'utf8');
    assert.match(handoff, /sub-agent: audit the docs \(its output so far: D:\\work\\audit\.jsonl\)/);
  } finally { await desk.shutdown(); store.close(); }
});

test('Continue works only on a chat the loop guard stopped (L117 review)', async () => {
  const store = new Store(temporary('continue-guard')), prompts = [];
  const desk = new Desk(store, { root: temporary('continue-guard-root'), runnerFactory: () => ({ async start(prompt) { prompts.push(prompt); }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('look');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the turn');
    await assert.rejects(desk.continueStuck(run.id), /not stopped by Rex Desk/);
    assert.equal(prompts.length, 1);
  } finally { await desk.shutdown(); store.close(); }
});

test('Stop while the turn waits for a helper ends it at once and clears the 30-minute timer (L117 review)', async () => {
  const timers = [], cleared = [];
  const messages = [launch('ag1'), launched('ag1'), result('I launched a helper.')];
  let fail = null;
  const sdk = { query: () => {
    let index = 0;
    const iterator = { next: () => index < messages.length ? Promise.resolve({ value: messages[index++], done: false }) : new Promise((resolve, reject) => { fail = reject; }), return: async () => ({ done: true }) };
    return { [Symbol.asyncIterator]: () => iterator, interrupt: async () => { fail?.(new Error('Claude Code process aborted by user')); }, close: () => {} };
  } };
  const runner = new ClaudeRunner({ sdk, run: { id: 'r', provider: 'claude' }, cwd: os.tmpdir(), event: () => {}, requeue: () => {},
    setTimer: (fire, ms) => { const id = { ms }; timers.push(id); return id; }, clearTimer: id => cleared.push(id) });
  const turn = runner.start('go');
  await waitFor(() => timers.length === 1 && fail, 'the wait for the helper');
  await runner.interrupt();
  await assert.rejects(turn, /aborted by user/);
  assert.deepEqual(cleared, timers, 'the timer is cleared even though the stream failed');
  assert.equal(runner.helpersQuiet, null, 'Stop is not reported as helpers going quiet');
});

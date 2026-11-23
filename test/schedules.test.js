import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { inHours, cleanHours } from '../src/specialists.js';
import { nextRun } from '../src/schedules.js';
import { ClaudeRunner } from '../src/runners.js';
import { CodexRunner } from '../src/codex.js';

// A stand-in for an agent that really took the prompt: its waiting tickets are marked taken.
const accept = (desk, prompt) => { for (const item of desk.store.list('delivery').filter(entry => entry.state === 'waiting' && String(prompt).includes(entry.text))) desk.setDelivery(item.id, { state: 'taken' }); };
const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup() {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop', description: 'Online shop' }));
  const store = new Store(temporary('sched')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  desk.memory.scan({ roots: [projects] });
  const agent = desk.specialists.create({ name: 'Desky', projectSlug: 'shop' });
  const sent = []; desk.specialistTurn = async (agentId, input) => { sent.push({ agentId, ...input }); accept(desk, input.prompt); return { id: `run-${sent.length}` }; };
  return { store, desk, agent, sent };
}
const at = (day, time) => { const date = new Date(2026, 10, 16 + day); const [hour, minute] = time.split(':').map(Number); date.setHours(hour, minute, 0, 0); return date; }; // day 0 = Monday 16 Nov 2026

test('work hours: inside the shift on a work day only, and a night shift runs past midnight', () => {
  const shift = cleanHours({ on: true, start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] });
  assert.equal(inHours(shift, at(0, '08:00')), true);
  assert.equal(inHours(shift, at(0, '16:59')), true);
  assert.equal(inHours(shift, at(0, '17:00')), false, 'the shift ends at 17:00');
  assert.equal(inHours(shift, at(0, '07:59')), false);
  assert.equal(inHours(shift, at(5, '10:00')), false, 'Saturday is off');
  assert.equal(inHours({ ...shift, on: false }, at(5, '03:00')), true, 'no work hours means any time');
  const night = cleanHours({ on: true, start: '22:00', end: '06:00', days: [1] });
  assert.equal(inHours(night, at(0, '23:00')), true);
  assert.equal(inHours(night, at(1, '05:00')), true, 'Tuesday early morning is still Monday night');
  assert.equal(inHours(night, at(1, '07:00')), false);
  assert.deepEqual(cleanHours({ start: '25:00', end: 'x', days: [9, 1, 1] }), { on: false, start: '08:00', end: '17:00', days: [1] });
});

test('the loop checks only in work hours, rests 10 minutes after a check, and spaces out when there is nothing new', async () => {
  const { store, desk, agent, sent } = setup();
  store.put('task', 't1', { id: 't1', local: true, active: true, title: 'Fix it', status: 'todo', projectSlug: 'shop', updatedAt: '1' });
  desk.specialists.update(agent.id, { taskSources: ['local'], loop: { on: true, every: 15, hours: { on: true, start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] } } });
  await desk.loopTick(at(5, '10:00').getTime(), { memory: false });
  assert.equal(sent.length, 0, 'no check on Saturday');
  await desk.loopTick(at(0, '10:00').getTime(), { memory: false });
  assert.equal(sent.length, 1, 'a check in work hours');
  assert.match(sent[0].prompt, /do one task per check, then stop/);
  assert.match(sent[0].prompt, /Your work hours are 08:00 to 17:00/);
  // The check said "Nothing new.": the next one waits twice as long (30 minutes instead of 15), and at least 10 minutes after it ended.
  store.event('run-1', 'agent-text', { text: 'Nothing new.' }, true);
  desk.specialists.status = () => ({ state: 'idle' });
  store.put('task', 't1', { ...store.get('task', 't1'), updatedAt: '2' });
  await desk.loopTick(at(0, '10:20').getTime(), { memory: false });
  assert.equal(sent.length, 1, 'cooling down after a quiet check');
  const loop = desk.specialists.loopOf(store.get('specialist', agent.id));
  assert.equal(loop.quiet, 1); assert.equal(loop.runId, '');
  await desk.loopTick(at(0, '10:31').getTime(), { memory: false });
  assert.equal(sent.length, 2, 'checks again after the longer wait');
});

test('a check still working when the shift ends is told once to finish the step and stop', () => {
  const { store, desk, agent } = setup();
  desk.specialists.update(agent.id, { loop: { on: true, hours: { on: true, start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] } } });
  store.put('specialist', agent.id, { ...store.get('specialist', agent.id), loop: { ...store.get('specialist', agent.id).loop, runId: 'r1' } });
  const said = []; desk.live.set('r1', {}); desk.say = async (runId, text) => { said.push(text); };
  desk.specialists.status = () => ({ state: 'busy' });
  void desk.loopTick(at(0, '17:05').getTime(), { memory: false }); void desk.loopTick(at(0, '17:10').getTime(), { memory: false });
  assert.equal(said.length, 1);
  assert.match(said[0], /work hours ended/);
});

test('when every account is out, the chat carries on by itself right after the limit resets', async () => {
  const { store, desk } = setup();
  const reset = Date.now() + 3600000;
  store.put('accounts', 'limited', { id: 'limited', until: { a: reset, b: reset + 7200000 } });
  store.put('run', 'r1', { id: 'r1', role: 'specialist', state: 'finished', createdAt: new Date().toISOString() });
  assert.match(desk.resumeAfterLimit('r1'), /carries on by itself at/);
  assert.equal(Date.parse(store.get('run', 'r1').resumeAt), reset + 60000, 'a minute after the soonest reset');
  const resumed = []; desk.resume = async (runId, input) => { resumed.push({ runId, ...input }); };
  await desk.resumeTick(reset);
  assert.equal(resumed.length, 0, 'not before its time');
  await desk.resumeTick(reset + 61000);
  assert.equal(resumed.length, 1); assert.match(resumed[0].prompt, /Continue exactly where you left off/);
  assert.equal(store.get('run', 'r1').resumeAt, '');
  // The person wrote first: no extra "continue".
  desk.resumeAfterLimit('r1'); store.event('r1', 'human-message', { text: 'go on' }, true);
  await desk.resumeTick(reset + 600000);
  assert.equal(resumed.length, 1);
});

test('scheduled messages: next time by repeat, sent once when due, repeating ones move to their next day', async () => {
  assert.equal(nextRun({ time: '09:00', repeat: 'weekdays' }, at(4, '10:00')).getDay(), 1, 'Friday after 9 goes to Monday');
  assert.equal(nextRun({ time: '09:00', repeat: 'daily' }, at(0, '08:00')).getHours(), 9);
  assert.equal(nextRun({ time: '09:00', repeat: 'weekly', day: 3 }, at(0, '08:00')).getDay(), 3);
  const { store, desk, agent, sent } = setup();
  assert.throws(() => desk.schedules.create(agent.id, { text: '', time: '09:00' }), /Write the message/);
  assert.throws(() => desk.schedules.create(agent.id, { text: 'hi', time: '9am' }), /Pick a time/);
  const daily = desk.schedules.create(agent.id, { text: 'Check Orbit', time: '09:00', repeat: 'daily' }, at(0, '08:00'));
  const once = desk.schedules.create(agent.id, { text: 'Ping', time: '12:00', repeat: 'once' }, at(0, '08:00'));
  await desk.schedules.tick(at(0, '08:59'));
  assert.equal(sent.length, 0);
  await desk.schedules.tick(at(0, '09:00'));
  assert.equal(sent.length, 1); assert.match(sent[0].prompt, /Check Orbit/); assert.equal(sent[0].agentId, agent.id);
  assert.equal(new Date(store.get('schedmsg', daily.id).nextAt).getDate(), at(1, '09:00').getDate(), 'next day');
  await desk.schedules.tick(at(0, '12:30'));
  assert.equal(sent.length, 2); assert.equal(store.get('schedmsg', once.id).on, false, 'a one-time message is done');
  await desk.schedules.tick(at(0, '13:00'));
  assert.equal(sent.length, 2, 'never sent twice');
  assert.equal(desk.snapshot().schedules.length, 2);
  desk.schedules.remove(once.id); assert.equal(desk.schedules.list().length, 1);
});

test('work hours hold a scheduled message off-shift, then send it once the shift is back', async () => {
  const { store, desk, agent, sent } = setup();
  desk.specialists.update(agent.id, { loop: { on: true, hours: { on: true, start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] } } });
  const daily = desk.schedules.create(agent.id, { text: 'Check Orbit', time: '07:00', repeat: 'daily' }, at(0, '06:00'));
  await desk.schedules.tick(at(0, '07:00'));
  assert.equal(sent.length, 0, 'due before the shift: held, not sent');
  assert.equal(store.get('schedmsg', daily.id).nextAt, daily.nextAt, 'held message keeps its due time');
  await desk.schedules.tick(at(0, '08:00'));
  assert.equal(sent.length, 1, 'sent once the shift starts');
  assert.equal(new Date(store.get('schedmsg', daily.id).nextAt).getDate(), at(1, '07:00').getDate(), 'then rolls to the next day');
});

test('a past one-time message cannot be turned back on, and a due message waits for a free agent and counts as sent only after its turn', async () => {
  const { store, desk, agent, sent } = setup();
  const day = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const soon = new Date(Date.now() + 2 * 86400000), past = new Date(Date.now() - 2 * 86400000);
  const once = desk.schedules.create(agent.id, { text: 'Ping', time: '09:00', repeat: 'once', date: day(soon) });
  desk.schedules.toggle(once.id, false);
  store.put('schedmsg', once.id, { ...store.get('schedmsg', once.id), date: day(past) });
  assert.throws(() => desk.schedules.toggle(once.id, true), /already passed/);
  assert.equal(store.get('schedmsg', once.id).on, false);
  const daily = desk.schedules.create(agent.id, { text: 'Check Orbit', time: '09:00', repeat: 'daily' }, at(0, '08:00'));
  desk.specialists.status = () => ({ state: 'replying' });
  await desk.schedules.tick(at(0, '09:00'));
  assert.equal(sent.length, 0, 'agent busy: held');
  assert.equal(store.get('schedmsg', daily.id).nextAt, daily.nextAt);
  desk.specialists.status = () => ({ state: 'idle' });
  desk.specialistTurn = async () => { throw new Error('no account'); };
  await desk.schedules.tick(at(0, '09:05'));
  assert.equal(store.get('schedmsg', daily.id).nextAt, daily.nextAt, 'a failed turn is not marked sent');
  assert.equal(store.get('schedmsg', daily.id).on, true); assert.match(store.get('schedmsg', daily.id).error, /no account/);
  desk.specialistTurn = async (agentId, input) => { sent.push({ agentId, ...input }); accept(desk, input.prompt); return { id: 'run-x' }; };
  await desk.schedules.tick(at(0, '09:10'));
  assert.equal(sent.length, 1);
  const saved = store.get('schedmsg', daily.id);
  assert.equal(new Date(saved.nextAt).getDate(), at(1, '09:00').getDate()); assert.equal(saved.error, undefined); assert.equal(saved.lastAt, at(0, '09:10').toISOString());
});

test('a loop that is on with no task source to look at is shown as finding nothing', async () => {
  const { loopFindsNothing } = await import('../public/agent-loop.js');
  assert.equal(loopFindsNothing({ on: true }, [], ['flow']), true);
  assert.equal(loopFindsNothing({ on: true }, ['gone'], ['flow']), true, 'only a removed tracker');
  assert.equal(loopFindsNothing({ on: true }, ['local'], []), false);
  assert.equal(loopFindsNothing({ on: true }, ['flow'], ['flow']), false);
  assert.equal(loopFindsNothing({ on: false }, [], []), false);
});

test('a scheduled message turned off while it is being sent stays off, whether the send fails or works', async () => {
  const { store, desk, agent } = setup();
  desk.specialists.status = () => ({ state: 'idle' });
  for (const fails of [true, false]) {
    const item = desk.schedules.create(agent.id, { text: fails ? 'Fails' : 'Works', time: '09:00', repeat: 'daily' }, at(0, '08:00'));
    desk.specialistTurn = async (agentId, input) => { desk.schedules.toggle(item.id, false); if (fails) throw new Error('no account'); accept(desk, input.prompt); return { id: 'run-x' }; };
    await desk.schedules.tick(at(0, '09:00'));
    assert.equal(store.get('schedmsg', item.id).on, false, fails ? 'a failed try never turns it back on' : 'a sent one stays off');
    store.delete('schedmsg', item.id);
  }
});

test('a due message turned off or deleted while the one before it is sending is not sent from the old list', async () => {
  const { store, desk, agent, sent } = setup();
  desk.specialists.status = () => ({ state: 'idle' });
  const first = desk.schedules.create(agent.id, { text: 'First', time: '09:00', repeat: 'daily' }, at(0, '08:00'));
  const second = desk.schedules.create(agent.id, { text: 'Second', time: '09:00', repeat: 'daily' }, at(0, '08:00'));
  const third = desk.schedules.create(agent.id, { text: 'Third', time: '09:00', repeat: 'daily' }, at(0, '08:00'));
  // Whichever is sent first turns one of the others off and deletes the last.
  desk.specialistTurn = async (agentId, input) => {
    sent.push(input.prompt);
    accept(desk, input.prompt);
    if (sent.length === 1) { const others = [first, second, third].filter(item => !input.prompt.includes(item.text)); desk.schedules.toggle(others[0].id, false); store.delete('schedmsg', others[1].id); }
    return { id: 'run-x' };
  };
  await desk.schedules.tick(at(0, '09:00'));
  assert.equal(sent.length, 1, 'only the first one was sent');
});

// Every path a scheduled turn can take, for Claude and Codex, through the real coordinator: a message counts as sent only
// when the agent really took the prompt; anything else leaves it on and due, and it is never delivered twice.
function deskWith(makeRunner, provider = 'claude') {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop' }));
  const store = new Store(temporary('sched')), launches = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), runnerFactory: options => { launches.push(options); return makeRunner(options, launches.length); } });
  desk.memory.scan({ roots: [projects] });
  const agent = desk.specialists.create({ name: 'Desky', projectSlug: 'shop', provider });
  desk.specialists.status = () => ({ state: 'idle' });
  const once = desk.schedules.create(agent.id, { text: 'Ping', time: '09:00', repeat: 'once' }, at(0, '08:00'));
  const settled = async () => { for (let step = 0; step < 150 && desk.live.size; step++) await new Promise(done => setTimeout(done, 20)); };
  const runOf = () => store.get('run', store.get('specialist', agent.id).runId);
  return { store, desk, agent, once, launches, settled, runOf, item: () => store.get('schedmsg', once.id) };
}
// A stand-in for the Agent SDK: each launch replays its own messages (or throws).
const claudeSdk = script => { let launch = 0; return { query: () => { const messages = script(++launch); if (messages instanceof Error) throw messages; return Object.assign((async function* replay() { for (const message of messages) yield message; })(), { interrupt: async () => {}, close: () => {} }); } }; };
const reply = (text, model = 'claude-opus-5-5') => [{ type: 'system', subtype: 'init', session_id: '11111111-1111-1111-1111-111111111111', apiKeySource: 'none' }, { type: 'assistant', message: { model, content: [{ type: 'text', text }] } }, { type: 'result', subtype: 'success', result: text, usage: {} }];

test('path 1, launch fails (Claude): nothing was taken, so it stays due and the next launch sends it once', async () => {
  const sdk = claudeSdk(launch => launch === 1 ? new Error('spawn claude ENOENT') : reply('On it.'));
  const t = deskWith(options => new ClaudeRunner({ ...options, sdk }));
  await t.desk.schedules.tick(at(0, '09:00')); await t.settled();
  assert.equal(t.runOf().state, 'failed');
  assert.equal(t.store.list('delivery')[0]?.state, 'lost', 'the ticket is lost, not taken');
  await t.desk.schedules.tick(at(0, '09:05')); await t.settled(); await t.desk.schedules.tick(at(0, '09:10'));
  assert.equal(t.launches.length, 2, 'tried again'); assert.equal(t.item().on, false, 'sent once the agent took it');
  await t.desk.schedules.tick(at(0, '09:15')); await t.settled();
  assert.equal(t.launches.length, 2, 'never sent twice');
});

test('path 2, sign-in error (Claude): a synthetic "not logged in" reply and its result do not count, so it stays due', async () => {
  const signedOut = [{ type: 'system', subtype: 'init', session_id: '11111111-1111-1111-1111-111111111111', apiKeySource: 'none' }, { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }, { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} }];
  const sdk = claudeSdk(launch => launch === 1 ? signedOut : reply('On it.'));
  const t = deskWith(options => new ClaudeRunner({ ...options, sdk }));
  await t.desk.schedules.tick(at(0, '09:00')); await t.settled();
  assert.equal(t.runOf().state, 'failed'); assert.match(t.runOf().error, /not signed in/);
  assert.equal(t.store.list('delivery')[0]?.state, 'lost', 'the ticket is lost, not taken');
  await t.desk.schedules.tick(at(0, '09:05')); await t.settled(); await t.desk.schedules.tick(at(0, '09:10'));
  assert.equal(t.launches.length, 2, 'tried again'); assert.equal(t.item().on, false, 'sent once a signed-in agent took it');
});

test('path 3, session opens then the submit fails (Codex): the open thread does not count, so it stays due', async () => {
  let submits = 0;
  const clientFactory = options => ({ open: async () => {}, close() {}, request: async method => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      if (++submits === 1) throw new Error('turn/start failed: connection closed');
      setTimeout(() => { options.onNotification('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Done: pinged.' } }); options.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'u2', status: 'completed' } }); }, 5);
      return { turn: { id: 'u2' } };
    }
    return {};
  } });
  const t = deskWith(options => new CodexRunner({ ...options, clientFactory }), 'codex');
  await t.desk.schedules.tick(at(0, '09:00')); await t.settled();
  assert.equal(t.runOf().state, 'failed'); assert.equal(t.runOf().sessionId, 'thread-1', 'the session opened before the submit failed');
  assert.equal(t.store.list('delivery')[0]?.state, 'lost');
  await t.desk.schedules.tick(at(0, '09:05')); await t.settled(); await t.desk.schedules.tick(at(0, '09:10'));
  assert.equal(submits, 2, 'submitted again'); assert.equal(t.item().on, false, 'sent once Codex accepted the turn');
});

test('path 4, queued behind an agent waiting for an answer: not sent while queued; taken from the queue counts, a stop keeps it due', async () => {
  for (const ending of ['taken', 'stopped']) {
    let release;
    const t = deskWith((options, launch) => ({
      async start() {
        options.event('prompt-accepted', {});
        if (launch === 1) {
          await new Promise(done => { release = done; options.signal.addEventListener('abort', () => done(), { once: true }); });
          if (options.signal.aborted) throw new Error('Run stopped.');
          if (ending === 'taken') options.inbox();
        }
      }, interrupt() {}, close() {} }));
    void t.desk.specialistTurn(t.agent.id, { prompt: 'Look at the logs' }); await new Promise(done => setTimeout(done, 80));
    assert.equal(t.desk.live.size, 1, `${ending}: the agent is mid-turn, waiting for an answer`);
    await t.desk.schedules.tick(at(0, '09:00'));
    assert.ok(t.runOf().queued.some(text => text.includes('Ping')), 'queued for the agent'); assert.equal(t.item().on, true, 'queued is not sent');
    await t.desk.schedules.tick(at(0, '09:02'));
    assert.equal(t.item().on, true, 'still waiting');
    if (ending === 'taken') {
      release(); await t.settled(); await t.desk.schedules.tick(at(0, '09:05'));
      assert.equal(t.item().on, false, 'taken from the queue: sent'); assert.equal(t.launches.length, 1, 'no second turn');
      continue;
    }
    await t.desk.stop(t.runOf().id); await t.settled();
    await t.desk.schedules.tick(at(0, '09:05'));
    assert.equal((t.runOf().queued || []).some(text => text.includes('Ping')), false, 'out of the stopped run\'s queue, so it is not sent twice');
    await t.settled(); await t.desk.schedules.tick(at(0, '09:10'));
    assert.equal(t.launches.length, 2, 'sent again in a new turn'); assert.equal(t.item().on, false);
  }
});

test('path 5, run stopped: before the prompt was taken it stays due; after, it counts as sent', async () => {
  for (const accepted of [false, true]) {
    const t = deskWith((options, launch) => ({
      async start() {
        if (launch === 1) { if (accepted) options.event('prompt-accepted', {}); await new Promise(done => options.signal.addEventListener('abort', () => done(), { once: true })); throw new Error('Run stopped.'); }
      }, interrupt() {}, close() {} }));
    await t.desk.schedules.tick(at(0, '09:00')); await new Promise(done => setTimeout(done, 80));
    assert.equal(t.item().on, !accepted, accepted ? 'taken at once: sent' : 'in a turn, not taken: waiting');
    await t.desk.stop(t.runOf().id); await t.settled();
    await t.desk.schedules.tick(at(0, '09:05')); await t.settled(); await t.desk.schedules.tick(at(0, '09:10'));
    assert.equal(t.launches.length, accepted ? 1 : 2, accepted ? 'taken before the stop: not sent again' : 'stopped before it was taken: sent again');
    assert.equal(t.item().on, false);
  }
});

test('path 6, the turn ends cleanly without any accepted signal (any runner): it counts as sent', async () => {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop' }));
  let launches = 0;
  const store = new Store(temporary('sched')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), runnerFactory: () => ({ async start() { launches++; }, interrupt() {}, close() {} }) });
  desk.memory.scan({ roots: [projects] });
  const agent = desk.specialists.create({ name: 'Desky', projectSlug: 'shop' });
  desk.specialists.status = () => ({ state: 'idle' });
  const once = desk.schedules.create(agent.id, { text: 'Ping', time: '09:00', repeat: 'once' }, at(0, '08:00'));
  const settled = async () => { for (let step = 0; step < 100 && desk.live.size; step++) await new Promise(done => setTimeout(done, 20)); };
  await desk.schedules.tick(at(0, '09:00')); await settled(); await desk.schedules.tick(at(0, '09:05')); await settled();
  assert.equal(store.get('schedmsg', once.id).on, false); assert.equal(launches, 1, 'not sent twice');
});

test('path 7, turned off or deleted while its turn is going: off stays off, deleted is dropped with its ticket', async () => {
  for (const change of ['off', 'deleted']) {
    let release;
    const t = deskWith(options => ({ async start() { await new Promise(done => { release = done; }); options.event('prompt-accepted', {}); }, interrupt() {}, close() {} }));
    t.store.delete('schedmsg', t.once.id);
    const daily = t.desk.schedules.create(t.agent.id, { text: 'Daily', time: '09:00', repeat: 'daily' }, at(0, '08:00'));
    await t.desk.schedules.tick(at(0, '09:00')); await new Promise(done => setTimeout(done, 80));
    if (change === 'off') t.desk.schedules.toggle(daily.id, false); else t.desk.schedules.remove(daily.id);
    release(); await t.settled(); await t.desk.schedules.tick(at(0, '09:05'));
    if (change === 'off') assert.equal(t.store.get('schedmsg', daily.id).on, false, 'stays off'); else assert.equal(t.store.get('schedmsg', daily.id), undefined);
    assert.equal(t.launches.length, 1, 'not sent again');
    if (change === 'deleted') assert.equal(t.store.list('delivery').length, 0, 'its ticket is gone');
  }
});

test('path 8, queued then handed to Codex mid-turn as a steer: counts only once Codex accepts it; a refused steer keeps it due', async () => {
  for (const steer of ['accepted', 'refused']) {
    let notify, finish, starts = 0;
    const clientFactory = options => ({ open: async () => {}, close() {}, request: async (method, params) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        const id = `u${++starts}`;
        if (starts === 1) { notify = options.onNotification; finish = () => options.onNotification('turn/completed', { threadId: 'thread-1', turn: { id, status: 'completed' } }); }
        else setTimeout(() => { options.onNotification('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Done: pinged.' } }); options.onNotification('turn/completed', { threadId: 'thread-1', turn: { id, status: 'completed' } }); }, 5);
        return { turn: { id } };
      }
      if (method === 'turn/steer') { if (steer === 'refused') throw new Error('turn/steer refused: no active turn'); return {}; }
      return {};
    } });
    const t = deskWith(options => new CodexRunner({ ...options, clientFactory }), 'codex');
    t.store.delete('schedmsg', t.once.id);
    const once = t.desk.schedules.create(t.agent.id, { text: 'Ping', time: '09:00', repeat: 'once' }, at(0, '08:00'));
    void t.desk.specialistTurn(t.agent.id, { prompt: 'Look at the logs' }); await new Promise(done => setTimeout(done, 100));
    assert.equal(t.desk.live.size, 1, `${steer}: Codex is mid-turn`);
    await t.desk.schedules.tick(at(0, '09:00'));
    assert.ok(t.runOf().queued.some(text => text.includes('Ping')), 'queued for Codex');
    // Codex finishes a step: Rex Desk hands the queue over as a steer.
    notify('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Reading the logs.' } });
    await new Promise(done => setTimeout(done, 50));
    const ticket = () => t.store.list('delivery')[0];
    if (steer === 'accepted') {
      assert.equal(ticket()?.state, 'taken', 'Codex accepted the steer');
      finish(); await t.settled(); await t.desk.schedules.tick(at(0, '09:05'));
      assert.equal(t.store.get('schedmsg', once.id).on, false, 'sent'); assert.equal(starts, 1, 'no second turn');
      continue;
    }
    assert.notEqual(ticket()?.state, 'taken', 'a refused steer is not taken');
    assert.ok(t.runOf().queued.some(text => text.includes('Ping')), 'back in the queue');
    await t.desk.schedules.tick(at(0, '09:02'));
    assert.equal(t.store.get('schedmsg', once.id).on, true, 'still due');
    finish(); await t.settled(); await t.desk.schedules.tick(at(0, '09:05'));
    assert.equal(starts, 2, 'the next turn took it'); assert.equal(t.store.get('schedmsg', once.id).on, false, 'sent once that turn took it');
  }
});

test('path 9, Rex Desk restarts while a scheduled message is in flight in a turn nobody follows: it goes back to due and is sent again', async () => {
  const t = deskWith((options, launch) => ({ async start() { if (launch === 1) await new Promise(() => {}); }, interrupt() {}, close() {} }));
  await t.desk.schedules.tick(at(0, '09:00')); await new Promise(done => setTimeout(done, 80));
  assert.equal(t.store.list('delivery')[0]?.state, 'turn', 'in flight, not taken');
  // The restart: the turn's process is gone and the run is marked interrupted, as the store does on load.
  t.desk.live.clear(); t.store.put('run', t.runOf().id, { ...t.runOf(), state: 'interrupted', endedAt: new Date().toISOString(), error: 'Server restarted. Resume this run to continue.' });
  t.desk.reattachHosts();
  assert.equal(t.store.list('delivery')[0]?.state, 'lost', 'never confirmed, so back to due');
  await t.desk.schedules.tick(at(0, '09:05')); await t.settled(); await t.desk.schedules.tick(at(0, '09:10'));
  assert.equal(t.launches.length, 2, 'sent again'); assert.equal(t.item().on, false, 'sent once the new turn took it');
});

test('path 10, two Codex steers overlap: the first accepted settles only its own message, the second refused stays due', async () => {
  let notify, finish, starts = 0, steers = 0, acceptFirst, refuseSecond;
  const clientFactory = options => ({ open: async () => {}, close() {}, request: async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      const id = `u${++starts}`;
      if (starts === 1) { notify = options.onNotification; finish = () => options.onNotification('turn/completed', { threadId: 'thread-1', turn: { id, status: 'completed' } }); }
      else setTimeout(() => { options.onNotification('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Done.' } }); options.onNotification('turn/completed', { threadId: 'thread-1', turn: { id, status: 'completed' } }); }, 5);
      return { turn: { id } };
    }
    // Both steers are in flight at once: Codex accepts the first, then refuses the second.
    if (method === 'turn/steer') return ++steers === 1 ? new Promise(done => { acceptFirst = () => done({}); }) : new Promise((done, fail) => { refuseSecond = () => fail(new Error('turn/steer refused')); });
    return {};
  } });
  const t = deskWith(options => new CodexRunner({ ...options, clientFactory }), 'codex');
  t.store.delete('schedmsg', t.once.id);
  const first = t.desk.schedules.create(t.agent.id, { text: 'First ping', time: '09:00', repeat: 'once' }, at(0, '08:00'));
  const second = t.desk.schedules.create(t.agent.id, { text: 'Second ping', time: '09:01', repeat: 'once' }, at(0, '08:00'));
  void t.desk.specialistTurn(t.agent.id, { prompt: 'Look at the logs' }); await new Promise(done => setTimeout(done, 100));
  await t.desk.schedules.tick(at(0, '09:00'));
  notify('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Step one.' } });
  await new Promise(done => setTimeout(done, 30));
  await t.desk.schedules.tick(at(0, '09:01'));
  notify('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Step two.' } });
  await new Promise(done => setTimeout(done, 30));
  acceptFirst(); await new Promise(done => setTimeout(done, 30));
  refuseSecond(); await new Promise(done => setTimeout(done, 30));
  const state = text => t.store.list('delivery').find(item => item.text.endsWith(text))?.state;
  assert.equal(state('First ping'), 'taken', 'the accepted steer settles its own message');
  assert.notEqual(state('Second ping'), 'taken', 'the refused steer is not counted as sent');
  assert.ok(t.runOf().queued.some(text => text.includes('Second ping')), 'the refused one is back in the queue');
  finish(); await t.settled(); await t.desk.schedules.tick(at(0, '09:05'));
  assert.equal(t.store.get('schedmsg', first.id).on, false, 'first sent');
  assert.equal(starts, 2, 'the next turn took the second'); assert.equal(t.store.get('schedmsg', second.id).on, false, 'second sent once that turn took it');
});

test('path 11, "Ping the team" accepted and "Ping" refused at the same set time: each steer settles only its own ticket', async () => {
  let notify, finish, starts = 0, steers = 0, acceptFirst, refuseSecond;
  const clientFactory = options => ({ open: async () => {}, close() {}, request: async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      const id = `u${++starts}`;
      if (starts === 1) { notify = options.onNotification; finish = () => options.onNotification('turn/completed', { threadId: 'thread-1', turn: { id, status: 'completed' } }); }
      else setTimeout(() => { options.onNotification('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Done.' } }); options.onNotification('turn/completed', { threadId: 'thread-1', turn: { id, status: 'completed' } }); }, 5);
      return { turn: { id } };
    }
    if (method === 'turn/steer') return ++steers === 1 ? new Promise(done => { acceptFirst = () => done({}); }) : new Promise((done, fail) => { refuseSecond = () => fail(new Error('turn/steer refused')); });
    return {};
  } });
  const t = deskWith(options => new CodexRunner({ ...options, clientFactory }), 'codex');
  t.store.delete('schedmsg', t.once.id);
  const team = t.desk.schedules.create(t.agent.id, { text: 'Ping the team', time: '09:00', repeat: 'once' }, at(0, '08:00'));
  void t.desk.specialistTurn(t.agent.id, { prompt: 'Look at the logs' }); await new Promise(done => setTimeout(done, 100));
  await t.desk.schedules.tick(at(0, '09:00'));
  notify('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Step one.' } });
  await new Promise(done => setTimeout(done, 30));
  // A second schedule for the same time, whose text is the start of the first one's.
  const ping = t.desk.schedules.create(t.agent.id, { text: 'Ping', time: '09:00', repeat: 'once' }, at(0, '08:00'));
  await t.desk.schedules.tick(at(0, '09:00'));
  notify('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Step two.' } });
  await new Promise(done => setTimeout(done, 30));
  acceptFirst(); await new Promise(done => setTimeout(done, 30));
  refuseSecond(); await new Promise(done => setTimeout(done, 30));
  const state = text => t.store.list('delivery').find(item => item.text.endsWith(`\n${text}`))?.state;
  assert.equal(state('Ping the team'), 'taken', 'the accepted steer settles its own message');
  assert.notEqual(state('Ping'), 'taken', 'the refused "Ping" is not counted as sent');
  assert.ok(t.runOf().queued.some(text => text.endsWith('\nPing')), 'the refused one is back in the queue');
  finish(); await t.settled(); await t.desk.schedules.tick(at(0, '09:05'));
  assert.equal(t.store.get('schedmsg', team.id).on, false, '"Ping the team" sent');
  assert.equal(starts, 2, 'the next turn took "Ping"'); assert.equal(t.store.get('schedmsg', ping.id).on, false, '"Ping" sent once that turn took it');
});

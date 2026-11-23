import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { inHours, cleanHours } from '../src/specialists.js';
import { nextRun } from '../src/schedules.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup() {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop', description: 'Online shop' }));
  const store = new Store(temporary('sched')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  desk.memory.scan({ roots: [projects] });
  const agent = desk.specialists.create({ name: 'Desky', projectSlug: 'shop' });
  const sent = []; desk.specialistTurn = async (agentId, input) => { sent.push({ agentId, ...input }); return { id: `run-${sent.length}` }; };
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
  desk.specialistTurn = async (agentId, input) => { sent.push({ agentId, ...input }); return { id: 'run-x' }; };
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
    desk.specialistTurn = async () => { desk.schedules.toggle(item.id, false); if (fails) throw new Error('no account'); return { id: 'run-x' }; };
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
    if (sent.length === 1) { const others = [first, second, third].filter(item => !input.prompt.includes(item.text)); desk.schedules.toggle(others[0].id, false); store.delete('schedmsg', others[1].id); }
    return { id: 'run-x' };
  };
  await desk.schedules.tick(at(0, '09:00'));
  assert.equal(sent.length, 1, 'only the first one was sent');
});

test('a scheduled message counts as sent only once its turn really started: a start that fails leaves it on and due', async () => {
  const { store, desk, agent } = setup();
  desk.specialists.status = () => ({ state: 'idle' });
  const once = desk.schedules.create(agent.id, { text: 'Ping', time: '09:00', repeat: 'once' }, at(0, '08:00'));
  const run = id => { store.put('run', id, { id, state: 'queued' }); return { id }; };
  desk.specialistTurn = async () => run('run-a');
  await desk.schedules.tick(at(0, '09:00'));
  assert.equal(store.get('schedmsg', once.id).on, true, 'only queued: not sent yet');
  store.put('run', 'run-a', { ...store.get('run', 'run-a'), state: 'failed', error: 'no account' });
  let calls = 0; desk.specialistTurn = async () => { calls++; return run('run-b'); };
  await desk.schedules.tick(at(0, '09:05'));
  const saved = store.get('schedmsg', once.id);
  assert.equal(saved.on, true, 'a failed start keeps it on'); assert.match(saved.error || '', /no account/); assert.equal(calls, 1, 'and it is tried again');
  store.put('run', 'run-b', { ...store.get('run', 'run-b'), state: 'running', turnStartedAt: new Date().toISOString() });
  await desk.schedules.tick(at(0, '09:07'));
  assert.equal(store.get('schedmsg', once.id).on, true, 'turnStartedAt alone is not a launch');
  store.put('run', 'run-b', { ...store.get('run', 'run-b'), turnLaunchedAt: new Date().toISOString() });
  await desk.schedules.tick(at(0, '09:10'));
  assert.equal(store.get('schedmsg', once.id).on, false, 'sent once the turn started'); assert.equal(calls, 1);
  assert.equal(store.get('schedmsg', once.id).lastAt, at(0, '09:05').toISOString());
});

test('a one-time message whose agent fails to launch after its turn was marked started stays due, and is sent on the next launch', async () => {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop' }));
  let launches = 0;
  const store = new Store(temporary('sched')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), runnerFactory: options => ({
    async start() { launches++; if (launches === 1) throw new Error('spawn claude ENOENT'); options.event('session', { sessionId: 'abc' }); options.event('agent-text', { text: 'On it.' }); }, interrupt() {}, close() {} }) });
  desk.memory.scan({ roots: [projects] });
  const agent = desk.specialists.create({ name: 'Desky', projectSlug: 'shop' });
  desk.specialists.status = () => ({ state: 'idle' });
  const once = desk.schedules.create(agent.id, { text: 'Ping', time: '09:00', repeat: 'once' }, at(0, '08:00'));
  const settled = async () => { for (let step = 0; step < 100 && desk.live.size; step++) await new Promise(done => setTimeout(done, 20)); };
  await desk.schedules.tick(at(0, '09:00')); await settled();
  const run = store.get('run', store.get('specialist', agent.id).runId);
  assert.equal(run.state, 'failed'); assert.ok(run.turnStartedAt, 'the turn was marked started before the launch failed');
  // The next tick sees the failed launch, keeps the message due and sends it again.
  await desk.schedules.tick(at(0, '09:05')); await settled(); await desk.schedules.tick(at(0, '09:10'));
  assert.equal(launches, 2, 'the failed launch left it due, so it was tried again');
  assert.equal(store.get('schedmsg', once.id).on, false, 'sent once the agent really launched');
  await desk.schedules.tick(at(0, '09:15')); await settled();
  assert.equal(launches, 2, 'never sent twice');
});

test('a one-time message whose session opens but whose prompt submit fails (Codex style) stays due, and is sent once the prompt is accepted', async () => {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop' }));
  let launches = 0;
  // Like CodexRunner: the thread (session) opens first, then turn/start submits the prompt. The first submit fails.
  const store = new Store(temporary('sched')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), provider: 'codex', runnerFactory: options => ({
    async start() {
      launches++; options.event('session', { sessionId: `thread-${launches}`, apiKeySource: 'subscription' });
      if (launches === 1) throw new Error('turn/start failed: connection closed');
      options.event('prompt-accepted', { turnId: 'turn-2' });
    }, interrupt() {}, close() {} }) });
  desk.memory.scan({ roots: [projects] });
  const agent = desk.specialists.create({ name: 'Desky', projectSlug: 'shop' });
  desk.specialists.status = () => ({ state: 'idle' });
  const once = desk.schedules.create(agent.id, { text: 'Ping', time: '09:00', repeat: 'once' }, at(0, '08:00'));
  const settled = async () => { for (let step = 0; step < 100 && desk.live.size; step++) await new Promise(done => setTimeout(done, 20)); };
  await desk.schedules.tick(at(0, '09:00')); await settled();
  const run = store.get('run', store.get('specialist', agent.id).runId);
  assert.equal(run.state, 'failed'); assert.equal(run.sessionId, 'thread-1', 'the session opened before the submit failed');
  assert.equal(run.turnLaunchedAt, undefined, 'an opened session is not an accepted prompt');
  await desk.schedules.tick(at(0, '09:05'));
  await settled(); await desk.schedules.tick(at(0, '09:10'));
  assert.equal(launches, 2, 'the failed submit left it due, so it was tried again');
  assert.equal(store.get('schedmsg', once.id).on, false, 'sent once the prompt was accepted');
  await desk.schedules.tick(at(0, '09:15')); await settled();
  assert.equal(launches, 2, 'never sent twice');
});

test('a one-time message whose turn ends cleanly without any answer event still counts as sent', async () => {
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
  assert.ok(store.get('run', store.get('specialist', agent.id).runId).turnLaunchedAt, 'a clean end marks the prompt taken');
  assert.equal(store.get('schedmsg', once.id).on, false); assert.equal(launches, 1, 'not sent twice');
});

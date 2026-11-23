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

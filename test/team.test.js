import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const waitFor = async (check, what = 'it') => { for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`timed out waiting for ${what}`); };
function setup(reply) {
  const store = new Store(temporary('team')), turns = [];
  const desk = new Desk(store, { root: temporary('team-root'), memoryDirectory: temporary('team-memory'), runnerFactory: options => ({ async start(prompt) {
    turns.push({ run: options.run, prompt });
    options.event('session', { sessionId: crypto.randomUUID() });
    await new Promise(resolve => setTimeout(resolve, 60));
    options.event('agent-text', { text: reply(prompt, options.run) });
  }, async interrupt() {} }) });
  return { store, desk, turns };
}
const idle = (store, desk) => store.list('run').every(run => !desk.live.has(run.id));

test('a manager gives a task to another agent, stays free, and is handed the result when it is done', async () => {
  const { store, desk, turns } = setup(prompt => /Task \w+ from Rex Agent/.test(prompt) ? 'Built the login page. Tests pass.' : /ended: done/.test(prompt) ? 'Dev finished the login page.' : 'Hello.');
  try {
    const dev = desk.specialists.create({ name: 'Dev', purpose: 'Builds features' });
    const rex = await desk.startMain({ prompt: 'hi' });
    await waitFor(() => store.get('run', rex.id).state === 'finished', 'the first turn');
    const given = await desk.team.delegate(rex.id, { agent: 'Dev', task: 'Build the login page and run the tests.', title: 'Login page' });
    assert.equal(given.state, 'working'); assert.equal(given.agent, 'Dev');
    assert.ok(!desk.live.has(rex.id), 'the manager is free at once');
    await waitFor(() => desk.team.tasks()[0].state === 'done', 'the task to finish');
    assert.match(turns.find(turn => turn.run.specialistId === dev.id).prompt, /Task \w+ from Rex Agent[\s\S]*Build the login page/);
    await waitFor(() => turns.some(turn => turn.run.id === rex.id && /that you gave Dev \(Login page\) ended: done[\s\S]*Tests pass/.test(turn.prompt)), 'the result handed to the manager');
    assert.ok(store.events(rex.id, { visible: true }).some(event => event.kind === 'message' && /Dev · Login page · done/.test(event.text)), 'the result is in the manager chat for the person');
    const seen = desk.team.overview(rex.id);
    assert.equal(seen.agents[0].name, 'Dev'); assert.equal(seen.tasks[0].state, 'done'); assert.match(seen.tasks[0].result, /Tests pass/);
    await assert.rejects(desk.team.delegate(rex.id, { agent: 'Nobody', task: 'x y z' }), /No agent "Nobody"/);
    await waitFor(() => idle(store, desk), 'everything to settle');
  } finally { await desk.shutdown?.(); store.close(); }
});

test('a worker that needs an answer asks its manager, carries on when answered, and a busy worker takes the next task when free', async () => {
  let asked = false;
  const { store, desk, turns } = setup(prompt => {
    if (/Task \w+ from Rex Agent[\s\S]*checkout/.test(prompt) && !asked) { asked = true; return 'I looked at the checkout.\nNEED: Should the coupon apply before or after tax?'; }
    if (/answers your question/.test(prompt)) return 'Coupon now applies before tax. Done.';
    if (/Task \w+ from Rex Agent[\s\S]*README/.test(prompt)) return 'README updated.';
    return 'Noted.';
  });
  try {
    desk.specialists.create({ name: 'Dev', purpose: 'Builds features' });
    const rex = await desk.startMain({ prompt: 'hi' });
    await waitFor(() => store.get('run', rex.id).state === 'finished', 'the first turn');
    const first = await desk.team.delegate(rex.id, { agent: 'Dev', task: 'Fix the checkout coupon.', title: 'Coupon' });
    const second = await desk.team.delegate(rex.id, { agent: 'Dev', task: 'Update the README.', title: 'README' });
    assert.equal(second.state, 'queued', 'one task at a time for each agent');
    await waitFor(() => desk.team.tasks()[0].state === 'needs-manager', 'the question');
    assert.match(desk.team.tasks()[0].question, /before or after tax/);
    await waitFor(() => turns.some(turn => turn.run.id === rex.id && /cannot go on with task[\s\S]*before or after tax/.test(turn.prompt)), 'the question handed to the manager');
    assert.equal(desk.team.tasks()[1].state, 'queued', 'the next task waits while the first is open');
    await waitFor(() => idle(store, desk), 'the manager turn');
    await desk.team.answer(rex.id, { id: first.id, text: 'Before tax.' });
    await waitFor(() => desk.team.tasks()[0].state === 'done', 'the first task');
    await waitFor(() => desk.team.tasks()[1].state === 'done', 'the queued task');
    assert.match(desk.team.tasks()[1].answer, /README updated/);
    await assert.rejects(desk.team.cancel(rex.id, { id: second.id }), /already ended/);
    await waitFor(() => idle(store, desk), 'everything to settle');
  } finally { await desk.shutdown?.(); store.close(); }
});

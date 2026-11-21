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
    assert.deepEqual(desk.snapshot().teamTasks.map(task => [task.title, task.workerName, task.state]), [['Login page', 'Dev', 'working']], 'the Team tab sees it');
    assert.ok(!desk.live.has(rex.id), 'the manager is free at once');
    await waitFor(() => desk.team.tasks()[0].state === 'done', 'the task to finish');
    assert.match(turns.find(turn => turn.run.specialistId === dev.id).prompt, /Task \w+ from Rex Agent[\s\S]*Build the login page/);
    await waitFor(() => turns.some(turn => turn.run.teamOf === 'main' && /that you gave Dev \(Login page\) ended: done[\s\S]*Tests pass/.test(turn.prompt)), 'the result handed to the manager');
    assert.ok(!turns.some(turn => turn.run.id === rex.id && /ended: done/.test(turn.prompt)), 'the person\'s chat with the manager is not used for the report');
    assert.ok(!store.events(rex.id, { visible: true }).some(event => /Login page|Tests pass/.test(event.text || '')), 'nothing about the report shows in the person\'s chat');
    const session = store.list('run').find(run => run.teamOf === 'main');
    assert.equal(session.roomAgent, 'main'); assert.ok(!session.main, 'the team session is not the personal chat');
    assert.equal(desk.snapshot().teamTasks[0].answer, 'Built the login page. Tests pass.', 'the Team tab has the report');
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
    await waitFor(() => turns.some(turn => turn.run.teamOf === 'main' && /cannot go on with task[\s\S]*before or after tax/.test(turn.prompt)), 'the question handed to the manager');
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

test('a task for an agent on the other computer travels there, runs, and its result comes back to the manager', async () => {
  const home = setup(prompt => /ended: done/.test(prompt) ? 'QA is finished.' : 'Hello.');
  const work = setup(prompt => /Task \w+ from Rex Agent/.test(prompt) ? 'Checked the login page on the work laptop: 3 tests pass.' : 'Hello.');
  // What the shared data does between the two computers: a command made on one arrives on the other and runs there.
  const carry = async (from, to) => { for (const command of from.store.list('peercmd')) if (command.target === to.store.nodeId && !to.store.get('peercmd', command.id)) { to.store.put('peercmd', command.id, command); await to.desk.peers.runCommand(to.store.get('peercmd', command.id)); } };
  try {
    assert.notEqual(home.store.nodeId, work.store.nodeId);
    const qa = work.desk.specialists.create({ name: 'QA', purpose: 'Tests features' });
    work.store.put('specialist', qa.id, { ...work.store.get('specialist', qa.id), node: work.store.nodeId });
    home.store.put('specialist', qa.id, { ...work.store.get('specialist', qa.id) });
    assert.ok(home.desk.peers.isRemote(home.store.get('specialist', qa.id)), 'on the home computer QA lives elsewhere');
    const rex = await home.desk.startMain({ prompt: 'hi' });
    await waitFor(() => home.store.get('run', rex.id).state === 'finished', 'the first turn');
    const given = await home.desk.team.delegate(rex.id, { agent: 'QA', task: 'Check the login page.', title: 'Check login' });
    assert.equal(given.state, 'working'); assert.match(given.note, /works on/);
    assert.equal(home.turns.filter(turn => turn.run.specialistId === qa.id).length, 0, 'it does not run on the manager computer');
    await carry(home, work);
    await waitFor(() => work.desk.team.tasks()[0]?.state === 'done', 'the task on the work computer');
    assert.match(work.turns.find(turn => turn.run.specialistId === qa.id).prompt, /Task \w+ from Rex Agent[\s\S]*Check the login page/);
    assert.equal(work.desk.team.overview(work.store.get('specialist', qa.id).runId).tasks.length, 0, 'a task from the other computer is not shown as a task of an agent here');
    await carry(work, home);
    await waitFor(() => home.desk.team.tasks()[0].state === 'done', 'the result back home');
    assert.match(home.desk.team.tasks()[0].answer, /3 tests pass/);
    await waitFor(() => home.turns.some(turn => turn.run.teamOf === 'main' && /that you gave QA \(Check login\) ended: done[\s\S]*3 tests pass/.test(turn.prompt)), 'the result handed to the manager');
    await waitFor(() => idle(home.store, home.desk) && idle(work.store, work.desk), 'everything to settle');
  } finally { await home.desk.shutdown?.(); home.store.close(); await work.desk.shutdown?.(); work.store.close(); }
});

test('the team session reuses one session per manager, and its desk_message goes to the person\'s chat with that manager', async () => {
  const { store, desk, turns } = setup(prompt => /Task \w+ from Lead/.test(prompt) ? 'Done.' : 'Noted.');
  try {
    const lead = desk.specialists.create({ name: 'Lead', purpose: 'Manages the team' });
    desk.specialists.create({ name: 'Dev', purpose: 'Builds features' });
    const chat = await desk.specialistTurn(lead.id, { prompt: 'hi' });
    await waitFor(() => idle(store, desk), 'the first turn');
    await desk.team.delegate(chat.id, { agent: 'Dev', task: 'Build one thing.', title: 'One' });
    await waitFor(() => turns.some(turn => turn.run.teamOf === lead.id && /One\) ended: done/.test(turn.prompt)), 'the first report');
    await waitFor(() => idle(store, desk), 'settle');
    await desk.team.delegate(chat.id, { agent: 'Dev', task: 'Build another thing.', title: 'Two' });
    await waitFor(() => turns.some(turn => turn.run.teamOf === lead.id && /Two\) ended: done/.test(turn.prompt)), 'the second report');
    await waitFor(() => idle(store, desk), 'settle again');
    const sessions = store.list('run').filter(run => run.teamOf === lead.id);
    assert.equal(sessions.length, 1, 'one team session for the manager');
    assert.equal(sessions[0].specialistId, lead.id);
    desk.message(sessions[0].id, 'Rex, pick a colour for the button.');
    assert.ok(store.events(chat.id, { visible: true }).some(event => event.kind === 'message' && /pick a colour/.test(event.text)), 'it lands in the personal chat');
  } finally { await desk.shutdown?.(); store.close(); }
});

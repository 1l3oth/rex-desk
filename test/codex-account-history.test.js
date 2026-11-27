import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { codexThreadHere } from '../src/agents.js';

// Every folder here is a throwaway on D: (next to the project), never a real Codex account.
const base = path.join(path.resolve(import.meta.dirname, '..', '..', '..'), 'tmp', 'codex-account-tests');
mkdirSync(base, { recursive: true });
const temporary = label => mkdtempSync(path.join(base, `${label}-`));
const waitFor = async (check, what = 'it') => { for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`timed out waiting for ${what}`); };
const rollouts = home => { const found = []; const walk = folder => { for (const entry of (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : [])) entry.isDirectory() ? walk(path.join(folder, entry.name)) : found.push(path.join(folder, entry.name)); }; walk(path.join(home, 'sessions')); return found.sort(); };

// A pretend Codex: a new thread writes its rollout into the account's own CODEX_HOME, and reopening a thread that account does
// not have fails the way the real one does.
function fakeCodex(turns) {
  return options => ({ async start(prompt) {
    const run = options.run, home = options.agentEnv.CODEX_HOME || '';
    turns.push({ run, prompt, home });
    if (run.provider === 'codex') {
      if (run.sessionId) {
        if (!codexThreadHere(run.sessionId, home)) throw new Error(`no rollout found for thread id ${run.sessionId}`);
        options.event('session', { sessionId: run.sessionId });
      } else {
        const thread = randomUUID(), day = path.join(home, 'sessions', '2026', '11', '27');
        mkdirSync(day, { recursive: true }); writeFileSync(path.join(day, `rollout-2026-11-27T10-00-00-${thread}.jsonl`), `{"thread":"${thread}"}\n`);
        options.event('session', { sessionId: thread });
      }
    }
    options.event('agent-text', { text: 'Done.' });
  }, async interrupt() {}, close() {} });
}
function setup() {
  const store = new Store(temporary('store')), turns = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), runnerFactory: fakeCodex(turns), threadHere: codexThreadHere });
  const first = temporary('codex-first'), second = temporary('codex-second');
  const use = profile => { store.saveConfig({ ...store.publicConfig(), provider: 'codex', agentProfiles: { codex: profile } }); desk.agents.invalidate('codex'); };
  use(first);
  return { store, desk, turns, first, second, use };
}
const cleared = (store, runId) => store.events(runId, { limit: 200 }).filter(event => event.kind === 'chat-cleared');
const said = (store, runId, text) => store.events(runId, { visible: true, limit: 200 }).filter(event => event.kind === 'human-message' && event.text === text).length;

test('codexThreadHere finds a thread only in the account that has its rollout, and only reads names', () => {
  const home = temporary('codex-home'), other = temporary('codex-other'), thread = randomUUID(), day = path.join(home, 'sessions', '2026', '11', '27');
  mkdirSync(day, { recursive: true }); writeFileSync(path.join(day, `rollout-2026-11-27T10-00-00-${thread}.jsonl`), '{}\n');
  assert.equal(codexThreadHere(thread, home), true);
  assert.equal(codexThreadHere(thread.toUpperCase(), home), true, 'the id is matched whatever its case');
  assert.equal(codexThreadHere(thread, other), false, 'another account has no sessions folder');
  assert.equal(codexThreadHere(randomUUID(), home), false);
  assert.equal(codexThreadHere('', home), false);
  assert.deepEqual(rollouts(other), [], 'nothing is written into the other account');
});

test('after switching Codex accounts the chat carries on with a handoff, the message is kept, and switching back works too', async () => {
  const { store, desk, turns, first, second, use } = setup();
  try {
    const run = await desk.startMain({ prompt: 'Look at the login page', provider: 'codex' });
    await waitFor(() => desk.run(run.id).state === 'finished' && desk.run(run.id).sessionId, 'the first turn');
    const firstThread = desk.run(run.id).sessionId, firstFiles = rollouts(first), firstContent = readFileSync(firstFiles[0], 'utf8');
    assert.equal(firstFiles.length, 1);

    use(second);
    await desk.resume(run.id, { prompt: 'Now fix it' });
    await waitFor(() => turns.length === 2 && desk.run(run.id).state === 'finished', 'the turn on the second account');
    assert.equal(path.resolve(turns[1].home), path.resolve(second), 'it ran on the second account');
    assert.ok(!turns[1].run.sessionId, 'no stale thread id was sent to the second account');
    assert.match(turns[1].prompt, /First read the handoff [\s\S]*Now fix it/, 'the message goes in with the handoff');
    assert.match(readFileSync(desk.run(run.id).handoffFile || turns[1].prompt.match(/handoff (\S+\.md)/)[1], 'utf8'), /Look at the login page/, 'the handoff has the chat so far');
    assert.equal(said(store, run.id, 'Now fix it'), 1, 'the message shows once and is never lost');
    assert.equal(cleared(store, run.id).at(-1).why, 'codex-account');
    assert.ok(!store.events(run.id, { limit: 200 }).some(event => event.kind === 'error'), 'no technical error in the chat');
    const secondThread = desk.run(run.id).sessionId;
    assert.ok(secondThread && secondThread !== firstThread);

    // Back on the second account: the new thread there just reopens, no extra handoff.
    await desk.resume(run.id, { prompt: 'And the tests' });
    await waitFor(() => turns.length === 3 && desk.run(run.id).state === 'finished', 'the next turn');
    assert.equal(turns[2].run.sessionId, secondThread, 'the same account reopens its own thread');
    assert.equal(cleared(store, run.id).length, 1);

    // Switching back to the first account: its old thread is not the chat's current one, so it hands off again.
    use(first);
    await desk.resume(run.id, { prompt: 'Back on the first one' });
    await waitFor(() => turns.length === 4 && desk.run(run.id).state === 'finished', 'the turn after switching back');
    assert.equal(path.resolve(turns[3].home), path.resolve(first));
    assert.match(turns[3].prompt, /handoff[\s\S]*Back on the first one/);
    assert.equal(cleared(store, run.id).length, 2);
    assert.equal(cleared(store, run.id).at(-1).why, 'codex-account');

    assert.equal(readFileSync(firstFiles[0], 'utf8'), firstContent, "the first account's history is untouched");
    assert.equal(rollouts(second).length, 1, "the second account's history is kept, nothing copied in or deleted");
    assert.ok(!existsSync(path.join(second, 'auth.json')) && !existsSync(path.join(first, 'auth.json')), 'no sign-in file is made or touched');
  } finally { desk.closed = true; }
});

test('a Codex thread whose rollout is really gone carries on in a fresh thread and says so in one line', async () => {
  const { store, desk, turns, first } = setup();
  try {
    const run = await desk.startMain({ prompt: 'Hello', provider: 'codex' });
    await waitFor(() => desk.run(run.id).state === 'finished' && desk.run(run.id).sessionId, 'the first turn');
    rmSync(rollouts(first)[0]);
    await desk.resume(run.id, { prompt: 'Are you there?' });
    await waitFor(() => turns.length === 2 && desk.run(run.id).state === 'finished', 'the next turn');
    assert.match(turns[1].prompt, /handoff[\s\S]*Are you there\?/);
    assert.equal(said(store, run.id, 'Are you there?'), 1);
    const line = cleared(store, run.id);
    assert.equal(line.length, 1); assert.equal(line[0].why, 'codex-missing');
    assert.match(line[0].text, /could not find the earlier conversation/);
    assert.ok(!store.events(run.id, { limit: 200 }).some(event => event.kind === 'error'));
  } finally { desk.closed = true; }
});

test('a team task to a Codex agent works after the account was switched', async () => {
  const { store, desk, turns, second, use } = setup();
  try {
    const reviewer = desk.specialists.create({ name: 'Reviewer', purpose: 'Reviews code', provider: 'codex' });
    const rex = await desk.startMain({ prompt: 'hi', provider: 'codex' });
    await waitFor(() => desk.run(rex.id).state === 'finished', 'the manager turn');
    await desk.team.delegate(rex.id, { agent: 'Reviewer', task: 'Review the first change.', title: 'First review' });
    await waitFor(() => desk.team.tasks().some(task => task.title === 'First review' && task.state === 'done'), 'the first review');
    const workerRun = desk.specialists.get(reviewer.id).runId;
    assert.ok(desk.run(workerRun).sessionId);

    use(second);
    await waitFor(() => store.list('run').every(item => !desk.live.has(item.id)), 'everyone idle');
    await desk.team.delegate(rex.id, { agent: 'Reviewer', task: 'Review the second change.', title: 'Second review' });
    await waitFor(() => desk.team.tasks().some(task => task.title === 'Second review' && ['done', 'failed'].includes(task.state)), 'the second review');
    assert.equal(desk.team.tasks().find(task => task.title === 'Second review').state, 'done', 'the task is not failed');
    const turn = turns.filter(item => item.run.id === workerRun).at(-1);
    assert.equal(path.resolve(turn.home), path.resolve(second));
    assert.match(turn.prompt, /handoff[\s\S]*Review the second change/);
    assert.equal(cleared(store, workerRun).at(-1).why, 'codex-account');
  } finally { desk.closed = true; }
});

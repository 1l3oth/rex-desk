import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { canonical, codexThreadHere } from '../src/agents.js';

// Every folder here is a throwaway on D: (next to the project), never a real Codex account.
const base = path.join(path.resolve(import.meta.dirname, '..', '..', '..'), 'tmp', 'codex-account-tests');
mkdirSync(base, { recursive: true });
const temporary = label => mkdtempSync(path.join(base, `${label}-`));
const waitFor = async (check, what = 'it') => { for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`timed out waiting for ${what}`); };
const rollouts = home => { const found = []; const walk = folder => { for (const entry of (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : [])) entry.isDirectory() ? walk(path.join(folder, entry.name)) : found.push(path.join(folder, entry.name)); }; walk(path.join(home, 'sessions')); return found.sort(); };

// A pretend Codex: a new thread writes its rollout into the account's own CODEX_HOME, and reopening a thread that account does
// not have fails the way the real one does.
function fakeCodex(turns, gate = null, reply = () => 'Done.') {
  return options => ({ async start(prompt) {
    const run = options.run, home = options.agentEnv.CODEX_HOME || '';
    turns.push({ run, prompt, home });
    if (gate) await gate(turns.length);
    if (run.provider === 'codex') {
      if (run.sessionId) {
        if (!codexThreadHere(run.sessionId, home)) throw new Error(`no rollout found for thread id ${run.sessionId}`);
        options.event('session', { sessionId: run.sessionId });
      } else {
        const thread = randomUUID(), day = path.join(home, 'sessions', '2026', '11', '27');
        // The main account (no CODEX_HOME) is ~/.codex: the pretend Codex never writes there.
        if (home) mkdirSync(day, { recursive: true });
        if (home) writeFileSync(path.join(day, `rollout-2026-11-27T10-00-00-${thread}.jsonl`), `{"thread":"${thread}"}\n`);
        options.event('session', { sessionId: thread });
      }
    }
    options.event('agent-text', { text: reply(turns.length) });
  }, async interrupt() {}, close() {} });
}
function setup({ threadHere = codexThreadHere, gate = null, reply } = {}) {
  const store = new Store(temporary('store')), turns = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), runnerFactory: fakeCodex(turns, gate, reply), threadHere });
  const first = temporary('codex-first'), second = temporary('codex-second');
  const use = profile => { store.saveConfig({ ...store.publicConfig(), provider: 'codex', agentProfiles: { codex: profile } }); desk.agents.invalidate('codex'); };
  use(first);
  return { store, desk, turns, first, second, use };
}
// The one plain line a Codex account change leaves in the chat (a status line, so the waiting message stays in view).
const cleared = (store, runId) => store.events(runId, { limit: 200 }).filter(event => ['chat-cleared', 'account-switched'].includes(event.kind) && event.why);
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

test('a switch made while a message waits to launch checks the thread against the account the turn really launches on', async () => {
  const { store, desk, turns, first, second, use } = setup();
  try {
    const run = await desk.startMain({ prompt: 'Hello', provider: 'codex' });
    await waitFor(() => desk.run(run.id).state === 'finished' && desk.run(run.id).sessionId, 'the first turn');
    const firstThread = desk.run(run.id).sessionId;
    // The message is accepted on the first account, and the person switches before the turn picks its account.
    const startFolder = desk.startFolder.bind(desk);
    let switchNow = true;
    desk.startFolder = async (...args) => { if (switchNow) { switchNow = false; use(second); } return startFolder(...args); };
    await desk.resume(run.id, { prompt: 'Sent just before the switch' });
    await waitFor(() => turns.length === 2 && desk.run(run.id).state === 'finished', 'the waiting message');
    assert.equal(path.resolve(turns[1].home), path.resolve(second), 'it launched on the account chosen at launch');
    assert.ok(!turns[1].run.sessionId, 'the old thread id never reaches the new account');
    assert.match(turns[1].prompt, /handoff[\s\S]*Sent just before the switch/, 'the waiting message goes in with the handoff');
    assert.equal(said(store, run.id, 'Sent just before the switch'), 1);
    assert.equal(cleared(store, run.id).at(-1).why, 'codex-account');
    assert.equal(cleared(store, run.id).at(-1).kind, 'account-switched', 'a status line, so the waiting message is not cut from view');
    assert.ok(!store.events(run.id, { limit: 200 }).some(event => event.kind === 'error'));
    assert.ok(desk.run(run.id).sessionId && desk.run(run.id).sessionId !== firstThread);
    assert.equal(path.resolve(desk.run(run.id).sessionAccount), path.resolve(second), 'the new thread is noted on the account it was made on');
    assert.equal(rollouts(first).length, 1);
  } finally { desk.closed = true; }
});

test('a history folder that could not be read keeps the thread and the message, says so, and a retry reopens the same thread', async () => {
  let failing = false;
  const refused = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  const { store, desk, turns } = setup({ threadHere: (id, home) => codexThreadHere(id, home, failing ? { readdir: refused } : {}) });
  try {
    const run = await desk.startMain({ prompt: 'Hello', provider: 'codex' });
    await waitFor(() => desk.run(run.id).state === 'finished' && desk.run(run.id).sessionId, 'the first turn');
    const thread = desk.run(run.id).sessionId;
    failing = true;
    await desk.resume(run.id, { prompt: 'Keep this one' });
    await waitFor(() => desk.run(run.id).state === 'failed' && !desk.live.has(run.id), 'the check to fail');
    assert.equal(turns.length, 1, 'nothing was sent to Codex');
    assert.equal(desk.run(run.id).sessionId, thread, 'the thread id is kept');
    assert.deepEqual(desk.run(run.id).queued, ['Keep this one'], 'the message is kept for the retry');
    assert.equal(cleared(store, run.id).length, 0, 'no handoff, no fresh start');
    const error = store.events(run.id, { limit: 200 }).filter(event => event.kind === 'error').at(-1);
    assert.equal(error.why, 'codex-unchecked'); assert.match(error.message, /could not read this Codex account's history folder[\s\S]*Your message is kept/);

    failing = false;
    await desk.resume(run.id, { prompt: '' });
    await waitFor(() => turns.length === 2 && desk.run(run.id).state === 'finished', 'the retry');
    assert.equal(turns[1].run.sessionId, thread, 'the retry reopens the same thread');
    assert.match(turns[1].prompt, /Keep this one/);
    assert.doesNotMatch(turns[1].prompt, /handoff/);
    assert.equal(said(store, run.id, 'Keep this one'), 1, 'the message shows once');
  } finally { desk.closed = true; }
});

test('codexThreadHere says "could not check" for a read error and "missing" only for a folder that is not there', () => {
  const home = temporary('codex-home2'), thread = randomUUID();
  assert.equal(codexThreadHere(thread, path.join(home, 'no-such-account')), false);
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EMFILE']) assert.equal(codexThreadHere(thread, home, { readdir: () => { throw Object.assign(new Error(code), { code }); } }), null, code);
});

// The account a turn runs on is picked once. A selection changed while the handoff is written, or after the turn started,
// never makes its usage limit land on an account it did not use.
const LIMIT_TEXT = "You've hit your usage limit. Try again later.";
const limitedKeys = store => Object.keys(store.get('accounts', 'limited')?.until || {});

test('a selection changed during the handoff leaves the turn on the checked account, and its usage limit marks that account', async () => {
  const { store, desk, turns, second, use } = setup({ reply: turn => turn === 2 ? LIMIT_TEXT : 'Done.' });
  try {
    const third = temporary('codex-third'), seen = [];
    desk.agents.alternative = async (provider, current) => { seen.push(current); return null; };
    const run = await desk.startMain({ prompt: 'Hello', provider: 'codex' });
    await waitFor(() => desk.run(run.id).state === 'finished' && desk.run(run.id).sessionId, 'the first turn');
    use(second);
    const freshStart = desk.freshStart.bind(desk);
    let switchNow = true;
    desk.freshStart = async (...args) => { if (switchNow) { switchNow = false; use(third); } return freshStart(...args); };
    await desk.resume(run.id, { prompt: 'Carry on' });
    await waitFor(() => turns.length === 2 && seen.length && !desk.live.has(run.id), 'the limited turn');
    assert.equal(path.resolve(turns[1].home), path.resolve(second), 'it ran on the account it was checked against');
    assert.equal(desk.run(run.id).turnAccount, second, 'and recorded that one, not the selection made during the handoff');
    assert.equal(canonical(seen[0]), canonical(second), 'the limit is put on the account the turn used');
    assert.ok(limitedKeys(store).includes(canonical(second)));
    assert.ok(!limitedKeys(store).includes(canonical(third)), 'the account selected later is not marked used up');
  } finally { desk.closed = true; }
});

test("a turn on the main account ('') keeps it as its account when the selection changes mid-turn", async () => {
  let switchTo = null;
  const { store, desk, second, use } = setup({ reply: () => { if (switchTo) switchTo(); return LIMIT_TEXT; } });
  try {
    const seen = [];
    desk.agents.alternative = async (provider, current) => { seen.push(current); return null; };
    use('');
    switchTo = () => use(second);
    const run = await desk.startMain({ prompt: 'Hello', provider: 'codex' });
    await waitFor(() => seen.length && !desk.live.has(run.id), 'the limited turn');
    assert.equal(desk.run(run.id).turnAccount, '', 'the main account is recorded outright');
    assert.equal(seen[0], '', 'the limit is put on the main account, not the one selected mid-turn');
    assert.ok(!limitedKeys(store).includes(canonical(second)), 'the account selected later is not marked used up');
  } finally { desk.closed = true; }
});

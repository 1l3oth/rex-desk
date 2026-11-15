import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const waitFor = async (check, what) => { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out waiting for ${what}`); };

test('a chat whose context is nearly full writes its own handoff, starts fresh and carries on by itself', async () => {
  const store = new Store(temporary('handoff')), prompts = [];
  // Each turn: the agent reports how full its context is and says something. The fresh session (turn 3 on) is nearly empty.
  const desk = new Desk(store, { root: temporary('handoff-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt);
    const turn = prompts.length;
    options.event('context', { used: turn === 1 ? 180000 : turn === 2 ? 185000 : 20000 });
    options.event('agent-text', { text: turn === 2 ? 'HANDOFF: fixing the login page; next step is the test.' : `reply ${turn}` });
  }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('fix the login page');
    await waitFor(() => store.events(run.id, { visible: true }).some(event => event.kind === 'chat-cleared'), 'the automatic fresh start');
    const after = store.get('run', run.id);
    assert.match(prompts[1], /context is nearly full/);
    assert.ok(after.contextUsed < 100000, 'the fresh session starts with a nearly empty context');
    assert.equal(after.autoHandoff, undefined);
    const folder = path.join(store.directory, 'handoffs'), handoff = readFileSync(path.join(folder, readdirSync(folder)[0]), 'utf8');
    assert.match(handoff, /automatically, because the conversation filled 90% of the context/);
    assert.match(handoff, /HANDOFF: fixing the login page/);
    assert.ok(store.events(run.id, { visible: true }).find(event => event.kind === 'chat-cleared').auto);

    // Without anyone saying "continue", the fresh session reads the handoff first and carries on.
    await waitFor(() => prompts.length === 3, 'the fresh session carrying on');
    assert.match(prompts[2], /First read the handoff/);
    assert.match(prompts[2], /Carry on with the work from the handoff/);
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the carried-on turn');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(prompts.length, 3, 'it carries on once, it does not loop');

    // The person's next message goes to the same fresh session.
    await desk.say(run.id, 'carry on');
    await waitFor(() => prompts.length === 4, 'the next turn');
    assert.match(prompts[3], /carry on/);
  } finally { await desk.shutdown(); store.close(); }
});

test('a fresh session that fills up again at once carries on at most three times, not for ever', async () => {
  const store = new Store(temporary('handoff-loop')), prompts = [];
  const desk = new Desk(store, { root: temporary('handoff-loop-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt); options.event('context', { used: 190000 });
  }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('fix the login page');
    await waitFor(() => store.events(run.id, { visible: true }).filter(event => event.kind === 'chat-cleared').length === 4, 'four fresh starts');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(prompts.filter(prompt => /Carry on with the work from the handoff/.test(prompt)).length, 3);
  } finally { await desk.shutdown(); store.close(); }
});

test('with autoContinue off, the fresh session waits for the next message', async () => {
  const store = new Store(temporary('handoff-wait')), prompts = [];
  const desk = new Desk(store, { root: temporary('handoff-wait-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt); options.event('context', { used: prompts.length === 1 ? 180000 : 185000 });
  }, async interrupt() {} }) });
  try {
    store.saveConfig({ ...store.publicConfig(), autoContinue: false });
    const run = await desk.startWebTask('fix the login page');
    await waitFor(() => store.events(run.id, { visible: true }).some(event => event.kind === 'chat-cleared'), 'the automatic fresh start');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(prompts.length, 2);
  } finally { await desk.shutdown(); store.close(); }
});

test('automatic handoff stays off below the threshold and when turned off', async () => {
  const store = new Store(temporary('handoff-off')); let turns = 0;
  const desk = new Desk(store, { root: temporary('handoff-off-root'), runnerFactory: options => ({ async start() { turns++; options.event('context', { used: 190000 }); }, async interrupt() {} }) });
  try {
    store.saveConfig({ ...store.publicConfig(), autoHandoff: false });
    const run = await desk.startWebTask('look at this');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the turn');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(turns, 1);
    assert.ok(!store.events(run.id, { visible: true }).some(event => event.kind === 'chat-cleared'));
  } finally { await desk.shutdown(); store.close(); }
});

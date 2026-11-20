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

test('on a 1M window the fresh start comes at 200k tokens, not at 85% of the window (L58)', async () => {
  const store = new Store(temporary('handoff-tokens')), prompts = [];
  const desk = new Desk(store, { root: temporary('handoff-tokens-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt); options.event('context', { used: prompts.length === 1 ? 210000 : prompts.length === 2 ? 215000 : 15000, window: 1000000 });
    options.event('agent-text', { text: prompts.length === 2 ? 'HANDOFF: next step is the test.' : 'ok' });
  }, async interrupt() {} }) });
  try {
    assert.equal(store.config().handoffTokens, 200000, '200k by default');
    const run = await desk.startWebTask('fix the login page');
    await waitFor(() => store.events(run.id, { visible: true }).some(event => event.kind === 'chat-cleared'), 'the fresh start at 210k of 1M');
    assert.match(prompts[1], /context is nearly full/);
    const folder = path.join(store.directory, 'handoffs'), handoff = readFileSync(path.join(folder, readdirSync(folder)[0]), 'utf8');
    assert.match(handoff, /reached 210k tokens \(the limit is 200k\)/);
  } finally { await desk.shutdown(); store.close(); }
});

test('the token limit is a setting: 300k waits longer, and off leaves only the share of the window (L58)', async () => {
  const store = new Store(temporary('handoff-setting')); let turns = 0;
  const desk = new Desk(store, { root: temporary('handoff-setting-root'), runnerFactory: options => ({ async start() { turns++; options.event('context', { used: 250000, window: 1000000 }); }, async interrupt() {} }) });
  try {
    store.saveConfig({ ...store.publicConfig(), handoffTokens: 300000 });
    assert.equal(store.config().handoffTokens, 300000);
    const run = await desk.startWebTask('look at this');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the turn');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(turns, 1, 'no handoff below 300k');
    store.saveConfig({ ...store.publicConfig(), handoffTokens: '0' });
    assert.equal(store.config().handoffTokens, 0);
  } finally { await desk.shutdown(); store.close(); }
});

test('a long turn far past the limit stops at the next step and hands off, without waiting for the turn to end (L58)', async () => {
  const store = new Store(temporary('handoff-mid')), prompts = []; let cut = false, stepsAfter = 0;
  const desk = new Desk(store, { root: temporary('handoff-mid-root'), runnerFactory: options => {
    let stopped = false;
    return { async start(prompt) {
      prompts.push(prompt);
      if (prompts.length > 1) { options.event('context', { used: prompts.length === 2 ? 330000 : 12000, window: 1000000 }); options.event('agent-text', { text: prompts.length === 2 ? 'HANDOFF: half way.' : 'ok' }); return; }
      // A working turn that keeps growing: each step re-sends more. It ends only when interrupted.
      for (let step = 1; step <= 50 && !stopped; step++) { options.event('context', { used: 100000 * step, window: 1000000 }); if (cut) stepsAfter++; await new Promise(resolve => setTimeout(resolve, 10)); }
    }, async interrupt() { cut = true; stopped = true; } };
  } });
  try {
    const run = await desk.startWebTask('a long job');
    await waitFor(() => store.events(run.id, { visible: true }).some(event => event.kind === 'chat-cleared'), 'the mid-turn fresh start');
    assert.ok(cut, 'the turn was cut');
    assert.ok(stepsAfter <= 1, 'it stopped at the next step');
    assert.ok(store.events(run.id, { visible: true }).some(event => event.kind === 'phase' && /far past 200k/.test(event.text)));
    assert.match(prompts[1], /context is nearly full/);
    assert.notEqual(store.get('run', run.id).state, 'failed');
    assert.equal(store.get('run', run.id).handoffMidTurn, undefined);
  } finally { await desk.shutdown(); store.close(); }
});

test('a late context report from the old session after a fresh start is ignored, and no second handoff fires (L60)', async () => {
  const store = new Store(temporary('handoff-stale')), prompts = [], reporters = [];
  const desk = new Desk(store, { root: temporary('handoff-stale-root'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt); reporters.push(options.event);
    options.event('context', { used: prompts.length === 1 ? 210000 : prompts.length === 2 ? 215000 : 40000, window: 1000000 });
    options.event('agent-text', { text: prompts.length === 2 ? `HANDOFF:\n${'a long line of notes\n'.repeat(2000)}` : 'ok' });
  }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('fix the login page');
    await waitFor(() => prompts.length === 3 && store.get('run', run.id).state === 'finished', 'the fresh session carrying on');
    assert.equal(store.get('run', run.id).contextUsed, 40000, 'the ring shows the fresh session');
    // The old session's runner reports its size once more, after the reset (the cut turn, a late result).
    reporters[1]('context', { used: 447000, window: 1000000 });
    reporters[0]('context', { used: 447000, window: 1000000 });
    assert.equal(store.get('run', run.id).contextUsed, 40000, 'a stale report does not change the ring');
    await desk.say(run.id, 'next');
    await waitFor(() => prompts.length === 4 && store.get('run', run.id).state === 'finished', 'the next turn');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(store.events(run.id, { visible: true }).filter(event => event.kind === 'chat-cleared').length, 1, 'no second handoff');
    // The handoff file stays about 4k tokens even when the agent's note is long.
    const folder = path.join(store.directory, 'handoffs'), handoff = readFileSync(path.join(folder, readdirSync(folder)[0]), 'utf8');
    assert.ok(handoff.length < 16000, `handoff is ${handoff.length} characters`);
    assert.match(handoff, /cut to keep the handoff short/);
    assert.equal(store.get('run', run.id).handoffMidTurn, undefined);
  } finally { await desk.shutdown(); store.close(); }
});

test('a working reply makes no hidden memory turn; the next real message carries the reminder in one line (L61)', async () => {
  const store = new Store(temporary('memory-fold')), prompts = [];
  const desk = new Desk(store, { root: temporary('memory-fold-root'), memoryDirectory: temporary('memory-fold-mem'), runnerFactory: options => ({ async start(prompt) {
    prompts.push(prompt);
    options.event('session', { sessionId: '11111111-2222-4333-8444-555555555555' });
    options.event('context', { used: 30000 });
    if (prompts.length === 1) options.event('agent-tool', { id: 't1', tool: 'Bash', input: { command: 'git commit -m "fix"' } });
    options.event('agent-text', { text: 'done' });
  }, async interrupt() {} }) });
  try {
    const agent = desk.specialists.create({ name: 'Desky', purpose: 'Looks after the shop.' }), at = new Date().toISOString();
    store.put('run', 'chat', { id: 'chat', role: 'specialist', specialistId: agent.id, provider: 'claude', state: 'finished', createdAt: at, updatedAt: at });
    await desk.say('chat', 'fix the checkout');
    await waitFor(() => prompts.length === 1 && store.get('run', 'chat').state === 'finished', 'the working turn');
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(prompts.length, 1, 'no hidden memory-check turn after the reply');
    await desk.say('chat', 'thanks');
    await waitFor(() => prompts.length === 2, 'the next real turn');
    assert.match(prompts[1], /\(Memory: if your last work/);
    assert.doesNotMatch(prompts[1], /Quiet memory check/);
  } finally { await desk.shutdown(); store.close(); }
});

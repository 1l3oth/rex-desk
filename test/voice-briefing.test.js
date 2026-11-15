import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { voiceBriefing } from '../src/voice-briefing.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const waitFor = async (check, what) => { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out waiting for ${what}`); };

test('the Voice mode report is made by code from what the person has been doing, fast', () => {
  const store = new Store(temporary('brief')), memory = temporary('brief-memory');
  try {
    writeFileSync(path.join(memory, 'user.md'), '# About the person\n\nDara builds Rex Desk and likes short answers.');
    store.put('specialist', 'a1', { id: 'a1', name: 'ReelHome', projectSlug: 'template-tiktok', purpose: 'A Remotion template for TikTok captions', createdAt: new Date().toISOString() });
    store.put('run', 'r1', { id: 'r1', specialistId: 'a1', state: 'finished', updatedAt: new Date().toISOString() });
    store.event('r1', 'human-message', { text: 'Render the stills again' }, true);
    store.event('r1', 'agent-text', { text: 'Done: all 12 stills rendered without errors.' }, true);
    store.put('interaction', 'q1', { id: 'q1', runId: 'r1', state: 'pending', title: 'May I push to master?' });
    store.put('run', 'old', { id: 'old', specialistId: 'a1', state: 'finished', updatedAt: '2020-01-01T00:00:00.000Z' });
    const started = performance.now(), report = voiceBriefing({ store, memoryDirectory: memory });
    assert.ok(performance.now() - started < 500, 'milliseconds, not an AI call');
    assert.match(report, /Dara builds Rex Desk/);
    assert.match(report, /ReelHome \(template-tiktok\)/);
    assert.match(report, /You asked: Render the stills again/);
    assert.match(report, /It said: Done: all 12 stills rendered/);
    assert.match(report, /ReelHome asks: May I push to master\?/);
    assert.equal(report.match(/^- ReelHome, /gm)?.length, 1, 'only chats from the last few days');
  } finally { store.close(); }
});

test('turning Voice mode on gives the agent the report at once and asks only for a greeting; later spoken messages stay short', async () => {
  const store = new Store(temporary('voice')), prompts = [];
  const desk = new Desk(store, { root: temporary('voice-root'), runnerFactory: options => ({ async start(prompt) { prompts.push(prompt); options.event('session', { sessionId: '7c3a8d71-d78d-409a-9a84-91fb162c1be3' }); options.event('agent-text', { text: 'Hey, welcome back!' }); }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('hello');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the first turn');
    const result = desk.voiceMode(run.id, true);
    assert.equal(result.greeting, true);
    await waitFor(() => prompts.length === 2, 'the greeting turn');
    assert.match(prompts[1], /# Briefing for Voice mode/); assert.match(prompts[1], /Just greet the person/); assert.match(prompts[1], /Do not summarise it/);
    assert.ok(!store.events(run.id, { visible: true }).some(event => event.kind === 'human-message' && /Briefing/.test(event.text)), 'the report is not shown in the chat');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the greeting');
    await desk.say(run.id, 'what is ReelHome doing', { voice: true });
    await waitFor(() => prompts.length === 3, 'the spoken question');
    assert.match(prompts[2], /\(Voice mode: you are heard[\s\S]*what is ReelHome doing/);
    assert.doesNotMatch(prompts[2], /# Briefing/, 'the report is not sent again');
    assert.equal(store.events(run.id, { visible: true }).filter(event => event.kind === 'human-message').at(-1).text, 'what is ReelHome doing', 'the chat shows only what was said');
    desk.voiceMode(run.id, false);
    assert.equal(store.get('run', run.id).voice, undefined);
  } finally { await desk.shutdown(); store.close(); }
});

test('in Voice mode, what the agent sends with desk_message or asks with a question card is said out loud too', async () => {
  const store = new Store(temporary('voice-said'));
  const desk = new Desk(store, { root: temporary('voice-said-root'), runnerFactory: options => ({ async start() { options.event('session', { sessionId: '7c3a8d71-d78d-409a-9a84-91fb162c1be3' }); }, async interrupt() {} }) });
  try {
    const run = await desk.startWebTask('hello');
    await waitFor(() => store.get('run', run.id).state === 'finished', 'the first turn');
    const heard = []; store.on('partial', data => heard.push(data));
    desk.message(run.id, 'Not in voice mode yet.');
    assert.equal(heard.length, 0);
    store.put('run', run.id, { ...store.get('run', run.id), voice: { at: '', briefing: '', sent: true } });
    desk.message(run.id, 'No projects are set up yet.');
    void desk.ask(run.id, { kind: 'question', title: 'Where do you keep your notes?' }).catch(() => {});
    assert.deepEqual(heard.map(item => item.text), ['No projects are set up yet.', 'Where do you keep your notes?']);
    assert.ok(heard.every(item => item.done && item.runId === run.id));
  } finally { await desk.shutdown(); store.close(); }
});

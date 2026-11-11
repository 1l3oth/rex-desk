import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/store.js';
import { Notifier } from '../src/notify.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup(options = {}) {
  const store = new Store(temporary('notify')), shown = [];
  const notifier = new Notifier(store, { show: (title, body) => shown.push([title, body]), minGapMs: 0, ...options }).start();
  store.put('run', 'r1', { id: 'r1', title: 'Main agent', main: true, state: 'running', createdAt: now() });
  return { store, shown, notifier };
}

test('a new question tells the person when the window is not in front, and only once', () => {
  const { store, shown } = setup();
  const ask = { id: 'q1', runId: 'r1', kind: 'question', title: 'Which clone should the agent use?', state: 'pending', createdAt: now() };
  store.put('interaction', 'q1', ask); store.put('interaction', 'q1', ask);
  assert.equal(shown.length, 1);
  assert.match(shown[0][0], /Needs your answer · Rex Agent/); assert.match(shown[0][1], /Which clone/);
  store.put('interaction', 'q2', { ...ask, id: 'q2', kind: 'approval', title: 'Approve Bash' });
  assert.match(shown[1][0], /Needs your OK/);
});

test('nothing is shown while Rex Desk is the focused window, or when notifications are off', () => {
  const focused = setup({ focused: () => true });
  focused.store.put('interaction', 'q1', { id: 'q1', runId: 'r1', kind: 'question', title: 'x', state: 'pending', createdAt: now() });
  assert.equal(focused.shown.length, 0);
  const off = setup({ enabled: () => false });
  off.store.put('interaction', 'q1', { id: 'q1', runId: 'r1', kind: 'question', title: 'x', state: 'pending', createdAt: now() });
  assert.equal(off.shown.length, 0);
});

test('an agent that finishes its turn shows its last words; a failure shows the error', () => {
  const { store, shown } = setup();
  store.event('r1', 'agent-text', { text: 'Created Dara for authentication.' }, true);
  store.put('run', 'r1', { ...store.get('run', 'r1'), state: 'finished' });
  assert.deepEqual(shown.at(-1), ['Rex Agent replied', 'Created Dara for authentication.']);
  store.put('run', 'r1', { ...store.get('run', 'r1'), state: 'running' });
  store.put('run', 'r1', { ...store.get('run', 'r1'), state: 'failed', error: 'Not signed in' });
  assert.deepEqual(shown.at(-1), ['Rex Agent stopped', 'Not signed in']);
});

test('toasts closer together than the gap are dropped', () => {
  const { store, shown } = setup({ minGapMs: 60000 });
  store.put('interaction', 'a', { id: 'a', runId: 'r1', kind: 'question', title: 'one', state: 'pending', createdAt: now() });
  store.put('interaction', 'b', { id: 'b', runId: 'r1', kind: 'question', title: 'two', state: 'pending', createdAt: now() });
  assert.equal(shown.length, 1);
});

test('every notification is kept with an unread count per chat; a chat on screen is read at once, and a muted one stays quiet', () => {
  let view = '', focused = false;
  const { store, shown, notifier } = setup({ focused: () => focused, viewing: () => view });
  store.put('room', 'room1', { id: 'room1', name: 'QA-Morningmate', members: [] });
  store.put('roommsg', 'm1', { id: 'm1', roomId: 'room1', from: { type: 'agent', id: 'a1', label: 'Sokha' }, text: 'The build passed.', at: now() });
  store.put('roommsg', 'm2', { id: 'm2', roomId: 'room1', from: { type: 'agent', id: 'a1', label: 'Sokha' }, text: 'Opening the preview.', at: now() });
  store.put('roommsg', 'm3', { id: 'm3', roomId: 'room1', from: { type: 'human', id: 'you', label: 'You' }, text: 'ok', at: now() });
  assert.equal(notifier.summary().byKey['room:room1'], 2, 'two agent messages unread, yours do not count');
  assert.equal(shown.filter(([title]) => /Sokha in QA-Morningmate/.test(title)).length, 1, 'a busy room toasts once a minute');
  notifier.read({ key: 'room:room1' }); assert.equal(notifier.summary().unread, 0);
  focused = true; view = 'room:room1';
  store.put('roommsg', 'm4', { id: 'm4', roomId: 'room1', from: { type: 'agent', id: 'a1', label: 'Sokha' }, text: 'Done.', at: now() });
  assert.equal(notifier.summary().unread, 0, 'you are looking at it');
  focused = false; view = ''; notifier.mute('room:room1', true); notifier.roomToast.clear(); const before = shown.length;
  store.put('roommsg', 'm5', { id: 'm5', roomId: 'room1', from: { type: 'agent', id: 'a1', label: 'Sokha' }, text: 'Again.', at: now() });
  assert.equal(shown.length, before, 'muted: no toast'); assert.equal(notifier.summary().unread, 0, 'muted: kept as read');
  assert.ok(notifier.summary().recent.some(item => item.body === 'Again.'), 'still in the list');
});

test('a phone push goes to the private ntfy topic with the title and priority, only when it is on', async () => {
  const { store, notifier } = setup(); const sent = [];
  notifier.fetch = async (url, options) => { sent.push({ url, options }); return { ok: true, status: 200 }; };
  const topic = notifier.prefs().push.topic;
  assert.match(topic, /^rexdesk-[0-9a-f]{24}$/);
  store.put('interaction', 'q9', { id: 'q9', runId: 'r1', kind: 'question', title: 'Which branch?', state: 'pending', createdAt: now() });
  assert.equal(sent.length, 0, 'off by default');
  notifier.setPrefs({ push: { on: true } });
  store.put('interaction', 'q10', { id: 'q10', runId: 'r1', kind: 'question', title: '어느 브랜치?', state: 'pending', createdAt: now() });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1); assert.equal(sent[0].url, `https://ntfy.sh/${topic}`);
  assert.equal(sent[0].options.headers.Priority, '4'); const title = sent[0].options.headers.Title.replace(/^=\?UTF-8\?B\?(.*)\?=$/, (_, b64) => Buffer.from(b64, 'base64').toString('utf8')); assert.match(title, /^Needs your answer · Rex Agent/);
  assert.equal(sent[0].options.body, '어느 브랜치?');
  notifier.setPrefs({ push: { newTopic: true } }); assert.notEqual(notifier.prefs().push.topic, topic);
});

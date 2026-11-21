import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSteps, setupHtml, showSetup } from '../public/chat-setup.js';

const store = new Map();
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
const esc = value => String(value);
const done = steps => Object.fromEntries(steps.map(step => [step.id, step.done]));

test('a brand new person starts with nothing ticked, and each step ticks from what Rex Desk already knows', () => {
  const fresh = setupSteps({ runs: [], specialists: [{ kind: 'main' }], rooms: [] }, {});
  assert.deepEqual(done(fresh), { account: false, ai: false, hello: false, work: false, agent: false, task: false, extras: false });
  const snap = {
    computer: 'pc1', account: { email: 'me@example.com' }, runs: [{ role: 'coordinator', main: true, computer: 'pc1' }], config: { repositories: [] },
    specialists: [{ kind: 'main' }, { kind: 'specialist', name: 'Writer', project: '' }], teamTasks: [{ state: 'done' }],
    rooms: [{ id: 'r' }], devices: { remote: true }, cloudSync: { on: true }, update: { supported: true, available: false },
  };
  const all = setupSteps(snap, { accounts: { claude: { profiles: [{ loggedIn: true }] } } });
  assert.ok(all.every(step => step.done), 'a named workspace agent counts as added work');
  assert.ok(all.filter(step => !step.done).length === 0);
  const elsewhere = setupSteps({ computer: 'pc2', runs: [{ role: 'coordinator', main: true, computer: 'pc1' }] }, {});
  assert.equal(elsewhere.find(step => step.id === 'hello').done, false, 'a Rex Agent chat on another computer does not count here');
});

test('the list hides when everything is done or when closed, and /setup opens it again', () => {
  const ui = { snap: { runs: [], specialists: [], rooms: [] } };
  assert.match(setupHtml({ ui, esc }), /Set up Rex Desk/);
  assert.match(setupHtml({ ui, esc }), /0 of 7 done/);
  store.set('rexdesk.setup.hidden', '1');
  assert.equal(setupHtml({ ui, esc }), '', 'closed: it stays hidden');
  showSetup({ ui });
  assert.match(setupHtml({ ui, esc }), /Do it for me/, 'opened again with its steps');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRunner, CODEX_RULE, CODEX_NUDGE, isPromise } from '../src/codex.js';

// A fake app-server: each turn/start plays the next scripted turn (its agent messages and whether it used a tool).
function fakeCodex(turns) {
  const calls = [];
  const clientFactory = options => ({
    open: async () => {}, close() {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 't1' } };
      if (method === 'turn/start') {
        const index = calls.filter(call => call.method === 'turn/start').length, turn = turns[index - 1] || { say: 'Done.' }, id = `u${index}`;
        setTimeout(() => {
          options.onNotification('turn/started', { threadId: 't1', turn: { id } });
          if (turn.tool) {
            options.onNotification('item/started', { threadId: 't1', item: { id: `c${index}`, type: 'commandExecution', command: 'echo hi' } });
            options.onNotification('item/completed', { threadId: 't1', item: { id: `c${index}`, type: 'commandExecution', aggregatedOutput: 'hi', exitCode: 0 } });
          }
          options.onNotification('item/completed', { threadId: 't1', item: { type: 'agentMessage', text: turn.say } });
          options.onNotification('turn/completed', { threadId: 't1', turn: { id, status: 'completed' } });
        }, 5);
        return { turn: { id } };
      }
      return {};
    },
  });
  return { calls, clientFactory, turnInputs: () => calls.filter(call => call.method === 'turn/start').map(call => call.params.input[0].text) };
}
const runner = (fake, run = {}) => new CodexRunner({ run: { permissionMode: 'bypassPermissions', ...run }, cwd: process.cwd(), clientFactory: fake.clientFactory, event: () => {} });

test('a Codex turn that ends on a promise with no tool gets one nudge', async () => {
  const fake = fakeCodex([{ say: "I'm working on it now." }, { say: 'Done: the script is in script.md.', tool: true }]);
  const done = runner(fake);
  assert.deepEqual(await done.start('Make the video script'), { status: 'completed' });
  assert.equal(fake.turnInputs().length, 2);
  assert.equal(fake.turnInputs()[1], CODEX_NUDGE);
  assert.match(done.text, /Done: the script/);
});

test('the nudge happens at most once per message, so it cannot loop', async () => {
  const fake = fakeCodex([{ say: "I'll do it now." }, { say: "I'll continue in a moment." }, { say: 'never reached' }]);
  await runner(fake).start('Fix it');
  assert.equal(fake.turnInputs().length, 2);
});

test('a real answer and a question get no nudge', async () => {
  for (const turn of [{ say: 'The bug was a missing await; fixed in cart.js.', tool: true }, { say: 'Should I continue with the mobile layout too?' }, { say: 'The build is green.' }]) {
    const fake = fakeCodex([turn]);
    await runner(fake).start('Go');
    assert.equal(fake.turnInputs().length, 1, turn.say);
  }
});

test('a promise said while tools ran in the same turn gets no nudge', async () => {
  const fake = fakeCodex([{ say: "I'll continue with the tests next.", tool: true }]);
  await runner(fake).start('Go');
  assert.equal(fake.turnInputs().length, 1);
});

test('the rule goes to Codex as developer instructions and at the top of a new thread', async () => {
  const fresh = fakeCodex([{ say: 'Done.' }]);
  await runner(fresh).start('Hello');
  assert.equal(fresh.calls.find(call => call.method === 'thread/start').params.developerInstructions, CODEX_RULE);
  assert.ok(fresh.turnInputs()[0].startsWith(CODEX_RULE));
  const resumed = fakeCodex([{ say: 'Done.' }]);
  await runner(resumed, { sessionId: 't1' }).start('Hello again');
  assert.equal(resumed.calls.find(call => call.method === 'thread/resume').params.developerInstructions, CODEX_RULE);
  assert.equal(resumed.turnInputs()[0], 'Hello again');
});

test('promise detection: first-person promises about later work', () => {
  for (const text of ["I'll continue.", "I'm working on it now.", "I'll send it as soon as it's ready.", 'Working on it now.', 'Sure. I will fix the test next.', 'Found the cause in cart.js.\nNext, I’ll patch it.'])
    assert.ok(isPromise(text), text);
});

test('promise detection: words inside instructions, UI labels and real answers are not promises', () => {
  for (const text of ['Click Continue to finish setup.', 'Press "I\'ll do it later" to skip the tour.', 'The bug was a missing await. It is fixed in cart.js and the tests pass.', 'The page shows Working on it while it loads.', "I'll explain: the build failed because Node 22 was used. Switching to Node 24 fixed it.", 'Here is the summary of the change.', ''])
    assert.ok(!isPromise(text), text);
});

test('promise detection: questions and requests for the person\'s choice are never nudged', () => {
  for (const text of ['Shall I continue?', 'Tell me which file you mean', 'Let me know which option you want', "I'll wait. Please confirm the branch", "I'll continue once you choose. Which one should I use"])
    assert.ok(!isPromise(text), text);
});

test('a clarification without a question mark gets no nudge', async () => {
  const fake = fakeCodex([{ say: 'Let me know which option you want' }]);
  await runner(fake).start('Set it up');
  assert.equal(fake.turnInputs().length, 1);
});

test('a UI instruction with Continue in it gets no nudge', async () => {
  const fake = fakeCodex([{ say: 'Click Continue to finish setup.' }]);
  await runner(fake).start('How do I finish?');
  assert.equal(fake.turnInputs().length, 1);
});

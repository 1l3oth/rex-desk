import test from 'node:test';
import assert from 'node:assert/strict';
import { BackoffPoll } from '../src/poll-backoff.js';

// A fake clock: timers run only when the test moves time on.
const clock = () => {
  let at = 0, next = null;
  return { now: () => at, timers: { setTimeout: (fn, ms) => (next = { fn, due: at + ms }), clearTimeout: item => { if (next === item) next = null; } },
    async step() { const item = next; next = null; at = item.due; await item.fn(); await new Promise(resolve => setImmediate(resolve)); return item; }, get wait() { return next ? next.due - at : null; } };
};

test('a quiet poll slows down to the maximum and a busy tick or a wake brings it back to the quick pace', async () => {
  const c = clock(); let busy = false, calls = 0;
  const poll = new BackoffPoll(() => { calls++; return busy; }, { minMs: 5000, maxMs: 60000, now: c.now, timers: c.timers });
  poll.start();
  const waits = [];
  for (let i = 0; i < 6; i++) { waits.push(c.wait); await c.step(); }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000]);
  busy = true; await c.step(); assert.equal(c.wait, 5000, 'activity brings the quick pace back');
  busy = false; await c.step(); assert.equal(c.wait, 10000);
  poll.wake(); assert.equal(c.wait, 5000, 'a wake polls soon');
  poll.stop(); assert.equal(c.wait, null); assert.equal(calls, 8);
});

test('a failing tick counts as quiet and does not stop the poll', async () => {
  const c = clock();
  const poll = new BackoffPoll(() => { throw new Error('offline'); }, { minMs: 1000, maxMs: 4000, now: c.now, timers: c.timers });
  poll.start(); await c.step(); await c.step(); await c.step();
  assert.equal(c.wait, 4000); poll.stop();
});

test('a wake while a poll is on its way never starts a second loop: one timer at a time, next poll at the quick pace', async () => {
  let at = 0; const live = new Set();
  const timers = { setTimeout: (fn, ms) => { const item = { fn, due: at + ms }; live.add(item); return item; }, clearTimeout: item => live.delete(item) };
  let release, calls = 0;
  const poll = new BackoffPoll(() => { calls++; return new Promise(resolve => { release = resolve; }); }, { minMs: 5000, maxMs: 60000, now: () => at, timers });
  poll.start(); poll.waitMs = 40000;
  const [first] = live; live.delete(first); at = first.due; const running = first.fn();
  poll.wake(); poll.wake();
  assert.equal(live.size, 0, 'no timer while the poll is in flight');
  release(false); await running;
  assert.equal(live.size, 1, 'the finished poll set exactly one next timer');
  assert.equal([...live][0].due - at, 5000, 'and it is at the quick pace because of the wake');
  poll.stop(); poll.start(); poll.wake(); assert.equal(live.size, 1, 'start and wake replace the pending timer'); poll.stop();
  assert.equal(live.size, 0); assert.equal(calls, 1);
});

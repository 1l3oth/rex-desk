import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Runs public/boot-watch.js against a tiny fake page and fails the page scripts the way a slow relay would.
function run() {
  const handlers = {}, timers = [], added = [];
  const noop = () => {};
  const sandbox = {
    localStorage: { getItem: () => null }, navigator: { language: 'en' }, location: { origin: 'http://rex.test', href: 'http://rex.test/' },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: async () => ({ ok: true, json: async () => ({}) }),
    document: { querySelector: () => null, createElement: () => ({}), head: { append: el => added.push(el) }, body: { append: noop } },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, setInterval: () => 0, clearInterval: noop, URL,
  };
  vm.runInNewContext(readFileSync(new URL('../public/boot-watch.js', import.meta.url), 'utf8'), sandbox);
  return { fail: el => handlers.error({ target: el, message: '' }), timers, added };
}

test('a page script that fails to load is asked for again twice, then reported', () => {
  const { fail, timers, added } = run();
  const retries = () => timers.filter(t => t.ms === 1000 || t.ms === 3000);
  const before = timers.length;
  fail({ tagName: 'SCRIPT', src: 'http://rex.test/chat.js', type: 'module' });
  assert.equal(timers.length, before + 1);
  assert.equal(timers.at(-1).ms, 1000);
  timers.at(-1).fn();
  assert.equal(added[0].src, 'http://rex.test/chat.js?rex-retry=1');
  assert.equal(added[0].type, 'module');
  fail({ tagName: 'SCRIPT', src: added[0].src, type: 'module' });
  assert.equal(timers.at(-1).ms, 3000);
  timers.at(-1).fn();
  assert.equal(added[1].src, 'http://rex.test/chat.js?rex-retry=2');
  const count = timers.length;
  fail({ tagName: 'SCRIPT', src: added[1].src, type: 'module' });
  assert.equal(timers.length, count, 'no third retry');
  assert.ok(retries().length >= 2);
});

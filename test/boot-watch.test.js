import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Runs public/boot-watch.js against a tiny fake page and fails the page scripts the way a slow relay would.
function run(boot = null) {
  const handlers = {}, timers = [], added = [];
  const noop = () => {};
  const sandbox = {
    localStorage: { getItem: () => null }, navigator: { language: 'en' }, location: { origin: 'http://rex.test', href: 'http://rex.test/' },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop }, fetch: async () => ({ ok: true, json: async () => ({}) }),
    document: { querySelector: selector => (selector === '#app > .boot' ? boot : null), createElement: () => ({}), head: { append: el => added.push(el) }, body: { append: noop } },
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

test('the could not open screen waits while a script retry is still pending', () => {
  const part = () => ({ textContent: '', onclick: null });
  const boot = { innerHTML: '', dataset: {}, shown: 0, querySelector: selector => (selector === 'h2' ? (boot.shown ? {} : null) : part()) };
  Object.defineProperty(boot, 'innerHTML', { set(html) { if (html.includes('could not open')) boot.shown++; }, get() { return ''; } });
  const { fail, timers, added } = run(boot);
  const showFailed = timers.find(t => t.ms === 8000);
  fail({ tagName: 'SCRIPT', src: 'http://rex.test/chat.js', type: 'module' });
  // The slow relay: the 8 s mark comes before the retry has even been sent.
  showFailed.fn();
  assert.equal(boot.shown, 0, 'not shown while the retry is planned');
  assert.equal(timers.at(-1).ms, 500, 'it looks again shortly');
  timers.find(t => t.ms === 1000).fn();
  timers.at(-2).fn();
  assert.equal(boot.shown, 0, 'not shown while the retried script is loading');
  added[0].onload();
  timers.at(-1).fn();
  assert.equal(boot.shown, 1, 'shown once the retry has finished and the page still did not start');
});

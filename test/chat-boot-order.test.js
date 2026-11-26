import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// chat.js opens the app with a top-level await. Any top-level const, let or class written below that line is still
// uninitialised while openApp() runs, so reading it there fails ("Cannot access 'PF_CHEV' before initialization").
test('chat.js opens the app only after every top-level value is declared', () => {
  const lines = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8').split(/\r?\n/);
  const open = lines.findIndex(line => /^try \{ await openApp\(\); \}/.test(line));
  assert.ok(open >= 0, 'the top-level openApp() call is found');
  const later = lines.slice(open + 1).map((line, index) => ({ line: open + 2 + index, text: line }))
    .filter(({ text }) => /^(const|let|class)\s/.test(text));
  assert.deepEqual(later.map(({ line, text }) => `${line}: ${text.slice(0, 40)}`), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// The browser's confirm() returns false at once in the macOS app (Tauri's WKWebView), so a delete that asked first never
// happened there (d079a364). Every page asks through the app's own box in public/confirm.js instead.
test('no page script uses the browser confirm(); all ask through askConfirm', () => {
  const left = readdirSync('public').filter(name => name.endsWith('.js') && !['jev.js', 'confirm.js'].includes(name))
    .flatMap(name => readFileSync(`public/${name}`, 'utf8').split('\n').map((line, index) => /(?<![\w.$])confirm\(/.test(line) ? `${name}:${index + 1}` : '').filter(Boolean));
  assert.deepEqual(left, []);
  for (const name of readdirSync('public').filter(item => item.endsWith('.js'))) {
    const text = readFileSync(`public/${name}`, 'utf8');
    if (text.includes('askConfirm(') && name !== 'confirm.js') assert.match(text, /import \{ askConfirm \} from '\.\/confirm\.js';/, name);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { attachedFiles } from '../public/chat-media.js';

const esc = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

test('pictures in a message are square thumbnails above the text that open the full picture; other files stay cards below', () => {
  const folder = 'D:\\Rex Desk\\uploads\\b41c7ae2-6843-4659-a836-282113e63089';
  const text = `Look at these\n\nAttached files (read them from these paths):\n- ${folder}\\one.png\n- ${folder}\\two.jpg\n- ${folder}\\notes.pdf`;
  const shown = attachedFiles(text, esc);
  assert.equal(shown.text.trim(), 'Look at these');
  assert.equal((shown.top.match(/class="att-thumb"/g) || []).length, 2);
  assert.match(shown.top, /^<div class="att-thumbs">/);
  assert.match(shown.top, /data-file-open="D:\\Rex Desk\\uploads\\[^"]+\\one\.png"/, 'a click opens the full picture');
  assert.doesNotMatch(shown.html, /<img/);
  assert.match(shown.html, /att-card[\s\S]*notes\.pdf/);
  assert.deepEqual(attachedFiles('Just words', esc), { text: 'Just words', top: '', html: '' });
});

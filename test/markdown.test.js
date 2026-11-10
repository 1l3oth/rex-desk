import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../public/chat-markdown.js';

test('tables, headings, lists, quotes and rules render as real elements', () => {
  const html = markdown('## Plan\n\n| Project | Agent |\n|---|:---:|\n| flow-was | Sokha |\n| polyglot | Mealea |\n\n- one\n  - nested\n- two\n\n1. first\n2. second\n\n> note\n\n---');
  assert.match(html, /<h4 class="md-h">Plan<\/h4>/);
  assert.match(html, /<table><thead><tr><th>Project<\/th><th class="a-center">Agent<\/th><\/tr><\/thead><tbody><tr><td>flow-was<\/td><td class="a-center">Sokha<\/td><\/tr>/);
  assert.match(html, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>note<\/p><\/blockquote>/); assert.match(html, /<hr>/);
});

test('inline styles, links and the bullet character work; code is left alone', () => {
  const html = markdown('**bold** and *italic* and ~~gone~~ and `a *b* c` see [docs](https://example.com/x) or https://example.com/y.\n• dot bullet');
  assert.match(html, /<strong>bold<\/strong>/); assert.match(html, /<em>italic<\/em>/); assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<code>a \*b\* c<\/code>/, 'markdown inside code is not applied');
  assert.match(html, /<a href="https:\/\/example.com\/x" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/y"[^>]*>https:\/\/example.com\/y<\/a>\./);
  assert.match(html, /<ul><li>dot bullet<\/li><\/ul>/);
});

test('HTML in a message never becomes markup, and only web links are linked', () => {
  const html = markdown('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) ```\n<b>code</b>\n```');
  assert.ok(!html.includes('<script') && !html.includes('<img'), 'tags are escaped');
  assert.ok(!/href="javascript/i.test(html), 'javascript links are not made');
  assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
});

test('code fences keep their lines, and @mentions are highlighted outside code', () => {
  const html = markdown('```js\nconst a = 1;\nconst b = 2;\n```\nask @Dara about `@Dara`', { mentions: ['Dara'] });
  assert.match(html, /<pre class="md-code"><code>const a = 1;\nconst b = 2;<\/code><\/pre>/);
  assert.match(html, /<span class="mention">@Dara<\/span>/);
  assert.match(html, /<code>@Dara<\/code>/);
});

test('single line breaks stay as line breaks inside a paragraph', () => {
  assert.equal(markdown('one\ntwo'), '<p>one<br>two</p>');
});

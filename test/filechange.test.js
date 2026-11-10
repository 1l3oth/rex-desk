import test from 'node:test';
import assert from 'node:assert/strict';
import { fileChange } from '../src/runners.js';

test('a file edit is recorded as its changed lines, without secrets', () => {
  const edit = fileChange('Edit', { file_path: 'D:/app/cart.js', old_string: 'a\nconst total = price;\nb', new_string: 'a\nconst total = price * qty;\nb' });
  assert.deepEqual({ added: edit.added, removed: edit.removed, diff: edit.diff }, { added: 1, removed: 1, diff: ['-const total = price;', '+const total = price * qty;'] });
  const created = fileChange('Write', { file_path: 'D:/app/notes.md', content: 'one\ntwo' });
  assert.equal(created.created, true); assert.equal(created.added, 2);
  const env = fileChange('Write', { file_path: 'D:/app/.env', content: 'KEY=secret' });
  assert.equal(env.hidden, true); assert.deepEqual(env.diff, []);
  assert.deepEqual(fileChange('Edit', { file_path: 'D:/app/config.js', old_string: 'x', new_string: 'api_key = sk-123' }).diff, ['-x', '+api_key: [redacted]']);
  assert.equal(fileChange('Read', { file_path: 'D:/app/cart.js' }), null);
  const many = fileChange('MultiEdit', { file_path: 'D:/app/a.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
  assert.deepEqual(many.diff, ['-a', '+b', '…', '-c', '+d']);
});

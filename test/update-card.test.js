import test from 'node:test';
import assert from 'node:assert/strict';
import { noteItems } from '../public/chat-update.js';

test('release notes become one list item per change, from a paragraph or from lines', () => {
  assert.deepEqual(noteItems('Faster start. The app shows why it stopped! Version 2 of sync.'), ['Faster start', 'The app shows why it stopped!', 'Version 2 of sync']);
  assert.deepEqual(noteItems('- Move folders\n- Keep files safe.\n\n* Reopens after an update'), ['Move folders', 'Keep files safe', 'Reopens after an update']);
  assert.deepEqual(noteItems('Settings > Folders: e.g. a path. Done'), ['Settings > Folders: e.g. a path', 'Done']);
  assert.deepEqual(noteItems(''), []);
});

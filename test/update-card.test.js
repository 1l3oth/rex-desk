import test from 'node:test';
import assert from 'node:assert/strict';
import { noteItems, whyUnreachable } from '../public/chat-update.js';

test('release notes become one list item per change, from a paragraph or from lines', () => {
  assert.deepEqual(noteItems('Faster start. The app shows why it stopped! Version 2 of sync.'), ['Faster start', 'The app shows why it stopped!', 'Version 2 of sync']);
  assert.deepEqual(noteItems('- Move folders\n- Keep files safe.\n\n* Reopens after an update'), ['Move folders', 'Keep files safe', 'Reopens after an update']);
  assert.deepEqual(noteItems('Settings > Folders: e.g. a path. Done'), ['Settings > Folders: e.g. a path', 'Done']);
  assert.deepEqual(noteItems(''), []);
});

test('an update press that cannot reach the server shows the reason the server gives once it answers', async () => {
  const lost = new Error('Cannot reach your computer. Trying again.');
  let calls = 0;
  const answers = async () => { calls++; if (calls < 2) throw lost; return { update: { problem: 'The C: drive is almost full (40 MB free).' } }; };
  assert.equal(await whyUnreachable(answers, lost, { pause: 1 }), 'The C: drive is almost full (40 MB free).');
  assert.match(await whyUnreachable(async () => { throw lost; }, lost, { tries: 2, pause: 1 }), /^Rex Desk is not answering\. The drive may be full/);
  assert.equal(await whyUnreachable(answers, new Error('Rex Agent is still working.')), 'Rex Agent is still working.', 'other errors stay as they are');
});

test('the update card has a state for an install antivirus blocked, with a button to the installer folder', async () => {
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(new URL('../public/chat-update.js', import.meta.url), 'utf8'), chat = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
  assert.match(code, /did not install/); assert.match(code, /data-action="update-reveal"/); assert.match(code, /api\('\/update\/reveal'/);
  assert.match(chat, /'update-reveal'\) await revealInstaller\(api\)/);
});

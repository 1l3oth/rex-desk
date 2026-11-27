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

test('the folder path after Explorer could not open stays on the card until it is dismissed or Install manually works', async () => {
  const { revealInstaller, revealNote, updateLater } = await import('../public/chat-update.js');
  const error = { textContent: '', hidden: true }, hint = { textContent: '' };
  const card = { dataset: { version: '0.3.0', failed: 'true' }, removed: false, remove() { this.removed = true; } };
  const saved = globalThis.document;
  globalThis.document = { querySelector: q => q.endsWith('.uc-error') ? error : q.endsWith('.uc-hint') ? hint : null, getElementById: () => (card.removed ? null : card) };
  try {
    await revealInstaller(async () => ({ opened: false, folder: String.raw`D:\O'Brien\Rex Desk\updates` }));
    assert.equal(error.textContent, String.raw`Rex Desk could not open the folder. Open it yourself: D:\O'Brien\Rex Desk\updates`);
    assert.equal(revealNote('0.3.0'), error.textContent, 'kept for this version, so a card refresh shows it again');
    assert.equal(revealNote('0.4.0'), '', 'not for another version');
    await revealInstaller(async () => ({ opened: true }));
    assert.equal(revealNote('0.3.0'), '', 'a retry that opened the folder clears it');
    await revealInstaller(async () => ({ opened: false, folder: 'D:/x' }));
    updateLater();
    assert.equal(revealNote('0.3.0'), '', 'dismissing the card clears it');
  } finally { globalThis.document = saved; }
});

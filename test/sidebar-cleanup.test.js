import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

test('a sidebar redraw keeps an open profile menu, its focus, and draws what changed once it closes (L122)', () => {
  const chat = read('chat.js');
  assert.match(chat, /const menu = document\.getElementById\('pf-menu'\), keepFoot = menu && !menu\.hidden \? rail\.querySelector\('\.rail-foot'\) : null/);
  assert.match(chat, /if \(keepFoot\) \{ rail\.querySelector\('\.rail-foot'\)\?\.replaceWith\(keepFoot\); ui\.railHtml = ''; focused\?\.focus\(\); \}/);
  assert.match(chat, /if \(open && !ui\.railHtml\) setTimeout\(\(\) => renderAll\(\), 300\);/, 'the list catches up after the closing click');
});

test('the agent filter has Working, Needs you and Stopped, one at a time, and hides empty teams (L122)', () => {
  const sidebar = read('chat-sidebar.js'), chat = read('chat.js');
  for (const [state, label] of [['working', 'Working'], ['waiting', 'Needs you'], ['stopped', 'Stopped']]) assert.ok(sidebar.includes(`chip('${state}', t('${label}'))`), label);
  assert.match(sidebar, /ctx\.ui\.agentState = ctx\.ui\.agentState === state \? '' : state;/, 'pressing the chip that is on shows everyone again');
  assert.match(sidebar, /Boolean\(state && row\.dataset\.state !== state\)/);
  assert.match(sidebar, /head\.hidden = !\[\.\.\.list\.children\]\.some\(row => !row\.hidden\)/);
  assert.match(chat, /const agentState = agent => agentStopped\(agent\) \? 'stopped' : \['busy', 'replying'\]\.includes\(agent\?\.status\?\.state\) \? 'working' : agent\?\.status\?\.state === 'waiting' \? 'waiting' : '';/);
  assert.match(chat, /applyFilter\(rail, ui\.agentFilter, ui\.agentState\)/);
  assert.match(chat, /\(!ui\.agentState \|\| row\.dataset\.state === ui\.agentState\)/, 'the phone list filters the same way');
});

test('one add per section, Notifications apart from Needs you, and the computer is named in a dialog (L122)', () => {
  const chat = read('chat.js'), devices = read('chat-devices.js');
  assert.doesNotMatch(chat, /class="rail-cta"/, 'no second add button under a section');
  assert.doesNotMatch(chat, /place\('notices'/, 'Notifications is no longer a row beside Needs you');
  assert.match(chat, /\$\{railBell\(snap\.notices\?\.unread \|\| 0\)\}/);
  assert.match(chat, /place\('inbox', 'inbox', t\('Needs you'\), asks \+ tgUnread, true, t\('Replies and approvals waiting for you'\), t\('Replies and approvals'\)\)/);
  assert.doesNotMatch(chat, /newComputerCard|data-newpc/, 'no inline New computer card');
  assert.match(devices, /export function nameComputer\(ctx\)/);
  assert.match(devices, /ctx\.ui\.snap\?\.devices\?\.self\?\.named !== false/);
});

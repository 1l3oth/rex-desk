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

test('an active agent filter shows and can be cleared at every list size, desktop and phone (L122)', async () => {
  const { agentListHtml } = await import('../public/chat-sidebar.js');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
  const agents = Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, name: `Agent ${index}`, projectSlug: 'demo', status: { state: 'idle' } }));
  const html = ui => agentListHtml({ ui: { snap: {}, ...ui }, esc, isCollapsed: () => false }, agents, agent => `<span>${agent.name}</span>`, () => '');
  assert.doesNotMatch(html({}), /rail-states/, 'six agents and no filter: no filter controls');
  for (const ui of [{ agentState: 'stopped' }, { agentFilter: 'zzz' }]) {
    const out = html(ui);
    if (ui.agentState) assert.match(out, /class="rail-states"/, `${JSON.stringify(ui)}: the chips still show`);
    if (ui.agentFilter) assert.match(out, /data-rail-filter="agents"/, `${JSON.stringify(ui)}: the filter box still shows`);
    assert.match(out, /No agents match\. <button type="button" class="rail-clear" data-rail-clear>Clear<\/button>/, 'an empty result offers Clear');
  }
  assert.match(html({ agentState: 'stopped' }), /class="state-chip on" data-rail-state="stopped" aria-pressed="true">/, 'the Stopped chip that is on stays enabled to turn off');
  const sidebar = read('chat-sidebar.js'), chat = read('chat.js');
  assert.match(sidebar, /ctx\.ui\.agentFilter = ''; ctx\.ui\.agentState = ''; ctx\.ui\.chatFilter = '';/);
  assert.match(chat, /\.length > 3 \|\| ui\.agentState \? stateChipsHtml\(/, 'the phone keeps its chips while a state is on');
  assert.match(chat, /<p class="m-none" hidden>\$\{t`No chat matches\.`\} <button type="button" class="rail-clear" data-rail-clear>/);
});

test('a sidebar redraw keeps focus on the button that had it, like the profile button after Escape (L122)', () => {
  const chat = read('chat.js');
  assert.match(chat, /const refocus = !keepFoot && rail\.contains\(document\.activeElement\) \? focusKey\(document\.activeElement\) : '';/);
  assert.match(chat, /if \(refocus && !rail\.contains\(document\.activeElement\)\) rail\.querySelector\(refocus\)\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(chat, /\['data-action', 'data-open', 'data-id', 'data-rail-state', 'data-rail-tool', 'data-sec', 'data-kind']/);
  assert.match(chat, /closeProfileMenu\(\); document\.querySelector\('\[data-action="profile-toggle"\]'\)\?\.focus\(\);/, 'Escape puts focus on the profile button first');
});

test('the desktop app shows one Notifications bell (L122)', () => {
  assert.match(read('glass.css'), /html\.has-win-bar \.rail-bell\{display:none\}/);
  assert.match(read('chat-notices.js'), /\.find\(item => item\.getClientRects\(\)\.length\)/, 'the pane opens under the bell that shows');
});

test('a hidden team heading really hides under the filter (L122)', () => {
  assert.match(read('glass.css'), /\.sub-sec\[hidden\]\{display:none\}/);
});

test('search and the state filter sit as two small icons in the Agents header and open on a click (L122 feedback)', async () => {
  const { agentListHtml, agentToolsHtml } = await import('../public/chat-sidebar.js');
  const esc = value => String(value ?? '');
  const agents = Array.from({ length: 9 }, (_, index) => ({ id: `a${index}`, name: `Agent ${index}`, status: { state: 'idle' } }));
  const html = ui => agentListHtml({ ui: { snap: {}, ...ui }, esc, isCollapsed: () => false }, agents, agent => agent.name, () => '');
  assert.doesNotMatch(html({}), /rail-filter|rail-states/, 'closed by default, even with many agents');
  assert.match(html({ agentSearchOpen: true }), /data-rail-filter="agents"/);
  assert.doesNotMatch(html({ agentSearchOpen: true }), /rail-states/);
  assert.match(html({ agentStatesOpen: true }), /class="rail-states"/);
  const tools = agentToolsHtml({ ui: { agentState: 'working' } }, agents);
  assert.match(tools, /data-rail-tool="search" title="Filter agents or projects" aria-label="Filter agents or projects" aria-expanded="false"/);
  assert.match(tools, /class="sec-tool open on" data-rail-tool="states"/, 'a state in use keeps its row open and marks the icon');
  assert.equal(agentToolsHtml({ ui: {} }, agents.slice(0, 1)), '', 'one agent needs no search');
  const chat = read('chat.js');
  assert.match(chat, /agentToolsHtml\(ctx, agents\) \+ plus\('spec-new', t\('New agent'\)\)/);
  assert.match(chat, /title="\$\{esc\(label\)\}" aria-label=/, 'places are icons with their name in the tooltip');
  assert.match(read('glass.css'), /\.sec-add\{[^}]*background:var\(--accent\)/, 'the add button is the primary colour');
});

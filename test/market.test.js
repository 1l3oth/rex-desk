import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { toolsOff, setToolOff, useIsOff, filterInventory, filterSlash, runAgentId, marketList } from '../src/market.js';

const store = () => new Store(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-market-')));

test('everything is on by default; a switch keeps only what is off, per agent', () => {
  const db = store();
  db.put('specialist', 'a1', { id: 'a1', name: 'App' }); db.put('specialist', 'a2', { id: 'a2', name: 'Web' });
  assert.equal(toolsOff(db, 'a1').size, 0);
  setToolOff(db, 'a1', 'skill:brag', true); setToolOff(db, 'a1', 'mcp:stripe', true);
  assert.deepEqual([...toolsOff(db, 'a1')], ['mcp:stripe', 'skill:brag']);
  assert.equal(toolsOff(db, 'a2').size, 0, 'the other agent keeps it');
  setToolOff(db, 'a1', 'skill:brag', false);
  assert.deepEqual([...toolsOff(db, 'a1')], ['mcp:stripe']);
  assert.throws(() => setToolOff(db, 'a1', 'mcp:rex_desk', true), /always on/);
  assert.throws(() => setToolOff(db, 'a1', 'nope:x', true), /Unknown/);
  db.close();
});

test('switched-off items leave the prompt list, the / menu, desk_find and desk_run', () => {
  const off = new Set(['skill:brag', 'command:deploy', 'mcp:stripe']);
  const list = filterInventory({ servers: ['- stripe: pay', '- aws-mcp: call'], skills: ['- brag: say it', '- eli5: explain'], moreSkills: 1,
    items: { servers: [{ name: 'stripe' }, { name: 'aws-mcp' }], skills: [{ name: 'brag' }, { name: 'eli5' }], more: [{ name: 'brag2' }] } }, off);
  assert.deepEqual(list.servers, ['- aws-mcp: call']); assert.deepEqual(list.skills, ['- eli5: explain']);
  assert.deepEqual(list.items.servers.map(item => item.name), ['aws-mcp']); assert.deepEqual(list.items.skills.map(item => item.name), ['eli5']); assert.equal(list.moreSkills, 1);
  const slash = filterSlash({ skills: [{ name: 'brag' }, { name: 'eli5' }], commands: [{ name: 'deploy' }, { name: 'teach-me' }] }, off);
  assert.deepEqual(slash.skills.map(item => item.name), ['eli5']); assert.deepEqual(slash.commands.map(item => item.name), ['teach-me']);
  assert.ok(useIsOff(off, 'skill:brag')); assert.ok(useIsOff(off, 'stripe/create_payment'));
  assert.ok(!useIsOff(off, 'skill:eli5')); assert.ok(!useIsOff(off, 'aws-mcp/call'));
  assert.equal(runAgentId({ specialistId: 'a1' }), 'a1'); assert.equal(runAgentId({ roomAgent: 'a2' }), 'a2'); assert.equal(runAgentId({ main: true }), 'main');
});

test('long descriptions are cut at a word break, never mid-word', () => {
  const long = `${'Builds generative applications on Bedrock with knowledge bases '.repeat(5)}end`;
  const desk = { toolbox: { skills: () => [{ name: 'bedrock', description: long }], servers: () => ({}) }, agents: { selected: () => '' }, store: store(), specialists: { list: () => [] } };
  let list; try { list = marketList(desk); } catch (error) { return assert.fail(`marketList needs more of the desk: ${error.message}`); }
  const item = (list.items || list).find(entry => entry.name === 'bedrock');
  assert.ok(item.description.length <= 201);
  assert.match(item.description, /[a-z]…$/);
  assert.ok(long.startsWith(item.description.slice(0, -1)));
  assert.ok(long[item.description.length - 1] === ' ', 'the cut falls on a space');
});

test('Market labels each item: Orbit is an MCP server, never a connector; one-file skills and hooks show as such', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-market-kinds-'));
  const single = path.join(home, 'notes'), full = path.join(home, 'deploy');
  mkdirSync(single); writeFileSync(path.join(single, 'SKILL.md'), 'x');
  mkdirSync(full); writeFileSync(path.join(full, 'SKILL.md'), 'x'); writeFileSync(path.join(full, 'run.sh'), 'x');
  const memory = store();
  memory.put('config', 'main', { ...memory.config(), sources: [{ id: 'c1', type: 'orbit', name: 'Goal', enabled: true }, { id: 'c2', type: 'flow', name: 'Flow', enabled: true }] });
  const desk = { toolbox: { skills: () => [{ name: 'notes', description: 'Notes', folder: single }, { name: 'deploy', description: 'Deploy', folder: full }], servers: () => ({}), listHooks: () => [{ id: 'Stop:0:0', event: 'Stop', matcher: '', command: 'echo done' }] },
    orbitAccount: () => ({ token: 't' }), agents: { selected: () => '' }, store: memory, specialists: { list: () => [] } };
  const items = marketList(desk).items;
  const named = name => items.find(item => item.name === name);
  assert.equal(named('notes').file, true);
  assert.equal(named('deploy').file, undefined);
  assert.deepEqual(named('Orbit').orbit, { signedIn: true, goals: 1, servers: [{ name: 'Goal', url: 'https://orbit.vongpichdaraboth.com/api/mcp' }, { name: 'Brain', url: 'https://orbit.vongpichdaraboth.com/api/mcp-server' }] });
  assert.equal(named('Orbit').kind, 'mcp');
  // A new person (no Orbit account, no goal) still finds Orbit here: it is no longer in the Connectors picker.
  memory.put('config', 'main', { ...memory.config(), sources: [] });
  const fresh = marketList({ ...desk, orbitAccount: () => null }).items.find(item => item.name === 'Orbit');
  assert.deepEqual(fresh?.orbit, { signedIn: false, goals: 0, servers: [{ name: 'Goal', url: 'https://orbit.vongpichdaraboth.com/api/mcp' }, { name: 'Brain', url: 'https://orbit.vongpichdaraboth.com/api/mcp-server' }] });
  // Flow and Morningmate run their own MCP servers: until linked, each is listed under MCP with its address and opens its Connectors form.
  assert.deepEqual(items.filter(item => item.remote).map(item => [item.remote, item.kind, item.description]), [['flow-mcp', 'mcp', 'https://flow.team/ai/mcp'], ['morningmate-mcp', 'mcp', 'https://morningmate.com/ai/mcp']]);
  assert.ok(items.some(item => item.kind === 'connector' && item.name === 'Flow'), 'the Flow API connection is still listed');
  assert.ok(!marketList({ ...desk, toolbox: { ...desk.toolbox, servers: () => ({ 'flow-mcp': { type: 'http', url: 'https://flow.team/ai/mcp' } }) } }).items.some(item => item.remote === 'flow-mcp'), 'a linked Flow MCP shows as its own server, not again');
  assert.ok(!items.some(item => item.kind === 'connector' && item.name === 'Goal'), 'an Orbit goal is not listed as a connector');
  assert.equal(named('Stop').kind, 'hook');
  assert.equal(named('Stop').id, 'Stop:0:0');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { toolsOff, setToolOff, useIsOff, filterInventory, filterSlash, runAgentId } from '../src/market.js';

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

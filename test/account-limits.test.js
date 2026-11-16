import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { AgentProfiles } from '../src/agents.js';

test("an account that hit its limit is skipped until Claude's reset time, and choosing it clears that", () => {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-limits-'))), agents = new AgentProfiles(store);
  const until = profile => Object.entries(store.get('accounts', 'limited').until).find(([key]) => key.endsWith(profile))?.[1];
  try {
    const soon = Date.now() + 10 * 60000;
    agents.markLimited('C:\\Users\\me\\.config\\claude2', soon);
    assert.equal(until('claude2'), soon, 'limited until the reset Claude reported, not 5 hours');
    agents.markLimited('C:\\Users\\me\\.config\\claude1');
    assert.ok(Math.abs(until('claude1') - (Date.now() + 5 * 3600000)) < 5000, 'without a reported reset: 5 hours');
    agents.markLimited('C:\\Users\\me\\.config\\claude3', Date.now() - 1000);
    assert.ok(until('claude3') > Date.now() + 4 * 3600000, 'a reset time already past is not trusted');
    agents.clearLimited('C:\\Users\\me\\.config\\claude2');
    assert.equal(until('claude2'), undefined, 'the person picked it: the mark is gone');
    assert.ok(until('claude1'), 'the other marks stay');
  } finally { store.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The rex-desk-guide skill must name every Settings page and tab, so Rex Agent can always point the person to the right
// place. This test reads the real Settings map from public/chat-settings.js and fails if the guide is missing any page id,
// which is what happens when a new Settings page is added without updating the guide.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settings = readFileSync(path.join(root, 'public', 'chat-settings.js'), 'utf8');
const guide = readFileSync(path.join(root, 'skills', 'rex-desk-guide', 'SKILL.md'), 'utf8');

// Every page id Settings knows: the keys and values of PARTS (sections and their tabs) plus every SECTIONS id.
function settingsPageIds() {
  const ids = new Set();
  const parts = /const PARTS = \{([^}]*)\};/.exec(settings);
  assert.ok(parts, 'PARTS not found in chat-settings.js; update this test if the Settings map moved.');
  for (const match of parts[1].matchAll(/'([a-z]+)'/g)) ids.add(match[1]);
  const sections = /const SECTIONS = \[([\s\S]*?)\];/.exec(settings);
  assert.ok(sections, 'SECTIONS not found in chat-settings.js.');
  for (const match of sections[1].matchAll(/\[\s*'([a-z]+)'/g)) ids.add(match[1]);
  return [...ids].sort();
}

test('the rex-desk-guide skill names every Settings page and tab', () => {
  const ids = settingsPageIds();
  assert.ok(ids.length >= 10, `expected the Settings map to have many pages, found ${ids.length}`);
  // Each id must appear in the guide as a backticked token, like `general`, so the match is exact and not a chance substring.
  const missing = ids.filter(id => !guide.includes('`' + id + '`'));
  assert.deepEqual(missing, [], `the rex-desk-guide skill is missing these Settings pages: ${missing.join(', ')}. Add each (as \`id\`) to skills/rex-desk-guide/SKILL.md.`);
});

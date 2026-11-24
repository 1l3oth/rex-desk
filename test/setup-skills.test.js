import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SKILLS } from '../src/specialists.js';
import { listSkills, rank } from '../src/toolbox.js';

const NAMES = ['rex-setup-orchestration', 'rex-setup-playbook'];

test('the two setup skills ship with Rex Desk and are found by their plain names', () => {
  for (const name of NAMES) assert.ok(existsSync(path.join(SKILLS, name, 'SKILL.md')), name);
  const skills = listSkills([SKILLS]);
  const found = new Set(skills.map(skill => skill.name));
  for (const name of NAMES) assert.ok(found.has(name), name);
  for (const name of NAMES) assert.ok(skills.find(skill => skill.name === name)?.description && !skills.find(skill => skill.name === name)?.error, `${name} has a description and no error`);
});

test('the setup skills are instruction only: no render script, no emoji, no em dash', () => {
  for (const name of NAMES) {
    const folder = path.join(SKILLS, name);
    assert.ok(!existsSync(path.join(folder, 'scripts')), `${name} ships no scripts`);
    const text = readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(text, /—/, `${name} has no em dash`);
    assert.doesNotMatch(text, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${name} has no emoji`);
  }
});

test('each setup skill wins its own plain question', () => {
  const skills = listSkills([SKILLS]);
  assert.equal(rank(skills, 'set up a team for my project')[0].name, 'rex-setup-orchestration');
  assert.equal(rank(skills, 'write the first playbook workflow rules')[0].name, 'rex-setup-playbook');
});

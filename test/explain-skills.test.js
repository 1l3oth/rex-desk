import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { SKILLS, ELI5_RULE, explainRule } from '../src/specialists.js';
import { listSkills, rank } from '../src/toolbox.js';
import { render as renderChanges } from '../skills/rex-code-explainer/scripts/render.mjs';
import { render as renderSimply, cleanSvg } from '../skills/rex-eli5/scripts/render.mjs';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const selfContained = html => { assert.doesNotMatch(html, /https?:\/\//i, 'no link to the internet'); assert.doesNotMatch(html, /<script|<link|<img|@import/i, 'nothing loaded from outside'); };

test('the built-in skills ship with Rex Desk and are found by their plain names', () => {
  for (const name of ['rex-code-explainer', 'rex-eli5', 'rex-desk-guide', 'rex-setup-phone']) assert.ok(existsSync(path.join(SKILLS, name, 'SKILL.md')), name);
  const skills = listSkills([SKILLS]);
  assert.deepEqual(skills.map(skill => skill.name).sort(), ['rex-code-explainer', 'rex-desk-guide', 'rex-eli5', 'rex-setup-orchestration', 'rex-setup-phone', 'rex-setup-playbook']);
  assert.ok(skills.every(skill => skill.description && !skill.error));
  assert.equal(rank(skills, 'explain my changes')[0].name, 'rex-code-explainer');
  assert.equal(rank(skills, 'explain it simply')[0].name, 'rex-eli5');
  assert.equal(rank(skills, 'set up my phone')[0].name, 'rex-setup-phone');
  assert.equal(rank(skills, 'where is the setting in Rex Desk')[0].name, 'rex-desk-guide');
  assert.match(ELI5_RULE, /rex-eli5[\\/]SKILL\.md/);
});

test('the code change rule: on with a reviewer, on without one, and off', () => {
  const reviewed = explainRule({ on: true, reviewer: 'Codex Reviewer' });
  assert.match(reviewed, /After you change code, always use the rex-code-explainer skill/);
  assert.match(reviewed, /needsOk: true, only once Codex Reviewer \(the team's code reviewer\) has approved/);
  const alone = explainRule({ on: true });
  assert.match(alone, /After you change code, always/); assert.match(alone, /needsOk: true, right away, asking the person to OK the change/);
  const off = explainRule({ on: false, reviewer: 'Codex Reviewer' });
  assert.doesNotMatch(off, /After you change code|needsOk/); assert.match(off, /When the person asks what you changed/);
});

test('an agent gets the rule for its own team and the person\'s setting', () => {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop' }));
  const store = new Store(temporary('explain')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  desk.memory.scan({ roots: [projects] });
  const dev = desk.specialists.create({ name: 'Builder', projectSlug: 'shop' });
  assert.match(desk.specialists.identity(dev), /right away, asking the person to OK the change/, 'no reviewer: straight to the person');
  desk.specialists.create({ name: 'Shop Reviewer', projectSlug: 'shop', purpose: 'Reviews every code change' });
  assert.match(desk.specialists.identity(store.get('specialist', dev.id)), /only once Shop Reviewer \(the team's code reviewer\) has approved/);
  store.saveConfig({ ...store.publicConfig(), showChanges: false });
  assert.equal(store.config().showChanges, false, 'the setting is kept');
  assert.doesNotMatch(desk.specialists.identity(store.get('specialist', dev.id)), /After you change code/, 'off: no page after each change');
});

test('rex-code-explainer renders a self-contained page with the changed lines, notes and a picture', () => {
  const html = renderChanges({ title: 'Footer fits — small windows', summary: 'The hint hides when the box is narrow.', idea: ['Box gets narrow', 'Hint hides', 'One row'],
    files: [{ path: 'public/chat.css', blocks: [{ start: 176, code: '-.hint{font-size:12px}\n+.hint{white-space:nowrap}\n <b>kept</b>', note: 'Stays on one line.' }] }] });
  selfContained(html);
  assert.match(html, /<svg class="flow"/); assert.match(html, /class="ln del"/); assert.match(html, /class="ln add"><span class="no">176/);
  assert.match(html, /&lt;b&gt;kept&lt;\/b&gt;/, 'code is escaped'); assert.match(html, /Stays on one line\./);
  assert.match(html, /prefers-color-scheme:dark/); assert.doesNotMatch(html, /—/, 'no em dashes');
});

test('rex-eli5 renders numbered picture steps, and an agent\'s own drawing keeps no links or scripts', () => {
  const html = renderSimply({ title: 'Why the message was lost', steps: [
    { text: 'You schedule a message.', picture: ['You', 'Schedule'] },
    { text: 'The agent reads an old note.', picture: ['Old note', 'Agent'], mark: 'bad' },
    { text: 'Now the newest goes first.', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()"><script>x()</script><a href="https://example.com"><rect/></a><circle r="4"/></svg>' }] });
  selfContained(html);
  assert.equal((html.match(/<li class="step">/g) || []).length, 3);
  assert.match(html, /class="box bad"/); assert.match(html, /<svg class="own" viewBox="0 0 10 10"><rect\/><circle r="4"\/><\/svg>/);
  assert.equal(cleanSvg('<svg><rect style="fill:url(https://x.test/a)"/></svg>').includes('https'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectLogo } from '../src/project-logo.js';
import { createApp } from '../src/server.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test("an agent's avatar is its project's own logo when there is a small, safe one; otherwise none", () => {
  const project = temporary('logo');
  assert.equal(findProjectLogo(project), null, 'no logo: the agent gets a robot');
  mkdirSync(path.join(project, 'public'));
  writeFileSync(path.join(project, 'public', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(findProjectLogo(project), null, 'an SVG with a script is never used');
  writeFileSync(path.join(project, 'public', 'logo.png'), Buffer.alloc(70 * 1024, 1));
  assert.equal(findProjectLogo(project), null, 'a logo over 60 KB is skipped');
  writeFileSync(path.join(project, 'public', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
  const logo = findProjectLogo(project);
  assert.equal(path.relative(project, logo.file), path.join('public', 'logo.svg'));
  assert.match(logo.dataUrl, /^data:image\/svg\+xml;base64,/);
});

test('the sidebar order and pins are saved with the workspace and come back with it', async () => {
  const app = await createApp({ dataDirectory: temporary('sidebar'), port: 0 });
  try {
    const post = data => fetch(`${app.address}/api/sidebar`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rex-Desk': '1' }, body: JSON.stringify(data) });
    assert.equal((await post({ kind: 'agents', order: ['b', 'a', 'c'], pins: ['c'] })).status, 200);
    assert.equal((await post({ kind: 'rooms', pins: ['r1'] })).status, 200);
    assert.equal((await post({ kind: 'everything', order: [] })).status, 400);
    const state = await (await fetch(`${app.address}/api/state`)).json();
    assert.deepEqual(state.sidebar, { agents: { order: ['b', 'a', 'c'], pins: ['c'] }, rooms: { pins: ['r1'] } });
  } finally { await app.close(); }
});

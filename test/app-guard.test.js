import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { guardTool, PROTECT_RULE } from '../src/app-guard.js';

const data = path.join(os.tmpdir(), 'Rex Desk data'), install = path.join(os.tmpdir(), 'Rex Desk app');
const places = { data, install, serverPid: 4242 };
const shell = command => guardTool('Bash', { command }, places);

test('agents cannot take down the Rex Desk they run inside', () => {
  for (const command of ['taskkill /F /IM node.exe', 'Stop-Process -Name node -Force', 'Get-Process node | Stop-Process', 'pkill -f node', 'taskkill /PID 4242 /F',
    'Stop-Process -Id 4242', 'taskkill /IM rex-desk.exe /F', `Remove-Item -Recurse -Force "${data}"`, `rm -rf "${data.replace(/\\/g, '/')}"`, `del "${path.join(install, 'payload', 'app', 'src', 'server.js')}"`,
    'set PORT=4317&& node src/server.js'])
    assert.match(shell(command), /^Rex Desk blocked this/, command);
  assert.match(guardTool('Edit', { file_path: path.join(install, 'payload', 'app', 'src', 'server.js') }, places), /installed Rex Desk app/);
  assert.match(guardTool('Write', { file_path: path.join(data, 'workspaces', 'w1', 'desk.sqlite') }, places), /database, keys or lock/);
  assert.match(PROTECT_RULE, /never start another Rex Desk server/i);
});

test("an agent's ordinary work is not blocked", () => {
  for (const command of ['npm test', 'taskkill /PID 9001 /F', 'Stop-Process -Id 31337', 'node src/server.js', 'git status', 'rm -rf node_modules', `dir "${data}"`, 'Get-Process node'])
    assert.equal(shell(command), '', command);
  assert.equal(guardTool('Edit', { file_path: path.join(os.tmpdir(), 'project', 'src', 'app.js') }, places), '');
  assert.equal(guardTool('Write', { file_path: path.join(data, 'workspaces', 'w1', 'artifacts', 'run-1', 'report.md') }, places), '', 'evidence files in the data folder are fine');
  assert.equal(guardTool('Read', { file_path: path.join(data, 'workspaces', 'w1', 'desk.sqlite') }, places), '');
});

test('every agent knows how to restart Rex Desk, how updates work, and every section of Settings', async () => {
  const { APP_GUIDE } = await import('../src/app-guard.js');
  const { readFileSync } = await import('node:fs');
  const settings = readFileSync(new URL('../public/chat-settings.js', import.meta.url), 'utf8');
  const sections = [...settings.match(/const SECTIONS = \[([\s\S]*?)\];/)[1].matchAll(/\['[a-z]+', '([^']+)'/g)].map(match => match[1]);
  assert.ok(sections.length >= 10);
  for (const name of sections) assert.ok(APP_GUIDE.includes(name), `the guide names the "${name}" section`);
  assert.match(APP_GUIDE, /Restart Rex Desk server/); assert.match(APP_GUIDE, /Update when it finishes/); assert.match(APP_GUIDE, /Check now/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { AgentProfiles } from '../src/agents.js';

// A stand-in for `claude auth login` / `agy acp --login` that cannot get the browser answer by itself: it prints the sign-in
// page, asks for the code that page shows, and signs in only with the right one. "hang" also starts a program of its own and
// waits, for Cancel.
const STAND_IN = `
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const mode = process.env.STAND_IN_MODE;
console.log('Opening browser to sign in. If it did not open, visit: https://claude.ai/oauth/authorize?client=standin');
if (mode === 'hang') {
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.STAND_IN_PIDS, JSON.stringify([process.pid, helper.pid]));
}
process.stdout.write('Paste code here if prompted > ');
let text = '';
process.stdin.on('data', chunk => {
  text += chunk; if (!text.includes('\\n')) return;
  if (text.trim() === 'GOOD-CODE') { console.log('Login successful.'); process.exit(0); }
  console.log('OAuth error: Invalid code'); process.exit(1);
});
`;
const folder = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-signin-code-')), script = path.join(folder, 'stand-in.cjs');
writeFileSync(script, STAND_IN);
const until = async (check, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 100)); } return false; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function start(agents, mode, extra = {}) {
  return agents.loginHidden({ provider: 'claude', profile: '', executable: { command: process.execPath, args: [script] }, found: true, install: '', name: 'Claude', env: { ...process.env, STAND_IN_MODE: mode, ...extra }, args: ['auth', 'login'] });
}

test('a new user pastes the code the browser page shows, through the real hidden sign-in, and is signed in', { timeout: 60000 }, async () => {
  const store = new Store(mkdtempSync(path.join(folder, 'data-'))), agents = new AgentProfiles(store);
  try {
    assert.equal(start(agents, 'code').started, true);
    assert.ok(await until(() => agents.loginJob('claude').codeAsked), 'the screen learns that a code is asked');
    assert.equal(agents.loginJob('claude').url, 'https://claude.ai/oauth/authorize?client=standin');
    assert.throws(() => agents.sendLoginCode('claude', 'GOOD\nrm -rf'), /does not look like a sign-in code/, 'one line only');
    assert.equal(agents.sendLoginCode('claude', '  GOOD-CODE  ').codeSent, true);
    assert.ok(await until(() => agents.loginJob('claude').state === 'finished'), 'signed in');
    assert.equal(JSON.stringify(agents.loginJob('claude')).includes('GOOD-CODE'), false, 'the code is never kept where the page can read it');
  } finally { store.close(); }
});

test('a wrong or old code gets a plain message and Start again works', { timeout: 60000 }, async () => {
  const store = new Store(mkdtempSync(path.join(folder, 'data-'))), agents = new AgentProfiles(store);
  try {
    start(agents, 'code');
    assert.ok(await until(() => agents.loginJob('claude').codeAsked));
    agents.sendLoginCode('claude', 'OLD-CODE');
    assert.ok(await until(() => agents.loginJob('claude').state === 'failed'));
    assert.match(agents.loginJob('claude').error, /The code may be wrong or too old. Start again/);
    assert.throws(() => agents.sendLoginCode('claude', 'GOOD-CODE'), /has stopped\. Start it again/);
    start(agents, 'code');
    assert.ok(await until(() => agents.loginJob('claude').codeAsked));
    assert.equal(agents.loginJob('claude').codeSent, false, 'a fresh start asks again');
    agents.sendLoginCode('claude', 'GOOD-CODE');
    assert.ok(await until(() => agents.loginJob('claude').state === 'finished'));
  } finally { store.close(); }
});

test('Cancel stops the whole sign-in, with every program it started', { timeout: 60000 }, async () => {
  const store = new Store(mkdtempSync(path.join(folder, 'data-'))), agents = new AgentProfiles(store), pids = path.join(folder, `pids-${Date.now()}.json`);
  try {
    start(agents, 'hang', { STAND_IN_PIDS: pids });
    assert.ok(await until(() => existsSync(pids) && agents.loginJob('claude').codeAsked));
    const started = JSON.parse(readFileSync(pids, 'utf8'));
    assert.ok(started.every(alive));
    assert.equal(agents.cancelLogin('claude').state, 'canceled');
    assert.ok(await until(() => !started.some(alive)), 'no program is left waiting');
    assert.equal(agents.cancelLogin('claude').state, 'canceled', 'a second cancel does nothing');
  } finally { store.close(); }
});

test('a code turned down while the sign-in still runs, a sign-in that comes back by itself, and the timeout', async t => {
  const child = () => Object.assign(new EventEmitter(), { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { writable: true, write(text) { this.sent = text; } }, kill() {} });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store(mkdtempSync(path.join(folder, 'data-'))), stopped = [];
  let current;
  const agents = new AgentProfiles(store, { spawnHidden: () => (current = child()), stopProcessTree: process => stopped.push(process) });
  try {
    start(agents, 'fake');
    current.stdout.emit('data', 'REXDESK-SIGNIN-STARTS\nEnter the authorization code: ');
    assert.equal(agents.loginJob('claude').codeAsked, true, "Antigravity's way of asking counts too");
    agents.sendLoginCode('claude', 'abc'); assert.equal(current.stdin.sent, 'abc\n');
    current.stdout.emit('data', 'That code is expired. Enter the authorization code: ');
    assert.deepEqual([agents.loginJob('claude').state, agents.loginJob('claude').codeError], ['signing-in', true]);
    assert.match(agents.loginJob('claude').error, /wrong or too old/);
    agents.sendLoginCode('claude', 'def'); assert.equal(agents.loginJob('claude').codeError, false, 'a new code clears it');

    start(agents, 'fake'); const first = current;
    first.stdout.emit('data', 'REXDESK-SIGNIN-STARTS\nhttps://claude.ai/oauth\n'); first.emit('exit', 0);
    assert.equal(agents.loginJob('claude').state, 'finished', 'the browser came back by itself: no code needed');

    start(agents, 'fake'); const slow = current;
    t.mock.timers.tick(15 * 60000);
    assert.ok(stopped.includes(slow), 'the timeout stops the whole sign-in');
    assert.match(agents.loginJob('claude').error, /waited too long/);
  } finally { store.close(); }
});

test('the first-run screen sends the code, cancels on the server, and looks at the accounts anew when an AI is picked', () => {
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const screen = read('public/chat-firstrun.js'), server = read('src/server.js'), km = JSON.parse(read('public/i18n/km.json'));
  assert.match(screen, /data-fr-codeform/);
  assert.match(screen, /api\('\/agents\/login\/code', \{ method: 'POST', data: \{ provider: fr\.ai, code \} \}\)/);
  assert.match(screen, /api\('\/agents\/login\/cancel', \{ method: 'POST', data: \{ provider: fr\.ai \} \}\)/);
  assert.match(screen, /if \(target\.closest\('\[data-fr-back\]'\)\) \{ cancel\(fr, api\);/);
  assert.match(screen, /if \(target\.closest\('\[data-fr-cancel\]'\)\) \{ cancel\(fr, api\);/);
  assert.match(screen, /await load\(\)\.catch\(\(\) => \{\}\); if \(!alive\(\)\) return true;/, 'a pick looks again, never at the old answer');
  assert.match(server, /\/api\/agents\/login\/code/); assert.match(server, /\/api\/agents\/login\/cancel/);
  for (const text of ['Paste the code here', 'If the browser page shows a code, copy it and paste it here.', 'The code may be wrong or too old. Start again to get a new code.', 'That code did not work', 'Checking the code…', 'Start again', 'Checking this computer…']) assert.ok(km[text], text);
});

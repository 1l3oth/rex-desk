import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentProfiles } from '../src/agents.js';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

// A home folder with the default ~/.claude, a shared history folder and one account added in Rex Desk whose "projects" is a
// junction to the shared history, like addProfile makes it.
function fakeHome() {
  const home = temporary('acct-home');
  mkdirSync(path.join(home, '.claude'), { recursive: true }); writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  const shared = path.join(home, '.config', 'claude-code-shared-history'); mkdirSync(shared, { recursive: true }); writeFileSync(path.join(shared, 'chat.jsonl'), 'kept');
  const work = path.join(home, '.config', 'claude-work'); mkdirSync(work, { recursive: true }); writeFileSync(path.join(work, '.credentials.json'), '{}');
  symlinkSync(shared, path.join(work, 'projects'), 'junction');
  return { home, shared, work };
}

test('only accounts Rex Desk added can be removed, never the default folder or the shared history (L123)', () => {
  const { home, shared, work } = fakeHome(), agents = new AgentProfiles({ config: () => ({}) }, { roots: { home } });
  assert.equal(agents.removable('claude', work), true);
  assert.equal(agents.removable('claude', ''), false, 'the default account');
  assert.equal(agents.removable('claude', path.join(home, '.claude')), false);
  assert.equal(agents.removable('claude', shared), false);
  assert.equal(agents.removable('claude', path.join(work, 'inner')), false, 'nothing deeper than .config/<provider>-<name>');
  assert.equal(agents.removable('codex', work), false, 'another AI\'s folder');
  assert.equal(agents.removable('gemini', path.join(home, '.config', 'gemini-work')), false);
  assert.throws(() => agents.deleteProfile('claude', path.join(home, '.claude')), /main account stays/);
  assert.ok(existsSync(path.join(home, '.claude', '.credentials.json')));
});

test('removing the account in use switches to the main one, clears what was saved for it, and keeps the shared history (L123)', async () => {
  const { home, shared, work } = fakeHome(), store = new Store(temporary('acct-store'));
  const desk = new Desk(store, { root: temporary('acct-root'), runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  try {
    desk.agents.roots = { home };
    store.saveConfig({ ...store.publicConfig(), agentProfiles: { ...store.config().agentProfiles, claude: work } });
    const agent = desk.specialists.create({ name: 'Writer', purpose: 'Writes.' });
    store.put('specialist', agent.id, { ...store.get('specialist', agent.id), profile: work });
    store.put('usage', `claude:${work}`, { id: `claude:${work}`, provider: 'claude', profile: work, windows: {} });
    desk.agents.markLimited(work);
    const result = desk.removeAccount('claude', work);
    assert.deepEqual(result, { removed: true, switched: true, moved: 1 });
    assert.equal(existsSync(work), false, 'the added account folder is gone');
    assert.equal(readFileSync(path.join(shared, 'chat.jsonl'), 'utf8'), 'kept', 'the shared conversations stay');
    assert.ok(existsSync(path.join(home, '.claude', '.credentials.json')), 'the default account is untouched');
    assert.equal(store.config().agentProfiles.claude, null, 'everyone is back on the main account');
    assert.equal(store.get('specialist', agent.id).profile, '');
    assert.equal(store.get('usage', `claude:${work}`), undefined);
    assert.deepEqual(store.get('accounts', 'limited').until, {});
    assert.throws(() => desk.removeAccount('claude', ''), /main account stays/);
  } finally { await desk.shutdown(); store.close(); }
});

test('removing an account that is not in use leaves the choice alone (L123)', async () => {
  const { home, work } = fakeHome(), store = new Store(temporary('acct-store2'));
  const desk = new Desk(store, { root: temporary('acct-root2'), runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  try {
    desk.agents.roots = { home };
    assert.deepEqual(desk.removeAccount('claude', work), { removed: true, switched: false, moved: 0 });
    assert.equal(existsSync(work), false);
  } finally { await desk.shutdown(); store.close(); }
});

test('sign out runs each CLI\'s own sign-out on that account, and Gemini opens agy with /logout (L123)', async () => {
  const calls = [], opened = [];
  let signedIn = true;
  const run = async (command, args, env) => {
    calls.push({ args, profile: env.CLAUDE_CONFIG_DIR || env.CODEX_HOME || '' });
    if (args.includes('logout')) { signedIn = false; return { code: 0, stdout: '', stderr: '' }; }
    if (args.includes('status')) return args.includes('--json') ? { code: 0, stdout: JSON.stringify({ loggedIn: signedIn }), stderr: '' } : { code: signedIn ? 0 : 1, stdout: signedIn ? 'Logged in using ChatGPT' : 'Not logged in', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const agents = new AgentProfiles({ config: () => ({}) }, { run, found: () => true, openWindow: options => opened.push(options) });
  const work = temporary('acct-work');
  assert.deepEqual(await agents.signOut('claude', work), { signedOut: true });
  assert.ok(calls.some(call => call.args.join(' ').endsWith('auth logout') && path.resolve(call.profile) === path.resolve(work)), 'claude auth logout, on that account folder');
  signedIn = true;
  assert.deepEqual(await agents.signOut('codex', work), { signedOut: true });
  assert.ok(calls.some(call => call.args.at(-1) === 'logout' && !call.args.includes('auth')), 'codex logout');
  assert.deepEqual(await agents.signOut('gemini', ''), { window: true });
  assert.match(opened[0].line, /type \/logout/);
  await assert.rejects(agents.signOut('openrouter', ''), /remove the key/);
  // A CLI that does not really sign out says so instead of pretending.
  const stuck = new AgentProfiles({ config: () => ({}) }, { run: async (command, args) => ({ code: 0, stdout: args.includes('--json') ? JSON.stringify({ loggedIn: true }) : '', stderr: '' }), found: () => true });
  await assert.rejects(stuck.signOut('claude', work), /did not sign out/);
});

test('Gemini shows a plain note instead of adding a second account, and the rows have Sign out and Remove (L123)', () => {
  const agents = new AgentProfiles({ config: () => ({}) }, { roots: { home: temporary('acct-gem') } });
  assert.throws(() => agents.addProfile('gemini', 'work'), /one Google account signed in on a computer/);
  const chat = read('chat.js');
  assert.match(chat, /name === 'gemini' \? `<p class="acct-one muted">\$\{t`Antigravity keeps one Google account signed in on a computer\./);
  assert.match(chat, /data-acct-signout="\$\{esc\(item\.profile\)\}"/);
  assert.match(chat, /item\.removable \? `<button type="button" class="or-link bad" data-acct-remove=/);
  assert.match(chat, /api\('\/agents\/remove'/);
});

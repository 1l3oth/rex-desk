import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentProfiles } from '../src/agents.js';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const stub = () => ({ async start() {}, async interrupt() {} });

// A home folder with the default ~/.claude and a shared history folder.
function fakeHome() {
  const home = temporary('acct-home');
  mkdirSync(path.join(home, '.claude'), { recursive: true }); writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  const shared = path.join(home, '.config', 'claude-code-shared-history'); mkdirSync(shared, { recursive: true }); writeFileSync(path.join(shared, 'chat.jsonl'), 'kept');
  return { home, shared };
}
// A Desk on a throwaway store whose accounts live in a fake home.
async function withDesk(label, body, files) {
  const { home, shared } = fakeHome(), store = new Store(temporary(`${label}-store`));
  const desk = new Desk(store, { root: temporary(`${label}-root`), runnerFactory: stub });
  desk.agents.roots = { home };
  if (files) desk.agents.files = { ...desk.agents.files, ...files };
  try { await body({ desk, store, home, shared }); } finally { await desk.shutdown(); store.close(); }
}
// An account added in Rex Desk (so it has the ownership record), signed in, with "projects" linked to the shared history.
const added = (desk, name = 'work', provider = 'claude') => { const { profile } = desk.agents.addProfile(provider, name); writeFileSync(path.join(profile, provider === 'codex' ? 'auth.json' : '.credentials.json'), '{}'); return profile; };
const pin = (store, provider, profile) => store.saveConfig({ ...store.publicConfig(), agentProfiles: { ...store.config().agentProfiles, [provider]: profile } });

test('only accounts shaped like Rex Desk ones can be removed, and only a recorded one is deleted (L123)', async () => {
  await withDesk('acct-shape', async ({ desk, home, shared }) => {
    const agents = desk.agents, work = added(desk);
    assert.equal(agents.removeMode('claude', work), 'delete', 'made by Rex Desk: recorded');
    assert.equal(agents.removeMode('claude', ''), '', 'the default account');
    assert.equal(agents.removeMode('claude', path.join(home, '.claude')), '');
    assert.equal(agents.removeMode('claude', shared), '');
    assert.equal(agents.removeMode('claude', path.join(work, 'inner')), '', 'nothing deeper than .config/<provider>-<name>');
    assert.equal(agents.removeMode('codex', work), '', 'another AI\'s folder');
    assert.equal(agents.removeMode('gemini', path.join(home, '.config', 'gemini-work')), '');
    assert.throws(() => desk.removeAccount('claude', path.join(home, '.claude')), /main account stays/);
    assert.ok(existsSync(path.join(home, '.claude', '.credentials.json')));
  });
});

test('a claude-work folder another tool made is never deleted: it only leaves the list, and stays hidden after a restart (L123)', async () => {
  await withDesk('acct-foreign', async ({ desk, store, home }) => {
    const foreign = path.join(home, '.config', 'claude-work'); mkdirSync(foreign, { recursive: true }); writeFileSync(path.join(foreign, 'their-file.txt'), 'theirs');
    pin(store, 'claude', foreign);
    assert.equal(desk.agents.removeMode('claude', foreign), 'hide', 'the name proves nothing');
    assert.throws(() => desk.agents.detachProfile('claude', foreign), /cannot prove it made/);
    const result = desk.removeAccount('claude', foreign);
    assert.deepEqual(result, { removed: true, switched: true, moved: 0, hidden: true, kept: '', leftover: '' });
    assert.equal(readFileSync(path.join(foreign, 'their-file.txt'), 'utf8'), 'theirs', 'the folder and its files stay');
    assert.equal(store.config().agentProfiles.claude, null);
    assert.ok(!desk.agents.profiles('claude').some(item => item.profile && path.resolve(item.profile) === path.resolve(foreign)), 'off the list');
    const again = new AgentProfiles(store, { roots: { home } });
    assert.ok(!again.profiles('claude').some(item => item.profile && path.resolve(item.profile) === path.resolve(foreign)), 'still off the list after a restart');
  });
});

test('an account added before the ownership record existed only leaves the list (L123)', async () => {
  await withDesk('acct-old', async ({ desk, home, shared }) => {
    // Made the old way: the folder and its history link, but no record.
    const old = path.join(home, '.config', 'claude-personal'); mkdirSync(old, { recursive: true }); writeFileSync(path.join(old, '.credentials.json'), '{}');
    symlinkSync(shared, path.join(old, 'projects'), 'junction');
    assert.equal(desk.agents.removeMode('claude', old), 'hide');
    assert.equal(desk.removeAccount('claude', old).hidden, true);
    assert.ok(existsSync(path.join(old, '.credentials.json')), 'nothing deleted');
    assert.equal(readFileSync(path.join(old, 'projects', 'chat.jsonl'), 'utf8'), 'kept');
  });
});

test('a recorded profile folder that became a junction is never deleted through (L123)', async () => {
  await withDesk('acct-junction', async ({ desk, home }) => {
    const work = added(desk);
    const elsewhere = temporary('acct-elsewhere'); writeFileSync(path.join(elsewhere, 'precious.txt'), 'mine');
    rmSync(work, { recursive: true, force: true }); symlinkSync(elsewhere, work, 'junction');
    assert.equal(desk.agents.removeMode('claude', work), 'hide', 'a junction is not the folder Rex Desk made');
    assert.throws(() => desk.agents.detachProfile('claude', work), /cannot prove it made/);
    desk.removeAccount('claude', work);
    assert.equal(readFileSync(path.join(elsewhere, 'precious.txt'), 'utf8'), 'mine');
    assert.ok(existsSync(path.join(home, '.config')));
    unlinkSync(work);
  });
});

test('removing the account in use switches to the main one, clears what was saved for it, and keeps the shared history (L123)', async () => {
  await withDesk('acct-inuse', async ({ desk, store, home, shared }) => {
    const work = added(desk);
    pin(store, 'claude', work);
    const agent = desk.specialists.create({ name: 'Writer', purpose: 'Writes.' });
    store.put('specialist', agent.id, { ...store.get('specialist', agent.id), profile: work });
    store.put('usage', `claude:${work}`, { id: `claude:${work}`, provider: 'claude', profile: work, windows: {} });
    desk.agents.markLimited(work);
    const result = desk.removeAccount('claude', work);
    assert.deepEqual(result, { removed: true, switched: true, moved: 1, hidden: false, kept: '', leftover: '' });
    assert.equal(existsSync(work), false, 'the added account folder is gone');
    assert.equal(readFileSync(path.join(shared, 'chat.jsonl'), 'utf8'), 'kept', 'the shared conversations stay');
    assert.ok(existsSync(path.join(home, '.claude', '.credentials.json')), 'the default account is untouched');
    assert.equal(store.config().agentProfiles.claude, null, 'everyone is back on the main account');
    assert.equal(store.get('specialist', agent.id).profile, '');
    assert.equal(store.get('usage', `claude:${work}`), undefined);
    assert.deepEqual(store.get('accounts', 'limited').until, {});
    assert.deepEqual(readdirSync(path.join(home, '.config')).filter(name => name.startsWith('.rexdesk-removing')), [], 'nothing left aside');
  });
});

test('removing an account that is not in use leaves the choice alone and says false, not an empty string (L123)', async () => {
  await withDesk('acct-unused', async ({ desk }) => {
    const work = added(desk), result = desk.removeAccount('claude', work);
    assert.equal(result.switched, false);
    assert.equal(result.moved, 0);
    assert.equal(existsSync(work), false);
  });
});

test('a Claude account whose projects is a real folder keeps its conversations, checked, before the folder goes (L123)', async () => {
  await withDesk('acct-claudehist', async ({ desk, home, shared }) => {
    rmSync(shared, { recursive: true, force: true }); // no shared history: addProfile makes no link, Claude writes a real projects folder
    const work = added(desk);
    mkdirSync(path.join(work, 'projects', 'D--app'), { recursive: true }); writeFileSync(path.join(work, 'projects', 'D--app', 's1.jsonl'), 'my chat');
    const result = desk.removeAccount('claude', work);
    assert.equal(existsSync(work), false);
    assert.ok(result.kept.startsWith(path.join(home, '.config', 'rex-desk-kept-history')), result.kept);
    assert.equal(readFileSync(path.join(result.kept, 'projects', 'D--app', 's1.jsonl'), 'utf8'), 'my chat');
  });
});

test('a Codex account keeps its sessions and history when removed (L123)', async () => {
  await withDesk('acct-codexhist', async ({ desk }) => {
    const work = added(desk, 'work', 'codex');
    mkdirSync(path.join(work, 'sessions', '2026', '11'), { recursive: true }); writeFileSync(path.join(work, 'sessions', '2026', '11', 'rollout.jsonl'), 'codex chat');
    writeFileSync(path.join(work, 'history.jsonl'), 'typed');
    const result = desk.removeAccount('codex', work);
    assert.equal(existsSync(work), false);
    assert.equal(readFileSync(path.join(result.kept, 'sessions', '2026', '11', 'rollout.jsonl'), 'utf8'), 'codex chat');
    assert.equal(readFileSync(path.join(result.kept, 'history.jsonl'), 'utf8'), 'typed');
    assert.equal(existsSync(path.join(result.kept, 'auth.json')), false, 'never the sign-in');
  });
});

test('a history copy that does not check out deletes nothing and changes nothing (L123)', async () => {
  await withDesk('acct-badcopy', async ({ desk, store }) => {
    const work = added(desk, 'work', 'codex');
    mkdirSync(path.join(work, 'sessions'), { recursive: true }); writeFileSync(path.join(work, 'sessions', 'a.jsonl'), 'codex chat');
    pin(store, 'codex', work);
    desk.agents.files.cp = (from, to) => mkdirSync(to, { recursive: true }); // copies the folder but none of its files
    assert.throws(() => desk.removeAccount('codex', work), /could not keep a copy of this account's conversations, so nothing was deleted/);
    assert.equal(readFileSync(path.join(work, 'sessions', 'a.jsonl'), 'utf8'), 'codex chat');
    assert.equal(store.config().agentProfiles.codex, work, 'still the account in use');
  });
});

test('a folder that cannot be moved aside changes nothing: pins, usage and the folder all stay (L123)', async () => {
  await withDesk('acct-locked', async ({ desk, store }) => {
    const work = added(desk);
    pin(store, 'claude', work);
    const agent = desk.specialists.create({ name: 'Writer', purpose: 'Writes.' });
    store.put('specialist', agent.id, { ...store.get('specialist', agent.id), profile: work });
    store.put('usage', `claude:${work}`, { id: `claude:${work}`, provider: 'claude', profile: work, windows: {} });
    assert.throws(() => desk.removeAccount('claude', work), /in use or locked, so nothing was deleted/);
    assert.ok(existsSync(path.join(work, '.credentials.json')));
    assert.equal(store.config().agentProfiles.claude, work);
    assert.equal(store.get('specialist', agent.id).profile, work);
    assert.ok(store.get('usage', `claude:${work}`));
  }, { rename: () => { const error = new Error('busy'); error.code = 'EBUSY'; throw error; } });
});

test('a delete that fails halfway says which files are left, and the account is already off its folder (L123)', async () => {
  await withDesk('acct-half', async ({ desk, store, shared }) => {
    const work = added(desk);
    pin(store, 'claude', work);
    const result = desk.removeAccount('claude', work);
    assert.equal(result.removed, true);
    assert.ok(result.leftover && existsSync(result.leftover), 'the leftover folder is named');
    assert.equal(existsSync(path.join(result.leftover, '.credentials.json')), false, 'part of it went');
    assert.equal(existsSync(work), false, 'nothing is left at the account\'s own path, so no agent picks up half an account');
    assert.equal(store.config().agentProfiles.claude, null);
    assert.equal(readFileSync(path.join(shared, 'chat.jsonl'), 'utf8'), 'kept', 'the history link was taken away before the delete');
    rmSync(result.leftover, { recursive: true, force: true });
  }, { rm: folder => { rmSync(path.join(folder, '.credentials.json')); throw new Error('EPERM'); } });
});

test('an account an agent is working on right now is not removed (L123)', async () => {
  await withDesk('acct-running', async ({ desk, store }) => {
    const work = added(desk);
    pin(store, 'claude', work);
    store.put('run', 'busy-run', { id: 'busy-run', state: 'running', provider: 'claude', role: 'coordinator', turnAccount: work, createdAt: new Date().toISOString() });
    assert.throws(() => desk.removeAccount('claude', work), /working on this account right now\. Wait until it finishes, or stop it/);
    assert.ok(existsSync(path.join(work, '.credentials.json')));
    assert.equal(store.config().agentProfiles.claude, work);
    // An agent on the account everyone uses, whose turn has not recorded its account yet, counts too.
    store.put('run', 'busy-run', { ...store.get('run', 'busy-run'), state: 'queued', turnAccount: '' });
    assert.throws(() => desk.removeAccount('claude', work), /working on this account right now/);
    store.put('run', 'busy-run', { ...store.get('run', 'busy-run'), state: 'finished' });
    assert.equal(desk.removeAccount('claude', work).removed, true);
  });
});

test('sign out runs each CLI\'s own sign-out and is reported only when the CLI confirms it (L123)', async () => {
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
  // Sign-out and status both failing, or either one alone, is never "Signed out".
  const both = new AgentProfiles({ config: () => ({}) }, { run: async () => ({ code: 1, stdout: '', stderr: 'network error' }), found: () => true });
  await assert.rejects(both.signOut('claude', work), /could not confirm the sign-out/);
  await assert.rejects(both.signOut('codex', work), /could not confirm the sign-out/);
  const thrown = new AgentProfiles({ config: () => ({}) }, { run: async () => { throw new Error('spawn failed'); }, found: () => true });
  await assert.rejects(thrown.signOut('claude', work), /could not confirm the sign-out/);
  const statusFails = new AgentProfiles({ config: () => ({}) }, { run: async (command, args) => (args.includes('logout') ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'timed out' }), found: () => true });
  await assert.rejects(statusFails.signOut('claude', work), /could not confirm the sign-out/);
  const logoutFails = new AgentProfiles({ config: () => ({}) }, { run: async (command, args) => (args.includes('logout') ? { code: 1, stdout: '', stderr: 'denied' } : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }), found: () => true });
  await assert.rejects(logoutFails.signOut('claude', work), /could not confirm the sign-out/);
});

test('Gemini shows a plain note instead of adding a second account, and the rows have Sign out and Remove (L123)', () => {
  const agents = new AgentProfiles({ config: () => ({}) }, { roots: { home: temporary('acct-gem') } });
  assert.throws(() => agents.addProfile('gemini', 'work'), /one Google account signed in on a computer/);
  const chat = read('chat.js');
  assert.match(chat, /name === 'gemini' \? `<p class="acct-one muted">\$\{t`Antigravity keeps one Google account signed in on a computer\./);
  assert.match(chat, /data-acct-signout="\$\{esc\(item\.profile\)\}"/);
  assert.match(chat, /item\.removable \? `<button type="button" class="or-link bad" data-acct-remove="\$\{esc\(item\.profile\)\}" data-acct-mode=/);
  assert.match(chat, /api\('\/agents\/remove'/);
  assert.match(chat, /done\.hidden \? t\('Account taken off the list\. Its folder stays on this computer\.'\)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentProfiles } from '../src/agents.js';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const stub = () => ({ async start() {}, async interrupt() {} });

// A home folder with the default ~/.claude, a shared history folder, and an added Claude account the way Rex Desk adds one:
// signed in, "projects" a junction to the shared history, plus the person's own commands and skills.
function fakeHome() {
  const home = temporary('acct-home');
  mkdirSync(path.join(home, '.claude'), { recursive: true }); writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  const shared = path.join(home, '.config', 'claude-code-shared-history'); mkdirSync(shared, { recursive: true }); writeFileSync(path.join(shared, 'chat.jsonl'), 'kept');
  const work = path.join(home, '.config', 'claude-work');
  mkdirSync(path.join(work, 'commands'), { recursive: true }); mkdirSync(path.join(work, 'skills', 'mine'), { recursive: true });
  writeFileSync(path.join(work, '.credentials.json'), '{"signed":"in"}'); writeFileSync(path.join(work, 'commands', 'ship.md'), 'my command'); writeFileSync(path.join(work, 'skills', 'mine', 'SKILL.md'), 'my skill');
  symlinkSync(shared, path.join(work, 'projects'), 'junction');
  return { home, shared, work };
}
// Everything under a folder (names, sizes, change times, link targets), without following links.
function snapshot(folder) {
  const out = [], walk = at => { for (const name of readdirSync(at).sort()) { const full = path.join(at, name), stat = lstatSync(full); out.push(`${path.relative(folder, full)}|${stat.isSymbolicLink() ? `link>${readlinkSync(full)}` : stat.isDirectory() ? 'dir' : `${stat.size}|${stat.mtimeMs}|${readFileSync(full, 'utf8')}`}`); if (stat.isDirectory() && !stat.isSymbolicLink()) walk(full); } };
  walk(folder); return out;
}
async function withDesk(label, body) {
  const { home, shared, work } = fakeHome(), store = new Store(temporary(`${label}-store`));
  const desk = new Desk(store, { root: temporary(`${label}-root`), runnerFactory: stub });
  desk.agents.roots = { home };
  try { await body({ desk, store, home, shared, work }); } finally { await desk.shutdown(); store.close(); }
}
const pin = (store, provider, profile) => store.saveConfig({ ...store.publicConfig(), agentProfiles: { ...store.config().agentProfiles, [provider]: profile } });
const listed = (agents, provider, profile) => agents.profiles(provider).some(item => item.profile && path.resolve(item.profile) === path.resolve(profile));

test('only an added account can be removed, never the default folder or the shared history (L123)', async () => {
  await withDesk('acct-shape', async ({ desk, home, shared, work }) => {
    const agents = desk.agents;
    assert.equal(agents.removable('claude', work), true);
    assert.equal(agents.removable('claude', ''), false, 'the default account');
    assert.equal(agents.removable('claude', path.join(home, '.claude')), false);
    assert.equal(agents.removable('claude', shared), false);
    assert.equal(agents.removable('claude', path.join(work, 'commands')), false, 'nothing deeper than .config/<provider>-<name>');
    assert.equal(agents.removable('codex', work), false, 'another AI\'s folder');
    assert.equal(agents.removable('gemini', path.join(home, '.config', 'gemini-work')), false);
    assert.throws(() => desk.removeAccount('claude', ''), /main account stays/);
    assert.throws(() => desk.removeAccount('claude', path.join(home, '.claude')), /main account stays/);
  });
});

test('Remove touches no file: the folder, its junction, commands, skills and sign-in, and the shared history all stay as they were (L123)', async () => {
  await withDesk('acct-nofile', async ({ desk, store, home, work }) => {
    const codex = path.join(home, '.config', 'codex-team'); mkdirSync(path.join(codex, 'skills', 'review'), { recursive: true }); mkdirSync(path.join(codex, 'sessions'), { recursive: true });
    writeFileSync(path.join(codex, 'auth.json'), '{}'); writeFileSync(path.join(codex, 'skills', 'review', 'SKILL.md'), 'codex skill'); writeFileSync(path.join(codex, 'sessions', 'a.jsonl'), 'codex chat');
    const before = snapshot(home);
    pin(store, 'claude', work);
    const agent = desk.specialists.create({ name: 'Writer', purpose: 'Writes.' });
    store.put('specialist', agent.id, { ...store.get('specialist', agent.id), profile: work });
    store.put('usage', `claude:${work}`, { id: `claude:${work}`, provider: 'claude', profile: work, windows: {} });
    desk.agents.markLimited(work);
    const result = desk.removeAccount('claude', work);
    assert.deepEqual(result, { removed: true, switched: true, moved: 1, folder: path.resolve(work) });
    assert.equal(desk.removeAccount('codex', codex).switched, false, 'a real false');
    assert.deepEqual(snapshot(home), before, 'not one file, folder or link changed');
    assert.equal(store.config().agentProfiles.claude, '', 'everyone is back on the main account, chosen outright');
    assert.equal(store.get('specialist', agent.id).profile, '');
    assert.equal(store.get('usage', `claude:${work}`), undefined);
    assert.deepEqual(store.get('accounts', 'limited').until, {});
    assert.equal(listed(desk.agents, 'claude', work), false, 'off the list');
    assert.equal(listed(desk.agents, 'codex', codex), false);
  });
});

test('a removed account stays off the list after a restart (L123)', async () => {
  await withDesk('acct-restart', async ({ desk, store, home, work }) => {
    desk.removeAccount('claude', work);
    const again = new AgentProfiles(store, { roots: { home } });
    assert.equal(listed(again, 'claude', work), false);
    assert.equal(again.hidden('claude', work), true);
  });
});

test('a failure while saving leaves the desk exactly as it was (L123)', async () => {
  await withDesk('acct-rollback', async ({ desk, store, work }) => {
    pin(store, 'claude', work);
    const agent = desk.specialists.create({ name: 'Writer', purpose: 'Writes.' });
    store.put('specialist', agent.id, { ...store.get('specialist', agent.id), profile: work });
    store.put('run', 'old-run', { id: 'old-run', state: 'finished', provider: 'claude', role: 'coordinator', turnAccount: work, createdAt: new Date().toISOString() });
    store.put('usage', `claude:${work}`, { id: `claude:${work}`, provider: 'claude', profile: work, windows: {} });
    desk.agents.markLimited(work);
    const put = store.put.bind(store);
    store.put = (kind, key, value) => { if (kind === 'accounts' && key === 'hidden') throw new Error('disk full'); return put(kind, key, value); };
    assert.throws(() => desk.removeAccount('claude', work), /disk full/);
    store.put = put;
    assert.equal(store.config().agentProfiles.claude, work, 'still the account in use');
    assert.equal(store.get('specialist', agent.id).profile, work);
    assert.equal(store.get('run', 'old-run').turnAccount, work);
    assert.ok(store.get('usage', `claude:${work}`));
    assert.ok(Object.keys(store.get('accounts', 'limited').until).length, 'the limit mark stays');
    assert.equal(desk.agents.hidden('claude', work), false);
    assert.equal(listed(desk.agents, 'claude', work), true);
  });
});

test('adding a removed account\'s name again brings it back and says so, instead of a dead end (L123)', async () => {
  await withDesk('acct-readd', async ({ desk, work }) => {
    desk.removeAccount('claude', work);
    const back = desk.agents.addProfile('claude', 'work');
    assert.equal(back.restored, true);
    assert.equal(path.resolve(back.profile), path.resolve(work));
    assert.equal(desk.agents.hidden('claude', work), false);
    assert.equal(listed(desk.agents, 'claude', work), true);
    assert.equal(readFileSync(path.join(work, '.credentials.json'), 'utf8'), '{"signed":"in"}', 'its sign-in is the earlier one');
    assert.throws(() => desk.agents.addProfile('claude', 'work'), /already a profile called work/, 'a listed one still says it exists');
  });
});

test('removing the account Rex Desk was launched with does not fall back to it (L123)', async () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  try {
    await withDesk('acct-launch', async ({ desk, store, work }) => {
      process.env.CLAUDE_CONFIG_DIR = work; // started with this account, nothing saved
      assert.equal(path.resolve(desk.agents.selected('claude')), path.resolve(work));
      assert.equal(desk.removeAccount('claude', work).switched, true);
      assert.equal(store.config().agentProfiles.claude, '');
      assert.equal(desk.agents.selected('claude'), '', 'the main account, not the launch one');
      assert.equal(desk.agents.use('claude', ''), '');
    });
  } finally { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; }
});

test('a removed account whose folder the person deleted can be added again as a new, listed account (L123)', async () => {
  await withDesk('acct-gone', async ({ desk, work }) => {
    desk.removeAccount('claude', work);
    rmSync(work, { recursive: true, force: true });
    const made = desk.agents.addProfile('claude', 'work');
    assert.equal(made.restored, undefined, 'a new account, not a restored one');
    assert.equal(desk.agents.hidden('claude', work), false);
    assert.equal(listed(desk.agents, 'claude', work), true);
  });
});

test('an account an agent is working on, or a queued turn will use, is not removed (L123)', async () => {
  await withDesk('acct-running', async ({ desk, store, work }) => {
    pin(store, 'claude', work);
    store.put('run', 'busy-run', { id: 'busy-run', state: 'running', provider: 'claude', role: 'coordinator', turnAccount: work, createdAt: new Date().toISOString() });
    assert.throws(() => desk.removeAccount('claude', work), /working on this account right now\. Wait until it finishes, or stop it/);
    store.put('run', 'busy-run', { ...store.get('run', 'busy-run'), state: 'queued', turnAccount: '' });
    assert.throws(() => desk.removeAccount('claude', work), /working on this account right now/, 'a queued turn on the account everyone uses');
    assert.equal(store.config().agentProfiles.claude, work);
    assert.equal(desk.agents.hidden('claude', work), false);
    store.put('run', 'busy-run', { ...store.get('run', 'busy-run'), state: 'finished' });
    assert.equal(desk.removeAccount('claude', work).removed, true);
  });
});

test('sign out is reported only when the CLI\'s sign-out worked and its status says signed out outright (L123)', async () => {
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
  const fake = respond => new AgentProfiles({ config: () => ({}) }, { run: async (command, args) => respond(args), found: () => true });
  const logoutOk = { code: 0, stdout: '', stderr: '' };
  await assert.rejects(fake(args => ({ code: 0, stdout: args.includes('--json') ? JSON.stringify({ loggedIn: true }) : '', stderr: '' })).signOut('claude', work), /did not sign out/);
  // Sign-out and status both failing, or either alone, is never "Signed out".
  await assert.rejects(fake(() => ({ code: 1, stdout: '', stderr: 'network error' })).signOut('claude', work), /could not confirm the sign-out/);
  await assert.rejects(fake(() => ({ code: 1, stdout: '', stderr: 'network error' })).signOut('codex', work), /could not confirm the sign-out/);
  await assert.rejects(fake(() => { throw new Error('spawn failed'); }).signOut('claude', work), /could not confirm the sign-out/);
  await assert.rejects(fake(args => (args.includes('logout') ? logoutOk : { code: 1, stdout: '', stderr: 'timed out' })).signOut('claude', work), /could not confirm the sign-out/);
  await assert.rejects(fake(args => (args.includes('logout') ? { code: 1, stdout: '', stderr: 'denied' } : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: '' })).signOut('claude', work), /could not confirm the sign-out/);
  // A status with no loggedIn field, or not a boolean, proves nothing.
  await assert.rejects(fake(args => (args.includes('logout') ? logoutOk : { code: 0, stdout: JSON.stringify({ authMethod: 'none' }), stderr: '' })).signOut('claude', work), /could not confirm the sign-out/);
  await assert.rejects(fake(args => (args.includes('logout') ? logoutOk : { code: 0, stdout: JSON.stringify({ loggedIn: 'false' }), stderr: '' })).signOut('claude', work), /could not confirm the sign-out/);
  // Codex: an error that only mentions "not logged in" is not a signed-out status.
  await assert.rejects(fake(args => (args.includes('logout') ? logoutOk : { code: 1, stdout: '', stderr: 'Error: could not read auth.json, treating as not logged in' })).signOut('codex', work), /could not confirm the sign-out/);
});

test('Gemini shows a plain note instead of adding a second account, and the rows say Remove only takes it off Rex Desk (L123)', () => {
  const agents = new AgentProfiles({ config: () => ({}) }, { roots: { home: temporary('acct-gem') } });
  assert.throws(() => agents.addProfile('gemini', 'work'), /one Google account signed in on a computer/);
  const chat = read('chat.js');
  assert.match(chat, /name === 'gemini' \? `<p class="acct-one muted">\$\{t`Antigravity keeps one Google account signed in on a computer\./);
  assert.match(chat, /data-acct-signout="\$\{esc\(item\.profile\)\}"/);
  assert.match(chat, /item\.removable \? `<button type="button" class="or-link bad" data-acct-remove="\$\{esc\(item\.profile\)\}">/);
  assert.match(chat, /Nothing on this computer is deleted: its folder, with its chats and sign-in, stays at \$\{profile\}\./);
  assert.match(chat, /signed \? t`To sign it out, press Sign out first\.`/);
  assert.match(chat, /Removed from Rex Desk only\. Nothing was deleted: its folder, with its chats and sign-in, stays at \$\{done\.folder \|\| profile\}\. To sign out now, add this account again, then choose Sign out\./);
  assert.match(chat, /Its earlier folder was found at \$\{started\.profile\}, so it is back\./);
  assert.doesNotMatch(chat, /sign-in were found/, 'no claim about a sign-in nobody checked');
  assert.match(chat, /started\?\.restored/);
});

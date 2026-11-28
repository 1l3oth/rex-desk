import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { AgentProfiles, canonical } from '../src/agents.js';
import { signInDone } from '../public/chat-card.js';

// Test data on D: next to the project (never C:), one folder per test.
const base = path.resolve(process.env.REX_TEST_TMP || path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'accounts-test'));
mkdirSync(base, { recursive: true });
delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;

// A home with ~/.claude (the main account), ~/.config/claude-<name> folders added in Rex Desk, and Orca copies. who maps a
// folder to the account its fake "claude auth status" reports ('' = never signed in).
function setup(accounts, { orca = {}, selected } = {}) {
  const root = mkdtempSync(path.join(base, 'home-')), home = path.join(root, 'home'), appData = path.join(root, 'appdata');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const who = new Map([[canonical(path.join(home, '.claude')), accounts.main]]);
  for (const [name, email] of Object.entries(accounts)) if (name !== 'main') { const folder = path.join(home, '.config', `claude-${name}`); mkdirSync(folder, { recursive: true }); who.set(canonical(folder), email); }
  for (const [id, email] of Object.entries(orca)) { const folder = path.join(appData, 'orca', 'claude-profiles', id, 'home'); mkdirSync(folder, { recursive: true }); who.set(canonical(folder), email); }
  const broken = new Set();
  const calls = [];
  const run = async (command, args, env) => {
    calls.push(args.join(' '));
    const folder = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), email = who.get(canonical(folder)) || '';
    if (broken.has(canonical(folder))) return { code: 1, stdout: '', stderr: 'status failed' };
    return { code: 0, stdout: JSON.stringify(email ? { loggedIn: true, authMethod: 'claude.ai', email, orgName: `${email}'s Organization`, subscriptionType: 'max' } : { loggedIn: false }), stderr: '' };
  };
  const records = new Map(), store = { get: (k, id) => records.get(`${k}/${id}`), put: (k, id, v) => records.set(`${k}/${id}`, v), config: () => (selected === undefined ? {} : { agentProfiles: { claude: selected(home, appData) } }) };
  const agents = new AgentProfiles(store, { run, roots: { home, appData } });
  return { agents, home, appData, broken, who, calls, folder: name => path.join(home, '.config', `claude-${name}`) };
}
const rows = async agents => (await agents.overview({ refresh: true })).claude.profiles;
const find = (list, folder) => list.find(item => item.profile && canonical(item.profile) === canonical(folder));

test('an added account that was never signed in shows, with Sign in, and is not marked as the same account', async () => {
  const { agents, folder } = setup({ main: 'me@example.com', 'info-vbuildcc-gmail-com': '' });
  const row = find(await rows(agents), folder('info-vbuildcc-gmail-com'));
  assert.ok(row, 'the new account has a row');
  assert.equal(row.loggedIn, false); assert.equal(row.sameAs, null); assert.equal(row.removable, true);
});

test('an added folder signed in to the same account as the main one still shows, says which row it matches, and can be removed', async () => {
  const { agents, home, folder } = setup({ main: 'me@example.com', 'info-vbuildcc-gmail-com': 'me@example.com' });
  const list = await rows(agents), row = find(list, folder('info-vbuildcc-gmail-com'));
  assert.ok(row, 'not hidden any more');
  assert.deepEqual([row.sameAs.profile, row.sameAs.account], ['', 'me@example.com'], 'the same account as the main one');
  assert.equal(list.filter(item => item.account === 'me@example.com' && !item.sameAs).length, 1, 'one row is the account, the other says it is the same');
  assert.equal(row.removable, true);
  assert.throws(() => agents.addProfile('claude', 'info-vbuildcc-gmail-com'), /already an account called info-vbuildcc-gmail-com\. It is in the list/);
});

test('an added folder signed in to a different account shows as its own account', async () => {
  const { agents, folder } = setup({ main: 'me@example.com', work: 'info@vbuild.cc' });
  const row = find(await rows(agents), folder('work'));
  assert.equal(row.account, 'info@vbuild.cc'); assert.equal(row.sameAs, null);
});

test('an Orca copy of an account already listed is still merged into one row', async () => {
  const { agents, appData } = setup({ main: 'me@example.com' }, { orca: { '6090b7ff-a': 'me@example.com', '7777aaaa-b': 'other@example.com' } });
  const list = await rows(agents);
  assert.equal(find(list, path.join(appData, 'orca', 'claude-profiles', '6090b7ff-a', 'home')), undefined, 'the Orca copy of the main account is merged');
  assert.ok(find(list, path.join(appData, 'orca', 'claude-profiles', '7777aaaa-b', 'home')), 'an Orca account seen nowhere else shows');
  assert.equal(list.filter(item => item.sameAs).length, 0);
});

test('the automatic switch skips a folder that is the same account as the one out of its limit', async () => {
  const { agents, folder } = setup({ main: 'me@example.com', copy: 'me@example.com', work: 'info@vbuild.cc' });
  const next = await agents.alternative('claude', '');
  assert.equal(canonical(next.profile), canonical(folder('work')));
  assert.equal(next.account, 'info@vbuild.cc');
  const only = setup({ main: 'me@example.com', copy: 'me@example.com' });
  assert.equal(await only.agents.alternative('claude', ''), null, 'no other account: no switch to a copy that shares the limit');
});

test('a taken name always has a row or a plain reason: a link or file at that path, and the shared history name', async () => {
  const { agents, folder, home } = setup({ main: 'me@example.com' });
  mkdirSync(path.join(home, '.config'), { recursive: true }); writeFileSync(folder('notes'), 'a plain file');
  assert.throws(() => agents.addProfile('claude', 'notes'), /taken by a file or link that is not an account/);
  const target = path.join(home, 'elsewhere'); mkdirSync(target);
  symlinkSync(target, folder('linked'), 'junction');
  assert.throws(() => agents.addProfile('claude', 'linked'), /taken by a file or link that is not an account/);
  assert.throws(() => agents.addProfile('claude', 'code-shared-history'), /kept for the shared conversation history/);
  assert.throws(() => agents.addProfile('claude', 'my shared-history'), /kept for the shared conversation history/);
});

const orcaHome = (appData, id) => path.join(appData, 'orca', 'claude-profiles', id, 'home');
const inUse = (list, selected) => list.filter(item => canonical(item.profile || '.') === canonical(selected || '.') && item.loggedIn && !item.sameAs);

test('a selected added copy of the main account is the row In use, and the main one says it is the same account', async () => {
  const { agents, folder } = setup({ main: 'me@example.com', copy: 'me@example.com' }, { selected: home => path.join(home, '.config', 'claude-copy') });
  const list = await rows(agents), copy = find(list, folder('copy')), main = list.find(item => item.profile === '');
  assert.equal(copy.sameAs, null, 'the account in use is never the duplicate');
  assert.equal(inUse(list, folder('copy')).length, 1);
  assert.equal(canonical(main.sameAs.profile), canonical(folder('copy')));
});

test('an Orca copy in use stays a normal row, keeps Remove when it has it, and the matching added folder is the duplicate', async () => {
  const { agents, appData, folder } = setup({ main: 'other@example.com', copy: 'me@example.com' }, { orca: { 'aaaa1111-x': 'me@example.com' }, selected: (home, appData) => orcaHome(appData, 'aaaa1111-x') });
  const list = await rows(agents), orca = find(list, orcaHome(appData, 'aaaa1111-x'));
  assert.ok(orca, 'the Orca copy in use shows'); assert.equal(orca.sameAs, null, 'not told it is a mistaken duplicate');
  assert.equal(orca.removable, agents.removable('claude', orca.profile));
  assert.equal(canonical(find(list, folder('copy')).sameAs.profile), canonical(orca.profile));
});

test('the launch account in use is never the duplicate of an added folder listed before it', async () => {
  const { agents, home, folder } = setup({ main: 'other@example.com', work: 'me@example.com', launch: 'me@example.com' });
  const launch = folder('launch'), old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = launch;
  try {
    const list = await rows(agents), row = find(list, launch);
    assert.equal(row.sameAs, null); assert.equal(inUse(list, launch).length, 1);
    assert.equal(canonical(find(list, folder('work')).sameAs.profile), canonical(launch));
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; }
});

test('the automatic switch never moves back to a copy of an account still marked limited', async () => {
  const { agents, folder } = setup({ main: 'me@example.com', copy: 'me@example.com', work: 'info@vbuild.cc' });
  await rows(agents);
  agents.markLimited('');
  const first = await agents.alternative('claude', '');
  assert.equal(canonical(first.profile), canonical(folder('work')));
  agents.markLimited(first.profile);
  assert.equal(await agents.alternative('claude', first.profile), null, 'the copy of the main account shares its limit');
});

test('the automatic switch remembers which account a folder was on when its status cannot be read', async () => {
  const { agents, broken, home } = setup({ main: 'me@example.com', copy: 'me@example.com' });
  await rows(agents);
  agents.invalidate?.('claude'); agents.cache.clear(); broken.add(canonical(path.join(home, '.claude')));
  assert.equal(await agents.alternative('claude', ''), null, 'the copy is the same account the main one was last seen on');
});

test('Sign in again on a duplicate row only starts a hidden sign-in: nothing signs the folder out, and the page never calls sign-out', async () => {
  const spawned = [];
  const { agents, folder, calls } = setup({ main: 'me@example.com', copy: 'me@example.com' });
  agents.spawnHidden = (command, args) => { spawned.push([command, ...args].join(' ')); return { on() {}, stdout: { on() {} }, stderr: { on() {} }, kill() {} }; };
  await rows(agents);
  const started = agents.login('claude', folder('copy'), { background: true });
  assert.equal(started.background, true);
  const script = spawned.map(line => { const coded = line.split(' ').pop(); try { return Buffer.from(coded, 'base64').toString('utf16le'); } catch { return line; } }).join(' ') + spawned.join(' ');
  assert.ok(!/logout/i.test(script), 'the sign-in never runs logout');
  assert.ok(!calls.some(line => /logout/.test(line)), 'no logout through the status runner either');
  assert.deepEqual(agents.cancelLogin('claude'), { stopped: true });
  const page = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
  const flow = page.slice(page.indexOf("const login = event.target.closest('[data-acct-login]')"), page.indexOf("back.addEventListener('keydown'"));
  assert.ok(flow.length > 500 && !flow.includes('/agents/signout'), 'the Sign in again flow never calls sign-out');
});

test('a sign-in is done only when it really finished: hidden job finished, newly signed in, or another account', () => {
  assert.equal(signInDone({ hidden: true, job: { state: 'signing-in' }, now: { loggedIn: true, account: 'me@example.com' }, wasIn: true, was: 'me@example.com' }), false, 'never same account before the person finished');
  assert.equal(signInDone({ hidden: true, job: { state: 'finished' }, now: { loggedIn: true, account: 'me@example.com' }, wasIn: true, was: 'me@example.com' }), true);
  assert.equal(signInDone({ hidden: true, job: { state: 'failed' } }), false, 'a cancelled sign-in is no success');
  assert.equal(signInDone({ now: { loggedIn: true, account: '' }, wasIn: false, was: '' }), true, 'Codex and Antigravity: signed out to signed in is enough');
  assert.equal(signInDone({ now: { loggedIn: true, account: '' }, wasIn: true, was: '' }), false);
  assert.equal(signInDone({ now: { loggedIn: true, account: 'b@example.com' }, wasIn: true, was: 'a@example.com' }), true);
  assert.equal(signInDone({ now: { loggedIn: false }, wasIn: false }), false);
});

test('a signed-out account never blocks a copy that works: only a status that cannot be read uses the remembered account', async () => {
  const { agents, who, home, folder } = setup({ main: 'me@example.com', copy: 'me@example.com' });
  await rows(agents);
  who.set(canonical(path.join(home, '.claude')), ''); agents.cache.clear();
  const next = await agents.alternative('claude', '');
  assert.equal(canonical(next.profile), canonical(folder('copy')), 'the main one says signed out, so its working copy is a replacement');
});

test('a limit keeps out the account it was hit on, even after that folder moves to another account', async () => {
  const { agents, who, folder } = setup({ main: 'm@example.com', x: 'a@example.com', copya: 'a@example.com' });
  await rows(agents);
  agents.markLimited(folder('x')); agents.markLimited('');
  who.set(canonical(folder('x')), 'b@example.com'); agents.cache.clear();
  assert.equal(await agents.alternative('claude', ''), null, 'the copy of A is still kept out');
});

test('a limit hit on another account does not keep out the account the folder moved to', async () => {
  const { agents, who, folder } = setup({ main: 'm@example.com', x: 'c@example.com', other: 'b@example.com' });
  await rows(agents);
  agents.markLimited(folder('x'));
  who.set(canonical(folder('x')), 'b@example.com'); agents.cache.clear();
  const next = await agents.alternative('claude', '');
  assert.equal(canonical(next.profile), canonical(folder('other')));
});

test('an old saved limit without its account does not break the switch', async () => {
  const { agents, folder } = setup({ main: 'm@example.com', x: 'a@example.com', work: 'b@example.com' });
  agents.store.put('accounts', 'limited', { id: 'limited', until: { [canonical(folder('x'))]: Date.now() + 3600000 } });
  const next = await agents.alternative('claude', '');
  assert.ok(next && canonical(next.profile) !== canonical(folder('x')));
});

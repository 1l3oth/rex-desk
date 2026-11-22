import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, shared } from '../src/store.js';
import { Desk, HANDOFF_HEADINGS } from '../src/coordinator.js';
import { execFileSync } from 'node:child_process';
import { looksSecret } from '../src/agent-notes.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup() {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop', description: 'Online shop' }));
  const store = new Store(temporary('notes')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  desk.memory.scan({ roots: [projects] });
  const agent = desk.specialists.create({ name: 'Desky', projectSlug: 'shop', purpose: 'Looks after the shop.', rules: 'Ask before schema changes.' });
  return { store, desk, agent };
}

test('a soul starts from the agent card, and memory is the agent\'s own notebook: add, replace a section, rewrite', () => {
  const { desk, agent } = setup(), notes = desk.notes;
  const soul = notes.text(agent.id, 'soul');
  assert.match(soul, /# Desky/); assert.match(soul, /Looks after the shop\./); assert.match(soul, /Ask before schema changes\./);
  assert.equal(notes.text(agent.id, 'memory'), '');
  notes.writeMemory(agent.id, { action: 'add', text: 'Rex wants release branches, not task branches.' }, 'Desky');
  notes.writeMemory(agent.id, { action: 'replace', section: 'Open work', text: '- L49 soul and memory' }, 'Desky');
  notes.writeMemory(agent.id, { action: 'replace', section: 'Open work', text: '- L49 done, waiting for Rex' }, 'Desky');
  const memory = notes.text(agent.id, 'memory');
  assert.match(memory, /^- Rex wants release branches/); assert.match(memory, /## Open work\n- L49 done, waiting for Rex/); assert.doesNotMatch(memory, /L49 soul and memory/);
  notes.writeMemory(agent.id, { action: 'rewrite', text: '## Short\n- tidy' }, 'Desky');
  assert.equal(notes.text(agent.id, 'memory'), '## Short\n- tidy');
  assert.equal(notes.history(agent.id, 'memory').length, 3, 'every change keeps the old text');
  assert.ok(notes.summary(agent.id).memoryAt, 'last written is known');
});

test('memory is capped at 8 KB and refuses anything that looks like a key, token or password', () => {
  const { desk, agent } = setup(), notes = desk.notes;
  assert.throws(() => notes.writeMemory(agent.id, { action: 'rewrite', text: 'x'.repeat(8 * 1024 + 1) }), /limit is 8 KB\. Tidy first/);
  for (const secret of ['key: sk_live_51Habcdefghijklmnop', 'password = hunter2hunter2', 'ghp_abcdefghijklmnopqrstuvwxyz0123', '-----BEGIN RSA PRIVATE KEY-----'])
    assert.throws(() => notes.writeMemory(agent.id, { action: 'add', text: secret }), /looks like a key, token or password/, secret);
  assert.equal(looksSecret('The Stripe key is in rex-desk-api/.env.stripe'), false, 'saying where a key lives is fine');
  assert.throws(() => notes.propose(agent.id, '# Desky\nAPI_KEY=abcdef123456', 'x'), /looks like a key/);
});

test('an agent only proposes a new soul: it waits for the person, who accepts or declines; history can be put back', () => {
  const { desk, agent } = setup(), notes = desk.notes, before = notes.text(agent.id, 'soul');
  notes.propose(agent.id, `${before}\n\n## How I work\n- Small commits.`, 'Rex asked for small commits', 'Desky');
  assert.equal(notes.text(agent.id, 'soul'), before, 'not changed until the person says yes');
  assert.equal(notes.summary(agent.id).soulPending, true);
  notes.decide(agent.id, false);
  assert.equal(notes.text(agent.id, 'soul'), before); assert.equal(notes.summary(agent.id).soulPending, false);
  notes.propose(agent.id, `${before}\n\n## How I work\n- Small commits.`, 'again', 'Desky');
  notes.decide(agent.id, true);
  assert.match(notes.text(agent.id, 'soul'), /Small commits/);
  const old = notes.history(agent.id, 'soul')[0];
  notes.restore(agent.id, 'soul', old.id);
  assert.equal(notes.text(agent.id, 'soul'), before, 'an earlier version comes back');
});

test('soul and memory sync like agent cards, Rex Agent\'s stay on this computer, and deleting an agent deletes them', () => {
  const { store, desk, agent } = setup(), notes = desk.notes;
  notes.writeMemory(agent.id, { action: 'add', text: 'a note' }, 'Desky');
  assert.equal(shared('agentnote', `${agent.id}:memory`), true);
  assert.equal(shared('agentnote', 'main:memory'), false);
  const mine = notes.writeMemory('main', { action: 'add', text: 'only here' }, 'Rex Agent');
  assert.equal(store.isPrivate('agentnote', mine), true, 'never goes to the cloud');
  assert.equal(store.isPrivate('agentnote', store.get('agentnote', `${agent.id}:memory`)), false);
  notes.writeMemory(agent.id, { action: 'add', text: 'another' }, 'Desky');
  desk.specialists.remove(agent.id);
  assert.equal(store.list('agentnote').filter(item => item.agentId === agent.id).length, 0);
  assert.equal(store.list('agentnotehist').filter(item => item.agentId === agent.id).length, 0);
});

test('the agent reads its soul and memory every session, and a fresh start keeps the gist in memory', async () => {
  const { store, desk, agent } = setup(), notes = desk.notes;
  notes.writeMemory(agent.id, { action: 'add', text: 'Rex likes short answers.' }, 'Desky');
  const identity = desk.specialists.identity(store.get('specialist', agent.id));
  assert.match(identity, /Your soul \(who you are/); assert.match(identity, /Rex likes short answers\./);
  assert.match(identity, /after a decision, a correction from the person, a finding worth keeping, or a finished task/);
  store.put('run', 'chat', { id: 'chat', role: 'specialist', specialistId: agent.id, state: 'finished', createdAt: new Date().toISOString() });
  store.event('chat', 'human-message', { text: 'Build the soul and memory feature' }, true);
  store.event('chat', 'agent-text', { text: 'On it.' }, true);
  desk.resume = async () => {};
  await desk.freshStart('chat', { note: 'Building L49; tests next.' });
  const memory = notes.text(agent.id, 'memory');
  assert.match(memory, /## Before the last fresh start/); assert.match(memory, /My full handoff: .+\.md \(read it first\)/); assert.match(memory, /Asked: Build the soul and memory feature/);
});

test('a handoff keeps the fixed headings, the whole note and the git facts, and memory points to the file', async () => {
  const { store, desk, agent } = setup(), notes = desk.notes, repo = temporary('repo');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'release/9.9.9'); writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-q', '-m', 'feat(a): #L1, first, Desky');
  writeFileSync(path.join(repo, 'b.txt'), '2');
  store.put('run', 'chat', { id: 'chat', role: 'specialist', specialistId: agent.id, state: 'finished', projectPath: repo, createdAt: new Date().toISOString() });
  store.put('team-task', 'tt1', { id: 'tt1', workerId: agent.id, managerName: 'Boss', title: 'Market page', state: 'working', createdAt: new Date().toISOString() });
  store.put('interaction', 'ny1', { id: 'ny1', runId: 'chat', kind: 'review', title: 'Split view screenshots', state: 'pending', parked: true, createdAt: new Date().toISOString() });
  const long = 'This sentence is long on purpose. '.repeat(400);
  const note = HANDOFF_HEADINGS.map(heading => `## ${heading}\n- ${heading === 'Next step' ? 'Commit the review card.' : long}`).join('\n\n');
  desk.resume = async () => {};
  const { handoff } = await desk.freshStart('chat', { note });
  const text = readFileSync(handoff, 'utf8');
  for (const heading of HANDOFF_HEADINGS) assert.match(text, new RegExp(`^## ${heading}$`, 'm'));
  assert.ok(text.includes(long.trim()), 'the whole note, never cut');
  assert.doesNotMatch(text, /cut to keep the handoff short/);
  assert.match(text, /## Facts from Rex Desk/); assert.match(text, /Branch: release\/9\.9\.9/);
  assert.match(text, /\?\? b\.txt/); assert.match(text, /[0-9a-f]{7} feat\(a\): #L1, first, Desky/);
  assert.match(text, /Market page \(tt1\): working, from Boss/); assert.match(text, /Split view screenshots \(ny1, waiting for OK\)/);
  const memory = notes.text(agent.id, 'memory');
  assert.ok(memory.includes(handoff)); assert.match(memory, /Next step: - Commit the review card\./); assert.ok(!memory.includes('long on purpose'));
});

test('after a turn with real work no hidden turn runs: the next real message carries a one-line memory reminder (L61)', async () => {
  const { store, desk, agent } = setup(), asked = [];
  desk.resume = async (runId, input) => { asked.push(input); };
  const started = new Date(Date.now() - 5000).toISOString();
  store.put('run', 'chat', { id: 'chat', role: 'specialist', specialistId: agent.id, state: 'finished', turnStartedAt: started, createdAt: started });
  store.event('chat', 'agent-text', { text: 'Hi!' }, true);
  assert.equal(await desk.nudgeMemory('chat'), false, 'a short chat turn: no reminder');
  assert.equal(store.get('run', 'chat').memoryDue, undefined);
  store.event('chat', 'agent-tool', { id: 't1', tool: 'Bash', input: { command: 'git commit -m "fix"' } }, true);
  assert.equal(await desk.nudgeMemory('chat'), true);
  assert.equal(asked.length, 0, 'no extra turn that re-sends the whole chat');
  assert.equal(store.get('run', 'chat').memoryDue, true, 'the reminder waits for the next real message');
  store.put('run', 'chat', { ...store.get('run', 'chat'), memoryDue: undefined });
  assert.equal(await desk.nudgeMemory('chat'), false, 'at most every 20 minutes');
});

test('handoffs leave out the start greeting, so the new session answers instead of introducing itself again', async () => {
  const { store, desk, agent } = setup();
  store.put('run', 'chat', { id: 'chat', role: 'specialist', specialistId: agent.id, state: 'finished', createdAt: new Date().toISOString() });
  store.event('chat', 'human-message', { text: 'Introduce yourself in one or two lines: who you are and which project you look after.', greeting: true }, true);
  store.event('chat', 'message', { text: 'I am Desky, I look after the shop.' }, true);
  store.event('chat', 'human-message', { text: 'Introduce yourself in one or two lines to the new client, please.' }, true);
  store.event('chat', 'human-message', { text: 'Why is checkout slow?' }, true);
  const digest = desk.conversationDigest('chat', 'claude');
  assert.doesNotMatch(digest, /which project you look after/); assert.match(digest, /to the new client/, 'a real message with the same words stays'); assert.match(digest, /Why is checkout slow\?/); assert.match(digest, /answer only the latest message/);
  desk.resume = async () => {};
  const handoff = readFileSync((await desk.freshStart('chat')).handoff, 'utf8');
  assert.doesNotMatch(handoff, /which project you look after/); assert.match(handoff, /to the new client/); assert.match(handoff, /without introducing yourself again/);
});

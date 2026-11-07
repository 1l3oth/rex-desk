import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { git } from '../src/processes.js';
import { branchList, scanRepositories, placeTask, baseCandidates } from '../src/placement.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const idle = () => ({ start: async () => ({ status: 'completed' }), interrupt: async () => {}, close() {} });
const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
async function checkout(parent, name, branches) {
  const directory = path.join(parent, name); mkdirSync(directory);
  await git(directory, ['init', '-b', branches[0]]);
  await git(directory, ['config', 'user.name', 'Rex Desk Test']); await git(directory, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(directory, 'README.md'), `${name}\n`); await git(directory, ['add', '.']); await git(directory, ['commit', '-m', 'fixture']);
  for (const branch of branches.slice(1)) await git(directory, ['branch', branch]);
  return directory;
}
// Answers each placement question with the option whose description mentions the wanted word.
const jevPicking = (repositoryWord, branchWord, asked = []) => async (url, options) => {
  const { questions } = JSON.parse(options.body); asked.push(questions);
  const [name, question] = Object.entries(questions)[0], word = name === 'repository' ? repositoryWord : branchWord;
  const choice = Object.entries(question.criteria).find(([, text]) => text.startsWith(word) || text.includes(` ${word}`))?.[0];
  return reply({ model: 'typesafe/jev', answers: { [name]: { type: 'choice', choice, probabilities: {}, confidence: 0.9 } } });
};

test('branch refs merge local and origin copies and keep the newest commit time', () => {
  const list = branchList('refs/heads/develop\t2026-11-01T00:00:00+09:00\nrefs/remotes/origin/develop\t2026-11-03T00:00:00+09:00\nrefs/remotes/origin/HEAD\t\nrefs/remotes/origin/global/master\t2026-10-01T00:00:00+09:00');
  assert.deepEqual(list.map(item => [item.name, item.local, item.remote]), [['develop', true, true], ['global/master', false, true]]);
  assert.equal(list[0].at, '2026-11-03T00:00:00+09:00');
});

test('the scan stores every checkout with its branches and the projects already run there', async () => {
  const parent = temporary('scan'), web = await checkout(parent, 'flow-web', ['develop', 'global/master', 'temp/rex/fix/thing']), desktop = await checkout(parent, 'flow-desktop', ['master']);
  const store = new Store(temporary('scan-store'));
  store.saveConfig({ ...defaults, repositories: [{ id: 'web', name: 'flow-web', path: web, baseBranch: 'develop', targetBranch: 'develop' }] });
  store.put('task', 't1', { id: 't1', title: 'Old', projectName: 'Web QA', active: true });
  store.put('run', 'r1', { id: 'r1', role: 'worker', taskId: 't1', title: 'Old', repositoryId: 'web', baseBranch: 'global/master', createdAt: now() });
  const catalog = await scanRepositories(store, [parent]);
  assert.deepEqual(catalog.map(item => item.name).sort(), ['flow-desktop', 'flow-web']);
  const stored = store.get('repository', path.resolve(web).toLowerCase());
  assert.equal(stored.configuredId, 'web');
  assert.deepEqual(stored.history.projects, { 'Web QA': 1 });
  assert.deepEqual(baseCandidates(stored), ['develop', 'global/master'], 'agent branches are not offered as a base');
  assert.equal(store.get('repository', path.resolve(desktop).toLowerCase()).configuredId, '');
  store.close();
});

test('Jev chooses the repository and base branch; without a key, the repository that ran the same project wins', async () => {
  const repositories = [
    { id: 'a', name: 'flow-web', path: 'C:/a', branches: [{ name: 'develop' }, { name: 'global/develop' }], baseBranch: 'develop', history: { runs: 2, projects: { 'Web QA': 2 }, bases: {}, recent: [] } },
    { id: 'b', name: 'flow-desktop', path: 'C:/b', branches: [{ name: 'master' }, { name: 'release/2.0' }], baseBranch: '', history: { runs: 1, projects: { 'Desktop QA': 1 }, bases: { master: 1 }, recent: [] } }];
  const task = { title: 'Tray icon disappears after update', projectName: 'Web QA' }, asked = [];
  const placed = await placeTask(task, { repositories, apiKey: 'or-key', fetcher: jevPicking('flow-desktop', 'release/2.0', asked) });
  assert.equal(placed.repository.name, 'flow-desktop'); assert.equal(placed.baseBranch, 'release/2.0'); assert.equal(placed.by, 'jev');
  assert.equal(asked.length, 2); assert.equal(asked[0].repository.type, 'choice');
  const human = await placeTask(task, { repositories, chosenRepository: { path: 'C:/a' }, chosenBase: 'develop', apiKey: 'or-key', fetcher: () => assert.fail('nothing left to ask') });
  assert.deepEqual([human.repository.name, human.baseBranch, human.by], ['flow-web', 'develop', 'human']);
  const offline = await placeTask(task, { repositories });
  assert.deepEqual([offline.repository.name, offline.baseBranch, offline.by], ['flow-web', 'develop', 'history']);
  assert.equal(await placeTask({ title: 'x', projectName: 'Unknown' }, { repositories }), null);
});

test('a fired issue with no repository picked is placed by Jev, and a checkout not in Settings is added', async () => {
  const parent = temporary('place'), web = await checkout(parent, 'flow-web', ['develop']), desktop = await checkout(parent, 'flow-desktop', ['master', 'release/2.0']);
  const store = new Store(path.join(temporary('place-store'), 'data'));
  store.saveConfig({ ...defaults, repositories: [{ id: 'web', name: 'flow-web', path: web, baseBranch: 'develop', targetBranch: 'develop' }], jev: { apiKey: 'or-key' } });
  store.put('task', 'task-1', { id: 'task-1', title: 'Desktop tray icon disappears', taskNumber: '501', externalId: '501', source: 'morningmate', projectName: 'Desktop QA', repositoryId: 'web', active: true, createdAt: now() });
  const desk = new Desk(store, { root: temporary('place-root'), runnerFactory: idle, jevFetcher: jevPicking('flow-desktop', 'release/2.0'), namingFetcher: async () => reply({ choices: [{ message: { content: '{"type":"fix","name":"tray icon disappears after update"}' } }] }) });
  await scanRepositories(store, [parent]);
  const run = await desk.startTask({ taskId: 'task-1' });
  assert.equal(run.placement.state, 'pending');
  for (let attempt = 0; attempt < 100 && !store.get('run', run.id).worktree; attempt++) await new Promise(resolve => setTimeout(resolve, 30));
  const placed = store.get('run', run.id), added = store.config().repositories.find(item => item.name === 'flow-desktop');
  assert.ok(added, 'the chosen checkout joined Settings');
  assert.equal(placed.repositoryId, added.id); assert.equal(placed.baseBranch, 'release/2.0'); assert.equal(placed.targetBranch, 'release/2.0');
  assert.equal(placed.placement.by, 'jev');
  assert.ok(placed.worktree, 'the worktree was created from the chosen checkout');
  await new Promise(resolve => setTimeout(resolve, 100)); store.close();
});

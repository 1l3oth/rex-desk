import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function setup() {
  const projects = temporary('projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop', description: 'Online shop for Acme', scripts: { test: 'node --test' } }));
  const store = new Store(temporary('spec')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  desk.memory.scan({ roots: [projects] });
  return { desk, store };
}

test('a specialist starts from what memory knows and gets an identity card file', () => {
  const { desk } = setup();
  const agent = desk.specialists.create({ name: 'Shopkeeper', projectSlug: 'shop', rules: 'Never touch the checkout flow.', unsure: ['Which payment sandbox?'], by: 'main agent' });
  assert.equal(agent.purpose, 'Online shop for Acme');
  assert.equal(agent.createdBy, 'main agent');
  const card = readFileSync(desk.specialists.cardFile(agent), 'utf8');
  assert.match(card, /# Shopkeeper/);
  assert.match(card, /Never touch the checkout flow\./);
  assert.match(card, /Which payment sandbox\?/);
  assert.equal(desk.snapshot().specialists.length, 1);
});

test('an unknown project and a taken name are refused', () => {
  const { desk } = setup();
  assert.throws(() => desk.specialists.create({ name: 'A', projectSlug: 'nope' }), /No project "nope"/);
  desk.specialists.create({ name: 'Shopkeeper', projectSlug: 'shop' });
  assert.throws(() => desk.specialists.create({ name: 'shopkeeper', projectSlug: 'shop' }), /already exists/);
});

test('rename moves the card; duplicate copies the rules under a new name', () => {
  const { desk } = setup();
  const original = desk.specialists.create({ name: 'Shopkeeper', projectSlug: 'shop', rules: 'Use pnpm.' });
  const oldCard = desk.specialists.cardFile(original);
  const renamed = desk.specialists.rename(original.id, 'Cashier');
  assert.equal(renamed.name, 'Cashier');
  assert.ok(!existsSync(oldCard), 'the old card is gone');
  assert.ok(existsSync(desk.specialists.cardFile(renamed)));
  const copy = desk.specialists.duplicate(original.id, 'Cashier Two');
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.projectSlug, 'shop');
  assert.equal(copy.rules, 'Use pnpm.');
  assert.equal(copy.provider, 'claude');
  assert.equal(copy.cloneOf, original.id);
  assert.match(readFileSync(desk.specialists.cardFile(copy), 'utf8'), /duplicate of Cashier/);
  assert.throws(() => desk.specialists.duplicate(original.id, 'cashier two'), /already exists/);
});

test('editing a specialist updates its rules and model; removing deletes the card', () => {
  const { desk } = setup();
  const agent = desk.specialists.create({ name: 'Shopkeeper', projectSlug: 'shop' });
  const updated = desk.specialists.update(agent.id, { rules: 'Ask before schema changes.', model: 'Opus 5.5' });
  assert.equal(updated.model, 'claude-opus-5-5', 'a typed model name becomes the listed id');
  assert.throws(() => desk.specialists.update(agent.id, { model: 'gpt-5' }), /Choose a model from the list/);
  assert.equal(desk.specialists.update(agent.id, { model: '' }).model, '', 'empty means the default');
  assert.match(readFileSync(desk.specialists.cardFile(updated), 'utf8'), /Ask before schema changes\./);
  desk.specialists.remove(agent.id);
  assert.equal(desk.specialists.list().length, 0);
  assert.ok(!existsSync(desk.specialists.cardFile(agent)));
});

test('the main agent starts from the chat with the first message and the onboarding prompt, and only one runs at a time', async () => {
  const { desk, store } = setup();
  desk.closed = true; // no agent process is started here
  const run = await desk.startMain({ prompt: 'Meet my projects' });
  assert.equal(run.role, 'coordinator'); assert.equal(run.main, true); assert.equal(run.provider, 'claude');
  assert.ok(store.events(run.id, { visible: true }).some(item => item.kind === 'human-message' && item.text === 'Meet my projects'));
  const prompt = desk.prompt(run);
  assert.match(prompt, /desk_create_specialist/); assert.match(prompt, /one at a time/); assert.match(prompt, /Meet my projects/);
  await assert.rejects(desk.startMain({}), /already running/);
});

test('each computer has its own main agent: one synced from another computer is not used here', async () => {
  const { desk, store } = setup();
  desk.closed = true;
  store.put('run', 'elsewhere', { id: 'elsewhere', role: 'coordinator', main: true, computer: 'OTHER-LAPTOP', title: 'Rex Agent', state: 'running', createdAt: '2030-01-01T00:00:00.000Z', taskIds: [] });
  desk.specialists.ensureMain();
  const run = await desk.startMain({ prompt: 'Hello' });
  assert.notEqual(run.id, 'elsewhere', 'a main agent running on another computer does not block this one');
  assert.equal(run.computer, desk.snapshot().computer);
  assert.equal(desk.specialists.status(desk.specialists.get('main')).runId, run.id);
  assert.deepEqual(desk.personalChat('main').map(item => item.text), ['Hello']);
});

test('an agent saves what it learned from a correction, sees it in its prompt and card, and the person can delete it', () => {
  const { desk } = setup();
  const agent = desk.specialists.create({ name: 'Shopkeeper', projectSlug: 'shop' });
  desk.specialists.learn(agent.id, 'Morningmate QA issues: check global/release, not global/develop.');
  desk.specialists.learn(agent.id, 'morningmate qa issues: check global/release, not global/develop.');
  desk.specialists.learn(agent.id, 'Never print token=abc123 in chat.');
  const saved = desk.specialists.get(agent.id).lessons;
  assert.equal(saved.length, 2, 'the same lesson is kept once');
  assert.ok(!saved[1].text.includes('abc123'), 'secrets are stripped');
  assert.match(desk.specialists.identity(desk.specialists.get(agent.id)), /Lessons you learned from the person[\s\S]*global\/release/);
  assert.match(readFileSync(desk.specialists.cardFile(agent), 'utf8'), /## Lessons learned[\s\S]*global\/release/);
  desk.specialists.forget(agent.id, 0);
  assert.equal(desk.specialists.get(agent.id).lessons.length, 1);
  desk.specialists.learn('main', 'Rooms: answer in two sentences.');
  assert.match(desk.specialists.lessonsText('main'), /answer in two sentences/);
});

test('the main agent adds a project folder itself: it becomes a repository and a memory project, and keeps the projects already known', async () => {
  const { desk, store } = setup();
  const folder = path.join(temporary('add'), 'billing');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'billing', description: 'Invoices for Acme' }));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: folder });
  const result = await desk.addProject(folder);
  assert.equal(result.added, true); assert.equal(result.project, 'billing');
  assert.equal(store.config().repositories.length, 1); assert.equal(result.repository.baseBranch, 'develop');
  assert.deepEqual(desk.memory.list().map(item => item.slug).sort(), ['billing', 'shop']);
  assert.equal((await desk.addProject(folder)).added, false, 'adding it again changes nothing');
  assert.equal((await desk.addProject(folder, { baseBranch: 'master' })).repository.targetBranch, 'master', 'new branches update the repository');
  assert.equal(desk.specialists.create({ name: 'Biller', projectSlug: 'billing' }).purpose, 'Invoices for Acme');
});

test('a profile photo is kept only when it is a real picture, and the About you profile lists notes and projects', () => {
  const { desk } = setup();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex');
  const folder = temporary('photo'), picture = path.join(folder, 'me.png'), fake = path.join(folder, 'notes.png');
  writeFileSync(picture, png); writeFileSync(fake, 'not a picture');
  assert.throws(() => desk.memory.setPhotoFrom(fake), /Only PNG, JPEG or WebP/);
  assert.equal(desk.memory.photo(), null);
  desk.memory.setPhotoFrom(picture);
  assert.match(desk.memory.photo().file, /profile\.png$/);
  desk.memory.personNote('likes', 'Short answers first');
  const profile = desk.memory.profile();
  assert.ok(profile.photo); assert.equal(profile.sections[0].title, 'Likes'); assert.match(profile.sections[0].items[0], /Short answers first/);
  assert.deepEqual(profile.projects.map(item => item.slug), ['shop']);
  desk.memory.removePhoto(); assert.equal(desk.memory.photo(), null);
});

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

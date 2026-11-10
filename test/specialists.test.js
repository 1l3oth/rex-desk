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
  const updated = desk.specialists.update(agent.id, { rules: 'Ask before schema changes.', model: 'opus' });
  assert.match(readFileSync(desk.specialists.cardFile(updated), 'utf8'), /Ask before schema changes\./);
  desk.specialists.remove(agent.id);
  assert.equal(desk.specialists.list().length, 0);
  assert.ok(!existsSync(desk.specialists.cardFile(agent)));
});

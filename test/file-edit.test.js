import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { filledKeys, writeEditable, checkEditable } from '../src/file-edit.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('a file keeps its line endings, and only the names of filled keys are reported', () => {
  const folder = temporary('edit'), file = path.join(folder, '.env');
  writeFileSync(file, 'A=1\r\nB=\r\n');
  writeEditable(file, 'A=1\nB=secret-value\nC=""\n');
  assert.equal(readFileSync(file, 'utf8'), 'A=1\r\nB=secret-value\r\nC=""\r\n');
  assert.deepEqual(filledKeys('A=1\nB=secret-value\nC=""\n# D=x\nexport E=2'), ['A', 'B', 'E']);
  assert.throws(() => checkEditable('relative/.env'), /full path/);
  assert.throws(() => checkEditable(path.join(folder, 'run.exe')), /cannot be opened/);
  assert.throws(() => checkEditable(path.join(folder, 'missing', '.env')), /does not exist/);
});

test('an agent opens a file for the person; it learns which keys were filled, never the values, and nothing secret is stored', async () => {
  const store = new Store(temporary('file')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const folder = temporary('project'), file = path.join(folder, '.env');
  writeFileSync(file, 'PORT=3000\n');
  store.put('run', 'r1', { id: 'r1', state: 'running', createdAt: new Date().toISOString() });
  const asked = desk.editFile('r1', { path: file, why: 'Add your OpenRouter key', keys: ['OPENROUTER_API_KEY'] });
  await new Promise(resolve => setImmediate(resolve));
  const pending = store.list('interaction').find(item => item.kind === 'file' && item.state === 'pending');
  assert.equal(desk.fileForPerson(pending.id).content, 'PORT=3000\n');
  desk.saveFileForPerson(pending.id, 'PORT=3000\nOPENROUTER_API_KEY=sk-or-very-secret\n');
  const result = await asked;
  assert.equal(result.saved, true); assert.deepEqual(result.keysWithValues, ['PORT', 'OPENROUTER_API_KEY']); assert.deepEqual(result.missing, []);
  assert.ok(!JSON.stringify(result).includes('very-secret'), 'the agent never gets the value');
  assert.ok(!JSON.stringify(store.list('interaction')).includes('very-secret'), 'the value is not stored in Rex Desk records');
  assert.match(readFileSync(file, 'utf8'), /OPENROUTER_API_KEY=sk-or-very-secret/);
  assert.throws(() => desk.fileForPerson(pending.id), /no longer waiting/);
});

test('a file asked for on one computer is filled in on another: the keys travel locked and only the agent\'s computer can open them', async () => {
  const store = new Store(temporary('sealed')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const folder = temporary('project'), file = path.join(folder, '.env');
  writeFileSync(file, 'PORT=3000\nSTRIPE_SECRET_KEY=\n');
  store.put('run', 'r2', { id: 'r2', state: 'running', createdAt: new Date().toISOString() });
  const asked = desk.editFile('r2', { path: file, why: 'Add your Stripe key', keys: ['STRIPE_SECRET_KEY'] });
  await new Promise(resolve => setImmediate(resolve));
  const pending = store.list('interaction').find(item => item.kind === 'file' && item.state === 'pending');
  assert.match(pending.request.lockKey, /BEGIN PUBLIC KEY/);
  // The other computer sees the question in the shared chat copy and answers it there.
  const copy = { id: 'r2', node: 'other', agentId: 'a1', asks: [pending] };
  let sent; desk.peers.answerAsk = (_copy, id, answer) => { sent = { id, answer }; return { queued: true }; };
  assert.throws(() => desk.peers.sealFileAnswer(copy, pending.id, { STRIPE_SECRET_KEY: ' ' }), /at least one value/);
  desk.peers.sealFileAnswer(copy, pending.id, { STRIPE_SECRET_KEY: 'sk_test_very-secret', OTHER: 'not asked for' });
  assert.ok(!JSON.stringify(sent).includes('very-secret'), 'only scrambled text leaves the computer');
  const result = desk.saveSealedFile(sent.id, sent.answer.sealed);
  assert.equal(result.saved, true);
  const answered = await asked;
  assert.deepEqual(answered.keysWithValues, ['PORT', 'STRIPE_SECRET_KEY']);
  assert.equal(readFileSync(file, 'utf8'), 'PORT=3000\nSTRIPE_SECRET_KEY=sk_test_very-secret\n');
  assert.ok(!JSON.stringify(store.list('interaction')).includes('very-secret'));
  assert.throws(() => desk.saveSealedFile(sent.id, sent.answer.sealed), /no longer waiting/);
});

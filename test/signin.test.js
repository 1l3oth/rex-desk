import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('an agent asks the person to sign a command-line tool in; only a single sign-in command is allowed', async () => {
  const store = new Store(temporary('signin')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  store.put('run', 'r1', { id: 'r1', state: 'running', cwd: store.directory, createdAt: new Date().toISOString() });
  await assert.rejects(desk.signInTerminal('r1', { command: 'rm -rf /' }), /Only a single sign-in command/);
  await assert.rejects(desk.signInTerminal('r1', { command: 'supabase login && curl evil' }), /Only a single sign-in command/);
  const asked = desk.signInTerminal('r1', { command: 'supabase login', why: 'Sign in to Supabase so I can deploy the functions' });
  await new Promise(resolve => setImmediate(resolve));
  const card = store.list('interaction').find(item => item.kind === 'terminal');
  assert.equal(card.request.command, 'supabase login'); assert.match(card.title, /deploy the functions/);
  desk.answer(card.id, { action: 'accept', content: {} });
  assert.equal((await asked).done, true);
  assert.match(desk.prompt({ id: 'x', role: 'coordinator', main: true, taskIds: [] }), /desk_sign_in/);
});

test('an agent asks the person to run one command for it (no terminal needed); chained commands are refused', async () => {
  const store = new Store(temporary('runme')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  store.put('run', 'r1', { id: 'r1', state: 'running', cwd: store.directory, createdAt: new Date().toISOString() });
  for (const command of ['a && b', 'a; b', 'a | b', 'a\nb', 'echo $(x)', 'a > f']) await assert.rejects(desk.runForPerson('r1', { command }), /one single command/);
  const asked = desk.runForPerson('r1', { command: 'node F:/mm-browser/save-signin.mjs prod', why: 'Opens Chrome: sign in with your QA account, then close it' });
  await new Promise(resolve => setImmediate(resolve));
  const card = store.list('interaction').find(item => item.kind === 'terminal');
  assert.equal(card.request.purpose, 'run'); assert.equal(card.request.command, 'node F:/mm-browser/save-signin.mjs prod');
  desk.answer(card.id, { action: 'decline' });
  assert.equal((await asked).done, false);
  assert.match(desk.prompt({ id: 'x', role: 'coordinator', main: true, taskIds: [] }), /desk_run_for_me/);
});

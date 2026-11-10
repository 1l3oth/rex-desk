import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../src/memory.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function project(root, name, files) {
  const directory = path.join(root, name);
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(directory, '.git', 'config'), '[remote "origin"]\n\turl = https://user:pw@github.com/acme/' + name + '.git\n');
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(directory, file), text);
  return directory;
}

test('a scan writes a page per project with purpose, commands and its own instructions', () => {
  const root = temporary('scan'), memory = new Memory(temporary('home'));
  project(root, 'shop', { 'package.json': JSON.stringify({ name: 'shop', description: 'Online shop for Acme', scripts: { test: 'node --test', dev: 'vite' }, dependencies: { react: '1' } }), 'CLAUDE.md': 'Use pnpm. api_key = sk-secret-123\nKeep commits small.' });
  const result = memory.scan({ roots: [root] });
  assert.equal(result.count, 1);
  const page = memory.readDoc('shop');
  assert.match(page, /Online shop for Acme/);
  assert.match(page, /Test: `npm test`/);
  assert.match(page, /Keep commits small/);
  assert.ok(!page.includes('sk-secret-123'), 'secrets are stripped');
  assert.ok(!page.includes('user:pw'), 'remote credentials are stripped');
  assert.match(memory.readDoc('index'), /shop/);
});

test('files outside the allow-list and skipped folders are never read', () => {
  const root = temporary('skip'), memory = new Memory(temporary('home'));
  const directory = project(root, 'app', { '.env': 'PASSWORD=hunter2', 'README.md': 'A small tool that renames files for the team every day.' });
  project(path.join(root, 'node_modules'), 'dep', { 'README.md': 'should not be found' });
  memory.scan({ roots: [root] });
  assert.ok(!memory.readDoc('app').includes('hunter2'));
  assert.deepEqual(memory.list().map(item => item.slug), ['app']);
  assert.ok(existsSync(directory));
});

test('agent notes survive a rescan and secrets in them are stripped', () => {
  const root = temporary('notes'), memory = new Memory(temporary('home'));
  project(root, 'api', { 'package.json': '{"name":"api"}' });
  memory.scan({ roots: [root] });
  memory.note('api', 'Needs Java 8 on PATH. token: abc123', 'run-1');
  memory.scan({ roots: [root] });
  const page = memory.readDoc('api');
  assert.match(page, /Needs Java 8 on PATH/);
  assert.ok(!page.includes('abc123'));
  assert.throws(() => memory.note('missing', 'x'), /No project/);
});

test('page names cannot escape the memory folder', () => {
  const memory = new Memory(temporary('home')).ensure();
  assert.throws(() => memory.readDoc('../../secret'), /No memory page/);
  assert.match(memory.readDoc('user'), /About the person/);
});

test('agents get the chat style, which the person can change in chat-style.md', () => {
  const memory = new Memory(temporary('style')).ensure();
  assert.match(memory.chatStyle(), /Write like a teammate in a group chat/);
  writeFileSync(path.join(memory.directory, 'chat-style.md'), '# Mine\n- Always one sentence.');
  assert.equal(memory.chatStyle(), '# Mine\n- Always one sentence.');
});

test('what agents learn about the person is kept in sections of user.md, once, without secrets', () => {
  const memory = new Memory(temporary('person')).ensure();
  assert.equal(memory.person(), '', 'nothing known yet');
  memory.personNote('likes', 'Short replies with the answer first.');
  memory.personNote('likes', 'short replies with the answer first.');
  memory.personNote('dislikes', 'Long tables in chat.');
  memory.personNote('works', 'Reviews in the morning; password=hunter2');
  const text = memory.person();
  assert.match(text, /## Likes\n\n- Short replies with the answer first\./);
  assert.equal((text.match(/Short replies/gi) || []).length, 1, 'kept once');
  assert.match(text, /## Dislikes\n\n- Long tables in chat\./);
  assert.ok(!text.includes('hunter2'));
  assert.throws(() => memory.personNote('hobbies', 'x'), /likes, dislikes, works or about/);
});

test('notes about the person are dated and soft unless lasting, a new note can replace an old one, and the second brain is recorded once', () => {
  const memory = new Memory(temporary('brain')).ensure();
  memory.personNote('likes', 'The colour red.');
  memory.personNote('likes', 'Short replies.', { lasting: true });
  assert.match(memory.person(), /- The colour red\. \(\d{4}-\d{2}-\d{2}, may change\)/);
  assert.match(memory.person(), /- Short replies\. \(\d{4}-\d{2}-\d{2}\)$/m);
  memory.personNote('likes', 'The colour blue.', { replaces: 'colour red' });
  assert.ok(!memory.person().includes('red'), 'the old note is gone'); assert.match(memory.person(), /colour blue/);
  assert.equal(memory.secondBrain(), '');
  const vault = temporary('vault'); mkdirSync(path.join(vault, 'wiki'), { recursive: true }); writeFileSync(path.join(vault, 'wiki', 'index.md'), '# Index');
  assert.throws(() => memory.setSecondBrain({ path: path.join(vault, 'missing') }), /does not exist/);
  memory.setSecondBrain({ path: vault, how: 'Read the index first; add notes as wiki pages.' });
  assert.match(memory.secondBrain(), /Where: `.+`/); assert.match(memory.secondBrain(), /index\.md/); assert.match(memory.secondBrain(), /add notes as wiki pages/);
});

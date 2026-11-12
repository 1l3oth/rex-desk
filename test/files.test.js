import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Files, kindOf } from '../src/files.js';

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rex-files-'));
  const repo = path.join(root, 'repo'), store = path.join(root, 'data'), worktree = path.join(root, 'worktrees', 'run-1');
  for (const dir of [path.join(repo, 'src'), path.join(store, 'artifacts', 'run-1'), worktree]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(repo, 'src', 'app.js'), 'const a = {b:1}\n');
  writeFileSync(path.join(worktree, 'notes.md'), '# Hi\n');
  writeFileSync(path.join(store, 'secrets.json'), '{}');
  writeFileSync(path.join(store, 'artifacts', 'run-1', 'shot.png'), Buffer.from([137, 80, 78, 71]));
  const runs = { 'run-1': { id: 'run-1', worktree, repositoryId: 'r1', roomId: 'room-1' } };
  const desk = { worktreeRoot: path.join(root, 'worktrees'), memory: null,
    store: { directory: store, config: () => ({ repositories: [{ id: 'r1', path: repo }] }), get: (kind, id) => (kind === 'run' ? runs[id] : null), list: kind => (kind === 'run' ? Object.values(runs) : []) } };
  return { root, repo, store, worktree, files: new Files(desk) };
}

test('a path from a chat opens with its line, from the run worktree first, then the projects', () => {
  const { files, repo, worktree } = setup();
  const code = files.open('src/app.js:12', 'run-1');
  assert.equal(code.path, path.join(repo, 'src', 'app.js')); assert.equal(code.line, 12); assert.equal(code.kind, 'text'); assert.equal(code.editable, true); assert.equal(code.formattable, true);
  const notes = files.open('notes.md#L3', 'run-1');
  assert.equal(notes.path, path.join(worktree, 'notes.md')); assert.equal(notes.line, 3); assert.equal(notes.kind, 'markdown');
  assert.throws(() => files.open('nope/missing.ts', 'run-1'), /No file named/);
});

test('Rex Desk data, private keys and folders outside the known ones never open', () => {
  const { files, store } = setup();
  assert.throws(() => files.open(path.join(store, 'secrets.json')), /private data/);
  assert.equal(files.open(path.join(store, 'artifacts', 'run-1', 'shot.png')).kind, 'image');
  assert.throws(() => files.check(path.join(os.homedir(), '.ssh', 'id_rsa')), /private key/);
  assert.throws(() => files.check(path.parse(process.cwd()).root + 'Windows-not-here' + path.sep + 'x.txt'), /outside/);
});

test('saving refuses a file changed on disk since it was opened, unless forced', () => {
  const { files, repo } = setup();
  const file = path.join(repo, 'src', 'app.js'), opened = files.open(file);
  const saved = files.save(file, { text: 'one\n', mtime: opened.mtime });
  assert.equal(readFileSync(file, 'utf8'), 'one\n');
  assert.throws(() => files.save(file, { text: 'two\n', mtime: opened.mtime - 5000 }), error => error.status === 409);
  files.save(file, { text: 'two\n', mtime: saved.mtime - 5000, force: true });
  assert.equal(readFileSync(file, 'utf8'), 'two\n');
});

test('Prettier formats by the file type', async () => {
  const { files, repo } = setup();
  const { text } = await files.format(path.join(repo, 'src', 'app.js'), 'const a = {b:1}');
  assert.equal(text, 'const a = { b: 1 };\n');
  await assert.rejects(files.format(path.join(repo, 'src', 'app.js').replace('.js', '.png'), 'x'), /does not format/);
});

test('kinds come from the extension, and unknown files with zero bytes are binary', () => {
  assert.equal(kindOf('a.xlsx'), 'sheet'); assert.equal(kindOf('a.docx'), 'doc'); assert.equal(kindOf('a.MP4'), 'video'); assert.equal(kindOf('a.pdf'), 'pdf');
  assert.equal(kindOf('a.yaml', Buffer.from('a: 1')), 'text'); assert.equal(kindOf('a.dat', Buffer.from([1, 0, 2])), 'binary');
});

test('a short path finds the file deep in the project, and a group chat looks in the worktrees of its work', async () => {
  const { files, repo, worktree } = setup();
  const { execFileSync } = await import('node:child_process');
  mkdirSync(path.join(repo, 'web', 'apiCall', 'task'), { recursive: true }); writeFileSync(path.join(repo, 'web', 'apiCall', 'task', 'index.js'), 'x');
  execFileSync('git', ['init', '-q', repo]);
  assert.equal(files.open('apiCall/task/index.js:5').path, path.join(repo, 'web', 'apiCall', 'task', 'index.js'));
  assert.equal(files.open('apiCall/task/index.js:5').line, 5);
  assert.equal(files.open('notes.md', '', 'room-1').path, path.join(worktree, 'notes.md'), 'the worktree of the room run');
  assert.throws(() => files.open('notes.md', '', 'room-2'), /No file named/);
});

test('a picture someone attached opens, by its path or its upload link', () => {
  const { files, store } = setup();
  const dir = path.join(store, 'uploads', '0f8fad5b-d9cb-469f-a165-70867728950e'); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'shot.png'); writeFileSync(file, Buffer.from([137, 80, 78, 71]));
  assert.equal(files.open(file).kind, 'image');
  assert.equal(files.open(`/api/uploads/file?path=${encodeURIComponent(file)}`).path, file);
});

test('a code reference with a line range opens the file with the range', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-range-')), file = path.join(folder, 'a.js');
  writeFileSync(file, Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n'));
  const files = new Files({ store: { directory: folder, list: () => [], get: () => null, config: () => ({ repositories: [] }) } });
  const check = files.check; files.check = value => value; // the folder is a temporary one, not a project
  for (const [input, line, endLine] of [[`${file}:42-58`, 42, 58], [`${file}#L10-L20`, 10, 20], [`${file}:7`, 7, 0], [`${file}:7:3`, 7, 0], [`${file}:9-4`, 9, 0]]) {
    const opened = files.open(input); assert.equal(opened.line, line, input); assert.equal(opened.endLine, endLine, input);
  }
  files.check = check;
});

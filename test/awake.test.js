import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Awake, awakeCommand } from '../src/awake.js';

const fakeSpawner = () => {
  const started = [];
  const spawner = (file, args) => { const child = new EventEmitter(); child.killed = false; child.kill = () => { child.killed = true; child.emit('exit', 0); }; started.push({ file, args, child }); return child; };
  return { started, spawner };
};

test('holds the computer awake once and lets go when told', () => {
  const { started, spawner } = fakeSpawner(), awake = new Awake({ platform: 'win32', spawner, ownerPid: 4242 });
  assert.equal(awake.set(true), true);
  awake.set(true);
  assert.equal(started.length, 1, 'a second request reuses the helper');
  assert.equal(started[0].file, 'powershell.exe');
  assert.match(started[0].args.at(-1), /SetThreadExecutionState\(\[uint32\]2147483649\)/);
  assert.match(started[0].args.at(-1), /Get-Process -Id 4242/, 'the helper ends when the server is gone');
  assert.equal(awake.set(false), false);
  assert.equal(started[0].child.killed, true);
});

test('a helper that exits on its own is started again next time', () => {
  const { started, spawner } = fakeSpawner(), awake = new Awake({ platform: 'darwin', spawner, ownerPid: 7 });
  awake.set(true);
  assert.deepEqual(started[0].args, ['-i', '-w', '7']);
  started[0].child.emit('exit', 1);
  assert.equal(awake.on, false);
  awake.set(true);
  assert.equal(started.length, 2);
});

test('does nothing where it has no way to keep the computer awake', () => {
  const { started, spawner } = fakeSpawner(), awake = new Awake({ platform: 'none', spawner });
  assert.equal(awake.set(true), false);
  assert.equal(started.length, 0);
  assert.equal(awakeCommand('linux'), null);
});

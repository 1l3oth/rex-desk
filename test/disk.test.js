import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { lowDiskMessage, friendlyDiskError, watchDisk, installedServer } from '../src/disk.js';

test('a nearly full drive is named in plain words, and a drive with room says nothing', () => {
  const message = lowDiskMessage([String.raw`C:\Users\me\data`], { free: () => 9 * 2 ** 20 });
  assert.match(message, /^Drive C: is almost full \(9 MB free\)/); assert.match(message, /Settings, Folders/);
  assert.equal(lowDiskMessage([String.raw`C:\x`], { free: () => 50 * 2 ** 30 }), '');
  assert.equal(lowDiskMessage([undefined, ''], { free: () => 0 }), '', 'folders that are not set are skipped');
});

test('a raw "no space left" write error becomes a plain message; other errors are left alone', () => {
  assert.match(friendlyDiskError('ENOSPC: no space left on device, write'), /disk is full/);
  assert.equal(friendlyDiskError('Something else'), 'Something else');
});

test('the low-disk warning shows once per drop, a missing folder never resets it, and it shows again after the drive had room', () => {
  const said = [], data = path.join(os.tmpdir(), 'data'), runtime = path.join(data, 'runtime');
  let left = 4 * 2 ** 30;
  // The runtime copy is not there yet: its free space is unknown (Infinity), which must not end the warning.
  const watch = watchDisk([data, runtime], { notify: (title, body) => said.push({ title, body }), free: folder => folder === runtime ? Infinity : left, everyMs: 3600000 });
  assert.equal(said.length, 1); assert.match(said[0].title, /is running out of space$/); assert.match(said[0].body, /Only 4\.0 GB is free/);
  watch.check(); watch.check();
  assert.equal(said.length, 1, 'still low, and the missing folder did not reset it');
  left = 20 * 2 ** 30; watch.check(); assert.equal(said.length, 1, 'a drive with room says nothing');
  left = 3 * 2 ** 30; watch.check(); assert.equal(said.length, 2, 'a new drop warns again');
  watch();
});

test('only the installed app\'s own server watches the disk, not a test or agent copy that inherits its settings', () => {
  const install = path.join(os.tmpdir(), 'Rex Desk'), exe = path.join(install, 'rex-desk.exe'), app = path.join(install, 'payload', 'app');
  const env = { REX_DESK_VERSION: '1.0.0', REX_DESK_EXE: exe, REX_DATA_DIR: path.join(os.tmpdir(), 'data') };
  assert.equal(installedServer(app, undefined, env), true, 'the real app sets REX_DATA_DIR too and still watches');
  assert.equal(installedServer(path.join(os.tmpdir(), 'checkout'), undefined, env), false, 'a copy run from a checkout');
  assert.equal(installedServer(path.join(os.tmpdir(), 'Rex Desk2', 'app'), undefined, env), false, 'a folder that only starts with the same name');
  assert.equal(installedServer(app, path.join(os.tmpdir(), 'test-data'), env), false, 'a test passes its own data folder');
  assert.equal(installedServer(app, undefined, { REX_DESK_EXE: exe }), false, 'no version: a development run');
});

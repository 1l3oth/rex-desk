import test from 'node:test';
import assert from 'node:assert/strict';
import { lowDiskMessage, friendlyDiskError, watchDisk } from '../src/disk.js';

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


test('the low-disk warning shows once when a drive drops below 5 GB, and again only after it had room', () => {
  const said = [];
  let left = 4 * 2 ** 30;
  const stop = watchDisk([String.raw`C:\data`, String.raw`C:\data\runtime`], { notify: (title, body) => said.push({ title, body }), free: () => left, everyMs: 3600000 });
  assert.equal(said.length, 1, 'two folders on one drive give one warning'); assert.equal(said[0].title, 'Drive C: is running out of space'); assert.match(said[0].body, /Only 4\.0 GB is free/);
  stop();
  left = 20 * 2 ** 30; const again = watchDisk([String.raw`D:\x`], { notify: () => said.push('more'), free: () => left, everyMs: 3600000 }); again();
  assert.equal(said.length, 1, 'a drive with room says nothing');
});

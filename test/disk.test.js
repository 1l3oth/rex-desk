import test from 'node:test';
import assert from 'node:assert/strict';
import { lowDiskMessage, friendlyDiskError } from '../src/disk.js';

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


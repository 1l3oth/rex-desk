import test from 'node:test';
import assert from 'node:assert/strict';
import { userBinPath } from '../src/processes.js';

test('a Mac app started from the Dock still finds tools in ~/.local/bin and Homebrew', () => {
  const there = new Set(['/opt/homebrew/bin']);
  const result = userBinPath('/usr/bin:/bin:/usr/sbin:/sbin', '/Users/rex', folder => there.has(folder));
  // ~/.local/bin comes first even before anything is installed in it; Homebrew only when it is there; missing folders are left out.
  assert.equal(result, '/Users/rex/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  // A PATH that already has them is left as it was.
  assert.equal(userBinPath(result, '/Users/rex', folder => there.has(folder)), result);
});

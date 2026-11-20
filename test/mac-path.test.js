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

test('on a Mac the full path of Claude Code is found, so the Agent SDK is always told where it is (L54)', async () => {
  const { unixCommand } = await import('../src/processes.js');
  // Installed by Anthropic's installer into ~/.local/bin, with the app started from the Dock (system PATH only).
  const there = new Set(['/Users/rex/.local/bin/claude']);
  assert.equal(unixCommand('claude', { pathValue: '/usr/bin:/bin:/usr/sbin:/sbin', home: '/Users/rex', exists: file => there.has(file) }), '/Users/rex/.local/bin/claude');
  // Homebrew, and a PATH entry, are found too; the first one on PATH wins.
  assert.equal(unixCommand('claude', { pathValue: '/usr/bin', home: '/Users/rex', exists: file => file === '/opt/homebrew/bin/claude' }), '/opt/homebrew/bin/claude');
  assert.equal(unixCommand('claude', { pathValue: '/custom/bin:/usr/bin', home: '/Users/rex', exists: file => file === '/custom/bin/claude' || file === '/Users/rex/.local/bin/claude' }), '/custom/bin/claude');
  // Not installed anywhere: nothing, so Rex Desk says "Claude Code is not installed" instead of the SDK's own message.
  assert.equal(unixCommand('claude', { pathValue: '/usr/bin', home: '/Users/rex', exists: () => false }), '');
});

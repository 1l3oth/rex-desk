import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { cliFound, signInWindowScript, signInShellLine } from '../src/agents.js';

const gone = path.join(process.cwd(), 'tmp', 'no-such-folder', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const viaNode = { command: process.execPath, args: [gone] };
const window = found => signInWindowScript({ name: 'Codex', found, install: 'irm https://example.invalid/install.ps1 | iex', executable: viaNode, bare: 'codex', args: ['login'] });

test('a codex.js that is gone is not found, although node.exe is there', () => {
  assert.equal(cliFound(viaNode), false);
  assert.equal(cliFound({ command: process.execPath, args: [] }), true);
  assert.equal(cliFound(viaNode, () => true), true);
});

test('the sign-in window checks the file and the exit code before it says the browser is next', () => {
  const script = window(true);
  assert.match(script, /Test-Path -LiteralPath '.*codex\.js'/);
  assert.match(script, /if \(\$rexCode -eq 0\) \{ Write-Host 'When the browser says you are signed in/);
  assert.match(script, /Codex sign-in failed: Codex was not found\. Press Set up or Sign in in Rex Desk again to install it\./);
  assert.match(script, /irm https:\/\/example\.invalid\/install\.ps1 \| iex/);
  const line = signInShellLine({ name: 'Codex', found: true, install: 'curl -fsSL https://example.invalid/install.sh | sh', executable: { command: '/usr/bin/node', args: ['/gone/codex.js'] }, bare: 'codex', args: ['login'] });
  assert.match(line, /if \[ -e '\/gone\/codex\.js' \]; then .*rc=\$\?; else rc=127; fi/);
  assert.match(line, /if \[ \$rc -eq 0 \]; then echo 'When the browser says/);
  assert.match(line, /elif \[ \$rc -eq 127 \]; then echo 'Codex sign-in failed: Codex was not found/);
});

test('a bare command found on PATH is run in try, not tested as a file in the current folder', () => {
  const script = signInWindowScript({ name: 'Codex', found: true, install: 'x', executable: { command: 'codex', args: [] }, bare: 'codex', args: ['login'] });
  assert.doesNotMatch(script, /Test-Path/);
  assert.match(script, /try \{ & 'codex' 'login'; \$rexCode = \$LASTEXITCODE \} catch \{ \$rexCode = 127 \}/);
});

test('in PowerShell, a missing codex.js prints the failure and the installer, never the browser line', { skip: process.platform !== 'win32' }, () => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(window(true).replace("$Host.UI.RawUI.WindowTitle = 'Rex Desk sign-in'", ''), 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000 });
  assert.match(out, /Codex sign-in failed: Codex was not found\. Press Set up or Sign in in Rex Desk again to install it\./);
  assert.match(out, /example\.invalid\/install\.ps1/);
  assert.doesNotMatch(out, /When the browser says you are signed in/);
});

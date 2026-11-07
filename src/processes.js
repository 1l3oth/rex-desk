import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
export async function git(cwd, args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  return stdout.trim();
}
export function slug(value, maximum = 48) {
  return String(value).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, maximum).toLowerCase() || 'issue';
}
export function resolveCommand(name) {
  const override = process.env[`REX_${name.toUpperCase()}_PATH`];
  if (override) return { command: override, args: [] };
  if (process.platform !== 'win32') return { command: name, args: [] };
  // npm installs a .cmd shim that spawn cannot start without a shell, so the real binary is looked up behind every
  // global npm folder: %APPDATA%\npm, the running Node's own folder (nvm4w), and each PATH entry. A self-update can
  // leave one install with only claude.exe.old.* files, so the first folder holding the binary wins.
  const folders = [...new Set([path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'npm'), path.dirname(process.execPath),
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean)].map(folder => path.resolve(folder).toLowerCase()))];
  const packages = { codex: '@openai/codex/bin/codex.js', claude: '@anthropic-ai/claude-code/bin/claude.exe' };
  const found = packages[name] && folders.map(folder => path.join(folder, 'node_modules', packages[name])).find(target => existsSync(target));
  if (found) return name === 'codex' ? { command: process.execPath, args: [found] } : { command: found, args: [] };
  if (name === 'codex' && process.env.CODEX_CLI_PATH) return { command: process.env.CODEX_CLI_PATH, args: [] };
  const native = name === 'claude' && [path.join(os.homedir(), '.local', 'bin'), ...folders].map(folder => path.join(folder, 'claude.exe')).find(target => existsSync(target));
  if (native) return { command: native, args: [] };
  return { command: name, args: [] };
}
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
export function stopTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}
export function shellCommand(command, { cwd, env = {}, onData = () => {}, timeout = 600000, signal } = {}) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
  const child = spawn(shell, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let timedOut = false;
  const receive = data => { const chunk = data.toString(); output = (output + chunk).slice(-2000000); onData(chunk); };
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  const timer = timeout ? setTimeout(() => { timedOut = true; stopTree(child); }, timeout) : undefined;
  const abort = () => stopTree(child);
  signal?.addEventListener('abort', abort, { once: true });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ exitCode: code ?? -1, output, timedOut, aborted: Boolean(signal?.aborted) }));
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  return { child, done };
}
export async function fingerprint(directory) {
  const [head, diff, names] = await Promise.all([git(directory, ['rev-parse', 'HEAD']), git(directory, ['diff', '--binary', 'HEAD']), git(directory, ['ls-files', '-z', '--others', '--exclude-standard'])]);
  const hash = createHash('sha256').update(head).update(diff);
  for (const name of names.split('\0').filter(Boolean).sort()) {
    // Worktree proof concerns project files, not recordings and local runtime files.
    if (name.startsWith('.rex-desk/')) continue;
    const file = path.resolve(directory, name);
    if (existsSync(file)) { hash.update(name); hash.update(readFileSync(file)); }
  }
  return hash.digest('hex');
}
export async function createWorktree(repository, root, branch) {
  await git(repository.path, ['rev-parse', '--show-toplevel']);
  await git(repository.path, ['check-ref-format', '--branch', branch]);
  let base = repository.baseBranch;
  try { await git(repository.path, ['rev-parse', '--verify', `${base}^{commit}`]); }
  catch {
    base = `origin/${repository.baseBranch}`;
    await git(repository.path, ['rev-parse', '--verify', `${base}^{commit}`]);
  }
  const directory = path.resolve(root, slug(branch, 120));
  if (!directory.startsWith(path.resolve(root) + path.sep)) throw new Error('Worktree path must stay inside the configured worktree directory.');
  await git(repository.path, ['worktree', 'add', '-b', branch, directory, base]);
  return { directory, base, commit: await git(directory, ['rev-parse', 'HEAD']) };
}

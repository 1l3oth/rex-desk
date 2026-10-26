import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectElectron } from './electron-runtime.js';
import { detectProject } from './project-detect.js';

const exec = promisify(execFile);
const options = { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } };
const run = async (command, args, cwd) => (await exec(command, args, { ...options, cwd })).stdout.trim();
function safeRemote(value) {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
  catch { return value.replace(/\/\/[^/@]+@/, '//'); }
}

export async function inspectRepository(directory, { execute = run } = {}) {
  if (!path.isAbsolute(directory || '')) throw new Error('Choose an absolute local repository folder.');
  const git = args => execute('git', ['-C', directory, ...args], directory);
  let root;
  try { root = await git(['rev-parse', '--show-toplevel']); }
  catch { throw new Error('This folder is not an accessible Git repository. Choose its source folder and inspect again.'); }
  const optional = async args => { try { return await git(args); } catch { return ''; } };
  const [currentBranch, names, refs, authorName, authorEmail] = await Promise.all([
    optional(['branch', '--show-current']), optional(['remote']),
    optional(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
    optional(['config', 'user.name']), optional(['config', 'user.email']),
  ]);
  const remotes = names.split('\n').filter(Boolean), remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const remoteUrl = remote ? await optional(['remote', 'get-url', remote]) : '';
  const branches = new Map();
  const add = (name, kind) => {
    if (!name || name === 'HEAD') return;
    const branch = branches.get(name) || { name, local: false, remote: false };
    branch[kind] = true; branches.set(name, branch);
  };
  for (const ref of refs.split('\n')) {
    if (ref.startsWith('refs/heads/')) add(ref.slice(11), 'local');
    if (remote && ref.startsWith(`refs/remotes/${remote}/`)) add(ref.slice(`refs/remotes/${remote}/`.length), 'remote');
  }
  const warnings = [];
  const github = { accounts: [], repository: null };
  await Promise.all([
    (async () => {
      if (!remote) return;
      try {
        const heads = await git(['ls-remote', '--heads', remote]);
        for (const line of heads.split('\n')) add(line.split('\trefs/heads/')[1], 'remote');
      } catch { warnings.push('Remote branches could not refresh. Showing locally known branches. Check your Git credentials or connection.'); }
    })(),
    (async () => {
      try {
        const auth = JSON.parse(await execute('gh', ['auth', 'status', '--active', '--json', 'hosts'], root));
        github.accounts = Object.entries(auth.hosts || {}).flatMap(([host, accounts]) => accounts
          .filter(account => account.active).map(account => ({ host, login: account.login, state: account.state })));
        if (!github.accounts.some(account => account.state === 'success')) warnings.push('GitHub CLI has no active signed-in account. Run gh auth login, then inspect again.');
      } catch { warnings.push('GitHub CLI sign-in unavailable. Install gh or run gh auth login, then inspect again.'); }
      if (!remoteUrl || !github.accounts.length) return;
      try {
        const repo = JSON.parse(await execute('gh', ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], root));
        github.repository = { name: repo.nameWithOwner, url: safeRemote(repo.url), defaultBranch: repo.defaultBranchRef?.name || '' };
      } catch { warnings.push('GitHub repository details unavailable. Git branches remain usable.'); }
    })(),
  ]);
  const list = [...branches.values()].sort((a, b) => a.name.localeCompare(b.name));
  const preferredBranch = branches.has('develop') ? 'develop' : list.find(branch => /(^|\/)develop$/.test(branch.name))?.name || currentBranch || github.repository?.defaultBranch || list[0]?.name || '';
  const found = detectProject(root);
  return { path: path.resolve(root), name: github.repository?.name || path.basename(root), currentBranch,
    remote: remote || '', remoteUrl: safeRemote(remoteUrl), branches: list, preferredBranch,
    gitAuthor: { name: authorName, email: authorEmail }, github, warnings,
    flow: found.flowRuntime ? { available: true, ...found.flowRuntime } : null, electron: detectElectron(root),
    suggested: { setupCommand: found.setupCommand, testCommand: found.testCommand, devCommand: found.devCommand, from: found.from } };
}
let picking = false;
export async function pickRepositoryFolder() {
  if (process.platform !== 'win32') throw new Error('Paste the absolute repository path on this platform.');
  if (picking) throw new Error('A folder picker is already open.');
  picking = true;
  try {
    const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show(); $owner.Activate()
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Choose the source code Git repository for Rex Desk'
$picker.ShowNewFolderButton = $false
try { if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) } }
finally { $picker.Dispose(); $owner.Dispose() }`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 300000 });
    return { path: stdout.trim() };
  } finally { picking = false; }
}

// Clone owner/name with the signed-in GitHub CLI next to the Rex Desk folder. An existing folder is reused, never overwritten.
export async function cloneRepository(spec, parent) {
  const name = String(spec || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error('Enter a GitHub repository as owner/name, or a local folder path.');
  const target = path.join(parent, name.split('/')[1]);
  if (existsSync(target)) {
    if (!existsSync(path.join(target, '.git'))) throw new Error(`${target} already exists and is not a Git checkout.`);
    return { path: target, existed: true };
  }
  try { await exec('gh', ['repo', 'clone', name, target], { ...options, timeout: 1800000 }); }
  catch (error) { throw new Error(`GitHub could not clone ${name}: ${String(error.stderr || error.message).trim().split('\n').at(-1)} Check that the active gh account can read it (gh auth switch).`); }
  return { path: target, existed: false };
}

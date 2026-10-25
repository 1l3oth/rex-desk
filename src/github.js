import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const options = { windowsHide: true, timeout: 20000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } };
let login = null;

// Accounts come from the GitHub CLI's own keyring, so Rex Desk never sees or stores a GitHub token.
export async function githubAccounts() {
  const result = await exec('gh', ['auth', 'status', '--hostname', 'github.com'], options).catch(error => error);
  if (result.code === 'ENOENT') return { installed: false, accounts: [], login: loginState() };
  const lines = `${result.stdout || ''}\n${result.stderr || ''}`.split('\n'), accounts = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/(Logged in to|Failed to log in to) github\.com account (\S+)/);
    if (!match) continue;
    const active = lines.slice(index + 1, index + 4).some(next => /Active account: true/.test(next));
    accounts.push({ login: match[2], active, valid: match[1] === 'Logged in to' });
  }
  return { installed: true, accounts, login: loginState() };
}

function loginState() {
  return login && { state: login.state, code: login.code, url: login.url, error: login.error, account: login.account };
}

// GitHub's device flow: gh prints a one-time code, the person approves it on github.com, and gh stores the new account.
export function startGithubLogin() {
  if (login?.state === 'waiting') return Promise.resolve(loginState());
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], { windowsHide: true, env: options.env });
  login = { state: 'starting', child, output: '' };
  const current = login;
  return new Promise(resolve => {
    const read = chunk => {
      current.output += chunk;
      const code = current.output.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/), url = current.output.match(/https:\/\/github\.com\/login\/device\S*/);
      if (code && current.state === 'starting') {
        Object.assign(current, { state: 'waiting', code: code[1], url: url?.[0] || 'https://github.com/login/device' });
        spawn('cmd.exe', ['/c', 'start', '', current.url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
        resolve(loginState());
      }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.stdin.write('\n');
    child.on('error', error => { Object.assign(current, { state: 'failed', error: error.code === 'ENOENT' ? 'GitHub CLI (gh) is not installed.' : error.message }); resolve(loginState()); });
    child.on('exit', async code => {
      if (code === 0) {
        await exec('gh', ['auth', 'setup-git', '--hostname', 'github.com'], options).catch(() => {});
        const account = current.output.match(/Logged in as (\S+)/)?.[1];
        Object.assign(current, { state: 'done', account });
      } else if (current.state !== 'cancelled') Object.assign(current, { state: 'failed', error: current.output.trim().split('\n').at(-1) || `gh exited with ${code}` });
      resolve(loginState());
    });
    setTimeout(() => { if (current.state === 'starting') { current.child.kill(); Object.assign(current, { state: 'failed', error: 'GitHub did not return a sign-in code. Try again.' }); resolve(loginState()); } }, 20000);
  });
}

export function cancelGithubLogin() {
  if (login?.state === 'waiting' || login?.state === 'starting') { login.state = 'cancelled'; login.child.kill(); }
  return loginState();
}

export async function switchGithubAccount(user) {
  if (!/^[A-Za-z0-9-]+$/.test(String(user || ''))) throw new Error('Choose a signed-in GitHub account.');
  await exec('gh', ['auth', 'switch', '--hostname', 'github.com', '--user', user], options).catch(error => { throw new Error(String(error.stderr || error.message).trim()); });
  return githubAccounts();
}

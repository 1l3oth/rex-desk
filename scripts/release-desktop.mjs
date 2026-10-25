// Publishes the desktop app: build, sign with the release key, verify, then upload the installer and latest.json.
// Usage: node scripts/release-desktop.mjs [--skip-build] [--notes "What changed"]
import path from 'node:path';
import os from 'node:os';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releasesRepository, verifyInstaller } from '../src/updates.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), notes = args.includes('--notes') ? args[args.indexOf('--notes') + 1] || '' : '';
const version = JSON.parse(readFileSync(path.join(project, 'desktop/src-tauri/tauri.conf.json'), 'utf8')).version;
const cargo = readFileSync(path.join(project, 'desktop/src-tauri/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (cargo !== version) throw new Error(`Set the same version in tauri.conf.json (${version}) and Cargo.toml (${cargo}).`);
// npm is a .cmd shim on Windows and needs a shell; gh runs directly so titles and notes with spaces stay single arguments.
const run = (command, commandArgs, env = process.env) => execFileSync(command, commandArgs, { cwd: project, stdio: 'inherit', shell: command === 'npm' && process.platform === 'win32', env });
// Publish as the releases repository's owner even when another GitHub account is active; the token is passed, never printed.
const owner = releasesRepository.split('/')[0];
let ownerEnv = process.env;
try { ownerEnv = { ...process.env, GH_TOKEN: execFileSync('gh', ['auth', 'token', '--user', owner], { encoding: 'utf8' }).trim() }; }
catch { console.warn(`${owner} is not signed in to the GitHub CLI; publishing as the active account.`); }

if (!args.includes('--skip-build')) run('npm', ['run', 'build', '--prefix', 'desktop']);
const installer = path.join(project, 'desktop/src-tauri/target/release/bundle/nsis', `Rex Desk_${version}_x64-setup.exe`);
const keyFile = process.env.REX_RELEASE_KEY || path.join(os.homedir(), '.rex-desk', 'release-signing-key.pem');
const bytes = readFileSync(installer), asset = `Rex-Desk_${version}_x64-setup.exe`;
const manifest = { version, notes, publishedAt: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'),
  signature: sign(null, bytes, createPrivateKey(readFileSync(keyFile))).toString('base64'),
  url: `https://github.com/${releasesRepository}/releases/download/v${version}/${asset}` };
verifyInstaller(bytes, manifest); // The installed app trusts only the public key in src/updates.js; refuse to publish anything it would reject.

const staging = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-release-'));
copyFileSync(installer, path.join(staging, asset));
writeFileSync(path.join(staging, 'latest.json'), JSON.stringify(manifest, null, 2));
run('gh', ['release', 'create', `v${version}`, '--repo', releasesRepository, '--title', `Rex Desk ${version}`, '--notes', notes || `Rex Desk ${version}`,
  path.join(staging, asset), path.join(staging, 'latest.json')], ownerEnv);
console.log(`Published Rex Desk ${version} to ${releasesRepository}. Installed apps update within six hours, or at Settings → Updates → Check now.`);

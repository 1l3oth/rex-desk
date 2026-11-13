// Publishes built desktop installers to the downloads bucket (Cloudflare R2 or AWS S3; both speak the S3 API).
//
//   releases/<version>/<file>   every installer of one version, written once and never changed
//   <channel>/latest.json       the small pointer installed apps read; replacing it is what ships an update
//
// Usage: node scripts/release-desktop.mjs --files <folder> [--channel stable|beta] [--notes "What changed"] [--out <folder>] [--upload] [--force]
// Without --upload it only stages and signs, so the result can be inspected. The GitHub workflow "Desktop installers" runs it with --upload.
import path from 'node:path';
import os from 'node:os';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { downloadsUrl, newer, updaters, verifyInstaller } from '../src/updates.js';

export const channels = ['stable', 'beta'];
const installerTypes = /\.(exe|msi|zip|dmg|tar\.gz)$/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const walk = folder => readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]);

// Lays the release out exactly as it will sit in the bucket and signs the file each kind of computer downloads to update itself.
export function stageRelease({ files, out, channel = 'stable', notes = '', baseUrl = downloadsUrl, privateKey, publicKey, now = new Date() }) {
  if (!channels.includes(channel)) throw new Error(`Channel must be one of: ${channels.join(', ')}.`);
  const found = walk(files).filter(file => installerTypes.test(file));
  const setups = found.filter(file => /-setup\.exe$/i.test(file));
  if (setups.length !== 1) throw new Error(`Expected one Windows installer (*-setup.exe) in ${files}, found ${setups.length}.`);
  // The version is read from the installer itself, so the pointer can never name a version that was not built.
  const version = path.basename(setups[0]).match(/_(\d+\.\d+\.\d+)_/)?.[1];
  if (!version) throw new Error(`No version in the installer name ${path.basename(setups[0])}.`);
  const base = baseUrl.replace(/\/+$/, ''), folder = path.join(out, 'releases', version);
  mkdirSync(folder, { recursive: true });
  const platforms = {};
  const downloads = found.map(file => {
    const name = path.basename(file).replace(/^Rex[ .]Desk/, 'Rex-Desk').replaceAll(' ', '-'), bytes = readFileSync(file);
    copyFileSync(file, path.join(folder, name));
    const download = { name, url: `${base}/releases/${version}/${name}`, sha256: sha256(bytes), size: bytes.length };
    const platform = Object.keys(updaters).find(key => name.toLowerCase().endsWith(updaters[key]));
    if (platform) {
      platforms[platform] = { url: download.url, sha256: download.sha256, signature: sign(null, bytes, privateKey).toString('base64') };
      verifyInstaller(bytes, platforms[platform], publicKey); // Installed apps trust only the public keys in src/updates.js; refuse to publish anything they would reject.
    }
    return download;
  }).sort((a, b) => a.name.localeCompare(b.name));
  // The Windows entry is repeated at the top for the apps up to 0.0.2, which read it there.
  const manifest = { version, channel, notes, publishedAt: now.toISOString(), ...platforms['win32-x64'], platforms, downloads };
  mkdirSync(path.join(out, channel), { recursive: true });
  writeFileSync(path.join(out, channel, 'latest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

const published = async (baseUrl, channel) => {
  const response = await fetch(`${baseUrl}/${channel}/latest.json?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
  return response?.ok ? response.json() : null;
};

function upload(out, manifest) {
  const bucket = process.env.RELEASE_S3_BUCKET;
  if (!bucket) throw new Error('Set RELEASE_S3_BUCKET (and AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; RELEASE_S3_ENDPOINT for R2) to upload.');
  const endpoint = process.env.RELEASE_S3_ENDPOINT ? ['--endpoint-url', process.env.RELEASE_S3_ENDPOINT] : [];
  // R2 has one region called "auto" and rejects the extra checksums newer AWS CLIs send by default.
  // Each installer goes up in one piece: R2 now and then loses a part of a file sent in parallel pieces, and the whole upload fails.
  const settings = path.join(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-aws-')), 'config');
  writeFileSync(settings, ['[default]', 's3 =', '  multipart_threshold = 4GB', ''].join('\n'));
  const env = { ...process.env, AWS_CONFIG_FILE: settings, AWS_DEFAULT_REGION: process.env.RELEASE_S3_REGION || process.env.AWS_DEFAULT_REGION || 'auto',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' };
  const aws = args => execFileSync('aws', ['s3', ...args, ...endpoint], { stdio: 'inherit', env });
  // Installers first, pointer last: an app that reads the pointer always finds the file it names.
  aws(['cp', path.join(out, 'releases', manifest.version), `s3://${bucket}/releases/${manifest.version}`, '--recursive', '--cache-control', 'public, max-age=31536000, immutable']);
  aws(['cp', path.join(out, manifest.channel, 'latest.json'), `s3://${bucket}/${manifest.channel}/latest.json`, '--content-type', 'application/json', '--cache-control', 'no-cache']);
}

// Downloads the release back the way an installed app does and checks it, so a wrong bucket, domain or key fails here and not on someone's computer.
async function confirm(baseUrl, manifest) {
  const live = await published(baseUrl, manifest.channel);
  if (live?.version !== manifest.version) throw new Error(`${baseUrl}/${manifest.channel}/latest.json does not show ${manifest.version} after the upload. Check the bucket's public address.`);
  const response = await fetch(live.url, { signal: AbortSignal.timeout(15 * 60000) });
  if (!response.ok) throw new Error(`The published installer did not download (${response.status}): ${live.url}`);
  verifyInstaller(Buffer.from(await response.arrayBuffer()), live);
  for (const [platform, update] of Object.entries(live.platforms)) if ((await fetch(update.url, { method: 'HEAD' })).status !== 200) throw new Error(`The published ${platform} update is not reachable: ${update.url}`);
}

async function main() {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] || '' : '';
  const files = value('--files'), channel = value('--channel') || 'stable';
  if (!files || !statSync(files).isDirectory()) throw new Error('Pass --files <folder holding the built installers>.');
  const baseUrl = (process.env.RELEASE_BASE_URL || downloadsUrl).replace(/\/+$/, '');
  const pem = process.env.REX_RELEASE_KEY_PEM || readFileSync(process.env.REX_RELEASE_KEY || path.join(os.homedir(), '.rex-desk', 'release-signing-key.pem'), 'utf8');
  const out = value('--out') || mkdtempSync(path.join(os.tmpdir(), 'rex-desk-release-'));
  const manifest = stageRelease({ files, out, channel, notes: value('--notes'), baseUrl, privateKey: createPrivateKey(pem) });
  console.log(`Staged Rex Desk ${manifest.version} (${channel}) in ${out}:\n${manifest.downloads.map(download => `  ${download.name}`).join('\n')}`);
  if (!args.includes('--upload')) return;
  const current = await published(baseUrl, channel);
  if (current && !newer(manifest.version, current.version) && !args.includes('--force')) throw new Error(`${channel} already has ${current.version}; ${manifest.version} is not newer, so no installed app would take it. Raise the version.`);
  upload(out, manifest);
  await confirm(baseUrl, manifest);
  console.log(`Published Rex Desk ${manifest.version} to ${baseUrl}/${channel}/latest.json. Installed apps on ${channel} update within six hours, or at Settings → Updates → Check now.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exit(1); });

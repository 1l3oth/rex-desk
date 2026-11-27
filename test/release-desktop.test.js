import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Updates } from '../src/updates.js';
import { stageRelease, withNotes, readArgs } from '../scripts/release-desktop.mjs';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const keys = generateKeyPairSync('ed25519');
const built = () => {
  const files = temporary('built');
  mkdirSync(path.join(files, 'windows')); mkdirSync(path.join(files, 'macos'));
  writeFileSync(path.join(files, 'windows', 'Rex Desk_0.3.0_x64-setup.exe'), 'windows installer');
  writeFileSync(path.join(files, 'windows', 'Rex Desk_0.3.0_x64_en-US.msi'), 'msi');
  writeFileSync(path.join(files, 'windows', 'Rex.Desk_0.3.0_x64-portable.zip'), 'zip');
  writeFileSync(path.join(files, 'macos', 'Rex Desk_0.3.0_aarch64.dmg'), 'dmg');
  writeFileSync(path.join(files, 'macos', 'Rex Desk_0.3.0_aarch64.app.tar.gz'), 'packed mac app');
  mkdirSync(path.join(files, 'linux'));
  writeFileSync(path.join(files, 'linux', 'Rex Desk_0.3.0_amd64.deb'), 'deb');
  writeFileSync(path.join(files, 'linux', 'Rex Desk_0.3.0_amd64.AppImage'), 'linux appimage');
  return files;
};
const stage = (options = {}) => { const out = temporary('staged'); return { out, manifest: stageRelease({ files: built(), out, baseUrl: 'https://downloads.example/', privateKey: keys.privateKey, publicKey: keys.publicKey, ...options }) }; };

test('a staged release is laid out like the bucket, and an installed app accepts and downloads it', async () => {
  const { out, manifest } = stage({ channel: 'beta', notes: 'Faster checks' });
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.url, 'https://downloads.example/releases/0.3.0/Rex-Desk_0.3.0_x64-setup.exe');
  assert.deepEqual(manifest.downloads.map(download => download.name), ['Rex-Desk_0.3.0_aarch64.app.tar.gz', 'Rex-Desk_0.3.0_aarch64.dmg', 'Rex-Desk_0.3.0_amd64.AppImage', 'Rex-Desk_0.3.0_amd64.deb', 'Rex-Desk_0.3.0_x64_en-US.msi', 'Rex-Desk_0.3.0_x64-portable.zip', 'Rex-Desk_0.3.0_x64-setup.exe']);
  for (const download of manifest.downloads) assert.ok(existsSync(path.join(out, 'releases', '0.3.0', download.name)));
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'beta', 'latest.json'), 'utf8')), manifest);

  // Serve the staged folder the way the bucket would and let the real updater take it.
  const fetcher = async url => new Response(readFileSync(path.join(out, new URL(url).pathname)));
  const data = temporary('installed');
  assert.equal(manifest.platforms['win32-x64'].url, manifest.url, 'apps up to 0.0.2 read the Windows update at the top');
  const updates = new Updates(data, { version: '0.2.1', executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey, platform: 'win32-x64',
    fetcher: url => fetcher(String(url).endsWith('latest.json') ? 'https://downloads.example/beta/latest.json' : url) });
  const status = await updates.check();
  assert.equal(status.error, ''); assert.equal(status.ready, true); assert.equal(status.available.notes, 'Faster checks');

  const mac = new Updates(temporary('mac'), { version: '0.2.1', executable: '/Applications/Rex Desk.app/Contents/MacOS/rex-desk', key: keys.publicKey, platform: 'darwin-arm64',
    fetcher: url => fetcher(String(url).endsWith('latest.json') ? 'https://downloads.example/beta/latest.json' : url) });
  const macStatus = await mac.check();
  assert.equal(macStatus.error, ''); assert.equal(macStatus.ready, true);
  assert.equal(readFileSync(mac.file, 'utf8'), 'packed mac app', 'a Mac takes the packed app, never the Windows installer');

  // Linux: an AppImage copy takes the signed AppImage; a copy from the .deb is updated by apt, never by itself.
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-arm64', 'linux-x64', 'win32-x64']);
  const linux = new Updates(temporary('linux'), { version: '0.2.1', key: keys.publicKey, platform: 'linux-x64', appImage: '/home/me/Apps/Rex-Desk.AppImage',
    fetcher: url => fetcher(String(url).endsWith('latest.json') ? 'https://downloads.example/beta/latest.json' : url) });
  const linuxStatus = await linux.check();
  assert.equal(linuxStatus.error, ''); assert.equal(linuxStatus.ready, true);
  assert.equal(readFileSync(linux.file, 'utf8'), 'linux appimage');
  assert.equal(linux.executable, '/home/me/Apps/Rex-Desk.AppImage', 'the file swapped is the AppImage, not the program inside it');
  const deb = new Updates(temporary('deb'), { version: '0.2.1', executable: '/usr/bin/rex-desk', key: keys.publicKey, platform: 'linux-x64', appImage: '' });
  assert.equal(deb.status().supported, false);
});

test('a release is refused without exactly one Windows installer, with an unknown channel, or when signed by another key', () => {
  const empty = temporary('empty');
  assert.throws(() => stageRelease({ files: empty, out: temporary('out'), privateKey: keys.privateKey, publicKey: keys.publicKey }), /Expected one Windows installer/);
  assert.throws(() => stage({ channel: 'nightly' }), /Channel must be one of/);
  assert.throws(() => stage({ privateKey: generateKeyPairSync('ed25519').privateKey }), /not signed by the Rex Desk release key/);
});

test('old versions are deleted from the bucket, keeping the newest three and any version a channel names', async () => {
  const { versionsToDelete } = await import('../scripts/release-desktop.mjs');
  assert.deepEqual(versionsToDelete(['0.0.9', '0.0.10', '0.0.44', '0.0.45', '0.0.2', '0.0.45'], 3), ['0.0.9', '0.0.2']);
  assert.deepEqual(versionsToDelete(['0.0.40', '0.0.41', '0.0.42', '0.0.43', '0.0.44'], 3, ['0.0.40']), ['0.0.41']);
  assert.deepEqual(versionsToDelete(['0.0.1', 'notes', 'beta'], 3), []);
  assert.deepEqual(versionsToDelete(['0.0.1', '0.0.2'], 0), ['0.0.1'], 'never empties the bucket');
});

test('a notes correction changes only the notes of the version the channel ships, and never rolls it back', () => {
  const live = { version: '0.0.100', channel: 'stable', notes: '', url: 'https://downloads.rexdesk.dev/releases/0.0.100/a.exe', signature: 'sig', platforms: { 'win32-x64': { url: 'u', sha256: 'h', signature: 's' } } };
  const fixed = withNotes(live, '0.0.100', 'Task counts show.');
  assert.deepEqual(fixed, { ...live, notes: 'Task counts show.' }, 'installers, URLs and signatures stay the same');
  assert.throws(() => withNotes({ ...live, version: '0.0.101' }, '0.0.100', 'x'), /ships 0.0.101/, 'an older version never replaces the newer one');
  assert.throws(() => withNotes(live, '0.0.100', '  '), /empty/);
  assert.throws(() => withNotes(null, '0.0.100', 'x'), /no published/);
});

test('notes on the command line are only ever notes, never flags', () => {
  assert.deepEqual({ ...readArgs(['--notes=--force', '--channel', 'stable', '--upload']) }, { notes: '--force', channel: 'stable', upload: true });
  assert.equal(readArgs(['--notes=--prune-only']).notes, '--prune-only');
  assert.equal(readArgs(['--notes=--prune-only'])['prune-only'], undefined, 'no cleanup runs');
  assert.throws(() => readArgs(['--notes', '--force']), /ambiguous/, 'a flag-like value without = stops the script');
  assert.throws(() => readArgs(['--republish']), /Unknown option/);
});

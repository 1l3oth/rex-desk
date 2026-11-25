import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Updates, newer, verifyInstaller } from '../src/updates.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const keys = generateKeyPairSync('ed25519');
const installer = Buffer.from('fake installer bytes');
const update = (bytes = installer, privateKey = keys.privateKey) => ({ url: 'https://example.invalid/setup.exe',
  sha256: createHash('sha256').update(bytes).digest('hex'), signature: sign(null, bytes, privateKey).toString('base64') });
const manifest = (bytes, privateKey) => ({ version: '0.3.0', notes: 'Faster QA checks', ...update(bytes, privateKey), platforms: { 'win32-x64': update(bytes, privateKey) } });
const fetcher = (published, bytes = installer) => async url => url.endsWith('latest.json')
  ? new Response(JSON.stringify(published)) : new Response(bytes);

test('versions compare numerically', () => {
  assert.equal(newer('0.10.0', '0.9.9'), true); assert.equal(newer('v0.2.0', '0.2.0'), false); assert.equal(newer('0.2.0', '0.3.0'), false);
});

test('an update is installed only when its checksum and release signature match', () => {
  verifyInstaller(installer, manifest(), keys.publicKey);
  assert.throws(() => verifyInstaller(Buffer.from('tampered'), manifest(), keys.publicKey), /checksum/);
  const stranger = generateKeyPairSync('ed25519');
  assert.throws(() => verifyInstaller(installer, manifest(installer, stranger.privateKey), keys.publicKey), /not signed/);
});

test('the installed app downloads and verifies a newer release, and ignores the same or older version', async () => {
  const data = temporary('updates');
  const updates = new Updates(data, { version: '0.2.0', executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  const status = await updates.check();
  assert.equal(status.available.version, '0.3.0'); assert.equal(status.ready, true);
  assert.ok(existsSync(path.join(data, 'updates', 'Rex-Desk-0.3.0-setup.exe')));

  const forged = new Updates(temporary('forged'), { version: '0.2.0', executable: 'x', key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest(), Buffer.from('swapped')) });
  const refused = await forged.check();
  assert.equal(refused.ready, false); assert.match(refused.error, /checksum/);

  const current = new Updates(temporary('current'), { version: '0.3.0', executable: 'x', key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  assert.equal((await current.check()).available, null);
  const source = new Updates(temporary('source'), { version: '', executable: '', fetcher: fetcher(manifest()) });
  assert.equal((await source.check()).supported, false, 'A source checkout never self-updates');
  const linux = new Updates(temporary('linux'), { version: '0.2.0', executable: '/opt/rex-desk', platform: 'linux-x64', fetcher: fetcher(manifest()) });
  assert.equal((await linux.check()).supported, false, 'A computer with no update file published for it never self-updates');
});

test('checking often is cheap: an unchanged release answers 304 and keeps what was found; a failed download is tried again', async () => {
  const seen = [];
  let failNext = true;
  const etagFetcher = async (url, options = {}) => {
    if (!url.endsWith('latest.json')) { if (failNext) { failNext = false; throw new Error('network blip'); } return new Response(installer); }
    seen.push(options.headers?.['If-None-Match'] || '');
    if (options.headers?.['If-None-Match'] === '"v3"') return new Response(null, { status: 304 });
    return new Response(JSON.stringify(manifest()), { headers: { etag: '"v3"' } });
  };
  const updates = new Updates(temporary('etag'), { version: '0.2.0', executable: 'x', key: keys.publicKey, platform: 'win32-x64', fetcher: etagFetcher });
  assert.equal((await updates.check()).ready, false, 'the first download failed');
  assert.equal((await updates.check()).ready, true, 'tried again in full, not skipped as unchanged');
  const again = await updates.check();
  assert.equal(again.ready, true); assert.equal(again.available.version, '0.3.0');
  assert.deepEqual(seen, ['', '', '"v3"']);
});

test('only the newest installer is kept, and an update is not installed without room for it', async () => {
  const { writeFileSync: write, readdirSync: list } = await import('node:fs');
  const data = temporary('cleanup');
  const updates = new Updates(data, { version: '0.2.0', executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  const { mkdirSync: make } = await import('node:fs'); make(path.join(data, 'updates'), { recursive: true });
  write(path.join(data, 'updates', 'Rex-Desk-0.1.0-setup.exe'), 'old'); write(path.join(data, 'updates', 'Rex-Desk-0.1.5-setup.exe'), 'old');
  assert.equal((await updates.check()).ready, true);
  assert.deepEqual(list(path.join(data, 'updates')).filter(name => name.endsWith('.exe')), ['Rex-Desk-0.3.0-setup.exe']);
  updates.freeSpace = () => 100 * 1024 * 1024;
  assert.throws(() => updates.install(1), /Not enough free space to install the update: 100 MB free/);
});

test('the Windows update installs over the copy that is running, not where the installer would guess', async () => {
  const { readFileSync: read } = await import('node:fs');
  const data = temporary('install-folder');
  const updates = new Updates(data, { version: '0.2.0', executable: String.raw`D:\Rex Desk\rex-desk.exe`, key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  assert.equal((await updates.check()).ready, true);
  updates.freeSpace = () => 10 * 2 ** 30; let started = '';
  updates.startHelper = helper => { started = helper; };
  updates.install(1);
  const script = read(started, 'utf8'), settings = JSON.parse(read(path.join(path.dirname(started), 'install-update.json'), 'utf8'));
  assert.equal(settings.app, String.raw`D:\Rex Desk\rex-desk.exe`);
  assert.match(script, /\$folder = Split-Path -Parent \$App/);
  assert.match(script, /-ArgumentList "\/S \/D=\$folder"/, 'the installer is told the folder of the running copy');
});

test('a full drive is said in plain words: no download without room, and the card gets the reason', async () => {
  const { plainProblem } = await import('../src/updates.js');
  const data = temporary('full-drive');
  const updates = new Updates(data, { version: '0.2.0', executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  updates.freeSpace = () => 50 * 1024 * 1024;
  const status = await updates.check();
  assert.equal(status.ready, false);
  assert.match(status.error, /Not enough free space to download the update: 50 MB free/);
  assert.match(status.problem, /drive is almost full \(50 MB free\)/);
  assert.equal(status.available.version, '0.3.0', 'the card still knows which version waits');
  updates.freeSpace = () => 10 * 2 ** 30;
  assert.equal((await updates.check()).ready, true);
  assert.equal(updates.status().problem, '');
  updates.startProblem = 'Your data was not moved. The C: drive is full.';
  assert.equal(updates.status().problem, 'Your data was not moved. The C: drive is full.');
  assert.match(plainProblem(Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' }), 'C:/Users/x', () => 3 * 1048576), /^The C: drive is full \(3 MB free\)\./);
  assert.equal(plainProblem(new Error('Update download failed (500).'), data), 'Update download failed (500).');
});

test('an update that did not take (antivirus blocked it) is told on the next start, and the log is written by the server too', async () => {
  const { writeFileSync: write, readFileSync: read, mkdirSync: make } = await import('node:fs');
  const data = temporary('blocked-install'), folder = path.join(data, 'updates'), installerFile = path.join(folder, 'Rex-Desk-0.3.0-setup.exe');
  make(folder, { recursive: true }); write(installerFile, 'setup');
  const settings = version => write(path.join(folder, 'install-update.json'), JSON.stringify({ version, installer: installerFile }));
  const open = version => new Updates(data, { version, executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  settings('0.3.0'); write(path.join(folder, 'install-update.log'), '2026-11-25T10:00:00 server: installing 0.3.0\r\n');
  let failed = open('0.2.0').status().installFailed;
  assert.equal(failed.version, '0.3.0'); assert.equal(failed.installer, installerFile);
  assert.match(failed.reason, /did not start\. Your antivirus may have blocked it\. Add the Rex Desk folder to its exclusions, or run the installer yourself/);
  write(path.join(folder, 'install-update.log'), 'x update helper started\r\nx install failed after 3 tries\r\n');
  assert.match(open('0.2.0').status().installFailed.reason, /^The update did not install\. Your antivirus may have blocked it/);
  rmSync(installerFile);
  failed = open('0.2.0').status().installFailed;
  assert.match(failed.reason, /installer is gone\. Your antivirus may have removed it/); assert.equal(failed.installer, '');
  assert.equal(open('0.3.0').status().installFailed, null, 'installed: forgotten');
  assert.equal(existsSync(path.join(folder, 'install-update.json')), false);
  // Pressing Update now again clears it, and the server writes the first lines of the log itself.
  settings('0.3.0');
  const updates = open('0.2.0'); assert.ok(updates.status().installFailed);
  assert.equal((await updates.check()).ready, true);
  updates.freeSpace = () => 10 * 2 ** 30; let helper = '';
  updates.startHelper = file => { helper = file; };
  updates.install(1);
  assert.equal(updates.status().installFailed, null);
  assert.match(read(path.join(folder, 'install-update.log'), 'utf8'), /server: installing 0\.3\.0/);
  const script = read(helper, 'utf8');
  assert.match(script, /trap \{ try \{ Add-Content -Path \$Log -Value .*helper error/); assert.match(script, /Add-Content -Path \$Log -Value .*update helper started/);
  assert.doesNotMatch(script, /Set-Content -Path \$Log/, 'the helper adds to the log, it never wipes what the server wrote');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
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

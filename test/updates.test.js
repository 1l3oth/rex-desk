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
const manifest = (bytes = installer, privateKey = keys.privateKey) => ({ version: '0.3.0', notes: 'Faster QA checks', url: 'https://example.invalid/setup.exe',
  sha256: createHash('sha256').update(bytes).digest('hex'), signature: sign(null, bytes, privateKey).toString('base64') });
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
  const updates = new Updates(data, { version: '0.2.0', executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey, fetcher: fetcher(manifest()) });
  const status = await updates.check();
  assert.equal(status.available.version, '0.3.0'); assert.equal(status.ready, true);
  assert.ok(existsSync(path.join(data, 'updates', 'Rex-Desk-0.3.0-setup.exe')));

  const forged = new Updates(temporary('forged'), { version: '0.2.0', executable: 'x', key: keys.publicKey, fetcher: fetcher(manifest(), Buffer.from('swapped')) });
  const refused = await forged.check();
  assert.equal(refused.ready, false); assert.match(refused.error, /checksum/);

  const current = new Updates(temporary('current'), { version: '0.3.0', executable: 'x', key: keys.publicKey, fetcher: fetcher(manifest()) });
  assert.equal((await current.check()).available, null);
  const source = new Updates(temporary('source'), { version: '', executable: '', fetcher: fetcher(manifest()) });
  assert.equal((await source.check()).supported, false, 'A source checkout never self-updates');
});

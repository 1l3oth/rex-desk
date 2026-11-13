import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Updates } from '../src/updates.js';
import { stageRelease } from '../scripts/release-desktop.mjs';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const keys = generateKeyPairSync('ed25519');
const built = () => {
  const files = temporary('built');
  mkdirSync(path.join(files, 'windows')); mkdirSync(path.join(files, 'macos'));
  writeFileSync(path.join(files, 'windows', 'Rex Desk_0.3.0_x64-setup.exe'), 'windows installer');
  writeFileSync(path.join(files, 'windows', 'Rex Desk_0.3.0_x64_en-US.msi'), 'msi');
  writeFileSync(path.join(files, 'windows', 'Rex.Desk_0.3.0_x64-portable.zip'), 'zip');
  writeFileSync(path.join(files, 'macos', 'Rex Desk_0.3.0_aarch64.dmg'), 'dmg');
  return files;
};
const stage = (options = {}) => { const out = temporary('staged'); return { out, manifest: stageRelease({ files: built(), out, baseUrl: 'https://downloads.example/', privateKey: keys.privateKey, publicKey: keys.publicKey, ...options }) }; };

test('a staged release is laid out like the bucket, and an installed app accepts and downloads it', async () => {
  const { out, manifest } = stage({ channel: 'beta', notes: 'Faster checks' });
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.url, 'https://downloads.example/releases/0.3.0/Rex-Desk_0.3.0_x64-setup.exe');
  assert.deepEqual(manifest.downloads.map(download => download.name), ['Rex-Desk_0.3.0_aarch64.dmg', 'Rex-Desk_0.3.0_x64_en-US.msi', 'Rex-Desk_0.3.0_x64-portable.zip', 'Rex-Desk_0.3.0_x64-setup.exe']);
  for (const download of manifest.downloads) assert.ok(existsSync(path.join(out, 'releases', '0.3.0', download.name)));
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'beta', 'latest.json'), 'utf8')), manifest);

  // Serve the staged folder the way the bucket would and let the real updater take it.
  const fetcher = async url => new Response(readFileSync(path.join(out, new URL(url).pathname)));
  const data = temporary('installed');
  const updates = new Updates(data, { version: '0.2.1', executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey,
    fetcher: url => fetcher(String(url).endsWith('latest.json') ? 'https://downloads.example/beta/latest.json' : url) });
  const status = await updates.check();
  assert.equal(status.error, ''); assert.equal(status.ready, true); assert.equal(status.available.notes, 'Faster checks');
});

test('a release is refused without exactly one Windows installer, with an unknown channel, or when signed by another key', () => {
  const empty = temporary('empty');
  assert.throws(() => stageRelease({ files: empty, out: temporary('out'), privateKey: keys.privateKey, publicKey: keys.publicKey }), /Expected one Windows installer/);
  assert.throws(() => stage({ channel: 'nightly' }), /Channel must be one of/);
  assert.throws(() => stage({ privateKey: generateKeyPairSync('ed25519').privateKey }), /not signed by the Rex Desk release key/);
});

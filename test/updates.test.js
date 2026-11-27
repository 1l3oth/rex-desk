import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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
  await assert.rejects(updates.install(), /Not enough free space to install the update: 100 MB free/);
});

// A stand-in for child_process.spawn: records the call and reports the start (or an error, like antivirus refusing it).
const fakeSpawn = (calls, error) => (file, args, options) => {
  const child = new EventEmitter(); child.pid = 4242; child.unref = () => {};
  calls.push({ file, args, options });
  setImmediate(() => error ? child.emit('error', error) : child.emit('spawn'));
  return child;
};

test('Windows: the server starts the installer itself, detached, over the running copy (no PowerShell, no scheduled task)', async () => {
  const { readFileSync: read, readdirSync: list } = await import('node:fs');
  const data = temporary('install-folder');
  const updates = new Updates(data, { version: '0.2.0', executable: String.raw`D:\Rex Desk\rex-desk.exe`, key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  assert.equal((await updates.check()).ready, true);
  updates.freeSpace = () => 10 * 2 ** 30;
  const calls = []; updates.spawner = fakeSpawn(calls);
  assert.equal(await updates.install(), 'server');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, path.join(data, 'updates', 'Rex-Desk-0.3.0-setup.exe'));
  assert.deepEqual(calls[0].args, ['/P', '/R', String.raw`/D=D:\Rex Desk`], 'the installer is told the folder of the running copy, and reopens it');
  assert.equal(calls[0].options.detached, true); assert.equal(calls[0].options.windowsVerbatimArguments, true, '/D= must stay unquoted');
  assert.equal(calls[0].options.argv0, `"${calls[0].file}"`, 'the installer path keeps its quotes in the command line');
  assert.equal(calls[0].options.cwd, path.join(data, 'updates'), "it runs from the updates folder, never from Rex Desk's own folder");
  assert.equal(calls[0].options.env.REX_INSTALL_LOG, path.join(data, 'updates', 'install-update.log'), 'the installer writes its steps to the same log');
  const settings = JSON.parse(read(path.join(data, 'updates', 'install-update.json'), 'utf8'));
  assert.equal(settings.app, String.raw`D:\Rex Desk\rex-desk.exe`); assert.equal(settings.version, '0.3.0');
  const files = list(path.join(data, 'updates'));
  assert.ok(!files.some(name => /\.ps1$|\.cmd$|install-now/.test(name)), `no script or leftover request: ${files}`);
  const log = read(path.join(data, 'updates', 'install-update.log'), 'utf8');
  assert.match(log, /server: installing 0\.3\.0/); assert.match(log, /the server started the installer \(process 4242\)/);
});

test('Windows: a second install while the first is going is refused, so only one installer starts; a failed start frees it', async () => {
  const data = temporary('install-twice');
  const updates = new Updates(data, { version: '0.2.0', executable: String.raw`D:\Rex Desk\rex-desk.exe`, key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  assert.equal((await updates.check()).ready, true);
  updates.freeSpace = () => 10 * 2 ** 30;
  const calls = []; updates.spawner = fakeSpawn(calls);
  const [first, second] = await Promise.allSettled([updates.install(), updates.install()]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected'); assert.match(second.reason.message, /already installing/);
  await assert.rejects(updates.install(), /already installing/, 'still refused after the installer started, until this server ends');
  assert.equal(calls.length, 1, 'one installer only');
  const blocked = new Updates(temporary('install-retry'), { version: '0.2.0', executable: String.raw`D:\Rex Desk\rex-desk.exe`, key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  assert.equal((await blocked.check()).ready, true);
  blocked.freeSpace = () => 10 * 2 ** 30;
  blocked.spawner = fakeSpawn([], Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }));
  await assert.rejects(blocked.install(), /did not start/);
  blocked.spawner = fakeSpawn([]);
  await blocked.install();
});

test('Windows: an installer that cannot start says so, with Install manually, and the log keeps the reason; no cause is guessed', async () => {
  const { readFileSync: read } = await import('node:fs');
  const data = temporary('install-blocked');
  const updates = new Updates(data, { version: '0.2.0', executable: String.raw`D:\Rex Desk\rex-desk.exe`, key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  assert.equal((await updates.check()).ready, true);
  updates.freeSpace = () => 10 * 2 ** 30;
  updates.spawner = fakeSpawn([], Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }));
  await assert.rejects(updates.install(), /^Error: The installer did not start \(spawn EPERM\)\. Press Install manually to run it yourself\.$/);
  assert.match(read(path.join(data, 'updates', 'install-update.log'), 'utf8'), /the installer did not start: spawn EPERM/);
  // On the next start, still on 0.2.0: the card says the installer did not start.
  const next = new Updates(data, { version: '0.2.0', executable: String.raw`D:\Rex Desk\rex-desk.exe`, key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  assert.equal(next.status().installFailed.why, 'not-started');
  assert.equal(next.status().installFailed.reason, 'The installer did not start. Press Install manually to run it yourself.');
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

test('an update that did not take is told on the next start with only what is known, and the log is written by the server too', async () => {
  const { writeFileSync: write, readFileSync: read, mkdirSync: make } = await import('node:fs');
  const data = temporary('blocked-install'), folder = path.join(data, 'updates'), installerFile = path.join(folder, 'Rex-Desk-0.3.0-setup.exe');
  make(folder, { recursive: true }); write(installerFile, 'setup');
  const settings = version => write(path.join(folder, 'install-update.json'), JSON.stringify({ version, installer: installerFile }));
  const open = version => new Updates(data, { version, executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey, platform: 'win32-x64', fetcher: fetcher(manifest()) });
  settings('0.3.0'); write(path.join(folder, 'install-update.log'), '2026-11-25T10:00:00 server: installing 0.3.0\r\n');
  let failed = open('0.2.0').status().installFailed;
  assert.equal(failed.version, '0.3.0'); assert.equal(failed.installer, installerFile);
  // Only "installing" in the log: logging is best effort, so a missing line is no proof the installer never started.
  assert.equal(failed.why, 'not-installed'); assert.equal(failed.reason, 'The update did not install. Press Install manually to run the installer yourself.');
  write(path.join(folder, 'install-update.log'), '');
  assert.equal(open('0.2.0').status().installFailed.why, 'not-installed', 'an empty log claims nothing');
  rmSync(path.join(folder, 'install-update.log'));
  assert.equal(open('0.2.0').status().installFailed.why, 'not-installed', 'no log at all claims nothing');
  write(path.join(folder, 'install-update.log'), 'x server: installing 0.3.0\r\nx server: the installer did not start: spawn EPERM\r\n');
  failed = open('0.2.0').status().installFailed;
  assert.equal(failed.why, 'not-started', 'the recorded launch error is said'); assert.match(failed.reason, /^The installer did not start\. Press Install manually/);
  write(path.join(folder, 'install-update.log'), 'x server: the server started the installer (process 1)\r\n');
  failed = open('0.2.0').status().installFailed;
  assert.equal(failed.why, 'not-installed'); assert.equal(failed.stopped, '');
  assert.equal(failed.reason, 'The update did not install. Press Install manually to run the installer yourself.');
  // The installer wrote its steps and why it stopped: the card says that, as the installer wrote it.
  write(path.join(folder, 'install-update.log'), ['x server: the server started the installer (process 1)', 'x installer: started, installing into C:\\Rex Desk',
    'x installer: could not rename C:\\Rex Desk\\payload to C:\\Rex Desk\\payload.old after 10 tries (Windows error 32)',
    'x installer: stopped: Rex Desk could not move its current version aside (a file in its folder is in use), so the update stopped and the current version stays. Run the update again in a minute.', ''].join('\r\n'));
  failed = open('0.2.0').status().installFailed;
  assert.equal(failed.why, 'not-installed');
  assert.match(failed.stopped, /^Rex Desk could not move its current version aside \(a file in its folder is in use\)/);
  assert.equal(failed.reason, `The installer stopped: ${failed.stopped}`);
  assert.match(failed.log, /Windows error 32/);
  rmSync(installerFile);
  failed = open('0.2.0').status().installFailed;
  assert.equal(failed.why, 'gone'); assert.match(failed.reason, /installer is gone, so the update could not run/); assert.equal(failed.installer, '');
  assert.doesNotMatch(failed.reason, /antivirus/i, 'no cause is guessed');
  assert.equal(open('0.3.0').status().installFailed, null, 'installed: forgotten');
  assert.equal(existsSync(path.join(folder, 'install-update.json')), false);
  // Pressing Update now again clears it, and the server writes the first lines of the log itself.
  settings('0.3.0');
  const updates = open('0.2.0'); assert.ok(updates.status().installFailed);
  assert.equal((await updates.check()).ready, true);
  updates.freeSpace = () => 10 * 2 ** 30; updates.spawner = fakeSpawn([]);
  await updates.install();
  assert.equal(updates.status().installFailed, null);
  assert.match(read(path.join(folder, 'install-update.log'), 'utf8'), /server: installing 0\.3\.0/);
});

test('Linux: an AppImage update swaps the file in one rename beside the old one, closes the app first, and reopens it', async () => {
  const { appImageInstallScript } = await import('../src/updates.js');
  const script = appImageInstallScript({ serverPid: 4242, update: "/home/me/.local/share/Rex Desk/updates/Rex-Desk-0.3.0.appimage", appImage: "/home/me/Apps/it's Rex.AppImage", log: '/tmp/install-update.log' });
  assert.match(script, /kill -0 4242/, 'waits for the server to end');
  assert.ok(script.includes(String.raw`APP='/home/me/Apps/it'\''s Rex.AppImage'`), 'quotes the path safely');
  assert.match(script, /cp '\/home\/me\/\.local\/share\/Rex Desk\/updates\/Rex-Desk-0\.3\.0\.appimage' "\$NEW" && chmod 755 "\$NEW" && mv -f "\$NEW" "\$APP"/);
  assert.match(script, /else rm -f "\$NEW"; echo "Swap failed, kept the old AppImage"/, 'a failed copy keeps the old AppImage');
  assert.match(script, /nohup "\$APP"/, 'opens Rex Desk again either way');
});

test('Windows: a copy from the .msi (Program Files) never runs the per-user installer over itself; IT updates it with the newer .msi', async () => {
  const { Updates, fromMsi } = await import('../src/updates.js');
  const win = (...parts) => path.win32.join('C:\\', ...parts);
  const env = { ProgramFiles: win('Program Files'), 'ProgramFiles(x86)': win('Program Files (x86)') };
  assert.equal(fromMsi(win('Program Files', 'Rex Desk', 'rex-desk.exe'), env), true);
  assert.equal(fromMsi(win('program files', 'Rex Desk', 'rex-desk.exe'), env), true, 'any letter case');
  assert.equal(fromMsi(win('Users', 'me', 'AppData', 'Local', 'Rex Desk', 'rex-desk.exe'), env), false);
  assert.equal(fromMsi(win('Program Files Extra', 'rex-desk.exe'), env), false);
  const data = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-msi-'));
  assert.equal(new Updates(data, { version: '0.1.0', executable: win('Program Files', 'Rex Desk', 'rex-desk.exe'), platform: 'win32-x64', msi: () => true }).status().supported, false);
  assert.equal(new Updates(data, { version: '0.1.0', executable: win('Users', 'me', 'AppData', 'Local', 'Rex Desk', 'rex-desk.exe'), platform: 'win32-x64', msi: () => false }).status().supported, true);
});

// Install manually: the installer is shown selected in a visible Explorer window. /select takes the quoted path as one word,
// so it is passed as written; no hidden window. Finder and the Linux file manager show the folder, as before.
test('Install manually shows the installer selected in a visible Explorer window, and says so when it cannot open', async () => {
  const { writeFileSync: write, mkdirSync: make } = await import('node:fs');
  const data = temporary('reveal with spaces'), folder = path.join(data, 'updates'), installerFile = path.join(folder, 'Rex Desk_0.3.0_x64-setup.exe');
  make(folder, { recursive: true }); write(installerFile, 'setup');
  write(path.join(folder, 'install-update.json'), JSON.stringify({ version: '0.3.0', installer: installerFile }));
  const open = platform => new Updates(data, { version: '0.2.0', executable: 'C:/Rex Desk/rex-desk.exe', key: keys.publicKey, platform, appImage: '/opt/Rex.AppImage', fetcher: fetcher(manifest()) });
  const windows = open('win32-x64'), calls = []; windows.spawner = fakeSpawn(calls);
  assert.deepEqual(await windows.reveal(), { opened: true, file: installerFile });
  assert.equal(calls[0].file, 'explorer.exe');
  assert.deepEqual(calls[0].args, [`/select,"${installerFile}"`], 'the whole path, spaces and all, in quotes');
  assert.equal(calls[0].options.windowsVerbatimArguments, true, 'passed as written, so the quotes reach Explorer');
  assert.equal(calls[0].options.windowsHide, undefined, 'never a hidden window');
  assert.equal(calls[0].options.detached, true);
  // Explorer could not be started: the card gets the folder to open by hand.
  windows.spawner = fakeSpawn([], Object.assign(new Error('spawn explorer.exe ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual(await windows.reveal(), { opened: false, folder: path.resolve(folder) });
  for (const [platform, command] of [['darwin-arm64', 'open'], ['linux-x64', 'xdg-open']]) {
    const other = open(platform), seen = []; other.spawner = fakeSpawn(seen);
    if (!other.state.installFailed) other.state.installFailed = { installer: installerFile };
    await other.reveal();
    assert.equal(seen[0].file, command); assert.deepEqual(seen[0].args, [path.resolve(folder)], `${platform}: the folder, as before`);
  }
  // An installer outside the updates folder is never shown.
  windows.state.installFailed = { installer: path.join(data, 'elsewhere.exe') }; write(path.join(data, 'elsewhere.exe'), 'x');
  assert.throws(() => windows.reveal(), /not in the updates folder/);
});

test('Windows installer: the install folder reaches PowerShell through an environment variable, and one leftover process is still counted', async () => {
  const { readFileSync: read } = await import('node:fs');
  const hooks = read(new URL('../desktop/src-tauri/windows/hooks.nsh', import.meta.url), 'utf8');
  const written = hooks.split(/\r?\n/).filter(line => /^\s*FileWrite \$RexFile `/.test(line));
  const script = written.map(line => line.replace(/^\s*FileWrite \$RexFile `/, '').replace(/\$\\r\$\\n`$/, '')).join('\n');
  assert.equal(written.length, 9);
  for (const line of written) assert.ok(line.trim().length < 1000, 'one NSIS string holds at most 1024 characters, so no line may be cut short');
  assert.doesNotMatch(script, /\$INSTDIR/, String.raw`the path is never inside the script text, so D:\O'Brien\Rex Desk cannot break its quotes`);
  assert.match(hooks, /nsExec::ExecToStack `powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "\$PLUGINSDIR\\rex-close\.ps1"`/);
  assert.match(script, /\$\$p = @\(& \$\$q\);/); assert.match(script, /\$\$left = @\(& \$\$q\)/);
});

test('Windows installer: an empty, unset or drive-root folder stops no program, and only programs inside the folder match', async () => {
  const { readFileSync: read } = await import('node:fs');
  const hooks = read(new URL('../desktop/src-tauri/windows/hooks.nsh', import.meta.url), 'utf8');
  const block = hooks.slice(hooks.indexOf('StrLen $RexT1 "$INSTDIR"'), hooks.indexOf('nsExec::ExecToStack `powershell.exe'));
  // The installer: a short folder (empty or a drive root) or a variable that did not read back as written skips the step.
  assert.match(block, /\$\{If\} \$RexT1 <= 3/);
  assert.match(block, /SetEnvironmentVariableW\(w "REX_INSTALL_DIR", w "\$INSTDIR\\"\) i \.s'\r?\n\s*Pop \$RexResult\r?\n\s*ReadEnvStr \$RexT2 REX_INSTALL_DIR/);
  assert.match(block, /\$\{If\} \$RexResult == 0\r?\n\s*\$\{OrIf\} \$RexT2 != "\$INSTDIR\\"/);
  assert.match(hooks, /\$\{If\} \$RexOk != ""\r?\n\s*!insertmacro RexNote "skipped closing programs, nothing was stopped: \$RexOk"\r?\n\s*\$\{Else\}\r?\n\s*nsExec::ExecToStack/);
  // The script itself: every check comes before any program is listed, each one exits, and the match is plain text on "<folder>\".
  const script = block.split(/\r?\n/).filter(line => /^\s*FileWrite \$RexFile `/.test(line)).join('\n');
  const list = script.indexOf('Get-CimInstance');
  for (const check of [/-notmatch '\^\[A-Za-z\]:\\\\\[\^\\\\\]'/, /GetFullPath/, /GetPathRoot/]) { const at = script.search(check); assert.ok(at > 0 && at < list, String(check)); }
  assert.equal((script.slice(0, list).match(/exit 3/g) || []).length, 3);
  assert.match(script, /\$\$f = \$\$f \+ '\\'/);
  assert.match(script, /ExecutablePath\.StartsWith\(\$\$f, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.doesNotMatch(script, /ExecutablePath -like|ExecutablePath -match|-Filter/, 'no wildcard or pattern match on the path');
});

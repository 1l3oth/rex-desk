import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statfsSync } from 'node:fs';
import os from 'node:os';

// Free space an install needs on the drive of the temp folder: the installer unpacks there first. On a full drive the
// 0.0.15 install wrote an empty node.exe and Rex Desk could not start.
const INSTALL_ROOM = 500 * 1024 * 1024;
export const freeSpace = folder => { try { const disk = statfsSync(folder); return Number(disk.bavail) * Number(disk.bsize); } catch { return Infinity; } };
// The drive a folder is on, for messages: "C:" on Windows, the folder itself elsewhere.
export const driveOf = folder => { const resolved = path.resolve(String(folder || '.')); return /^[a-z]:/i.test(resolved) ? resolved.slice(0, 2).toUpperCase() : resolved; };
const mb = bytes => Math.max(0, Math.round(bytes / 1048576));
// A full drive is the usual reason an update or a data move stops (ENOSPC), so it is said in plain words with how much is free.
export function plainProblem(error, folder, free = freeSpace) {
  const message = String(error?.message || error || '');
  if (error?.code === 'ENOSPC' || /ENOSPC|no space left/i.test(message)) { const left = folder ? free(folder) : Infinity; return `The ${driveOf(folder)} drive is full${Number.isFinite(left) ? ` (${mb(left)} MB free)` : ''}. Free some space, then try again.`; }
  return message;
}
import { spawn } from 'node:child_process';

// Installers are published with an Ed25519 signature made by the release key, which only the release workflow holds.
// The app trusts only the public keys below, so an installer changed in the downloads bucket or on the way is refused.
// Two keys are trusted: the first sealed the releases up to 0.2.1, the second seals the ones the release workflow publishes.
const releaseKeys = ['MCowBQYDK2VwAyEAJmCa3mqqjlD4lVjyGWHafrS3Sye2kdJDtyPJ1WndQtw=', 'MCowBQYDK2VwAyEA6MpHcyNjV9KlhtbrEsVhnAh+xCmlLoOXY0bJduoeXjk=']
  .map(key => createPublicKey(`-----BEGIN PUBLIC KEY-----
${key}
-----END PUBLIC KEY-----`));
// The downloads bucket behind an address Rex Desk owns, so the storage behind it can change without stranding installed apps.
export const downloadsUrl = 'https://downloads.rexdesk.dev';
// REX_UPDATE_CHANNEL=beta makes an installed app follow test releases; everyone else stays on stable.
const manifestUrl = () => process.env.REX_UPDATE_MANIFEST || `${downloadsUrl}/${process.env.REX_UPDATE_CHANNEL || 'stable'}/latest.json`;

export function newer(candidate, current) {
  const parts = value => String(value || '').replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}
export function verifyInstaller(bytes, manifest, key = releaseKeys) {
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('The downloaded update does not match its published checksum.');
  if (![key].flat().some(trusted => verify(null, bytes, trusted, Buffer.from(manifest.signature || '', 'base64')))) throw new Error('The downloaded update is not signed by the Rex Desk release key.');
}

// What each kind of computer downloads to update itself: Windows runs an installer, a Mac swaps in a packed copy of the app.
// The keys are Node's platform and processor names, and they name the entries under "platforms" in latest.json.
export const updaters = { 'win32-x64': '-setup.exe', 'darwin-arm64': '.app.tar.gz' };

const quoted = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
// The Mac helper: waits for the server to exit, closes the app, unpacks the new app beside the old one (same disk, so the
// swap is a rename), and reopens Rex Desk. When anything fails the old app is put back and opened, so nobody is left without it.
export function macInstallScript({ serverPid, archive, app, log }) {
  return `#!/bin/sh
exec >${quoted(log)} 2>&1
APP=${quoted(app)}
tries=0; while kill -0 ${Number(serverPid)} 2>/dev/null && [ $tries -lt 120 ]; do sleep 0.5; tries=$((tries+1)); done
pkill -f "$APP/Contents/" ; sleep 2
WORK=$(mktemp -d "$(dirname "$APP")/.rex-desk-update.XXXXXX") || { echo "Cannot write beside $APP"; open "$APP"; exit 1; }
if tar -xzf ${quoted(archive)} -C "$WORK" && NEW=$(find "$WORK" -maxdepth 1 -name '*.app' | head -1) && [ -n "$NEW" ] && mv "$APP" "$WORK/old" ; then
  if mv "$NEW" "$APP"; then xattr -cr "$APP" 2>/dev/null; echo "Updated $APP"; else mv "$WORK/old" "$APP"; echo "Swap failed, kept the old app"; fi
else echo "Unpack failed, kept the old app"; fi
rm -rf "$WORK"
open "$APP"
`;
}

// Only the installed desktop app updates itself; a source checkout updates through Git.
export class Updates {
  constructor(dataDirectory, { fetcher = fetch, version = process.env.REX_DESK_VERSION, executable = process.env.REX_DESK_EXE, key = releaseKeys, platform = `${process.platform}-${process.arch}` } = {}) {
    Object.assign(this, { fetcher, version, executable, key, platform, directory: path.join(dataDirectory, 'updates') });
    this.state = { supported: Boolean(version && executable && updaters[platform]), current: version || '', stage: 'Beta', checkedAt: '', available: null, ready: false, error: '', installFailed: null };
    this.state.installFailed = this.lastInstall();
  }
  // The last install this copy started (install-update.json names its version). Still on an older version now means it did not
  // take: antivirus such as Kaspersky blocks the silent installer or the helper that runs it, or removes the downloaded file.
  // The log says how far it got. A finished install (this copy is that version or newer) is forgotten.
  lastInstall() {
    if (!this.state.supported) return null;
    const settingsFile = path.join(this.directory, 'install-update.json');
    let settings; try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return null; }
    if (!settings?.version || !newer(settings.version, this.version)) { rmSync(settingsFile, { force: true }); return null; }
    let log = ''; try { log = readFileSync(path.join(this.directory, 'install-update.log'), 'utf8'); } catch { /* never written */ }
    const installer = String(settings.installer || ''), gone = !installer || !existsSync(installer);
    const reason = gone ? 'The downloaded installer is gone. Your antivirus may have removed it. Add the Rex Desk folder to its exclusions, then check for updates again.'
      : !/started the installer/.test(log) ? 'The installer did not start. Your antivirus may have blocked it. Add the Rex Desk folder to its exclusions, or press Install manually and run it yourself.'
        : 'The update did not install. Your antivirus may have blocked it. Add the Rex Desk folder to its exclusions, or press Install manually and run it yourself.';
    return { version: String(settings.version), reason, installer: gone ? '' : installer, log: log.trim().split(/\r?\n/).slice(-6).join('\n') };
  }
  // Writes one line to install-update.log from this server, so the log exists and says what happened even when the installer
  // never runs (it was missing on a computer where antivirus stopped the update).
  note(text) { try { mkdirSync(this.directory, { recursive: true }); appendFileSync(path.join(this.directory, 'install-update.log'), `${new Date().toISOString().slice(0, 19)} server: ${text}\r\n`); } catch { /* best effort */ } }
  // problem: why updating cannot go on right now, in plain words (the drive is full, the last start could not move the data
  // or get its port). The update card shows it instead of a bare "Cannot reach your computer".
  status() {
    const free = (this.freeSpace || freeSpace)(existsSync(this.directory) ? this.directory : path.dirname(this.directory));
    const disk = this.state.supported && free < INSTALL_ROOM ? `The ${driveOf(this.directory)} drive is almost full (${mb(free)} MB free). Rex Desk needs 500 MB to update. Free some space, then try again.` : '';
    return { ...this.state, problem: this.startProblem || disk || (/free space|drive is full/i.test(this.state.error) ? this.state.error : '') };
  }
  async check() {
    if (!this.state.supported || this.checking) return this.status();
    this.checking = true;
    try {
      // Asked with the last answer's ETag: while nothing is new the bucket answers 304 with no body, so checking often is cheap.
      const headers = this.etag && this.state.checkedAt ? { 'If-None-Match': this.etag } : {};
      const response = await this.fetcher(manifestUrl(), { redirect: 'follow', signal: AbortSignal.timeout(20000), headers });
      if (response.status === 304) { Object.assign(this.state, { checkedAt: new Date().toISOString(), error: '' }); return this.status(); }
      // Kept only once this answer is fully handled (a failed download must be tried again, not skipped as unchanged).
      const etag = response.headers?.get?.('etag') || ''; this.etag = '';
      if (response.status === 404) { Object.assign(this.state, { checkedAt: new Date().toISOString(), available: null, error: '' }); return this.status(); }
      if (!response.ok) throw new Error(`Update check failed (${response.status}).`);
      const manifest = await response.json();
      Object.assign(this.state, { checkedAt: new Date().toISOString(), error: '' });
      if (!newer(manifest.version, this.version)) { Object.assign(this.state, { available: null, ready: false }); this.etag = etag; return this.status(); }
      const update = manifest.platforms?.[this.platform];
      if (!update) { Object.assign(this.state, { available: null, ready: false }); return this.status(); }
      this.state.available = { version: manifest.version, notes: String(manifest.notes || '').slice(0, 4000), publishedAt: manifest.publishedAt || '' };
      await this.download(manifest.version, update);
      this.etag = etag;
    } catch (error) { this.state.error = plainProblem(error, this.directory, this.freeSpace || freeSpace); }
    finally { this.checking = false; }
    return this.status();
  }
  // Download once, verify, and keep it until the person restarts to install.
  async download(version, update) {
    const file = path.join(this.directory, `Rex-Desk-${String(version).replace(/[^0-9.]/g, '')}${updaters[this.platform]}`);
    if (this.file === file && this.state.ready) return;
    mkdirSync(this.directory, { recursive: true });
    // Only the newest installer is kept: older ones are not needed and took hundreds of MB on a nearly full drive.
    for (const name of readdirSync(this.directory)) if (/^Rex-Desk-.+-setup\.exe$|^Rex-Desk-.+\.app\.tar\.gz$/i.test(name) && path.join(this.directory, name) !== file) rmSync(path.join(this.directory, name), { force: true });
    let bytes = existsSync(file) ? readFileSync(file) : null;
    if (!bytes) {
      const free = (this.freeSpace || freeSpace)(this.directory), need = Math.max(INSTALL_ROOM, 2 * (Number(update.size) || 0));
      if (free < need) throw new Error(`Not enough free space to download the update: ${mb(free)} MB free on the ${driveOf(this.directory)} drive, and it needs ${mb(need)} MB. Free some space and Rex Desk tries again by itself.`);
      const response = await this.fetcher(update.url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60000) });
      if (!response.ok) throw new Error(`Update download failed (${response.status}).`);
      // Read in pieces so the update card can show how much has arrived (state.downloading), as it arrives.
      const total = Number(response.headers?.get?.('content-length')) || 0, parts = [];
      this.state.downloading = { version, received: 0, total };
      try {
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); this.state.downloading = { version, received: this.state.downloading.received + value.length, total }; this.onProgress?.(); }
          bytes = Buffer.concat(parts);
        } else bytes = Buffer.from(await response.arrayBuffer());
      } finally { this.state.downloading = null; }
    }
    try { verifyInstaller(bytes, update, this.key); } catch (error) { rmSync(file, { force: true }); throw error; }
    try { writeFileSync(file, bytes); } catch (error) { rmSync(file, { force: true }); throw new Error(plainProblem(error, this.directory, this.freeSpace || freeSpace)); } this.file = file; this.state.ready = true;
  }
  // Windows: the signed-by-us NSIS installer runs by itself, nothing in between. It closes Rex Desk (its own pre-install step
  // stops everything running from the install folder), installs over this copy, and reopens it (/R). /P shows its small
  // progress window without asking anything.
  // There used to be a PowerShell helper started through Task Scheduler (with Windows Explorer and a .cmd file as the
  // fallback). Kaspersky took that for malware ("PDM:Exploit.Win32.Generic" on node.exe: a script written to disk and run
  // with -ExecutionPolicy Bypass through a scheduled task) and blocked every update on that computer.
  // When the Rex Desk window is open, it starts the installer (rex-desk.exe is the program the person opened, outside any
  // job that would end the installer with it). With no window (Rex Desk running in the background), or an older window that
  // does not know this request, this server starts the installer itself, detached, so it keeps running after this server
  // ends. Returns who started it.
  async install() {
    if (!this.state.ready || !this.file) throw new Error('No checked update is ready yet.');
    // The installer unpacks in the temp folder and writes into the app's folder: both drives need room.
    for (const folder of [os.tmpdir(), this.executable ? path.dirname(this.executable) : ''].filter(Boolean)) {
      const free = (this.freeSpace || freeSpace)(folder);
      if (free < INSTALL_ROOM) throw new Error(`Not enough free space to install the update: ${mb(free)} MB free on the ${driveOf(folder)} drive, and it needs 500 MB. Free some space, then press Update now again.`);
    }
    this.state.installFailed = null;
    rmSync(path.join(this.directory, 'install-update.log'), { force: true });
    const version = this.state.available?.version || '';
    this.note(`installing ${version} from ${this.file}`);
    if (this.platform.startsWith('darwin')) {
      // The executable is "Rex Desk.app/Contents/MacOS/rex-desk"; the app is the folder three levels up.
      const helper = path.join(this.directory, 'install-update.sh');
      writeFileSync(helper, macInstallScript({ serverPid: process.pid, archive: this.file, app: path.resolve(this.executable, '../../..'), log: path.join(this.directory, 'install-update.log') }));
      spawn('/bin/sh', [helper], { detached: true, stdio: 'ignore' }).unref();
      return 'helper';
    }
    // Remembered for the next start: still on an older version then means the install did not take (see lastInstall).
    const folder = path.dirname(this.executable);
    writeFileSync(path.join(this.directory, 'install-update.json'), JSON.stringify({ version, installer: this.file, app: this.executable, at: new Date().toISOString() }));
    if (await this.askWindow(folder)) return 'window';
    await this.launch(folder);
    return 'server';
  }
  // The window takes a request file (renames it, so only one of them starts the installer) and answers in a result file.
  async askWindow(folder) {
    const request = path.join(this.directory, 'install-now.txt'), result = path.join(this.directory, 'install-now.result.txt'), taken = `${request}.taken`;
    for (const file of [result, taken]) rmSync(file, { force: true });
    writeFileSync(request, `${this.file}\n${folder}\n`);
    const wait = this.windowWait ?? 4000, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let waited = 0; waited < wait && existsSync(request); waited += 100) await pause(100);
    if (existsSync(request)) { rmSync(request, { force: true }); this.note('no Rex Desk window took the update, so the server starts the installer'); return false; }
    // Taken: the window says within a few seconds whether the installer started.
    for (let waited = 0; waited < 10000 && !existsSync(result); waited += 100) await pause(100);
    const answer = existsSync(result) ? readFileSync(result, 'utf8').trim() : '';
    if (answer === 'ok') { this.note('the Rex Desk window started the installer'); return true; }
    this.note(`the Rex Desk window could not start the installer (${answer || 'no answer'}), so the server tries`);
    return false;
  }
  // Started detached and outside this server's console, with the command line written as is: NSIS reads /D= only as the
  // last word, unquoted, even when the folder has spaces. Written as is, the installer's own path would lose its quotes and
  // NSIS would read the rest of a path with spaces as options, so it is quoted by hand (argv0).
  launch(folder) {
    return new Promise((resolve, reject) => {
      let child;
      const failed = error => { const reason = plainProblem(error, this.directory, this.freeSpace || freeSpace); this.note(`the installer did not start: ${reason}`); reject(new Error(`The installer did not start (${reason}). Your antivirus may have blocked it. Press Install manually to run it yourself.`)); };
      try { child = (this.spawner || spawn)(this.file, ['/P', '/R', `/D=${folder}`], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, argv0: `"${this.file}"` }); }
      catch (error) { failed(error); return; }
      child.once('error', failed);
      child.once('spawn', () => { this.note(`the server started the installer (process ${child.pid})`); child.unref(); resolve(); });
    });
  }
}

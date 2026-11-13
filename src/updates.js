import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

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
    this.state = { supported: Boolean(version && executable && updaters[platform]), current: version || '', stage: 'Beta', checkedAt: '', available: null, ready: false, error: '' };
  }
  status() { return { ...this.state }; }
  async check() {
    if (!this.state.supported || this.checking) return this.status();
    this.checking = true;
    try {
      const response = await this.fetcher(manifestUrl(), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (response.status === 404) { Object.assign(this.state, { checkedAt: new Date().toISOString(), available: null, error: '' }); return this.status(); }
      if (!response.ok) throw new Error(`Update check failed (${response.status}).`);
      const manifest = await response.json();
      Object.assign(this.state, { checkedAt: new Date().toISOString(), error: '' });
      if (!newer(manifest.version, this.version)) { Object.assign(this.state, { available: null, ready: false }); return this.status(); }
      const update = manifest.platforms?.[this.platform];
      if (!update) { Object.assign(this.state, { available: null, ready: false }); return this.status(); }
      this.state.available = { version: manifest.version, notes: String(manifest.notes || '').slice(0, 4000), publishedAt: manifest.publishedAt || '' };
      await this.download(manifest.version, update);
    } catch (error) { this.state.error = error.message; }
    finally { this.checking = false; }
    return this.status();
  }
  // Download once, verify, and keep it until the person restarts to install.
  async download(version, update) {
    const file = path.join(this.directory, `Rex-Desk-${String(version).replace(/[^0-9.]/g, '')}${updaters[this.platform]}`);
    if (this.file === file && this.state.ready) return;
    mkdirSync(this.directory, { recursive: true });
    let bytes = existsSync(file) ? readFileSync(file) : null;
    if (!bytes) {
      const response = await this.fetcher(update.url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60000) });
      if (!response.ok) throw new Error(`Update download failed (${response.status}).`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    try { verifyInstaller(bytes, update, this.key); } catch (error) { rmSync(file, { force: true }); throw error; }
    writeFileSync(file, bytes); this.file = file; this.state.ready = true;
  }
  // A helper waits for this server to exit, closes the app window, runs the installer silently, and reopens Rex Desk.
  // Windows creates it through WMI: a child of this server would be killed when the server exits, and a detached
  // PowerShell has no console and never starts. A WMI-created process inherits no environment, so values go as arguments.
  install(serverPid) {
    if (!this.state.ready || !this.file) throw new Error('No verified update is ready yet.');
    if (this.platform.startsWith('darwin')) {
      // The executable is "Rex Desk.app/Contents/MacOS/rex-desk"; the app is the folder three levels up.
      const helper = path.join(this.directory, 'install-update.sh');
      writeFileSync(helper, macInstallScript({ serverPid, archive: this.file, app: path.resolve(this.executable, '../../..'), log: path.join(this.directory, 'install-update.log') }));
      spawn('/bin/sh', [helper], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    const helper = path.join(this.directory, 'install-update.ps1');
    writeFileSync(path.join(this.directory, 'install-update.json'), JSON.stringify({ serverPid: Number(serverPid), installer: this.file, app: this.executable, log: path.join(this.directory, 'install-update.log') }));
    writeFileSync(helper, [
      '$settings = Get-Content -Raw (Join-Path $PSScriptRoot "install-update.json") | ConvertFrom-Json',
      '$ServerPid = [int]$settings.serverPid; $Installer = $settings.installer; $App = $settings.app; $Log = $settings.log',
      // Each step is written as it happens (a transcript is lost if the helper is cut off), so a stuck update shows where.
      'function Step($text) { Add-Content -Path $Log -Value "$(Get-Date -Format s) $text" }',
      'Set-Content -Path $Log -Value "$(Get-Date -Format s) update helper started"',
      'Wait-Process -Id $ServerPid -Timeout 60 -ErrorAction SilentlyContinue',
      'Step "server stopped"',
      // The window and any bundled Node still running from the install folder would lock files the installer replaces.
      '$folder = Split-Path -Parent $App',
      'Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue',
      'Start-Sleep -Seconds 2',
      'Step "installing"',
      // Waits for the installer process only (-Wait would also wait for anything the installer starts).
      'try { $setup = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru; $setup.WaitForExit(); Step "installer exit code $($setup.ExitCode)" } catch { Step "installer failed: $($_.Exception.Message)" }',
      // Rex Desk opens again whatever happened, so an update never leaves it closed.
      'Start-Process -FilePath $App; Step "app opened"',
      'schtasks.exe /Delete /TN "Rex Desk update" /F | Out-Null',
      'Step "done"',
    ].join('\r\n'));
    // Task Scheduler runs the helper in this person's desktop session, outside this server's process tree and free of the
    // memory limits a WMI-created process gets (which cut the installer off mid-copy). Settings travel in the JSON beside it.
    const task = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helper}"`;
    if (task.length > 260) throw new Error('The update folder path is too long for Windows Task Scheduler.');
    execFileSync('schtasks.exe', ['/Create', '/TN', 'Rex Desk update', '/TR', task, '/SC', 'ONCE', '/ST', '00:00', '/RL', 'LIMITED', '/F'], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
    execFileSync('schtasks.exe', ['/Run', '/TN', 'Rex Desk update'], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
  }
}

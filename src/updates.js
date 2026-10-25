import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Installers are published with an Ed25519 signature made by the release key that never leaves the publisher's computer.
// The app trusts only this public key, so a changed manifest or installer is refused.
const releaseKey = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJmCa3mqqjlD4lVjyGWHafrS3Sye2kdJDtyPJ1WndQtw=
-----END PUBLIC KEY-----`);
export const releasesRepository = process.env.REX_RELEASES_REPO || 'DaraBoth/rex-desk-releases';
const manifestUrl = () => process.env.REX_UPDATE_MANIFEST || `https://github.com/${releasesRepository}/releases/latest/download/latest.json`;

export function newer(candidate, current) {
  const parts = value => String(value || '').replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}
export function verifyInstaller(bytes, manifest, key = releaseKey) {
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('The downloaded update does not match its published checksum.');
  if (!verify(null, bytes, key, Buffer.from(manifest.signature || '', 'base64'))) throw new Error('The downloaded update is not signed by the Rex Desk release key.');
}

// Only the installed desktop app updates itself; a source checkout updates through Git.
export class Updates {
  constructor(dataDirectory, { fetcher = fetch, version = process.env.REX_DESK_VERSION, executable = process.env.REX_DESK_EXE, key = releaseKey } = {}) {
    Object.assign(this, { fetcher, version, executable, key, directory: path.join(dataDirectory, 'updates') });
    this.state = { supported: Boolean(version && executable), current: version || '', checkedAt: '', available: null, ready: false, error: '' };
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
      this.state.available = { version: manifest.version, notes: String(manifest.notes || '').slice(0, 4000), publishedAt: manifest.publishedAt || '' };
      await this.download(manifest);
    } catch (error) { this.state.error = error.message; }
    finally { this.checking = false; }
    return this.status();
  }
  // Download once, verify, and keep it until the person restarts to install.
  async download(manifest) {
    const file = path.join(this.directory, `Rex-Desk-${manifest.version}-setup.exe`);
    if (this.file === file && this.state.ready) return;
    mkdirSync(this.directory, { recursive: true });
    let bytes = existsSync(file) ? readFileSync(file) : null;
    if (!bytes) {
      const response = await this.fetcher(manifest.url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60000) });
      if (!response.ok) throw new Error(`Update download failed (${response.status}).`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    try { verifyInstaller(bytes, manifest, this.key); } catch (error) { rmSync(file, { force: true }); throw error; }
    writeFileSync(file, bytes); this.file = file; this.state.ready = true;
  }
  // A helper waits for this server to exit, closes the app window, runs the installer silently, and reopens Rex Desk.
  // Windows creates it through WMI: a child of this server would be killed when the server exits, and a detached
  // PowerShell has no console and never starts. A WMI-created process inherits no environment, so values go as arguments.
  install(serverPid) {
    if (!this.state.ready || !this.file) throw new Error('No verified update is ready yet.');
    const helper = path.join(this.directory, 'install-update.ps1');
    writeFileSync(path.join(this.directory, 'install-update.json'), JSON.stringify({ serverPid: Number(serverPid), installer: this.file, app: this.executable, log: path.join(this.directory, 'install-update.log') }));
    writeFileSync(helper, [
      '$settings = Get-Content -Raw (Join-Path $PSScriptRoot "install-update.json") | ConvertFrom-Json',
      '$ServerPid = [int]$settings.serverPid; $Installer = $settings.installer; $App = $settings.app; $Log = $settings.log',
      'Start-Transcript -Path $Log -Force | Out-Null',
      'Wait-Process -Id $ServerPid -Timeout 60 -ErrorAction SilentlyContinue',
      // The window and any bundled Node still running from the install folder would lock files the installer replaces.
      '$folder = Split-Path -Parent $App',
      'Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue',
      'Start-Sleep -Seconds 2',
      '$setup = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru',
      '"Installer exit code: $($setup.ExitCode)"',
      'Start-Process -FilePath $App',
      'schtasks.exe /Delete /TN "Rex Desk update" /F | Out-Null',
      'Stop-Transcript | Out-Null',
    ].join('\r\n'));
    // Task Scheduler runs the helper in this person's desktop session, outside this server's process tree and free of the
    // memory limits a WMI-created process gets (which cut the installer off mid-copy). Settings travel in the JSON beside it.
    const task = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helper}"`;
    if (task.length > 260) throw new Error('The update folder path is too long for Windows Task Scheduler.');
    execFileSync('schtasks.exe', ['/Create', '/TN', 'Rex Desk update', '/TR', task, '/SC', 'ONCE', '/ST', '00:00', '/RL', 'LIMITED', '/F'], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
    execFileSync('schtasks.exe', ['/Run', '/TN', 'Rex Desk update'], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
  }
}

import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statfsSync } from 'node:fs';
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
// Only #rrggbb colours reach the update window's script, whatever the page sent.
export function safeTheme(theme) {
  const out = {};
  for (const key of ['panel', 'ink', 'muted', 'accent', 'line']) if (/^#[0-9a-f]{6}$/i.test(String(theme?.[key] || ''))) out[key] = theme[key];
  return out;
}
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
  // A helper waits for this server to exit, closes the app window, runs the installer silently, and reopens Rex Desk.
  // Windows creates it through WMI: a child of this server would be killed when the server exits, and a detached
  // PowerShell has no console and never starts. A WMI-created process inherits no environment, so values go as arguments.
  install(serverPid) {
    if (!this.state.ready || !this.file) throw new Error('No checked update is ready yet.');
    // The installer unpacks in the temp folder and writes into the app's folder: both drives need room.
    for (const folder of [os.tmpdir(), this.executable ? path.dirname(this.executable) : ''].filter(Boolean)) {
      const free = (this.freeSpace || freeSpace)(folder);
      if (free < INSTALL_ROOM) throw new Error(`Not enough free space to install the update: ${mb(free)} MB free on the ${driveOf(folder)} drive, and it needs 500 MB. Free some space, then press Update now again.`);
    }
    if (this.platform.startsWith('darwin')) {
      // The executable is "Rex Desk.app/Contents/MacOS/rex-desk"; the app is the folder three levels up.
      const helper = path.join(this.directory, 'install-update.sh');
      writeFileSync(helper, macInstallScript({ serverPid, archive: this.file, app: path.resolve(this.executable, '../../..'), log: path.join(this.directory, 'install-update.log') }));
      spawn('/bin/sh', [helper], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    const helper = path.join(this.directory, 'install-update.ps1');
    writeFileSync(path.join(this.directory, 'install-update.json'), JSON.stringify({ serverPid: Number(serverPid), installer: this.file, app: this.executable, version: this.state.available?.version || '', log: path.join(this.directory, 'install-update.log'), theme: safeTheme(this.theme) }));
    writeFileSync(helper, [
      '$settings = Get-Content -Raw (Join-Path $PSScriptRoot "install-update.json") | ConvertFrom-Json',
      '$ServerPid = [int]$settings.serverPid; $Installer = $settings.installer; $App = $settings.app; $Log = $settings.log',
      // Each step is written as it happens (a transcript is lost if the helper is cut off), so a stuck update shows where.
      // While Rex Desk is closed for the update, a small window says which step it is on and how far along, until Rex Desk
      // answers again. The window is a nicety: if it cannot be shown, the update goes on without it.
      '$Version = [string]$settings.version',
      '$ui = $null',
      // The update window looks like Rex Desk: no Windows frame, rounded, the colours of the theme the person sees, the four-square
      // logo, and a thin accent bar (a filled panel, not the green Windows progress bar). It is a normal window, not always on top:
      // the person can work in other apps, drag it by any part, or minimize it with its own button. It comes to the front by
      // itself only when something goes wrong.
      '$t = $settings.theme; function Col($value, $fallback) { try { if ($value) { return [Drawing.ColorTranslator]::FromHtml($value) } } catch {}; return [Drawing.ColorTranslator]::FromHtml($fallback) }',
      'try { Add-Type -AssemblyName System.Windows.Forms, System.Drawing; [Windows.Forms.Application]::EnableVisualStyles()',
      '  $panel = Col $t.panel "#16181d"; $ink = Col $t.ink "#e6e8eb"; $muted = Col $t.muted "#9aa3b1"; $accent = Col $t.accent "#5a97ff"; $line = Col $t.line "#2a2f37"',
      '  $form = New-Object Windows.Forms.Form -Property @{ Text = "Updating Rex Desk"; ClientSize = New-Object Drawing.Size(460, 132); StartPosition = "CenterScreen"; FormBorderStyle = "None"; TopMost = $false; ShowInTaskbar = $true; BackColor = $panel }',
      // The taskbar shows Rex Desk's own icon (taken from the app being updated), not PowerShell's.
      '  try { $form.Icon = [Drawing.Icon]::ExtractAssociatedIcon($App) } catch {}',
      '  $path = New-Object Drawing.Drawing2D.GraphicsPath; $r = 28; $w = $form.Width; $h = $form.Height; $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($w - $r, 0, $r, $r, 270, 90); $path.AddArc($w - $r, $h - $r, $r, $r, 0, 90); $path.AddArc(0, $h - $r, $r, $r, 90, 90); $path.CloseFigure(); $form.Region = New-Object Drawing.Region($path)',
      '  $form.Add_Paint({ param($s, $e) $e.Graphics.SmoothingMode = "AntiAlias"; $pen = New-Object Drawing.Pen($line, 1); $e.Graphics.DrawPath($pen, $path); $pen.Dispose() })',
      '  $logo = New-Object Windows.Forms.Panel -Property @{ Location = New-Object Drawing.Point(24, 24); Size = New-Object Drawing.Size(30, 30); BackColor = $panel }',
      '  $logo.Add_Paint({ param($s, $e) $g = $e.Graphics; $g.SmoothingMode = "AntiAlias"; $brush = New-Object Drawing.SolidBrush($accent); foreach ($p in @(@(0,0),@(16,0),@(0,16),@(16,16))) { $box = New-Object Drawing.Drawing2D.GraphicsPath; $x = $p[0]; $y = $p[1]; $box.AddArc($x, $y, 6, 6, 180, 90); $box.AddArc($x + 8, $y, 6, 6, 270, 90); $box.AddArc($x + 8, $y + 8, 6, 6, 0, 90); $box.AddArc($x, $y + 8, 6, 6, 90, 90); $box.CloseFigure(); $g.FillPath($brush, $box) }; $brush.Dispose() })',
      '  $title = New-Object Windows.Forms.Label -Property @{ Text = "Updating Rex Desk $Version"; Location = New-Object Drawing.Point(66, 22); AutoSize = $true; Font = New-Object Drawing.Font("Segoe UI Semibold", 11.5); ForeColor = $ink; BackColor = $panel }',
      '  $label = New-Object Windows.Forms.Label -Property @{ Text = "Getting ready"; Location = New-Object Drawing.Point(67, 48); Size = New-Object Drawing.Size(370, 38); Font = New-Object Drawing.Font("Segoe UI", 9.5); ForeColor = $muted; BackColor = $panel }',
      '  $track = New-Object Windows.Forms.Panel -Property @{ Location = New-Object Drawing.Point(24, 92); Size = New-Object Drawing.Size(412, 6); BackColor = $line }',
      '  $fill = New-Object Windows.Forms.Panel -Property @{ Location = New-Object Drawing.Point(0, 0); Size = New-Object Drawing.Size(0, 6); BackColor = $accent }; $track.Controls.Add($fill)',
      '  $foot = New-Object Windows.Forms.Label -Property @{ Text = "Rex Desk opens again by itself when this is done."; Location = New-Object Drawing.Point(23, 106); AutoSize = $true; Font = New-Object Drawing.Font("Segoe UI", 8.5); ForeColor = $muted; BackColor = $panel }',
      '  $bar = [pscustomobject]@{ Track = $track; Fill = $fill }',
      // Its own minimize button, top right, in the theme colours (a frameless window has no Windows title bar to minimize from).
      '  $min = New-Object Windows.Forms.Label -Property @{ Text = [string][char]0x2013; Location = New-Object Drawing.Point(420, 12); Size = New-Object Drawing.Size(28, 24); TextAlign = "MiddleCenter"; Font = New-Object Drawing.Font("Segoe UI", 11); ForeColor = $muted; BackColor = $panel; Cursor = [Windows.Forms.Cursors]::Hand }',
      '  $min.Add_MouseEnter({ $min.BackColor = $line; $min.ForeColor = $ink }); $min.Add_MouseLeave({ $min.BackColor = $panel; $min.ForeColor = $muted }); $min.Add_Click({ $form.WindowState = "Minimized" })',
      '  try { (New-Object Windows.Forms.ToolTip).SetToolTip($min, "Minimize") } catch {}',
      // Dragged by any part but the button: there is no title bar to hold.
      '  $drag = [pscustomobject]@{ On = $false; X = 0; Y = 0 }',
      '  foreach ($c in @($form, $logo, $title, $label, $foot)) { $c.Add_MouseDown({ param($s, $e) if ($e.Button -eq "Left") { $drag.On = $true; $drag.X = [Windows.Forms.Cursor]::Position.X - $form.Left; $drag.Y = [Windows.Forms.Cursor]::Position.Y - $form.Top } }); $c.Add_MouseMove({ if ($drag.On) { $form.Left = [Windows.Forms.Cursor]::Position.X - $drag.X; $form.Top = [Windows.Forms.Cursor]::Position.Y - $drag.Y } }); $c.Add_MouseUp({ $drag.On = $false }) }',
      '  $form.Controls.AddRange(@($logo, $title, $label, $track, $foot, $min)); $form.Show(); [Windows.Forms.Application]::DoEvents(); $ui = $form } catch { $ui = $null }',
      // Only a problem brings the window back and in front of other apps, once, so the person sees it.
      'function Alert { if ($ui) { try { if ($ui.WindowState -eq "Minimized") { $ui.WindowState = "Normal" }; $ui.TopMost = $true; $ui.Activate(); [Windows.Forms.Application]::DoEvents(); $ui.TopMost = $false } catch {} } }',
      'function Set-Bar($percent) { if ($ui) { $bar.Fill.Width = [int]($bar.Track.Width * [Math]::Min(100, [Math]::Max(0, $percent)) / 100) } }',
      'function Pump { if ($ui) { [Windows.Forms.Application]::DoEvents() } }',
      'function Step($text, $say, $percent) { Add-Content -Path $Log -Value "$(Get-Date -Format s) $text"; if ($ui -and $say) { $label.Text = $say; if ($percent -ge 0) { Set-Bar $percent }; Pump } }',
      // Started twice (Task Scheduler late, and the Explorer fallback), only the first one runs.
      '$lock = New-Object Threading.Mutex($false, "Local\\RexDeskUpdate"); if (-not $lock.WaitOne(0)) { exit }',
      'Set-Content -Path $Log -Value "$(Get-Date -Format s) update helper started"',
      'Step "closing" "Closing Rex Desk" 5',
      '$until = (Get-Date).AddSeconds(60); while ((Get-Process -Id $ServerPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $until) { Pump; Start-Sleep -Milliseconds 200 }',
      'Step "server stopped" "Closing Rex Desk" 15',
      // The window and any bundled Node still running from the install folder would lock files the installer replaces.
      '$folder = Split-Path -Parent $App; $node = Join-Path $folder "payload\\node\\node.exe"; $server = Join-Path $folder "payload\\app\\src\\server.js"',
      // Everything running from the install folder ends first, and stays ended: the installer cannot replace a file that is
      // open (a 0.0.15 update left node.exe empty when something still held it). Antivirus may hold a file for a moment too,
      // so the helper waits until node.exe can really be written.
      'function Clear-Folder { for ($i = 0; $i -lt 40; $i++) { $left = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) }); if (-not $left.Count) { break }; $left | Stop-Process -Force -ErrorAction SilentlyContinue; Pump; Start-Sleep -Milliseconds 300 }; for ($i = 0; $i -lt 40; $i++) { try { if (-not (Test-Path $node)) { break }; $handle = [IO.File]::Open($node, "Open", "ReadWrite", "None"); $handle.Close(); break } catch { Pump; Start-Sleep -Milliseconds 300 } } }',
      // A good install has the whole app: node.exe at full size and the server code.
      'function Whole { (Test-Path $node) -and ((Get-Item $node).Length -gt 1000000) -and (Test-Path $server) }',
      // Waits for the installer process only (-Wait would also wait for anything the installer starts). The installer does not
      // report its own progress, so the bar moves on time (it usually takes about a minute) and never claims to be done early.
      // /D= installs over the copy that is running, wherever it is: the installer's own guess from the registry once put a second
      // copy in AppData while the person's Rex Desk stayed on the old version (0.0.21, after the publisher name changed).
      'function Install($try) { Clear-Folder; Step "installing (try $try)" "Installing the new version" 20; try { $setup = Start-Process -FilePath $Installer -ArgumentList "/S /D=$folder" -PassThru; $started = Get-Date; while (-not $setup.HasExited) { if ($ui) { Set-Bar ([Math]::Min(80, 20 + [int](((Get-Date) - $started).TotalSeconds / 1.2))) }; Pump; Start-Sleep -Milliseconds 250 }; Step "installer exit code $($setup.ExitCode)" "Checking the install" 82; return ($setup.ExitCode -eq 0) } catch { Step "installer failed: $($_.Exception.Message)" "The installer did not finish" 82; return $false } }',
      // Up to three tries; an install is only done when the app is whole, whatever the installer says.
      '$ok = $false; for ($try = 1; $try -le 3 -and -not $ok; $try++) { $ran = Install $try; $ok = $ran -and (Whole); if (-not $ok) { Step "install incomplete (node $(if (Test-Path $node) { (Get-Item $node).Length } else { 0 }) bytes)" "The install did not finish. Trying again" 20; Alert; Start-Sleep -Seconds 3 } }',
      'if ($ok) { Step "installed" "Installed" 85 } else { Step "install failed after 3 tries" "The update could not be installed. Run the installer again from the updates folder." 85; Alert; for ($i = 0; $i -lt 40; $i++) { Pump; Start-Sleep -Milliseconds 250 } }',
      // Rex Desk opens again whatever happened, so an update never leaves it closed.
      'Start-Process -FilePath $App; Step "app opened" "Starting Rex Desk" 90',
      // The window stays until Rex Desk answers (at most two minutes), so there is never a gap with nothing on screen.
      // Any answer counts (an older Rex Desk has no /api/boot and answers "not found"); only no answer at all means it is not up yet.
      '$until = (Get-Date).AddMinutes(2); while ((Get-Date) -lt $until) { try { Invoke-WebRequest "http://127.0.0.1:4317/api/boot" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { if ($_.Exception.Response) { break }; Pump; Start-Sleep -Milliseconds 500 } }',
      'Step "rex desk answered" "Rex Desk is open" 100',
      'for ($i = 0; $i -lt 6; $i++) { Pump; Start-Sleep -Milliseconds 200 }',
      'if ($ui) { $ui.Close() }',
      'schtasks.exe /Delete /TN "Rex Desk update" /F | Out-Null',
      'Step "done"',
    ].join('\r\n'));
    // Task Scheduler runs the helper in this person's desktop session, outside this server's process tree and free of the
    // memory limits a WMI-created process gets (which cut the installer off mid-copy). Settings travel in the JSON beside it.
    if (this.startHelper) return this.startHelper(helper); // tests read the helper instead of running it
    const task = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helper}"`;
    if (task.length > 260) throw new Error('The update folder path is too long for Windows Task Scheduler.');
    const log = path.join(this.directory, 'install-update.log');
    rmSync(log, { force: true });
    // Some computers do not let an app start Task Scheduler (a security setting or antivirus: "spawnSync schtasks.exe EPERM"),
    // and on some the task is made but never runs. Then Windows Explorer starts the helper: like a double-click, it runs in the
    // person's own session, outside this server, so it keeps going when the old Rex Desk closes for the install.
    const explorer = () => {
      const launcher = path.join(path.dirname(helper), 'rex-desk-update.cmd');
      writeFileSync(launcher, `@echo off\r\nstart "" /min ${task}\r\n`);
      spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [launcher], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    };
    try {
      execFileSync('schtasks.exe', ['/Create', '/TN', 'Rex Desk update', '/TR', task, '/SC', 'ONCE', '/ST', '00:00', '/RL', 'LIMITED', '/F'], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
      execFileSync('schtasks.exe', ['/Run', '/TN', 'Rex Desk update'], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
    } catch (error) {
      try { explorer(); } catch { throw new Error(`Windows did not let Rex Desk start the update (${error.message}). Close Rex Desk and run the installer in ${path.dirname(helper)} yourself.`); }
      return;
    }
    // The helper writes its log the moment it starts; no log after a few seconds means the task never ran.
    setTimeout(() => { if (!existsSync(log)) { try { explorer(); } catch { /* the installer is still in the updates folder */ } } }, 6000).unref?.();
  }
}

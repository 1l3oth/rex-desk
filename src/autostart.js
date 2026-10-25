import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const link = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Rex Desk server.lnk');

export function autostartStatus() {
  const supported = process.platform === 'win32' && Boolean(process.env.APPDATA);
  return { supported, enabled: supported && existsSync(link()) };
}

// A Startup-folder shortcut runs the existing launcher hidden at sign-in, so scheduled work happens without opening the app.
export async function setAutostart(enabled, root) {
  if (!autostartStatus().supported) throw new Error('Starting at sign-in is available on Windows.');
  if (!enabled) { if (existsSync(link())) unlinkSync(link()); return autostartStatus(); }
  // The installed app starts its own bundled server with --background; a checkout uses the PowerShell launcher.
  const executable = process.env.REX_DESK_EXE;
  const script = [
    '$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:REX_LINK)',
    executable ? '$shortcut.TargetPath = $env:REX_EXE' : '$shortcut.TargetPath = Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    executable ? '$shortcut.Arguments = "--background"' : '$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$env:REX_SCRIPT`" -NoBrowser"',
    '$shortcut.WorkingDirectory = $env:REX_ROOT',
    '$shortcut.WindowStyle = 7',
    '$shortcut.Save()',
  ].join('; ');
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000,
    env: { ...process.env, REX_LINK: link(), REX_SCRIPT: path.join(root, 'Start-RexDesk.ps1'), REX_ROOT: executable ? path.dirname(executable) : root, REX_EXE: executable || '' } });
  return autostartStatus();
}

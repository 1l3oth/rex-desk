import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Jev anywhere: Jev without opening the Rex Desk window.
// Windows: a tray helper (scripts/jev-anywhere.ps1) holds Ctrl+Alt+J, opens the small Jev bar over any app, and starts
// the Rex Desk server when needed. Turning it on also starts it with Windows (the per-user Run key, no admin needed).
// macOS: a LaunchAgent keeps the Rex Desk server running from login; a Shortcuts keyboard shortcut opens the bar.
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', runName = 'Rex Desk Jev';
export const jevHotkey = 'Ctrl+Alt+J';
export const macAgentLabel = 'com.rexdesk.server';

const run = (command, args) => new Promise(resolve => execFile(command, args, { windowsHide: true, timeout: 10000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || '') })));

export class Anywhere {
  constructor({ root, dataRoot, platform = process.platform, home = os.homedir(), runner = run, spawner = spawn } = {}) {
    Object.assign(this, { root, dataRoot, platform, home, runner, spawner });
  }
  get script() { return path.join(this.root, 'scripts', 'jev-anywhere.ps1'); }
  get pidFile() { return path.join(this.dataRoot, 'jev-anywhere.pid'); }
  get macAgent() { return path.join(this.home, 'Library', 'LaunchAgents', `${macAgentLabel}.plist`); }
  windowsCommand() { return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${this.script}"`; }
  running() {
    try { const pid = Number(readFileSync(this.pidFile, 'utf8')); if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch { return false; }
  }
  async status() {
    if (this.platform === 'win32') {
      const found = await this.runner('reg.exe', ['query', runKey, '/v', runName]);
      return { supported: true, platform: 'windows', hotkey: jevHotkey, atLogin: found.ok && found.stdout.includes(runName), running: this.running() };
    }
    if (this.platform === 'darwin') return { supported: true, platform: 'mac', hotkey: '', atLogin: existsSync(this.macAgent), running: true };
    return { supported: false, atLogin: false, running: false };
  }
  // Starts the tray helper now (it outlives the server), so Ctrl+Alt+J works straight away.
  start() {
    if (this.platform !== 'win32' || this.running()) return false;
    const child = this.spawner('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', this.script], { detached: true, stdio: 'ignore', windowsHide: true, cwd: this.root });
    child.unref?.(); return true;
  }
  stop() {
    try { const pid = Number(readFileSync(this.pidFile, 'utf8')); if (pid > 0) process.kill(pid); } catch {}
    rmSync(this.pidFile, { force: true });
  }
  async set(on) {
    if (this.platform === 'win32') {
      if (on) {
        const added = await this.runner('reg.exe', ['add', runKey, '/v', runName, '/t', 'REG_SZ', '/d', this.windowsCommand(), '/f']);
        if (!added.ok) throw new Error('Windows did not let Rex Desk start Jev at sign-in.');
        this.start();
      } else { await this.runner('reg.exe', ['delete', runKey, '/v', runName, '/f']); this.stop(); }
      return this.status();
    }
    if (this.platform === 'darwin') {
      if (on) {
        mkdirSync(path.dirname(this.macAgent), { recursive: true });
        const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
        writeFileSync(this.macAgent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${macAgentLabel}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(this.root, 'src', 'server.js'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(this.root)}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${xml(path.join(this.dataRoot, 'server-error.log'))}</string>
</dict></plist>
`);
      } else rmSync(this.macAgent, { force: true });
      return this.status();
    }
    throw new Error('Jev anywhere runs on Windows and macOS.');
  }
}

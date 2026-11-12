import { spawn } from 'node:child_process';

// Keeps the computer from going to sleep while Rex Desk has a reason to stay reachable: an agent is working,
// or the person turned on connecting from other devices. The screen may still lock and turn off.
// A small helper process holds the request and lets go when it ends or when this server is gone,
// so a crashed server never leaves the computer awake for good.
export function awakeCommand(platform = process.platform, ownerPid = process.pid) {
  if (platform === 'win32') {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by the helper's thread until it exits.
    const script = `Add-Type -Name Power -Namespace RexDesk -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; `
      + `[RexDesk.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null; while (Get-Process -Id ${ownerPid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]];
  }
  if (platform === 'darwin') return ['caffeinate', ['-i', '-w', String(ownerPid)]];
  return null;
}

export class Awake {
  constructor({ platform = process.platform, spawner = spawn, ownerPid = process.pid } = {}) {
    Object.assign(this, { platform, spawner, ownerPid, child: null });
  }
  get on() { return Boolean(this.child); }
  set(wanted) {
    if (Boolean(wanted) === this.on) return this.on;
    if (!wanted) { const child = this.child; this.child = null; try { child.kill(); } catch {} return false; }
    const command = awakeCommand(this.platform, this.ownerPid);
    if (!command) return false;
    try {
      const child = this.spawner(command[0], command[1], { stdio: 'ignore', windowsHide: true });
      child.on?.('error', () => { if (this.child === child) this.child = null; });
      child.on?.('exit', () => { if (this.child === child) this.child = null; });
      this.child = child;
    } catch { this.child = null; }
    return this.on;
  }
}

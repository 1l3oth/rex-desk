import { spawn } from 'node:child_process';
import os from 'node:os';

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

// Keeps the server's memory in RAM. When the computer runs short of memory for a while (a local model loading, a
// browser, a big build), Windows moves an idle server's memory to the page file; on a hard drive, reading it back
// takes minutes, and all that time the window is black and no agent can reply, even after the memory is free again.
// A hard minimum working set (set once from a helper; it holds after the helper ends) tells Windows not to take the
// server's memory below that size. Normal users may set it. Not Windows: nothing to do.
export function keepInMemoryCommand(platform = process.platform, ownerPid = process.pid, bytes = Math.min(384 * 1024 * 1024, Math.floor(os.totalmem() / 8))) {
  if (platform !== 'win32') return null;
  const script = `Add-Type -Name Memory -Namespace RexDesk -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid); [DllImport("kernel32.dll")] public static extern bool SetProcessWorkingSetSizeEx(IntPtr process, UIntPtr minimum, UIntPtr maximum, uint flags);'; `
    // PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION; QUOTA_LIMITS_HARDWS_MIN_ENABLE | QUOTA_LIMITS_HARDWS_MAX_DISABLE.
    + `$process = [RexDesk.Memory]::OpenProcess(0x0500, $false, ${Number(ownerPid)}); [RexDesk.Memory]::SetProcessWorkingSetSizeEx($process, [UIntPtr][uint64]${Math.floor(bytes)}, [UIntPtr][uint64]${4 * 1024 * 1024 * 1024}, 9) | Out-Null`;
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]];
}

export function keepInMemory({ platform = process.platform, spawner = spawn, ownerPid = process.pid } = {}) {
  const command = keepInMemoryCommand(platform, ownerPid);
  if (!command) return false;
  try { const child = spawner(command[0], command[1], { stdio: 'ignore', windowsHide: true }); child.on?.('error', () => {}); child.unref?.(); return true; } catch { return false; }
}

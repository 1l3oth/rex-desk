// Free space on the drive that holds a folder, and a plain message when there is too little for an agent to work.
import { statfsSync } from 'node:fs';
import path from 'node:path';

export const MIN_FREE_BYTES = 500 * 2 ** 20;
export const freeBytes = folder => { try { const disk = statfsSync(folder); return Number(disk.bavail) * Number(disk.bsize); } catch { return Infinity; } };
// "Drive C:" on Windows, "The disk" elsewhere.
export const driveName = folder => { const letter = path.parse(path.resolve(folder)).root.match(/^([a-z]):/i); return letter ? `Drive ${letter[1].toUpperCase()}:` : 'The disk'; };
// Returns '' when there is room, otherwise what to tell the person.
export function lowDiskMessage(folders, { min = MIN_FREE_BYTES, free = freeBytes } = {}) {
  for (const folder of folders.filter(Boolean)) {
    const left = free(folder);
    if (left < min) return `${driveName(folder)} is almost full (${Math.max(0, Math.round(left / 2 ** 20))} MB free), so the agent cannot save its work. Free some space (empty the Recycle Bin, delete old downloads, or remove old copies of your projects), or move Rex Desk's files to another drive in Settings, Folders. Then send your message again.`;
  }
  return '';
}
// A write that failed because the disk is full, in the words of the person, not "ENOSPC".
export const friendlyDiskError = message => /ENOSPC|no space left on device/i.test(String(message)) ? "The disk is full, so the agent could not save its work. Free some space (empty the Recycle Bin, delete old downloads) or move Rex Desk's files to another drive in Settings, Folders, then send your message again." : message;
// The low-disk warning: checks the drives that hold Rex Desk's data and the agents' runtime copy, and tells the person once
// each time one drops below 5 GB (again only after it had room). Returns a stop function.
export const WARN_FREE_BYTES = 5 * 2 ** 30;
export function watchDisk(folders, { notify, min = WARN_FREE_BYTES, free = freeBytes, everyMs = 10 * 60000 } = {}) {
  const low = new Set();
  const check = () => {
    for (const folder of folders.filter(Boolean)) {
      const name = driveName(folder), left = free(folder);
      // A folder that is not there yet (the runtime copy before it is made) says nothing; it must not end a warning.
      if (!Number.isFinite(left)) continue;
      if (left >= min) { low.delete(name); continue; }
      if (low.has(name)) continue;
      low.add(name);
      notify(`${name} is running out of space`, `Only ${(Math.max(0, left) / 2 ** 30).toFixed(1)} GB is free on ${name.replace(/^Drive /, 'drive ')}, where Rex Desk keeps its data and agents' files. Below a few GB agents stop working. Free some space (empty the Recycle Bin, delete old downloads or old project copies) or move Rex Desk's files to another drive in Settings, Folders.`);
    }
  };
  check();
  const timer = setInterval(check, everyMs); timer.unref?.();
  return Object.assign(() => clearInterval(timer), { check });
}
// Only the installed app's own server watches the disk: it runs from the app's payload beside its program (REX_DESK_EXE) with
// its version set. A test copy or an agent's copy runs from a checkout or a temp folder, even when it inherits those settings.
export function installedServer(appRoot, dataDirectory, env = process.env) {
  if (dataDirectory || !env.REX_DESK_VERSION || !env.REX_DESK_EXE) return false;
  const inside = path.relative(path.resolve(path.dirname(env.REX_DESK_EXE)), path.resolve(appRoot));
  return Boolean(inside) && !inside.startsWith('..') && !path.isAbsolute(inside);
}

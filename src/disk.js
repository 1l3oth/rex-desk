// Free space on the drive that holds a folder, and a plain message when there is too little for an agent to work.
import { statfsSync } from 'node:fs';
import path from 'node:path';

export const MIN_FREE_BYTES = 500 * 2 ** 20;
export const freeBytes = folder => { try { const disk = statfsSync(folder); return Number(disk.bavail) * Number(disk.bsize); } catch { return Infinity; } };
// "Drive C:" on Windows, "The disk" elsewhere.
const drive = folder => { const letter = path.parse(path.resolve(folder)).root.match(/^([a-z]):/i); return letter ? `Drive ${letter[1].toUpperCase()}:` : 'The disk'; };
// Returns '' when there is room, otherwise what to tell the person.
export function lowDiskMessage(folders, { min = MIN_FREE_BYTES, free = freeBytes } = {}) {
  for (const folder of folders.filter(Boolean)) {
    const left = free(folder);
    if (left < min) return `${drive(folder)} is almost full (${Math.max(0, Math.round(left / 2 ** 20))} MB free), so the agent cannot save its work. Free some space (empty the Recycle Bin, delete old downloads, or remove old copies of your projects), or move Rex Desk's files to another drive in Settings, Folders. Then send your message again.`;
  }
  return '';
}
// A write that failed because the disk is full, in the words of the person, not "ENOSPC".
export const friendlyDiskError = message => /ENOSPC|no space left on device/i.test(String(message)) ? "The disk is full, so the agent could not save its work. Free some space (empty the Recycle Bin, delete old downloads) or move Rex Desk's files to another drive in Settings, Folders, then send your message again." : message;

// Where agents keep their work: worktrees, run folders, temp files and test data sit in a work folder next to the project,
// on the project's own drive (D:\dev\products\rex-desk -> D:\dev\products\rex-desk-work), never on drive C: by default.
// Agents without a project use a work folder inside Rex Desk's data folder.
import path from 'node:path';
import { freeBytes } from './disk.js';

export function workFolder(project, dataDirectory) {
  if (project) { const resolved = path.resolve(project); return path.join(path.dirname(resolved), `${path.basename(resolved)}-work`); }
  return path.join(path.resolve(dataDirectory), 'work');
}
// The agents' runtime copy is shared by every agent, so it goes on the drive with the most free space among the data
// folder's drive and the added projects' drives: next to that project, or in the data folder when its drive wins.
export function runtimeFolder(dataDirectory, projects = [], { free = freeBytes } = {}) {
  const root = folder => path.parse(path.resolve(folder)).root.toLowerCase();
  let best = { folder: path.join(path.resolve(dataDirectory), 'runtime'), left: free(dataDirectory) }, seen = new Set([root(dataDirectory)]);
  for (const project of projects.filter(Boolean)) {
    if (seen.has(root(project))) continue; seen.add(root(project));
    const left = free(project);
    if (Number.isFinite(left) && left > (Number.isFinite(best.left) ? best.left : -1)) best = { folder: path.join(workFolder(project), 'runtime'), left };
  }
  return best.folder;
}

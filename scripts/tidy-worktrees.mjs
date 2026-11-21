// Tidies the loose worktrees made beside a project before the work folder existed (D:\dev\products\rex-desk-files and so on).
// Removes only those whose branch is merged into the base and that have nothing uncommitted; lists the rest with why.
// Usage: node scripts/tidy-worktrees.mjs <project folder> [--base origin/master] [--apply --data <Rex Desk data folder>]
// Without --apply it only lists what it would do. --apply reads the desk's runs (read-only) again right before each removal,
// under the same lock the desk honors (a desk from 0.0.102 on waits for it before starting an agent there; stop an older desk
// first), and keeps every worktree a live run or chat uses or used in the last 10 minutes. It refuses without the data folder
// (--data, or REX_DATA_DIR), so it never removes one blind.
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { worktreeList, removeMerged, inside, busyFolders, usedBy } from '../src/worktree-cleanup.js';
import { workFolder } from '../src/work-folder.js';

// Flags that take a value; every other argument that is not a flag is the project folder.
export function parseArgs(args) {
  const options = { apply: false, base: 'origin/master', data: '', project: '' };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--apply') options.apply = true;
    else if (value === '--base' || value === '--data') options[value.slice(2)] = args[++index] || '';
    else if (!value.startsWith('--') && !options.project) options.project = value;
  }
  options.project = path.resolve(options.project || '.');
  return options;
}
// Every desk database under the data folder: the one at its root (no account) and each signed-in account's own
// (accounts.json names their folders, normally workspaces\<id>).
export function deskDatabases(data) {
  const folders = [data, ...(() => { try { return readdirSync(path.join(data, 'workspaces')).map(name => path.join(data, 'workspaces', name)); } catch { return []; } })()];
  try { for (const entry of JSON.parse(readFileSync(path.join(data, 'accounts.json'), 'utf8')).workspaces || []) if (entry?.dir) folders.push(path.resolve(data, entry.dir)); } catch { /* no accounts */ }
  return [...new Set(folders.map(folder => path.resolve(folder, 'desk.sqlite')))].filter(file => existsSync(file));
}
// The folders live (or lately active) runs and chats work in, from every desk database, opened read-only and read fresh each call.
export function liveFolders(data) {
  const files = deskDatabases(data);
  if (!files.length) throw new Error(`No Rex Desk database in ${data}.`);
  return files.flatMap(file => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return busyFolders(db.prepare("SELECT value FROM records WHERE kind='run'").all().map(row => JSON.parse(row.value)));
    } finally { db.close(); }
  });
}

async function main() {
  const { apply, base, project, ...options } = parseArgs(process.argv.slice(2));
  const data = options.data || process.env.REX_DATA_DIR || '';
  if (apply && !data) { console.error('--apply needs the Rex Desk data folder (--data <folder> or REX_DATA_DIR) to keep worktrees that live agents use.'); process.exit(1); }
  // Read again for every check, never one snapshot from the start.
  if (apply) liveFolders(path.resolve(data)); // no database: stop here, before any removal
  const keep = item => apply && usedBy(liveFolders(path.resolve(data)), item);
  const work = workFolder(project);
  const loose = (await worktreeList(project)).filter(item => !inside(work, item.path));
  const { removed, kept } = await removeMerged(project, loose, { base, keep, dryRun: !apply });
  console.log(`${loose.length} worktrees outside ${work}. ${apply ? 'Removed' : 'Would remove'} ${removed.length}, kept ${kept.length}.`);
  for (const item of removed) console.log(`${apply ? 'removed' : 'would remove'}\t${item.path}\t${item.branch || item.head}`);
  for (const item of kept) console.log(`kept\t${item.path}\t${item.branch || item.head}\t${item.reason}`);
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await main();

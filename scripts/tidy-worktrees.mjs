// Tidies the loose worktrees made beside a project before the work folder existed (D:\dev\products\rex-desk-files and so on).
// Removes only those whose branch is merged into the base and that have nothing uncommitted; lists the rest with why.
// Usage: node scripts/tidy-worktrees.mjs <project folder> [--base origin/master] [--apply --data <Rex Desk data folder>]
// Without --apply it only lists what it would do. --apply reads the desk's runs (read-only) and keeps every worktree a live
// run or chat uses; it refuses without the data folder (--data, or REX_DATA_DIR), so it never removes one blind.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { worktreeList, removeMerged, inside } from '../src/worktree-cleanup.js';
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
// The folders that live runs and chats work in, from the desk's own database (opened read-only).
export function liveFolders(data) {
  const file = path.join(data, 'desk.sqlite');
  if (!existsSync(file)) throw new Error(`No Rex Desk database in ${data}.`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM records WHERE kind='run'").all().map(row => JSON.parse(row.value))
      .filter(run => !['done', 'failed', 'stopped', 'canceled'].includes(run.state))
      .flatMap(run => [run.worktree, run.cwd, run.projectPath]).filter(Boolean).map(folder => path.resolve(folder).toLowerCase());
  } finally { db.close(); }
}

async function main() {
  const { apply, base, project, ...options } = parseArgs(process.argv.slice(2));
  const data = options.data || process.env.REX_DATA_DIR || '';
  if (apply && !data) { console.error('--apply needs the Rex Desk data folder (--data <folder> or REX_DATA_DIR) to keep worktrees that live agents use.'); process.exit(1); }
  const busy = apply ? liveFolders(path.resolve(data)) : [];
  const keep = item => { const folder = item.path.toLowerCase(); return busy.some(other => other === folder || inside(folder, other)); };
  const work = workFolder(project);
  const loose = (await worktreeList(project)).filter(item => !inside(work, item.path));
  const { removed, kept } = await removeMerged(project, loose, { base, keep, dryRun: !apply });
  console.log(`${loose.length} worktrees outside ${work}. ${apply ? 'Removed' : 'Would remove'} ${removed.length}, kept ${kept.length}.`);
  for (const item of removed) console.log(`${apply ? 'removed' : 'would remove'}\t${item.path}\t${item.branch || item.head}`);
  for (const item of kept) console.log(`kept\t${item.path}\t${item.branch || item.head}\t${item.reason}`);
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await main();

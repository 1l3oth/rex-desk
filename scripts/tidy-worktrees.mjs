// Tidies the loose worktrees made beside a project before the work folder existed (D:\dev\products\rex-desk-files and so on).
// Removes only those whose branch is merged into the base and that have nothing uncommitted; lists the rest with why.
// Usage: node scripts/tidy-worktrees.mjs <project folder> [--base origin/master] [--apply]
// Without --apply it only lists what it would do.
import path from 'node:path';
import { worktreeList, removeMerged, inside } from '../src/worktree-cleanup.js';
import { workFolder } from '../src/work-folder.js';

const args = process.argv.slice(2), apply = args.includes('--apply'), baseAt = args.indexOf('--base');
const project = path.resolve(args.find((value, index) => !value.startsWith('--') && index !== baseAt + 1) || '.');
const base = baseAt >= 0 ? args[baseAt + 1] : 'origin/master';
const work = workFolder(project);
const loose = (await worktreeList(project)).filter(item => !inside(work, item.path));
const { removed, kept } = await removeMerged(project, loose, { base, dryRun: !apply });
console.log(`${loose.length} worktrees outside ${work}. ${apply ? 'Removed' : 'Would remove'} ${removed.length}, kept ${kept.length}.`);
for (const item of removed) console.log(`${apply ? 'removed' : 'would remove'}\t${item.path}\t${item.branch || item.head}`);
for (const item of kept) console.log(`kept\t${item.path}\t${item.branch || item.head}\t${item.reason}`);

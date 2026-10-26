import path from 'node:path';
import { existsSync } from 'node:fs';
import { slug, git } from './processes.js';

// Readable by default: temp/rex/fix/download-button-blank-preview. The worker names the branch in English once it understands the issue.
export const defaultBranchPattern = '{prefix}/{type}/{title}';
export const branchTypes = ['fix', 'feature', 'refactor', 'chore', 'docs'];
// Until the worker names it, a title that has no Latin words (Korean, Japanese) uses the tracker's own issue number.
export function provisionalTitle(task) {
  const words = String(task.title || '').normalize('NFKD').match(/[a-zA-Z][a-zA-Z0-9]*/g) || [];
  return words.length >= 2 ? words.slice(0, 8).join(' ') : `issue ${task.taskNumber || task.externalId || ''}`.trim();
}
export function issueBranch(pattern, { prefix = 'temp/rex', type = 'fix', title = 'download button blank preview', number = '38464', source = 'morningmate', taskId = '4821', runId = 'a1b2c3' } = {}) {
  const values = { prefix, type: branchTypes.includes(type) ? type : 'fix', title: slug(title), number: slug(number, 24), source: slug(source), taskId: slug(taskId, 24), runId: String(runId).slice(0, 6) };
  const template = String(pattern || defaultBranchPattern).trim();
  const branch = template.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown branch placeholder: {${key}}.`);
    return values[key];
  });
  if (!branch || branch.length > 220 || /[\s~^:?*\[\\{}\x00-\x1f\x7f]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch === '@'
    || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) || branch.startsWith('-')) {
    throw new Error('Branch pattern produces an invalid Git branch. Use letters, numbers, hyphens, underscores, and folder slashes.');
  }
  return branch;
}
// Concurrent runs and earlier work keep their names: a taken name gets -2, -3, and so on.
export async function uniqueBranch(repositoryPath, branch, { worktreeRoot, taken = [] } = {}) {
  for (let index = 1; index < 100; index++) {
    const candidate = index === 1 ? branch : `${branch}-${index}`;
    if (taken.includes(candidate) || (worktreeRoot && existsSync(path.resolve(worktreeRoot, slug(candidate, 120))))) continue;
    const refs = await git(repositoryPath, ['for-each-ref', '--format=%(refname)', `refs/heads/${candidate}`, `refs/remotes/origin/${candidate}`]);
    if (!refs.trim()) return candidate;
  }
  throw new Error(`No free branch name near ${branch}.`);
}

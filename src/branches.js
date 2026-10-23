import { slug } from './processes.js';

export const defaultBranchPattern = '{prefix}/{source}-{taskId}/{title}-{runId}';
export function issueBranch(pattern, { prefix = 'temp/rex', source = 'morningmate', taskId = '4821', title = 'Fix blank preview', runId = 'a1b2c3' } = {}) {
  const values = { prefix, source: slug(source), taskId: slug(taskId, 24), title: slug(title), runId: String(runId).slice(0, 6) };
  const template = String(pattern || defaultBranchPattern).trim();
  if (!template.includes('{runId}')) throw new Error('Branch pattern must include {runId} to keep concurrent runs unique.');
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

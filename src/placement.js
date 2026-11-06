// Where a fired issue runs: which checkout on this computer and which branch it starts from.
// The checkouts are scanned into the database once, with their branches and the issues already run in them, and
// Jev chooses among them with typed choice questions, so nothing generated is parsed. Without a Jev key, the
// repository that earlier runs of the same tracker project used wins.
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverRepositories } from './repositories.js';
import { askJev, jevState, defaultJevModel } from './jev.js';
import { now } from './store.js';

const exec = promisify(execFile);
const gitRefs = async directory => (await exec('git', ['-C', directory, 'for-each-ref', '--sort=-committerdate',
  '--format=%(refname)%09%(committerdate:iso-strict)', 'refs/heads', 'refs/remotes/origin'], { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 })).stdout;
const keyOf = directory => path.resolve(directory).toLowerCase();
// Branches people start work from. Feature and agent branches are left out, so Jev chooses among a short list.
const baseLike = /^(develop|development|dev|master|main|staging|stage|release|hotfix|production|prod|qa)([/-].*)?$|^(global|saas|kr|jp|en)\/(develop|master|main|release|staging|hotfix)/i;

export function branchList(output) {
  const branches = new Map();
  for (const line of String(output).split('\n')) {
    const [ref, at = ''] = line.trim().split('\t');
    const name = ref?.startsWith('refs/heads/') ? ref.slice(11) : ref?.startsWith('refs/remotes/origin/') ? ref.slice(20) : '';
    if (!name || name === 'HEAD') continue;
    const branch = branches.get(name) || { name, local: false, remote: false, at };
    branch[ref.startsWith('refs/heads/') ? 'local' : 'remote'] = true;
    if (at > branch.at) branch.at = at;
    branches.set(name, branch);
  }
  return [...branches.values()];
}

// What has already happened in each checkout: the tracker projects whose issues ran there and the branches they started from.
export function repositoryHistory(store) {
  const repositories = new Map(store.config().repositories.map(item => [item.id, keyOf(item.path)]));
  const history = new Map();
  for (const run of store.list('run')) {
    const key = repositories.get(run.repositoryId);
    if (!key || run.role !== 'worker') continue;
    const task = run.taskId ? store.get('task', run.taskId) : null;
    const entry = history.get(key) || { runs: 0, projects: {}, bases: {}, recent: [] };
    entry.runs++;
    if (task?.projectName) entry.projects[task.projectName] = (entry.projects[task.projectName] || 0) + 1;
    if (run.baseBranch) entry.bases[run.baseBranch] = (entry.bases[run.baseBranch] || 0) + 1;
    entry.recent.push({ at: run.createdAt, title: run.title });
    history.set(key, entry);
  }
  for (const entry of history.values()) entry.recent = entry.recent.sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, 5).map(item => item.title);
  return history;
}

// Folders holding the checkouts: next to each configured one, next to Rex Desk, and the home folder.
export const scanRoots = (store, root) => [...store.config().repositories.map(item => path.dirname(item.path)), path.dirname(root), os.homedir()];

export async function scanRepositories(store, roots, { refs = gitRefs } = {}) {
  const configured = store.config().repositories;
  const found = discoverRepositories(roots, []);
  for (const item of configured) if (!found.some(entry => keyOf(entry.path) === keyOf(item.path))) found.push({ name: path.basename(item.path), path: item.path, branch: '', remote: '' });
  const history = repositoryHistory(store), seen = new Set();
  for (const item of found) {
    const key = keyOf(item.path); seen.add(key);
    let branches = [];
    try { branches = branchList(await refs(item.path)).slice(0, 400); } catch {}
    const setting = configured.find(entry => keyOf(entry.path) === key);
    store.put('repository', key, { id: key, name: setting?.name || item.name, path: path.resolve(item.path), remote: item.remote, currentBranch: item.branch,
      configuredId: setting?.id || '', baseBranch: setting?.baseBranch || '', branches, history: history.get(key) || { runs: 0, projects: {}, bases: {}, recent: [] }, scannedAt: now() });
  }
  for (const stale of store.list('repository')) if (!seen.has(stale.id)) store.delete('repository', stale.id);
  return store.list('repository');
}

export function baseCandidates(repository) {
  const used = Object.keys(repository.history?.bases || {});
  const named = repository.branches.filter(branch => baseLike.test(branch.name)).map(branch => branch.name);
  return [...new Set([repository.baseBranch, ...used, ...named].filter(name => name && repository.branches.some(branch => branch.name === name)))].slice(0, 15);
}

const top = counts => Object.entries(counts || {}).sort((left, right) => right[1] - left[1]).slice(0, 4).map(([name, count]) => `${name} (${count})`).join(', ');
const describe = repository => [`${repository.name}`, repository.remote && `remote ${repository.remote.replace(/^https?:\/\//, '')}`,
  repository.history?.runs ? `earlier issues from: ${top(repository.history.projects)}` : 'no issues run here yet',
  repository.history?.recent?.length && `recent: ${repository.history.recent.slice(0, 3).join('; ')}`].filter(Boolean).join('. ').slice(0, 600);

// The repository earlier runs of the same tracker project used most, when there is exactly one such favourite.
function fromHistory(task, repositories) {
  const scored = repositories.map(repository => ({ repository, count: repository.history?.projects?.[task.projectName] || 0 })).filter(item => item.count)
    .sort((left, right) => right.count - left.count);
  return scored.length && (scored.length === 1 || scored[0].count > scored[1].count) ? scored[0].repository : null;
}

// Decide the repository (unless the human chose one) and the base branch (unless the human chose one).
// Returns { repository, baseBranch, by, reason } or null when nothing better than the caller's default is known.
export async function placeTask(task, { repositories, chosenRepository = null, chosenBase = '', apiKey = '', model = defaultJevModel, fetcher = fetch, versions = '' }) {
  const pool = repositories.filter(item => item.branches?.length);
  let repository = chosenRepository ? pool.find(item => keyOf(item.path) === keyOf(chosenRepository.path)) || null : null, by = chosenRepository ? 'human' : '', reasons = [];
  const state = jevState(task, new Date(), versions);
  if (!repository && apiKey && pool.length > 1) {
    const keys = pool.map((_, index) => `repo${index + 1}`);
    const result = await askJev({ apiKey, model, fetcher, state, questions: { repository: { type: 'choice',
      instructions: 'Which local Git repository holds the code that causes this issue? Match the product, platform, screen, module, and any file or class names in the issue to the repository and the issues that already ran there.',
      criteria: Object.fromEntries(pool.map((item, index) => [keys[index], describe(item)])) } } });
    repository = pool[keys.indexOf(result.answers?.repository?.choice)] || null;
    if (repository) { by = 'jev'; reasons.push(`Jev matched the issue to ${repository.name}`); }
  }
  if (!repository) {
    repository = fromHistory(task, pool);
    if (repository) { by = 'history'; reasons.push(`earlier ${task.projectName} issues ran in ${repository.name}`); }
  }
  if (!repository) return null;
  let baseBranch = chosenBase;
  const candidates = baseCandidates(repository);
  if (!baseBranch && apiKey && candidates.length > 1) {
    const keys = candidates.map((_, index) => `branch${index + 1}`);
    const result = await askJev({ apiKey, model, fetcher, state, questions: { base: { type: 'choice',
      instructions: `Which branch of ${repository.name} should work on this issue start from? Prefer the branch the reported product, region, and version ship from; a release or hotfix branch only when the issue is about that release.`,
      criteria: Object.fromEntries(candidates.map((name, index) => [keys[index], `${name}${name === repository.baseBranch ? ' (the usual base in Settings)' : ''}${repository.history?.bases?.[name] ? `, used by ${repository.history.bases[name]} earlier runs` : ''}`])) } } });
    baseBranch = candidates[keys.indexOf(result.answers?.base?.choice)] || '';
    if (baseBranch) reasons.push(`Jev chose base ${baseBranch}`);
  }
  if (!baseBranch) baseBranch = repository.baseBranch || Object.entries(repository.history?.bases || {}).sort((left, right) => right[1] - left[1])[0]?.[0] || candidates[0] || repository.currentBranch;
  return { repository, baseBranch, by, reason: reasons.join('; ') || `default base ${baseBranch}` };
}

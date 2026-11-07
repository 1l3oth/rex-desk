// What was worked on in a date range, one card per issue: its QA number, tracker status and link, and for every run
// the branch, each commit message, and the pull request. Commits are read from the repository with git log.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const prCommits = async (directory, url) => JSON.parse((await exec('gh', ['pr', 'view', url, '--json', 'commits'], { cwd: directory, windowsHide: true, timeout: 20000 })).stdout).commits
  .map(commit => ({ hash: commit.oid.slice(0, 9), at: commit.committedDate, subject: commit.messageHeadline }));
const gitLog = async (directory, range) => (await exec('git', ['-C', directory, 'log', '--no-merges', '--format=%H%x09%aI%x09%s', range], { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 })).stdout;

// Monday of this week to today, in local time, as YYYY-MM-DD.
export function thisWeek(today = new Date()) {
  const local = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return { from: local(monday), to: local(today) };
}
const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const inRange = (run, from, to) => {
  const start = String(run.createdAt || '').slice(0, 10), end = String(run.updatedAt || run.endedAt || run.createdAt || '').slice(0, 10);
  return start <= to && end >= from;
};

export async function weeklyReport(store, { from, to, log = gitLog, pullCommits = prCommits, detail = async () => null, today = new Date() } = {}) {
  const week = thisWeek(today);
  from = valid(from) ? from : week.from; to = valid(to) ? to : week.to;
  const repositories = new Map(store.config().repositories.map(item => [item.id, item]));
  const runs = store.list('run').filter(run => run.role === 'worker' && run.taskId && inRange(run, from, to));
  const cards = new Map();
  for (const run of runs.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) {
    let task = store.get('task', run.taskId) || { id: run.taskId, title: run.title };
    // The tracker link arrives with the full issue, which a synced list row may not have loaded yet.
    if (!task.url && !cards.has(task.id) && task.postId) task = await detail(task.id).catch(() => null) || task;
    const card = cards.get(task.id) || { taskId: task.id, title: task.title, number: task.taskNumber || task.externalId || '', source: task.source || '', project: task.projectName || '',
      status: task.statusName || task.status || '', deskStatus: task.deskStatus || '', url: task.url || '', runs: [] };
    const repository = repositories.get(run.repositoryId);
    let commits = [], error = '';
    // The local branch first, then its pushed copy; a branch deleted after its pull request opened is read from the pull request.
    if (repository?.path && run.branch) {
      for (const branch of [run.branch, `origin/${run.branch}`]) {
        try {
          commits = String(await log(repository.path, `${run.baseCommit || run.baseBranch || repository.baseBranch}..${branch}`)).split('\n').filter(Boolean)
            .map(line => { const [hash, at, ...subject] = line.split('\t'); return { hash: hash.slice(0, 9), at, subject: subject.join('\t') }; });
          error = ''; break;
        } catch { error = 'The branch no longer exists on this computer.'; }
      }
      if (error && run.prUrl) { try { commits = await pullCommits(repository.path, run.prUrl); error = ''; } catch {} }
    }
    card.runs.push({ id: run.id, state: run.state, repository: repository?.name || '', branch: run.branch || '', baseBranch: run.baseBranch || '', targetBranch: run.targetBranch || '',
      prUrl: run.prUrl || '', prNumber: run.prNumber || '', prState: run.prState || '', createdAt: run.createdAt, commits, error });
    cards.set(task.id, card);
  }
  return { from, to, cards: [...cards.values()] };
}

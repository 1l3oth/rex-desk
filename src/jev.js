import { now } from './store.js';

// Jev (TypeSafe AI) answers typed questions about one issue: a score on a scale, one choice from a set, or a yes/no probability.
// It is reached through OpenRouter's System One endpoint with the person's OpenRouter key; no generated text is parsed.
export const jevEndpoint = 'https://openrouter.ai/api/v1/systemone';
export const defaultJevModel = '~typesafe/jev-latest';
export const severityLabels = ['Cosmetic', 'Minor', 'Moderate', 'Major', 'Critical'];
export const effortLabels = ['Easy', 'Medium', 'Hard'];
export const platformLabels = { web: 'Web', desktop: 'Desktop app', mobile: 'Mobile', unclear: 'Any surface' };
// An issue about a version older than the one running is often already fixed, so anything this likely is called out.
export const outdatedThreshold = 0.6;
export const actionLabels = { fix: 'Fix', verify: 'Verify', wait: 'Waiting', skip: 'Skip' };
export const jevQuestions = {
  severity: { type: 'score', instructions: 'How severe is the problem in this issue for the product’s users?', criteria: [
    'Cosmetic: wording, spacing, or a visual detail; users are not blocked',
    'Minor: a small feature misbehaves for some users and a workaround exists',
    'Moderate: a feature is wrong or missing for many users',
    'Major: an important feature is broken or blocks users’ work',
    'Critical: data loss, a security or privacy exposure, payments, or the app is unusable'] },
  action: { type: 'choice', instructions: 'Judging by the tracker status, description, and comments, what should happen next with this issue?', criteria: {
    fix: 'An open bug or request that still needs a code change',
    verify: 'A developer reports it fixed or development is complete; it needs a QA re-test',
    wait: 'Blocked: waiting for information, a decision, another team, or a release',
    skip: 'Not actionable: a duplicate, already confirmed resolved, or not a product problem' } },
  effort: { type: 'score', instructions: 'How hard is this issue for a skilled developer to fix?', criteria: [
    'Easy: text, translation, style, or one obvious code change',
    'Medium: a contained change across a few files with a clear reproduction',
    'Hard: an unclear cause, many modules, a migration, or design decisions'] },
  platform: { type: 'choice', instructions: 'Which product surface does this issue happen on, judging by its description, screenshots, fields, and comments?', criteria: {
    web: 'The web site opened in a browser on a computer',
    desktop: 'The installed desktop application on Windows or macOS',
    mobile: 'The phone or tablet app on iOS or Android, or a mobile browser',
    unclear: 'It does not say, or the problem is on every surface' } },
  outdated: { type: 'noul', instructions: 'Is this issue likely already fixed or no longer worth working on? Say yes when it reports a problem in a version older than the ones under currentVersions, when the discussion says it was fixed or shipped, or when it has sat untouched while the product moved on.' },
  web: { type: 'noul', instructions: 'Can this issue be reproduced and checked in a desktop Chromium web browser, rather than only in a mobile app, Safari, macOS, iOS, Android, or an installed desktop app?' },
};

const clip = (value, size) => { const text = String(value ?? ''); return text.length > size ? `${text.slice(0, size)}…` : text; };
// The issue as Jev sees it: tracker facts and the latest discussion, without images or internal IDs.
export function jevState(task, today = new Date(), currentVersions = '') {
  return { today: today.toISOString().slice(0, 10), currentVersions: String(currentVersions || '').trim() || undefined, title: task.title, product: task.source, project: task.projectName, status: task.statusName || task.status,
    category: task.category || undefined, reporter: task.reporter, created: task.createdAt, updated: task.updatedAt, due: task.dueDate || undefined,
    fields: Object.fromEntries((task.fields || []).map(field => [field.name, field.value])), description: clip(task.description, 6000),
    comments: (task.comments || []).filter(comment => !comment.system).slice(-8).map(comment => ({ author: comment.author, at: comment.at, text: clip(comment.text, 800) })),
    trackerUpdates: (task.comments || []).filter(comment => comment.system).slice(-5).map(comment => clip(comment.text, 200)) };
}
// A changed title, status, due date, description, or new comment makes the saved analysis stale.
export const taskFingerprint = task => [task.title, task.statusName || task.status, task.dueDate, task.updatedAt, String(task.description || '').length, (task.comments || []).length].join('|');

export async function askJev({ apiKey, model = defaultJevModel, state, questions = jevQuestions, fetcher = fetch }) {
  const response = await fetcher(jevEndpoint, { method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Rex Desk' }, body: JSON.stringify({ model, state, questions }) });
  const text = await response.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`Jev request failed (${response.status}): ${clip(data?.error?.message || text, 300)}`);
  if (!data?.answers) throw new Error('Jev returned no answers.');
  return data;
}

const dueDays = (value, today) => {
  const time = Date.parse(String(value || '').trim().replace(' ', 'T'));
  return Number.isFinite(time) ? Math.floor((time - today.getTime()) / 86400000) : null;
};
const doneStates = new Set(['ready_for_review', 'published', 'qa_passed', 'finished']);
const activeStates = new Set(['queued', 'starting', 'running', 'waiting']);
// Higher is sooner: severity counts most, then a near due date and how likely an agent can prove it in a browser; large work and waiting issues sink.
export function priorityOf(task, analysis, run, today = new Date()) {
  const answers = analysis?.answers || {}, days = dueDays(task.dueDate, today);
  const severity = answers.severity?.score ?? null, effort = answers.effort?.score ?? null, action = answers.action?.choice || null, web = answers.web?.noul ?? null;
  const platform = answers.platform?.choice || null, outdated = answers.outdated?.noul ?? null;
  let value = (severity ?? 1.5) * 2 - (effort ?? 1) * 0.6 + ((web ?? 0.5) - 0.5) * 2;
  // Work that cannot be done here sinks: a phone-only issue, and one the current release has probably already fixed.
  if (platform === 'mobile') value -= 2;
  if (outdated !== null && outdated >= outdatedThreshold) value -= 2;
  if (days !== null) value += days < 0 ? 3 : days <= 1 ? 2.5 : days <= 3 ? 1.5 : days <= 7 ? 0.5 : 0;
  if (action === 'verify') value += 0.5;
  const group = run && activeStates.has(run.state) ? 'running' : run && doneStates.has(run.state) ? 'done' : action === 'wait' || action === 'skip' ? 'later' : 'next';
  const reasons = [severity !== null && `${severityLabels[Math.round(severity)]} severity`, action && actionLabels[action], effort !== null && `${effortLabels[Math.round(effort)].toLowerCase()} to fix`,
    platform && platform !== 'unclear' && platformLabels[platform], outdated !== null && outdated >= outdatedThreshold && 'may already be fixed',
    days !== null && (days < 0 ? `overdue ${-days}d` : days === 0 ? 'due today' : `due in ${days}d`), web !== null && web < 0.4 && 'hard to check in a browser'].filter(Boolean);
  return { taskId: task.id, value: Math.round(value * 100) / 100, group, action: action || null, severity, effort, platform, outdated, web, days, reasons, analyzed: Boolean(analysis?.answers), at: analysis?.at || '', model: analysis?.model || '', error: analysis?.error || '' };
}
// Issues to start now come first, by value; running and finished work follow, then issues that are waiting or not actionable.
export function rankTasks(tasks, analyses, runs, today = new Date()) {
  const order = { next: 0, running: 1, done: 2, later: 3 };
  const latest = taskId => runs.filter(run => run.taskId === taskId).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  const ranked = tasks.map(task => priorityOf(task, analyses.get(task.id), latest(task.id), today))
    .sort((left, right) => order[left.group] - order[right.group] || right.value - left.value);
  let rank = 0;
  return ranked.map(item => ({ ...item, rank: item.group === 'next' ? ++rank : null }));
}

export class Jev {
  constructor(store, { fetcher = fetch, emit = () => {} } = {}) { Object.assign(this, { store, fetcher, emit }); this.running = null; }
  apiKey() {
    const saved = this.store.get('secret', 'openrouter');
    return saved ? this.store.decrypt(saved) : process.env.OPENROUTER_API_KEY || '';
  }
  status() {
    const saved = Boolean(this.store.get('secret', 'openrouter'));
    return { configured: Boolean(this.apiKey()), keySource: saved ? 'settings' : process.env.OPENROUTER_API_KEY ? 'environment' : '', running: Boolean(this.running), ...(this.store.get('jev', 'status') || {}) };
  }
  ranking(today = new Date()) {
    const analyses = new Map(this.store.list('priority').map(item => [item.taskId, item]));
    return rankTasks(this.store.list('task').filter(task => task.active && !task.demo), analyses, this.store.list('run'), today);
  }
  // One pass at a time. Only new or changed issues are asked again unless force is set; three requests run at once.
  prioritize({ force = false, taskId = '' } = {}) {
    if (this.running) return this.running;
    const apiKey = this.apiKey();
    if (!apiKey) return Promise.reject(new Error('Add your OpenRouter API key in Settings → Jev to prioritize issues.'));
    this.running = this.analyze(apiKey, force, taskId).finally(() => { this.running = null; this.emit(); });
    return this.running;
  }
  async analyze(apiKey, force, taskId) {
    const model = this.store.config().jev?.model || defaultJevModel;
    const tasks = this.store.list('task').filter(task => task.active && !task.demo);
    const pending = tasks.filter(task => taskId ? task.id === taskId : force || this.store.get('priority', task.id)?.fingerprint !== taskFingerprint(task));
    const status = { state: 'running', total: pending.length, done: 0, failed: 0, startedAt: now(), error: '' };
    this.store.put('jev', 'status', status);
    const queue = [...pending];
    const worker = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        try {
          const result = await askJev({ apiKey, model, state: jevState(task, new Date(), this.store.config().jev?.versions), fetcher: this.fetcher });
          this.store.put('priority', task.id, { taskId: task.id, fingerprint: taskFingerprint(task), model: result.model || model, answers: result.answers, at: now() });
        } catch (error) {
          status.failed++; status.error = error.message;
          this.store.put('priority', task.id, { ...(this.store.get('priority', task.id) || { taskId: task.id }), error: error.message, at: now() });
          if (/\((401|402|403)\)/.test(error.message)) queue.length = 0;
        }
        status.done++; this.store.put('jev', 'status', { ...status });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
    const finished = { ...status, state: status.failed ? 'error' : 'done', endedAt: now() };
    this.store.put('jev', 'status', finished);
    return { ...finished, ranking: this.ranking() };
  }
}

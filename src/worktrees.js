import path from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { git } from './processes.js';

// The history of git worktrees in the person's projects. Each one keeps the tasks that live in it, so a worktree can carry
// more than one task: the person (or an agent) adds a task, and whoever works on it is told to work there.
// Records come from three places: worktrees Rex Desk made for a run, worktrees an agent shows with desk_worktree,
// and every worktree `git worktree list` reports for a configured project. A worktree that is gone stays in the history.
const now = () => new Date().toISOString();
// Windows can name one folder two ways (C:\Users\RUNNER~1 and C:\Users\runneradmin); git reports the long one, so a short
// name is turned into the long one before folders are compared. Every other path stays as it is written.
export const longPath = value => { const folder = path.resolve(String(value || '')); if (!/~\d/.test(folder)) return folder; try { return realpathSync.native(folder); } catch { return folder; } };
const clean = value => longPath(value).replace(/[\\/]+$/, '');
const sameDir = (left, right) => clean(left).toLowerCase() === clean(right).toLowerCase();
export const worktreeId = directory => createHash('sha256').update(clean(directory).toLowerCase()).digest('hex').slice(0, 12);
// `git worktree list --porcelain`: blocks split by a blank line; the first is the main checkout.
export function parseWorktreeList(text) {
  return String(text || '').replace(/\r/g, '').split(/\n\n+/).map(block => {
    const item = {}; for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' '), value = rest.join(' ');
      if (key === 'worktree') item.path = value; else if (key === 'HEAD') item.head = value; else if (key === 'branch') item.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') item.detached = true; else if (key === 'prunable') item.prunable = true;
    }
    return item;
  }).filter(item => item.path);
}
const MARK = id => `[[worktree:${id}]]`;

export class Worktrees {
  constructor(desk) { this.desk = desk; this.store = desk.store; this.scannedAt = 0; this.scanning = null; }
  all() { return this.store.list('worktree').sort((left, right) => String(right.lastUsedAt || right.createdAt).localeCompare(String(left.lastUsedAt || left.createdAt))); }
  get(ref) {
    const text = String(ref || '').trim(); if (!text) return null;
    return this.store.get('worktree', text) || this.all().find(item => sameDir(item.path, text) || item.branch === text) || null;
  }
  // The project a worktree belongs to: the one whose git folder it shares.
  async repositoryOf(directory) {
    let common = ''; try { common = await git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']); } catch { return null; }
    return this.store.config().repositories.find(item => item.path && sameDir(path.join(item.path, '.git'), common)) || null;
  }
  // Adds or refreshes one worktree. Tasks and who made it are only ever added, never dropped by a refresh.
  // chat: where it was shown or made, as run:<id> (a personal chat) or room:<id> (a group chat); its side panel lists it.
  record({ path: directory, repositoryId = '', branch = '', head = '', taskId = '', by = '', base = '', chat = '' }) {
    const id = worktreeId(directory), old = this.store.get('worktree', id) || {}, at = now();
    const repository = this.store.config().repositories.find(item => item.id === (repositoryId || old.repositoryId)) || null;
    const tasks = [...new Set([...(old.tasks || []), ...(taskId ? [taskId] : [])])], chats = [...new Set([...(old.chats || []), ...(chat ? [chat] : [])])];
    return this.store.put('worktree', id, { ...old, id, path: clean(directory), repositoryId: repositoryId || old.repositoryId || '', project: repository?.name || old.project || '',
      branch: branch || old.branch || '', head: head || old.head || '', base: base || old.base || '', tasks, chats, createdBy: old.createdBy || by || '',
      createdAt: old.createdAt || at, lastUsedAt: taskId || by ? at : old.lastUsedAt || old.createdAt || at, state: existsSync(directory) ? 'active' : 'gone', goneAt: existsSync(directory) ? undefined : old.goneAt || at });
  }
  // Reads every configured project's worktrees. A worktree that disappeared stays in the history, marked gone.
  async scan({ force = false } = {}) {
    if (!force && Date.now() - this.scannedAt < 20000) return this.all();
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const seen = new Set();
      for (const repository of this.store.config().repositories) {
        if (!repository.path || !existsSync(repository.path)) continue;
        let list; try { list = parseWorktreeList(await git(repository.path, ['worktree', 'list', '--porcelain'])); } catch { continue; }
        for (const item of list.slice(1)) { if (item.prunable) continue; seen.add(worktreeId(item.path)); this.record({ path: item.path, repositoryId: repository.id, branch: item.branch || '', head: item.head || '' }); }
      }
      // Runs remember the worktree they worked in and their task.
      for (const run of this.store.list('run')) if (run.worktree) {
        const known = this.store.get('worktree', worktreeId(run.worktree));
        if (known || existsSync(run.worktree)) this.record({ path: run.worktree, repositoryId: run.repositoryId, branch: run.branch, taskId: run.taskId || '', base: run.baseBranch || '', chat: `run:${run.id}` });
      }
      for (const item of this.store.list('worktree')) if (item.state !== 'gone' && !seen.has(item.id) && !existsSync(item.path)) this.store.put('worktree', item.id, { ...item, state: 'gone', goneAt: now() });
      this.scannedAt = Date.now(); return this.all();
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  taskLabel(taskId) {
    const task = this.store.get('task', taskId); if (!task) return null;
    return { id: task.id, number: String(task.taskNumber || task.externalId || ''), title: task.titleEn || task.title || '', status: task.statusName || task.status || '' };
  }
  summary(item) { return { ...item, tasks: (item.tasks || []).map(id => this.taskLabel(id) || { id, number: '', title: 'A task that is no longer here', status: '' }) }; }
  async list({ project = '', state = '' } = {}) {
    const all = await this.scan();
    return all.filter(item => (!project || [item.project, item.repositoryId].some(value => String(value).toLowerCase() === String(project).toLowerCase())) && (!state || item.state === state)).map(item => this.summary(item));
  }
  // A worktree an agent names by id, folder or branch. A folder Rex Desk has not seen yet is read from git first.
  async find(ref) {
    let item = this.get(ref); if (item) return item;
    const directory = String(ref || '').trim();
    if (directory && existsSync(directory)) {
      const repository = await this.repositoryOf(directory);
      let branch = ''; try { branch = await git(directory, ['branch', '--show-current']); } catch { throw new Error(`${directory} is not a git worktree.`); }
      item = this.record({ path: directory, repositoryId: repository?.id || '', branch });
    } else { await this.scan({ force: true }); item = this.get(ref); }
    if (!item) throw new Error('No worktree has that id, folder or branch. Read them with desk_worktrees, or pass the full folder of the worktree.');
    return item;
  }
  addTask(id, taskId) {
    const item = this.store.get('worktree', id); if (!item) throw new Error('Worktree not found.');
    if (!this.store.get('task', taskId)) throw new Error('No task has that id. Read it from desk_tasks.');
    // A task lives in one worktree at a time: adding it here takes it out of any other.
    for (const other of this.store.list('worktree')) if (other.id !== id && (other.tasks || []).includes(taskId)) this.store.put('worktree', other.id, { ...other, tasks: other.tasks.filter(entry => entry !== taskId) });
    return this.summary(this.store.put('worktree', id, { ...item, tasks: [...new Set([...(item.tasks || []), taskId])], lastUsedAt: now() }));
  }
  removeTask(id, taskId) {
    const item = this.store.get('worktree', id); if (!item) throw new Error('Worktree not found.');
    return this.summary(this.store.put('worktree', id, { ...item, tasks: (item.tasks || []).filter(entry => entry !== taskId) }));
  }
  // What changed in a worktree, the way a source control panel shows it: branch, the branch it tracks, how far ahead or behind,
  // and every changed file with its added and removed lines (uncommitted work, staged or not, and new files).
  async changes(id) {
    const item = this.store.get('worktree', id); if (!item) throw new Error('Worktree not found.');
    if (!existsSync(item.path)) return { id, gone: true, branch: item.branch, files: [], added: 0, removed: 0 };
    const [status, numstat] = await Promise.all([git(item.path, ['status', '--porcelain=v1', '-b', '--untracked-files=all']), git(item.path, ['diff', '--numstat', 'HEAD']).catch(() => '')]);
    const lines = status.split('\n').filter(Boolean), head = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
    const tracking = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head) || [], counts = String(tracking[3] || '');
    const counted = new Map(numstat.split('\n').filter(Boolean).map(line => { const [plus, minus, ...name] = line.split('\t'); return [name.join('\t').replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/\/\//g, '/').replace(/^.* => /, ''), { added: Number(plus) || 0, removed: Number(minus) || 0 }]; }));
    const files = lines.slice(0, 500).map(line => {
      const code = line.slice(0, 2), file = line.slice(3).replace(/^.* -> /, '').replace(/^"(.*)"$/, '$1');
      const status = code === '??' ? 'U' : code.includes('D') ? 'D' : code.includes('A') ? 'A' : code.includes('R') ? 'R' : 'M';
      let lines = counted.get(file) || { added: 0, removed: 0 };
      if (status === 'U') { try { const full = path.join(item.path, file); lines = { added: statSync(full).size < 2e6 ? readFileSync(full, 'utf8').split('\n').length : 0, removed: 0 }; } catch {} }
      return { path: path.join(item.path, file), name: path.basename(file), dir: path.dirname(file) === '.' ? '' : path.dirname(file).replace(/\\/g, '/'), status, ...lines };
    });
    return { id, branch: tracking[1] || item.branch, upstream: tracking[2] || '', ahead: Number(/ahead (\d+)/.exec(counts)?.[1] || 0), behind: Number(/behind (\d+)/.exec(counts)?.[1] || 0),
      files, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0), at: now() };
  }
  forTask(taskId) { return this.all().find(item => item.state !== 'gone' && (item.tasks || []).includes(taskId)) || null; }
  // Told to whoever is given a task that lives in a worktree, so the tasks in it are worked on together, in one place.
  briefFor(taskId) {
    const item = this.forTask(taskId); if (!item) return '';
    const others = (item.tasks || []).filter(id => id !== taskId).map(id => this.taskLabel(id)).filter(Boolean).map(task => `#${task.number} ${task.title}`);
    return `This task lives in the worktree ${item.path}${item.branch ? ` on branch ${item.branch}` : ''}${others.length ? `, together with ${others.join(', ')}` : ''}. Work there, not in a new branch or worktree.`;
  }
  // A chat message with a worktree card in it: the dashboard draws the card from the marker, with the latest tasks.
  card(item, note = '') {
    return [`**Worktree: ${item.branch || path.basename(item.path)}**`, String(note || '').trim(), MARK(item.id)].filter(Boolean).join('\n');
  }
}

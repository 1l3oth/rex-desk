// Settings › Storage: what Rex Desk keeps on this computer, by folder like Explorer or Finder, what takes the space
// (here and in the cloud copy), deleting files, and one-click clean-ups.
//
// Only Rex Desk's own data is shown or touched: a fixed list of its folders ("places"). The person's project folders, the
// vault, the database file, keys and the installed app are never listed for deletion. A file deleted here is also taken out
// of the cloud backup, so the cloud copy shrinks with it.
//
// The counting (folder walks, database sizes, duplicate hashing) runs in a worker thread (src/storage-worker.js): on a big
// desk it took 50 s, and on the desk's own thread every other page froze meanwhile.
import { existsSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import * as scan from './storage-scan.js';
import { sizeOf, inside } from './storage-scan.js';

// The files folder holds the installed app on Windows too (D:\Rex Desk\rex-desk.exe): only these folders of it are Rex Desk data.
const FILE_PLACES = [
  ['uploads', 'Files you attached', 'uploads'],
  ['artifacts', 'Agent files and evidence', 'artifacts'],
  ['room-images', 'Group chat pictures', 'room-images'],
];
const DATA_PLACES = [
  ['old-artifacts', 'Older agent files', 'artifacts'],
  ['backups', 'Database backups', 'backups'],
  ['handoffs', 'Chat handoffs', 'handoffs'],
  ['runtime', 'Agent copies of the app', 'runtime'],
];
// How long chat history can be kept, in days: 0 is forever, then a year, six months, three months and one month.
export const HISTORY_DAYS = [0, 365, 180, 90, 30];
// A count this recent is shown as it is; an older one is still shown at once and counted again behind it.
const FRESH_MS = 30000;

export class Storage {
  constructor(desk) { this.desk = desk; this.store = desk.store; this.calls = new Map(); this.nextCall = 0; this.cache = null; this.twins = null; }
  get version() { return process.env.REX_DESK_VERSION || ''; }

  // The folders this page shows, with their real place on disk. A place that is the same folder as another is shown once.
  places() {
    const seen = new Set(), list = [];
    const add = (id, label, directory, cloud) => { const key = path.resolve(directory); if (seen.has(key) || !existsSync(directory)) return; seen.add(key); list.push({ id, label, directory, cloud }); };
    for (const [id, label, folder] of FILE_PLACES) add(id, label, path.join(this.store.filesFolder(), folder), `data/${folder}/`);
    for (const [id, label, folder] of DATA_PLACES) add(id, label, path.join(this.store.directory, folder), '');
    return list;
  }
  place(id) { const place = this.places().find(item => item.id === id); if (!place) throw new Error('That folder is not one of Rex Desk\'s.'); return place; }

  // Who a file belongs to: an agent's files sit in a folder named after the chat's run.
  owner(placeId, relative) {
    if (!['artifacts', 'old-artifacts'].includes(placeId)) return null;
    const runId = relative.split(/[\\/]/)[0], run = runId ? this.store.get('run', runId) : null; if (!run) return null;
    const agent = this.store.get('specialist', run.specialistId || run.roomAgent || ''), room = run.roomId ? this.store.get('room', run.roomId) : null;
    return { runId, agentId: agent?.id || '', name: agent?.name || room?.name || run.title || '' };
  }
  // A protected thing cannot be deleted: the app copy agents run from now.
  protectedPath(place, relative) { return place.id === 'runtime' && this.version && relative.split(/[\\/]/)[0] === this.version; }

  // ---------- counting in the worker thread ----------
  // What the counting needs, as plain data a worker thread can take.
  scope() {
    return { places: this.places().map(({ id, label, directory }) => ({ id, label, directory })), databaseDirectory: this.store.directory, voiceDirectory: process.env.REX_VOICE_DIR || path.join(this.store.directory, 'voice'), version: this.version };
  }
  // Runs one counting job in the worker. If no worker can start, the same job runs here instead.
  run(op, args = {}) {
    args = { scope: this.scope(), ...args };
    if (!this.worker && !this.noWorker) {
      try {
        const worker = new Worker(new URL('./storage-worker.js', import.meta.url));
        worker.unref();
        worker.on('message', ({ id, result, error }) => { const call = this.calls.get(id); if (!call) return; this.calls.delete(id); if (error) call.reject(new Error(error)); else call.resolve(result); });
        const fail = error => { if (this.worker === worker) this.worker = null; for (const call of this.calls.values()) call.reject(error instanceof Error ? error : new Error('Storage counting stopped.')); this.calls.clear(); };
        worker.on('error', fail); worker.on('exit', fail);
        this.worker = worker;
      } catch { this.noWorker = true; }
    }
    if (!this.worker) return this.runHere(op, args);
    const id = ++this.nextCall;
    return new Promise((resolve, reject) => { this.calls.set(id, { resolve, reject }); this.worker.postMessage({ id, op, args }); });
  }
  async runHere(op, args) {
    if (op === 'summary') return { usage: scan.usage(args.scope), suggestions: await scan.suggestions(args.scope, args.now, { findDuplicates: args.findDuplicates }) };
    if (op === 'usage') return scan.usage(args.scope);
    if (op === 'duplicates') return scan.duplicates(args.scope);
    if (op === 'list') return scan.list(args.scope, args.place, args.folder);
    if (op === 'search') return scan.search(args.scope, args.query);
    if (op === 'oldMedia') return scan.oldMedia(args.scope, args.now);
    if (op === 'oldBackups') return scan.oldBackups(args.scope, args.now);
    if (op === 'oldCopies') return scan.oldCopies(args.scope);
    throw new Error('No such storage job.');
  }
  close() { const worker = this.worker; this.worker = null; this.noWorker = true; void worker?.terminate().catch(() => {}); }

  // The page's numbers. Duplicates are only searched when the person asks (findDuplicates); that answer is kept until files change.
  // The last count is kept in a small file too, so after a restart the page still opens with numbers at once.
  // wait: false (the page) answers at once: the last count if there is one, else counting: true and no numbers yet; the
  // page asks again until counting is false. Reading a big database from disk can take a minute.
  async summary({ findDuplicates = false, fresh = false, wait = true } = {}) {
    const kept = path.join(this.store.directory, 'storage-count.json');
    if (!this.cache) { try { const saved = JSON.parse(readFileSync(kept, 'utf8')); if (saved?.data?.usage) this.cache = { at: 0, data: saved.data }; } catch { /* first look */ } }
    const count = () => {
      if (this.counting) return this.counting;
      this.counting = this.run('summary', { now: Date.now() }).then(data => {
        this.cache = { at: Date.now(), data };
        try { writeFileSync(kept, JSON.stringify({ at: new Date().toISOString(), data })); } catch { /* shown, just not kept */ }
        return data;
      }).finally(() => { this.counting = null; });
      return this.counting;
    };
    let data = null;
    if (this.cache && !fresh) { data = this.cache.data; if (Date.now() - this.cache.at > FRESH_MS) count().catch(() => {}); }
    else if (wait) data = await count();
    else count().catch(() => {});
    if (findDuplicates) { const twins = await this.run('duplicates'); this.twins = { bytes: twins.reduce((sum, item) => sum + item.size, 0), count: twins.length }; }
    const suggestions = (data?.suggestions || []).map(item => item.id === 'duplicates' && this.twins ? { ...item, ...this.twins } : item);
    return { usage: data?.usage || null, suggestions, places: this.places().map(({ id, label, directory }) => ({ id, label, directory })), counting: Boolean(this.counting) };
  }
  // Files changed: the numbers shown are counted again behind the page, and duplicates need a new look.
  forget() { if (this.cache) this.cache.at = 0; this.twins = null; }
  async usage() { return this.run('usage'); }
  async suggestions({ findDuplicates = true } = {}) { return (await this.run('summary', { now: Date.now(), findDuplicates })).suggestions; }

  // One folder's contents: its folders (with their total size) and files, like a file manager's list.
  async list(placeId, folder = '') {
    const place = this.place(placeId), directory = inside(place.directory, folder);
    if (!directory || !existsSync(directory)) throw new Error('That folder is gone.');
    const items = (await this.run('list', { place: placeId, folder })).map(item => ({ ...item, owner: this.owner(placeId, item.path), locked: this.protectedPath(place, item.path) }));
    return { place: { id: place.id, label: place.label, directory: place.directory }, folder, items };
  }
  // Search every place by file name.
  async search(query) { return (await this.run('search', { query })).map(item => ({ ...item, owner: this.owner(item.place, item.path) })); }

  file(placeId, relative) {
    const place = this.place(placeId), full = inside(place.directory, relative);
    if (!full || full === path.resolve(place.directory) || !existsSync(full) || !statSync(full).isFile()) throw new Error('That file is gone.');
    return full;
  }
  // "Show in folder": Explorer or Finder opens with the file selected.
  reveal(placeId, relative) {
    const place = this.place(placeId), full = inside(place.directory, relative);
    if (!full || !existsSync(full)) throw new Error('That file is gone.');
    const [command, args] = process.platform === 'win32' ? ['explorer.exe', [`/select,${full}`]] : process.platform === 'darwin' ? ['open', ['-R', full]] : ['xdg-open', [path.dirname(full)]];
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { opened: true };
  }

  // Deletes files and folders (each as { place, path }). Returns the space that came back.
  remove(items = []) {
    let freed = 0, removed = 0; const keys = [];
    for (const item of [].concat(items).slice(0, 5000)) {
      const place = this.place(String(item.place || '')), relative = String(item.path || ''), full = inside(place.directory, relative);
      if (!full || full === path.resolve(place.directory)) throw new Error('A whole Rex Desk folder cannot be deleted; open it and pick what to delete.');
      if (this.protectedPath(place, relative)) throw new Error('Agents run from this copy of the app now, so it stays.');
      if (!existsSync(full)) continue;
      const info = statSync(full), size = info.isDirectory() ? sizeOf(full).bytes : info.size;
      try { rmSync(full, { recursive: true, force: true }); } catch (error) { throw new Error(`${path.basename(full)} could not be deleted: ${error.code === 'EBUSY' || error.code === 'EPERM' ? 'something is using it' : error.message}`); }
      freed += size; removed += 1;
      const key = `${place.cloud || `local/${place.id}/`}${relative.split(path.sep).join('/')}${info.isDirectory() ? '/' : ''}`;
      if (place.cloud) keys.push(key);
      // Remembered as deleted, so a copy carried with a chat or kept in the backup is not brought back when the chat shows it.
      this.store.put('storage-gone', key, { id: key, at: new Date().toISOString() });
      // An agent's file was also listed as evidence: that record goes, so the chat shows "file removed" instead of a broken link.
      if (['artifacts', 'old-artifacts'].includes(place.id)) for (const artifact of this.store.list('artifact')) {
        const file = path.join(place.directory, artifact.runId || '', artifact.file || '');
        if (path.resolve(file) === path.resolve(full) || path.resolve(file).startsWith(path.resolve(full) + path.sep)) this.store.delete('artifact', artifact.id);
      }
    }
    this.dropFromCloud(keys);
    if (removed) this.forget();
    return { freed, removed };
  }
  // Whether a file (by its backup key, like data/uploads/<id>/photo.png) was deleted here, itself or with its folder.
  gone(key) { const want = String(key || ''); return Boolean(want) && this.store.list('storage-gone').some(item => item.id === want || (item.id.endsWith('/') && want.startsWith(item.id))); }
  // The cloud backup forgets the deleted files: its database copy and the account's file folder.
  dropFromCloud(keys) {
    const cloud = this.store.cloud; if (!cloud?.enabled || !keys.length) return;
    this.store.transaction(() => { for (const key of keys) cloud.enqueue(key.endsWith('/') ? 'DELETE FROM rex_files WHERE workspace=? AND path LIKE ?' : 'DELETE FROM rex_files WHERE workspace=? AND path=?', [cloud.workspace, key.endsWith('/') ? `${key}%` : key]); });
    cloud.files?.forget(keys);
    cloud.schedule?.();
  }

  // ---------- one-click clean-ups ----------
  // Runs one clean-up. Files freed are counted as they are deleted; raw agent output by how much the database file shrank.
  async clean(id, now = Date.now()) {
    if (!['raw-output', 'old-media', 'duplicates', 'old-backups', 'old-copies'].includes(id)) throw new Error('No such clean-up.');
    // The total from the last count when there is one: counting a big desk again first took a minute.
    const before = this.cache?.data?.usage?.total ?? (await this.usage()).total;
    const database = () => { const file = name => { try { return statSync(path.join(this.store.directory, name)).size; } catch { return 0; } }; return file('desk.sqlite') + file('desk.sqlite-wal'); };
    let freed = 0;
    if (id === 'raw-output') { const start = database(); this.dropRawOutput(now); freed = Math.max(0, start - database()); }
    else if (id === 'old-media') freed = this.remove(await this.run('oldMedia', { now })).freed;
    else if (id === 'duplicates') freed = this.remove(await this.run('duplicates')).freed;
    else if (id === 'old-backups') freed = this.remove(await this.run('oldBackups', { now })).freed;
    else if (id === 'old-copies') { for (const item of await this.run('oldCopies')) { try { freed += this.remove([item]).freed; } catch { /* an agent still runs from it */ } } }
    this.forget();
    return { id, before, after: Math.max(0, before - freed), freed };
  }
  // ---------- keep chat history ----------
  // How long chat messages are kept (Settings > Storage): 0 is forever. Older messages are deleted on their own, here and in
  // the cloud copy. Only messages go: agents' memory and lessons, tasks, pins and files are records or files and stay.
  historyDays() { const days = Number(this.store.config().keepHistory) || 0; return HISTORY_DAYS.includes(days) ? days : 0; }
  setHistory(days) {
    const value = Number(days) || 0; if (!HISTORY_DAYS.includes(value)) throw new Error('Pick how long to keep chat history.');
    this.store.saveConfig({ ...this.store.config(), keepHistory: value });
    return { keepHistory: value, ...this.dropOldHistory() };
  }
  // Called by the server's timer; deletes at most every 6 hours, so a big desk is not scanned every minute.
  historyTick(now = Date.now()) {
    if (!this.historyDays() || now - (this.historyAt || 0) < 6 * 3600000) return null;
    this.historyAt = now; return this.dropOldHistory(now);
  }
  dropOldHistory(now = Date.now()) {
    const days = this.historyDays(); if (!days) return { removed: 0 };
    const before = new Date(now - days * scan.DAY).toISOString(), cloud = this.store.cloud;
    let removed = 0;
    this.store.transaction(() => {
      removed = Number(this.store.db.prepare('DELETE FROM events WHERE created_at < ?').run(before).changes) || 0;
      if (cloud?.enabled) cloud.enqueue('DELETE FROM rex_events WHERE workspace=? AND created_at < ?', [cloud.workspace, before]);
    });
    if (removed) { cloud?.schedule?.(); this.forget(); }
    return { removed, before };
  }
  dropRawOutput(now = Date.now()) {
    const before = new Date(now - 30 * scan.DAY).toISOString(), cloud = this.store.cloud;
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM events WHERE visible = 0 AND created_at < ?').run(before);
      if (cloud?.enabled) cloud.enqueue('DELETE FROM rex_events WHERE workspace=? AND visible=0 AND created_at < ?', [cloud.workspace, before]);
    });
    cloud?.schedule?.();
    // The database file gives the freed pages back to the disk.
    try { this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.store.db.exec('VACUUM'); this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: the space is reused by new messages instead */ }
  }
}

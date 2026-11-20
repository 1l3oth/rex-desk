// Settings › Storage: what Rex Desk keeps on this computer, by folder like Explorer or Finder, what takes the space
// (here and in the cloud copy), deleting files, and one-click clean-ups.
//
// Only Rex Desk's own data is shown or touched: a fixed list of its folders ("places"). The person's project folders, the
// vault, the database file, keys and the installed app are never listed for deletion. A file deleted here is also taken out
// of the cloud backup, so the cloud copy shrinks with it.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DAY = 86400000;
const MEDIA = /\.(png|jpe?g|gif|webp|bmp|mp4|webm|mov|mp3|wav|ogg|m4a)$/i;
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

const walk = (folder, visit, depth = 0) => {
  if (depth > 12) return;
  let entries = []; try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(full, visit, depth + 1);
    else if (entry.isFile()) { try { const info = statSync(full); visit(full, info); } catch { /* gone meanwhile */ } }
  }
};
const sizeOf = folder => { let bytes = 0, files = 0; walk(folder, (_, info) => { bytes += info.size; files += 1; }); return { bytes, files }; };
const inside = (root, file) => { const full = path.resolve(root, file); return full === path.resolve(root) || full.startsWith(path.resolve(root) + path.sep) ? full : ''; };

export class Storage {
  constructor(desk) { this.desk = desk; this.store = desk.store; }
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

  // One folder's contents: its folders (with their total size) and files, like a file manager's list.
  list(placeId, folder = '') {
    const place = this.place(placeId), directory = inside(place.directory, folder);
    if (!directory || !existsSync(directory)) throw new Error('That folder is gone.');
    const items = [];
    // Each file you attach sits in a folder of its own with a code name: the files are listed by their own names instead.
    const entries = readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (place.id !== 'uploads' || folder || !entry.isDirectory()) return [{ entry, directory }];
      let inner = []; try { inner = readdirSync(path.join(directory, entry.name), { withFileTypes: true }); } catch { return [{ entry, directory }]; }
      return inner.length && inner.every(item => item.isFile()) ? inner.map(item => ({ entry: item, directory: path.join(directory, entry.name) })) : [{ entry, directory }];
    });
    for (const { entry, directory } of entries) {
      const full = path.join(directory, entry.name), relative = path.relative(place.directory, full);
      try {
        if (entry.isDirectory()) { const { bytes, files } = sizeOf(full); items.push({ name: entry.name, path: relative, folder: true, size: bytes, files, modified: statSync(full).mtime.toISOString(), owner: this.owner(placeId, relative), locked: this.protectedPath(place, relative) }); }
        else if (entry.isFile()) { const info = statSync(full); items.push({ name: entry.name, path: relative, folder: false, size: info.size, modified: info.mtime.toISOString(), owner: this.owner(placeId, relative), locked: this.protectedPath(place, relative) }); }
      } catch { /* gone meanwhile */ }
    }
    return { place: { id: place.id, label: place.label, directory: place.directory }, folder, items };
  }
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
  // Search every place by file name.
  search(query, limit = 200) {
    const want = String(query || '').trim().toLowerCase(); if (!want) return [];
    const found = [];
    for (const place of this.places()) walk(place.directory, (full, info) => {
      if (found.length >= limit || !path.basename(full).toLowerCase().includes(want)) return;
      const relative = path.relative(place.directory, full);
      found.push({ place: place.id, name: path.basename(full), path: relative, folder: false, size: info.size, modified: info.mtime.toISOString(), owner: this.owner(place.id, relative) });
    });
    return found.sort((left, right) => right.size - left.size);
  }

  // What takes the space on this computer, by kind, and the database split into chat history and raw agent output.
  usage() {
    const db = this.store.db, file = name => { try { return statSync(path.join(this.store.directory, name)).size; } catch { return 0; } };
    const database = file('desk.sqlite') + file('desk.sqlite-wal');
    const rows = db.prepare('SELECT visible, SUM(LENGTH(value)) AS bytes, COUNT(*) AS n FROM events GROUP BY visible').all();
    const chat = Number(rows.find(row => Number(row.visible) === 1)?.bytes || 0), raw = Number(rows.find(row => Number(row.visible) !== 1)?.bytes || 0);
    const places = this.places().map(place => ({ id: place.id, label: place.label, ...sizeOf(place.directory) }));
    const voiceDirectory = process.env.REX_VOICE_DIR || path.join(this.store.directory, 'voice');
    const models = existsSync(voiceDirectory) ? sizeOf(voiceDirectory).bytes : 0;
    const files = places.filter(place => ['uploads', 'artifacts', 'room-images', 'old-artifacts', 'handoffs'].includes(place.id)).reduce((sum, place) => sum + place.bytes, 0);
    const backups = places.filter(place => ['backups', 'runtime'].includes(place.id)).reduce((sum, place) => sum + place.bytes, 0);
    // The database file holds more than the events (records, free pages): what is not chat or raw output is "other records".
    const other = Math.max(0, database - chat - raw);
    const kinds = [
      { id: 'chat', label: 'Chat history', bytes: chat },
      { id: 'raw', label: 'Raw agent output', bytes: raw },
      { id: 'records', label: 'Other records', bytes: other },
      { id: 'files', label: 'Files', bytes: files },
      { id: 'backups', label: 'Backups and app copies', bytes: backups },
      { id: 'models', label: 'Voice models', bytes: models },
    ];
    return { total: kinds.reduce((sum, kind) => sum + kind.bytes, 0), kinds, places, database };
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
  // Each suggestion says what it removes, how much space it frees, and whether chats lose anything.
  suggestions(now = Date.now()) {
    const list = [];
    const raw = this.rawOutput(now);
    list.push({ id: 'raw-output', label: 'Raw agent output older than 30 days', note: 'What agents printed while working (tool results, logs). Messages and the agent\'s memory of the chat stay; old runs show fewer details in Activity.', bytes: raw.bytes, count: raw.count });
    const media = this.oldMedia(now);
    list.push({ id: 'old-media', label: 'Screenshots and recordings older than 60 days', note: 'Agents\' evidence pictures and videos. The chat shows "file removed" where they were.', bytes: media.reduce((sum, item) => sum + item.size, 0), count: media.length });
    const twins = this.duplicates();
    list.push({ id: 'duplicates', label: 'Duplicate files', note: 'The same file kept more than once. The oldest copy stays.', bytes: twins.reduce((sum, item) => sum + item.size, 0), count: twins.length });
    const backups = this.oldBackups(now);
    list.push({ id: 'old-backups', label: 'Database backups older than 30 days', note: 'Copies Rex Desk made before big changes. The newest stays.', bytes: backups.reduce((sum, item) => sum + item.size, 0), count: backups.length });
    const copies = this.oldCopies();
    list.push({ id: 'old-copies', label: 'Old copies of the app for agents', note: 'Agents run from a copy of the current version; older ones are left over from updates.', bytes: copies.reduce((sum, item) => sum + item.size, 0), count: copies.length });
    return list;
  }
  rawOutput(now = Date.now()) {
    const before = new Date(now - 30 * DAY).toISOString();
    const row = this.store.db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(value)) AS bytes FROM events WHERE visible = 0 AND created_at < ?').get(before);
    return { before, count: Number(row?.n || 0), bytes: Number(row?.bytes || 0) };
  }
  filesIn(ids, keep = () => true) {
    const found = [];
    for (const place of this.places().filter(item => ids.includes(item.id))) walk(place.directory, (full, info) => { const relative = path.relative(place.directory, full); if (keep(full, info) && !this.protectedPath(place, relative)) found.push({ place: place.id, path: relative, size: info.size, modified: info.mtimeMs }); });
    return found;
  }
  oldMedia(now = Date.now()) { return this.filesIn(['artifacts', 'old-artifacts'], (full, info) => MEDIA.test(full) && now - info.mtimeMs > 60 * DAY); }
  oldBackups(now = Date.now()) {
    const all = this.filesIn(['backups']).sort((left, right) => right.modified - left.modified);
    return all.slice(1).filter(item => now - item.modified > 30 * DAY);
  }
  oldCopies() {
    const place = this.places().find(item => item.id === 'runtime'); if (!place || !this.version) return [];
    return readdirSync(place.directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== this.version).map(entry => ({ place: 'runtime', path: entry.name, size: sizeOf(path.join(place.directory, entry.name)).bytes }));
  }
  // Same size first, then the same contents; the oldest of each set stays.
  duplicates() {
    const bySize = new Map();
    for (const item of this.filesIn(['uploads', 'artifacts', 'old-artifacts', 'room-images'], (_, info) => info.size >= 1024)) { const list = bySize.get(item.size) || []; list.push(item); bySize.set(item.size, list); }
    const extra = [];
    for (const group of bySize.values()) {
      if (group.length < 2) continue;
      const byHash = new Map();
      for (const item of group) {
        const full = path.join(this.place(item.place).directory, item.path);
        let digest = ''; try { digest = createHash('sha256').update(readFileSync(full)).digest('hex'); } catch { continue; }
        const list = byHash.get(digest) || []; list.push(item); byHash.set(digest, list);
      }
      for (const twins of byHash.values()) if (twins.length > 1) extra.push(...twins.sort((left, right) => left.modified - right.modified).slice(1));
    }
    return extra;
  }
  // Runs one clean-up. Returns the space that came back, measured on disk before and after.
  // Runs one clean-up. Files freed are counted as they are deleted; raw agent output by how much the database file shrank.
  clean(id, now = Date.now()) {
    const before = this.usage().total, database = () => this.usage().database;
    let freed = 0;
    if (id === 'raw-output') { const start = database(); this.dropRawOutput(now); freed = Math.max(0, start - database()); }
    else if (id === 'old-media') freed = this.remove(this.oldMedia(now)).freed;
    else if (id === 'duplicates') freed = this.remove(this.duplicates()).freed;
    else if (id === 'old-backups') freed = this.remove(this.oldBackups(now)).freed;
    else if (id === 'old-copies') { for (const item of this.oldCopies()) { try { freed += this.remove([item]).freed; } catch { /* an agent still runs from it */ } } }
    else throw new Error('No such clean-up.');
    return { id, before, after: Math.max(0, before - freed), freed };
  }
  dropRawOutput(now = Date.now()) {
    const { before } = this.rawOutput(now), cloud = this.store.cloud;
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM events WHERE visible = 0 AND created_at < ?').run(before);
      if (cloud?.enabled) cloud.enqueue('DELETE FROM rex_events WHERE workspace=? AND visible=0 AND created_at < ?', [cloud.workspace, before]);
    });
    cloud?.schedule?.();
    // The database file gives the freed pages back to the disk.
    try { this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.store.db.exec('VACUUM'); this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: the space is reused by new messages instead */ }
  }
}

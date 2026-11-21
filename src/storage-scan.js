// The slow part of Settings › Storage: walking Rex Desk's folders, counting the database, hashing files for duplicates.
// These functions use only plain inputs (folders, the database file), so they run in a worker thread
// (src/storage-worker.js) and the desk's own thread keeps answering while they count.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DAY = 86400000;
export const MEDIA = /\.(png|jpe?g|gif|webp|bmp|mp4|webm|mov|mp3|wav|ogg|m4a)$/i;

export const walk = (folder, visit, depth = 0) => {
  if (depth > 12) return;
  let entries = []; try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(full, visit, depth + 1);
    else if (entry.isFile()) { try { const info = statSync(full); visit(full, info); } catch { /* gone meanwhile */ } }
  }
};
export const sizeOf = folder => { let bytes = 0, files = 0; walk(folder, (_, info) => { bytes += info.size; files += 1; }); return { bytes, files }; };
export const inside = (root, file) => { const full = path.resolve(root, file); return full === path.resolve(root) || full.startsWith(path.resolve(root) + path.sep) ? full : ''; };
const isProtected = (scope, placeId, relative) => placeId === 'runtime' && scope.version && relative.split(/[\\/]/)[0] === scope.version;

// scope: { places: [{ id, directory }], databaseDirectory, voiceDirectory, version }. A read-only connection of its own.
const openDatabase = scope => {
  const file = path.join(scope.databaseDirectory, 'desk.sqlite');
  try { return new DatabaseSync(file, { readOnly: true }); } catch { return new DatabaseSync(file); }
};
const withDatabase = (scope, use) => { const db = scope.db || openDatabase(scope); try { return use(db); } finally { if (!scope.db) db.close(); } };

export function usage(scope) {
  const file = name => { try { return statSync(path.join(scope.databaseDirectory, name)).size; } catch { return 0; } };
  const database = file('desk.sqlite') + file('desk.sqlite-wal');
  const rows = withDatabase(scope, db => db.prepare('SELECT visible, SUM(LENGTH(value)) AS bytes, COUNT(*) AS n FROM events GROUP BY visible').all());
  const chat = Number(rows.find(row => Number(row.visible) === 1)?.bytes || 0), raw = Number(rows.find(row => Number(row.visible) !== 1)?.bytes || 0);
  const places = scope.places.map(place => ({ id: place.id, label: place.label, ...sizeOf(place.directory) }));
  const models = scope.voiceDirectory && existsSync(scope.voiceDirectory) ? sizeOf(scope.voiceDirectory).bytes : 0;
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

export function rawOutput(scope, now = Date.now()) {
  const before = new Date(now - 30 * DAY).toISOString();
  const row = withDatabase(scope, db => db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(value)) AS bytes FROM events WHERE visible = 0 AND created_at < ?').get(before));
  return { before, count: Number(row?.n || 0), bytes: Number(row?.bytes || 0) };
}
export function filesIn(scope, ids, keep = () => true) {
  const found = [];
  for (const place of scope.places.filter(item => ids.includes(item.id))) walk(place.directory, (full, info) => { const relative = path.relative(place.directory, full); if (keep(full, info) && !isProtected(scope, place.id, relative)) found.push({ place: place.id, path: relative, size: info.size, modified: info.mtimeMs }); });
  return found;
}
export const oldMedia = (scope, now = Date.now()) => filesIn(scope, ['artifacts', 'old-artifacts'], (full, info) => MEDIA.test(full) && now - info.mtimeMs > 60 * DAY);
export function oldBackups(scope, now = Date.now()) {
  const all = filesIn(scope, ['backups']).sort((left, right) => right.modified - left.modified);
  return all.slice(1).filter(item => now - item.modified > 30 * DAY);
}
export function oldCopies(scope) {
  const place = scope.places.find(item => item.id === 'runtime'); if (!place || !scope.version) return [];
  let entries = []; try { entries = readdirSync(place.directory, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isDirectory() && entry.name !== scope.version).map(entry => ({ place: 'runtime', path: entry.name, size: sizeOf(path.join(place.directory, entry.name)).bytes }));
}
// Same size first, then the same contents; the oldest of each set stays. Files are read in pieces, so a big video never
// sits in memory whole.
const sameSizeGroups = scope => {
  const bySize = new Map();
  for (const item of filesIn(scope, ['uploads', 'artifacts', 'old-artifacts', 'room-images'], (_, info) => info.size >= 1024)) { const list = bySize.get(item.size) || []; list.push(item); bySize.set(item.size, list); }
  return [...bySize.values()].filter(group => group.length > 1);
};
const directoryOf = (scope, id) => scope.places.find(place => place.id === id)?.directory || '';
const pickTwins = byHash => [...byHash.values()].filter(twins => twins.length > 1).flatMap(twins => twins.sort((left, right) => left.modified - right.modified).slice(1));
const hashFile = file => new Promise((resolve, reject) => { const hash = createHash('sha256'); createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex'))); });
export async function duplicates(scope) {
  const extra = [];
  for (const group of sameSizeGroups(scope)) {
    const byHash = new Map();
    for (const item of group) {
      let digest = ''; try { digest = await hashFile(path.join(directoryOf(scope, item.place), item.path)); } catch { continue; }
      const list = byHash.get(digest) || []; list.push(item); byHash.set(digest, list);
    }
    extra.push(...pickTwins(byHash));
  }
  return extra;
}

// The clean-up rows. Duplicates are only counted when asked (bytes null until then): hashing every file is the slow part.
export async function suggestions(scope, now = Date.now(), { findDuplicates = false } = {}) {
  const list = [], sum = items => items.reduce((total, item) => total + item.size, 0);
  const raw = rawOutput(scope, now);
  list.push({ id: 'raw-output', label: 'Raw agent output older than 30 days', note: 'What agents printed while working (tool results, logs). Messages and the agent\'s memory of the chat stay; old runs show fewer details in Activity.', bytes: raw.bytes, count: raw.count });
  const media = oldMedia(scope, now);
  list.push({ id: 'old-media', label: 'Screenshots and recordings older than 60 days', note: 'Agents\' evidence pictures and videos. The chat shows "file removed" where they were.', bytes: sum(media), count: media.length });
  const twins = findDuplicates ? await duplicates(scope) : null;
  list.push({ id: 'duplicates', label: 'Duplicate files', note: 'The same file kept more than once. The oldest copy stays.', bytes: twins ? sum(twins) : null, count: twins ? twins.length : null });
  const backups = oldBackups(scope, now);
  list.push({ id: 'old-backups', label: 'Database backups older than 30 days', note: 'Copies Rex Desk made before big changes. The newest stays.', bytes: sum(backups), count: backups.length });
  const copies = oldCopies(scope);
  list.push({ id: 'old-copies', label: 'Old copies of the app for agents', note: 'Agents run from a copy of the current version; older ones are left over from updates.', bytes: sum(copies), count: copies.length });
  return list;
}

// One folder's contents with sizes (folders summed). Who owns each and what is locked is added on the desk's thread.
export function list(scope, placeId, folder = '') {
  const directory = inside(directoryOf(scope, placeId), folder), root = directoryOf(scope, placeId);
  if (!root || !directory || !existsSync(directory)) throw new Error('That folder is gone.');
  const items = [];
  // Each file you attach sits in a folder of its own with a code name: the files are listed by their own names instead.
  const entries = readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (placeId !== 'uploads' || folder || !entry.isDirectory()) return [{ entry, directory }];
    let inner = []; try { inner = readdirSync(path.join(directory, entry.name), { withFileTypes: true }); } catch { return [{ entry, directory }]; }
    return inner.length && inner.every(item => item.isFile()) ? inner.map(item => ({ entry: item, directory: path.join(directory, entry.name) })) : [{ entry, directory }];
  });
  for (const { entry, directory } of entries) {
    const full = path.join(directory, entry.name), relative = path.relative(root, full);
    try {
      if (entry.isDirectory()) { const { bytes, files } = sizeOf(full); items.push({ name: entry.name, path: relative, folder: true, size: bytes, files, modified: statSync(full).mtime.toISOString() }); }
      else if (entry.isFile()) { const info = statSync(full); items.push({ name: entry.name, path: relative, folder: false, size: info.size, modified: info.mtime.toISOString() }); }
    } catch { /* gone meanwhile */ }
  }
  return items;
}
export function search(scope, query, limit = 200) {
  const want = String(query || '').trim().toLowerCase(); if (!want) return [];
  const found = [];
  for (const place of scope.places) walk(place.directory, (full, info) => {
    if (found.length >= limit || !path.basename(full).toLowerCase().includes(want)) return;
    found.push({ place: place.id, name: path.basename(full), path: path.relative(place.directory, full), folder: false, size: info.size, modified: info.mtime.toISOString() });
  });
  return found.sort((left, right) => right.size - left.size);
}

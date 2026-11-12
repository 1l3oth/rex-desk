import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Files a workspace keeps beside its database: pictures attached in chats, room pictures, screenshots and other evidence, and
// the person's memory folder (who they are, their profile photo, agents' notes and homes). The database backup has the chats;
// this keeps the files they point to, so a reinstall, a cleared data folder or a new computer gets everything back.
export const FILE_LIMIT = 4 * 1024 * 1024;
const MAX_FILES = 5000;
const SKIP = new Set(['node_modules', '.git', '.cache', 'cache', 'worktrees', 'tmp', 'temp', '__pycache__', '.venv', 'venv', 'dist', 'build']);
const DATA_FOLDERS = ['uploads', 'room-images', 'artifacts'];

export class FileBackup {
  constructor(sync) { this.sync = sync; this.memoryDirectory = ''; this.indexFile = path.join(sync.store.directory, 'file-backup.json'); }
  // Each backed-up file has a key: data/<folder>/... inside the workspace, memory/... inside the memory folder.
  roots() {
    const roots = DATA_FOLDERS.map(folder => ({ prefix: `data/${folder}/`, directory: path.join(this.sync.store.directory, folder) }));
    if (this.memoryDirectory) roots.push({ prefix: 'memory/', directory: this.memoryDirectory });
    return roots;
  }
  // The local file for a key, never outside its root.
  local(key) {
    const root = this.roots().find(item => key.startsWith(item.prefix));
    if (!root) return '';
    const file = path.resolve(root.directory, ...key.slice(root.prefix.length).split('/'));
    return file.startsWith(path.resolve(root.directory) + path.sep) ? file : '';
  }
  walk() {
    const found = [];
    for (const root of this.roots()) {
      const visit = (directory, relative) => {
        let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (found.length >= MAX_FILES) return;
          const full = path.join(directory, entry.name), key = `${root.prefix}${relative}${entry.name}`;
          if (entry.isDirectory()) { if (!SKIP.has(entry.name.toLowerCase())) visit(full, `${relative}${entry.name}/`); continue; }
          if (!entry.isFile() || /\.(tmp|lock)$/i.test(entry.name)) continue;
          try { const stat = statSync(full); if (stat.size <= FILE_LIMIT) found.push({ key, file: full, stamp: `${stat.size}:${Math.floor(stat.mtimeMs)}` }); } catch { /* gone */ }
        }
      };
      visit(root.directory, '');
    }
    return found;
  }
  index() { try { return JSON.parse(readFileSync(this.indexFile, 'utf8')); } catch { return null; } }
  saveIndex(index) { const temporary = `${this.indexFile}.tmp`; writeFileSync(temporary, JSON.stringify(index), { mode: 0o600 }); renameSync(temporary, this.indexFile); }
  // Upload new and changed files, one at a time. Files deleted here stay in the backup.
  async backup() {
    const { client, store, workspace } = this.sync;
    const index = this.index() || { files: {} }; let uploaded = 0;
    for (const item of this.walk()) {
      if (index.files[item.key] === item.stamp) continue;
      let data; try { data = readFileSync(item.file); } catch { continue; }
      await client.execute({ sql: 'INSERT INTO rex_files(workspace,path,size,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace,path) DO UPDATE SET size=excluded.size,data=excluded.data,updated_at=excluded.updated_at',
        args: [workspace, item.key, data.length, store.encryptBytes(data), new Date().toISOString()] });
      index.files[item.key] = item.stamp; uploaded += 1;
      if (uploaded % 20 === 0) this.saveIndex(index);
    }
    this.saveIndex(index);
    return { uploaded };
  }
  // A workspace without its file list lost its files (a reinstall, a cleared data folder, a new computer): put back every
  // backed-up file that is missing here. Files already here are kept as they are.
  async restoreMissing() {
    const { client, store, workspace } = this.sync;
    const listed = await client.execute({ sql: 'SELECT path FROM rex_files WHERE workspace=?', args: [workspace] });
    let restored = 0; const index = { files: {} };
    for (const row of listed.rows) {
      const file = this.local(String(row.path));
      if (!file || existsSync(file)) continue;
      const got = await client.execute({ sql: 'SELECT data FROM rex_files WHERE workspace=? AND path=?', args: [workspace, row.path] });
      if (!got.rows[0]) continue;
      try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, store.decryptBytes(String(got.rows[0].data))); restored += 1;
        const stat = statSync(file); index.files[String(row.path)] = `${stat.size}:${Math.floor(stat.mtimeMs)}`; } catch { /* another vault key, or no room */ }
    }
    // What came back is already in the backup, so it is not uploaded again.
    this.saveIndex(index);
    return { restored };
  }
  // Run after each connection and every few minutes; one pass at a time.
  run() {
    if (this.running || !this.sync.ready || this.sync.closed) return this.running;
    this.running = (async () => {
      try {
        if (!this.index()) { const result = await this.restoreMissing(); this.lastRestored = result.restored; if (result.restored) this.sync.notify(); }
        await this.backup(); this.error = '';
      } catch (error) { this.error = String(error.message || error); }
      finally { this.running = null; }
    })();
    return this.running;
  }
}

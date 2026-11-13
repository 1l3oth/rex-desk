import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Files a workspace keeps beside its database: pictures attached in chats, room pictures, screenshots and other evidence, and
// the person's memory folder (who they are, their profile photo, agents' notes and homes). The database backup has the chats;
// this keeps the files they point to, so a reinstall, a cleared data folder or a new computer gets everything back.
export const FILE_LIMIT = 4 * 1024 * 1024;
// Each folder has its own limit, so one busy folder never crowds out the others.
const MAX_FILES = 2000;
// Evidence folders keep what proves the work (pictures, recordings, reports, text); an agent's copy of source code is not kept.
export const EVIDENCE = /\.(png|jpe?g|webp|gif|svg|bmp|mp3|mp4|webm|wav|ogg|m4a|mov|html?|txt|md|json|pdf|log|csv)$/i;
const SKIP = new Set(['node_modules', '.git', '.cache', 'cache', 'worktrees', 'tmp', 'temp', '__pycache__', '.venv', 'venv', 'dist', 'build']);
const DATA_FOLDERS = ['uploads', 'room-images', 'artifacts'];

export class FileBackup {
  constructor(sync) { this.sync = sync; this.memoryDirectory = ''; this.indexFile = path.join(sync.store.directory, 'file-backup.json'); }
  // Each backed-up file has a key: data/<folder>/... inside the workspace, memory/... inside the memory folder.
  roots() {
    // The memory folder first: who the person is and their photo matter most.
    const roots = DATA_FOLDERS.map(folder => ({ prefix: `data/${folder}/`, directory: this.sync.store.media(folder), only: folder === 'artifacts' ? EVIDENCE : null }));
    if (this.memoryDirectory) roots.unshift({ prefix: 'memory/', directory: this.memoryDirectory, only: null });
    return roots;
  }
  // The local file for a key, never outside its root.
  local(key) {
    const root = this.roots().find(item => key.startsWith(item.prefix));
    if (!root || (root.only && !root.only.test(key))) return '';
    const file = path.resolve(root.directory, ...key.slice(root.prefix.length).split('/'));
    return file.startsWith(path.resolve(root.directory) + path.sep) ? file : '';
  }
  // Folders of a project kept out of the cloud stay here: an agent's own folder and the evidence of its chats.
  kept(key) {
    const store = this.sync.store, agent = /^memory\/agents\/home\/([^/]+)\/$/.exec(key), run = /^data\/artifacts\/([^/]+)\/$/.exec(key);
    return agent ? store.privateAgent(agent[1]) : run ? store.privateRun(run[1]) : false;
  }
  // The backup forgets these folders, so they go up again if the project uses the cloud later.
  forget(prefixes) {
    const index = this.index(); if (!index) return;
    for (const key of Object.keys(index.files)) if (prefixes.some(prefix => key.startsWith(prefix))) delete index.files[key];
    this.saveIndex(index);
  }
  walk() {
    const found = [];
    for (const root of this.roots()) {
      let counted = 0;
      const visit = (directory, relative) => {
        let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (counted >= MAX_FILES) return;
          const full = path.join(directory, entry.name), key = `${root.prefix}${relative}${entry.name}`;
          if (entry.isDirectory()) { if (!SKIP.has(entry.name.toLowerCase()) && !this.kept(`${key}/`)) visit(full, `${relative}${entry.name}/`); continue; }
          if (!entry.isFile() || /\.(tmp|lock)$/i.test(entry.name) || (root.only && !root.only.test(entry.name))) continue;
          try { const stat = statSync(full); if (stat.size <= FILE_LIMIT) { counted += 1; found.push({ key, file: full, stamp: `${stat.size}:${Math.floor(stat.mtimeMs)}` }); } } catch { /* gone */ }
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
  // Soon after something changes (a picture attached, a photo set), without starting over on every chat message.
  soon(delay = 20000) {
    if (this.soonTimer || this.sync.closed) return;
    this.soonTimer = setTimeout(() => { this.soonTimer = null; void this.run(); }, delay); this.soonTimer.unref?.();
  }
  // Run after each connection, soon after changes and every few minutes; one pass at a time.
  // A call during a pass gets one more pass after it, so a file added meanwhile is not missed.
  run() {
    if (this.running) { this.again = true; return this.running.then(() => this.running); }
    if (!this.sync.ready || this.sync.closed) return Promise.resolve();
    this.running = (async () => {
      try {
        if (!this.index()) { const result = await this.restoreMissing(); this.lastRestored = result.restored; if (result.restored) this.sync.notify(); }
        await this.backup(); this.error = '';
      } catch (error) { this.error = String(error.message || error); }
      finally { this.running = null; if (this.again && !this.sync.closed) { this.again = false; this.running = this.run(); } }
    })();
    return this.running;
  }
}

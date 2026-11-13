// The file window: open any file the person or an agent points at, save edits, format with Prettier,
// and turn Excel and Word files into something a browser can show. Only folders Rex Desk works with are open to it,
// and the app's own data folder (where the keys live) and private key files never are.
import { readFileSync, writeFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export const TEXT_MAX = 1.8 * 1024 * 1024;
const EXT = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif'],
  video: ['.mp4', '.webm', '.mov', '.m4v', '.ogv'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.flac'],
  pdf: ['.pdf'],
  sheet: ['.xlsx', '.xlsm', '.xls', '.ods'],
  doc: ['.docx'],
};
const MIME = { '.avif': 'image/avif', '.m4v': 'video/mp4', '.ogv': 'video/ogg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };
const SECRET = /(^|[\\/])(\.credentials\.json|id_(rsa|ed25519|ecdsa)(\.pub)?|[^\\/]+\.(pem|key|p12|pfx))$/i;
const PRETTIER = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json', '.jsonc', '.json5', '.css', '.scss', '.less', '.html', '.htm', '.vue', '.md', '.markdown', '.mdx', '.yaml', '.yml', '.graphql', '.gql', '.hbs', '.handlebars'];

export const kindOf = (file, head = null) => {
  const ext = path.extname(file).toLowerCase();
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return kind;
  if (head && head.includes(0)) return 'binary';
  return ['.md', '.markdown', '.mdx'].includes(ext) ? 'markdown' : ['.html', '.htm'].includes(ext) ? 'html' : ext === '.csv' || ext === '.tsv' ? 'csv' : 'text';
};
export const mimeOf = file => MIME[path.extname(file).toLowerCase()];
const inside = (file, root) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

export class Files {
  constructor(desk) { this.desk = desk; }
  // Folders the window may open: home, every project, the agents' worktrees, project memory, the notes vault, shared evidence.
  roots() {
    const config = this.desk.store.config(), roots = [os.homedir(), this.desk.worktreeRoot, this.desk.memory?.directory, path.join(this.desk.store.directory, 'artifacts'), path.join(this.desk.store.directory, 'uploads')];
    // Every project Rex Desk knows: the ones set up, the ones it found on this computer, and Rex Desk itself.
    for (const repo of [...(config.repositories || []), ...(this.desk.store.list?.('repository') || [])]) roots.push(repo.path);
    roots.push(this.desk.root);
    const brain = String(this.desk.memory?.secondBrain?.() || '').match(/[A-Za-z]:[\\/][^\s`'")\]]+/);
    if (brain) roots.push(brain[0]);
    return roots.filter(Boolean).map(root => path.resolve(root));
  }
  // The app's own data folder holds encrypted keys and sign-ins: never open it, except the evidence agents shared.
  check(file) {
    const full = path.resolve(file), store = path.resolve(this.desk.store.directory), shared = [path.join(store, 'artifacts'), path.join(store, 'uploads')];
    // Shared evidence and the files people attached open; the rest of the data folder (keys, sign-ins) never does.
    if (inside(full, store) && !shared.some(folder => inside(full, folder))) throw new Error('That file is part of Rex Desk\'s private data (keys and sign-ins), so it does not open here.');
    if (SECRET.test(full)) throw new Error('That looks like a private key or a sign-in file, so it does not open here.');
    if (!this.roots().some(root => inside(full, root))) throw new Error('Rex Desk opens files in your home folder, your projects, the agents\' worktrees and your notes vault. That file is outside them.');
    return full;
  }
  // The folders a chat works in: the run's worktree and project; in a group chat, the worktrees and projects of the work done in that room.
  bases(runId = '', roomId = '') {
    const runs = this.desk.store.list('run'), repos = [...(this.desk.store.config().repositories || []), ...(this.desk.store.list('repository') || [])];
    const mine = runs.filter(run => (runId && run.id === runId) || (roomId && (run.roomId === roomId || run.roomOf === roomId || this.desk.store.list('task').some(task => task.roomWork?.roomId === roomId && run.taskIds?.includes(task.id)))));
    mine.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    const own = mine.flatMap(run => [run.worktree, repos.find(repo => repo.id === run.repositoryId)?.path, run.projectPath]);
    return [...new Set([...own, ...repos.map(repo => repo.path), this.desk.memory?.directory].filter(Boolean).map(base => path.resolve(base)))];
  }
  // Every file git tracks in a folder, kept for a minute, so a path written short (`apiCall/task/index.js`) is found deep in a project.
  tracked(base) {
    this.cache ||= new Map(); const hit = this.cache.get(base);
    if (hit && Date.now() - hit.at < 60000) return hit.files;
    let files = [];
    try { files = execFileSync('git', ['-C', base, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 15000 }).split('\n').filter(Boolean); } catch { /* not a git folder */ }
    this.cache.set(base, { at: Date.now(), files }); return files;
  }
  // "src/server.js:42", "src/server.js:42-58", "file:///F:/x.md", "F:\\x\\y.ts#L10-L20": the path and the line, or a range of lines to highlight. A relative path is looked up in the chat's worktrees and projects:
  // first as written, then as the end of a longer path.
  resolve(input, runId = '', roomId = '') {
    let text = String(input || '').trim().replace(/^file:\/\/\/?/i, '').replace(/^["'`]|["'`]$/g, ''), line = 0, endLine = 0;
    try { text = decodeURIComponent(text); } catch { /* keep as is */ }
    const hash = text.match(/#L(\d+)(?:-L?(\d+))?$/); if (hash) { line = Number(hash[1]); endLine = Number(hash[2] || 0); text = text.slice(0, hash.index); }
    const colon = text.match(/:(\d+)(?:-(\d+)|:\d+)?$/); if (colon && !/^[A-Za-z]:$/.test(text.slice(0, colon.index))) { line = Number(colon[1]); endLine = Number(colon[2] || 0); text = text.slice(0, colon.index); }
    endLine = endLine > line ? endLine : 0;
    if (!text) throw new Error('Name a file to open.');
    // A file someone attached is linked as /api/uploads/file?path=<the file>.
    const upload = text.match(/^\/api\/uploads\/file\?path=(.+)$/); if (upload) text = upload[1];
    // Evidence an agent shared is linked as /artifacts/<run>/<name>.
    const sharedLink = text.match(/^\/artifacts\/([\w-]+)\/([^/\\]+)$/);
    if (sharedLink) return { file: this.check(path.join(this.desk.store.directory, 'artifacts', sharedLink[1], sharedLink[2])), line, endLine };
    if (path.isAbsolute(text)) return { file: this.check(text), line, endLine };
    const bases = this.bases(runId, roomId);
    for (const base of bases) { const full = path.resolve(base, text); if (existsSync(full)) return { file: this.check(full), line, endLine }; }
    const tail = `/${text.replace(/\\/g, '/').replace(/^\.?\//, '')}`;
    for (const base of bases) {
      const found = this.tracked(base).filter(file => `/${file}`.endsWith(tail));
      if (found.length) return { file: this.check(path.join(base, found.sort((left, right) => left.length - right.length)[0])), line, endLine };
    }
    throw new Error(`No file named ${text} in this chat's worktrees or your projects.`);
  }
  // A page an agent shared from another computer is not on this disk yet: it is written from the shared copy of the chat.
  restoreShared(file) {
    const root = path.join(this.desk.store.directory, 'artifacts') + path.sep, full = path.resolve(file);
    if (!full.toLowerCase().startsWith(root.toLowerCase())) return;
    const [runId, name] = path.relative(root, full).split(path.sep); if (!runId || !name) return;
    try { this.desk.peers.restoreEvidence(runId, name); } catch {}
  }
  open(input, runId, roomId) {
    const { file, line, endLine } = this.resolve(input, runId, roomId);
    if (!existsSync(file)) this.restoreShared(file);
    if (!existsSync(file)) throw new Error(`${file} does not exist.`);
    const stat = statSync(file); if (stat.isDirectory()) throw new Error(`${file} is a folder. Name a file in it.`);
    const head = Buffer.alloc(Math.min(stat.size, 8192)); if (head.length) { const fd = openSync(file, 'r'); try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); } }
    const kind = kindOf(file, head), ext = path.extname(file).toLowerCase(), textual = ['text', 'markdown', 'html', 'csv'].includes(kind) || (kind === 'image' && ext === '.svg');
    const result = { path: file, name: path.basename(file), ext, kind, size: stat.size, mtime: stat.mtimeMs, line, endLine, formattable: PRETTIER.includes(ext), editable: textual && stat.size <= TEXT_MAX };
    if (result.editable) result.text = readFileSync(file, 'utf8');
    return result;
  }
  save(input, { text, mtime, force = false } = {}) {
    const file = this.check(input);
    if (typeof text !== 'string') throw new Error('Send the text to save.');
    if (Buffer.byteLength(text) > TEXT_MAX) throw new Error('That file is too big to save from here.');
    if (/[\\/]\.git([\\/]|$)/.test(file)) throw new Error('Files inside .git are not edited here.');
    if (existsSync(file) && !force && mtime && Math.abs(statSync(file).mtimeMs - Number(mtime)) > 1) { const error = new Error('Someone else changed this file after you opened it. Reload it, or save anyway.'); error.status = 409; throw error; }
    writeFileSync(file, text);
    return { saved: true, mtime: statSync(file).mtimeMs };
  }
  async format(input, text) {
    const file = this.check(input), prettier = await import('prettier');
    if (!PRETTIER.includes(path.extname(file).toLowerCase())) throw new Error('Prettier does not format this kind of file.');
    const options = await prettier.resolveConfig(file).catch(() => null) || {};
    return { text: await prettier.format(String(text ?? readFileSync(file, 'utf8')), { ...options, filepath: file }) };
  }
  // Every sheet as rows of text, capped so a huge workbook still opens fast.
  async sheet(input, { rows = 1000, cols = 60 } = {}) {
    const file = this.check(input), XLSX = (await import('xlsx')).default;
    const book = XLSX.read(readFileSync(file), { type: 'buffer', cellDates: true, sheetRows: rows + 1 });
    return { sheets: book.SheetNames.map(name => {
      const all = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
      return { name, rows: all.slice(0, rows).map(row => row.slice(0, cols).map(cell => String(cell))), more: all.length > rows || all.some(row => row.length > cols) };
    }) };
  }
  async doc(input) {
    const file = this.check(input), mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.convertToHtml({ path: file });
    return `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 20px;color:#1d2228}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}@media (prefers-color-scheme:dark){body{background:#16191d;color:#e6e8eb}}</style>${value}`;
  }
  // Open in the program Windows uses for it, or show it in Explorer.
  reveal(input, how = 'app') {
    const file = this.check(input); if (!existsSync(file)) throw new Error(`${file} does not exist.`);
    const [command, args] = process.platform === 'win32' ? (how === 'folder' ? ['explorer.exe', [`/select,${file}`]] : ['cmd.exe', ['/c', 'start', '""', file]])
      : process.platform === 'darwin' ? ['open', how === 'folder' ? ['-R', file] : [file]] : ['xdg-open', [how === 'folder' ? path.dirname(file) : file]];
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { opened: true };
  }
}

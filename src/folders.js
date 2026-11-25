// Where Rex Desk keeps things on this computer, and moving them. Three folders, each changeable in Settings, Folders:
// - data: chats, tasks, settings and keys (the database). Moved while the server is stopped, on the next start.
// - memory: the AI memory every agent reads (what it knows about the person and the projects). Also moved on the next start.
// - files: screenshots, recordings and attachments. Moved at once, since nothing holds them open.
// A move copies first and switches only after the copy is complete; the old folder stays as a backup the person can delete.
import { copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOVED = 'moved-to.txt', PENDING = 'move-pending.json';
export const MEDIA_FOLDERS = ['artifacts', 'uploads', 'room-images'];
// A source checkout run as development (npm start: port 4318, see defaultPort in server.js) is kept apart from the real
// Rex Desk on the same computer: its own home folder (AI memory, project list, folder pointers) and no cloud unless
// REX_DEV_CLOUD=1. The installed app, and a checkout used as the real app (Start-RexDesk.ps1, port 4317), are not development.
export const development = (env = process.env) => !env.NODE_TEST_CONTEXT
  && Number(env.PORT || (env.REX_DESK_VERSION || env.REX_RESTART_AFTER ? 4317 : 4318)) !== 4317;

// Fixed small files outside the folders that move, so every start finds where the folders went. Development keeps them
// (and its AI memory) in ~/.rexdesk-dev, so it never moves the real app's data or writes into its memory.
export const pointerHome = (home = os.homedir(), env = process.env) => path.join(home, development(env) ? '.rexdesk-dev' : '.rexdesk');
const readLine = file => { try { return readFileSync(file, 'utf8').split(/\r?\n/)[0].replace(/^\uFEFF/, '').trim(); } catch { return ''; } };
const inside = (child, parent) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
// Free bytes on the drive of a folder, or of its nearest parent that exists (the target of a move is often not made yet).
export const freeOn = folder => { let at = path.resolve(folder); while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at); try { const disk = statfsSync(at); return Number(disk.bavail) * Number(disk.bsize); } catch { return Infinity; } };
const drive = folder => { const resolved = path.resolve(folder); return /^[a-z]:/i.test(resolved) ? resolved.slice(0, 2).toUpperCase() : resolved; };
const mb = bytes => Math.max(0, Math.round(bytes / 1048576));
// Room kept free on the drive after a move, so the database still has space to grow and Windows keeps working.
const MOVE_SPARE = 200 * 1048576;
const holdsWorkspace = folder => existsSync(path.join(folder, 'desk.sqlite')) || existsSync(path.join(folder, 'accounts.json'));

// The AI memory folder: an override from the environment, else the folder it was moved to, else ~/.rexdesk.
export function memoryFolder(env = process.env, home = os.homedir()) {
  if (env.REX_DESK_MEMORY) return path.resolve(env.REX_DESK_MEMORY);
  const moved = readLine(path.join(pointerHome(home, env), 'memory-folder.txt'));
  return path.resolve(moved && existsSync(moved) ? moved : pointerHome(home, env));
}

// Checks a folder the person picked. It must be a real absolute folder, not inside the folder being moved, and empty
// (or missing), so a move never mixes into or overwrites something else.
export function checkTarget(from, to) {
  if (!to || !path.isAbsolute(to)) throw new Error('Pick a full folder path, like C:\\Users\\you\\Rex Desk.');
  const target = path.resolve(to), source = path.resolve(from);
  if (target.toLowerCase() === source.toLowerCase()) throw new Error('That is already where it is.');
  if (inside(target, source)) throw new Error('The new folder cannot be inside the current one.');
  if (inside(source, target)) throw new Error('The new folder cannot hold the current one.');
  if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length)) throw new Error('Pick an empty folder, or a new folder name. That one already has files in it.');
  return target;
}

// Copies everything file by file, then checks the copy has every file with the same size before the caller switches over.
// Not Node's cpSync: it is native code, and on Windows it ended the whole server while moving a data folder (exit 0xC0000409,
// no message), which left Rex Desk unable to start. Copying file by file turns any problem into an error that is reported.
// It reports progress for the waiting page.
// It first checks the new drive has room for everything (plus a spare 200 MB): a copy that ran out of space partway
// ("ENOSPC: no space left on device") left a half-copied folder that filled the drive even more.
export async function copyAll(from, to, skip = () => false, progress = () => {}, free = freeOn) {
  const files = [], folders = [];
  const walk = (folder, relative) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const source = path.join(folder, entry.name), name = path.join(relative, entry.name);
      if (skip(source)) continue;
      if (entry.isDirectory()) { folders.push(name); walk(source, name); } else if (entry.isFile()) files.push(name);
    }
  };
  walk(from, '');
  const size = files.reduce((sum, name) => { try { return sum + statSync(path.join(from, name)).size; } catch { return sum; } }, 0), left = free(to);
  if (left < size + MOVE_SPARE) throw new Error(`Not enough free space on the ${drive(to)} drive: your data needs ${mb(size + MOVE_SPARE)} MB and ${mb(left)} MB is free. Free some space or pick another drive. Nothing was moved.`);
  mkdirSync(to, { recursive: true });
  for (const folder of folders) mkdirSync(path.join(to, folder), { recursive: true });
  for (let index = 0; index < files.length; index++) {
    // Copied in the background (not copyFileSync), so the server still answers while a large database file copies.
    await copyFile(path.join(from, files[index]), path.join(to, files[index]), constants.COPYFILE_EXCL);
    if (index % 20 === 0) progress(index, files.length);
  }
  const missing = files.filter(name => { try { return statSync(path.join(to, name)).size !== statSync(path.join(from, name)).size; } catch { return true; } });
  if (missing.length) throw new Error(`The copy is missing ${missing.length} files (for example ${missing[0]}), so nothing was moved.`);
  progress(files.length, files.length);
}

// Files copied into a folder Windows compresses (a whole drive can be set to save space) are compressed too, and a compressed
// database on a hard disk is read so slowly that Rex Desk stopped answering for minutes. The moved data is kept uncompressed.
// Best effort: elsewhere, or when it fails, the move still counts.
export async function uncompress(folder, platform = process.platform) {
  if (platform !== 'win32') return;
  await new Promise(resolve => execFile('compact.exe', ['/u', '/s', '/i', '/q'], { cwd: folder, windowsHide: true, timeout: 600000 }, () => resolve()));
}

// People pick the folder they think of (Documents, a drive), not an empty one: a picked folder that already holds things
// gets a named folder inside it instead.
const settle = (to, name) => { const target = path.resolve(String(to || '')); return path.isAbsolute(String(to || '')) && existsSync(target) && statSync(target).isDirectory() && readdirSync(target).length ? path.join(target, name) : to; };

// Ask for the data folder to move on the next start. Returns where it will go.
export function planDataMove(dataRoot, to) {
  const target = checkTarget(dataRoot, settle(to, 'Rex Desk'));
  writeFileSync(path.join(dataRoot, PENDING), JSON.stringify({ to: target, at: new Date().toISOString() }));
  return target;
}

// Called on every start, before the database opens. Follows a finished move, or does a planned one once the previous
// server has let go of the folder. Any failure keeps the old folder, so Rex Desk always opens.
export async function followDataMove(dataRoot, { home = os.homedir(), waitForOld = async () => {}, log = () => {}, progress = () => {} } = {}) {
  const moved = readLine(path.join(dataRoot, MOVED));
  if (moved && holdsWorkspace(moved)) return moved;
  const pendingFile = path.join(dataRoot, PENDING);
  if (!existsSync(pendingFile)) return dataRoot;
  let plan; try { plan = JSON.parse(readFileSync(pendingFile, 'utf8')); } catch { rmSync(pendingFile, { force: true }); return dataRoot; }
  let copying = null;
  try {
    // A move that stopped the server partway (twice) is given up, so Rex Desk opens from the old folder instead of never opening.
    const tries = Number(plan.tries) || 0;
    if (tries >= 2) throw new Error('Rex Desk stopped while moving the data, so it stays in the old folder. Empty the new folder and try again.');
    writeFileSync(pendingFile, JSON.stringify({ ...plan, tries: tries + 1 }));
    await waitForOld();
    const target = checkTarget(dataRoot, plan.to);
    copying = { target, existed: existsSync(target) };
    await copyAll(dataRoot, target, source => [PENDING, 'runtime.lock'].includes(path.basename(source)) && path.dirname(source) === dataRoot, progress);
    await uncompress(target);
    writeFileSync(path.join(dataRoot, MOVED), target);
    // The desktop app reads this pointer to find the workspace on its next launch.
    mkdirSync(pointerHome(home), { recursive: true }); writeFileSync(path.join(pointerHome(home), 'data-folder.txt'), target);
    rmSync(pendingFile, { force: true });
    log(`Moved Rex Desk data from ${dataRoot} to ${target}. The old folder is kept as a backup.`);
    return target;
  } catch (error) {
    // A full drive is said in plain words, and the half-made copy is removed so it does not keep the space (the folder was
    // empty or new before the copy, so only what this move wrote is removed).
    const message = error?.code === 'ENOSPC' || /ENOSPC/.test(String(error?.message)) ? `The ${drive(plan.to)} drive ran out of space while moving your data (${mb(freeOn(plan.to))} MB free). Free some space or pick another drive. Your data stays in the old folder.` : error.message;
    if (copying) { try { if (copying.existed) for (const name of readdirSync(copying.target)) rmSync(path.join(copying.target, name), { recursive: true, force: true }); else rmSync(copying.target, { recursive: true, force: true }); } catch { /* best effort */ } }
    writeFileSync(pendingFile.replace(/\.json$/, '.failed.json'), JSON.stringify({ ...plan, error: message }));
    rmSync(pendingFile, { force: true });
    log(`Could not move Rex Desk data: ${message}`);
    return dataRoot;
  }
}

// Ask for the AI memory to move on the next start.
export function planMemoryMove(to, { env = process.env, home = os.homedir() } = {}) {
  if (env.REX_DESK_MEMORY) throw new Error('The memory folder is set by REX_DESK_MEMORY on this computer, so it cannot be moved here.');
  const from = memoryFolder(env, home), target = checkTarget(from, settle(to, 'Rex Desk memory'));
  mkdirSync(pointerHome(home, env), { recursive: true });
  writeFileSync(path.join(pointerHome(home, env), 'memory-move.json'), JSON.stringify({ from, to: target, at: new Date().toISOString() }));
  return target;
}

// Called on every start, before the memory opens.
export async function followMemoryMove({ env = process.env, home = os.homedir(), log = () => {} } = {}) {
  const file = path.join(pointerHome(home, env), 'memory-move.json');
  if (env.REX_DESK_MEMORY || !existsSync(file)) return memoryFolder(env, home);
  try {
    const plan = JSON.parse(readFileSync(file, 'utf8')), target = checkTarget(plan.from, plan.to);
    // Moving out of ~/.rexdesk leaves the small pointer files behind; they are not memory.
    const pointers = new Set(['memory-move.json', 'memory-folder.txt', 'data-folder.txt']);
    await copyAll(plan.from, target, source => pointers.has(path.basename(source)) && path.dirname(source) === plan.from);
    writeFileSync(path.join(pointerHome(home, env), 'memory-folder.txt'), target);
    log(`Moved the AI memory from ${plan.from} to ${target}. The old folder is kept as a backup.`);
  } catch (error) { log(`Could not move the AI memory: ${error.message}`); }
  rmSync(file, { force: true });
  return memoryFolder(env, home);
}

// The files folder moves at once: copy each part, switch the setting, then remove the old copies.
export async function moveMedia(store, to) {
  to = settle(to, 'Rex Desk');
  const from = store.filesFolder(), target = path.resolve(String(to || ''));
  if (!to || !path.isAbsolute(String(to))) throw new Error('Pick a full folder path.');
  if (target.toLowerCase() === path.resolve(from).toLowerCase()) throw new Error('That is already where it is.');
  if (inside(target, store.directory) && target.toLowerCase() !== store.directory.toLowerCase()) throw new Error('Pick a folder outside Rex Desk\'s data folder.');
  for (const folder of MEDIA_FOLDERS) if (existsSync(path.join(target, folder)) && readdirSync(path.join(target, folder)).length) throw new Error(`That folder already has a ${folder} folder with files in it. Pick another one.`);
  mkdirSync(target, { recursive: true });
  for (const folder of MEDIA_FOLDERS) if (existsSync(path.join(from, folder))) await copyAll(path.join(from, folder), path.join(target, folder));
  store.setFilesFolder(target);
  for (const folder of MEDIA_FOLDERS) {
    const old = path.join(from, folder);
    // Leave the data folder's own (now unused) folders in place but empty them; remove them anywhere else.
    try { if (existsSync(old)) { const aside = `${old}.moved-${Date.now()}`; renameSync(old, aside); rmSync(aside, { recursive: true, force: true }); } } catch { /* an open file keeps the old copy; it is harmless */ }
  }
  return target;
}

// What Settings shows.
export function folderStatus({ dataRoot, store, memory }) {
  const pending = (() => { try { return JSON.parse(readFileSync(path.join(dataRoot, PENDING), 'utf8')).to; } catch { return ''; } })();
  const failed = (() => { try { return JSON.parse(readFileSync(path.join(dataRoot, 'move-pending.failed.json'), 'utf8')).error; } catch { return ''; } })();
  const memoryPending = (() => { try { return JSON.parse(readFileSync(path.join(pointerHome(), 'memory-move.json'), 'utf8')).to; } catch { return ''; } })();
  return { data: dataRoot, dataPending: pending, dataFailed: failed, memory, memoryPending, files: store.filesFolder(),
    filesInData: store.filesFolder() === store.directory };
}

// Where Rex Desk keeps things on this computer, and moving them. Three folders, each changeable in Settings, Folders:
// - data: chats, tasks, settings and keys (the database). Moved while the server is stopped, on the next start.
// - memory: the AI memory every agent reads (what it knows about the person and the projects). Also moved on the next start.
// - files: screenshots, recordings and attachments. Moved at once, since nothing holds them open.
// A move copies first and switches only after the copy is complete; the old folder stays as a backup the person can delete.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOVED = 'moved-to.txt', PENDING = 'move-pending.json';
export const MEDIA_FOLDERS = ['artifacts', 'uploads', 'room-images'];
// Fixed small files outside the folders that move, so every start finds where the folders went.
export const pointerHome = (home = os.homedir()) => path.join(home, '.rexdesk');
const readLine = file => { try { return readFileSync(file, 'utf8').split(/\r?\n/)[0].replace(/^\uFEFF/, '').trim(); } catch { return ''; } };
const inside = (child, parent) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
const holdsWorkspace = folder => existsSync(path.join(folder, 'desk.sqlite')) || existsSync(path.join(folder, 'accounts.json'));

// The AI memory folder: an override from the environment, else the folder it was moved to, else ~/.rexdesk.
export function memoryFolder(env = process.env, home = os.homedir()) {
  if (env.REX_DESK_MEMORY) return path.resolve(env.REX_DESK_MEMORY);
  const moved = readLine(path.join(pointerHome(home), 'memory-folder.txt'));
  return path.resolve(moved && existsSync(moved) ? moved : pointerHome(home));
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

// Copies everything, then checks the copy has every file before the caller switches over.
function copyAll(from, to, skip = () => false) {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, force: false, errorOnExist: false, filter: source => !skip(source) });
  const count = folder => readdirSync(folder, { recursive: true }).length;
  if (count(to) < count(from) - readdirSync(from, { recursive: true }).filter(name => skip(path.join(from, String(name)))).length) throw new Error('The copy is missing files, so nothing was moved.');
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
export async function followDataMove(dataRoot, { home = os.homedir(), waitForOld = async () => {}, log = () => {} } = {}) {
  const moved = readLine(path.join(dataRoot, MOVED));
  if (moved && holdsWorkspace(moved)) return moved;
  const pendingFile = path.join(dataRoot, PENDING);
  if (!existsSync(pendingFile)) return dataRoot;
  let plan; try { plan = JSON.parse(readFileSync(pendingFile, 'utf8')); } catch { rmSync(pendingFile, { force: true }); return dataRoot; }
  try {
    await waitForOld();
    const target = checkTarget(dataRoot, plan.to);
    copyAll(dataRoot, target, source => [PENDING, 'runtime.lock'].includes(path.basename(source)) && path.dirname(source) === dataRoot);
    writeFileSync(path.join(dataRoot, MOVED), target);
    // The desktop app reads this pointer to find the workspace on its next launch.
    mkdirSync(pointerHome(home), { recursive: true }); writeFileSync(path.join(pointerHome(home), 'data-folder.txt'), target);
    rmSync(pendingFile, { force: true });
    log(`Moved Rex Desk data from ${dataRoot} to ${target}. The old folder is kept as a backup.`);
    return target;
  } catch (error) {
    writeFileSync(pendingFile.replace(/\.json$/, '.failed.json'), JSON.stringify({ ...plan, error: error.message }));
    rmSync(pendingFile, { force: true });
    log(`Could not move Rex Desk data: ${error.message}`);
    return dataRoot;
  }
}

// Ask for the AI memory to move on the next start.
export function planMemoryMove(to, { env = process.env, home = os.homedir() } = {}) {
  if (env.REX_DESK_MEMORY) throw new Error('The memory folder is set by REX_DESK_MEMORY on this computer, so it cannot be moved here.');
  const from = memoryFolder(env, home), target = checkTarget(from, settle(to, 'Rex Desk memory'));
  mkdirSync(pointerHome(home), { recursive: true });
  writeFileSync(path.join(pointerHome(home), 'memory-move.json'), JSON.stringify({ from, to: target, at: new Date().toISOString() }));
  return target;
}

// Called on every start, before the memory opens.
export function followMemoryMove({ env = process.env, home = os.homedir(), log = () => {} } = {}) {
  const file = path.join(pointerHome(home), 'memory-move.json');
  if (env.REX_DESK_MEMORY || !existsSync(file)) return memoryFolder(env, home);
  try {
    const plan = JSON.parse(readFileSync(file, 'utf8')), target = checkTarget(plan.from, plan.to);
    // Moving out of ~/.rexdesk leaves the small pointer files behind; they are not memory.
    const pointers = new Set(['memory-move.json', 'memory-folder.txt', 'data-folder.txt']);
    copyAll(plan.from, target, source => pointers.has(path.basename(source)) && path.dirname(source) === plan.from);
    writeFileSync(path.join(pointerHome(home), 'memory-folder.txt'), target);
    log(`Moved the AI memory from ${plan.from} to ${target}. The old folder is kept as a backup.`);
  } catch (error) { log(`Could not move the AI memory: ${error.message}`); }
  rmSync(file, { force: true });
  return memoryFolder(env, home);
}

// The files folder moves at once: copy each part, switch the setting, then remove the old copies.
export function moveMedia(store, to) {
  to = settle(to, 'Rex Desk');
  const from = store.config().mediaDirectory || store.directory, target = path.resolve(String(to || ''));
  if (!to || !path.isAbsolute(String(to))) throw new Error('Pick a full folder path.');
  if (target.toLowerCase() === path.resolve(from).toLowerCase()) throw new Error('That is already where it is.');
  if (inside(target, store.directory) && target.toLowerCase() !== store.directory.toLowerCase()) throw new Error('Pick a folder outside Rex Desk\'s data folder.');
  for (const folder of MEDIA_FOLDERS) if (existsSync(path.join(target, folder)) && readdirSync(path.join(target, folder)).length) throw new Error(`That folder already has a ${folder} folder with files in it. Pick another one.`);
  mkdirSync(target, { recursive: true });
  for (const folder of MEDIA_FOLDERS) if (existsSync(path.join(from, folder))) copyAll(path.join(from, folder), path.join(target, folder));
  store.saveConfig({ ...store.publicConfig(), mediaDirectory: target === store.directory ? '' : target });
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
  return { data: dataRoot, dataPending: pending, dataFailed: failed, memory, memoryPending, files: store.config().mediaDirectory || store.directory,
    filesInData: !store.config().mediaDirectory };
}

import path from 'node:path';
import { readdir, stat, statfs } from 'node:fs/promises';

// What Settings › About shows: which Rex Desk this is, how much it holds (agents, chats, tasks, files) and how much room
// it takes on this computer. Sizes are counted by walking the folders, which takes a moment on a big workspace, so the
// answer is kept for a minute.
const KEEP_MS = 60000;
let cached = null;

async function folderSize(root, limit = 200000) {
  let bytes = 0, files = 0;
  const walk = async folder => {
    if (files >= limit) return;
    let entries = []; try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async entry => {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.isFile()) return;
      try { const size = (await stat(full)).size; bytes += size; files++; } catch { /* gone meanwhile */ }
    }));
  };
  await walk(root);
  return { bytes, files };
}

export async function aboutRexDesk({ store, rooms = [], update = {}, install = '', fresh = false, now = Date.now() }) {
  if (!fresh && cached && cached.directory === store.directory && now - cached.at < KEEP_MS) return cached.value;
  const runs = store.list('run'), media = store.config().mediaDirectory || '';
  const data = await folderSize(store.directory), files = media && path.resolve(media) !== path.resolve(store.directory) ? await folderSize(media) : null;
  const artifacts = store.list('artifact').length;
  let disk = null;
  try { const info = await statfs(store.directory); disk = { free: info.bavail * info.bsize, total: info.blocks * info.bsize }; } catch { /* not available here */ }
  const value = {
    version: update.current || '', channel: update.stage || '', supported: Boolean(update.supported), latest: update.available?.version || '', ready: Boolean(update.ready),
    counts: {
      agents: store.list('specialist').filter(agent => agent.kind !== 'main').length,
      chats: new Set(runs.map(run => run.specialistId || run.roomId || run.id)).size,
      conversations: runs.length,
      rooms: rooms.length,
      tasks: store.list('task').length,
      files: artifacts,
    },
    storage: { data: data.bytes, dataFiles: data.files, files: files?.bytes ?? null, fileCount: files?.files ?? null, disk },
    places: { data: store.directory, files: media || store.directory, install },
  };
  cached = { at: now, directory: store.directory, value };
  return value;
}

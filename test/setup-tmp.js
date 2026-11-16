// Every test file gets its own temporary folder, removed when the file's run ends, so a full test run leaves nothing behind
// (it used to leave tens of thousands of folders in the temp directory and could fill the drive).
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Folders left by an earlier run (a file was still in use when it ended) are removed once they are old enough not to belong to a run in progress.
for (const name of readdirSync(os.tmpdir())) {
  if (!/^rex-desk-run-/.test(name)) continue;
  const full = path.join(os.tmpdir(), name);
  try { if (Date.now() - statSync(full).mtimeMs > 15 * 60000) rmSync(full, { recursive: true, force: true }); } catch { /* in use */ }
}

// An agent that runs the tests inside Rex Desk is handed the live app's settings (REX_DESK_VERSION, REX_DATA_DIR and the rest).
// With them every test desk took itself for the installed app and copied the whole checkout, worktrees and all, into its
// temporary folder: one run filled the drive and stopped the person's working agents. Tests set what they need themselves.
for (const name of Object.keys(process.env)) if (/^REX_/i.test(name)) delete process.env[name];

const mine = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-run-'));
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = mine;
process.on('exit', () => { try { rmSync(mine, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* a file still in use: the next run's cleanup takes it */ } });

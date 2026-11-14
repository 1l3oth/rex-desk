// Loaded by every test file (npm test uses --import): removes the temp folders a test made when its process ends.
// Tests make folders with mkdtemp("rex-..."); nothing removed them, so each run left hundreds behind and a few hundred
// runs filled drive C (ENOSPC). Only folders made by this process, directly in the temp folder, with a "rex-" prefix.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const made = new Set(), temp = path.resolve(os.tmpdir());
const track = folder => { if (typeof folder === 'string' && path.dirname(path.resolve(folder)) === temp && path.basename(folder).startsWith('rex-')) made.add(folder); return folder; };
const sync = fs.mkdtempSync, promised = fs.promises.mkdtemp;
fs.mkdtempSync = (...args) => track(sync.apply(fs, args));
fs.promises.mkdtemp = async (...args) => track(await promised.apply(fs.promises, args));
syncBuiltinESMExports(); // so `import { mkdtempSync } from 'node:fs'` in a test file gets the tracking version too
process.on('exit', () => {
  const stuck = [];
  for (const folder of made) {
    // A database or server of the test can still hold a file as the process ends (Windows refuses to delete it then).
    try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { stuck.push(folder); }
  }
  // Those are removed a moment later by a tiny helper that outlives this process, once its files are let go.
  if (stuck.length) {
    const script = 'const fs=require("node:fs");setTimeout(()=>{for(const f of JSON.parse(process.argv[1]))try{fs.rmSync(f,{recursive:true,force:true,maxRetries:10,retryDelay:300})}catch{}},1500)';
    try { spawn(process.execPath, ['-e', script, JSON.stringify(stuck)], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* left for the next sweep */ }
  }
});

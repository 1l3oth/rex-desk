// Freeze log. Rex Desk's server does everything on one thread: when one step blocks it (a large read on a slow disk, a
// big copy), the window turns black and no agent can reply, and nothing said why. A small watcher on its own thread sees
// the server's heartbeat stop and writes to the log what the server was doing, how long it was stuck, and when it came back.
// Code marks what it is about to do with doing('…'); the newest mark is what the log names.
import { Worker } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';

const shared = new SharedArrayBuffer(16 + 512);
const beat = new Float64Array(shared, 0, 1), began = new Float64Array(shared, 8, 1), label = new Uint8Array(shared, 16, 512);
let watcher = null, ticker = null, slowLog = '';
const SLOW_STEP_MS = 500;

// What the server is doing now, in a few words. Cheap: called on every request. When it began goes with it, so the log
// says how long that step had been running.
export function doing(text) {
  const bytes = Buffer.from(String(text || '').slice(0, 200));
  label.fill(0); label.set(bytes.subarray(0, 511)); began[0] = Date.now();
}

// One blocking step (a database call), named while it runs and cleared after it, so a freeze later on is never blamed on a
// step that already ended. One that takes over half a second is written to the log with its name and time.
export function step(name, run) {
  doing(name); const start = performance.now();
  try { return run(); } finally {
    const ms = Math.round(performance.now() - start); doing('');
    if (ms > SLOW_STEP_MS && slowLog) { try { appendFileSync(slowLog, `${new Date().toISOString()} Slow step: ${name} took ${ms} ms\n`); } catch { /* the log is best effort */ } }
  }
}
// An awaited step (a network read): while it waits the server is free, so a freeze then is some other unmarked work, said so.
export async function waitStep(name, run) {
  doing(`${name} (waiting; the server is free, so a freeze now is unmarked work)`);
  try { return await run(); } finally { doing(''); }
}

// Starts the watcher. logFile: where freezes are written. threshold: how long without a heartbeat counts as a freeze.
export function watchStalls({ logFile, threshold = 3000, every = 250 } = {}) {
  if (watcher || !logFile) return;
  beat[0] = Date.now(); slowLog = logFile;
  ticker = setInterval(() => { beat[0] = Date.now(); }, every); ticker.unref();
  watcher = new Worker(`
    const { workerData: { shared, logFile, threshold } } = require('node:worker_threads');
    const { appendFileSync } = require('node:fs');
    const beat = new Float64Array(shared, 0, 1), began = new Float64Array(shared, 8, 1), label = new Uint8Array(shared, 16, 512);
    const what = () => Buffer.from(label).toString('utf8').replace(/\\0+$/, '') || 'nothing marked';
    const write = line => { try { appendFileSync(logFile, \`\${new Date().toISOString()} \${line}\\n\`); } catch {} };
    // The step named, and how long it has run so far (it started before the freeze was noticed).
    const named = () => \`\${cause} (step running \${Math.max(0, Math.round(Date.now() - stepAt))} ms)\`;
    let since = 0, cause = '', told = 0, stepAt = 0;
    setInterval(() => {
      const late = Date.now() - beat[0];
      if (late > threshold) {
        if (!since) { since = beat[0]; cause = what(); stepAt = began[0] || since; told = 0; }
        // Said while still stuck too (at 10 s, 30 s, 60 s, then every minute): a server restarted while stuck never says it came back.
        const seconds = Math.round(late / 1000), marks = [10, 30, 60];
        if (seconds >= (marks[told] ?? (60 * (told - 1)))) { write(\`Rex Desk server stuck for \${seconds}s while: \${named()}\`); told++; }
      } else if (since) {
        write(\`Rex Desk server was stuck for \${((Date.now() - since) / 1000).toFixed(1)}s while: \${named()}\`); since = 0;
      }
    }, 500);
  `, { eval: true, workerData: { shared, logFile, threshold } });
  watcher.unref();
  watcher.on('error', () => { watcher = null; });
}

export function stopStallWatch() { clearInterval(ticker); ticker = null; void watcher?.terminate(); watcher = null; }

#!/usr/bin/env node
// jev: tell Jev what this computer should do, from any terminal, script, or keyboard shortcut, without the Rex Desk window.
//   jev turn the volume down          jev --yes shut down        jev --json battery
// It starts the Rex Desk server if needed and uses the account that chose "Stay signed in" on this computer.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const address = process.env.REX_DESK_URL || 'http://127.0.0.1:4317';
const args = process.argv.slice(2), flags = new Set(args.filter(arg => arg.startsWith('--'))), text = args.filter(arg => !arg.startsWith('--')).join(' ').trim();

async function reach(fetcher = fetch) {
  try { const response = await fetcher(`${address}/api/auth`, { signal: AbortSignal.timeout(2000) }); return response; } catch { return null; }
}
async function startServer() {
  const local = path.join(root, '.local'); mkdirSync(local, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root, detached: true, windowsHide: true,
    stdio: ['ignore', openSync(path.join(local, 'server.log'), 'a'), openSync(path.join(local, 'server-error.log'), 'a')] });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) { await new Promise(resolve => setTimeout(resolve, 250)); const response = await reach(); if (response) return response; }
  throw new Error('Rex Desk did not start. Check .local/server-error.log.');
}
async function main() {
  if (!text || flags.has('--help')) {
    console.log('Usage: jev <what the computer should do>   (Khmer, English, or Korean)\n  --yes   allow actions that ask first (shut down, restart, quit an app)\n  --json  print the full answer as JSON');
    return 0;
  }
  const auth = await reach() || await startServer();
  const cookie = (auth.headers.get('set-cookie') || '').split(';')[0];
  const signedIn = await auth.json();
  if (signedIn.mode === 'accounts' && !signedIn.current) throw new Error('Sign in to Rex Desk once and tick “Stay signed in”. After that jev works without the window.');
  const call = async (endpoint, data) => {
    const response = await fetch(`${address}/api${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  };
  let answer = await call('/computer/do', { text });
  if (answer.needsConfirm?.length) {
    if (!flags.has('--yes')) { console.log(`Jev needs your yes for: ${answer.needsConfirm.join(', ')}. Run again with --yes.`); return 2; }
    answer = { ...answer, ...await call('/computer/run', { steps: answer.steps }) };
  }
  if (flags.has('--json')) { console.log(JSON.stringify(answer, null, 2)); return answer.done ? 0 : 1; }
  if (answer.say) console.log(answer.say);
  for (const step of answer.results || []) console.log(`${step.ok ? '✓' : '✗'} ${step.title}${step.ok ? (step.result ? `  ${JSON.stringify(step.result)}` : '') : `: ${step.error}`}`);
  if (!answer.steps?.length) return 1;
  return answer.done ? 0 : 1;
}
main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });

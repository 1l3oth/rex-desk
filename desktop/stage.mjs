// Copies this Node runtime and the Rex Desk server into the installer payload, so the desktop app needs nothing preinstalled.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url)), project = path.resolve(desktop, '..');
const payload = path.join(desktop, 'src-tauri', 'payload');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(`Stage with Node.js 24 or newer; this is ${process.version}.`);
if (!existsSync(path.join(project, 'node_modules', 'playwright'))) throw new Error('Run npm ci in the project folder first.');

rmSync(payload, { recursive: true, force: true });
mkdirSync(path.join(payload, 'node'), { recursive: true });
cpSync(process.execPath, path.join(payload, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
// Left out: the agent SDK's own copy of Claude Code (about 220 MB). Rex Desk runs the Claude Code installed on the
// computer, which signing in needs anyway, so the copy was never used and only made the installer 400 MB.
const skip = /[\\/]node_modules[\\/](@anthropic-ai[\\/]claude-agent-sdk-[^\\/]+|@types)([\\/]|$)/;
for (const entry of ['src', 'public', 'scripts', 'package.json', 'node_modules']) cpSync(path.join(project, entry), path.join(payload, 'app', entry), { recursive: true, dereference: true, filter: source => !skip.test(source) });
console.log(`Staged Node ${process.version} and Rex Desk into ${payload}`);

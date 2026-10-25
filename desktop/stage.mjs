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
cpSync(process.execPath, path.join(payload, 'node', 'node.exe'));
for (const entry of ['src', 'public', 'scripts', 'package.json', 'node_modules']) cpSync(path.join(project, entry), path.join(payload, 'app', entry), { recursive: true, dereference: true });
console.log(`Staged Node ${process.version} and Rex Desk into ${payload}`);

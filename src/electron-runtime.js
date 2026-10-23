import path from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const bootstrap = fileURLToPath(new URL('../scripts/electron-isolation.cjs', import.meta.url));
const relative = (value, fallback, name) => {
  const result = String(value || fallback).trim().replaceAll('\\', '/');
  if (path.isAbsolute(result) || /^[A-Za-z]:/.test(result) || result.split('/').includes('..')) throw new Error(`Electron ${name} must be a path inside the repository.`);
  return result;
};
export function validateElectronRuntime(value) {
  if (!value) return undefined;
  const args = String(value.args ?? '--enable-logging').trim();
  if (args.length > 300 || /[;&|<>`$]/.test(args)) throw new Error('Electron arguments must be plain switches, without shell characters.');
  return { appDir: relative(value.appDir, 'app', 'app folder'), electronPath: relative(value.electronPath, process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron', 'executable'), args };
}
export function detectElectron(root) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const version = manifest.devDependencies?.electron || manifest.dependencies?.electron;
    if (!version) return null;
    const main = String(manifest.main || '').replace(/^\.\//, '');
    const appDir = main.includes('/') ? main.split('/')[0] : existsSync(path.join(root, 'app', 'package.json')) ? 'app' : '.';
    return { version, ...validateElectronRuntime({ appDir }), nestedInstall: existsSync(path.join(root, appDir, 'package.json')) && appDir !== '.' };
  } catch { return null; }
}
// Playwright drives the run's own Electron build; the bootstrap isolates profile data before the app's main script runs.
export function electronLaunch(repository, run, dataDirectory, recordDirectory) {
  const electron = repository.electronRuntime, home = path.join(dataDirectory, 'runtimes', run.id, 'electron');
  const executablePath = path.resolve(run.worktree, electron.electronPath), appDirectory = path.resolve(run.worktree, electron.appDir);
  if (!executablePath.startsWith(path.resolve(run.worktree) + path.sep) || !existsSync(executablePath)) throw new Error(`Electron is not installed in this worktree (${electron.electronPath}). Add a worktree setup command such as npm ci.`);
  if (!existsSync(path.join(appDirectory, 'package.json'))) throw new Error(`Electron app folder ${electron.appDir} has no package.json in this worktree.`);
  mkdirSync(home, { recursive: true });
  // Playwright adds its loader only for its own Electron; a worktree executable needs it passed explicitly.
  const loader = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'lib/server/electron/loader.js');
  const env = { ...process.env, REX_ELECTRON_HOME: home, REX_RUN_ID: run.id, PORT: String(run.port), ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return { home, options: { executablePath, cwd: run.worktree, env, timeout: 120000,
    args: ['-r', bootstrap, '-r', loader, appDirectory, ...electron.args.split(/\s+/).filter(Boolean)],
    recordVideo: { dir: recordDirectory, size: { width: 1440, height: 900 } } } };
}

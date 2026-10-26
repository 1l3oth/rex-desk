// Worktree setup for Java WAR repositories with a gulp frontend (such as flow-was): pages load bundles from a gitignored dist/
// folder, so a fresh worktree must build them before its preview works. The build also rewrites some tracked CSS and SVG files;
// those are restored afterwards so the worktree starts with no changes of its own.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd(), frontend = path.join(root, 'src', 'flow-renewal'), windows = process.platform === 'win32';
if (!existsSync(path.join(frontend, 'package.json'))) { console.log('No src/flow-renewal frontend; nothing to build.'); process.exit(0); }
const changed = () => new Set(execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).map(entry => entry.slice(3)));
const npm = (args, label) => {
  console.log(`> npm ${args.join(' ')}`);
  const result = spawnSync(windows ? 'npm.cmd' : 'npm', args, { cwd: frontend, stdio: 'inherit', shell: windows });
  if (result.status !== 0) { console.log(`${label} failed (exit ${result.status}).`); process.exit(result.status || 1); }
};
const before = changed();
npm([existsSync(path.join(frontend, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'], 'Installing frontend packages');
npm(['run', 'build'], 'The frontend build');
const touched = [...changed()].filter(file => !before.has(file));
if (touched.length) { execFileSync('git', ['checkout', '--', ...touched], { cwd: root }); console.log(`Restored ${touched.length} tracked files the build rewrote.`); }
console.log('Frontend bundles built for this worktree’s preview.');

import path from 'node:path';
import { existsSync, readdirSync, mkdirSync, copyFileSync, constants } from 'node:fs';
import { shellCommand } from './processes.js';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../scripts/start-flow-tomcat.ps1', import.meta.url));
export function validateFlowRuntime(value) {
  if (!value) return undefined;
  if (process.platform !== 'win32') throw new Error('The Flow Tomcat preset currently requires Windows. Use a custom dev command elsewhere.');
  const result = {};
  for (const key of ['templateBase', 'javaHome', 'catalinaHome', 'seedPath']) {
    if (!path.isAbsolute(value[key] || '')) throw new Error(`Flow Tomcat ${key} must be an absolute folder.`);
    result[key] = path.resolve(value[key]);
  }
  result.maxHeapMb = Number(value.maxHeapMb || 512);
  if (!Number.isInteger(result.maxHeapMb) || result.maxHeapMb < 256 || result.maxHeapMb > 4096) throw new Error('Tomcat heap must be 256–4096 MB per worker.');
  return result;
}
export function seedFlowWorktree(repository, worktree) {
  const flow = repository.flowRuntime;
  if (!flow) return [];
  const copied = [];
  // Copy only local JEX settings. Never share mutable files, build output, or node_modules between branches.
  for (const relative of ['src/WEB-INF/jex/config', 'src/WEB-INF/jex/license']) {
    const from = path.join(flow.seedPath, relative), to = path.join(worktree, relative);
    const visit = (source, destination) => {
      if (!existsSync(source)) return;
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('JEX configuration seed must contain real files, not links.');
        const sourceFile = path.join(source, entry.name), targetFile = path.join(destination, entry.name);
        if (entry.isDirectory()) visit(sourceFile, targetFile);
        else if (entry.isFile() && !existsSync(targetFile)) {
          mkdirSync(path.dirname(targetFile), { recursive: true });
          copyFileSync(sourceFile, targetFile, constants.COPYFILE_EXCL);
          copied.push(path.relative(worktree, targetFile));
        }
      }
    };
    visit(from, to);
  }
  return copied;
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export function flowPreview(repository, run, dataDirectory, onData) {
  const flow = repository.flowRuntime;
  const runtime = path.join(dataDirectory, 'runtimes', run.id);
  const command = `& ${quote(launcher)} -Worktree ${quote(run.worktree)} -Runtime ${quote(runtime)} -Port ${run.port} -TemplateBase ${quote(flow.templateBase)} -JavaHome ${quote(flow.javaHome)} -CatalinaHome ${quote(flow.catalinaHome)} -MaxHeapMb ${flow.maxHeapMb}`;
  return shellCommand(command, { cwd: run.worktree, timeout: 0, env: { PORT: String(run.port), REX_RUN_ID: run.id }, onData });
}

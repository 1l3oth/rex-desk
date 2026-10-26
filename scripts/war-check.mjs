// Verification for Java WAR repositories without a runnable test suite (such as flow-was): compile every Java file the branch
// changed with JDK 8 against the checked-in classes and libraries, confirm Java 8 bytecode, and syntax-check changed JavaScript.
// Output goes to a temporary folder, so the worktree is unchanged. Run from the worktree root; REX_BASE_COMMIT names the base.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd(), windows = process.platform === 'win32';
const base = process.env.REX_BASE_COMMIT || execFileSync('git', ['merge-base', 'HEAD', 'origin/HEAD'], { encoding: 'utf8' }).trim();
const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD'], { encoding: 'utf8' }).split('\n').map(line => line.trim()).filter(Boolean);
const java = changed.filter(file => file.startsWith('src/WEB-INF/src/') && file.endsWith('.java'));
const scripts = changed.filter(file => /^src\/.*\.m?js$/.test(file) && !/(\.min\.js|\/dist\/|\/node_modules\/)/.test(file));
let failed = false;
console.log(`Base ${base.slice(0, 10)} · ${changed.length} changed files · ${java.length} Java · ${scripts.length} JavaScript`);

if (java.length) {
  const home = process.env.JAVA_HOME, javac = home ? path.join(home, 'bin', windows ? 'javac.exe' : 'javac') : 'javac';
  const output = mkdtempSync(path.join(os.tmpdir(), 'rex-war-check-'));
  const classpath = ['src/WEB-INF/classes', 'src/WEB-INF/lib/*'].join(windows ? ';' : ':');
  const result = spawnSync(javac, ['-nowarn', '-g', '-source', '1.8', '-target', '1.8', '-encoding', 'UTF-8', '-proc:none', '-cp', classpath, '-d', output, ...java], { cwd: root, encoding: 'utf8' });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error || result.status !== 0) { failed = true; console.log(`Java compile failed (${result.error?.message || `exit ${result.status}`}).`); }
  else {
    // Java 8 servers load only class files with major version 52.
    const classes = []; const walk = directory => { for (const name of readdirSync(directory)) { const file = path.join(directory, name); if (statSync(file).isDirectory()) walk(file); else if (name.endsWith('.class')) classes.push(file); } };
    walk(output);
    const wrong = classes.filter(file => { const bytes = readFileSync(file); return bytes.readUInt16BE(6) !== 52; });
    if (wrong.length) { failed = true; console.log(`Not Java 8 bytecode: ${wrong.map(file => path.relative(output, file)).join(', ')}`); }
    else console.log(`Java: ${java.length} changed files compile with JDK 8 into ${classes.length} Java 8 classes.`);
  }
  rmSync(output, { recursive: true, force: true });
}
for (const file of scripts) {
  if (!existsSync(path.join(root, file))) continue;
  const source = readFileSync(path.join(root, file), 'utf8'), module = /^\s*(import|export)\s/m.test(source);
  const result = spawnSync(process.execPath, module ? ['--input-type=module', '--check'] : ['--check', file], { cwd: root, input: module ? source : undefined, encoding: 'utf8' });
  if (result.status !== 0) { failed = true; console.log(`JavaScript syntax error in ${file}:\n${(result.stderr || '').trim().split('\n').slice(0, 6).join('\n')}`); }
}
if (scripts.length && !failed) console.log(`JavaScript: ${scripts.length} changed files parse.`);
if (!java.length && !scripts.length) console.log('No changed Java or JavaScript to compile; the browser assertion is the proof for this change.');
process.exit(failed ? 1 : 0);

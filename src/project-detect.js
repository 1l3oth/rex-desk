import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { defaultProfiles, seedProduct } from './flow-runtime.js';
import { detectElectron } from './electron-runtime.js';

const rexScript = name => path.resolve(import.meta.dirname, '..', 'scripts', name);

const windows = process.platform === 'win32';
const has = (...parts) => existsSync(path.join(...parts));
const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
const children = parent => { try { return readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(parent, entry.name)); } catch { return []; } };
const programFolders = () => [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']].filter(Boolean);

// A JDK 8 with javac, from JAVA_HOME or the usual vendor folders. Newer JDKs build classes Java 8 servers cannot load.
export function findJava8() {
  const javac = directory => existsSync(path.join(directory, 'bin', windows ? 'javac.exe' : 'javac'));
  const eight = directory => /(^|[^0-9])(1\.8|8)([^0-9]|$)/.test(path.basename(directory));
  const vendors = ['Amazon Corretto', 'Eclipse Adoptium', 'Zulu', 'AdoptOpenJDK', 'Microsoft', 'Java'];
  const candidates = [process.env.JAVA_HOME, ...programFolders().flatMap(folder => vendors.flatMap(vendor => children(path.join(folder, vendor)).sort().reverse()))].filter(Boolean);
  return candidates.find(directory => eight(directory) && javac(directory)) || '';
}
export function findTomcat() {
  const catalina = directory => existsSync(path.join(directory, 'bin', windows ? 'catalina.bat' : 'catalina.sh'));
  const candidates = [process.env.CATALINA_HOME, ...programFolders().flatMap(folder => children(path.join(folder, 'Apache Software Foundation')).filter(directory => /tomcat/i.test(path.basename(directory))).sort().reverse())].filter(Boolean);
  return candidates.find(catalina) || '';
}
// Run one of Rex Desk's own scripts in the worktree, with JDK 8 when the project needs it.
const rexNode = (name, javaHome) => windows
  ? `${javaHome ? `$env:JAVA_HOME=${powershell(javaHome)}; ` : ''}node ${powershell(rexScript(name))}`
  : `${javaHome ? `JAVA_HOME=${quote(javaHome)} ` : ''}node ${quote(rexScript(name))}`;
const powershell = value => `'${String(value).replaceAll("'", "''")}'`;
// POSIX only. On Windows, repository .sh scripts assume Unix paths and tools (flow-was's javac argfile breaks in Git Bash),
// so the worker proposes a command there and the human approves it once.
const shellScript = (script, javaHome) => `${javaHome ? `JAVA_HOME=${quote(javaHome)} PATH=${quote(path.join(javaHome, 'bin'))}:"$PATH" ` : ''}bash ${quote(script)}`;

// What a repository needs, read from its own files: how to install, test, and preview it. Settings only override these.
// The dashboard asks on every refresh, so each answer is reused for 30 seconds.
const recent = new Map();
export function detectProject(root) {
  const hit = recent.get(root);
  if (hit && Date.now() - hit.at < 30000) return hit.found;
  const found = scan(root);
  recent.set(root, { at: Date.now(), found });
  return found;
}
function scan(root) {
  const found ={ setupCommand: '', testCommand: '', devCommand: '', from: {}, flowRuntime: null, electronRuntime: null };
  if (!root || !existsSync(root)) return found;
  const set = (key, command, from) => { if (command && !found[key]) { found[key] = command; found.from[key] = from; } };
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  if (manifest) {
    const scripts = manifest.scripts || {}, tool = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : 'npm';
    set('setupCommand', { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', npm: has(root, 'package-lock.json') ? 'npm ci' : 'npm install' }[tool], 'package.json');
    if (scripts.test && !/no test specified/.test(scripts.test)) set('testCommand', `${tool} test`, 'package.json "test" script');
    if (scripts.dev) set('devCommand', `${tool} run dev -- --port {port}`, 'package.json "dev" script');
    else if (scripts.start) set('devCommand', `${tool} run start -- --port {port}`, 'package.json "start" script');
  }
  // Flow / Morningmate: a Java 8 WAR layout previewed in an isolated Tomcat built from the sibling template.
  const javaHome = has(root, 'src', 'WEB-INF') ? findJava8() : '';
  if (has(root, 'src', 'WEB-INF')) {
    const templateBase = path.join(path.dirname(root), 'flow-was-tomcat'), catalinaHome = findTomcat();
    if (windows && javaHome && catalinaHome && has(templateBase, 'conf', 'server.xml')) {
      const seed = seedProduct(root);
      found.flowRuntime = { templateBase, javaHome, catalinaHome, seedPath: root, maxHeapMb: 512, profiles: defaultProfiles(), defaultProfile: seed?.product || 'flow', seed };
      found.from.flowRuntime = `src/WEB-INF and ${templateBase}`;
    }
    // flow-was has no runnable test suite; its developers compile the changed classes with JDK 8, so verification does the same.
    if (javaHome) set('testCommand', rexNode('war-check.mjs', javaHome), 'a Java 8 compile of the changed classes and a syntax check of changed scripts (no test suite in the repository)');
    // Pages load gitignored dist/ bundles, so a new worktree builds the gulp frontend before its preview can work.
    if (has(root, 'src', 'flow-renewal', 'package.json')) set('setupCommand', rexNode('war-setup.mjs'), 'src/flow-renewal (installs and builds the frontend bundles the pages load)');
  }
  const script = ['run-tests.sh', 'test.sh', path.join('scripts', 'test.sh')].find(name => has(root, name));
  if (script && !windows) set('testCommand', shellScript(script, javaHome), script);
  if (has(root, 'pom.xml')) set('testCommand', has(root, windows ? 'mvnw.cmd' : 'mvnw') ? `${windows ? '.\\mvnw.cmd' : './mvnw'} -q test` : 'mvn -q test', 'pom.xml');
  if (has(root, 'build.gradle') || has(root, 'build.gradle.kts')) set('testCommand', has(root, windows ? 'gradlew.bat' : 'gradlew') ? `${windows ? '.\\gradlew.bat' : './gradlew'} test` : 'gradle test', 'build.gradle');
  if (has(root, 'go.mod')) set('testCommand', 'go test ./...', 'go.mod');
  if (has(root, 'Cargo.toml')) set('testCommand', 'cargo test', 'Cargo.toml');
  if (has(root, 'pyproject.toml') || has(root, 'pytest.ini') || has(root, 'setup.cfg')) set('testCommand', 'python -m pytest', has(root, 'pyproject.toml') ? 'pyproject.toml' : 'pytest configuration');
  if (readdirSync(root).some(name => /\.(sln|csproj)$/i.test(name))) set('testCommand', 'dotnet test', 'solution file');
  const electron = !found.flowRuntime && detectElectron(root);
  if (electron) {
    found.electronRuntime = { appDir: electron.appDir, electronPath: electron.electronPath, args: electron.args };
    found.from.electronRuntime = `electron ${electron.version} in package.json`;
    if (electron.nestedInstall) { found.setupCommand = `npm ci; npm ci --prefix ${electron.appDir}`; found.from.setupCommand = 'package.json and the app folder'; }
  }
  return found;
}

// Empty settings mean automatic: a run uses what the repository's files say, and anything typed in Settings wins.
// A custom dev command replaces the detected Tomcat or Electron preview.
export function effectiveRepository(repository) {
  if (!repository) return repository;
  const found = detectProject(repository.path), custom = Boolean(repository.devCommand);
  const flowRuntime = repository.flowRuntime || (!custom && !repository.electronRuntime && found.flowRuntime) || undefined;
  const electronRuntime = repository.electronRuntime || (!custom && !flowRuntime && found.electronRuntime) || undefined;
  return { ...repository, flowRuntime, electronRuntime, detected: found,
    setupCommand: repository.setupCommand || found.setupCommand,
    testCommand: repository.testCommand || found.testCommand,
    devCommand: repository.devCommand || (flowRuntime || electronRuntime ? '' : found.devCommand) };
}

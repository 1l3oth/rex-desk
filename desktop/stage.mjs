// Copies this Node runtime and the Rex Desk server into the installer payload, so the desktop app needs nothing preinstalled.
import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url)), project = path.resolve(desktop, '..');
const payload = path.join(desktop, 'src-tauri', 'payload'), app = path.join(payload, 'app'), modules = path.join(app, 'node_modules');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(`Stage with Node.js 24 or newer; this is ${process.version}.`);
if (!existsSync(path.join(project, 'node_modules', 'playwright'))) throw new Error('Run npm ci in the project folder first.');

rmSync(payload, { recursive: true, force: true });
mkdirSync(path.join(payload, 'node'), { recursive: true });
cpSync(process.execPath, path.join(payload, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
for (const entry of ['src', 'public', 'scripts', 'package.json']) cpSync(path.join(project, entry), path.join(app, entry), { recursive: true, dereference: true });

// Left out: the agent SDK's own copy of Claude Code (about 220 MB). Rex Desk runs the Claude Code installed on the
// computer, which signing in needs anyway, so the copy was never used and only made the installer 400 MB.
const skip = /[\\/]node_modules[\\/](@anthropic-ai[\\/]claude-agent-sdk-[^\\/]+|@types)([\\/]|$)/;
// Also left out: files nothing runs (type definitions, source maps, package docs).
const unused = /[\\/]node_modules[\\/](.+\.(d\.[cm]?ts|map)|(.+[\\/])?(readme|changelog|changes|history|contributing|code_of_conduct|security|sponsors|upgrading|migration)[^\\/]*\.md|.+[\\/]\.github([\\/].*)?)$/i;
const copy = (from, to = from) => cpSync(path.join(project, 'node_modules', from), path.join(modules, to), { recursive: true, dereference: true, filter: source => !skip.test(source) && !unused.test(source) });

if (process.env.REX_STAGE_FULL === '1') {
  // The old way, every package file as installed: about 5,400 files. Kept as a fallback if a bundled package misbehaves.
  copy('.');
} else {
  // Every file costs the installer and the virus scanner time on its own (copying 5,400 small files took 85 seconds, the
  // 56 MB node.exe 5), so the packages the server imports are bundled into a few files instead. Each keeps its own name
  // under node_modules with the same exports, so `import ... from 'zod'` in src/ resolves exactly as before.
  // These stay as installed, unbundled: they find their own files on disk at run time or start other programs.
  for (const name of ['playwright', 'playwright-core', '@anthropic-ai/claude-agent-sdk']) copy(name);
  // Served to the browser as files (see vendorFiles in src/server.js), so only those files are kept.
  copy('three/build'); copy('three/package.json');
  copy('driver.js/dist'); copy('driver.js/package.json');
  for (const part of ['lib', 'mode', 'addon', 'package.json']) copy(`codemirror/${part}`);
  await bundle();
}
console.log(`Staged Node ${process.version} and Rex Desk into ${payload} (${count(app)} files)`);

async function bundle() {
  const { build } = await import('esbuild');
  // Every package specifier src/ imports. A new import that is missing here fails the check below, never at run time.
  const specifiers = ['@libsql/client/web', '@modelcontextprotocol/sdk/client/index.js', '@modelcontextprotocol/sdk/client/streamableHttp.js', '@modelcontextprotocol/sdk/client/stdio.js', '@modelcontextprotocol/sdk/client/sse.js',
    '@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/server/stdio.js',
    '@modelcontextprotocol/sdk/server/streamableHttp.js', '@modelcontextprotocol/sdk/types.js', 'mammoth', 'msedge-tts', 'prettier', 'qrcode', 'xlsx', 'zod', 'zod-to-json-schema'];
  const kept = /^(playwright|playwright-core|@anthropic-ai\/claude-agent-sdk|node:.*)$/;
  const imported = new Set();
  for (const file of walk(path.join(project, 'src'))) for (const match of readFile(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)'((?:@[a-z0-9-]+\/)?[a-z0-9][\w.-]*(?:\/[\w./-]+)?)'/g)) if (!kept.test(match[1])) imported.add(match[1]);
  const missing = [...imported].filter(name => !specifiers.includes(name));
  if (missing.length) throw new Error(`src/ imports packages the desktop bundle does not have: ${missing.join(', ')}. Add them to the specifiers in desktop/stage.mjs.`);

  // One small entry file per specifier that re-exports the same names the package gives Node (named exports of CommonJS
  // packages are listed by name, since a bundler cannot see them).
  const entries = path.join(desktop, '.stage-entries');
  rmSync(entries, { recursive: true, force: true }); mkdirSync(entries, { recursive: true });
  const entryPoints = {};
  for (const specifier of specifiers) {
    const names = Object.keys(await import(specifier)).filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
    const hasDefault = 'default' in await import(specifier);
    const file = path.join(entries, `${specifier.replace(/[\\/@.]/g, '_')}.mjs`);
    writeFileSync(file, `${names.length ? `export { ${names.join(', ')} } from '${specifier}';\n` : ''}${hasDefault ? `export { default } from '${specifier}';\n` : ''}`);
    entryPoints[target(specifier)] = file;
  }
  await build({
    entryPoints, outdir: modules, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24',
    chunkNames: '.rex-bundle/[name]-[hash]', outExtension: { '.js': '.mjs' }, logLevel: 'warning', legalComments: 'none', absWorkingDir: project,
    external: ['playwright', 'playwright-core', '@anthropic-ai/claude-agent-sdk'],
    // CommonJS packages (xlsx, mammoth, qrcode) call require() for Node's own modules; ESM output has no require of its own.
    banner: { js: "import { createRequire as __rexRequire } from 'node:module'; const require = __rexRequire(import.meta.url);" },
  });
  rmSync(entries, { recursive: true, force: true });

  // A package.json per package that maps each specifier to its bundled file, so Node resolves the same import names.
  const packages = {};
  for (const specifier of specifiers) {
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const sub = specifier.slice(name.length);
    (packages[name] ||= {})[sub ? `.${sub}` : '.'] = `./${path.relative(path.join(modules, name), path.join(modules, target(specifier))).replaceAll('\\', '/')}.mjs`;
  }
  for (const [name, exports] of Object.entries(packages)) writeFileSync(path.join(modules, name, 'package.json'), JSON.stringify({ name, private: true, type: 'module', exports }, null, 2));

  // The bundle must give every specifier the same exports as the installed package, or the stage fails here.
  for (const specifier of specifiers) {
    const installed = await import(specifier), bundled = await import(pathToFileURL(path.join(modules, `${target(specifier)}.mjs`)).href);
    for (const name of Object.keys(installed).filter(name => name !== 'module.exports')) if (typeof bundled[name] !== typeof installed[name]) throw new Error(`Bundled ${specifier} lost the export ${name}.`);
  }
}

// node_modules/<package>/<subpath without .js>: where the bundle of one specifier goes.
function target(specifier) { return specifier.replace(/\.js$/, '').replace(/^([^@][^/]*)$/, '$1/index').replace(/^(@[^/]+\/[^/]+)$/, '$1/index'); }
function walk(folder) { return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : entry.name.endsWith('.js') ? [path.join(folder, entry.name)] : []); }
function readFile(file) { return readFileSync(file, 'utf8'); }
function count(folder) { return readdirSync(folder, { withFileTypes: true, recursive: true }).filter(entry => entry.isFile()).length; }

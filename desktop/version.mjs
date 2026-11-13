// Sets the desktop app's version in the three files that carry it, so a build can be given its version when it starts.
// Usage: node desktop/version.mjs 0.3.0
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url)), version = process.argv[2] || '';
// Windows .msi installers accept only three plain numbers.
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error(`Version must look like 0.3.0, got "${version}".`); process.exit(1); }
const rewrite = (file, change) => { const target = path.join(desktop, file); writeFileSync(target, change(readFileSync(target, 'utf8'))); };
const json = text => text.replace(/^(  "version": ")[^"]+(")/m, `$1${version}$2`);
rewrite('src-tauri/tauri.conf.json', json);
rewrite('package.json', json);
rewrite('src-tauri/Cargo.toml', text => text.replace(/^(version = ")[^"]+(")/m, `$1${version}$2`));
console.log(`Desktop version set to ${version}`);

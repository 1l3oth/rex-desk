// Finds every text the page scripts pass to t() (see public/i18n.js) and compares it with a language file.
//   node scripts/i18n-keys.mjs [km]     lists what is missing from public/i18n/<code>.json and what is left over
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const squash = text => text.replace(/\s+/g, ' ').trim();

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

// Every text a page script gives to t(): { "Moves to {0} on restart.": ["chat-tour.js:31"], ... }
export function collectKeys(directory = path.join(root, 'public')) {
  const keys = new Map();
  const add = (key, file, line) => { key = squash(key); if (!key) return; if (!keys.has(key)) keys.set(key, []); keys.get(key).push(`${file}:${line}`); };
  for (const file of readdirSync(directory).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    if (!/\bt\b/.test(source)) continue;
    let ast;
    try { ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }); } catch { continue; }
    walk(ast, node => {
      if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && node.tag.name === 't') {
        add(node.quasi.quasis.map(part => part.value.cooked ?? part.value.raw).reduce((out, part, index) => out + (index ? `{${index - 1}}` : '') + part, ''), file, node.loc.start.line);
      } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 't' && node.arguments[0]) {
        const [first] = node.arguments;
        if (first.type === 'Literal' && typeof first.value === 'string') add(first.value, file, node.loc.start.line);
        else if (first.type === 'TemplateLiteral' && !first.expressions.length) add(first.quasis[0].value.cooked, file, node.loc.start.line);
      }
    });
  }
  return keys;
}

// A message the server sends is translated by the page with t(message), so it is in the catalog without a t() call in the page scripts.
let serverSource = null;
export function serverText(text) {
  serverSource ??= readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js')).map(name => readFileSync(path.join(root, 'src', name), 'utf8')).join(' ');
  const slash = String.fromCharCode(92), twice = slash + slash;
  const forms = [text, text.replaceAll(slash, twice), text.replaceAll('"', slash + '"'), text.replaceAll("'", slash + "'"), text.replaceAll(slash, twice).replaceAll("'", slash + "'")];
  return forms.some(form => serverSource.includes(form));
}

export function loadLanguage(code) {
  const file = path.join(root, 'public', 'i18n', `${code}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = process.argv[2] || 'km', keys = collectKeys(), catalog = loadLanguage(code);
  const missing = [...keys.keys()].filter(key => !(key in catalog)), stale = Object.keys(catalog).filter(key => !keys.has(key) && !serverText(key));
  console.log(`${keys.size} texts in the page scripts; ${keys.size - missing.length} have a ${code} translation; ${missing.length} missing; ${stale.length} left over.`);
  if (process.argv.includes('--missing')) for (const key of missing) console.log(JSON.stringify(key));
  if (process.argv.includes('--stale')) for (const key of stale) console.log(JSON.stringify(key));
}

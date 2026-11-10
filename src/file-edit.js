import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// An agent can open a file on this computer for the person to fill in inside Rex Desk: an .env file that needs an API key,
// a config value only the person knows. The person sees and edits the file; the agent never sees what was typed.
// It only learns that the file was saved and which keys now have a value. Nothing typed here is stored in Rex Desk's records.
const LIMIT = 1024 * 1024;
const BLOCKED = [/[\\/]\.git[\\/]/i, /[\\/]windows[\\/]system32[\\/]/i, /\.(exe|dll|sys|bat|cmd|ps1|lnk|msi)$/i];

export function checkEditable(file) {
  const location = path.resolve(String(file || ''));
  if (!path.isAbsolute(String(file || ''))) throw new Error('Give the full path of the file, for example D:\\dev\\app\\.env.');
  if (BLOCKED.some(pattern => pattern.test(location))) throw new Error('That file cannot be opened for editing here.');
  if (!existsSync(path.dirname(location))) throw new Error(`The folder ${path.dirname(location)} does not exist.`);
  if (existsSync(location)) {
    const stat = statSync(location);
    if (!stat.isFile()) throw new Error(`${location} is a folder, not a file.`);
    if (stat.size > LIMIT) throw new Error('That file is larger than 1 MB; it is not a file to fill in by hand.');
    if (readFileSync(location).includes(0)) throw new Error('That is not a text file.');
  }
  return { path: location, exists: existsSync(location) };
}
export function readEditable(file) {
  const { path: location, exists } = checkEditable(file);
  return { path: location, exists, content: exists ? readFileSync(location, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') : '' };
}
// Keeps the file's own line endings and byte-order mark, and writes through a temporary file so a crash never leaves half a file.
export function writeEditable(file, content) {
  const { path: location, exists } = checkEditable(file);
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > LIMIT) throw new Error('That is more than 1 MB of text.');
  const before = exists ? readFileSync(location, 'utf8') : '', crlf = /\r\n/.test(before), bom = before.startsWith('\uFEFF');
  const output = (bom ? '\uFEFF' : '') + (crlf ? text.replace(/\r?\n/g, '\r\n') : text);
  const temporary = `${location}.${process.pid}.rexdesk.tmp`;
  writeFileSync(temporary, output); renameSync(temporary, location);
  return { path: location, bytes: Buffer.byteLength(output), created: !exists };
}
// The names of KEY=value lines that have a value, never the values, so the agent can tell whether what it needed is there.
export function filledKeys(content) {
  return [...new Set(String(content || '').split(/\r?\n/).map(line => /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s*(.*)$/.exec(line)).filter(match => match && match[2].trim() && !/^["']?\s*["']?$/.test(match[2].trim())).map(match => match[1]))];
}

import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync, createWriteStream, openSync, readSync, closeSync, renameSync, rmSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const limit = 20 * 1024 * 1024;
export function imageType(bytes) {
  const head = bytes.subarray(0, 12);
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  return '';
}
export function taskImageUrls(task) {
  return new Set([...(task.images || []), ...(task.contentImages || []), ...(task.comments || []).flatMap(comment => comment.images || [])]
    .flatMap(item => [item.url, item.thumbnail]).filter(Boolean));
}
// Only image addresses already present in a stored task are fetched, so the dashboard cannot become a general proxy.
export async function cachedTaskImage(store, taskId, address, { fetcher = fetch } = {}) {
  const task = store.get('task', taskId);
  if (!task) throw new Error('Task not found.');
  if (!taskImageUrls(task).has(address)) throw new Error('This image is not part of the selected task.');
  const directory = path.join(store.directory, 'cache', 'images'), key = createHash('sha256').update(address).digest('hex');
  mkdirSync(directory, { recursive: true });
  const cached = readdirSync(directory).find(name => name.startsWith(`${key}.`));
  if (cached) return path.join(directory, cached);
  let target = new URL(address), response;
  for (let hop = 0; hop < 4; hop++) {
    if (target.protocol !== 'https:') throw new Error('Task images must use HTTPS.');
    response = await fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    target = new URL(response.headers.get('location'), target);
  }
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Image exceeds 20 MB.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('Image exceeds 20 MB.');
  const type = imageType(bytes);
  if (!type) throw new Error('The tracker returned a file that is not a supported image.');
  const file = path.join(directory, `${key}.${type}`);
  if (!existsSync(file)) writeFileSync(file, bytes);
  return file;
}

// Videos are recognized by their container, never by the name the tracker gives them.
export function mediaType(bytes) {
  const image = imageType(bytes);
  if (image) return image;
  if (bytes.toString('latin1', 4, 8) === 'ftyp') return bytes.toString('latin1', 8, 10) === 'qt' ? 'mov' : 'mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  return '';
}
export function taskFileUrls(task) {
  return new Set([...taskImageUrls(task), ...(task.files || []), ...(task.contentFiles || []), ...(task.comments || []).flatMap(comment => comment.files || [])]
    .map(item => typeof item === 'string' ? item : item?.url).filter(Boolean));
}
const mediaLimit = 500 * 1024 * 1024, downloads = new Map();
// Image and video attachments of a stored task, downloaded once into the cache and streamed from disk so the viewer can seek.
export async function cachedTaskMedia(store, taskId, address, { fetcher = fetch } = {}) {
  const task = store.get('task', taskId);
  if (!task) throw new Error('Task not found.');
  if (!taskFileUrls(task).has(address)) throw new Error('This file is not part of the selected task.');
  const directory = path.join(store.directory, 'cache', 'media'), key = createHash('sha256').update(address).digest('hex');
  mkdirSync(directory, { recursive: true });
  const cached = readdirSync(directory).find(name => name.startsWith(`${key}.`) && !name.endsWith('.part'));
  if (cached) return path.join(directory, cached);
  // A video player asks for the same file several times at once; they share one download.
  if (!downloads.has(key)) downloads.set(key, downloadMedia(directory, key, address, fetcher).finally(() => downloads.delete(key)));
  return downloads.get(key);
}
async function downloadMedia(directory, key, address, fetcher) {
  let target = new URL(address), response;
  for (let hop = 0; hop < 4; hop++) {
    if (target.protocol !== 'https:') throw new Error('Task files must use HTTPS.');
    response = await fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(300000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    target = new URL(response.headers.get('location'), target);
  }
  if (!response.ok || !response.body) throw new Error(`File request failed with HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > mediaLimit) throw new Error('The file is larger than 500 MB. Open it in the tracker instead.');
  const partial = path.join(directory, `${key}.part`);
  let size = 0;
  const count = new Transform({ transform(chunk, encoding, done) { size += chunk.length; done(size > mediaLimit ? new Error('The file is larger than 500 MB. Open it in the tracker instead.') : null, chunk); } });
  try { await pipeline(Readable.fromWeb(response.body), count, createWriteStream(partial)); }
  catch (error) { rmSync(partial, { force: true }); throw error; }
  const head = Buffer.alloc(16), handle = openSync(partial, 'r');
  try { readSync(handle, head, 0, 16, 0); } finally { closeSync(handle); }
  const type = mediaType(head);
  if (!type) { rmSync(partial, { force: true }); throw new Error('This attachment is not an image or video Rex Desk can show. Open it in the tracker.'); }
  const file = path.join(directory, `${key}.${type}`);
  renameSync(partial, file);
  return file;
}

import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';

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

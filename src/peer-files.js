// A picture, video or file an agent made on the person's other computer is not on this disk, and the cloud backup does not
// always have it (a video over 25 MB is never backed up, L112). Then this computer asks the computer that holds it, through
// the account's relay (api.rexdesk.dev/v1/relay/peer/<computer>/file), the same way the phone reaches a desk: no Tailscale.
// Small files are brought over and kept here; a big video is passed straight through to whoever asked, a range at a time, so
// it starts playing at once instead of waiting for the whole file. When it cannot, why stays here (why), so the chat says it.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ACCOUNT_API } from './rexdesk-account.js';
import { chatFileId, evidenceId } from './peers.js';

// Brought over and kept here in one go: pictures and pages for the Media grid, small recordings. Bigger is streamed.
export const KEEP_BYTES = 8 * 1024 * 1024;
// Never passed through the relay: past this the person opens it on the computer that has it.
export const PEER_FILE_MAX = 1024 * 1024 * 1024;
const FOLDERS = ['artifacts', 'uploads', 'room-images'];
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const MB = bytes => `${Math.round(bytes / 1048576)} MB`;

// The key a data file is known by on every computer: data/<folder>/<rest>, or '' for anything outside the data folders.
export function dataKey(store, file) {
  const full = path.resolve(String(file || ''));
  for (const folder of FOLDERS) {
    const root = path.resolve(store.media(folder)), relative = path.relative(root, full);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return `data/${folder}/${relative.split(path.sep).join('/')}`;
  }
  return '';
}
// The local file for a key, never outside its folder.
export function dataFile(store, key) {
  const match = /^data\/([a-z-]+)\/(.+)$/.exec(String(key || ''));
  if (!match || !FOLDERS.includes(match[1])) return '';
  const parts = match[2].split('/'); if (parts.some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) return '';
  const root = path.resolve(store.media(match[1])), file = path.resolve(root, ...parts);
  return file.startsWith(root + path.sep) ? file : '';
}

export class PeerFiles {
  constructor(desk, { fetcher = (...args) => fetch(...args), base = ACCOUNT_API } = {}) { this.desk = desk; this.fetcher = fetcher; this.base = base; this.missing = new Map(); this.inflight = new Map(); }
  get store() { return this.desk.store; }
  // The computers that may hold this file, most likely first: the one whose chat it came from, then every other computer
  // this one has heard of. This computer is never asked.
  holders(key) {
    const self = this.store.nodeId, peers = this.desk.peers, hints = [];
    const artifact = /^data\/artifacts\/([^/]+)\/(.+)$/.exec(key);
    if (artifact) hints.push(this.store.get('chatcopy', artifact[1])?.node, this.store.get('chatfile', evidenceId(artifact[1], artifact[2]))?.node);
    const upload = /^data\/uploads\/([^/]+)\/([^/]+)$/.exec(key);
    if (upload) hints.push(this.store.get('chatfile', chatFileId(`/uploads/${upload[1]}/${upload[2]}`))?.node);
    const heard = [...(peers?.cloudSeen?.keys?.() || [])].sort((left, right) => (peers?.lastHeard?.(right) || 0) - (peers?.lastHeard?.(left) || 0));
    const known = (peers?.settings?.().peers || []).map(peer => peer.id);
    return [...new Set([...hints, ...heard, ...known].filter(node => node && node !== self))].slice(0, 6);
  }
  nameOf(node) { const peers = this.desk.peers; return peers?.cloudSeen?.get?.(node)?.name || peers?.byNode?.(node)?.name || ''; }
  // Why the last try for this key did not bring it: offline (the computer that has it is off, holder names it), too-big,
  // signed-out, not-paid (the relay is for cloud backup accounts), not-found (none of the computers that are on has it),
  // or failed. Null when it came, or was never asked.
  why(key) { return this.missing.get(key) || null; }
  miss(key, reason, extra = {}) { this.missing.set(key, { reason, ...extra }); return null; }
  // One answer from a computer that may hold the file: the Response when it has it, or null with why set.
  async ask(key, { range = '' } = {}) {
    const token = this.desk.net?.token?.();
    if (!token) return this.miss(key, 'signed-out');
    const holders = this.holders(key); if (!holders.length) return this.miss(key, 'not-found');
    let offline = '', lastError = '';
    for (const node of holders) {
      const url = `${this.base}/v1/relay/peer/${encodeURIComponent(node)}/file?key=${encodeURIComponent(key)}&from=${encodeURIComponent(this.store.nodeId || '')}`;
      let response;
      try { response = await this.fetcher(url, { headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) } }); }
      catch (error) { lastError = error.message || String(error); continue; }
      if (response.status === 200 || response.status === 206) {
        const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') || '')?.[1] || response.headers.get('content-length') || 0);
        if (total > PEER_FILE_MAX) { await response.body?.cancel?.().catch(() => {}); return this.miss(key, 'too-big', { holder: this.nameOf(node), size: total }); }
        this.missing.delete(key); response.holder = node; response.total = total; return response;
      }
      await response.body?.cancel?.().catch(() => {});
      if (response.status === 401) return this.miss(key, 'signed-out');
      if (response.status === 402) return this.miss(key, 'not-paid');
      // 503: that computer's relay line is not open (it is off, asleep, or Rex Desk is closed there).
      if (response.status === 503 || response.status === 504) { offline ||= node; continue; }
      if (response.status === 416) return response;
      if (response.status !== 404) lastError = `HTTP ${response.status}`;
    }
    if (offline) return this.miss(key, 'offline', { holder: this.nameOf(offline) });
    return lastError ? this.miss(key, 'failed', { detail: lastError.slice(0, 200) }) : this.miss(key, 'not-found');
  }
  // Bring a small file over and keep it here, so it opens like a local one from now on. True when it is here afterwards.
  // A big one is left where it is (pipe streams it); keep: false only checks that a computer has it.
  keep(key, { limit = KEEP_BYTES } = {}) {
    const file = dataFile(this.store, key); if (!file) return Promise.resolve(false);
    if (existsSync(file)) return Promise.resolve(true);
    const running = this.inflight.get(key); if (running) return running;
    const work = (async () => {
      // Always as a range from the start: the relay drops Content-Length, and Content-Range still says how big the file is.
      const response = await this.ask(key, { range: 'bytes=0-' }); if (!response) return false;
      if (response.status !== 206 || !/^bytes 0-/.test(response.headers.get('content-range') || '') || response.total > limit) { await response.body?.cancel?.().catch(() => {}); return false; }
      return this.saveBody(file, response);
    })().catch(error => { this.miss(key, 'failed', { detail: String(error.message || error).slice(0, 200) }); return false; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work); return work;
  }
  async saveBody(file, response) {
    mkdirSync(path.dirname(file), { recursive: true });
    const partial = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try { await pipeline(Readable.fromWeb(response.body), createWriteStream(partial)); renameSync(partial, file); return true; }
    catch (error) { rmSync(partial, { force: true }); throw error; }
  }
  // The size and kind of a file without bringing it over: the first byte, with the whole length in Content-Range.
  async peek(key) {
    const response = await this.ask(key, { range: 'bytes=0-0' }); if (!response) return null;
    await response.body?.cancel?.().catch(() => {});
    return { size: response.total, holder: response.holder, type: response.headers.get('content-type') || '' };
  }
  // Pass the file (or the range the browser asked for) straight from the computer that has it to this request. A small
  // whole file is kept here on the way. True when it was served; false with why set when no computer could give it.
  async pipe(key, request, response, { download = false, headers: extra = {} } = {}) {
    const range = /^bytes=\d*-\d*$/.test(String(request.headers.range || '')) ? request.headers.range : '';
    // A request for the whole file is asked as bytes=0- and answered 200 with its length, which the relay would drop otherwise.
    const got = await this.ask(key, { range: range || 'bytes=0-' }); if (!got) return false;
    const whole = !range && got.status === 206;
    const headers = { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'X-Rex-From-Computer': encodeURIComponent(this.nameOf(got.holder) || 'other'), ...extra };
    for (const name of PASS) { const value = got.headers.get(name); if (value) headers[name.replace(/(^|-)\w/g, part => part.toUpperCase())] = value; }
    if (whole) { delete headers['Content-Range']; headers['Content-Length'] = String(got.total); headers['Accept-Ranges'] = 'bytes'; }
    if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(dataFile(this.store, key) || key))}`;
    response.writeHead(whole ? 200 : got.status, headers);
    if (!got.body || request.method === 'HEAD') { await got.body?.cancel?.().catch(() => {}); response.end(); return true; }
    const source = Readable.fromWeb(got.body);
    request.once?.('close', () => { if (!response.writableEnded) source.destroy(); });
    try { await pipeline(source, response); } catch { /* the browser went away (a video seeks with a new range) */ }
    return true;
  }
  // The sentence the chat shows when the file could not come, or '' when there is no reason known.
  say(key, name = path.basename(key)) {
    const why = this.why(key); if (!why) return '';
    const where = why.holder ? `on ${why.holder}` : 'on your other computer';
    if (why.reason === 'offline') return `${name} is ${where}, which is offline. Turn that computer on with Rex Desk open, then try again.`;
    if (why.reason === 'too-big') return `${name} is too large to open from another computer (${MB(why.size)}, the limit is ${MB(PEER_FILE_MAX)}). Open it ${where}.`;
    if (why.reason === 'signed-out') return `${name} is on your other computer. Sign this computer in to your Rex Desk account to open it here.`;
    if (why.reason === 'not-paid') return `${name} is on your other computer. Opening files from another computer comes with cloud backup.`;
    if (why.reason === 'not-found') return `${name} is not on any of your computers that are on right now, and it is not in the cloud backup.`;
    return `${name} could not be brought from your other computer${why.detail ? ` (${why.detail})` : ''}. Try again in a moment.`;
  }
}

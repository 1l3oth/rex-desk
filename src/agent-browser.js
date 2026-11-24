// The browser agents use (Settings, Agents, Browser for agents): Obscura, a light headless browser offered as browser_* tools
// through desk_find/desk_run, Chromium, a full browser for recorded proof (desk_browser), or Off. Neither ships with Rex Desk.
// The chosen one is downloaded the first time an agent needs it, only after the person says yes in Needs you: a pinned
// version, checked against its sha256, kept in the data folder (tools, which follows the storage folder setting).
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { connectServer } from './toolbox.js';
// The 38 browser_* tools of Obscura v0.2.7 (its tools/list), so desk_find can offer them before anything is downloaded.
export const OBSCURA_TOOLS = JSON.parse(readFileSync(new URL('./obscura-tools.json', import.meta.url), 'utf8'));

export const BROWSER_CHOICES = ['obscura', 'chromium', 'off'];
export const browserChoice = store => BROWSER_CHOICES.includes(store.config().agentBrowser) ? store.config().agentBrowser : 'obscura';

const OBSCURA = 'https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.7';
const CHROMIUM = 'https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4';
// Pinned builds: the address, its size and its sha256 (from the GitHub release of Obscura v0.2.7, and measured once for the
// Chrome for Testing headless shell 156.0.8078.4 that Playwright 1.64 drives). Normal Obscura builds, never the stealth ones.
export const TOOLS = {
  obscura: {
    name: 'Obscura', version: '0.2.7', exe: process.platform === 'win32' ? 'obscura.exe' : 'obscura', onDisk: 'about 150 MB on disk',
    builds: {
      'win32-x64': { url: `${OBSCURA}/obscura-x86_64-windows.zip`, size: 72427564, sha256: 'be983b663552e11faf8c1e07696578bad622dbeb48afb9f59036032ca8e97fb3' },
      'darwin-arm64': { url: `${OBSCURA}/obscura-aarch64-macos.tar.gz`, size: 67612634, sha256: 'fc7e73f23058f18d6d5be983d83b24ba374d12167677657a307a9476c0f5a7c1' },
      'darwin-x64': { url: `${OBSCURA}/obscura-x86_64-macos.tar.gz`, size: 69818596, sha256: 'c47383e5b5551e09d2055ee7bdcce788af409fb4394e39bdaf179734df18e829' },
      'linux-x64': { url: `${OBSCURA}/obscura-x86_64-linux.tar.gz`, size: 72018118, sha256: '11b53d27cd743e00e196e216920e7f3f794cf378e3f1792b8d25d3beabaf9cad' },
      'linux-arm64': { url: `${OBSCURA}/obscura-aarch64-linux.tar.gz`, size: 69952302, sha256: '4ee0aeeb38fa8bb2cb004ba104abe1c79f1bdfd02f51672c694e8234a5ae0e5c' },
    },
  },
  chromium: {
    name: 'Chromium', version: '156.0.8078.4', exe: process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell', onDisk: '400 to 600 MB on disk',
    builds: {
      'win32-x64': { url: `${CHROMIUM}/win64/chrome-headless-shell-win64.zip`, size: 123826519, sha256: '5af4c82cf4b351ec4bad4c71dcf938af14fccea8a0eb0d5c2a7b49ccc922698c' },
      'darwin-arm64': { url: `${CHROMIUM}/mac-arm64/chrome-headless-shell-mac-arm64.zip`, size: 103778487, sha256: '94e4337b70cbc5638f0935fbc46b9f242bc7416f657e3fbe924baf348404b53d' },
      'darwin-x64': { url: `${CHROMIUM}/mac-x64/chrome-headless-shell-mac-x64.zip`, size: 109130614, sha256: '8a9e4a32ba5b1a796f8b16d01896e355cf6662544d9743296394fd999d782331' },
    },
  },
};
export const megabytes = bytes => `${Math.round(bytes / 1048576)} MB`;
// The plain answer an agent gets when no browser is on: it says so, and never tells the person to run a command.
export const NO_BROWSER = 'No browser is on for agents on this computer. The person can turn one on in Settings, Agents, Browser for agents. Do not install one yourself; tell the person in one line if the task needs a browser.';

// Private addresses: loopback, RFC 1918, link-local and .local names. Blocked unless a QA agent opens its own preview.
export function privateHost(host) {
  const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!name || name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name === '::1' || name === '0.0.0.0') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(name) || name.startsWith('fe80:')) return true;
  const parts = name.split('.').map(Number); if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false;
  return parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254);
}
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host || '').toLowerCase());
// The system fonts folders, so pages in Khmer (and every other script) render with real glyphs, not boxes.
export function fontFolders(platform = process.platform) {
  if (platform === 'win32') return [path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts')];
  if (platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')].filter(existsSync);
  return ['/usr/share/fonts', '/usr/local/share/fonts'].filter(existsSync);
}
// Archives open with the system's own tar (bsdtar on Windows 10+ and macOS reads zip too); on Windows the one in System32,
// since a Git tar on the PATH cannot read zip.
// One pinned file into `file`: its size and sha256 must match, or it is thrown away and nothing is used.
export async function downloadPinned(fetcher, build, file, name, say = () => {}) {
  const response = await fetcher(build.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${name} could not be downloaded (the server answered ${response.status}).`);
  const hash = createHash('sha256'), out = createWriteStream(file); let got = 0, shown = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
      const percent = Math.floor(got * 100 / build.size);
      if (build.size > 5 * 1048576 && percent >= shown + 20 && percent < 100) { shown = percent - (percent % 20); say(`Downloading ${name}: ${shown}% of ${megabytes(build.size)}.`); }
    }
  } finally { await new Promise(resolve => out.end(resolve)); }
  if (got !== build.size || hash.digest('hex') !== build.sha256) { rmSync(file, { force: true }); throw new Error(`The ${name} download did not match its pinned checksum, so it was thrown away. Nothing was installed.`); }
}
export const extract = (archive, into) => new Promise((resolve, reject) => {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFile(tar, ['-xf', archive, '-C', into], { windowsHide: true, timeout: 10 * 60000 }, error => error ? reject(new Error(`The download could not be unpacked: ${error.message}`)) : resolve());
});
const findFile = (folder, name, depth = 0) => {
  if (depth > 4) return '';
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) { const found = findFile(full, name, depth + 1); if (found) return found; }
  }
  return '';
};

export class AgentBrowser {
  constructor(desk, { fetcher = fetch, tools = TOOLS, platform = `${process.platform}-${process.arch}`, connect = connectServer, idleMs = 5 * 60000 } = {}) {
    Object.assign(this, { desk, store: desk.store, fetcher, tools, platform, connect, idleMs });
    this.installs = new Map(); this.sessions = new Map();
  }
  choice() { return browserChoice(this.store); }
  offText() { return NO_BROWSER; }
  folder() { return this.store.media('tools'); }
  home(id) { return path.join(this.folder(), `${id}-${this.tools[id].version}`); }
  // The installed program, or '' when it is not downloaded yet (or was only partly unpacked).
  installed(id) {
    const tool = this.tools[id], home = this.home(id);
    try { const saved = JSON.parse(readFileSync(path.join(home, 'installed.json'), 'utf8')); return saved.version === tool.version && saved.exe && existsSync(saved.exe) ? saved.exe : ''; } catch { return ''; }
  }
  // What Settings shows: the choice, and for each browser whether it is here, its download size, and a download in progress.
  status() {
    return { choice: this.choice(), tools: Object.fromEntries(Object.entries(this.tools).map(([id, tool]) => { const build = tool.builds[this.platform]; return [id, { name: tool.name, version: tool.version, installed: Boolean(this.installed(id)), size: build?.size || 0, available: Boolean(build), downloading: this.installs.has(id), declined: Boolean(this.declined(id)) }]; })) };
  }
  // A no from the person counts until the setting changes.
  declined(id) { const saved = this.store.get('browser-tool', id); return saved?.declined && saved.choiceAt === (this.store.config().agentBrowserAt || '') ? saved : null; }
  // The program for this agent's turn: downloaded first if the person agrees. Returns { exe } or { off: message }.
  async ensure(runId, id) {
    const choice = this.choice();
    if (choice === 'off' || choice !== id) return { off: choice === 'off' ? NO_BROWSER : `${NO_BROWSER} The browser chosen for agents is ${this.tools[choice]?.name || choice}, not ${this.tools[id].name}.` };
    const ready = this.installed(id); if (ready) return { exe: ready };
    const tool = this.tools[id], build = tool.builds[this.platform];
    if (!build) return { off: `${tool.name} has no build for this computer (${this.platform}). ${NO_BROWSER}` };
    if (this.declined(id)) return { off: `${NO_BROWSER} The person said no to downloading ${tool.name}.` };
    if (!this.installs.has(id)) {
      const answer = await this.desk.ask(runId, { kind: 'approval', method: 'browser-download', title: `Download ${tool.name} for agents? It is a ${megabytes(build.size)} download (${tool.onDisk}), kept in the Rex Desk data folder. Agents use it to open web pages.`, request: { browser: id, version: tool.version, size: build.size } });
      if (answer?.action !== 'accept') { this.store.put('browser-tool', id, { id, declined: true, at: new Date().toISOString(), choiceAt: this.store.config().agentBrowserAt || '' }); return { off: `${NO_BROWSER} The person said no to downloading ${tool.name}.` }; }
    }
    return { exe: await this.install(id, runId) };
  }
  // Download, check, unpack: one download at a time per browser, shared by every agent that needs it meanwhile.
  install(id, runId = '') {
    if (!this.installs.has(id)) this.installs.set(id, this.download(id, runId).finally(() => this.installs.delete(id)));
    return this.installs.get(id);
  }
  async download(id, runId) {
    const tool = this.tools[id], build = tool.builds[this.platform], home = this.home(id), folder = this.folder();
    const say = text => { if (runId) this.store.event(runId, 'message', { text }, true); this.store.emit?.('browser-tool', { id, text }); };
    const archive = path.join(folder, `${id}-${tool.version}.download`), partial = `${home}.partial`;
    rmSync(archive, { force: true }); rmSync(partial, { recursive: true, force: true });
    say(`Downloading ${tool.name} ${tool.version} for agents (${megabytes(build.size)}).`);
    await downloadPinned(this.fetcher, build, archive, tool.name, say);
    try {
      mkdirSync(partial, { recursive: true });
      await extract(archive, partial);
      const exe = findFile(partial, tool.exe); if (!exe) throw new Error(`The ${tool.name} download has no ${tool.exe}.`);
      if (process.platform !== 'win32') chmodSync(exe, 0o755);
      rmSync(home, { recursive: true, force: true }); renameSync(partial, home);
      const final = path.join(home, path.relative(partial, exe));
      writeFileSync(path.join(home, 'installed.json'), JSON.stringify({ id, version: tool.version, sha256: build.sha256, exe: final, at: new Date().toISOString() }, null, 2));
      say(`${tool.name} ${tool.version} is ready for agents.`);
      return final;
    } catch (error) { rmSync(partial, { recursive: true, force: true }); throw error; }
    finally { rmSync(archive, { force: true }); }
  }

  // ---------- Obscura as browser_* tools, one process per agent ----------
  agentOf(run) { return run?.roomAgent || run?.specialistId || (run?.main ? 'main' : run?.id || 'agent'); }
  // A QA agent may open its own preview on this computer (loopback only); every other agent stays off private addresses.
  previewAllowed(run) {
    const agent = this.store.get('specialist', run?.roomAgent || run?.specialistId || '');
    return /\bqa\b/i.test(`${agent?.name || ''} ${agent?.role || ''}`);
  }
  // Where the agent's cookies and storage live while its browser runs: its own folder in the work folder, never C: for a project.
  storageFor(run, key) {
    const base = this.desk.workFolderOf ? this.desk.workFolderOf(run?.projectPath || '') : path.join(this.store.directory, 'work');
    return path.join(base, 'tmp', 'browser', key.replace(/[^\w.-]/g, '_'));
  }
  async session(runId) {
    const run = this.store.get('run', runId), key = this.agentOf(run);
    const open = this.sessions.get(key);
    if (open) { this.touch(key); return open; }
    const got = await this.ensure(runId, 'obscura'); if (got.off) return got;
    const storage = this.storageFor(run, key), allow = this.previewAllowed(run);
    mkdirSync(storage, { recursive: true });
    const args = ['--storage-dir', storage, 'mcp', ...fontFolders().flatMap(folder => ['--font-dir', folder]), ...(allow ? ['--allow-private-network'] : [])];
    const client = await this.connect('obscura', { command: got.exe, args, env: { RUST_LOG: 'error', OBSCURA_LOG: 'error' }, cwd: storage });
    const session = { client, storage, allow, port: Number(run?.port) || 0 };
    this.sessions.set(key, session); this.touch(key);
    return session;
  }
  touch(key) { const open = this.sessions.get(key); if (!open) return; clearTimeout(open.timer); open.timer = setTimeout(() => void this.close(key), this.idleMs); open.timer.unref?.(); }
  // Idle for a while, or Rex Desk closing: the process ends and the agent's cookies go with it.
  async close(key) {
    const open = this.sessions.get(key); if (!open) return; this.sessions.delete(key); clearTimeout(open.timer);
    await open.client.close?.().catch(() => {});
    rmSync(open.storage, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  async closeAll() { await Promise.all([...this.sessions.keys()].map(key => this.close(key))); }
  // desk_run obscura/<tool>: checked, called in the agent's own browser, and a picture it returns is saved as a file.
  async call(runId, name, input = {}) {
    if (this.choice() !== 'obscura') return { off: true, note: this.choice() === 'off' ? NO_BROWSER : `The browser for agents is ${this.tools[this.choice()]?.name}; use desk_browser instead.` };
    if (!OBSCURA_TOOLS.some(tool => tool.name === name)) throw new Error(`Obscura has no tool "${name}". Search with desk_find.`);
    const target = input?.url ? (() => { try { return new URL(String(input.url)); } catch { return null; } })() : null;
    const session = await this.session(runId); if (session.off) return { off: true, note: session.off };
    if (target && privateHost(target.hostname) && !(session.allow && loopback(target.hostname) && (!session.port || Number(target.port) === session.port)))
      return { failed: true, result: session.allow ? `Only your own preview (http://127.0.0.1:${session.port || '<port>'}) can be opened on this computer's network.` : 'Pages on this computer or its local network are blocked for agents.' };
    const result = await session.client.callTool({ name, arguments: input && typeof input === 'object' ? input : {} }, undefined, { timeout: 5 * 60000 });
    const saved = [], texts = [];
    for (const part of result.content || []) {
      if (part.type === 'text') texts.push(part.text);
      else if ((part.type === 'image' || part.type === 'resource') && (part.data || part.resource?.blob)) {
        const type = part.mimeType || part.resource?.mimeType || 'image/png', ext = type.includes('pdf') ? 'pdf' : type.includes('jpeg') ? 'jpg' : 'png';
        const folder = path.join(this.store.media('artifacts'), runId); mkdirSync(folder, { recursive: true });
        const file = path.join(folder, `obscura-${Date.now()}-${saved.length + 1}.${ext}`);
        writeFileSync(file, Buffer.from(part.data || part.resource.blob, 'base64')); saved.push(file);
      }
    }
    this.touch(this.agentOf(this.store.get('run', runId)));
    const text = texts.join('\n');
    return { tool: `obscura/${name}`, ...(result.isError ? { failed: true } : {}), result: text.length > 30000 ? `${text.slice(0, 30000)}\n… (${text.length - 30000} more characters)` : text,
      ...(saved.length ? { files: saved, note: 'Saved on this computer. Read it with your Read tool, or share it with desk_share_evidence.' } : {}) };
  }
}

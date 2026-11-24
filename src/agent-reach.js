// Agent Reach (github.com/Panniantong/Agent-Reach, MIT): lets agents read YouTube, GitHub, Reddit and web pages, read-only.
// Only its tool list ships with Rex Desk. The pinned uv and the pinned Agent Reach wheel are downloaded the first time an
// agent needs them, after a yes in Needs you, each checked against its sha256, and installed in the data folder (tools), with
// its own home there, so nothing lands in the person's user folder. No sign-ins: Chrome cookie copy, login, its browser and
// paid speech-to-text are never used, and channels that would need a sign-in read only public pages.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { downloadPinned, extract, megabytes, privateHost } from './agent-browser.js';

export const REACH_TOOLS = JSON.parse(readFileSync(new URL('./agent-reach-tools.json', import.meta.url), 'utf8'));
// The platforms the person can switch on and off (Settings, Agents), and their names there.
export const REACH_PLATFORMS = [['youtube', 'YouTube'], ['github', 'GitHub'], ['reddit', 'Reddit'], ['web', 'Web pages']];
export const reachOn = store => { const saved = store.config().agentReach || {}; return Object.fromEntries(REACH_PLATFORMS.map(([id]) => [id, saved[id] !== false])); };

const VERSION = '1.6.1', UV = 'https://github.com/astral-sh/uv/releases/download/0.13.9';
export const PINS = {
  wheel: { url: `https://github.com/Panniantong/Agent-Reach/releases/download/v${VERSION}/agent_reach-${VERSION}-py3-none-any.whl`, size: 164630, sha256: '6a1085cae53118c5f1271ab24041e55ec17c509932612b919208f04d10183acb' },
  uv: {
    'win32-x64': { url: `${UV}/uv-x86_64-pc-windows-msvc.zip`, size: 15567875, sha256: 'edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb' },
    'darwin-arm64': { url: `${UV}/uv-aarch64-apple-darwin.tar.gz`, size: 14554974, sha256: '5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca' },
    'darwin-x64': { url: `${UV}/uv-x86_64-apple-darwin.tar.gz`, size: 17362924, sha256: '617a3211261b0fc739562f0071aa34e9739797c510208ede8e2977c30903d041' },
    'linux-x64': { url: `${UV}/uv-x86_64-unknown-linux-gnu.tar.gz`, size: 17068176, sha256: 'a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5' },
    'linux-arm64': { url: `${UV}/uv-aarch64-unknown-linux-gnu.tar.gz`, size: 16120245, sha256: '0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d' },
  },
};
const findFile = (folder, names, depth = 0) => {
  if (depth > 4 || !existsSync(folder)) return '';
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return full;
    if (entry.isDirectory()) { const found = findFile(full, names, depth + 1); if (found) return found; }
  }
  return '';
};
const exec = (file, args, options) => new Promise(resolve => execFile(file, args, { windowsHide: true, maxBuffer: 20 * 1048576, ...options }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })));

export class AgentReach {
  constructor(desk, { fetcher = fetch, run = exec, platform = `${process.platform}-${process.arch}`, pins = PINS } = {}) {
    Object.assign(this, { desk, store: desk.store, fetcher, run, platform, pins });
  }
  home() { return path.join(this.store.media('tools'), `agent-reach-${VERSION}`); }
  installed() { try { const saved = JSON.parse(readFileSync(path.join(this.home(), 'installed.json'), 'utf8')); return saved.version === VERSION && existsSync(saved.exe) ? saved.exe : ''; } catch { return ''; } }
  status() { return { version: VERSION, installed: Boolean(this.installed()), downloading: Boolean(this.installing), on: reachOn(this.store), size: (this.pins.uv[this.platform]?.size || 0) + this.pins.wheel.size }; }
  declined() { const saved = this.store.get('browser-tool', 'agent-reach'); return saved?.declined && saved.choiceAt === (this.store.config().agentReachAt || '') ? saved : null; }
  // Everything it writes stays in its own folder: uv, Python, the tool, its cache, and Agent Reach's ~/.agent-reach.
  env() {
    const home = this.home(), user = path.join(home, 'home'), temp = path.join(home, 'tmp');
    mkdirSync(user, { recursive: true }); mkdirSync(temp, { recursive: true });
    return { ...process.env, USERPROFILE: user, HOME: user, TEMP: temp, TMP: temp, TMPDIR: temp, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      UV_TOOL_DIR: path.join(home, 'tools'), UV_TOOL_BIN_DIR: path.join(home, 'bin'), UV_PYTHON_INSTALL_DIR: path.join(home, 'python'), UV_CACHE_DIR: path.join(home, 'cache'), UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_MODIFY_PATH: '1' };
  }
  async ensure(runId) {
    const ready = this.installed(); if (ready) return { exe: ready };
    const uv = this.pins.uv[this.platform];
    if (!uv) return { off: `Agent Reach has no build for this computer (${this.platform}).` };
    if (this.declined()) return { off: 'The person said no to downloading Agent Reach. Tell them in one line if the task needs it.' };
    if (!this.installing) {
      const answer = await this.desk.ask(runId, { kind: 'approval', method: 'tool-download', title: `Download Agent Reach for agents? It is a ${megabytes(uv.size + this.pins.wheel.size)} download, then Python and its parts (about 150 MB on disk), kept in the Rex Desk data folder. Agents use it to read YouTube, GitHub, Reddit and web pages. It never signs in anywhere.`, request: { tool: 'agent-reach', version: VERSION, size: uv.size + this.pins.wheel.size } });
      if (answer?.action !== 'accept') { this.store.put('browser-tool', 'agent-reach', { id: 'agent-reach', declined: true, at: new Date().toISOString(), choiceAt: this.store.config().agentReachAt || '' }); return { off: 'The person said no to downloading Agent Reach. Tell them in one line if the task needs it.' }; }
    }
    this.installing ||= this.install(runId).finally(() => { this.installing = null; });
    return { exe: await this.installing };
  }
  async install(runId = '') {
    const home = this.home(), say = text => { if (runId) this.store.event(runId, 'message', { text }, true); };
    rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
    try {
      say(`Downloading Agent Reach ${VERSION} for agents.`);
      const uvArchive = path.join(home, 'uv.download'), wheel = path.join(home, path.basename(this.pins.wheel.url));
      await downloadPinned(this.fetcher, this.pins.uv[this.platform], uvArchive, 'uv', say);
      await downloadPinned(this.fetcher, this.pins.wheel, wheel, 'Agent Reach', say);
      mkdirSync(path.join(home, 'uv'), { recursive: true }); await extract(uvArchive, path.join(home, 'uv')); rmSync(uvArchive, { force: true });
      const uv = findFile(path.join(home, 'uv'), ['uv.exe', 'uv']); if (!uv) throw new Error('The uv download has no uv program.');
      say('Installing Agent Reach and its Python (one time).');
      const done = await this.run(uv, ['tool', 'install', '--python', '3.12', wheel], { env: this.env(), cwd: home, timeout: 20 * 60000 });
      if (done.error?.killed) throw new Error('Agent Reach could not be installed: downloading Python and its parts took over 20 minutes. Try again on a faster connection.');
      if (done.error) throw new Error(`Agent Reach could not be installed: ${(done.stderr || done.error.message).trim().split('\n').slice(-3).join(' ')}`);
      const exe = findFile(path.join(home, 'bin'), ['agent-reach.exe', 'agent-reach']); if (!exe) throw new Error('Agent Reach installed without its program.');
      writeFileSync(path.join(home, 'installed.json'), JSON.stringify({ version: VERSION, exe, at: new Date().toISOString() }, null, 2));
      say(`Agent Reach ${VERSION} is ready for agents.`);
      return exe;
    } catch (error) { rmSync(home, { recursive: true, force: true }); throw error; }
  }
  // desk_run agent-reach/<platform>_<action>: only the shipped read-only tools, only on platforms that are switched on.
  async call(runId, name, input = {}) {
    const tool = REACH_TOOLS.find(item => item.name === name);
    if (!tool) throw new Error(`Agent Reach has no tool "${name}". Search with desk_find.`);
    if (!reachOn(this.store)[tool.channel]) return { off: true, note: `${tool.channel} is switched off for agents in Settings, Agents. Tell the person in one line if the task needs it.` };
    const values = input && typeof input === 'object' ? input : {}, args = [tool.channel, tool.action];
    for (const param of tool.args) {
      const value = values[param.name];
      if (value === undefined || value === null || value === '') { if (param.required) throw new Error(`${name} needs "${param.name}".`); continue; }
      const text = String(value);
      if (text.startsWith('-')) throw new Error(`"${param.name}" cannot start with a dash.`);
      if (param.required) args.push(text); else args.push(`--${param.name}`, text);
    }
    const target = /^https?:/i.test(String(values.target || '')) ? (() => { try { return new URL(String(values.target)); } catch { return null; } })() : null;
    if (target && privateHost(target.hostname)) return { failed: true, result: 'Pages on this computer or its local network are blocked for agents.' };
    // Sites that would need a sign-in are read from their public pages only: never the person's Chrome cookies.
    if (tool.publicOnly) args.push('--backend', 'public-web');
    const got = await this.ensure(runId); if (got.off) return { off: true, note: got.off };
    const done = await this.run(got.exe, args, { env: this.env(), cwd: this.home(), timeout: 3 * 60000 });
    let data = null; try { data = JSON.parse(done.stdout); } catch { /* not JSON */ }
    if (!data) return { tool: `agent-reach/${name}`, failed: true, result: (done.stderr || done.stdout || done.error?.message || 'No answer.').trim().slice(-2000) };
    const text = (data.items || []).map(item => [item.title, item.url, item.author && `by ${item.author}`, item.text].filter(Boolean).join('\n')).join('\n\n---\n\n');
    return { tool: `agent-reach/${name}`, ...(data.ok ? {} : { failed: true }), result: data.ok ? (text.length > 30000 ? `${text.slice(0, 30000)}\n... (${text.length - 30000} more characters)` : text || 'Nothing found.') : (data.error?.message || JSON.stringify(data.error || data).slice(0, 2000)),
      ...(data.meta?.access?.mode === 'public' ? { note: 'Public page text only; it can be partial. A page that asks to log in means the site blocked public reading.' } : {}) };
  }
}

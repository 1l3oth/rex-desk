import path from 'node:path';
import { doing } from './stall-watch.js';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Rex Desk's side of an agent that runs in its own process (src/agent-host.js). It has the same face as an in-process
// runner (start, interrupt), so the coordinator treats both alike. It reads the agent's journal from where it left off,
// so after a restart it can attach to an agent that kept working, and nothing the agent did in between is lost.
const HOST_SCRIPT = fileURLToPath(new URL('./agent-host.js', import.meta.url));

// Only what an agent needs is copied: the app's code and its packages, never a checkout's .git, worktrees, .local logs or
// build output (a copy run from a dev folder once took 7 GB and filled drive C:). Dev-only packages and caches stay behind too.
const APP_PARTS = new Set(['src', 'public', 'node_modules', 'package.json']);
const NEVER = new Set(['.git', '.cache', '.vite', '.parcel-cache', '.turbo', '.next', 'worktrees', '.local', 'dist', 'target', 'build', 'coverage']);
export function runtimeSkip(appRoot) {
  let dev = [];
  try { dev = Object.keys(JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')).devDependencies || {}); } catch { /* no package.json */ }
  const devModules = new Set(dev.map(name => path.join(appRoot, 'node_modules', name)));
  return source => {
    const relative = path.relative(appRoot, source), parts = relative.split(path.sep);
    if (parts.length === 1) return !APP_PARTS.has(parts[0]);
    // Inside node_modules a package may have its own build or dist folder it needs; only caches and .git are dropped there.
    if (parts[0] === 'node_modules') return devModules.has(source) || ['.git', '.cache', '.vite'].includes(parts.at(-1));
    return NEVER.has(parts.at(-1));
  };
}
// The node folder: only its files (node.exe and its DLLs), not npm or other folders a system Node.js keeps beside it.
const nodeSkip = from => source => path.dirname(source) !== from || statSync(source).isDirectory();
const sizeOf = (folder, skip) => {
  let bytes = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const source = path.join(folder, entry.name);
    if (skip(source)) continue;
    if (entry.isDirectory()) bytes += sizeOf(source, skip); else if (entry.isFile()) bytes += statSync(source).size;
  }
  return bytes;
};
export const RUNTIME_RESERVE = 5 * 2 ** 30;

// Agents keep working through an update. On Windows the installer closes everything that runs from the install folder (it
// cannot replace a running program), so agents run from a private copy of this version (its Node.js and Rex Desk's code)
// kept beside the data. The update leaves them running, and the new server attaches to them as after any restart.
// One copy per version; older ones are removed once no agent uses them. Returns { node, script, cwd } once the copy is ready.
// When the copy would leave less than 5 GB free on that drive it is not made: agents keep running from the app's own
// folder, and onLowSpace gets a plain message for the person.
export async function prepareRuntime(directory, { version = process.env.REX_DESK_VERSION, execPath = process.execPath, appRoot = path.resolve(path.dirname(HOST_SCRIPT), '..'), platform = process.platform, free, reserve = RUNTIME_RESERVE, onLowSpace = () => {} } = {}) {
  if (!version || platform !== 'win32' || !/^[\w.-]+$/.test(version)) return null;
  doing('agents: preparing their copy of Rex Desk');
  const { copyAll } = await import('./folders.js');
  const { freeBytes, driveName } = await import('./disk.js');
  const target = path.join(directory, version), ready = path.join(target, 'ready');
  const paths = { node: path.join(target, 'node', path.basename(execPath)), script: path.join(target, 'app', 'src', 'agent-host.js'), cwd: path.join(target, 'app') };
  if (!existsSync(ready)) {
    const nodeFrom = path.dirname(execPath), appSkip = runtimeSkip(appRoot), onlyNode = nodeSkip(nodeFrom);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const size = sizeOf(nodeFrom, onlyNode) + sizeOf(appRoot, appSkip), left = (free || freeBytes)(directory);
    if (left - size < reserve) {
      const gb = bytes => (Math.max(0, bytes) / 2 ** 30).toFixed(1);
      onLowSpace(`${driveName(directory)} has only ${gb(left)} GB free, so Rex Desk did not make its private copy for agents (${gb(size)} GB); it keeps at least ${gb(reserve)} GB free. Agents still work, but an update will stop them while it installs. Free some space or move Rex Desk's files to another drive in Settings, Folders.`);
      return null;
    }
    await copyAll(nodeFrom, path.join(target, 'node'), onlyNode);
    await copyAll(appRoot, path.join(target, 'app'), appSkip);
    writeFileSync(ready, new Date().toISOString());
  }
  for (const name of existsSync(directory) ? readdirSync(directory) : []) if (name !== version) { try { rmSync(path.join(directory, name), { recursive: true }); } catch { /* an agent still runs from it */ } }
  return paths;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// What crosses into the host process: plain data only. Callbacks stay here and travel as journal entries and HTTP calls.
const PLAIN = ['run', 'cwd', 'projectDirectory', 'token', 'sourcePath', 'mcpUrl', 'model', 'agentEnv', 'javaEnv', 'artifactDirectory', 'uploadsDirectory', 'extraMcp', 'remote', 'guard', 'gateway'];

export class HostRunner {
  // options: the coordinator's runner options (event, ask, inbox, run…). onState: saves { pid, port, key, journal, offset, asks } on the run.
  // runtime: { node, script, cwd } of the private copy (prepareRuntime), so an update does not stop the agent.
  constructor(options, { directory, onState, spawner = spawn, node = process.execPath, pollMs = 250, sdkModule = '', runtime = null }) {
    Object.assign(this, { options, directory, onState, spawner, node: runtime?.node || node, script: runtime?.script || HOST_SCRIPT, cwd: runtime?.cwd || path.dirname(HOST_SCRIPT), outside: Boolean(runtime), pollMs, sdkModule, state: null, stopped: false, detached: false });
  }
  save(patch) { this.state = { ...this.state, ...patch }; this.onState?.(this.state); }
  async start(prompt) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const runId = this.options.run.id, stamp = Date.now(), base = path.join(this.directory, `${runId}-${stamp}`);
    const key = randomBytes(24).toString('base64url'), journal = `${base}.jsonl`, stateFile = `${base}.state.json`, specFile = `${base}.spec.json`;
    writeFileSync(journal, '', { mode: 0o600 });
    const options = Object.fromEntries(PLAIN.filter(name => this.options[name] !== undefined).map(name => [name, this.options[name]]));
    writeFileSync(specFile, JSON.stringify({ key, journal, stateFile, prompt, options, ...(this.sdkModule ? { sdkModule: this.sdkModule } : {}) }), { mode: 0o600 });
    const child = this.spawner(this.node, [this.script, specFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: this.cwd });
    child.unref?.();
    // outside: the agent runs from the private copy, so an update can install while it works.
    this.save({ pid: child.pid, port: 0, key, journal, stateFile, offset: 0, asks: [], ...(this.outside ? { outside: true } : {}) });
    return this.follow();
  }
  // A Rex Desk that restarted picks up an agent that kept working. Questions it was waiting on are asked again.
  attach(state) {
    this.state = { asks: [], ...state };
    for (const open of this.state.asks) this.answer(open.id, open.request);
    return this.follow();
  }
  async port() {
    if (this.state.port) return this.state.port;
    for (let attempt = 0; attempt < 80 && !this.state.port; attempt++) {
      try { const found = JSON.parse(readFileSync(this.state.stateFile, 'utf8')); if (found.port) this.save({ port: found.port }); } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    return this.state.port;
  }
  async post(route, data) {
    const port = await this.port(); if (!port) throw new Error('The agent process is not answering.');
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-host-key': this.state.key }, body: JSON.stringify(data || {}), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `The agent process answered ${response.status}.`);
  }
  answer(id, request) {
    void Promise.resolve(this.options.ask(request)).then(answer => {
      this.save({ asks: (this.state.asks || []).filter(item => item.id !== id) });
      return this.post('/answer', { id, answer });
    }).catch(() => { /* the agent ended, or was stopped, before the answer came */ });
  }
  follow() {
    return new Promise((resolve, reject) => {
      let buffer = '', quiet = 0, inboxAt = 0;
      // Hand-overs still on their way to the process. The reply's end waits for them, so one the process refuses (its reply had
      // just ended) goes back with its tickets before the turn counts anything as sent.
      const sending = new Set();
      const finish = (fn, value) => { clearInterval(this.timer); this.timer = null; void Promise.allSettled([...sending]).then(() => { this.cleanup(); fn(value); }); };
      const handOver = (news, handover) => {
        const sent = this.post('/inbox', { text: news, handover })
          // Taken into its inbox: the agent reads it, or it comes back unread before the end, so the clean end may count it.
          .then(() => { if (handover) this.options.event?.('handover-delivered', { handover }); },
            error => { if (!/timeout|aborted/i.test(String(error?.name || '') + error?.message)) this.options.requeue?.(news, handover); })
          .finally(() => sending.delete(sent));
        sending.add(sent);
      };
      const read = () => {
        if (this.detached) { clearInterval(this.timer); return; }
        try {
          // New messages for the agent go over as they come, the way an in-process agent picks them up between steps.
          // A message the process refuses (its reply just ended) or cannot take goes back to the run's queue, for the next turn.
          // Each goes with its handover (its tickets and queue entries), which comes back with it if it is refused or left unread.
          if (Date.now() - inboxAt > 1000) { inboxAt = Date.now(); const got = this.options.inbox?.({ withId: true }), news = typeof got === 'string' ? got : got?.text || '', handover = typeof got === 'string' ? null : got?.handover ?? null; if (news) handOver(news, handover); }
          const size = existsSync(this.state.journal) ? statSync(this.state.journal).size : 0;
          if (size > this.state.offset) {
            const fd = openSync(this.state.journal, 'r'), chunk = Buffer.alloc(size - this.state.offset);
            try { readSync(fd, chunk, 0, chunk.length, this.state.offset); } finally { closeSync(fd); }
            buffer += chunk.toString('utf8'); let offset = this.state.offset + chunk.length; quiet = 0;
            const lines = buffer.split('\n'); buffer = lines.pop();
            offset -= Buffer.byteLength(buffer);
            for (const line of lines) {
              if (!line.trim()) continue;
              const entry = JSON.parse(line);
              if (entry.type === 'event') this.options.event(entry.kind, entry.data);
              // Unread messages come back one by one with their handovers, so their own tickets wait again (an older process sends text only).
              else if (entry.type === 'unread') { if (Array.isArray(entry.items)) for (const item of entry.items) this.options.requeue?.(item.text, item.handover ?? null); else this.options.requeue?.(entry.text); }
              else if (entry.type === 'ask' && !(this.state.asks || []).some(item => item.id === entry.id)) { this.save({ asks: [...(this.state.asks || []), { id: entry.id, request: entry.request }] }); this.answer(entry.id, entry.request); }
              else if (entry.type === 'done') { this.save({ offset }); return finish(resolve, { status: 'completed' }); }
              else if (entry.type === 'error') { this.save({ offset }); return finish(reject, new Error(entry.message)); }
            }
            this.save({ offset }); buffer = '';
          } else if (++quiet * this.pollMs > 3000 && this.state.pid && !alive(this.state.pid)) {
            return finish(reject, new Error('The agent process ended without finishing its reply.'));
          }
        } catch (error) { finish(reject, error); }
      };
      this.timer = setInterval(read, this.pollMs); read();
    });
  }
  cleanup() { for (const file of [this.state?.journal, this.state?.stateFile]) { try { if (file) unlinkSync(file); } catch { /* gone */ } } }
  // Stop asks the agent to stop. If it does not answer (stuck in a long tool call) or is still running 15 s later, its process
  // ends, so it never keeps working after the person pressed Stop.
  async interrupt() {
    this.stopped = true;
    const asked = await this.post('/stop').then(() => true, () => false), pid = Number(this.state?.pid);
    if (!pid) return;
    const end = () => {
      if (!alive(pid)) return;
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } } }
    };
    if (asked) setTimeout(end, 15000).unref(); else end();
  }
  // Rex Desk is closing (a restart or an update): stop reading, and leave the agent working.
  detach() { this.detached = true; clearInterval(this.timer); this.timer = null; }
  close() {}
}
export const hostAlive = alive;

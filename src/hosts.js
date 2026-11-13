import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Rex Desk's side of an agent that runs in its own process (src/agent-host.js). It has the same face as an in-process
// runner (start, interrupt), so the coordinator treats both alike. It reads the agent's journal from where it left off,
// so after a restart it can attach to an agent that kept working, and nothing the agent did in between is lost.
const HOST_SCRIPT = fileURLToPath(new URL('./agent-host.js', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// What crosses into the host process: plain data only. Callbacks stay here and travel as journal entries and HTTP calls.
const PLAIN = ['run', 'cwd', 'projectDirectory', 'token', 'sourcePath', 'mcpUrl', 'model', 'agentEnv', 'javaEnv', 'artifactDirectory', 'uploadsDirectory', 'extraMcp', 'remote'];

export class HostRunner {
  // options: the coordinator's runner options (event, ask, inbox, run…). onState: saves { pid, port, key, journal, offset, asks } on the run.
  constructor(options, { directory, onState, spawner = spawn, node = process.execPath, pollMs = 250, sdkModule = '' }) {
    Object.assign(this, { options, directory, onState, spawner, node, pollMs, sdkModule, state: null, stopped: false, detached: false });
  }
  save(patch) { this.state = { ...this.state, ...patch }; this.onState?.(this.state); }
  async start(prompt) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const runId = this.options.run.id, stamp = Date.now(), base = path.join(this.directory, `${runId}-${stamp}`);
    const key = randomBytes(24).toString('base64url'), journal = `${base}.jsonl`, stateFile = `${base}.state.json`, specFile = `${base}.spec.json`;
    writeFileSync(journal, '', { mode: 0o600 });
    const options = Object.fromEntries(PLAIN.filter(name => this.options[name] !== undefined).map(name => [name, this.options[name]]));
    writeFileSync(specFile, JSON.stringify({ key, journal, stateFile, prompt, options, ...(this.sdkModule ? { sdkModule: this.sdkModule } : {}) }), { mode: 0o600 });
    const child = this.spawner(this.node, [HOST_SCRIPT, specFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(HOST_SCRIPT) });
    child.unref?.();
    this.save({ pid: child.pid, port: 0, key, journal, stateFile, offset: 0, asks: [] });
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
      const finish = (fn, value) => { clearInterval(this.timer); this.timer = null; this.cleanup(); fn(value); };
      const read = () => {
        if (this.detached) { clearInterval(this.timer); return; }
        try {
          // New messages for the agent go over as they come, the way an in-process agent picks them up between steps.
          if (Date.now() - inboxAt > 1000) { inboxAt = Date.now(); const news = this.options.inbox?.(); if (news) void this.post('/inbox', { text: news }).catch(() => {}); }
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

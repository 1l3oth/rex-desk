// What uses this computer's memory, in groups the person understands, and a cleanup that only touches what nobody uses:
// Rex Desk's own idle previews, and helper processes left behind when the app that started them closed.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HELPER = /(@playwright[\\/]mcp|playwright-mcp|notebooklm-mcp|mcp-server|[\\/]mcp[\\/]|npx-cli\.js"? "-y" "@[^"]*mcp|chrome-devtools-mcp)/i;

export async function processList() {
  if (process.platform !== 'win32') {
    const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,rss=,lstart=,comm=,args='], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean).map(line => { const parts = line.trim().split(/\s+/); return { pid: Number(parts[0]), ppid: Number(parts[1]), mb: Math.round(Number(parts[2]) / 1024), started: new Date(parts.slice(3, 8).join(' ')).toISOString(), name: parts[8], cmd: parts.slice(9).join(' ') }; });
  }
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CreationDate,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return [].concat(JSON.parse(stdout || '[]')).map(item => ({ pid: item.ProcessId, ppid: item.ParentProcessId, name: String(item.Name || ''), mb: Math.round((item.WorkingSetSize || 0) / 1048576),
    started: item.CreationDate ? new Date(Number(/\d+/.exec(String(item.CreationDate))?.[0]) || item.CreationDate).toISOString() : '', cmd: String(item.CommandLine || '') }));
}

// Sorts processes into groups. Rex Desk's own are those started under this server.
export function classify(list, { selfPid = process.pid, runs = [] } = {}) {
  const byPid = new Map(list.map(item => [item.pid, item])), alive = new Set(list.map(item => item.pid));
  const under = item => { for (let seen = 0, current = item; current && seen < 40; seen++) { if (current.ppid === selfPid) return true; current = byPid.get(current.ppid); } return false; };
  // Tools an agent started (its MCP servers, its browser) belong to that agent.
  const inAgent = item => { for (let seen = 0, current = byPid.get(item.ppid); current && seen < 40; seen++) { if (/^claude(\.exe)?$/i.test(current.name)) return true; current = byPid.get(current.ppid); } return false; };
  const groups = { agents: [], previews: [], browsers: [], terminals: [], leftovers: [], servers: [] };
  for (const item of list) {
    if (item.pid === selfPid) continue;
    const name = item.name.toLowerCase(), mine = under(item);
    if (mine && (/^claude(\.exe)?$/.test(name) || inAgent(item))) groups.agents.push(item);
    else if (mine && /^(java|node|cmd|python|php|dotnet)(\.exe)?$/.test(name) && !/claude-code|@anthropic-ai/.test(item.cmd)) groups.previews.push(item);
    else if (mine && /^(chrome|msedge|chromium)(\.exe)?$/.test(name)) groups.browsers.push(item);
    else if (/^claude(\.exe)?$/.test(name)) groups.terminals.push(item);
    else if (/^node(\.exe)?$/.test(name) && /(^|[\s"\\/])src[\\/]server\.js"?\s*$/.test(item.cmd)) groups.servers.push(item);
    else if (/^node(\.exe)?$/.test(name) && HELPER.test(item.cmd) && !alive.has(item.ppid)) groups.leftovers.push(item);
  }
  // A helper whose parent is a leftover is a leftover too (npx starts the real server as its child).
  const left = new Set(groups.leftovers.map(item => item.pid));
  for (const item of list) if (!left.has(item.pid) && left.has(item.ppid) && /^node(\.exe)?$/i.test(item.name)) { groups.leftovers.push(item); left.add(item.pid); }
  return groups;
}

export class Monitor {
  constructor(desk) { this.desk = desk; this.cache = null; this.cleaned = []; }
  async snapshot({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < 8000) return this.cache.value;
    const list = await processList(), groups = classify(list, { runs: this.desk.store.list('run') });
    const sum = items => items.reduce((total, item) => total + item.mb, 0);
    const known = new Set(Object.values(groups).flat().map(item => item.pid));
    const others = list.filter(item => !known.has(item.pid) && item.pid !== process.pid);
    const top = Object.entries(others.reduce((totals, item) => { const key = item.name.replace(/\.exe$/i, ''); totals[key] = (totals[key] || 0) + item.mb; return totals; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, mb]) => ({ name, mb }));
    const value = { at: new Date().toISOString(), totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576), deskMb: list.find(item => item.pid === process.pid)?.mb || Math.round(process.memoryUsage().rss / 1048576),
      liveRuns: [...this.desk.live.keys()].map(id => { const run = this.desk.store.get('run', id); return { id, title: run?.title || id, state: run?.state || '' }; }),
      groups: Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, { count: items.length, mb: sum(items), items: items.sort((a, b) => b.mb - a.mb).slice(0, 30).map(({ pid, name, mb, started, cmd }) => ({ pid, name, mb, started, cmd: cmd.slice(0, 220) })) }])),
      others: top, cleaned: this.cleaned.slice(-20) };
    this.cache = { at: Date.now(), value }; return value;
  }
  kill(pid) { try { process.kill(Number(pid)); return true; } catch { return false; } }
  // Ends one process the person picked on the Monitor, only from the groups it shows.
  async end(pid) {
    const value = await this.snapshot({ fresh: true }), allowed = ['previews', 'browsers', 'leftovers', 'servers'].flatMap(key => value.groups[key].items);
    const item = allowed.find(entry => entry.pid === Number(pid));
    if (!item) throw new Error('Rex Desk only ends previews, test browsers and leftover helpers from this list. Stop an agent with its Stop button.');
    if (process.platform === 'win32') await exec('taskkill', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else this.kill(item.pid);
    this.cache = null; return { ended: true, pid: item.pid };
  }
  // The automatic part: idle previews of runs that are not working, and helpers whose app is gone. Never an agent, a terminal or a browser the person uses.
  async clean({ reason = 'auto' } = {}) {
    const desk = this.desk, done = [];
    for (const runId of [...desk.evidence.previews.keys()]) if (!desk.live.has(runId)) { desk.evidence.stopPreview(runId); done.push(`preview of ${desk.store.get('run', runId)?.title || runId}`); }
    for (const runId of [...desk.evidence.sessions.keys()]) if (!desk.live.has(runId)) { await desk.evidence.close(runId).catch(() => {}); done.push(`browser of ${desk.store.get('run', runId)?.title || runId}`); }
    const value = await this.snapshot({ fresh: true });
    for (const item of value.groups.leftovers.items) {
      if (process.platform === 'win32') await exec('taskkill', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else this.kill(item.pid);
      done.push(`leftover helper ${item.name} (${item.mb} MB)`);
    }
    if (done.length) this.cleaned.push({ at: new Date().toISOString(), reason, what: done });
    this.cache = null; return { cleaned: done };
  }
  // Every few minutes: when memory runs low (under 15% free), clean up by itself if the person allowed it.
  async tick() {
    if (this.desk.store.config().autoFree === false || this.busy) return;
    if (os.freemem() / os.totalmem() > 0.15) return;
    this.busy = true; try { await this.clean({ reason: 'memory was low' }); } finally { this.busy = false; }
  }
}

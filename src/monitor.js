// What uses this computer's memory, in groups the person understands: Rex Desk's own agents and previews, Claude Code and tools
// opened outside Rex Desk, and what was left behind. Each item says where it came from, whether it is busy, and how much it holds with its helpers.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HELPER = /(@playwright[\\/]mcp|playwright-mcp|notebooklm-mcp|mcp-server|[\\/]mcp[\\/]|npx-cli\.js"? "-y" "@[^"]*mcp|chrome-devtools-mcp)/i;
const APPS = [[/^orca/i, 'Orca'], [/^windowsterminal/i, 'Windows Terminal'], [/^code(\.exe)?$/i, 'VS Code'], [/^cursor/i, 'Cursor'], [/^rex-desk/i, 'Rex Desk app'], [/^claude(\.exe)?$/i, null], [/^(idea64|webstorm64|pycharm64)/i, 'JetBrains'], [/^conhost/i, null], [/^explorer/i, 'Windows']];

export async function processList() {
  if (process.platform !== 'win32') {
    const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,rss=,time=,lstart=,comm=,args='], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean).map(line => { const parts = line.trim().split(/\s+/); const [h, m, sec] = parts[3].split(':').map(Number);
      return { pid: Number(parts[0]), ppid: Number(parts[1]), mb: Math.round(Number(parts[2]) / 1024), cpu: (h * 3600) + (m * 60) + sec, started: new Date(parts.slice(4, 9).join(' ')).toISOString(), name: parts[9], cmd: parts.slice(10).join(' ') }; });
  }
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CreationDate,CommandLine,KernelModeTime,UserModeTime | ConvertTo-Json -Compress';
  const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return [].concat(JSON.parse(stdout || '[]')).map(item => ({ pid: item.ProcessId, ppid: item.ParentProcessId, name: String(item.Name || ''), mb: Math.round((item.WorkingSetSize || 0) / 1048576),
    cpu: ((Number(item.KernelModeTime) || 0) + (Number(item.UserModeTime) || 0)) / 1e7,
    started: item.CreationDate ? new Date(Number(/\d+/.exec(String(item.CreationDate))?.[0]) || item.CreationDate).toISOString() : '', cmd: String(item.CommandLine || '') }));
}

// Sorts processes into groups. Rex Desk's own are those started under this server; the rest say which app opened them.
export function classify(list, { selfPid = process.pid } = {}) {
  const byPid = new Map(list.map(item => [item.pid, item])), alive = new Set(list.map(item => item.pid));
  const children = new Map(); for (const item of list) { if (!children.has(item.ppid)) children.set(item.ppid, []); children.get(item.ppid).push(item); }
  const ancestors = item => { const chain = []; for (let seen = 0, current = byPid.get(item.ppid); current && seen < 40; seen++) { chain.push(current); current = byPid.get(current.ppid); } return chain; };
  const under = item => ancestors(item).some(parent => parent.pid === selfPid);
  const inAgent = item => ancestors(item).some(parent => /^claude(\.exe)?$/i.test(parent.name));
  const tree = item => { const all = [item]; for (let index = 0; index < all.length; index++) for (const child of children.get(all[index].pid) || []) all.push(child); return all; };
  // Which app opened it. When the app has closed but its terminal lives on, say which kind of terminal.
  const SHELLS = [[/^(sh|bash)(\.exe)?$/i, 'a Git Bash terminal'], [/^(powershell|pwsh)(\.exe)?$/i, 'a PowerShell terminal'], [/^cmd(\.exe)?$/i, 'a Command Prompt']];
  const origin = item => { const chain = ancestors(item); for (const parent of chain) for (const [pattern, label] of APPS) if (pattern.test(parent.name) && label) return label;
    for (const parent of chain) for (const [pattern, label] of SHELLS) if (pattern.test(parent.name)) return `${label} (its window app already closed)`; return 'an app that already closed'; };
  const groups = { agents: [], previews: [], browsers: [], terminals: [], leftovers: [], servers: [] };
  for (const item of list) {
    if (item.pid === selfPid) continue;
    const name = item.name.toLowerCase(), mine = under(item), claude = /^claude(\.exe)?$/.test(name);
    // A Claude Code process counts once, with its tools (MCP servers, browsers) added to it.
    if (claude && !inAgent(item)) {
      const all = tree(item), total = { ...item, mb: all.reduce((sum, entry) => sum + entry.mb, 0), cpu: all.reduce((sum, entry) => sum + (entry.cpu || 0), 0), helpers: all.length - 1 };
      if (mine) groups.agents.push(total); else groups.terminals.push({ ...total, app: origin(item) });
      continue;
    }
    if (inAgent(item)) continue;
    if (mine && /^(java|node|cmd|python|php|dotnet)(\.exe)?$/.test(name)) groups.previews.push(item);
    else if (mine && /^(chrome|msedge|chromium)(\.exe)?$/.test(name)) groups.browsers.push(item);
    else if (/^node(\.exe)?$/.test(name) && /(^|[\s"\\/])src[\\/]server\.js"?\s*$/.test(item.cmd)) groups.servers.push(item);
    else if (/^node(\.exe)?$/.test(name) && HELPER.test(item.cmd) && !alive.has(item.ppid)) groups.leftovers.push(item);
  }
  // A helper whose parent is a leftover is a leftover too (npx starts the real server as its child).
  const left = new Set(groups.leftovers.map(item => item.pid));
  for (const item of list) if (!left.has(item.pid) && left.has(item.ppid) && /^node(\.exe)?$/i.test(item.name)) { groups.leftovers.push(item); left.add(item.pid); }
  return groups;
}

// A short, plain name for a Claude Code session from its command line.
const sessionLabel = cmd => /claude-agent-view/i.test(cmd) ? 'Orca agent view' : /--resume|-r\b/.test(cmd) ? 'Resumed conversation' : /--continue|-c\b/.test(cmd) ? 'Continued conversation' : /--print|-p\b/.test(cmd) ? 'One-off command' : 'Conversation';

export class Monitor {
  constructor(desk) { this.desk = desk; this.cache = null; this.cleaned = []; this.lastCpu = new Map(); }
  async snapshot({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < 8000) return this.cache.value;
    const list = await processList(), groups = classify(list), at = Date.now();
    // Busy or idle: how much processor time it used since the last look.
    const busy = item => { const before = this.lastCpu.get(item.pid); return before ? ((item.cpu - before.cpu) / ((at - before.at) / 1000)) > 0.03 : null; };
    const runs = [...this.desk.live.keys()].map(id => this.desk.store.get('run', id)).filter(Boolean);
    const runOf = item => runs.map(run => ({ run, gap: Math.abs(Date.parse(run.turnStartedAt || run.startedAt || 0) - Date.parse(item.started || 0)) })).sort((a, b) => a.gap - b.gap)[0]?.run;
    const nameOf = run => { const id = run?.roomAgent || run?.specialistId || (run?.main ? 'main' : ''); return id === 'main' ? 'Rex Agent' : id ? this.desk.store.get('specialist', id)?.name || run.title : run?.title || ''; };
    const shape = (item, extra = {}) => ({ pid: item.pid, name: item.name.replace(/\.exe$/i, ''), mb: item.mb, started: item.started, cmd: item.cmd.slice(0, 220), helpers: item.helpers || 0, busy: busy(item), ...extra });
    const value = { at: new Date(at).toISOString(), totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576), deskMb: list.find(item => item.pid === process.pid)?.mb || Math.round(process.memoryUsage().rss / 1048576),
      liveRuns: runs.map(run => ({ id: run.id, title: run.title, agent: nameOf(run), state: run.state })),
      groups: {
        agents: groups.agents.map(item => { const run = runOf(item); return shape(item, { label: nameOf(run) || 'Rex Desk agent', detail: run ? `${run.roomAgent ? 'group chat' : run.taskId ? 'task' : 'personal chat'} · ${run.title}` : 'agent', runId: run?.id || '' }); }),
        previews: groups.previews.map(item => shape(item, { label: /java/i.test(item.name) ? 'Tomcat preview' : 'Preview server', detail: item.cmd.replace(/^"?[^"\s]+"?\s*/, '').slice(0, 90) })),
        browsers: groups.browsers.map(item => shape(item, { label: 'Test browser', detail: '' })),
        leftovers: groups.leftovers.map(item => shape(item, { label: /playwright/i.test(item.cmd) ? 'Playwright browser tool' : /notebooklm/i.test(item.cmd) ? 'NotebookLM tool' : 'Tool server', detail: 'its app already closed' })),
        servers: groups.servers.map(item => shape(item, { label: 'Another server (node src/server.js)', detail: 'another project, or another copy of Rex Desk' })),
        terminals: groups.terminals.map(item => shape(item, { label: `Claude Code · ${sessionLabel(item.cmd)}`, detail: `opened in ${item.app}${item.helpers ? ` · with ${item.helpers} tool${item.helpers === 1 ? '' : 's'}` : ''}`, app: item.app })),
      },
      cleaned: this.cleaned.slice(-20) };
    for (const group of Object.values(value.groups)) group.sort((a, b) => b.mb - a.mb);
    const known = new Set([process.pid, ...Object.values(groups).flat().flatMap(item => [item.pid])]);
    value.others = Object.entries(list.filter(item => !known.has(item.pid)).reduce((totals, item) => { const key = item.name.replace(/\.exe$/i, ''); totals[key] = (totals[key] || 0) + item.mb; return totals; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, mb]) => ({ name, mb }));
    this.lastCpu = new Map(list.map(item => [item.pid, { cpu: item.cpu, at }]));
    this.cache = { at, value }; return value;
  }
  kill(pid) { try { process.kill(Number(pid)); return true; } catch { return false; } }
  async endTree(pid) { if (process.platform === 'win32') await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else this.kill(pid); }
  // Ends one process from the Monitor. A Rex Desk agent is stopped as a run; Claude Code opened outside Rex Desk needs outside: true (the person confirmed it).
  async end(pid, { outside = false } = {}) {
    const value = await this.snapshot({ fresh: true }), find = key => value.groups[key].find(entry => entry.pid === Number(pid));
    const agent = find('agents');
    if (agent) { if (agent.runId) await this.desk.stop(agent.runId); else await this.endTree(agent.pid); this.cache = null; return { ended: true, pid: agent.pid, what: agent.label }; }
    const terminal = find('terminals');
    if (terminal && !outside) throw new Error(`${terminal.label} was opened in ${terminal.app}, outside Rex Desk. Ending it closes that conversation; confirm first.`);
    const item = terminal || ['previews', 'browsers', 'leftovers', 'servers'].map(find).find(Boolean);
    if (!item) throw new Error('That process is not on the Monitor any more, or Rex Desk does not end it.');
    await this.endTree(item.pid); this.cache = null; return { ended: true, pid: item.pid, what: item.label };
  }
  // The automatic part: idle previews of runs that are not working, and helpers whose app is gone. Never an agent, a terminal or a browser the person uses.
  async clean({ reason = 'auto' } = {}) {
    const desk = this.desk, done = [];
    for (const runId of [...desk.evidence.previews.keys()]) if (!desk.live.has(runId)) { desk.evidence.stopPreview(runId); done.push(`preview of ${desk.store.get('run', runId)?.title || runId}`); }
    for (const runId of [...desk.evidence.sessions.keys()]) if (!desk.live.has(runId)) { await desk.evidence.close(runId).catch(() => {}); done.push(`browser of ${desk.store.get('run', runId)?.title || runId}`); }
    const value = await this.snapshot({ fresh: true });
    // Servers are never ended automatically: "node src/server.js" may be another project, or the other Rex Desk (the real
    // app and a development copy run side by side). They stay on the Monitor for the person to end.
    for (const item of value.groups.leftovers) { await this.endTree(item.pid); done.push(`${item.label} (${item.mb} MB)`); }
    if (done.length) this.cleaned.push({ at: new Date().toISOString(), reason, what: done });
    this.cache = null; return { cleaned: done };
  }
  // A short text version for Rex Agent.
  async summary() {
    const value = await this.snapshot({ fresh: true }), line = item => `- pid ${item.pid}: ${item.label} (${item.detail}) ${item.mb} MB${item.busy === true ? ', busy' : item.busy === false ? ', idle' : ''}`;
    const part = (title, items) => items.length ? `${title}:\n${items.map(line).join('\n')}` : '';
    return [`Memory: ${value.freeMb} MB free of ${value.totalMb} MB. Rex Desk itself uses ${value.deskMb} MB.`,
      part('Rex Desk agents working now', value.groups.agents), part('Rex Desk previews and test browsers', [...value.groups.previews, ...value.groups.browsers]),
      part('Left behind (safe to end)', value.groups.leftovers), part('Other servers: another project or another copy of Rex Desk (ask the person before ending)', value.groups.servers), part('Claude Code opened outside Rex Desk (ask the person before ending)', value.groups.terminals),
      value.others.length ? `Biggest other programs: ${value.others.map(item => `${item.name} ${item.mb} MB`).join(', ')}` : ''].filter(Boolean).join('\n\n');
  }
  // Every few minutes: when memory runs low (under 15% free), clean up by itself if the person allowed it.
  async tick() {
    if (this.desk.store.config().autoFree === false || this.busy) return;
    if (os.freemem() / os.totalmem() > 0.15) return;
    this.busy = true; try { await this.clean({ reason: 'memory was low' }); } finally { this.busy = false; }
  }
}

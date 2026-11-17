// The toolbox: Rex Desk stands between agents and the person's other tools. An agent is not handed every MCP tool and
// skill on this computer (hundreds of descriptions, read again on every turn). It gets two tools instead:
//
//   desk_find  search everything by plain words; only what matches comes back, with how to call it
//   desk_run   use one: an MCP tool is called by Rex Desk on the agent's behalf; a skill hands back its instructions
//
// Rex Desk opens the MCP servers itself (the same ones Claude Code would, from ~/.claude.json and the project's .mcp.json),
// reads their tool lists once, and keeps a connection open only while it is used.
import { existsSync, readdirSync, readFileSync, statSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolveCommand } from './processes.js';
import os from 'node:os';
import path from 'node:path';
import { existingMcpConnections } from './runners.js';

const IDLE_MS = 5 * 60000, LIST_MS = 10 * 60000, CALL_MS = 5 * 60000;
const clip = (text, size) => { const value = String(text ?? ''); return value.length > size ? `${value.slice(0, size)}\n… (${value.length - size} more characters)` : value; };
const words = text => String(text || '').toLowerCase().normalize('NFKD').split(/[^a-z0-9ក-៿가-힯]+/).filter(word => word.length > 1);
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'use', 'when', 'into', 'your', 'you', 'can', 'are', 'any', 'all', 'how', 'what', 'tool', 'tools']);

// A skill's name and description, from the front matter of its SKILL.md.
export function readSkill(file) {
  const text = readFileSync(file, 'utf8'), head = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const field = name => head.match(new RegExp(`^${name}:\\s*(.*)$`, 'mi'))?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
  return { name: field('name') || path.basename(path.dirname(file)), description: field('description'), file, folder: path.dirname(file) };
}
// Skill folders: the person's own (~/.claude/skills), the project's (.claude/skills), and the ones that ship with Rex Desk.
export function skillFolders({ home = os.homedir(), project = '', bundled = '' } = {}) {
  return [path.join(home, '.claude', 'skills'), project ? path.join(project, '.claude', 'skills') : '', bundled].filter(folder => folder && existsSync(folder));
}
export function listSkills(folders) {
  const found = new Map();
  for (const folder of folders) for (const entry of readdirSync(folder)) {
    const file = path.join(folder, entry, 'SKILL.md');
    try { if (statSync(path.join(folder, entry)).isDirectory() && existsSync(file)) { const skill = readSkill(file); if (!found.has(skill.name)) found.set(skill.name, skill); } } catch { /* a broken link or unreadable folder is skipped */ }
  }
  return [...found.values()];
}

// Search: each word of the question counts more in a name than in a description; rare words count more than common ones.
export function rank(items, query, limit = 8) {
  const asked = [...new Set(words(query).filter(word => !STOP.has(word)))]; if (!asked.length) return items.slice(0, limit);
  const docs = items.map(item => ({ item, name: words(`${item.server || ''} ${item.name}`), body: words(`${item.description} ${Object.keys(item.inputSchema?.properties || {}).join(' ')}`) }));
  const df = word => docs.filter(doc => doc.name.includes(word) || doc.body.some(token => token.startsWith(word))).length || 1;
  const idf = Object.fromEntries(asked.map(word => [word, Math.log(1 + docs.length / df(word))]));
  return docs.map(doc => ({ item: doc.item, score: asked.reduce((sum, word) => sum + idf[word] * ((doc.name.some(token => token.startsWith(word)) ? 3 : 0) + Math.min(3, doc.body.filter(token => token.startsWith(word)).length)), 0) }))
    .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(entry => entry.item);
}

export class Toolbox {
  constructor({ connect, home = os.homedir(), bundled = '', configDirectory = () => process.env.CLAUDE_CONFIG_DIR, mcpConfig, cli } = {}) {
    this.cli = cli || runClaude;
    this.mcpConfig = mcpConfig || (project => existingMcpConnections(project, this.configDirectory()));
    this.connectWith = connect; this.home = home; this.bundled = bundled; this.configDirectory = configDirectory;
    this.clients = new Map(); this.lists = new Map(); this.failed = new Map();
  }
  servers(project = '') {
    const all = { ...this.mcpConfig(project) };
    delete all.rex_desk;
    return Object.fromEntries(Object.entries(all).filter(([, config]) => config && (config.command || config.url)));
  }
  skills(project = '') { return listSkills(skillFolders({ home: this.home, project, bundled: this.bundled })); }

  // ---------- talking to one MCP server ----------
  async client(name, config) {
    const open = this.clients.get(name);
    if (open && JSON.stringify(open.config) === JSON.stringify(config)) { clearTimeout(open.timer); open.timer = setTimeout(() => void this.close(name), IDLE_MS); open.timer.unref?.(); return open.client; }
    if (open) await this.close(name);
    const client = await (this.connectWith || connectServer)(name, config);
    const timer = setTimeout(() => void this.close(name), IDLE_MS); timer.unref?.();
    this.clients.set(name, { client, config, timer });
    return client;
  }
  async close(name) { const open = this.clients.get(name); if (!open) return; this.clients.delete(name); clearTimeout(open.timer); await open.client.close?.().catch(() => {}); }
  async closeAll() { await Promise.all([...this.clients.keys()].map(name => this.close(name))); }
  async toolsOf(name, config) {
    const known = this.lists.get(name);
    if (known && Date.now() - known.at < LIST_MS && JSON.stringify(known.config) === JSON.stringify(config)) return known.tools;
    try {
      const client = await this.client(name, config), tools = [];
      let cursor;
      do { const page = await client.listTools(cursor ? { cursor } : {}); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor && tools.length < 1000);
      const list = tools.map(tool => ({ server: name, name: tool.name, description: String(tool.description || '').trim(), inputSchema: tool.inputSchema || { type: 'object' }, readOnly: Boolean(tool.annotations?.readOnlyHint) }));
      this.lists.set(name, { at: Date.now(), config, tools: list }); this.failed.delete(name);
      return list;
    } catch (error) { this.failed.set(name, { at: Date.now(), error: error.message }); await this.close(name); return known?.tools || []; }
  }
  async catalog(project = '') {
    const servers = this.servers(project);
    const tools = (await Promise.all(Object.entries(servers).map(([name, config]) => this.toolsOf(name, config)))).flat();
    const skills = this.skills(project).map(skill => ({ kind: 'skill', name: skill.name, description: skill.description, folder: skill.folder, file: skill.file }));
    return { tools: tools.map(tool => ({ kind: 'tool', ...tool })), skills, servers: Object.keys(servers), failed: Object.fromEntries([...this.failed].filter(([name]) => servers[name]).map(([name, value]) => [name, value.error])) };
  }

  // ---------- the person's manager (Settings, Tools and skills) ----------
  get skillsHome() { return path.join(this.home, '.claude', 'skills'); }
  get commandsHome() { return path.join(this.home, '.claude', 'commands'); }
  async overview(project = '') {
    const servers = this.servers(project), user = this.mcpConfigUser ? this.mcpConfigUser() : null;
    const lists = await Promise.all(Object.entries(servers).map(async ([name, config]) => ({ name, config, tools: await this.toolsOf(name, config) })));
    const commands = existsSync(this.commandsHome) ? readdirSync(this.commandsHome).filter(file => file.endsWith('.md')).map(file => { const text = readFileSync(path.join(this.commandsHome, file), 'utf8'); return { name: file.slice(0, -3), description: (text.match(/^description:\s*(.*)$/m)?.[1] || text.replace(/^---[\s\S]*?---/, '').trim().split(/\r?\n/)[0] || '').slice(0, 200) }; }) : [];
    const settings = (() => { try { return JSON.parse(readFileSync(path.join(this.home, '.claude', 'settings.json'), 'utf8')); } catch { return {}; } })();
    const hooks = Object.entries(settings.hooks || {}).flatMap(([event, groups]) => (groups || []).flatMap(group => (group.hooks || []).map(hook => ({ event, matcher: group.matcher || '', command: String(hook.command || hook.url || '').slice(0, 200) }))));
    return {
      servers: lists.map(({ name, config, tools }) => ({ name, how: config.command ? [config.command, ...(config.args || [])].join(' ').slice(0, 200) : config.url, tools: tools.length, error: this.failed.get(name)?.error || '', removable: !user || Boolean(user[name]) })),
      skills: this.skills(project).map(skill => ({ name: skill.name, description: skill.description.slice(0, 240), removable: skill.folder.startsWith(this.skillsHome) })),
      commands, hooks,
    };
  }
  // MCP servers are added and removed with Claude Code's own command, for the person (user scope), so its config stays its own.
  async addServer({ name, command = '', url = '' }) {
    const id = String(name || '').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('A name is letters, numbers, - or _.');
    if (!command.trim() && !/^https?:\/\//.test(url.trim())) throw new Error('Give the command that starts it, or its https address.');
    const args = url.trim() ? ['mcp', 'add', '--scope', 'user', '--transport', 'http', id, url.trim()] : ['mcp', 'add', '--scope', 'user', id, '--', ...splitCommand(command)];
    await this.cli(args); this.lists.delete(id); await this.close(id);
    return { added: id };
  }
  async removeServer(name) { await this.cli(['mcp', 'remove', '--scope', 'user', String(name)]); this.lists.delete(name); await this.close(name); return { removed: name }; }
  // A skill comes from a folder on this computer or a git address; it is copied into the person's skills folder.
  async addSkill(source) {
    const from = String(source || '').trim(); if (!from) throw new Error('Give a folder or a git address.');
    mkdirSync(this.skillsHome, { recursive: true });
    if (/^(https?:\/\/|git@)/.test(from)) {
      const name = path.basename(from).replace(/\.git$/, '').replace(/[^A-Za-z0-9_-]/g, '-'), target = path.join(this.skillsHome, name);
      if (existsSync(target)) throw new Error(`A skill folder named ${name} is already there.`);
      await new Promise((resolve, reject) => execFile('git', ['clone', '--depth', '1', from, target], { windowsHide: true, timeout: 120000 }, error => error ? reject(new Error(`The skill could not be downloaded: ${error.message.split('\n')[0]}`)) : resolve()));
      if (!existsSync(path.join(target, 'SKILL.md'))) { rmSync(target, { recursive: true, force: true }); throw new Error('That repository has no SKILL.md at its top.'); }
      return { added: readSkill(path.join(target, 'SKILL.md')).name };
    }
    if (!existsSync(path.join(from, 'SKILL.md'))) throw new Error('That folder has no SKILL.md.');
    const target = path.join(this.skillsHome, path.basename(path.resolve(from)));
    if (existsSync(target)) throw new Error(`A skill folder named ${path.basename(target)} is already there.`);
    cpSync(from, target, { recursive: true });
    return { added: readSkill(path.join(target, 'SKILL.md')).name };
  }
  removeSkill(name) {
    const skill = this.skills().find(item => item.name === name && item.folder.startsWith(this.skillsHome + path.sep));
    if (!skill) throw new Error('Only skills in your own skills folder can be removed here.');
    rmSync(skill.folder, { recursive: true, force: true }); return { removed: name };
  }
  removeCommand(name) {
    const file = path.join(this.commandsHome, `${String(name).replace(/[^A-Za-z0-9_.-]/g, '')}.md`);
    if (!existsSync(file)) throw new Error('No such command.'); rmSync(file); return { removed: name };
  }

  // ---------- what agents use ----------
  async find(query, { project = '', limit = 8, kind = '' } = {}) {
    const { tools, skills, failed } = await this.catalog(project);
    const items = kind === 'tool' ? tools : kind === 'skill' ? skills : [...tools, ...skills];
    const hits = rank(items, query, Math.min(20, Math.max(1, Number(limit) || 8)));
    return {
      found: hits.map((item, index) => item.kind === 'skill'
        ? { use: `skill:${item.name}`, kind: 'skill', description: clip(item.description, 400) }
        // The full input shape only for the best few: enough to call them, without filling the context with the rest.
        : { use: `${item.server}/${item.name}`, kind: 'tool', description: clip(item.description, 400), ...(index < 4 ? { input: item.inputSchema } : { input: 'Search again with its name to see its input.' }), ...(item.readOnly ? { readOnly: true } : {}) }),
      searched: `${tools.length} tools on ${new Set(tools.map(tool => tool.server)).size} servers and ${skills.length} skills`,
      ...(Object.keys(failed).length ? { unavailable: failed } : {}),
      ...(hits.length ? {} : { note: 'Nothing matched. Try other words, or fewer.' }),
    };
  }
  // Finds what an id names: "server/tool", or "skill:name".
  async resolve(use, project = '') {
    const id = String(use || '').trim();
    if (id.startsWith('skill:')) { const skill = this.skills(project).find(item => item.name === id.slice(6)); if (!skill) throw new Error(`No skill "${id.slice(6)}" here. Search with desk_find.`); return { kind: 'skill', skill }; }
    const cut = id.indexOf('/'), server = cut > 0 ? id.slice(0, cut) : '', name = cut > 0 ? id.slice(cut + 1) : id, servers = this.servers(project);
    if (!servers[server]) throw new Error(`No MCP server "${server}" here. Use the exact "use" value from desk_find.`);
    const tool = (await this.toolsOf(server, servers[server])).find(item => item.name === name);
    if (!tool) throw new Error(`${server} has no tool "${name}". Search with desk_find.`);
    return { kind: 'tool', server, config: servers[server], tool };
  }
  async run(use, input = {}, { project = '' } = {}) {
    const target = await this.resolve(use, project);
    if (target.kind === 'skill') {
      const text = readFileSync(target.skill.file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      return { skill: target.skill.name, folder: target.skill.folder, instructions: clip(text, 40000), note: `Follow these instructions now. Files they mention are in ${target.skill.folder}; read them with your own tools when needed.` };
    }
    const client = await this.client(target.server, target.config);
    const result = await client.callTool({ name: target.tool.name, arguments: input && typeof input === 'object' ? input : {} }, undefined, { timeout: CALL_MS });
    const text = (result.content || []).map(part => part.type === 'text' ? part.text : part.type === 'resource' ? part.resource?.text || `[resource ${part.resource?.uri || ''}]` : `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ''}]`).join('\n');
    return { tool: `${target.server}/${target.tool.name}`, ...(result.isError ? { failed: true } : {}), result: clip(text || (result.structuredContent ? JSON.stringify(result.structuredContent) : ''), 30000) };
  }
}

// Opens one MCP server the way Claude Code would: a local command (stdio), or an address (Streamable HTTP, then SSE).
// Claude Code fills ${NAME} and ${NAME:-default} in a server's command, arguments, environment, address and headers.
const expand = value => typeof value === 'string' ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, key, fallback) => process.env[key] ?? fallback ?? '') : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;
export async function connectServer(name, config) {
  config = expand(config);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'rex-desk-toolbox', version: '1.0.0' });
  if (config.command) {
    const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args || [], env: { ...getDefaultEnvironment(), ...(config.env || {}) }, ...(config.cwd ? { cwd: config.cwd } : {}), stderr: 'ignore' }));
    return client;
  }
  const headers = config.headers || {};
  if (config.type !== 'sse') {
    try { const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'); await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })); return client; }
    catch (error) { if (config.type === 'http') throw error; }
  }
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
  const fallback = new Client({ name: 'rex-desk-toolbox', version: '1.0.0' });
  await fallback.connect(new SSEClientTransport(new URL(config.url), { requestInit: { headers } }));
  return fallback;
}

// "npx -y @scope/server --flag" into its parts, keeping quoted parts together.
export const splitCommand = text => [...String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
function runClaude(args) {
  const claude = resolveCommand('claude');
  return new Promise((resolve, reject) => execFile(claude.command, [...claude.args, ...args], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || stdout || error.message).trim().split('\n')[0])) : resolve(stdout)));
}

// The toolbox: Rex Desk stands between agents and the person's other tools. An agent is not handed every MCP tool and
// skill on this computer (hundreds of descriptions, read again on every turn). It gets two tools instead:
//
//   desk_find  search everything by plain words; only what matches comes back, with how to call it
//   desk_run   use one: an MCP tool is called by Rex Desk on the agent's behalf; a skill hands back its instructions
//
// Rex Desk opens the MCP servers itself (the same ones Claude Code would, from ~/.claude.json and the project's .mcp.json),
// reads their tool lists once, and keeps a connection open only while it is used.
import { existsSync, readdirSync, readFileSync, statSync, cpSync, rmSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveCommand } from './processes.js';
import os from 'node:os';
import path from 'node:path';
import { existingMcpConnections } from './runners.js';

// When a Claude Code hook can run (Claude Code hooks reference): the common ones, offered in Market.
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'Notification'];
const IDLE_MS = 5 * 60000, LIST_MS = 10 * 60000, CALL_MS = 5 * 60000;
const clip = (text, size) => { const value = String(text ?? ''); return value.length > size ? `${value.slice(0, size)}\n… (${value.length - size} more characters)` : value; };
const words = text => String(text || '').toLowerCase().normalize('NFKD').split(/[^a-z0-9ក-៿가-힯]+/).filter(word => word.length > 1);
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'use', 'when', 'into', 'your', 'you', 'can', 'are', 'any', 'all', 'how', 'what', 'tool', 'tools']);

// A skill's name and description, from the front matter of its SKILL.md.
export function readSkill(file) {
  const text = readFileSync(file, 'utf8'), head = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const field = name => {
    const lines = head.split(/\r?\n/), at = lines.findIndex(line => new RegExp(`^${name}:`, 'i').test(line)); if (at < 0) return '';
    const value = lines[at].replace(new RegExp(`^${name}:\\s*`, 'i'), '').trim();
    // A YAML block (description: >- or |, then indented lines): the indented lines are the value, joined into one line.
    if (/^[>|][+-]?$/.test(value)) { const block = []; for (const line of lines.slice(at + 1)) { if (line.trim() && !/^\s/.test(line)) break; block.push(line.trim()); } return block.join(' ').replace(/\s+/g, ' ').trim(); }
    if (/^".*"$/.test(value)) { try { return JSON.parse(value); } catch { /* not JSON-style escapes: strip the quotes */ } }
    return value.replace(/^["']|["']$/g, '');
  };
  return { name: field('name') || path.basename(path.dirname(file)), description: field('description'), file, folder: path.dirname(file) };
}
// Skill folders: the person's own (~/.claude/skills), the project's (.claude/skills), and the ones that ship with Rex Desk.
export function skillFolders({ home = os.homedir(), project = '', bundled = '' } = {}) {
  return [path.join(home, '.claude', 'skills'), project ? path.join(project, '.claude', 'skills') : '', bundled].filter(folder => folder && existsSync(folder));
}
export function listSkills(folders) {
  const found = new Map();
  for (const folder of folders) for (const entry of readdirSync(folder)) {
    if (entry.startsWith('.')) continue;
    const file = path.join(folder, entry, 'SKILL.md');
    let isFolder = false; try { isFolder = statSync(path.join(folder, entry)).isDirectory(); } catch { /* a broken link */ }
    if (!isFolder) continue;
    if (!existsSync(file)) { if (!found.has(entry)) found.set(entry, { name: entry, description: '', file, folder: path.join(folder, entry), error: 'No SKILL.md in this folder.' }); continue; }
    try { const skill = readSkill(file); if (!skill.description) skill.error = 'Its SKILL.md has no description, so agents cannot find it.'; if (!found.has(skill.name)) found.set(skill.name, skill); }
    catch (error) { if (!found.has(entry)) found.set(entry, { name: entry, description: '', file, folder: path.join(folder, entry), error: `Its SKILL.md cannot be read: ${error.message}` }); }
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

const hookPrint = (matcher, hook) => createHash('sha256').update(JSON.stringify([matcher || '', hook])).digest('hex').slice(0, 12);
export class Toolbox {
  constructor({ connect, home = os.homedir(), bundled = '', configDirectory = () => process.env.CLAUDE_CONFIG_DIR, mcpConfig, cli, clone } = {}) {
    this.cli = cli || runClaude; this.clone = clone || gitClone;
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
  // A short list for an agent's instructions (L53): the person's MCP servers and skills by name, one short line each, no input
  // shapes, so the agent knows what it has before it scripts something itself or asks the person for a manual step. Nothing is
  // connected for it: a server's tools are named only when they were already listed.
  inventory(project = '', { skills = 40, width = 70 } = {}) {
    const clip = text => { const line = String(text || '').replace(/\s+/g, ' ').trim(); return line.length > width ? `${line.slice(0, width - 1)}…` : line; };
    let servers = {}; try { servers = this.servers(project); } catch { /* no config */ }
    const serverLines = Object.keys(servers).sort().map(name => { const known = this.lists.get(name)?.tools || []; return `- ${name}${known.length ? `: ${clip(known.slice(0, 4).map(tool => tool.name).join(', '))}${known.length > 4 ? ` and ${known.length - 4} more` : ''}` : ''}`; });
    let all = []; try { all = this.skills(project).filter(skill => !skill.error && skill.name); } catch { /* no skills */ }
    const skillLines = all.slice(0, skills).map(skill => `- ${skill.name}${skill.description ? `: ${clip(skill.description)}` : ''}`);
    // The same items as data, for the agent's profile (the panel shows exactly what the instructions name, L53).
    const items = {
      servers: Object.keys(servers).sort().map(name => ({ name, tools: (this.lists.get(name)?.tools || []).map(tool => tool.name), error: this.failed.get(name)?.error || '' })),
      skills: all.slice(0, skills).map(skill => ({ name: skill.name, description: clip(skill.description) })),
      more: all.slice(skills).map(skill => ({ name: skill.name, description: clip(skill.description) })),
    };
    return { servers: serverLines, skills: skillLines, moreSkills: Math.max(0, all.length - skills), items };
  }

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
    } catch (error) { this.failed.set(name, { at: Date.now(), error: plainError(error.message) }); await this.close(name); return known?.tools || []; }
  }
  async catalog(project = '') {
    const servers = this.servers(project);
    const tools = (await Promise.all(Object.entries(servers).map(([name, config]) => this.toolsOf(name, config)))).flat();
    const skills = this.skills(project).filter(skill => !skill.error || skill.description).map(skill => ({ kind: 'skill', name: skill.name, description: skill.description, folder: skill.folder, file: skill.file }));
    return { tools: tools.map(tool => ({ kind: 'tool', ...tool })), skills, servers: Object.keys(servers), failed: Object.fromEntries([...this.failed].filter(([name]) => servers[name]).map(([name, value]) => [name, value.error])) };
  }

  // ---------- the person's manager (Settings, Tools and skills) ----------
  get skillsHome() { return path.join(this.home, '.claude', 'skills'); }
  get commandsHome() { return path.join(this.home, '.claude', 'commands'); }
  async overview(project = '') {
    const servers = this.servers(project), user = this.mcpConfigUser ? this.mcpConfigUser() : null;
    const lists = await Promise.all(Object.entries(servers).map(async ([name, config]) => ({ name, config, tools: await this.toolsOf(name, config) })));
    const commands = existsSync(this.commandsHome) ? readdirSync(this.commandsHome).filter(file => file.endsWith('.md')).map(file => { const text = readFileSync(path.join(this.commandsHome, file), 'utf8'); return { name: file.slice(0, -3), description: (text.match(/^description:\s*(.*)$/m)?.[1] || text.replace(/^---[\s\S]*?---/, '').trim().split(/\r?\n/)[0] || '').slice(0, 200) }; }) : [];
    const hooks = this.listHooks();
    return {
      computer: this.computer?.() || '',
      servers: lists.map(({ name, config, tools }) => ({ name, how: config.command ? [config.command, ...(config.args || [])].join(' ').slice(0, 200) : config.url, tools: tools.length, error: this.failed.get(name)?.error || '', removable: !user || Boolean(user[name]) })),
      skills: this.skills(project).map(skill => ({ name: skill.name, description: skill.description.slice(0, 240), removable: skill.folder.startsWith(this.skillsHome), ...(skill.error ? { error: skill.error } : {}) })),
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
  // A repository may hold many skills in subfolders (skills/<name>/SKILL.md): each is copied, or only the ones named.
  async addSkill(source, { only = [], subfolder = '' } = {}) {
    const from = String(source || '').trim(); if (!from) throw new Error('Give a folder or a git address.');
    mkdirSync(this.skillsHome, { recursive: true });
    if (/^(https?:\/\/|git@)/.test(from)) {
      const github = from.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/[^/]+\/(.+?))?\/?$/);
      const address = github ? `https://github.com/${github[1]}/${github[2]}.git` : from, inside = subfolder || github?.[3] || '';
      // Downloaded inside the skills folder (same drive), then moved in; the dot keeps it out of the skill list meanwhile.
      const incoming = path.join(this.skillsHome, `.incoming-${process.pid}-${Date.now()}`);
      try {
        await this.clone(address, incoming);
        const root = path.join(incoming, inside); if (!existsSync(root)) throw new Error(`That repository has no folder ${inside}.`);
        return this.copySkills(root, only, path.basename(inside || address).replace(/\.git$/, ''));
      } finally { rmSync(incoming, { recursive: true, force: true }); }
    }
    if (!existsSync(from)) throw new Error('That folder does not exist on this computer.');
    return this.copySkills(from, only, path.basename(path.resolve(from)), { copy: true });
  }
  copySkills(root, only = [], fallbackName = '', { copy = false } = {}) {
    const found = findSkillFiles(root).map(file => ({ ...readSkill(file), top: path.dirname(file) === root }))
      .filter(skill => !only.length || only.some(name => name === skill.name || name === path.basename(skill.folder)));
    if (!found.length) throw new Error(only.length ? `No skill named ${only.join(', ')} there.` : 'No SKILL.md there, so it is not a skill.');
    const added = [], skipped = [];
    for (const skill of found) {
      const folderName = (skill.top ? fallbackName : path.basename(skill.folder)).replace(/[^A-Za-z0-9_.-]/g, '-') || skill.name;
      const target = path.join(this.skillsHome, folderName);
      if (existsSync(target)) { skipped.push(skill.name); continue; }
      let moved = false; if (!copy) try { renameSync(skill.folder, target); moved = true; } catch { /* another drive: copy */ }
      if (!moved) cpSync(skill.folder, target, { recursive: true, filter: file => path.basename(file) !== '.git' });
      added.push(readSkill(path.join(target, 'SKILL.md')).name);
    }
    if (!added.length) throw new Error(`${skipped.length === 1 ? `A skill folder for ${skipped[0]} is` : `Skill folders for ${skipped.join(', ')} are`} already there.`);
    return { added: added.join(', '), skills: added, ...(skipped.length ? { skipped } : {}) };
  }
  // One box for any install line copied from a README: "claude mcp add ...", "npx skills add owner/repo",
  // an mcpServers JSON block, "npx -y @scope/some-mcp", an https address, a GitHub link or a folder.
  // After installing, Rex Desk checks it the way an agent would: the server answers with its tools, and desk_find finds it.
  async install(text) {
    const plan = parseInstall(text);
    if (plan.kind === 'skill') {
      const result = await this.addSkill(plan.source, { only: plan.only });
      const check = [];
      for (const name of result.skills) {
        const skill = this.skills().find(item => item.name === name);
        const found = skill?.description ? (await this.find(`${name} ${skill.description}`, { kind: 'skill', limit: 20 })).found.some(item => item.use === `skill:${name}`) : false;
        check.push({ name, ok: found, ...(found ? {} : { error: 'Installed, but agents cannot find it: its SKILL.md needs a name and a description.' }) });
      }
      return { kind: 'skill', ...result, check };
    }
    for (const args of plan.calls) await this.cli(args);
    const servers = this.servers(), check = [];
    for (const name of plan.names) {
      this.lists.delete(name); this.failed.delete(name); await this.close(name);
      if (!servers[name]) { check.push({ name, ok: false, error: 'Claude Code took it, but Rex Desk does not see it yet. Restart Rex Desk and look again.' }); continue; }
      const tools = await this.toolsOf(name, servers[name]), error = this.failed.get(name)?.error || '';
      check.push({ name, ok: !error && tools.length > 0, tools: tools.length, ...(error ? { error } : tools.length ? {} : { error: 'It started but offers no tools.' }) });
    }
    return { kind: 'server', added: plan.names.join(', '), check };
  }
  removeSkill(name) {
    const skill = this.skills().find(item => item.name === name && item.folder.startsWith(this.skillsHome + path.sep));
    if (!skill) throw new Error('Only skills in your own skills folder can be removed here.');
    rmSync(skill.folder, { recursive: true, force: true }); return { removed: name };
  }
  // A skill that is only a SKILL.md, pasted or uploaded in Market and named there. Front matter is added when the text has none,
  // so agents can find it by its name and first line.
  addSkillFile({ name, text }) {
    const id = String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(id)) throw new Error('A skill name is letters, numbers, - or _.');
    let body = String(text || '').replace(/^﻿/, '').trim(); if (!body) throw new Error('Paste the SKILL.md text or upload the file.');
    if (body.length > 200000) throw new Error('That file is too big for a skill.');
    const folder = path.join(this.skillsHome, id); if (existsSync(folder)) throw new Error(`A skill folder named ${id} is already there.`);
    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(body)) {
      const first = body.split(/\r?\n/).map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) || id;
      // Quoted (a JSON string is valid YAML), so a first line like "Purpose: ..." cannot break the front matter.
      body = `---\nname: ${id}\ndescription: ${JSON.stringify(first.slice(0, 200))}\n---\n\n${body}`;
    }
    mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, 'SKILL.md'), `${body}\n`);
    return { added: readSkill(path.join(folder, 'SKILL.md')).name };
  }
  // A slash command: one Markdown file in the person's commands folder, named by its command.
  addCommand({ name, text }) {
    const id = String(name || '').trim().replace(/^\//, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(id)) throw new Error('A command name is letters, numbers, - or _.');
    const body = String(text || '').trim(); if (!body) throw new Error('Write what the command tells the agent to do.');
    const file = path.join(this.commandsHome, `${id}.md`); if (existsSync(file)) throw new Error(`/${id} is already there.`);
    mkdirSync(this.commandsHome, { recursive: true }); writeFileSync(file, `${body}\n`);
    return { added: `/${id}` };
  }
  // Hooks live in Claude Code's own settings.json. Only the hooks part changes; every other setting stays as it was.
  get settingsFile() { return path.join(this.home, '.claude', 'settings.json'); }
  readSettings() {
    if (!existsSync(this.settingsFile)) return {};
    try { return JSON.parse(readFileSync(this.settingsFile, 'utf8')); } catch { throw new Error('Claude Code settings.json cannot be read, so hooks were not changed.'); }
  }
  addHook({ event, matcher = '', command }) {
    if (!HOOK_EVENTS.includes(event)) throw new Error('Pick when the hook runs.');
    const line = String(command || '').trim(); if (!line) throw new Error('Give the command the hook runs.');
    const settings = this.readSettings(), hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [], match = String(matcher || '').trim();
    const group = groups.find(item => (item.matcher || '') === match);
    if (group) group.hooks = [...(group.hooks || []), { type: 'command', command: line }];
    else groups.push({ ...(match ? { matcher: match } : {}), hooks: [{ type: 'command', command: line }] });
    mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    writeFileSync(this.settingsFile, `${JSON.stringify({ ...settings, hooks: { ...hooks, [event]: groups } }, null, 2)}\n`);
    return { added: event };
  }
  // id: "<event>:<group>:<hook>:<print>", the place listHooks gave it and a print of the hook itself. When the list changed
  // since (another window removed one), the hook is found again by its print, so a neighbour is never removed instead.
  removeHook(id) {
    const [event, group, index, print] = String(id || '').split(':'), settings = this.readSettings(), groups = settings.hooks?.[event];
    const at = (Array.isArray(groups) ? groups : []).flatMap((item, place) => (item?.hooks || []).map((hook, slot) => ({ place, slot, print: hookPrint(item.matcher, hook) })));
    const found = at.find(item => item.place === Number(group) && item.slot === Number(index) && item.print === print) || at.find(item => item.print === print);
    if (!print || !found) throw new Error('That hook changed or is already gone. Open Market again to see the hooks as they are now.');
    const list = groups[found.place].hooks;
    list.splice(found.slot, 1); if (!list.length) groups.splice(found.place, 1); if (!groups.length) delete settings.hooks[event];
    writeFileSync(this.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    return { removed: event };
  }
  listHooks() {
    let settings = {}; try { settings = this.readSettings(); } catch { return []; }
    return Object.entries(settings.hooks || {}).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).flatMap((group, at) => (group.hooks || []).map((hook, index) => ({ id: `${event}:${at}:${index}:${hookPrint(group.matcher, hook)}`, event, matcher: group.matcher || '', command: String(hook.command || hook.url || hook.prompt || '').slice(0, 200) }))));
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
      computer: this.computer?.() || '',
      searched: `${tools.length} tools on ${new Set(tools.map(tool => tool.server)).size} servers and ${skills.length} skills, on this computer${this.computer?.() ? ` (${this.computer()})` : ''} only`,
      ...(Object.keys(failed).length ? { unavailable: failed } : {}),
      ...(hits.length ? {} : { note: 'Nothing matched on this computer. Try other words, or fewer. If it is installed on the person\'s other computer, hand the task to an agent there with desk_team_task.' }),
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

// Every SKILL.md under a folder, a few levels down, skipping .git and node_modules.
export function findSkillFiles(root, depth = 4) {
  if (existsSync(path.join(root, 'SKILL.md'))) return [path.join(root, 'SKILL.md')];
  if (depth <= 0) return [];
  let entries = []; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules').flatMap(entry => findSkillFiles(path.join(root, entry.name), depth - 1));
}
const safeName = text => String(text || '').replace(/^@[^/]+\//, '').replace(/^(mcp-server-|server-|mcp-)/, '').replace(/(-mcp-server|-mcp|-server)$/, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
const RUNNERS = new Set(['npx', 'bunx', 'uvx', 'pnpx']);
const VALUE_FLAGS = new Set(['-s', '--scope', '-t', '--transport', '-e', '--env', '-H', '--header', '--client-id', '--client-secret', '--callback-port']);
// What an install line asks for: { kind: 'skill', source, only } or { kind: 'server', calls (Claude Code arguments), names }.
export function parseInstall(text) {
  const line = String(text || '').trim().replace(/^(\$|>|PS [^>]*>)\s*/, '');
  if (!line) throw new Error('Paste the install command or address.');
  if (line.startsWith('{') || line.startsWith('"')) {
    let data; try { data = JSON.parse(line.startsWith('"') ? `{${line.replace(/,\s*$/, '')}}` : line); } catch { throw new Error('That JSON does not read. Paste the whole block, from { to }.'); }
    const map = data.mcpServers || data.servers || data.mcp?.servers || (data.command || data.url ? null : data);
    if (!map || typeof map !== 'object') throw new Error('Paste the block with its name, like {"mcpServers": {"slack": {...}}}.');
    const entries = Object.entries(map).filter(([name, config]) => config && (config.command || config.url) && /^[A-Za-z0-9_-]{1,40}$/.test(name));
    if (!entries.length) throw new Error('No server in that JSON has a name and a command or url.');
    return { kind: 'server', names: entries.map(([name]) => name), calls: entries.map(([name, config]) => ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(config)]) };
  }
  const parts = splitCommand(line);
  // claude / codex / gemini mcp add ...: run as Claude Code's own command, for the person (user scope).
  if (['claude', 'codex', 'gemini'].includes(parts[0]) && parts[1] === 'mcp' && ['add', 'add-json'].includes(parts[2])) {
    let args = parts.slice(1);
    const cut = args.indexOf('--'), head = cut < 0 ? args : args.slice(0, cut);
    const scopeAt = head.findIndex(part => part === '-s' || part === '--scope'); if (scopeAt >= 0) args.splice(scopeAt, 2);
    const end = args.indexOf('--'), rest = (end < 0 ? args : args.slice(0, end)).slice(2);
    let name = '', at = -1;
    for (let i = 0; i < rest.length; i += 1) { if (VALUE_FLAGS.has(rest[i])) { i += 1; continue; } if (rest[i].startsWith('-')) continue; name = rest[i]; at = i + 2; break; }
    if (!name) throw new Error('That command has no server name.');
    if (parts[0] !== 'claude') {
      const after = args.slice(at + 1).filter(part => part !== '--');
      args = /^https?:\/\//.test(after[0] || '') ? ['mcp', 'add', '--transport', 'http', name, after[0]] : ['mcp', 'add', name, '--', ...after];
    }
    args.splice(2, 0, '--scope', 'user');
    return { kind: 'server', names: [name], calls: [args] };
  }
  // npx skills add owner/repo [--skill name], npx add-skill owner/repo, or the same without npx.
  const tail = RUNNERS.has(parts[0]) ? parts.slice(1).filter(part => part !== '-y' && part !== '--yes') : parts;
  const skillAt = tail[0] === 'skills' && tail[1] === 'add' ? 2 : tail[0] === 'add-skill' ? 1 : -1;
  if (skillAt > 0) {
    const rest = tail.slice(skillAt), only = [];
    let source = '';
    for (let i = 0; i < rest.length; i += 1) { if (rest[i] === '--skill' || rest[i] === '-s') { only.push(...String(rest[i + 1] || '').split(',').filter(Boolean)); i += 1; } else if (!rest[i].startsWith('-') && !source) source = rest[i]; }
    if (!source) throw new Error('Say which skills to add, like owner/repo.');
    const short = !/^(https?:|git@)/.test(source) && !existsSync(source) && source.match(/^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/);
    return { kind: 'skill', source: short ? `https://github.com/${short[1]}/${short[2]}${short[3] ? `/tree/HEAD/${short[3]}` : ''}` : source, only };
  }
  if (parts.length === 1 && /^https:\/\/(github\.com|gitlab\.com)\//.test(line)) return { kind: 'skill', source: line, only: [] };
  if (parts.length === 1 && /^git@/.test(line)) return { kind: 'skill', source: line, only: [] };
  if (parts.length === 1 && /^https?:\/\//.test(line)) {
    const host = new URL(line).hostname.split('.').filter(part => !['www', 'mcp', 'api'].includes(part));
    const name = safeName(host.length > 1 ? host[host.length - 2] : host[0]);
    return { kind: 'server', names: [name], calls: [['mcp', 'add', '--scope', 'user', '--transport', /\/sse\/?$/.test(line) ? 'sse' : 'http', name, line]] };
  }
  if (existsSync(line)) return { kind: 'skill', source: line, only: [] };
  // A command that starts a server: npx -y @scope/some-mcp, uvx mcp-server-time, docker run ..., node server.js.
  if (RUNNERS.has(parts[0]) || ['docker', 'node', 'python', 'python3', 'deno', 'bun'].includes(parts[0])) {
    const pkg = tail.find(part => !part.startsWith('-')) || parts[0];
    const name = safeName(parts[0] === 'docker' ? parts[parts.length - 1].split('/').pop().split(':')[0] : path.basename(pkg).replace(/\.(m?js|py|ts)$/, '').replace(/(.)@[^/]*$/, '$1'));
    return { kind: 'server', names: [name], calls: [['mcp', 'add', '--scope', 'user', name, '--', ...parts]] };
  }
  throw new Error('Rex Desk does not know that install line. Paste a "claude mcp add" or "npx skills add" command, an mcpServers JSON block, an address, or a folder.');
}
function gitClone(address, target) {
  return new Promise((resolve, reject) => execFile('git', ['clone', '--depth', '1', address, target], { windowsHide: true, timeout: 180000 }, error => error ? reject(new Error(`It could not be downloaded: ${String(error.message).split('\n').find(part => /fatal|error:/i.test(part)) || String(error.message).split('\n')[0]}`)) : resolve()));
}

// "npx -y @scope/server --flag" into its parts, keeping quoted parts together.
export const splitCommand = text => [...String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
function runClaude(args) {
  const claude = resolveCommand('claude');
  return new Promise((resolve, reject) => execFile(claude.command, [...claude.args, ...args], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || stdout || error.message).trim().split('\n')[0])) : resolve(stdout)));
}

// What a server's failure means, in a line: its own message when it sent one ("Invalid API key"), not the transport's wrapping.
export function plainError(text) {
  const raw = String(text || '').trim(), inner = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
  const said = (inner || raw).replace(/^(Streamable HTTP error|SSE error|McpError):\s*/i, '').replace(/^Error POSTing to endpoint:\s*/i, '').replace(/^MCP error -?\d+:\s*/i, '');
  if (/ENOENT|not recognized|cannot find|spawn .* ENOENT/i.test(raw)) return 'Its command is not installed on this computer.';
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|getaddrinfo/i.test(raw)) return 'Its address cannot be reached.';
  if (/^unauthorized/i.test(said) || /\b401\b/.test(raw)) return `The server refused the key: ${said.replace(/^unauthorized:?\s*/i, '') || 'not signed in'}.`.replace(/\.\.$/, '.');
  return said.slice(0, 160);
}

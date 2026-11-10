import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existingMcpConnections } from './runners.js';

// What an agent can use, as the person sees it: the skills and slash commands Claude Code loads for it (from its Claude profile and
// its project), and the MCP servers it is given. Only names, descriptions and addresses: never keys, headers or environment values.
const frontmatter = text => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
  const value = key => (new RegExp(`^${key}:\\s*(.+)$`, 'mi').exec(block)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  return { name: value('name'), description: value('description') };
};
function skillsIn(folder, source) {
  const found = [];
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const meta = frontmatter(readFileSync(file, 'utf8').slice(0, 4000));
      found.push({ name: meta.name || entry.name, description: meta.description.slice(0, 240), source });
    }
  } catch {}
  return found;
}
function commandsIn(folder, source) {
  const found = [];
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const text = readFileSync(path.join(folder, entry.name), 'utf8').slice(0, 3000), meta = frontmatter(text);
      const first = text.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0] || '';
      found.push({ name: entry.name.replace(/\.md$/, ''), description: (meta.description || first).replace(/^#+\s*/, '').slice(0, 200), source });
    }
  } catch {}
  return found;
}
const kind = server => server.type || (server.url ? 'http' : server.command ? 'stdio' : 'unknown');
const where = server => { if (server.url) { try { return new URL(server.url).host; } catch { return 'remote'; } } return [server.command, ...(server.args || [])].filter(Boolean).join(' ').replace(/(--?(token|key|secret|password)[= ]\S+)/gi, '$2 …').slice(0, 120); };

export function agentTools({ profile = '', projectPath = '', extra = {} } = {}) {
  const home = profile || path.join(os.homedir(), '.claude');
  const skills = [...skillsIn(path.join(home, 'skills'), 'account'), ...(projectPath ? skillsIn(path.join(projectPath, '.claude', 'skills'), 'project') : [])];
  const commands = [...commandsIn(path.join(home, 'commands'), 'account'), ...(projectPath ? commandsIn(path.join(projectPath, '.claude', 'commands'), 'project') : [])];
  let servers = {};
  try { servers = existingMcpConnections(projectPath, profile || undefined); } catch {}
  const mcp = [
    { name: 'rex_desk', type: 'http', where: 'this computer', source: 'Rex Desk' },
    ...Object.entries(extra).map(([name, server]) => ({ name, type: kind(server), where: where(server), source: 'Rex Desk' })),
    ...Object.entries(servers).filter(([name]) => name !== 'rex_desk' && !extra[name]).map(([name, server]) => ({ name, type: kind(server), where: where(server), source: projectPath && existsSync(path.join(projectPath, '.mcp.json')) && JSON.parse(readFileSync(path.join(projectPath, '.mcp.json'), 'utf8')).mcpServers?.[name] ? 'project' : 'account' })),
  ];
  const unique = list => [...new Map(list.map(item => [item.name.toLowerCase(), item])).values()].sort((left, right) => left.name.localeCompare(right.name));
  return { skills: unique(skills), commands: unique(commands), mcp };
}

// Market: one list of what agents can use on this computer (skills, commands, MCP servers) and the connectors, with a switch
// per agent. Everything is on by default; an agent's record keeps only what is switched off (toolsOff: ["skill:x", "mcp:y"]),
// and that list is filtered out of its start prompt, its / menu, desk_find and desk_run, and (for MCP) its Claude Code session.
import { agentTools } from './agent-tools.js';
import { connections, connector } from './connectors.js';

export const TOOL_KINDS = ['skill', 'command', 'mcp'];
export const toolKey = (kind, name) => `${kind}:${name}`;

// The agent behind a run: a specialist, the room agent it speaks for, or Rex Agent.
export const runAgentId = run => run ? run.specialistId || run.roomAgent || (run.main || run.role === 'coordinator' ? 'main' : '') : '';

export function toolsOff(store, agentId) {
  const record = agentId ? store.get('specialist', agentId) : null;
  return new Set(Array.isArray(record?.toolsOff) ? record.toolsOff.map(String) : []);
}

export function setToolOff(store, agentId, key, off) {
  const record = store.get('specialist', agentId);
  if (!record) throw new Error('No such agent.');
  const [kind, ...rest] = String(key || '').split(':');
  if (!TOOL_KINDS.includes(kind) || !rest.join(':')) throw new Error('Unknown tool.');
  if (key === 'mcp:rex_desk') throw new Error('Rex Desk itself is always on.');
  const list = new Set(Array.isArray(record.toolsOff) ? record.toolsOff : []);
  if (off) list.add(key); else list.delete(key);
  store.put('specialist', agentId, { ...record, toolsOff: [...list].sort() });
  return [...list];
}

// desk_find and desk_run ids: "skill:name" or "server/tool".
export function useIsOff(off, use) {
  const id = String(use || '');
  if (id.startsWith('skill:')) return off.has(id);
  const cut = id.indexOf('/');
  return cut > 0 && off.has(toolKey('mcp', id.slice(0, cut)));
}

// What the inventory for one agent holds once its switched-off tools are taken out.
export function filterInventory(list, off) {
  if (!off.size) return list;
  const name = line => String(line).replace(/^-\s*/, '').split(':')[0].trim();
  const items = list.items || { servers: [], skills: [], more: [] };
  const skillOn = item => !off.has(toolKey('skill', item.name)), serverOn = item => !off.has(toolKey('mcp', item.name));
  const more = (items.more || []).filter(skillOn);
  return {
    ...list,
    servers: (list.servers || []).filter(line => !off.has(toolKey('mcp', name(line)))),
    skills: (list.skills || []).filter(line => !off.has(toolKey('skill', name(line)))),
    moreSkills: more.length,
    items: { ...items, servers: (items.servers || []).filter(serverOn), skills: (items.skills || []).filter(skillOn), more },
  };
}

export function filterSlash(tools, off) {
  if (!tools || !off.size) return tools;
  return { ...tools, skills: (tools.skills || []).filter(item => !off.has(toolKey('skill', item.name))), commands: (tools.commands || []).filter(item => !off.has(toolKey('command', item.name))) };
}

// The Market page's data: every item once, and each agent with what it has switched off.
export function marketList(desk) {
  // First one wins: the toolbox reads folded YAML descriptions (description: >-) that the plain reader leaves as '>-'.
  const unique = list => { const seen = new Map(); for (const item of list) { const id = `${item.kind}:${item.name}`; if (!seen.has(id)) seen.set(id, item); } return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)); };
  const text = value => { const line = String(value || '').replace(/\s+/g, ' ').trim(); if (/^[>|][-+]?$/.test(line)) return ''; if (line.length <= 200) return line; const cut = line.slice(0, 200), space = cut.lastIndexOf(' '); return `${(space > 120 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`; };
  let skills = [], servers = {}, account = { skills: [], commands: [] };
  try { skills = desk.toolbox.skills('').filter(item => item.name); } catch { /* no skills folder */ }
  try { servers = desk.toolbox.servers(''); } catch { /* no MCP config */ }
  try { account = agentTools({ profile: desk.agents.selected('claude') || '' }); } catch { /* no profile */ }
  const items = unique([
    ...skills.map(item => ({ kind: 'skill', name: item.name, description: text(item.description), ...(item.error ? { error: item.error } : {}) })),
    ...account.skills.map(item => ({ kind: 'skill', name: item.name, description: text(item.description) })),
    ...account.commands.map(item => ({ kind: 'command', name: item.name, description: text(item.description) })),
    ...Object.keys(servers).map(name => { const tools = desk.toolbox.lists?.get(name)?.tools || [], error = desk.toolbox.failed?.get(name)?.error || ''; return { kind: 'mcp', name, description: error ? '' : tools.length ? tools.slice(0, 4).map(tool => tool.name).join(', ') : '', tools: tools.length, ...(error ? { error } : {}) }; }),
    { kind: 'mcp', name: 'rex_desk', description: 'Rex Desk itself: chats, tasks, Needs you, evidence', fixed: true },
  ]);
  const connectorsList = connections(desk.store.config()).map(item => ({ kind: 'connector', name: item.name || connector(item.connectorId)?.name || item.connectorId, description: connector(item.connectorId)?.name || item.connectorId, enabled: item.enabled, id: item.id }));
  const main = desk.store.get('specialist', 'main');
  const agents = [...(main ? [{ id: 'main', name: main.name || 'Rex Agent' }] : []), ...desk.specialists.list().map(agent => ({ id: agent.id, name: agent.name }))]
    .map(agent => ({ ...agent, off: [...toolsOff(desk.store, agent.id)] }));
  return { items: [...items, ...connectorsList], agents, computer: desk.toolbox.computer?.() || '' };
}

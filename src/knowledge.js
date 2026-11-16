import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// The knowledge space as one graph: the person in the middle, what the agents learned about them, every agent with its
// project and lessons, and the notes of the person's second brain (an Obsidian-style vault) with the links between them.
// Nodes: { id, kind, label, text?, group?, file? }. Links: [fromId, toId].
const MAX_NOTES = 1500, MAX_BYTES = 80000, KEEP_MS = 5 * 60000, SKIP = new Set(['node_modules', 'attachments', 'output', 'raw', 'Clippings']);
const GROUPS = { 'How to explain things to me': 'explain', Personality: 'personality', Likes: 'likes', Dislikes: 'dislikes', 'How they work': 'works', 'About them': 'about' };
const clean = text => String(text || '').replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, '').trim();
const short = (text, size = 46) => { const one = clean(text).replace(/\s+/g, ' '); return one.length > size ? `${one.slice(0, size - 1)}…` : one; };

// Markdown files of the vault, the compiled wiki first, so a large vault shows its best pages when the limit is reached.
function vaultFiles(root) {
  const found = [], walk = (folder, depth) => {
    if (found.length >= MAX_NOTES || depth > 8) return;
    let entries; try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_NOTES) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(full, depth + 1); }
      else if (entry.name.toLowerCase().endsWith('.md')) found.push(full);
    }
  };
  walk(path.join(root, 'wiki'), 0);
  walk(root, 0);
  return [...new Set(found)];
}

const cache = new Map();
// Reading a large vault takes a while the first time (hundreds of files), so it is done many files at a time without
// holding the server up, kept for a few minutes, and one read is shared by everyone who asks meanwhile.
export function vaultGraph(root, { now = Date.now() } = {}) {
  if (!root) return Promise.resolve({ nodes: [], links: [], total: 0 });
  const cached = cache.get(root); if (cached && now - cached.at < KEEP_MS) return cached.graph;
  const graph = readVault(root).catch(() => ({ nodes: [], links: [], total: 0 }));
  cache.set(root, { at: now, graph });
  return graph;
}
async function readVault(root) {
  let total = 0; try { if (!statSync(root).isDirectory()) return { nodes: [], links: [], total: 0 }; } catch { return { nodes: [], links: [], total: 0 }; }
  const files = vaultFiles(root), byName = new Map(), nodes = [], links = [];
  for (const file of files) {
    const name = path.basename(file, path.extname(file)), key = name.toLowerCase();
    if (byName.has(key)) continue;
    const relative = path.relative(root, file).replaceAll('\\', '/');
    const node = { id: `note:${relative.toLowerCase()}`, kind: 'note', label: name, group: relative.split('/').slice(0, -1).join('/') || 'vault', file };
    byName.set(key, node); nodes.push(node);
  }
  total = nodes.length;
  const texts = new Array(nodes.length);
  for (let from = 0; from < nodes.length; from += 96) await Promise.all(nodes.slice(from, from + 96).map((node, offset) => readFile(node.file, 'utf8').then(text => { texts[from + offset] = text.slice(0, MAX_BYTES); }, () => {})));
  for (const [position, node] of nodes.entries()) {
    const text = texts[position]; if (text === undefined) continue;
    node.text = text.replace(/^---[\s\S]*?---\s*/, '').replace(/[#>*`_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 320);
    const seen = new Set();
    for (const match of text.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
      const target = byName.get(path.basename(match[1].trim()).toLowerCase());
      if (target && target !== node && !seen.has(target.id)) { seen.add(target.id); links.push([node.id, target.id]); }
    }
  }
  return { nodes, links, total };
}

export async function knowledgeGraph({ profile = {}, name = 'You', agents = [], brainPath = '' } = {}) {
  const nodes = [{ id: 'you', kind: 'you', label: name || 'You' }], links = [], ids = new Set(['you']);
  const add = (node, parent) => { if (!ids.has(node.id)) { ids.add(node.id); nodes.push(node); } if (parent) links.push([parent, node.id]); return node.id; };
  // What the agents learned about the person, one branch for each kind.
  for (const section of profile.sections || []) {
    const group = GROUPS[section.title] || section.title.toLowerCase().replace(/\W+/g, '-');
    const hub = add({ id: `kind:${group}`, kind: 'branch', label: section.title === 'About them' ? 'About you' : section.title === 'How they work' ? 'How you work' : section.title, group }, 'you');
    section.items.forEach((item, index) => add({ id: `fact:${group}:${index}`, kind: 'fact', label: short(item), text: clean(item), group }, hub));
  }
  // Projects, and the agents that look after them with what each one learned.
  for (const project of profile.projects || []) add({ id: `project:${project.slug}`, kind: 'project', label: project.name || project.slug, text: project.purpose || '', group: 'project' }, 'you');
  for (const agent of agents) {
    const id = add({ id: `agent:${agent.id}`, kind: 'agent', label: agent.name, text: agent.purpose || '', group: 'agent', agent: agent.id }, 'you');
    if (agent.project) { add({ id: `project:${agent.project}`, kind: 'project', label: agent.project, group: 'project' }); links.push([id, `project:${agent.project}`]); }
    (agent.lessons || []).forEach((lesson, index) => add({ id: `lesson:${agent.id}:${index}`, kind: 'lesson', label: short(lesson), text: clean(lesson), group: 'lesson' }, id));
  }
  // The second brain: its notes and the links between them. Project pages hang off their project.
  const vault = await vaultGraph(brainPath);
  if (vault.nodes.length) {
    const linked = new Set(vault.links.flat());
    const hub = add({ id: 'brain', kind: 'brain', label: 'Second brain', text: `${vault.total} notes in ${brainPath}`, group: 'brain' }, 'you');
    for (const note of vault.nodes) {
      add({ id: note.id, kind: 'note', label: note.label, text: note.text, group: note.group, file: note.file });
      const project = /(?:^|\/)project\/([^/]+)/.exec(note.group)?.[1];
      if (project && ids.has(`project:${project}`)) links.push([`project:${project}`, note.id]);
      else if (!linked.has(note.id) || /^wiki$/.test(note.group) && /^index$/i.test(note.label)) links.push([hub, note.id]);
    }
    links.push(...vault.links);
  }
  return { nodes: nodes.map(({ file, ...node }) => ({ ...node, ...(file ? { file } : {}) })), links, brain: brainPath ? { path: brainPath, notes: vault.total, limit: MAX_NOTES } : null };
}

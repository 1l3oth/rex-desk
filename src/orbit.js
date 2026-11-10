// Orbit (orbitkh.vercel.app) as a task source. One Orbit project key (dgm_...) opens one goal; each connection is one goal.
// Every call is POST /api/mcp with { tool, input } and the key in X-Project-Api-Key. See orbit/.claude/skills/orbit-api.md.
export const ORBIT_URL = 'https://orbitkh.vercel.app';
const STATUS_NAMES = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done' };
// The run's phase becomes the Orbit status, the same way a Rex Desk task moves.
const PHASE_STATUS = { working: 'in_progress', review: 'in_review', done: 'done' };
// "active" is work that is on: not parked in the backlog and not done. "unfinished" adds the backlog.
const WANTED = { active: ['todo', 'in_progress', 'in_review', 'blocked'], unfinished: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'], all: null };

export async function orbitCall(source, key, tool, input = {}, fetcher = fetch) {
  const url = new URL('/api/mcp', source.baseUrl || ORBIT_URL);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project-Api-Key': key }, body: JSON.stringify({ tool, input }), signal: AbortSignal.timeout(30000), redirect: 'error' });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 600 * 2 ** attempt)); continue; }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      if (response.status === 401 || response.status === 403) throw new Error(`Orbit refused the key for ${source.name}. Make a new project key in Orbit (Goal → Settings → API) and paste it here.`);
      throw new Error(`Orbit ${tool} failed: ${data.error || `HTTP ${response.status}`}`);
    }
    return data.result ?? data;
  }
  throw new Error('Orbit did not answer. Try the sync again in a minute.');
}

export function orbitTask(source, item) {
  const status = item.status || (item.completed ? 'done' : 'todo');
  return { id: `orbit:${source.id}:${item.id}`, sourceId: source.id, source: 'orbit', sourceName: source.name, externalId: String(item.id), taskNumber: String(item.id).slice(0, 6),
    projectId: String(item.goal_id || ''), projectName: source.goalName || source.name, title: String(item.title || '').slice(0, 300), description: String(item.description || '').slice(0, 20000),
    status, statusName: STATUS_NAMES[status] || status, tags: Array.isArray(item.tags) ? item.tags : [], dueDate: String(item.end_date || '').slice(0, 10), startDate: String(item.start_date || '').slice(0, 10),
    checklist: Array.isArray(item.checklist) ? item.checklist.map(entry => ({ text: String(entry.text || ''), done: Boolean(entry.done) })) : [],
    assignees: [item.assigned_agent_role, item.claimed_by].filter(Boolean).map(String), createdAt: item.created_at || '', updatedAt: item.updated_at || '',
    url: `${new URL(source.baseUrl || ORBIT_URL).origin}/`, active: status !== 'done', detailLoaded: true, raw: { orbit: { id: item.id, goal_id: item.goal_id, parent_id: item.parent_id || null } } };
}

// Reads every task of the goal, a page at a time, and keeps the ones the connection's status filter wants.
export async function orbitTasks(source, key, fetcher = fetch) {
  const wanted = WANTED[source.statusFilter || 'active'] ?? WANTED.active, tasks = [];
  for (let offset = 0; offset < 5000; offset += 200) {
    const page = await orbitCall(source, key, 'tasks.list', { limit: 200, offset, ...(wanted ? { status: wanted.join(',') } : {}) }, fetcher);
    const rows = Array.isArray(page.tasks) ? page.tasks : [];
    for (const row of rows) { const task = orbitTask(source, row); if (!wanted || wanted.includes(task.status)) tasks.push(task); }
    if (rows.length < 200) break;
  }
  return tasks;
}

export async function orbitStatus(source, key, task, phase, fetcher = fetch) {
  const status = PHASE_STATUS[phase]; if (!status) return { skipped: true, reason: `No Orbit status for ${phase}.` };
  await orbitCall(source, key, 'tasks.update', { task_id: task.externalId, status }, fetcher);
  return { status };
}
export const orbitComment = (source, key, task, body, fetcher = fetch) => orbitCall(source, key, 'tasks.comment', { task_id: task.externalId, body: String(body).slice(0, 4000) }, fetcher);

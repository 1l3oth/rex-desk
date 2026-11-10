import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
function orbitServer() {
  const calls = [], tasks = [
    { id: 'aaaaaaaa-1111', goal_id: 'g1', title: 'Write the launch post', description: 'Draft and review', status: 'todo', completed: false, tags: ['writing'], end_date: '2026-11-20T10:00:00Z', checklist: [{ text: 'Draft', done: true }] },
    { id: 'bbbbbbbb-2222', goal_id: 'g1', title: 'Fix the login bug', status: 'in_progress', completed: false, tags: [] },
  ];
  const fetcher = async (url, options) => {
    const request = JSON.parse(options.body); calls.push({ url: String(url), key: options.headers['X-Project-Api-Key'], ...request });
    if (options.headers['X-Project-Api-Key'] !== 'dgm_valid_key_123') return new Response(JSON.stringify({ ok: false, error: 'Invalid key' }), { status: 401 });
    if (request.tool === 'tasks.list') { const wanted = request.input.status?.split(','); return Response.json({ ok: true, result: { tasks: tasks.filter(task => !wanted || wanted.includes(task.status)).slice(request.input.offset || 0, (request.input.offset || 0) + (request.input.limit || 200)) } }); }
    if (request.tool === 'tasks.update') { const task = tasks.find(item => item.id === request.input.task_id); Object.assign(task, { status: request.input.status }); return Response.json({ ok: true, result: { task } }); }
    return Response.json({ ok: false, error: 'unknown tool' }, { status: 400 });
  };
  return { calls, tasks, fetcher };
}

test('an Orbit goal syncs its open tasks, and a run moves the Orbit status', async () => {
  const orbit = orbitServer(), store = new Store(temporary('orbit'));
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), fetcher: orbit.fetcher });
  const source = store.saveConnection({ name: 'Launch goal', type: 'orbit', baseUrl: 'https://orbitkh.vercel.app', apiKey: 'dgm_valid_key_123', projectIds: [], statusFilter: 'active' });
  assert.equal(source.type, 'orbit');
  const result = await desk.sources.syncSource(source);
  assert.equal(result.count, 2);
  const task = store.get('task', `orbit:${source.id}:aaaaaaaa-1111`);
  assert.equal(task.title, 'Write the launch post'); assert.equal(task.statusName, 'To do'); assert.equal(task.dueDate, '2026-11-20'); assert.equal(task.sourceName, 'Launch goal');
  assert.equal(orbit.calls[0].url, 'https://orbitkh.vercel.app/api/mcp'); assert.equal(orbit.calls[0].input.status, 'todo,in_progress,in_review,blocked');
  assert.deepEqual(await desk.sources.updateStatus(task, 'working'), { status: 'in_progress' });
  assert.equal(orbit.tasks[0].status, 'in_progress');
  await assert.rejects(desk.sources.testOrbit({ ...source }, 'dgm_wrong_key_123'), /refused the key/);
});

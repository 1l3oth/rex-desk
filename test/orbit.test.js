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

test('signing in to the Orbit account gives every agent an Orbit MCP server', async () => {
  const { orbitDeviceStart, orbitDevicePoll } = await import('../src/orbit.js');
  let polls = 0;
  const fetcher = async (url, options) => {
    if (String(url).endsWith('/api/device-login-start')) return Response.json({ device_code: 'dev-code', user_code: 'ABCD2345', verification_uri: 'https://orbitkh.vercel.app/connect', verification_uri_complete: 'https://orbitkh.vercel.app/connect?code=ABCD2345', expires_in: 600, interval: 3 });
    assert.equal(options.headers.Authorization, 'Bearer dev-code');
    return Response.json(++polls < 2 ? { status: 'pending' } : { status: 'confirmed', token: 'dgm_pat_secret' });
  };
  const login = await orbitDeviceStart('https://orbitkh.vercel.app', fetcher);
  assert.equal(login.userCode, 'ABCD2345'); assert.match(login.url, /connect\?code=ABCD2345/);
  assert.deepEqual(await orbitDevicePoll(login.deviceCode, 'https://orbitkh.vercel.app', fetcher), { pending: true });
  assert.deepEqual(await orbitDevicePoll(login.deviceCode, 'https://orbitkh.vercel.app', fetcher), { token: 'dgm_pat_secret' });
  await assert.rejects(orbitDevicePoll('x', 'https://orbitkh.vercel.app', async () => Response.json({ status: 'expired' })), /expired/);
  const store = new Store(temporary('orbit-acct')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  assert.deepEqual(desk.orbitAccountMcp(), {});
  store.put('secret', 'orbit-account', store.encrypt(JSON.stringify({ token: 'dgm_pat_secret', base: 'https://orbitkh.vercel.app', at: new Date().toISOString() })));
  assert.deepEqual(desk.orbitAccountMcp(), { orbit: { type: 'http', url: 'https://orbitkh.vercel.app/mcp', headers: { Authorization: 'Bearer dgm_pat_secret' } } });
});

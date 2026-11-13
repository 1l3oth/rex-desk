import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
// A desk with one project folder on "this computer" and a cloud that only records what it is asked to write.
function setup() {
  const store = new Store(temporary('rules')), project = temporary('rules-project');
  const desk = new Desk(store, { root: temporary('rules-root'), memoryDirectory: temporary('rules-memory'), runnerFactory: () => ({ start: async () => ({ status: 'completed' }), interrupt: async () => {}, close() {} }) });
  desk.closed = true;
  desk.memory.list = () => [{ slug: 'shop', name: 'shop', path: project }];
  const writes = [], cloud = store.cloud;
  cloud.connection = { url: 'libsql://test.invalid' };
  cloud.enqueue = (sql, args) => writes.push({ sql, args });
  cloud.schedule = () => {};
  const agent = (id, extra = {}) => store.put('specialist', id, { id, kind: 'specialist', name: `${id}_bot`, slug: id, projectSlug: 'shop', projectPath: project, provider: 'claude', ...extra });
  return { store, desk, writes, agent, project, close: async () => { await desk.shutdown(); store.close(); } };
}
const wrote = (writes, kind) => writes.filter(item => /^INSERT INTO rex_records/.test(item.sql) && item.args[1] === kind).length;

test('a project kept out of the cloud: its chats skip the cloud, the card stays shared, what was there is deleted, and it syncs back', async () => {
  const { store, desk, writes, agent, close } = setup();
  try {
    agent('a1'); agent('other', { projectSlug: 'web' });
    store.put('run', 'r1', { id: 'r1', specialistId: 'a1', role: 'specialist', state: 'finished' });
    store.event('r1', 'human-message', { text: 'hello' }, true);
    store.put('chatcopy', 'r1', { id: 'r1', agentId: 'a1', run: {}, events: [] });
    assert.ok(wrote(writes, 'run') && wrote(writes, 'chatcopy'), 'before the rule, the chat goes to the cloud');

    writes.length = 0;
    assert.deepEqual(desk.projectRules.set('shop', { noCloud: true }), { slug: 'shop', pinned: false, noCloud: true, agents: 1 });
    assert.equal(store.get('specialist', 'a1').noCloud, true); assert.equal(Boolean(store.get('specialist', 'other').noCloud), false);
    assert.ok(wrote(writes, 'specialist'), 'the agent card is still shared, so every computer knows the rule');
    const deleted = writes.filter(item => /^DELETE FROM/.test(item.sql)).map(item => `${item.sql.split(' WHERE')[0]}:${item.args.slice(-2).join('/')}`);
    assert.ok(deleted.includes('DELETE FROM rex_records:run/r1') && deleted.includes('DELETE FROM rex_shared:chatcopy/r1'), deleted.join('\n'));
    assert.ok(writes.some(item => /^DELETE FROM rex_events/.test(item.sql) && item.args[1] === 'r1'));
    assert.ok(!writes.some(item => /^INSERT INTO rex_shared/.test(item.sql) && item.args[0] === 'chatcopy'), 'no "deleted" mark is shared: the other computers keep their copy');

    writes.length = 0;
    store.put('run', 'r1', { ...store.get('run', 'r1'), state: 'running' }); store.event('r1', 'agent-text', { text: 'secret' }, true);
    store.put('chatcopy', 'r1', { id: 'r1', agentId: 'a1', run: {}, events: [{ text: 'secret' }] });
    store.put('peercmd', 'c1', { id: 'c1', agentId: 'a1', action: 'say', input: { text: 'secret' } });
    store.put('interaction', 'i1', { id: 'i1', runId: 'r1', state: 'pending' });
    assert.deepEqual(writes.filter(item => /^INSERT/.test(item.sql)), [], 'nothing of the project is written to the cloud');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS total FROM changes WHERE kind='chatcopy' AND id='r1'").get().total, 1, 'it still travels straight between the computers');
    store.put('run', 'r2', { id: 'r2', specialistId: 'other', state: 'finished' });
    assert.equal(wrote(writes, 'run'), 1, 'another project is not affected');

    const fresh = store.put('specialist', 'a2', { id: 'a2', kind: 'specialist', name: 'a2_bot', slug: 'a2', projectSlug: 'shop' });
    assert.equal(desk.projectRules.inherit(fresh).noCloud, true, 'a new agent takes the rule of its project');

    writes.length = 0;
    desk.projectRules.set('shop', { noCloud: false });
    assert.ok(wrote(writes, 'run') && wrote(writes, 'chatcopy') && wrote(writes, 'peercmd') && wrote(writes, 'interaction'), 'turned off: everything goes back up');
    assert.equal(writes.filter(item => /^INSERT INTO rex_events/.test(item.sql) && item.args[2] === 'r1').length, 2);
  } finally { await close(); }
});

test('a project that runs only on its computer: its agent never starts elsewhere and cannot be moved', async () => {
  const { store, desk, agent, close } = setup();
  try {
    agent('far', { node: 'work-pc', pinned: true, runId: 'r1' });
    store.put('run', 'r1', { id: 'r1', specialistId: 'far', role: 'specialist', state: 'finished', provider: 'claude' });
    await assert.rejects(desk.specialistTurn('far', { prompt: 'hi' }), /runs only on/);
    await assert.rejects(desk.resume('r1', { prompt: 'hi' }), /runs only on/);
    await assert.rejects(desk.projectRules.move('far'), /set to run only on/);
    assert.equal(store.get('specialist', 'far').node, 'work-pc');
    assert.deepEqual(desk.projectRules.list().map(item => [item.slug, item.pinned, item.here]), [['shop', true, true]]);
  } finally { await close(); }
});

test('an agent whose project folder is not on this computer does not start here', async () => {
  const { desk, agent, close } = setup();
  try {
    agent('lost', { projectPath: path.join(os.tmpdir(), 'rex-desk-no-such-folder-xyz') });
    await assert.rejects(desk.specialistTurn('lost', { prompt: 'hi' }), /is not on this computer/);
  } finally { await close(); }
});

test('moving an agent here brings its chat, points it at the folder here, and starts a fresh session from a handoff', async () => {
  const { store, desk, agent, project, close } = setup();
  try {
    agent('mv', { node: 'work-pc', projectPath: path.join(os.tmpdir(), 'rex-desk-folder-on-the-other-computer'), runId: 'r9' });
    store.remote = true;
    store.put('chatcopy', 'r9', { id: 'r9', agentId: 'mv', node: 'work-pc', _v: '1', run: { id: 'r9', specialistId: 'mv', role: 'specialist', state: 'running', provider: 'claude', sessionId: '7c3a8d71-d78d-409a-9a84-91fb162c1be3', cwd: 'elsewhere', projectPath: 'elsewhere' },
      events: [{ sequence: 4, kind: 'human-message', visible: true, text: 'fix the cart', createdAt: '2026-11-13T01:00:00.000Z' }, { sequence: 5, kind: 'agent-text', visible: true, text: 'Cart fixed.', createdAt: '2026-11-13T01:01:00.000Z' }] });
    store.remote = false;
    desk.peers.statusOf = () => ({ state: 'idle', label: 'Idle' });
    const result = await desk.projectRules.move('mv');
    assert.equal(result.moved, true); assert.equal(result.messages, 2); assert.equal(result.folder, project);
    const moved = store.get('specialist', 'mv'), run = store.get('run', 'r9');
    assert.equal(moved.node, store.nodeId); assert.equal(moved.projectPath, project); assert.equal(moved.movedFrom, 'work-pc');
    assert.equal(run.projectPath, project); assert.equal(run.sessionId, undefined, 'the session of the other computer is not reopened'); assert.ok(run.handoffFile);
    const texts = store.events('r9', { visible: true }).map(event => [event.kind, event.text, event.createdAt]);
    assert.deepEqual(texts.slice(0, 2), [['human-message', 'fix the cart', '2026-11-13T01:00:00.000Z'], ['agent-text', 'Cart fixed.', '2026-11-13T01:01:00.000Z']]);
    await assert.rejects(desk.projectRules.move('mv'), /already works on this computer/);
    desk.memory.list = () => [];
    agent('gone', { node: 'work-pc' });
    await assert.rejects(desk.projectRules.move('gone'), /is not on this computer/);
  } finally { await close(); }
});

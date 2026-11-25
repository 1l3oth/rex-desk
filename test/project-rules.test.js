import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { ProjectRules } from '../src/project-rules.js';

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
  const { store, desk, agent, project, close } = setup();
  try {
    agent('lost', { projectSlug: 'gone', projectPath: path.join(os.tmpdir(), 'rex-desk-no-such-folder-xyz') });
    await assert.rejects(desk.specialistTurn('lost', { prompt: 'hi' }), /is not on this computer/);
    // The same project in another folder here is used instead.
    agent('found', { projectPath: path.join(os.tmpdir(), 'rex-desk-shop-on-the-other-computer') });
    assert.equal(desk.specialists.folder(store.get('specialist', 'found')), project);
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

test('a move saves the work first and shows each step; when saving fails the agent stays where it was (L57)', async () => {
  const { store, desk, agent, close } = setup();
  try {
    desk.peers.statusOf = () => ({ state: 'idle', label: 'Idle' }); desk.peers.online = () => true;
    // Saved and committed on the other computer, unpacked here into the agent's own worktree.
    agent('mv3', { node: 'work-pc', runId: 'r11' });
    store.put('run', 'r11', { id: 'r11', role: 'specialist', specialistId: 'mv3', state: 'finished', createdAt: new Date().toISOString() });
    const asked = [];
    desk.handover.request = async (moving, input) => { asked.push([moving.id, input.to]); return { branch: 'rex/mv3/cart', head: 'abc123', committed: 'abc123', bundle: 'YnVuZGxl' }; };
    desk.handover.pickUp = async input => ({ worktree: input.directory, branch: input.branch, head: input.head });
    const result = await desk.projectRules.move('mv3');
    assert.equal(asked.length, 1, 'the other computer was asked to save the work first');
    assert.equal(result.branch, 'rex/mv3/cart'); assert.equal(store.get('specialist', 'mv3').node, store.nodeId);
    assert.equal(store.get('run', 'r11').worktree, result.worktree); assert.equal(store.get('run', 'r11').branch, 'rex/mv3/cart');
    const steps = store.events('r11', { visible: true, limit: 50 }).filter(event => event.kind === 'move-step').map(event => event.step);
    assert.deepEqual(steps, ['saved', 'committed', 'moved', 'picked-up']);
    const record = store.get('specialist', 'mv3').move;
    assert.equal(record.state, 'done'); assert.equal(record.to, store.nodeId); assert.equal(record.from, 'work-pc');
    for (const key of ['saved', 'committed', 'moved', 'pickedUp']) assert.ok(record.steps[key], `${key} has its time`);
    // The same steps live on the agent record (shared with the other computer) for the profile's chips.
    const done = store.get('specialist', 'mv3').move;
    assert.equal(done.state, 'done'); assert.deepEqual(done.steps, { saved: true, committed: true, moved: true, pickedUp: true }); assert.equal(done.error, '');
    assert.ok(Date.parse(done.at) > 0, 'at is the time of the last change');
    // Saving fails there: nothing moves, and the chat says why in one line.
    agent('mv4', { node: 'work-pc', runId: 'r12' });
    store.put('run', 'r12', { id: 'r12', role: 'specialist', specialistId: 'mv4', state: 'finished', createdAt: new Date().toISOString() });
    desk.handover.request = async () => { throw new Error("Desky's worktree is on master, where work is never committed, so its unsaved changes stayed."); };
    await assert.rejects(desk.projectRules.move('mv4'), /never committed/);
    assert.equal(store.get('specialist', 'mv4').node, 'work-pc', 'it stayed where it was');
    const failed = store.events('r12', { visible: true, limit: 50 }).filter(event => event.kind === 'move-step');
    assert.equal(store.get('specialist', 'mv4').move.state, 'failed'); assert.match(store.get('specialist', 'mv4').move.error, /never committed/);
    assert.equal(failed.length, 1); assert.equal(failed[0].step, 'failed'); assert.match(failed[0].text, /stayed on .*never committed/);
    const broken = store.get('specialist', 'mv4').move;
    assert.equal(broken.state, 'failed'); assert.match(broken.error, /never committed/); assert.deepEqual(broken.steps, { saved: false, committed: false, moved: false, pickedUp: false });
  } finally { await close(); }
});

test('Send to an agent that moves here saves the message and answers at once, then starts it once when the move is done (L114)', async () => {
  const { store, desk, agent, close } = setup();
  try {
    desk.peers.statusOf = () => ({ state: 'idle', label: 'Idle' }); desk.peers.online = () => true;
    agent('mv5', { node: 'work-pc', runId: 'r13' });
    store.put('run', 'r13', { id: 'r13', role: 'specialist', specialistId: 'mv5', provider: 'claude', state: 'finished', createdAt: new Date().toISOString() });
    // The other computer takes its time to save the work (a slow relay): the send does not wait for it.
    let release; const gate = new Promise(resolve => { release = resolve; }), asked = [];
    desk.handover.request = async moving => { asked.push(moving.id); await gate; return { nothing: true }; };
    const sent = () => store.events('r13', { visible: true, limit: 50 }).filter(event => event.kind === 'human-message').map(event => event.text);
    const first = desk.projectRules.sendHere('r13', store.get('specialist', 'mv5'), 'resume', { prompt: 'fix the cart' });
    assert.deepEqual(first, { queued: true, moving: true });
    assert.deepEqual(sent(), ['fix the cart'], 'the message is saved before the move');
    assert.equal(store.get('specialist', 'mv5').move.state, 'running', 'the chat shows the agent moving here');
    assert.equal(desk.projectRules.movingHere('mv5'), true);
    // A second message while it is on its way waits behind the same move: one move, nothing lost.
    desk.projectRules.sendHere('r13', store.get('specialist', 'mv5'), 'say', { text: 'and the checkout' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(asked.length, 1, 'the agent moves once');
    assert.equal(store.get('run', 'r13').state, 'finished', 'nothing starts before the move is done');
    release(); await desk.projectRules.moving.get('mv5');
    const run = store.get('run', 'r13');
    assert.equal(store.get('specialist', 'mv5').node, store.nodeId);
    assert.equal(run.state, 'queued', 'the agent starts once it is here'); assert.equal(run.followUp, 'fix the cart');
    assert.deepEqual(run.queued, ['and the checkout'], 'the second message waits for the next turn, not a second start');
    assert.deepEqual(sent(), ['fix the cart', 'and the checkout'], 'each message shows once');
    assert.equal(desk.projectRules.movingHere('mv5'), false);
    // The move fails: the message still goes to the agent on the other computer, shown here once.
    agent('mv6', { node: 'work-pc', runId: 'r14' });
    store.put('run', 'r14', { id: 'r14', role: 'specialist', specialistId: 'mv6', provider: 'claude', state: 'finished', createdAt: new Date().toISOString() });
    desk.handover.request = async () => { throw new Error('The relay did not answer.'); };
    desk.projectRules.sendHere('r14', store.get('specialist', 'mv6'), 'resume', { prompt: 'still there?' });
    await desk.projectRules.moving.get('mv6');
    assert.equal(store.get('specialist', 'mv6').node, 'work-pc');
    assert.ok(store.list('peercmd').some(command => command.runId === 'r14' && command.target === 'work-pc' && command.action === 'chat-say'), 'passed on to the other computer');
    assert.deepEqual(store.events('r14', { visible: true, limit: 50 }).filter(event => event.kind === 'human-message').map(event => event.text), ['still there?']);
  } finally { await close(); }
});

test('a chat whose conversation is on another computer shows the message first, starts after the fresh start, and a message sent meanwhile waits for the next turn (L114)', async () => {
  const { store, desk, close } = setup();
  try {
    store.put('run', 'r15', { id: 'r15', role: 'specialist', provider: 'claude', state: 'finished', sessionId: '0f3a8d71-d78d-409a-9a84-91fb162c1be4', createdAt: new Date().toISOString() });
    // The real path runs only without a test runner (the session would be looked for on disk): it is cleared for this test.
    const runnerFactory = desk.runnerFactory; desk.runnerFactory = null;
    let release; const gate = new Promise(resolve => { release = resolve; });
    const facts = desk.handoffFacts.bind(desk); desk.handoffFacts = async (...args) => { await gate; return facts(...args); };
    const shown = () => store.events('r15', { visible: true, limit: 50 }).filter(event => event.kind === 'human-message').map(event => event.text);
    await desk.resume('r15', { prompt: 'fix the cart' });
    assert.deepEqual(shown(), ['fix the cart'], 'the message shows before the fresh start is done');
    assert.equal(store.get('run', 'r15').state, 'finished', 'the agent has not started yet');
    await desk.say('r15', 'and the checkout');
    assert.deepEqual(store.get('run', 'r15').queued, ['and the checkout']);
    release();
    for (let tries = 0; tries < 100 && store.get('run', 'r15').state !== 'queued'; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    const run = store.get('run', 'r15');
    assert.equal(run.state, 'queued', 'the agent starts once the fresh start is done'); assert.equal(run.sessionId, undefined); assert.ok(run.handoffFile);
    assert.equal(run.followUp, 'fix the cart'); assert.deepEqual(run.queued, ['and the checkout'], 'the second message waits for the next turn');
    assert.deepEqual(shown(), ['fix the cart', 'and the checkout'], 'each message shows once');
    assert.equal(desk.starting.has('r15'), false);
    desk.runnerFactory = runnerFactory;
  } finally { await close(); }
});

test('a message kept while an agent moves here is passed on once after Rex Desk closes and opens again mid-move (L114 review)', async () => {
  const { store, desk, agent, close } = setup();
  try {
    desk.peers.statusOf = () => ({ state: 'idle', label: 'Idle' }); desk.peers.online = () => true;
    agent('mv7', { node: 'work-pc', runId: 'r16' });
    store.put('run', 'r16', { id: 'r16', role: 'specialist', specialistId: 'mv7', provider: 'claude', state: 'finished', createdAt: new Date().toISOString() });
    // The move never ends in this "session": Rex Desk closes while it waits.
    desk.handover.request = () => new Promise(() => {});
    desk.projectRules.sendHere('r16', store.get('specialist', 'mv7'), 'resume', { prompt: 'fix the cart' });
    desk.projectRules.sendHere('r16', store.get('specialist', 'mv7'), 'say', { text: 'and the checkout' });
    assert.equal(store.list('movesend').length, 2, 'both messages are kept on this computer');
    // Opened again: a fresh ProjectRules (nothing in memory) finds them, moves the agent once and passes each on once.
    let asked = 0; desk.handover.request = async () => { asked++; return { nothing: true }; };
    const reopened = new ProjectRules(desk); desk.projectRules = reopened;
    reopened.recoverSends(); reopened.recoverSends();
    await reopened.moving.get('mv7');
    const run = store.get('run', 'r16');
    assert.equal(asked, 1, 'one move'); assert.equal(store.get('specialist', 'mv7').node, store.nodeId);
    assert.equal(run.state, 'queued'); assert.equal(run.followUp, 'fix the cart'); assert.deepEqual(run.queued, ['and the checkout']);
    assert.equal(store.list('movesend').length, 0, 'nothing left to pass on again');
    assert.deepEqual(store.events('r16', { visible: true, limit: 50 }).filter(event => event.kind === 'human-message').map(event => event.text), ['fix the cart', 'and the checkout'], 'each shows once');
  } finally { await close(); }
});

test('a failed fresh start keeps the first message in front of the ones that waited, and the next send takes them all (L114 review)', async () => {
  const { store, desk, close } = setup();
  try {
    store.put('run', 'r17', { id: 'r17', role: 'specialist', provider: 'claude', state: 'finished', sessionId: '1f3a8d71-d78d-409a-9a84-91fb162c1be5', createdAt: new Date().toISOString() });
    const runnerFactory = desk.runnerFactory; desk.runnerFactory = null;
    let release; const gate = new Promise(resolve => { release = resolve; });
    const fresh = desk.freshStart.bind(desk); desk.freshStart = async () => { await gate; throw new Error('The handoff could not be written.'); };
    await desk.resume('r17', { prompt: 'fix the cart' });
    await desk.say('r17', 'and the checkout');
    release();
    for (let tries = 0; tries < 100 && !store.get('run', 'r17').freshRetry; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    let run = store.get('run', 'r17');
    assert.deepEqual(run.queued, ['fix the cart', 'and the checkout'], 'the first message is kept, in front');
    assert.equal(run.freshRetry, true); assert.notEqual(run.state, 'queued', 'nothing waits on a runner that never comes');
    assert.match(store.events('r17', { visible: true, limit: 50 }).filter(event => event.kind === 'error').at(-1).message, /kept: send again or press Resume/);
    // Retried with the next send: the fresh start works now and the whole batch goes in one turn.
    desk.freshStart = fresh;
    await desk.resume('r17', { prompt: 'and the total' });
    for (let tries = 0; tries < 100 && store.get('run', 'r17').state !== 'queued'; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    run = store.get('run', 'r17');
    assert.equal(run.state, 'queued'); assert.equal(run.followUp, 'fix the cart\nand the checkout\nand the total'); assert.deepEqual(run.queued, []); assert.equal(run.freshRetry, undefined);
    assert.deepEqual(store.events('r17', { visible: true, limit: 50 }).filter(event => event.kind === 'human-message').map(event => event.text), ['fix the cart', 'and the checkout', 'and the total'], 'each shows once');
    desk.runnerFactory = runnerFactory;
  } finally { await close(); }
});

test('Rex Desk that closes during a fresh start keeps the whole batch saved, and the retry after it starts the agent with it once (L114 review 2)', async () => {
  const { store, desk, close } = setup();
  try {
    store.put('run', 'r18', { id: 'r18', role: 'specialist', provider: 'claude', state: 'finished', sessionId: '2f3a8d71-d78d-409a-9a84-91fb162c1be6', queued: ['fix the cart', 'and the checkout'], freshRetry: true, createdAt: new Date().toISOString() });
    const runnerFactory = desk.runnerFactory; desk.runnerFactory = null;
    // The retry's fresh start never ends in this "session": Rex Desk closes while it runs.
    const fresh = desk.freshStart.bind(desk); desk.freshStart = () => new Promise(() => {});
    await desk.resume('r18', { prompt: 'and the total' });
    let run = store.get('run', 'r18');
    assert.deepEqual(run.freshBatch, ['fix the cart\nand the checkout\nand the total'], 'the batch is saved on the run while the fresh start runs');
    assert.deepEqual(run.queued, []); assert.equal(run.freshRetry, undefined);
    // Opened again: nothing in memory says a fresh start runs, and the saved batch goes back in front, ready for a retry.
    desk.starting = new Set();
    desk.keepFreshBatches(); desk.keepFreshBatches();
    run = store.get('run', 'r18');
    assert.deepEqual(run.queued, ['fix the cart\nand the checkout\nand the total'], 'kept once'); assert.equal(run.freshRetry, true); assert.equal(run.freshBatch, undefined);
    assert.match(store.events('r18', { visible: true, limit: 50 }).filter(event => event.kind === 'error').at(-1).message, /closed while this agent was starting fresh/);
    desk.freshStart = fresh;
    await desk.resume('r18', { prompt: '' });
    for (let tries = 0; tries < 100 && store.get('run', 'r18').state !== 'queued'; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    run = store.get('run', 'r18');
    assert.equal(run.state, 'queued'); assert.equal(run.followUp, 'fix the cart\nand the checkout\nand the total', 'the whole batch, once');
    assert.deepEqual(run.queued, []); assert.equal(run.freshBatch, undefined, 'cleared with the write that queued the agent');
    desk.runnerFactory = runnerFactory;
  } finally { await close(); }
});

test('a kept message stays saved until the agent takes it in: a failed or cut-off delivery is passed on after a restart exactly once (L114 review 2)', async () => {
  const { store, desk, agent, close } = setup();
  try {
    desk.peers.statusOf = () => ({ state: 'idle', label: 'Idle' }); desk.peers.online = () => true;
    // 1. Delivery throws: the message is not lost.
    agent('mv8', { node: store.nodeId, runId: 'r19' });
    store.put('run', 'r19', { id: 'r19', role: 'specialist', specialistId: 'mv8', provider: 'claude', state: 'finished', createdAt: new Date().toISOString() });
    const resume = desk.resume.bind(desk); let calls = 0;
    desk.resume = async () => { throw new Error('The agent could not start.'); };
    desk.projectRules.sendHere('r19', store.get('specialist', 'mv8'), 'resume', { prompt: 'fix the cart' });
    await desk.projectRules.moving?.get('mv8');
    assert.equal(store.list('movesend').length, 1, 'kept after the failed delivery'); assert.equal(store.list('movesend')[0].tries, 1);
    assert.match(store.events('r19', { visible: true, limit: 50 }).filter(event => event.kind === 'error').at(-1).message, /kept and is passed on when Rex Desk opens again/);
    desk.resume = async (...args) => { calls++; return resume(...args); };
    let reopened = new ProjectRules(desk); desk.projectRules = reopened;
    reopened.recoverSends(); await reopened.moving.get('mv8');
    let run = store.get('run', 'r19');
    assert.equal(calls, 1); assert.equal(run.state, 'queued'); assert.equal(run.followUp, 'fix the cart'); assert.equal(store.list('movesend').length, 0);
    // 2. Rex Desk closes after the run took the message in but before the record was dropped: no second delivery.
    store.put('run', 'r19', { ...store.get('run', 'r19'), state: 'finished', followUp: '' });
    const id = 'kept-2';
    store.put('movesend', id, { id, runId: 'r19', agentId: 'mv8', action: 'resume', input: { prompt: 'and the checkout' }, text: 'and the checkout', shown: null, at: new Date().toISOString(), order: 1 });
    await reopened.deliver('r19', 'mv8', 'resume', { prompt: 'and the checkout' }, 'and the checkout', null, id);
    assert.ok(store.get('run', 'r19').sentIds.includes(id), 'the run notes the message id in the write that takes it in');
    reopened = new ProjectRules(desk); desk.projectRules = reopened;
    reopened.recoverSends(); await reopened.moving.get('mv8');
    run = store.get('run', 'r19');
    assert.equal(calls, 2, 'delivered once, not again after the restart'); assert.equal(run.followUp, 'and the checkout'); assert.deepEqual(run.queued || [], []);
    assert.equal(store.list('movesend').length, 0, 'the record is dropped');
    desk.resume = resume;
    // 3. The other computer: the command keeps the message id, so a second try writes nothing new.
    store.put('run', 'r20', { id: 'r20', role: 'specialist', provider: 'claude', state: 'finished', createdAt: new Date().toISOString() });
    const copy = { id: 'r20', node: 'work-pc', agentId: 'mv8' };
    await desk.peers.chatAction(copy, 'say', { text: 'and the total' }, { sendId: 'kept-3' });
    await desk.peers.chatAction(copy, 'say', { text: 'and the total' }, { sendId: 'kept-3' });
    assert.equal(store.list('peercmd').filter(item => item.runId === 'r20').length, 1);
  } finally { await close(); }
});

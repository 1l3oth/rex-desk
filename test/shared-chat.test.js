import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

// One account on two computers, with a pretend cloud that holds rex_chat and the shared records (docs/design/cross-device-chat.md).
const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-chat-${label}-`));
const waitFor = async predicate => { for (let attempt = 0; attempt < 240; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };

function account() {
  const hub = { chat: new Map(), shared: new Map() };
  const make = name => {
    const projects = temporary(`${name}-projects`), directory = path.join(projects, 'shop');
    mkdirSync(path.join(directory, '.git'), { recursive: true }); writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop' }));
    const turns = [];
    const desk = new Desk(new Store(temporary(name)), { root: temporary(`${name}-root`), memoryDirectory: temporary(`${name}-memory`),
      runnerFactory: options => ({ start: async prompt => { turns.push(prompt); options.event('session', { sessionId: '7c3a8d71-d78d-409a-9a84-91fb162c1be3' }); options.event('agent-text', { text: `${name} answers` }); }, interrupt: async () => {} }) });
    const store = desk.store;
    store.cloud = {
      ready: true, enabled: true, record(kind, id, value) { if (value?._v) hub.shared.set(`${kind}/${id}`, { kind, id, value, v: value._v }); }, remove() {}, event() {}, schedule() {}, shared() {}, enqueue() {},
      chatEvent(row) {
        if (!store.sharesEvent(row)) return;
        hub.chat.set(row.uid, { uid: row.uid, run_id: row.run_id, kind: row.kind, visible: row.visible, value: row.value, created_at: row.created_at, v: store.stamp(), node: store.nodeId, deleted: 0 });
        store.db.prepare('UPDATE events SET pushed=1 WHERE uid=?').run(row.uid);
      },
      removeChatEvent(uid, runId) { if (store.syncedChat(runId)) hub.chat.set(uid, { uid, run_id: runId, v: store.stamp(), node: store.nodeId, deleted: 1 }); },
      async pullChat(since) { return [...hub.chat.values()].filter(row => row.v > since && row.node !== store.nodeId).sort((a, b) => a.v.localeCompare(b.v)); },
    };
    desk.memory.scan({ roots: [projects] });
    return { desk, store, turns };
  };
  const a = make('a'), b = make('b');
  // Shared records arrive as the cloud brings them (what Peers.pullTurso does).
  const records = (to, from) => to.desk.peers.applyAll([...hub.shared.values()].filter(row => row.value.node !== to.store.nodeId || row.value._v.endsWith(from.store.nodeId)).map(row => ({ kind: row.kind, id: row.id, value: row.value })));
  return { hub, a, b, records };
}
const texts = (store, runId) => store.events(runId, { visible: true }).filter(event => ['human-message', 'agent-text'].includes(event.kind)).map(event => event.text);
const idle = (desk, runId) => waitFor(() => !['starting', 'running', 'queued'].includes(desk.store.get('run', runId)?.state));

test('an agent has one chat on both computers: the whole history arrives, and a message from the other computer shows once', async () => {
  const { a, b, records } = account();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  await a.desk.specialistTurn(dara.id, { prompt: 'Fix the refund bug' });
  const runId = a.store.get('specialist', dara.id).runId;
  await idle(a.desk, runId);
  // Written before chats were shared: more than the old 160-message copy.
  a.store.importEvents(runId, Array.from({ length: 200 }, (_, index) => ({ kind: 'agent-text', text: `step ${index}`, visible: true })));
  a.desk.peers.pushChats();
  records(b, a);
  await b.desk.peers.pullChats();
  assert.deepEqual(texts(b.store, runId), texts(a.store, runId), 'the home laptop has the whole chat');
  assert.equal(texts(b.store, runId).length, 202);

  a.desk.peers.copyChat(runId); records(b, a);
  const copy = b.desk.peers.chatCopy(runId);
  await b.desk.peers.chatAction(copy, 'say', { text: 'Is it done?' });
  assert.equal(texts(b.store, runId).at(-1), 'Is it done?', 'it shows at once where it was typed');
  records(a, b);
  await a.desk.peers.pullChats();
  await waitFor(() => a.store.list('peercmd').every(item => item.done));
  await idle(a.desk, runId);
  assert.equal(texts(a.store, runId).filter(text => text === 'Is it done?').length, 1, 'once on the computer running the agent');
  assert.ok(a.turns.some(turn => /Is it done\?/.test(turn)), `and the agent got it ${JSON.stringify(a.store.list('peercmd').map(item => item.error))} ${JSON.stringify(a.turns.map(turn => String(turn).slice(-60)))}`);
  await b.desk.peers.pullChats();
  assert.deepEqual(texts(b.store, runId), texts(a.store, runId), 'both computers show the same chat');
  assert.equal(texts(b.store, runId).at(-1), 'a answers');
});

test('a message that waited more than a day is not acted on late, and the chat says why', async () => {
  const { a, b, records } = account();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  await a.desk.specialistTurn(dara.id, { prompt: 'Hello' });
  const runId = a.store.get('specialist', dara.id).runId;
  await idle(a.desk, runId);
  a.desk.peers.copyChat(runId); records(b, a);
  await b.desk.peers.chatAction(b.desk.peers.chatCopy(runId), 'say', { text: 'old news' });
  const command = b.store.list('peercmd')[0];
  b.store.put('peercmd', command.id, { ...command, at: new Date(Date.now() - 2 * 86400000).toISOString() });
  records(a, b);
  await waitFor(() => a.store.list('peercmd').every(item => item.done));
  assert.match(a.store.list('peercmd')[0].error, /more than a day/);
  assert.equal(a.turns.length, 1, 'the agent did not get it');
});

test('a chat that went two ways on two computers is flagged, and the person picks the one every computer keeps', async () => {
  for (const keep of ['a', 'b']) {
    const { a, b, records } = account();
    const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
    await a.desk.specialistTurn(dara.id, { prompt: 'Work laptop story' });
    const runId = a.store.get('specialist', dara.id).runId;
    await idle(a.desk, runId);
    records(b, a);
    // Before chats were shared, the home laptop wrote its own messages in the same chat.
    b.store.event(runId, 'human-message', { text: 'Home laptop story' }, true);
    b.store.db.prepare('UPDATE events SET pushed=NULL').run();
    assert.deepEqual(b.desk.chatSplits.detect(), [dara.id], 'the home laptop opens the question');
    await assert.rejects(() => b.desk.peers.chatAction({ id: runId, node: a.store.nodeId, agentId: dara.id }, 'say', { text: 'hi' }), /Pick the one to keep/);
    records(a, b); a.desk.chatSplits.detect();
    a.desk.peers.pushChats();
    assert.equal(a.store.get('chatsplit', dara.id).sides.length, 2, 'the work laptop adds its side');
    records(b, a);
    const split = b.store.get('chatsplit', dara.id);
    assert.ok(split.sides.every(side => side.messages >= 1 && side.lastText));
    const picker = keep === 'a' ? a : b, other = keep === 'a' ? b : a;
    picker.desk.chatSplits.pick(dara.id, picker.store.nodeId);
    records(other, picker); other.desk.chatSplits.settleAll();
    picker.desk.peers.pushChats(); other.desk.peers.pushChats();
    await a.desk.peers.pullChats(); await b.desk.peers.pullChats();
    const kept = keep === 'a' ? 'Work laptop story' : 'Home laptop story', dropped = keep === 'a' ? 'Home laptop story' : 'Work laptop story';
    for (const computer of [a, b]) {
      assert.ok(texts(computer.store, runId).includes(kept), `${keep}: the kept chat is on every computer`);
      assert.ok(!texts(computer.store, runId).includes(dropped), `${keep}: the other one is put away ${computer === a ? 'A' : 'B'} ${JSON.stringify(texts(computer.store, runId))} ${JSON.stringify(computer.store.get('chatsplit', dara.id))}`);
    }
    assert.equal(a.store.get('specialist', dara.id).node, picker.store.nodeId, 'the agent runs where the kept chat is');
  }
});

test('Rex Agent chats stay on their computer', async () => {
  const { a } = account();
  let backedUp = 0; a.store.cloud.event = () => { backedUp++; };
  a.store.put('run', 'main-run', { id: 'main-run', role: 'coordinator', main: true });
  a.store.event('main-run', 'human-message', { text: 'private' }, true);
  assert.equal(a.store.syncedChat('main-run'), false);
  assert.equal(a.store.mainRun('main-run'), true);
});

test('only what the chat shows goes to the cloud: hidden records stay home and never hold up the visible ones', async () => {
  const { hub, a } = account();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  await a.desk.specialistTurn(dara.id, { prompt: 'Fix the refund bug' });
  const runId = a.store.get('specialist', dara.id).runId;
  await idle(a.desk, runId);
  a.store.importEvents(runId, [
    ...Array.from({ length: 2500 }, (_, index) => ({ kind: 'agent-operation', text: `raw ${index}`, visible: false })),
    { kind: 'agent-text', text: 'after the hidden ones', visible: true },
  ]);
  a.desk.peers.pushChats();
  const sent = [...hub.chat.values()].filter(row => row.run_id === runId);
  assert.ok(sent.every(row => Number(row.visible)), 'No hidden record is uploaded');
  assert.ok(sent.some(row => JSON.parse(row.value).text === 'after the hidden ones'), 'A visible message behind 2,500 hidden ones still goes up');
});

test('a message the computer already has under another id is not added twice', () => {
  const { a } = account();
  const row = { run_id: 'run-x', kind: 'agent-text', visible: 1, value: JSON.stringify({ text: 'same words' }), created_at: '2026-11-19T09:00:00.000Z', deleted: 0 };
  assert.equal(a.store.applyChatEvents([{ ...row, uid: 'one.1' }]), 1);
  assert.equal(a.store.applyChatEvents([{ ...row, uid: 'two.1' }]), 0);
  assert.equal(a.store.db.prepare('SELECT count(*) n FROM events WHERE run_id=?').get('run-x').n, 1);
});

test('a reply whose id another message already uses still arrives, and arriving twice adds it once', () => {
  const { a } = account();
  const mine = { run_id: 'run-old', kind: 'human-message', visible: 1, value: JSON.stringify({ text: 'hi' }), created_at: '2026-11-19T09:35:03.000Z', deleted: 0, uid: 'shared.1000041697' };
  const reply = { run_id: 'run-new', kind: 'agent-text', visible: 1, value: JSON.stringify({ text: 'Hi Rex' }), created_at: '2026-11-19T10:08:50.000Z', deleted: 0, uid: 'shared.1000041697' };
  a.store.applyChatEvents([mine]);
  assert.equal(a.store.applyChatEvents([reply]), 1, 'The reply is not dropped');
  assert.equal(a.store.applyChatEvents([reply]), 0, 'Reading it again adds nothing');
  assert.deepEqual(a.store.db.prepare("SELECT run_id FROM events WHERE uid LIKE 'shared.1000041697%' ORDER BY run_id").all().map(row => row.run_id), ['run-new', 'run-old']);
});

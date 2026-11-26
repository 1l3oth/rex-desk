import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { tailscaleAddresses } from '../src/peers.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const SESSION = '7c3a8d71-d78d-409a-9a84-91fb162c1be3';
const waitFor = async predicate => { for (let attempt = 0; attempt < 240; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };

// Two computers of one person, talking through a fake network that can be switched off.
function computers() {
  const network = { a: null, b: null, off: new Set() };
  const transport = from => async (peer, method, route, data) => {
    const name = new URL(peer.url).hostname, desk = network[name];
    if (!desk || network.off.has(name)) throw new Error('fetch failed');
    if (!from.peers.checkKey(desk.peers.key())) throw new Error('That computer has a different key.');
    const url = new URL(route, 'http://x');
    if (url.pathname === '/api/peer/hello') return desk.peers.self;
    if (url.pathname === '/api/peer/pull') return desk.peers.serve({ since: Number(url.searchParams.get('since')), filesSince: Number(url.searchParams.get('files')) });
    const say = url.pathname.match(/^\/api\/specialists\/([^/]+)\/say$/);
    if (say) return desk.specialistTurn(say[1], { prompt: data.text });
    throw new Error(`no route ${route}`);
  };
  const make = (name, label) => {
    const projects = temporary(`${name}-projects`), directory = path.join(projects, label);
    mkdirSync(path.join(directory, '.git'), { recursive: true }); writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: label }));
    const turns = [], holder = {};
    const desk = new Desk(new Store(temporary(name)), { root: temporary(`${name}-root`), memoryDirectory: temporary(`${name}-memory`), peerTransport: (...args) => transport(holder.desk)(...args),
      runnerFactory: options => ({ start: async prompt => { turns.push({ run: options.run, prompt }); options.event('session', { sessionId: SESSION }); options.event('agent-text', { text: `${name} here` }); }, interrupt: async () => {} }) });
    holder.desk = desk; desk.memory.scan({ roots: [projects] }); desk.peers.rename(name === 'a' ? 'Work laptop' : 'Home laptop');
    return { desk, turns };
  };
  const a = make('a', 'shop'), b = make('b', 'blog');
  network.a = a.desk; network.b = b.desk;
  b.desk.peers.join(a.desk.peers.key());
  return { a, b, network };
}

test('two computers of one person share rooms, messages and agents, and each agent works on its own computer', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' }), room = a.desk.rooms.create('Team', [dara.id]);
  await b.desk.peers.add('a');
  assert.equal(a.desk.peers.settings().peers.length, 0, 'a learns b from b\'s own pulls over the network');
  assert.ok(b.desk.store.get('room', room.id), 'the room arrived');
  const copy = b.desk.store.get('specialist', dara.id);
  assert.equal(copy.node, a.desk.store.nodeId); assert.ok(b.desk.peers.isRemote(copy)); assert.ok(!a.desk.peers.isRemote(dara));
  assert.equal(b.desk.specialists.status(copy).state, 'idle', 'online, so its status comes from its computer');
  assert.equal(b.desk.snapshot().specialists.find(agent => agent.id === dara.id).device, 'Work laptop');

  // The person writes from the home laptop; Dara answers on the work laptop, and the answer comes back.
  await b.desk.rooms.post(room.id, { text: '@dara how is the shop?' });
  assert.equal(b.turnsLength ?? 0, 0); assert.ok(!b.desk.store.list('run').some(run => run.specialistId === dara.id || run.roomAgent === dara.id), 'nothing runs for Dara on the home laptop');
  await a.desk.peers.pullFrom({ id: b.desk.store.nodeId, url: 'http://b' });
  await waitFor(() => a.turns.length === 1);
  assert.match(a.turns[0].prompt, /how is the shop/);
  await waitFor(() => a.desk.rooms.messages(room.id).some(item => item.from.id === dara.id));
  await b.desk.peers.pullFrom(b.desk.peers.byNode(a.desk.store.nodeId));
  assert.ok(b.desk.rooms.messages(room.id).some(item => item.from.id === dara.id && /a here/.test(item.text)), 'the reply reached the home laptop');
});

test('when a computer is off its agents show offline, room messages and chats wait, and run when it is back', async () => {
  const { a, b, network } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' }), room = a.desk.rooms.create('Team', [dara.id]);
  await b.desk.peers.add('a');
  network.off.add('a');
  await b.desk.peers.pullFrom(b.desk.peers.byNode(a.desk.store.nodeId));
  const copy = b.desk.store.get('specialist', dara.id);
  assert.equal(b.desk.specialists.status(copy).state, 'offline');
  assert.match(b.desk.specialists.status(copy).label, /Work laptop is off/);

  await b.desk.rooms.post(room.id, { text: '@dara are you there?' });
  assert.ok(b.desk.rooms.messages(room.id).some(item => item.from.type === 'system' && /Dara is offline: Work laptop is off\. The message waits/.test(item.text)));
  const queued = await b.desk.peers.command(copy, 'say', { text: 'Check the logs when you are back.' });
  assert.equal(queued.queued, true); assert.match(queued.message, /gets this when it is back/);

  // The work laptop comes back and reads what it missed.
  network.off.delete('a');
  await a.desk.peers.pullFrom({ id: b.desk.store.nodeId, url: 'http://b' });
  await waitFor(() => a.turns.length === 2);
  assert.ok(a.turns.some(turn => /are you there/.test(turn.prompt)), 'the waiting room message was answered');
  assert.ok(a.turns.some(turn => /Check the logs/.test(turn.prompt)), 'the waiting chat message was delivered');
  await waitFor(() => a.desk.store.list('peercmd').every(item => item.done));
  await b.desk.peers.pullFrom(b.desk.peers.byNode(a.desk.store.nodeId));
  assert.ok(b.desk.store.list('peercmd').every(item => item.done), 'the home laptop sees the command is done');
});

test('the newest change wins, what agents learn is shared, and Rex Agent stays each computer\'s own', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' }), room = a.desk.rooms.create('Team', [dara.id]);
  a.desk.memory.personNote('likes', 'Short replies.');
  a.desk.memory.learnWorkflow('shop', 'Branch from global/release.');
  await b.desk.peers.add('a');
  b.desk.rooms.rename(room.id, 'Shop team');
  await a.desk.peers.pullFrom({ id: b.desk.store.nodeId, url: 'http://b' });
  assert.equal(a.desk.store.get('room', room.id).name, 'Shop team');
  assert.match(b.desk.memory.person(), /Short replies/);
  assert.ok(existsSync(b.desk.memory.file('workflows', 'shop.md')));
  assert.match(readFileSync(b.desk.memory.file('workflows', 'shop.md'), 'utf8'), /global\/release/);
  a.desk.specialists.ensureMain();
  await b.desk.peers.pullFrom(b.desk.peers.byNode(a.desk.store.nodeId));
  assert.ok(!b.desk.store.get('specialist', 'main'), 'Rex Agent is not copied');
  assert.ok(!a.desk.peers.serve().changes.some(change => change.kind === 'specialist' && change.id === 'main'));
});

test('a computer with another key is refused, and only Tailscale addresses are listened on', async () => {
  const { a, b } = computers();
  b.desk.peers.join('a-completely-different-key-123');
  await assert.rejects(b.desk.peers.add('a'), /different key/);
  assert.deepEqual(tailscaleAddresses({ eth: [{ family: 'IPv4', address: '192.168.1.5', internal: false }], ts: [{ family: 'IPv4', address: '100.101.2.3', internal: false }, { family: 'IPv4', address: '100.200.1.1', internal: false }] }), ['100.101.2.3']);
  assert.ok(a.desk.peers.checkSession(`x=1; rexdesk=${a.desk.peers.session()}`)); assert.ok(!a.desk.peers.checkSession('rexdesk=nope'));
});

test('a computer that says it is on through Turso counts as on, even when it cannot be reached over Tailscale', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  b.desk.store.put('specialist', dara.id, { ...a.desk.store.get('specialist', dara.id) });
  const copy = b.desk.store.get('specialist', dara.id);
  assert.match(b.desk.specialists.status(copy).label, /has not checked in/, 'never seen at all: it says so, not that it is off');
  b.desk.store.cloud = { ready: true, record() {}, remove() {}, event() {}, schedule() {}, shared() {}, enqueue() {}, presence: async () => [{ node: a.desk.store.nodeId, name: 'Home laptop', at: Date.now(), agents: { [dara.id]: { state: 'replying', label: 'Replying in a room…' } } }] };
  await b.desk.peers.presence();
  assert.equal(b.desk.specialists.status(copy).state, 'replying', 'its status comes from the database');
  assert.equal(b.desk.peers.deviceName(a.desk.store.nodeId), 'Home laptop');
  assert.ok(b.desk.peers.status().peers.some(peer => peer.name === 'Home laptop' && peer.online && peer.via === 'turso'), 'Devices lists it');
  const sent = await b.desk.peers.command(copy, 'say', { text: 'hi' });
  assert.match(sent.message, /through the shared database/);
});

test('a personal chat with an agent on another computer is read and written through the shared database, without Tailscale', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  await a.desk.specialistTurn(dara.id, { prompt: 'Introduce yourself.' });
  const runId = a.desk.store.get('specialist', dara.id).runId;
  await waitFor(() => !['starting', 'running'].includes(a.desk.store.get('run', runId).state));
  a.desk.peers.copyChat(runId);
  // Only through the database: the records arrive on the home laptop as Turso would bring them.
  const carry = (from, to, kinds) => to.desk.peers.applyAll(kinds.flatMap(kind => from.desk.store.list(kind).map(value => ({ kind, id: value.id, value }))));
  carry(a, b, ['specialist', 'chatcopy']);
  const shown = b.desk.snapshot().runs.find(run => run.id === runId);
  assert.ok(shown?.cloudCopy, 'the chat shows on the home laptop');
  const copy = b.desk.peers.chatCopy(runId);
  assert.ok(copy.events.some(event => /a here/.test(event.text || '')), 'with what Dara said');
  assert.ok(!b.desk.store.get('run', runId), 'nothing runs for Dara on the home laptop');

  const sent = await b.desk.peers.chatAction(copy, 'resume', { prompt: 'How is the shop today?' });
  assert.equal(sent.queued, true);
  carry(b, a, ['peercmd']);
  await waitFor(() => a.turns.some(turn => /How is the shop today/.test(turn.prompt)));
  await waitFor(() => a.desk.store.list('peercmd').every(item => item.done));
  await waitFor(() => !['starting', 'running'].includes(a.desk.store.get('run', runId).state));
  a.desk.peers.copyChat(runId); carry(a, b, ['chatcopy']);
  const after = b.desk.peers.chatCopy(runId);
  assert.ok(after.events.some(event => /How is the shop today/.test(event.text || '')), 'the person\'s message is in the chat on both computers');
  await assert.rejects(() => b.desk.peers.chatAction(after, 'publish', {}), /Open this chat on .* to do that/);
});

test('the same message to an agent on another computer is sent once, and its chat copy shows a repeated message once', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  b.desk.store.put('specialist', dara.id, { ...a.desk.store.get('specialist', dara.id) });
  const copy = b.desk.store.get('specialist', dara.id);
  await b.desk.peers.command(copy, 'say', { text: 'Introduce yourself.' });
  const again = await b.desk.peers.command(copy, 'say', { text: 'Introduce yourself.' });
  assert.equal(again.repeat, true);
  assert.equal(b.desk.store.list('peercmd').length, 1);

  await a.desk.specialistTurn(dara.id, { prompt: 'Hello' });
  const runId = a.desk.store.get('specialist', dara.id).runId;
  await waitFor(() => !['starting', 'running'].includes(a.desk.store.get('run', runId).state));
  for (let index = 0; index < 5; index++) a.desk.store.event(runId, 'human-message', { text: 'Introduce yourself.' }, true);
  a.desk.peers.copyChat(runId);
  const events = a.desk.store.get('chatcopy', runId).events;
  assert.equal(events.filter(event => event.text === 'Introduce yourself.').length, 1);
});

test('a question an agent on another computer is waiting on shows here and is answered from here', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  await a.desk.specialistTurn(dara.id, { prompt: 'Hello' });
  const runId = a.desk.store.get('specialist', dara.id).runId;
  await waitFor(() => !['starting', 'running'].includes(a.desk.store.get('run', runId).state));
  const answered = a.desk.ask(runId, { kind: 'approval', method: 'approval', title: 'Restart Rex Desk?', request: { command: 'restart' } });
  await waitFor(() => a.desk.store.list('interaction').some(item => item.runId === runId && item.state === 'pending'));
  a.desk.peers.copyChat(runId);
  const carry = (from, to, kinds) => to.desk.peers.applyAll(kinds.flatMap(kind => from.desk.store.list(kind).map(value => ({ kind, id: value.id, value }))));
  carry(a, b, ['specialist', 'chatcopy']);
  const ask = b.desk.snapshot().interactions.find(item => item.runId === runId);
  assert.equal(ask?.title, 'Restart Rex Desk?', 'the question shows on the home laptop');
  b.desk.peers.answerAsk(b.desk.peers.askCopy(ask.id), ask.id, { action: 'accept', content: {} });
  assert.ok(!b.desk.snapshot().interactions.some(item => item.id === ask.id), 'answered here, so it leaves the list at once');
  carry(b, a, ['peercmd']);
  const answer = await answered;
  assert.equal(answer.action, 'accept');
});

test('a picture attached in a chat on another computer shows here too', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  const folder = path.join(a.desk.store.directory, 'uploads', '0b5e2c3a-1111-4222-8333-444455556666'); mkdirSync(folder, { recursive: true });
  const picture = path.join(folder, 'screen.png'); writeFileSync(picture, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  await a.desk.specialistTurn(dara.id, { prompt: `Look at this.\n\nAttached files (read them from these paths):\n- ${picture}` });
  const runId = a.desk.store.get('specialist', dara.id).runId;
  await waitFor(() => !['starting', 'running'].includes(a.desk.store.get('run', runId).state));
  a.desk.peers.copyChat(runId);
  b.desk.peers.applyAll(['specialist', 'chatcopy', 'chatfile'].flatMap(kind => a.desk.store.list(kind).map(value => ({ kind, id: value.id, value }))));
  const shown = b.desk.peers.chatPicture(picture);
  assert.deepEqual([...shown.data], [137, 80, 78, 71, 1, 2, 3]);
  assert.equal(b.desk.peers.chatPicture(path.join(folder, 'other.png')), null);
});

test('a file attached here for an agent on another computer is saved there, and the agent is given that computer\'s path', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  await a.desk.specialistTurn(dara.id, { prompt: 'Hello' });
  const runId = a.desk.store.get('specialist', dara.id).runId;
  await waitFor(() => !['starting', 'running'].includes(a.desk.store.get('run', runId).state));
  a.desk.peers.copyChat(runId);
  const carry = (from, to, kinds) => to.desk.peers.applyAll(kinds.flatMap(kind => from.desk.store.list(kind).map(value => ({ kind, id: value.id, value }))));
  carry(a, b, ['specialist', 'chatcopy']);
  // The person attaches a screenshot on the home laptop (or the phone connected to it).
  const folder = path.join(b.desk.store.directory, 'uploads', '7a1e2c3a-1111-4222-8333-444455556666'); mkdirSync(folder, { recursive: true });
  const shot = path.join(folder, 'image.png'); writeFileSync(shot, Buffer.from([137, 80, 78, 71, 9, 9]));
  await b.desk.peers.chatAction(b.desk.peers.chatCopy(runId), 'resume', { prompt: `What is in this?\n\nAttached files (read them from these paths):\n- ${shot}` });
  carry(b, a, ['chatfile', 'peercmd']);
  await waitFor(() => a.turns.some(turn => /What is in this/.test(turn.prompt)));
  const prompt = a.turns.find(turn => /What is in this/.test(turn.prompt)).prompt;
  assert.ok(!prompt.includes(shot), 'the home laptop\'s path is not given to the agent');
  const there = /- (.+image\.png)/.exec(prompt)[1];
  assert.ok(there.startsWith(path.join(a.desk.store.directory, 'uploads')), 'it is in the work laptop\'s uploads');
  assert.deepEqual([...readFileSync(there)], [137, 80, 78, 71, 9, 9]);
});

test('a screenshot an agent on another computer saved as evidence shows here too', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  await a.desk.specialistTurn(dara.id, { prompt: 'Hello' });
  const runId = a.desk.store.get('specialist', dara.id).runId;
  await waitFor(() => !['starting', 'running'].includes(a.desk.store.get('run', runId).state));
  const folder = a.desk.evidence.directory(runId); writeFileSync(path.join(folder, 'proof.png'), Buffer.from([137, 80, 78, 71, 5]));
  a.desk.evidence.attach(runId, 'proof.png', 'Proof', 'image/png');
  a.desk.peers.copyChat(runId);
  b.desk.peers.applyAll(['chatcopy', 'chatfile'].flatMap(kind => a.desk.store.list(kind).map(value => ({ kind, id: value.id, value }))));
  assert.deepEqual([...b.desk.peers.evidencePicture(runId, 'proof.png').data], [137, 80, 78, 71, 5]);
});

test('a computer whose clock runs behind still counts as on: "on" is judged by when this computer last heard from it', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  b.desk.store.put('specialist', dara.id, { ...a.desk.store.get('specialist', dara.id) });
  const copy = b.desk.store.get('specialist', dara.id);
  // Its clock is ten minutes behind: by comparing clocks it looked off for good.
  let beat = Date.now() - 10 * 60000;
  b.desk.store.cloud = { ready: true, record() {}, remove() {}, event() {}, schedule() {}, shared() {}, enqueue() {}, presence: async () => [{ node: a.desk.store.nodeId, name: 'Home laptop', at: beat, agents: { [dara.id]: { state: 'idle', label: 'Idle' } } }] };
  await b.desk.peers.presence();
  assert.equal(b.desk.peers.online(a.desk.store.nodeId), false, 'one old heartbeat alone is not enough');
  beat += 30000; await b.desk.peers.presence();
  assert.equal(b.desk.peers.online(a.desk.store.nodeId), true, 'its heartbeat changed since the last look, so it is on');
  assert.match((await b.desk.peers.command(copy, 'say', { text: 'hi' })).message, /through the shared database/);
  // New data from it counts too.
  b.desk.peers.heard.clear();
  b.desk.store.cloud.pullShared = async () => [];
  assert.equal(b.desk.peers.online(a.desk.store.nodeId), false);
  b.desk.peers.newestFrom = new Map([[a.desk.store.nodeId, 1]]);
  b.desk.store.cloud.pullShared = async since => since < '0' ? [] : [{ kind: 'room', id: 'r', deleted: false, value: null, v: `${(Date.now() - 600000).toString(36).padStart(9, '0')}.0001.${a.desk.store.nodeId}` }];
  b.desk.peers.applyAll = () => {};
  await b.desk.peers.pullTurso();
  assert.equal(b.desk.peers.online(a.desk.store.nodeId), true, 'something new arrived from it');
});

test('an agent without a project can move to the computer the person writes from, with nothing to set up', async () => {
  const { a, b } = computers();
  const writer = a.desk.specialists.create({ name: 'Writer', purpose: 'Writes posts' });
  b.desk.store.put('specialist', writer.id, { ...a.desk.store.get('specialist', writer.id), follows: true });
  assert.ok(b.desk.peers.isRemote(b.desk.store.get('specialist', writer.id)));
  const moved = await b.desk.projectRules.move(writer.id);
  assert.equal(moved.moved, true);
  assert.equal(b.desk.store.get('specialist', writer.id).node, b.desk.store.nodeId, 'it works here now');
  assert.equal(b.desk.store.get('specialist', writer.id).follows, true, 'and keeps following the person');
});

test('an agent follows the person by default, unless that is turned off or its project stays on its own computer', async () => {
  const { a, b } = computers();
  const writer = a.desk.specialists.create({ name: 'Writer', purpose: 'Writes posts' });
  b.desk.store.put('specialist', writer.id, { ...a.desk.store.get('specialist', writer.id) });
  const card = () => b.desk.store.get('specialist', writer.id);
  assert.equal(b.desk.peers.followsHere(card()), true, 'a message from this computer brings it here');
  b.desk.store.put('specialist', writer.id, { ...card(), follows: false });
  assert.equal(b.desk.peers.followsHere(card()), false, '"Works where you are" off keeps it where it is');
  b.desk.store.put('specialist', writer.id, { ...card(), follows: true, pinned: true });
  assert.equal(b.desk.peers.followsHere(card()), false, 'a project that runs only on its computer stays there');
  assert.equal(a.desk.peers.followsHere(a.desk.store.get('specialist', writer.id)), false, 'on its own computer there is nothing to move');
});

test('a page an agent on another computer shared is unpacked here when opened', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  await a.desk.specialistTurn(dara.id, { prompt: 'Hello' });
  const runId = a.desk.store.get('specialist', dara.id).runId;
  await waitFor(() => !['starting', 'running'].includes(a.desk.store.get('run', runId).state));
  const folder = a.desk.evidence.directory(runId); writeFileSync(path.join(folder, 'explain.html'), '<!doctype html><h1>How it works</h1>');
  a.desk.evidence.attach(runId, 'explain.html', 'How it works', 'text/html');
  a.desk.peers.copyChat(runId);
  b.desk.peers.applyAll(['chatcopy', 'chatfile'].flatMap(kind => a.desk.store.list(kind).map(value => ({ kind, id: value.id, value }))));
  assert.equal(b.desk.peers.evidencePicture(runId, 'explain.html'), null, 'it is not a picture');
  assert.equal(b.desk.peers.restoreEvidence(runId, 'explain.html'), true, 'but the page came with the chat and is written here');
  assert.match(readFileSync(path.join(b.desk.store.media('artifacts'), runId, 'explain.html'), 'utf8'), /How it works/);
});

// Two computers of one account linked by the relay line (L88): a note one sends reaches the other a moment later. Both hold the
// account's key and workspace, as two computers signed in to one account do.
function linkByRelay(a, b) {
  b.desk.store.key = a.desk.store.key;
  const lines = { a: { up: true }, b: { up: true } }, notes = [];
  for (const [name, from, to] of [['a', a, b], ['b', b, a]]) from.desk.phoneRelay = { get online() { return lines[name].up; }, ensure() {}, sync: text => { if (!lines[name].up) return false; notes.push({ from: name, text }); setTimeout(() => to.desk.peers.onSync(text), 5); return true; } };
  return { lines, notes };
}
const sharedCloud = (desks, workspace = 'workspace-1') => {
  const table = new Map(), reads = { a: 0, b: 0 }, writes = { a: 0, b: 0 };
  const cloud = (desk, name) => ({ ready: true, workspace, record() {}, remove() {}, event() {}, schedule() {}, shared() {}, enqueue() {},
    pullShared: async () => { reads[name]++; return []; }, pullChat: async () => { reads[name]++; return []; },
    presence: async (title, agents, { read = true } = {}) => { writes[name]++; table.set(desk.store.nodeId, { node: desk.store.nodeId, name: title, at: Date.now(), agents }); if (!read) return []; reads[name]++; return [...table.values()].filter(row => row.node !== desk.store.nodeId); },
    readPresence: async () => { reads[name]++; return [...table.values()].filter(row => row.node !== desk.store.nodeId); } });
  for (const [name, desk] of Object.entries(desks)) desk.store.cloud = cloud(desk, name);
  return { reads, writes };
};
const within = async (ms, check) => { const start = Date.now(); while (Date.now() - start < ms) { if (check()) return Date.now() - start; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`not within ${ms} ms`); };

test('without Tailscale, an agent replying on one computer shows as replying on the other within a second, by note, and reads nothing for it (L88)', async () => {
  const { a, b } = computers();
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  b.desk.store.put('specialist', dara.id, { ...a.desk.store.get('specialist', dara.id) });
  const { reads, writes } = sharedCloud({ a: a.desk, b: b.desk }); linkByRelay(a, b);
  a.desk.peers.start(); b.desk.peers.start();
  const copy = () => b.desk.store.get('specialist', dara.id), state = () => b.desk.specialists.status(copy()).state;
  try {
    await within(4000, () => state() === 'idle');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const before = { ...reads }, wrote = writes.a;
    a.desk.store.put('run', 'run-1', { id: 'run-1', specialistId: dara.id, role: 'specialist', state: 'running', createdAt: new Date().toISOString() });
    assert.ok(await within(1500, () => state() === 'replying') < 1500, 'shown within a second or so');
    assert.ok(writes.a > wrote, 'the cloud row is still written, for computers without the line');
    a.desk.store.put('run', 'run-1', { ...a.desk.store.get('run', 'run-1'), state: 'done' });
    await within(1500, () => state() === 'idle');
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.deepEqual(reads, before, 'nothing was read from the cloud for it, and nothing is polled while idle');
  } finally { a.desk.peers.stop(); b.desk.peers.stop(); }
});

test('a room message and a chat message ride inside the note: the other computer shows them without reading the cloud (L88)', async () => {
  const { a, b } = computers();
  const { reads } = sharedCloud({ a: a.desk, b: b.desk }); const { notes } = linkByRelay(a, b);
  const room = a.desk.rooms.create('Plans'); b.desk.peers.applyAll([{ kind: 'room', id: room.id, value: a.desk.store.get('room', room.id) }]);
  a.desk.rooms.system(room.id, 'Ship it today'); const message = a.desk.store.list('roommsg').find(item => item.text === 'Ship it today');
  const saved = a.desk.store.get('roommsg', message.id);
  const record = { kind: 'roommsg', id: message.id, value: saved, deleted: false, v: saved._v };
  const row = { uid: `${a.desk.store.nodeId}.1.x`, run_id: 'run-9', kind: 'agent-text', visible: 1, value: JSON.stringify({ text: 'Done' }), created_at: new Date().toISOString(), v: saved._v, deleted: 0 };
  let applied = []; b.desk.store.applyChatEvents = rows => { applied = rows; return rows.length; };
  a.desk.peers.uploaded({ shared: record.v, chat: row.v, records: [record], rows: [row] });
  await within(500, () => b.desk.store.get('roommsg', message.id));
  assert.equal(b.desk.store.get('roommsg', message.id).text, 'Ship it today');
  assert.deepEqual(applied.map(item => item.uid), [row.uid], 'the chat message is applied from the note');
  assert.deepEqual(b.desk.peers.due || {}, {}, 'and nothing is left to read');
  assert.deepEqual(reads, { a: 0, b: 0 });
  assert.doesNotMatch(notes[0].text, /Ship it today/, 'the relay only sees the sealed note');
});

test('a note too big to carry its rows, or one the line could not send, makes the other computer read from the oldest one only (L88)', async () => {
  const { a, b } = computers();
  sharedCloud({ a: a.desk, b: b.desk }); const { lines } = linkByRelay(a, b);
  const asked = [];
  b.desk.peers.pullTurso = async options => { asked.push(['shared', options]); }; b.desk.peers.pullChats = async options => { asked.push(['chat', options]); return 0; };
  b.desk.peers.start();
  try {
    await within(5000, () => asked.length >= 2); asked.length = 0;
    const big = Array.from({ length: 40 }, (_, i) => ({ uid: `u${i}`, run_id: 'r', kind: 'agent-text', visible: 1, value: 'x'.repeat(1000), created_at: '', v: `00000000${i}.0000.n`, deleted: 0 }));
    a.desk.peers.uploaded({ chat: '000000005.0000.n', rows: big });
    await within(1000, () => asked.some(([part]) => part === 'chat'));
    assert.deepEqual(asked.find(([part]) => part === 'chat')[1], { from: '000000005.0000.n', overlap: 0 }, 'read from the oldest version in it, with no look back');
    // Uploaded while the line was down: told, with the oldest version, once it is back.
    lines.a.up = false; asked.length = 0;
    a.desk.peers.uploaded({ shared: '00000000b.0000.n' }); a.desk.peers.uploaded({ shared: '00000000a.0000.n' });
    lines.a.up = true; a.desk.peers.relayUp();
    await within(1000, () => asked.some(([part]) => part === 'shared'));
    assert.deepEqual(asked.find(([part]) => part === 'shared')[1], { from: '00000000a.0000.n', overlap: 0 });
  } finally { b.desk.peers.stop(); }
});

test("a note's hint goes with a safety look too, and stays until a look has read it (L88 review)", async () => {
  const { a, b } = computers();
  sharedCloud({ a: a.desk, b: b.desk }); linkByRelay(a, b);
  const asked = []; let fail = 1;
  b.desk.peers.pullTurso = async () => true;
  b.desk.peers.pullChats = async options => { asked.push(options); if (options?.from && fail-- > 0) throw new Error('fetch failed'); return 0; };
  b.desk.peers.start();
  try {
    await within(5000, () => asked.length >= 1); asked.length = 0;
    const big = Array.from({ length: 40 }, (_, i) => ({ uid: `u${i}`, run_id: 'r', kind: 'agent-text', visible: 1, value: 'x'.repeat(1000), created_at: '', v: `00000000${i}.0000.n`, deleted: 0 }));
    a.desk.peers.uploaded({ chat: '000000005.0000.n', rows: big });
    await within(4000, () => asked.filter(options => options?.from).length >= 2);
    assert.deepEqual(asked.filter(options => options?.from).slice(0, 2).map(options => options.from), ['000000005.0000.n', '000000005.0000.n'], 'the look failed, so the next one starts there again');
    await within(2000, () => !('chat' in b.desk.peers.due));
    // A safety look that is due while a hint waits takes the hint along, instead of dropping it.
    b.desk.peers.timers.set('chat', 0); b.desk.peers.due.chat = '000000003.0000.n'; asked.length = 0;
    await within(3000, () => asked.length >= 1);
    assert.deepEqual(asked[0], { from: '000000003.0000.n' });
    await within(2000, () => !('chat' in b.desk.peers.due));
  } finally { b.desk.peers.stop(); }
});

test('a note from another account, or one that cannot be opened, is ignored; a closing computer shows off at once (L88)', async () => {
  const { a, b } = computers();
  sharedCloud({ a: a.desk, b: b.desk }); linkByRelay(a, b);
  b.desk.peers.onSync('not a sealed note');
  b.desk.peers.onSync(a.desk.store.encrypt(JSON.stringify({ w: 'another-workspace', n: a.desk.store.nodeId, p: { name: 'X', agents: {} } })));
  assert.equal(b.desk.peers.online(a.desk.store.nodeId), false);
  b.desk.peers.onSync(a.desk.store.encrypt(JSON.stringify({ w: 'workspace-1', n: a.desk.store.nodeId, p: { name: 'Home laptop', agents: {} } })));
  assert.equal(b.desk.peers.online(a.desk.store.nodeId), true, 'a note says it is on');
  a.desk.peers.goodbye(); await within(500, () => !b.desk.peers.online(a.desk.store.nodeId));
});

test('a computer that went off does not stay "on" because the chat overlap reads its last message again (L26)', async () => {
  const { a, b } = computers();
  const from = a.desk.store.nodeId, row = { v: `${(Date.now() - 30000).toString(36).padStart(9, '0')}.0001.${from}` };
  b.desk.store.cloud = { ready: true, record() {}, remove() {}, event() {}, schedule() {}, shared() {}, enqueue() {}, pullChat: async () => [row] };
  b.desk.store.applyChatEvents = () => 0;
  await b.desk.peers.pullChats();
  assert.equal(b.desk.peers.online(from), true, 'a message it had not read yet is a sign of life');
  b.desk.peers.heard.clear();
  // It went off: every pull still starts two minutes back and gets the same last message.
  await b.desk.peers.pullChats(); await b.desk.peers.pullChats();
  assert.equal(b.desk.peers.online(from), false, 'reading the same message again is not');
});

test('a days-old message read for the first time does not make its computer look on (L26)', async () => {
  const { a, b } = computers();
  const from = a.desk.store.nodeId, row = { v: `${(Date.now() - 3 * 86400000).toString(36).padStart(9, '0')}.0001.${from}` };
  b.desk.store.cloud = { ready: true, record() {}, remove() {}, event() {}, schedule() {}, shared() {}, enqueue() {}, pullChat: async () => [row] };
  b.desk.store.applyChatEvents = () => 0;
  await b.desk.peers.pullChats();
  assert.equal(b.desk.peers.online(from), false);
});

test('a file sent to the other computer keeps its upload folder name there, so the shared chat path opens on both (L27)', async () => {
  const { a, b } = computers();
  const folder = '0f6aa13b-910c-4871-a64a-af4c48269fff', sent = path.join(path.resolve(a.desk.store.media('uploads')), folder, 'from-work.png');
  mkdirSync(path.dirname(sent), { recursive: true }); writeFileSync(sent, 'png');
  const packed = a.desk.peers.packFiles(`Look\n\nAttached files (read them from these paths):\n- ${sent}`, b.desk.store.nodeId);
  b.desk.store.put('chatfile', packed.files[0].id, a.desk.store.get('chatfile', packed.files[0].id));
  const text = await b.desk.peers.unpackFiles({ text: packed.text, files: packed.files });
  const here = path.join(path.resolve(b.desk.store.media('uploads')), folder, 'from-work.png');
  assert.ok(text.includes(here), 'saved under the same folder name');
  assert.equal(readFileSync(here, 'utf8'), 'png');
});

test('a file attached in a room travels with it, and one that is not a picture comes back as a download (L27)', async () => {
  const { a } = computers();
  const file = path.join(path.resolve(a.desk.store.media('uploads')), '1f6aa13b-910c-4871-a64a-af4c48269fff', 'notes.txt');
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'hello');
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' }), room = a.desk.rooms.create('Files', [dara.id]);
  a.desk.runnerFactory = () => ({ start: async () => {}, interrupt: async () => {} });
  await a.desk.rooms.post(room.id, { text: `See this\n\nAttached files (read them from these paths):\n- ${file}` });
  const shared = a.desk.peers.chatPicture(file);
  assert.equal(shared?.data.toString(), 'hello');
  assert.equal(shared.picture, false);
});

test('an attached file has one id on Windows and macOS, and an incoming file never overwrites a different one (L27)', async () => {
  const { chatFileId } = await import('../src/peers.js');
  const id = '2f6aa13b-910c-4871-a64a-af4c48269fff';
  assert.equal(chatFileId(['C:', 'Users', 'rex', 'Rex Desk data', 'uploads', id, 'shot.png'].join('\\')), chatFileId(`/Users/rex/Library/Rex Desk/uploads/${id}/shot.png`));
  const { b } = computers();
  const here = path.join(path.resolve(b.desk.store.media('uploads')), id, 'shot.png');
  mkdirSync(path.dirname(here), { recursive: true }); writeFileSync(here, 'mine');
  const sent = `/Users/rex/Library/Rex Desk/uploads/${id}/shot.png`, fileId = chatFileId(sent);
  b.desk.store.put('chatfile', fileId, { id: fileId, name: 'shot.png', size: 6, data: Buffer.from('theirs').toString('base64') });
  const text = await b.desk.peers.unpackFiles({ text: `- ${sent}`, files: [{ id: fileId, path: sent, name: 'shot.png' }] });
  assert.equal(readFileSync(here, 'utf8'), 'mine', 'the file already here stays');
  const other = text.slice(2);
  assert.notEqual(path.resolve(other), path.resolve(here));
  assert.equal(readFileSync(other, 'utf8'), 'theirs');
});

test('notes learned about the person on two computers are merged, not replaced, a removed note stays removed, and agents\' lessons and memory carry across', async () => {
  const { a, b } = computers();
  a.desk.memory.personNote('likes', 'Short replies.');
  a.desk.memory.learnWorkflow('shop', 'Branch from global/release.');
  b.desk.memory.personNote('dislikes', 'Emoji in replies.');
  b.desk.memory.personNote('likes', 'Plain words.');
  await b.desk.peers.add('a');
  const toA = () => b.desk.peers.pullFrom(b.desk.peers.byNode(a.desk.store.nodeId)), toB = () => a.desk.peers.pullFrom({ id: b.desk.store.nodeId, url: 'http://b' });
  // An older copy already read a's files with newest-wins: its file cursor is past a's notes. The first sync after the update reads them all once.
  a.desk.memory.personNote('about', 'Works on two laptops.');
  const settings = b.desk.store.get('peers', 'main');
  b.desk.store.put('peers', 'main', { ...settings, notesMerged: {}, files: { ...settings.files, [a.desk.store.nodeId]: Date.now() + 60000 } });
  await toA(); await toB();
  for (const desk of [a.desk, b.desk]) {
    const person = desk.memory.person();
    assert.match(person, /Works on two laptops/, 'skipped by the old cursor, read by the one-time merge');
    assert.match(person, /Short replies/); assert.match(person, /Plain words/); assert.match(person, /Emoji in replies/);
    assert.equal(person.match(/Short replies/g).length, 1, 'never doubled');
  }
  assert.match(readFileSync(b.desk.memory.file('workflows', 'shop.md'), 'utf8'), /global\/release/);
  assert.equal(b.desk.store.get('peers', 'main').notesMerged[a.desk.store.nodeId], true);
  // A note removed on one computer goes on the other too, and the next merge does not bring it back.
  a.desk.memory.forgetPersonNote('likes', 'Plain words');
  a.desk.memory.personNote('likes', 'Answers first.');
  await toA(); await toB(); await toA();
  for (const desk of [a.desk, b.desk]) { assert.doesNotMatch(desk.memory.person(), /Plain words/); assert.match(desk.memory.person(), /Answers first/); }
  // A note replaced on b is replaced on a.
  b.desk.memory.personNote('dislikes', 'Emoji anywhere.', { replaces: 'Emoji in replies' });
  await toB();
  assert.doesNotMatch(a.desk.memory.person(), /Emoji in replies/); assert.match(a.desk.memory.person(), /Emoji anywhere/);
  // An agent's own lessons and memory travel with it.
  const dara = a.desk.specialists.create({ name: 'Dara', projectSlug: 'shop' });
  a.desk.specialists.learn(dara.id, 'Run only the touched tests.', 'you');
  a.desk.notes.put(dara.id, 'memory', '- Release branch is release/0.0.111.', { by: 'Dara' });
  await toA();
  assert.match(b.desk.specialists.lessonsText(dara.id), /touched tests/);
  assert.match(b.desk.notes.text(dara.id, 'memory'), /release\/0\.0\.111/);
});

test('a removed note that arrives without the notes file leaves the other computer\'s active memory at once', () => {
  const { a, b } = computers();
  for (const desk of [a.desk, b.desk]) { desk.memory.personNote('likes', 'Plain words.'); desk.memory.personNote('likes', 'Answers first.'); }
  a.desk.memory.forgetPersonNote('likes', 'Plain words');
  const forgotten = readFileSync(a.desk.memory.file('forgotten.json'), 'utf8');
  b.desk.peers.applyFiles([{ name: 'forgotten.json', mtime: Date.now(), text: forgotten }]);
  assert.doesNotMatch(b.desk.memory.person(), /Plain words/);
  assert.match(b.desk.memory.person(), /Answers first/);
  assert.deepEqual(JSON.parse(readFileSync(b.desk.memory.file('forgotten.json'), 'utf8')), JSON.parse(forgotten));
});

test('a synced note removal takes out only that note line and keeps the rest of the page byte for byte', () => {
  const { a, b } = computers();
  for (const desk of [a.desk, b.desk]) { desk.memory.personNote('likes', 'Plain words.'); desk.memory.personNote('likes', 'Answers first.'); }
  const file = b.desk.memory.file('user.md'), page = readFileSync(file, 'utf8');
  const lines = page.split('\n'), at = lines.findIndex(line => /Answers first/.test(line));
  lines.splice(at + 1, 0, 'Some text under the heading the person wrote.');
  writeFileSync(file, lines.join('\r\n'));
  const before = readFileSync(file, 'utf8');
  a.desk.memory.forgetPersonNote('likes', 'Plain words');
  b.desk.peers.applyFiles([{ name: 'forgotten.json', mtime: Date.now(), text: readFileSync(a.desk.memory.file('forgotten.json'), 'utf8') }]);
  const after = readFileSync(file, 'utf8'), gone = before.split(/(?<=\n)/).find(line => /Plain words/.test(line));
  assert.equal(after, before.replace(gone, ''), 'only the removed note line went');
  assert.match(after, /Some text under the heading/); assert.match(after, /Answers first/);
});

test('a sync that carries a note removal and the notes file together keeps the rest of About you byte for byte', () => {
  const { a, b } = computers();
  for (const desk of [a.desk, b.desk]) { desk.memory.personNote('likes', 'Plain words.'); desk.memory.personNote('likes', 'Answers first.'); }
  const file = b.desk.memory.file('user.md'), lines = readFileSync(file, 'utf8').split('\n');
  lines.splice(lines.findIndex(line => /Answers first/.test(line)) + 1, 0, 'Some text under the heading the person wrote.');
  writeFileSync(file, lines.join('\r\n'));
  const before = readFileSync(file, 'utf8');
  a.desk.memory.forgetPersonNote('likes', 'Plain words');
  a.desk.memory.personNote('likes', 'Short replies.');
  b.desk.peers.applyFiles([
    { name: 'forgotten.json', mtime: Date.now(), text: readFileSync(a.desk.memory.file('forgotten.json'), 'utf8') },
    { name: 'user.md', mtime: Date.now(), text: readFileSync(a.desk.memory.file('user.md'), 'utf8') },
  ]);
  const after = readFileSync(file, 'utf8'), gone = before.split(/(?<=\n)/).find(line => /Plain words/.test(line));
  const answers = before.split(/(?<=\n)/).find(line => /Answers first/.test(line));
  const added = after.split(/(?<=\n)/).find(line => /Short replies/.test(line));
  assert.equal(after, before.replace(gone, '').replace(answers, answers + added), 'only the removed line went and the new note joined its section');
  assert.match(after, /Some text under the heading the person wrote\.\r\n/); assert.doesNotMatch(after, /Plain words/);
});

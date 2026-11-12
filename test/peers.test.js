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

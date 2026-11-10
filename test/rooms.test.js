import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { MAX_HOPS } from '../src/rooms.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const SESSION = '7c3a8d71-d78d-409a-9a84-91fb162c1be3';
const waitFor = async predicate => { for (let attempt = 0; attempt < 240; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };

function setup({ replies = [] } = {}) {
  const projects = temporary('projects');
  for (const name of ['shop', 'billing']) {
    const directory = path.join(projects, name); mkdirSync(path.join(directory, '.git'), { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, description: `The ${name} service` }));
  }
  const store = new Store(temporary('rooms')), turns = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'),
    runnerFactory: options => ({ start: async prompt => { turns.push({ run: options.run, prompt }); options.event('session', { sessionId: SESSION }); const text = replies.shift(); if (text) options.event('agent-text', { text }); }, interrupt() {}, close() {} }) });
  desk.memory.scan({ roots: [projects] });
  const dara = desk.specialists.create({ name: 'Dara', projectSlug: 'shop', rules: 'Ask before schema changes.' }), vanna = desk.specialists.create({ name: 'Vanna', projectSlug: 'billing' });
  const room = desk.rooms.create('Checkout bug', [dara.id, vanna.id]);
  store.put('task', 't1', { id: 't1', title: '장바구니 합계가 틀림', titleEn: 'Cart total is wrong', taskNumber: '49760', externalId: '49760', status: 'In progress', projectName: 'Shop', description: 'The cart total ignores the discount.', active: true });
  return { store, desk, turns, dara, vanna, room };
}

test('a message reaches only the agents it names, with the room history and the English task name', async () => {
  const { desk, turns, dara, room } = setup();
  await desk.rooms.post(room.id, { text: 'Morning everyone' });
  assert.equal(turns.length, 0, 'nobody was mentioned');
  await desk.rooms.post(room.id, { text: '@dara can you look at #49760?' });
  await waitFor(() => turns.length === 1);
  assert.equal(turns[0].run.role, 'specialist'); assert.equal(turns[0].run.specialistId, dara.id);
  assert.match(turns[0].prompt, /You are Dara, the specialist agent for the project "shop"/);
  assert.match(turns[0].prompt, /Morning everyone/);
  assert.match(turns[0].prompt, /#49760 Cart total is wrong/); assert.ok(!turns[0].prompt.includes('장바구니'), 'the task is named in English');
  assert.match(turns[0].prompt, /Ask before schema changes\./);
});

test('what an agent says in its turn is posted to the room, and its session is kept for the next mention', async () => {
  const { desk, store, turns, dara, vanna, room } = setup({ replies: ['The discount is applied after tax. **Looks like a bug.**', 'Still on it.'] });
  await desk.rooms.post(room.id, { text: '@dara what is wrong with the cart?' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.type === 'agent'));
  const reply = desk.rooms.messages(room.id).find(item => item.from.type === 'agent');
  assert.equal(reply.from.label, 'Dara'); assert.match(reply.text, /Looks like a bug/); assert.deepEqual(reply.to, ['you']);
  const firstRun = store.get('specialist', dara.id).runId; assert.ok(firstRun);
  await desk.rooms.post(room.id, { text: '@vanna did you see that?' });
  await waitFor(() => turns.length === 2);
  await desk.rooms.post(room.id, { text: '@dara and now?' });
  await waitFor(() => turns.length === 3);
  assert.equal(store.get('specialist', dara.id).runId, firstRun, 'one session per agent');
  assert.equal(turns[2].run.id, firstRun);
  assert.match(turns[2].prompt, /Vanna: |The person: @vanna did you see that/, 'the second mention carries what happened since the agent last looked');
  assert.ok(!/You are Dara, the specialist agent/.test(turns[2].prompt), 'a resumed session is given only what is new');
  assert.ok(vanna.id);
});

test('an agent catches up on its other rooms when it is mentioned', async () => {
  const { desk, turns, dara, vanna, room } = setup();
  const other = desk.rooms.create('Billing sync', [dara.id, vanna.id]);
  await desk.rooms.post(other.id, { text: 'The invoice export is failing on refunds' });
  await desk.rooms.post(room.id, { text: '@dara anything I should know?' });
  await waitFor(() => turns.length === 1);
  assert.match(turns[0].prompt, /News from your other rooms/); assert.match(turns[0].prompt, /\[Billing sync\]/); assert.match(turns[0].prompt, /invoice export is failing/);
});

test('agent-to-agent threads pause after the hop limit and a person resets the count', async () => {
  const replies = Array.from({ length: 12 }, (_, index) => `${index % 2 ? '@dara' : '@vanna'} your turn ${index}`);
  const { desk, room } = setup({ replies });
  await desk.rooms.post(room.id, { text: '@dara start' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.paused || (item.from.type === 'system' && /paused/.test(item.text))));
  assert.ok(desk.rooms.messages(room.id).some(item => item.from.type === 'system' && /Thread paused after/.test(item.text)));
  const human = await desk.rooms.post(room.id, { text: 'carry on' });
  assert.equal(desk.rooms.messages(room.id).find(item => item.id === human.id).hops, 0);
  assert.ok(MAX_HOPS >= 1);
});

test('assigning a task makes the agent busy on it, announces it in the room and mirrors its reports; a busy agent refuses a second one', async () => {
  const { desk, store, dara, room } = setup();
  desk.closed = true;
  const directory = store.list('specialist')[0].projectPath;
  store.put('config', 'main', { ...store.config(), repositories: [{ id: 'repository-1', name: 'shop', path: directory, baseBranch: 'develop', targetBranch: 'develop' }] });
  const run = await desk.assignTask({ specialistId: dara.id, taskId: 't1', roomId: room.id });
  assert.equal(run.specialistId, dara.id); assert.equal(run.roomId, room.id); assert.equal(run.title, 'Cart total is wrong');
  assert.deepEqual([desk.specialists.status(store.get('specialist', dara.id)).state, desk.specialists.status(store.get('specialist', dara.id)).label], ['busy', 'Working on #49760 Cart total is wrong']);
  assert.ok(desk.rooms.messages(room.id).some(item => /Dara is now working on #49760 Cart total is wrong/.test(item.text)));
  assert.equal(desk.snapshot().specialists.find(agent => agent.id === dara.id).status.state, 'busy');
  desk.message(run.id, 'Found it: the discount is applied after tax.');
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.type === 'agent' && /discount is applied after tax/.test(item.text)));
  store.put('task', 't2', { id: 't2', title: 'Another', taskNumber: '1', externalId: '1', active: true });
  await assert.rejects(desk.assignTask({ specialistId: dara.id, taskId: 't2' }), /already working on a task/);
});

test('a task title in another language is named in English once, and an English title is left as it is', async () => {
  const store = new Store(temporary('naming')), calls = [];
  const desk = new Desk(store, { root: temporary('root'), namingFetcher: async (url, options) => { calls.push(options); return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"fix","name":"smart search ignores plan limit"}' } }] }), { headers: { 'Content-Type': 'application/json' } }); } });
  store.put('secret', 'openrouter', store.encrypt('key'));
  store.put('task', 'a', { id: 'a', title: 'Basic 플랜에서 스마트 검색 기간 제한이 적용되지 않음', taskNumber: '39551', externalId: '39551', active: true });
  store.put('task', 'b', { id: 'b', title: 'Gmail alert hides the status buttons', taskNumber: '34348', externalId: '34348', active: true });
  assert.equal(await desk.englishName('a'), 'Smart search ignores plan limit');
  assert.equal(await desk.englishName('a'), 'Smart search ignores plan limit'); assert.equal(calls.length, 1, 'named once');
  assert.equal(await desk.englishName('b'), 'Gmail alert hides the status buttons'); assert.equal(calls.length, 1, 'English needs no model');
  assert.equal(store.get('task', 'a').titleEn, 'Smart search ignores plan limit');
});

test('an agent cannot be mentioned if it is not in the room, and a typo is an error', async () => {
  const { desk, room } = setup();
  await assert.rejects(desk.rooms.post(room.id, { text: 'hello', to: ['nobody'] }), /not in this room/);
  const stranger = desk.specialists.create({ name: 'Stranger', projectSlug: 'billing' });
  assert.deepEqual(desk.rooms.mentionsIn(desk.rooms.room(room.id), '@stranger hi @dara'), [desk.specialists.list().find(a => a.name === 'Dara').id]);
  assert.ok(stranger.id && now());
});

test('a room made when members were runs keeps only the members that are agents now', () => {
  const { desk, store, dara, room } = setup();
  store.put('room', room.id, { ...store.get('room', room.id), members: ['an-old-run-id', dara.id] });
  desk.rooms.cleanup();
  assert.deepEqual(store.get('room', room.id).members, [dara.id]);
});

test('a room can be renamed, given a picture and deleted with its messages', async () => {
  const { desk, store, room } = setup();
  await desk.rooms.post(room.id, { text: 'hello' });
  assert.equal(desk.rooms.rename(room.id, '  Billing bug  ').name, 'Billing bug');
  assert.throws(() => desk.rooms.rename(room.id, '   '), /Name the room/);
  assert.equal(desk.rooms.setImage(room.id, `${room.id}.png`).image, `${room.id}.png`);
  assert.ok(desk.rooms.messages(room.id).length > 0);
  desk.rooms.remove(room.id);
  assert.equal(store.get('room', room.id), undefined);
  assert.equal(store.list('roommsg').filter(item => item.roomId === room.id).length, 0);
});

test('the main agent can be added to a room as @main, and answers there from its own session', async () => {
  const { desk, store, turns, room } = setup({ replies: ['I can route this to Dara.'] });
  desk.rooms.addMember(room.id, 'main');
  assert.ok(desk.rooms.room(room.id).members.includes('main'));
  assert.ok(!desk.specialists.list().some(agent => agent.id === 'main'), 'the main agent is not listed as a project agent');
  await desk.rooms.post(room.id, { text: '@main who should take the cart bug?' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.id === 'main'));
  assert.equal(turns[0].run.role, 'coordinator'); assert.equal(turns[0].run.main, true);
  assert.match(desk.rooms.messages(room.id).find(item => item.from.id === 'main').text, /route this to Dara/);
  assert.equal(desk.rooms.member('main').name, 'Main agent');
  assert.ok(store.get('specialist', 'main'));
});

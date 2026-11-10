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
  await waitFor(() => turns.length === 1);
  assert.equal(turns[0].run.roomAgent, 'main', 'a message that names nobody goes to the main agent');
  assert.ok(desk.rooms.room(room.id).members.includes('main'), 'the main agent joined the room');
  await desk.rooms.post(room.id, { text: '@dara can you look at #49760?' });
  await waitFor(() => turns.some(item => item.run.specialistId === dara.id));
  const asked = turns.find(item => item.run.specialistId === dara.id);
  assert.equal(asked.run.role, 'specialist');
  assert.match(asked.prompt, /You are Dara, the specialist agent for the project "shop"/);
  assert.match(asked.prompt, /Morning everyone/);
  assert.match(asked.prompt, /#49760 Cart total is wrong/); assert.ok(!asked.prompt.includes('장바구니'), 'the task is named in English');
  assert.match(asked.prompt, /Ask before schema changes\./);
});

test('what an agent says in its turn is posted to the room, and its session is kept for the next mention', async () => {
  const { desk, store, turns, dara, vanna, room } = setup({ replies: ['The discount is applied after tax. **Looks like a bug.**', 'Still on it.'] });
  await desk.rooms.post(room.id, { text: '@dara what is wrong with the cart?' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.type === 'agent'));
  const reply = desk.rooms.messages(room.id).find(item => item.from.type === 'agent');
  assert.equal(reply.from.label, 'Dara'); assert.match(reply.text, /Looks like a bug/); assert.deepEqual(reply.to, ['you']);
  const firstRun = store.get('specialist', dara.id).roomRunId; assert.ok(firstRun);
  await desk.rooms.post(room.id, { text: '@vanna did you see that?' });
  await waitFor(() => turns.length === 2);
  await desk.rooms.post(room.id, { text: '@dara and now?' });
  await waitFor(() => turns.length === 3);
  assert.equal(store.get('specialist', dara.id).roomRunId, firstRun, 'one room session per agent, for every room');
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
  await waitFor(() => turns.some(item => item.run.specialistId === dara.id));
  const asked = turns.find(item => item.run.specialistId === dara.id);
  assert.match(asked.prompt, /News from your other rooms/); assert.match(asked.prompt, /\[Billing sync\]/); assert.match(asked.prompt, /invoice export is failing/);
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

test('a task given in a room is done by the agent right there, in its room session, with no separate run', async () => {
  const { desk, store, turns, dara, room } = setup({ replies: ['On it. Making a worktree for #49760.'] });
  const directory = store.get('specialist', dara.id).projectPath;
  store.put('config', 'main', { ...store.config(), branchPrefix: 'temp/rex', repositories: [{ id: 'repository-1', name: 'shop', path: directory, baseBranch: 'develop', targetBranch: 'develop' }] });
  const result = await desk.assignTask({ specialistId: dara.id, taskId: 't1', roomId: room.id });
  assert.deepEqual(result, { inRoom: true, agentId: dara.id, roomId: room.id, taskId: 't1' });
  assert.ok(!store.list('run').some(run => run.role === 'worker'), 'no separate task run');
  assert.ok(desk.rooms.messages(room.id).some(item => item.from.type === 'system' && /Dara is now working on #49760 Cart total is wrong here in the room/.test(item.text)));
  await waitFor(() => turns.some(item => item.run.roomAgent === dara.id && item.prompt.includes('gave you this task')));
  const prompt = turns.find(item => item.run.roomAgent === dara.id && item.prompt.includes('gave you this task')).prompt;
  assert.match(prompt, /gave you this task to do here in the room: #49760 Cart total is wrong/);
  assert.ok(prompt.includes('-b temp/rex/49760-cart-total-is-wrong develop'), `the worktree branch follows the naming rules: ${prompt.slice(prompt.indexOf('git worktree add'), prompt.indexOf('git worktree add') + 160)}`);
  assert.match(prompt, /Never change the main checkout/);
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.id === dara.id && /Making a worktree/.test(item.text)));
  assert.equal(store.get('task', 't1').roomWork.agentId, dara.id);
  assert.ok(desk.rooms.taskOwners().some(line => /#49760 Cart total is wrong: Dara .*working in the room/.test(line)));
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
  assert.equal(turns[0].run.role, 'coordinator'); assert.equal(turns[0].run.roomAgent, 'main'); assert.ok(!turns[0].run.main, 'the room session is not the main chat');
  assert.match(desk.rooms.messages(room.id).find(item => item.from.id === 'main').text, /route this to Dara/);
  assert.equal(desk.rooms.member('main').name, 'Rex Agent'); assert.equal(desk.rooms.member('main').handle, 'rex', '@rex, and the old @main still reaches it');
  assert.ok(store.get('specialist', 'main'));
});

test('an agent keeps its personal chat apart from its room session, and the room session can read the personal chat', async () => {
  const { desk, store, turns, dara, room } = setup({ replies: ['Room answer.', 'Personal answer.'] });
  await desk.rooms.post(room.id, { text: '@dara status of the cart?' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.type === 'agent'));
  await desk.specialistTurn(dara.id, { prompt: 'Just between us: how are you?' });
  await waitFor(() => turns.length === 2);
  const agent = store.get('specialist', dara.id);
  assert.ok(agent.runId && agent.roomRunId && agent.runId !== agent.roomRunId, 'two separate sessions');
  assert.equal(turns[1].run.id, agent.runId); assert.ok(!turns[1].run.roomAgent);
  const personal = store.events(agent.runId, { visible: true }).map(event => event.text || '').join(' ');
  assert.ok(!personal.includes('status of the cart'), 'room messages never land in the personal chat');
  await waitFor(() => desk.personalChat(dara.id).some(item => item.text === 'Personal answer.'));
  assert.ok(!desk.rooms.messages(room.id).some(item => /Personal answer/.test(item.text)), 'a personal reply is not posted to the room');
});

test('each session of an agent is told what happened in the other one since it last looked', async () => {
  const { desk, turns, dara, room } = setup({ replies: ['Room reply.', 'Personal reply.', 'Room again.'] });
  await desk.rooms.post(room.id, { text: '@dara the cart total is wrong' });
  await waitFor(() => turns.length === 1);
  await desk.specialistTurn(dara.id, { prompt: 'Privately: I think it is the tax step.' });
  await waitFor(() => turns.length === 2);
  assert.match(turns[1].prompt, /Meanwhile in your group chats:\n\[Checkout bug\]/); assert.match(turns[1].prompt, /the cart total is wrong/);
  await waitFor(() => desk.personalChat(dara.id).some(item => item.text === 'Personal reply.'));
  await desk.rooms.post(room.id, { text: '@dara any idea?' });
  await waitFor(() => turns.length === 3);
  assert.match(turns[2].prompt, /Meanwhile in your personal chat with the person:/); assert.match(turns[2].prompt, /I think it is the tax step/);
  await desk.specialistTurn(dara.id, { prompt: 'and now?' });
  await waitFor(() => turns.length === 4);
  assert.ok(!/the cart total is wrong/.test(turns[3].prompt), 'what was already seen is not repeated');
});

test('an agent is told who else is answering in the room, with their handles, and to build on their replies', async () => {
  const { desk, store, turns, dara, vanna, room } = setup();
  store.put('run', 'busy-vanna', { id: 'busy-vanna', role: 'specialist', specialistId: vanna.id, roomAgent: vanna.id, state: 'running', createdAt: now() });
  desk.rooms.quietLimit = 300; // Vanna never finishes here, so Dara waits only briefly
  await desk.rooms.post(room.id, { text: '@dara what do you think?' });
  await waitFor(() => turns.some(item => item.run.specialistId === dara.id));
  const asked = turns.find(item => item.run.specialistId === dara.id).prompt;
  assert.match(asked, /Vanna \(@vanna, billing\)/);
  assert.match(asked, /Also working in this room right now: Vanna \(Replying in a room…\)/);
  assert.match(asked, /read desk_room_history for what they just posted/);
});

test('an agent that mentions another agent in its reply gets that agent to answer in the room', async () => {
  const { desk, turns, vanna, room } = setup({ replies: ['@vanna can you check the invoice side?', 'Invoices look fine.'] });
  await desk.rooms.post(room.id, { text: '@dara is billing involved?' });
  await waitFor(() => turns.some(item => item.run.specialistId === vanna.id));
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.label === 'Vanna' && /Invoices look fine/.test(item.text)));
  assert.ok(desk.rooms.messages(room.id).find(item => item.from.label === 'Dara').to.includes(vanna.id));
});

test('@all from the person wakes every agent in the room, and a Rex Desk task is mentioned as #L1', async () => {
  const { desk, turns, dara, vanna, room } = setup();
  const task = desk.localTasks.create({ title: 'Plan the checkout redesign' });
  await desk.rooms.post(room.id, { text: `@all please read #${task.taskNumber}` });
  await waitFor(() => turns.some(item => item.run.specialistId === dara.id) && turns.some(item => item.run.specialistId === vanna.id));
  assert.ok(!turns.some(item => item.run.roomAgent === 'main'), 'the main agent was not in the room, so @all does not pull it in');
  assert.match(turns.find(item => item.run.specialistId === dara.id).prompt, /#L1 Plan the checkout redesign/);
});

test('replying to an agent message without a mention goes to that agent, and its answer quotes the reply', async () => {
  const { desk, store, turns, vanna, room } = setup({ replies: ['Billing looks fine.', 'Yes, the cron runs at 2am.'] });
  await desk.rooms.post(room.id, { text: '@vanna is billing ok?' });
  await waitFor(() => store.list('roommsg').some(item => item.from.id === vanna.id));
  const answer = store.list('roommsg').find(item => item.from.id === vanna.id);
  const reply = await desk.rooms.post(room.id, { text: 'does the cron still run?', replyTo: answer.id });
  assert.deepEqual(reply.delivered.filter(id => id !== 'you'), [vanna.id], 'the reply is for Vanna, not the main agent');
  await waitFor(() => turns.filter(item => item.run.specialistId === vanna.id).length >= 2);
  assert.ok(!turns.some(item => item.run.roomAgent === 'main'), 'the main agent was not woken');
  await waitFor(() => store.list('roommsg').filter(item => item.from.id === vanna.id).length >= 2);
  const second = store.list('roommsg').filter(item => item.from.id === vanna.id).sort((left, right) => left.seq - right.seq)[1];
  assert.equal(second.replyTo, reply.id, "Vanna's answer is linked to the person's reply");
});

test('while another agent is typing in the room the next one waits, then reads what was just said', async () => {
  const { desk, store, turns, dara, vanna, room } = setup();
  desk.rooms.quietSettle = 50;
  store.put('run', 'typing-vanna', { id: 'typing-vanna', role: 'specialist', specialistId: vanna.id, roomAgent: vanna.id, state: 'running', createdAt: now() });
  await desk.rooms.post(room.id, { text: '@dara and what about the refunds?' });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(!turns.some(item => item.run.specialistId === dara.id), 'Dara waits while Vanna is typing');
  await desk.rooms.post(room.id, { fromAgentId: vanna.id, text: 'Refunds go through the billing queue.' });
  store.put('run', 'typing-vanna', { ...store.get('run', 'typing-vanna'), state: 'finished' });
  await waitFor(() => turns.some(item => item.run.specialistId === dara.id));
  const prompt = turns.find(item => item.run.specialistId === dara.id).prompt;
  assert.match(prompt, /Already answered after that message[\s\S]*Refunds go through the billing queue/);
});

test('an agent that already saw the room still gets the last messages as context', async () => {
  const { desk, turns, dara, room } = setup({ replies: ['First answer.', 'Second answer.'] });
  await desk.rooms.post(room.id, { text: '@dara the checkout total is wrong after a coupon' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.id === dara.id));
  await desk.rooms.post(room.id, { text: '@dara any idea why?' });
  await waitFor(() => turns.filter(item => item.run.specialistId === dara.id).length >= 2);
  const prompt = turns.filter(item => item.run.specialistId === dara.id)[1].prompt;
  assert.match(prompt, /The conversation so far[\s\S]*checkout total is wrong after a coupon[\s\S]*First answer\./);
});

test('a message for an agent that is working is handed to it between steps, once', async () => {
  const { desk, store, vanna, room } = setup();
  store.put('run', 'vanna-room', { id: 'vanna-room', role: 'specialist', specialistId: vanna.id, roomAgent: vanna.id, state: 'running', createdAt: now() });
  store.put('specialist', vanna.id, { ...store.get('specialist', vanna.id), roomRunId: 'vanna-room' });
  desk.live.set('vanna-room', { runner: { interrupt() {} } });
  desk.rooms.quietSettle = 10;
  await desk.rooms.post(room.id, { text: '@vanna stop, use Sydney not Seoul' });
  await waitFor(() => (store.get('run', 'vanna-room').queued || []).length === 1);
  assert.equal(store.get('run', 'vanna-room').queued[0], '[Room "Checkout bug"] The person → you: @vanna stop, use Sydney not Seoul');
  assert.match(desk.takeInbox('vanna-room'), /use Sydney not Seoul/);
  assert.equal(desk.takeInbox('vanna-room'), '', 'handed over once, not again when the turn ends');
  assert.deepEqual(store.get('run', 'vanna-room').queued, []);
  desk.live.delete('vanna-room');
});

test('away mode: the lead plans without the person, check-ins come on schedule, and writing in the room ends it with a summary', async () => {
  const { desk, store, turns, dara, vanna, room } = setup({ replies: ['@vanna please check the invoices.', 'Invoices checked.', 'All done for now.', 'While you were away: invoices checked. Waiting for you: nothing.'] });
  desk.rooms.quietSettle = 10;
  desk.rooms.setAway(room.id, { on: true, every: 5, goal: 'Fix the cart total' });
  await waitFor(() => turns.some(item => item.run.specialistId === dara.id));
  const plan = turns.find(item => item.run.specialistId === dara.id).prompt;
  assert.match(plan, /turned on away mode and left\. Goal: Fix the cart total/);
  assert.match(plan, /The person is away until they come back[\s\S]*do not wait for the person/);
  assert.ok(desk.rooms.messages(room.id).some(item => item.from.type === 'system' && /Away mode on/.test(item.text)));
  assert.ok(!desk.rooms.messages(room.id).some(item => item.from.type === 'human'), 'nothing is posted as the person');
  await waitFor(() => turns.some(item => item.run.specialistId === vanna.id));
  // A quiet room gets a check-in once its interval has passed.
  await waitFor(() => !['replying', 'busy'].includes(desk.rooms.member(dara.id).state) && !['replying', 'busy'].includes(desk.rooms.member(vanna.id).state));
  const before = turns.length;
  store.put('room', room.id, { ...desk.rooms.room(room.id), away: { ...desk.rooms.room(room.id).away, lastTick: Date.now() - 6 * 60000 } });
  await desk.rooms.awayTick();
  await waitFor(() => turns.length > before);
  assert.match(turns.at(-1).prompt, /Away check-in/);
  // The person writes: away ends and the lead sums up.
  await desk.rooms.post(room.id, { text: 'I am back, what happened?' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.type === 'system' && /writing what happened while you were away/.test(item.text)));
  assert.equal(desk.rooms.room(room.id).away.on, false);
  assert.ok(desk.rooms.messages(room.id).some(item => item.from.type === 'system' && item.text === 'Away mode off: you are back.'));
});

test('away mode on auto timing: the lead sets when it checks in next', async () => {
  const { desk, room, dara } = setup({ replies: ['Plan: finish the cart fix. Next check-in: 2 hours'] });
  desk.rooms.quietSettle = 10;
  desk.rooms.setAway(room.id, { on: true, every: 'auto' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.id === dara.id));
  assert.equal(desk.rooms.room(room.id).away.every, 'auto');
  assert.equal(desk.rooms.room(room.id).away.nextMinutes, 120);
});

test('a mention counts in bold, before a colon or a full stop, and inside brackets, but not inside an email address', () => {
  const { desk, dara, vanna, room } = setup();
  const who = text => desk.rooms.mentionsIn(desk.rooms.room(room.id), text).sort();
  assert.deepEqual(who('1. **@dara:** start now.'), [dara.id]);
  assert.deepEqual(who('Thanks @vanna.'), [vanna.id]);
  assert.deepEqual(who('(@dara) and [@vanna], please'), [dara.id, vanna.id].sort());
  assert.deepEqual(who('write to me@dara.com'), []);
});

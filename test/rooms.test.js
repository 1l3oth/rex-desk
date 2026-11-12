import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
  const firstRun = store.get('specialist', dara.id).roomRuns[room.id]; assert.ok(firstRun);
  await desk.rooms.post(room.id, { text: '@vanna did you see that?' });
  await waitFor(() => turns.length === 2);
  await desk.rooms.post(room.id, { text: '@dara and now?' });
  await waitFor(() => turns.length === 3);
  assert.equal(store.get('specialist', dara.id).roomRuns[room.id], firstRun, 'the room keeps its session for the next mention');
  assert.equal(turns[2].run.id, firstRun);
  assert.match(turns[2].prompt, /Vanna: |The person: @vanna did you see that/, 'the second mention carries what happened since the agent last looked');
  assert.ok(!/You are Dara, the specialist agent/.test(turns[2].prompt), 'a resumed session is given only what is new');
  assert.ok(vanna.id);
});

test('what is said in one group chat never reaches another: each room has its own session and prompt', async () => {
  const { desk, store, turns, dara, vanna, room } = setup();
  const other = desk.rooms.create('Billing sync', [dara.id, vanna.id]);
  await desk.rooms.post(other.id, { text: '@dara the invoice export is failing on refunds' });
  await waitFor(() => turns.some(item => item.run.roomOf === other.id));
  await desk.rooms.post(room.id, { text: '@dara anything I should know?' });
  await waitFor(() => turns.some(item => item.run.roomOf === room.id));
  const asked = turns.find(item => item.run.roomOf === room.id), billing = turns.find(item => item.run.roomOf === other.id);
  assert.ok(!/invoice export|Billing sync/.test(asked.prompt), 'no news from the other room');
  assert.match(asked.prompt, /never bring up what was said in another group chat/);
  const sessions = store.get('specialist', dara.id).roomRuns;
  assert.ok(sessions[room.id] && sessions[other.id] && sessions[room.id] !== sessions[other.id], 'one session per room');
  assert.notEqual(asked.run.id, billing.run.id);
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
  assert.deepEqual(result, { inRoom: true, taskId: 't1', roomId: room.id, lead: 'Dara', team: ['Dara'] });
  assert.ok(!store.list('run').some(run => run.role === 'worker'), 'no separate task run');
  assert.ok(desk.rooms.messages(room.id).some(item => item.from.type === 'system' && /Dara is now working on #49760 Cart total is wrong here in the room/.test(item.text)));
  await waitFor(() => turns.some(item => item.run.roomAgent === dara.id && item.prompt.includes('gave you this task')));
  const prompt = turns.find(item => item.run.roomAgent === dara.id && item.prompt.includes('gave you this task')).prompt;
  assert.match(prompt, /gave you this task to do here in the room: #49760 Cart total is wrong/);
  assert.ok(prompt.includes('branch temp/rex/49760-cart-total-is-wrong from develop'), 'the branch follows the naming rules');
  assert.match(prompt, /the way the person says/);
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
  assert.ok(agent.runId && agent.roomRuns?.[room.id] && agent.runId !== agent.roomRuns[room.id], 'two separate sessions');
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

test('an agent that already saw the room is sent only what is new, not the history its session already holds', async () => {
  const { desk, turns, dara, room } = setup({ replies: ['First answer.', 'Second answer.'] });
  await desk.rooms.post(room.id, { text: '@dara the checkout total is wrong after a coupon' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.id === dara.id));
  await desk.rooms.post(room.id, { text: '@dara any idea why?' });
  await waitFor(() => turns.filter(item => item.run.specialistId === dara.id).length >= 2);
  const second = turns.filter(item => item.run.specialistId === dara.id)[1].prompt;
  assert.ok(!second.includes('checkout total is wrong after a coupon'), 'the earlier message is not sent again');
  assert.match(second, /any idea why?/);
});

test('a message for an agent that is working is handed to it between steps, once', async () => {
  const { desk, store, vanna, room } = setup();
  store.put('run', 'vanna-room', { id: 'vanna-room', role: 'specialist', specialistId: vanna.id, roomAgent: vanna.id, state: 'running', createdAt: now() });
  store.put('specialist', vanna.id, { ...store.get('specialist', vanna.id), roomRuns: { [room.id]: 'vanna-room' } });
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

test('away check-ins skip a quiet room and wait longer each time, and room chat runs on Sonnet unless saving is off', async () => {
  const { desk, store, turns, dara, room } = setup({ replies: ['Plan done. Next check-in: 10 minutes'] });
  desk.rooms.quietSettle = 10;
  desk.rooms.setAway(room.id, { on: true, every: 10 });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.id === dara.id));
  await waitFor(() => !['replying', 'busy'].includes(desk.rooms.member(dara.id).state));
  const before = turns.length;
  store.put('room', room.id, { ...desk.rooms.room(room.id), away: { ...desk.rooms.room(room.id).away, lastTick: Date.now() - 11 * 60000 } });
  await desk.rooms.awayTick();
  assert.equal(turns.length, before, 'nothing happened since the last check-in, so the lead is not woken');
  assert.equal(desk.rooms.room(room.id).away.idle, 1);
  const roomRun = store.list('run').find(run => run.roomAgent === dara.id);
  assert.equal(desk.saverModel(roomRun), 'sonnet');
  store.saveConfig({ ...store.publicConfig(), saver: false });
  assert.equal(desk.saverModel(roomRun), '');
});

test('an agent shares test evidence: it is posted in its room, kept on the task and shown in the chat', async () => {
  const { store, desk, turns, dara, room } = setup();
  await desk.rooms.post(room.id, { text: '@dara can you look at #49760?' });
  await waitFor(() => turns.some(item => item.run.specialistId === dara.id));
  const roomRun = store.get('run', store.get('specialist', dara.id).roomRuns[room.id]);
  store.put('task', 't1', { ...store.get('task', 't1'), roomWork: { agentId: dara.id, roomId: room.id, at: now() } });
  const shot = path.join(temporary('shot'), 'after fix.png'); writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const shared = desk.shareEvidence(roomRun.id, { file: shot, title: 'Cart total after the fix', result: 'passed', note: 'Discount applied in the total.' });
  assert.equal(shared.taskId, 't1', 'the task the agent works on in the room');
  assert.equal(shared.where, 'room');
  const artifact = store.list('artifact').find(item => item.runId === roomRun.id);
  assert.equal(artifact.taskId, 't1'); assert.equal(artifact.result, 'passed'); assert.equal(artifact.type, 'image/png');
  await waitFor(() => desk.rooms.messages(room.id).some(item => /Test evidence for #49760: Cart total after the fix/.test(item.text)));
  assert.ok(desk.rooms.messages(room.id).some(item => item.text.includes(`![Cart total after the fix](${shared.url})`)), 'the picture is in the room message');
  assert.throws(() => desk.shareEvidence(roomRun.id, { file: path.join(path.dirname(shot), 'missing.png'), title: 'x' }), /No file at/);
  const script = path.join(path.dirname(shot), 'run.exe'); writeFileSync(script, 'x');
  assert.throws(() => desk.shareEvidence(roomRun.id, { file: script, title: 'x' }), /Share a picture/);
});

test('/clear writes a handoff, and the next message starts a fresh session that reads it first', async () => {
  const { store, desk, turns, dara } = setup({ replies: ['The cart bug is in totals.js.'] });
  await desk.specialistTurn(dara.id, { prompt: 'Where is the cart bug?' });
  await waitFor(() => turns.length === 1 && store.get('run', store.get('specialist', dara.id).runId)?.state === 'finished');
  const runId = store.get('specialist', dara.id).runId;
  assert.ok(store.get('run', runId).sessionId, 'the first turn made a session');
  const { handoff } = await desk.freshStart(runId);
  assert.match(readFileSync(handoff, 'utf8'), /The cart bug is in totals\.js/);
  assert.equal(store.get('run', runId).sessionId, undefined, 'the session is dropped');
  await desk.specialistTurn(dara.id, { prompt: 'Fix it now.' });
  await waitFor(() => turns.length === 2);
  assert.match(turns[1].prompt, /read the handoff .*\.md with the Read tool/);
  assert.match(turns[1].prompt, /Fix it now\./);
  assert.match(turns[1].prompt, /You are Dara/, 'a fresh session gets its whole identity again');
});

test('a model the Claude account cannot use: the turn runs again on the default model and the agent drops it', async () => {
  const { store, desk, dara } = setup(); const seen = [];
  store.put('specialist', dara.id, { ...store.get('specialist', dara.id), model: 'claude-opus-5-5' });
  desk.runnerFactory = options => ({ start: async () => { seen.push(options.model); if (seen.length === 1) throw new Error("There's an issue with the selected model (Opus 5.5). It may not exist or you may not have access to it."); options.event('session', { sessionId: SESSION }); options.event('agent-text', { text: 'Hello' }); }, interrupt() {}, close() {} });
  await desk.specialistTurn(dara.id, { prompt: 'Hi' });
  await waitFor(() => seen.length === 2);
  assert.equal(seen[1], undefined, 'the second try uses the account default');
  assert.equal(store.get('specialist', dara.id).model, '', 'the agent no longer asks for that model');
});

test('an agent shows an explanation page of its changes in the chat, and only HTML counts as a page', async () => {
  const { store, desk, turns, dara } = setup({ replies: ['Done.'] });
  await desk.specialistTurn(dara.id, { prompt: 'Explain your changes' });
  await waitFor(() => turns.length === 1);
  const runId = store.get('specialist', dara.id).runId, folder = temporary('page');
  const page = path.join(folder, 'code-explainer-cart.html'); writeFileSync(page, '<!doctype html><p>Cart fix</p>');
  const shown = desk.shareEvidence(runId, { file: page, title: 'Cart total fix', note: 'The discount is now in the total.', page: true });
  assert.equal(shown.where, 'chat');
  assert.ok(store.list('artifact').find(item => item.runId === runId && item.page), 'kept as a page');
  assert.ok(store.events(runId, { visible: true }).some(event => event.kind === 'message' && event.text.includes(`[Open the explanation](${shown.url})`)));
  const shot = path.join(folder, 'a.png'); writeFileSync(shot, 'x');
  assert.throws(() => desk.shareEvidence(runId, { file: shot, title: 'x', page: true }), /\.html file/);
});

test('each reply shows the tokens it used: on the run and under the agent\'s room message', async () => {
  const { store, desk, dara, room } = setup();
  desk.runnerFactory = options => ({ start: async () => { options.event('session', { sessionId: SESSION }); options.event('agent-text', { text: 'On it.' }); options.event('agent-result', { subtype: 'success', tokens: { input: 1200, output: 340, cacheRead: 45000, cacheWrite: 800 }, steps: 3 }); }, interrupt() {}, close() {} });
  await desk.rooms.post(room.id, { text: '@dara status?' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.id === dara.id && item.tokens));
  const reply = desk.rooms.messages(room.id).find(item => item.from.id === dara.id);
  assert.deepEqual(reply.tokens, { input: 1200, output: 340, cacheRead: 45000, cacheWrite: 800, steps: 3, at: reply.tokens.at });
  const run = store.get('run', store.get('specialist', dara.id).roomRuns[room.id]);
  assert.equal(run.tokensTotal.output, 340);
});

test('every agent is told to explain with eli5 picture pages and to show code changes with an explainer page', async () => {
  const { desk, turns } = setup();
  await desk.rooms.post(room0(desk), { text: 'Morning' });
  await waitFor(() => turns.length === 1);
  assert.match(turns[0].prompt, /explain like they are five/);
  assert.match(turns[0].prompt, /desk_show_page/);
});
function room0(desk) { return desk.store.list('room')[0].id; }

test('each agent runs its own loop: it checks its tasks on schedule, skips when nothing changed, and can take a task itself', async () => {
  const { store, desk, turns, dara } = setup();
  store.put('specialist', dara.id, { ...store.get('specialist', dara.id), taskSources: ['local'] });
  assert.equal(desk.specialists.loopOf(store.get('specialist', dara.id)).on, true, 'on by default');
  const created = desk.localTasks.create({ title: 'Fix the cart total', project: 'shop' });
  assert.ok(desk.specialists.ownTasks(store.get('specialist', dara.id)).some(task => task.id === created.id));
  await desk.loopTick(Date.now(), { memory: false });
  await waitFor(() => turns.some(turn => /Loop check/.test(turn.prompt)));
  const loopTurn = turns.find(turn => /Loop check/.test(turn.prompt));
  assert.match(loopTurn.prompt, /desk_take_task/); assert.match(loopTurn.prompt, /shop workflow/);
  assert.ok(!store.events(loopTurn.run.id, { visible: true }).some(event => event.kind === 'human-message' && /Loop check/.test(event.text)), 'the loop prompt is not shown as the person talking');
  await waitFor(() => desk.specialists.status(store.get('specialist', dara.id)).state === 'idle');
  const count = turns.length;
  await desk.loopTick(Date.now() + 61 * 60000, { memory: false });
  assert.equal(turns.length, count, 'nothing changed, so the next check does not wake the agent');
  desk.specialists.update(dara.id, { loop: { on: false, every: 15 } });
  assert.equal(store.get('specialist', dara.id).loop.every, 15);
});

test('a task on a project with its own agent goes to that agent, never to a new run; in a room it is done in the room', async () => {
  const { store, desk, dara, room } = setup();
  store.put('task', 't1', { ...store.get('task', 't1'), sourceId: 'src-mm' });
  store.put('specialist', dara.id, { ...store.get('specialist', dara.id), taskSources: ['src-mm'] });
  store.put('run', 'main-room', { id: 'main-room', role: 'coordinator', roomAgent: 'main', state: 'running', createdAt: now(), roomTurn: { roomId: room.id, messageId: '' } });
  const given = await desk.dispatch('main-room', { taskId: 't1' });
  assert.deepEqual(given.team, ['Dara'], 'the project agent gets it in the room, no new run');
  assert.ok(!store.list('run').some(run => run.role === 'worker'));
  store.put('run', 'dara-room', { id: 'dara-room', role: 'specialist', specialistId: dara.id, roomAgent: dara.id, state: 'running', createdAt: now(), roomTurn: { roomId: room.id } });
  const joined = await desk.dispatch('dara-room', { taskId: 't1' });
  assert.deepEqual(joined.team, ['Dara'], 'in a room the agent takes it right there, no new run');
});

test('a sub-agent an agent starts shows as its own steps: noted in the room, and its words never post as the agent\'s reply', async () => {
  const { store, desk, dara, room } = setup();
  desk.runnerFactory = options => ({ start: async () => {
    options.event('session', { sessionId: SESSION });
    options.event('agent-tool', { id: 'tu1', tool: 'Agent', input: { description: 'Review the cart fix', type: 'qa-reviewer', model: 'opus', prompt: 'Review it' } });
    options.event('agent-tool', { id: 'tu2', tool: 'Read', parent: 'tu1', input: { file_path: 'cart.js' } });
    options.event('subagent-text', { parent: 'tu1', text: 'APPROVE: looks right.' });
    options.event('subagent-done', { id: 'tu1', failed: false, text: 'APPROVE: looks right.' });
    options.event('agent-text', { text: 'The reviewer approved it.' });
  }, interrupt() {}, close() {} });
  await desk.rooms.post(room.id, { text: '@dara review it' });
  await waitFor(() => desk.rooms.messages(room.id).some(item => item.from.id === dara.id));
  const texts = desk.rooms.messages(room.id).map(item => item.text);
  assert.ok(texts.some(text => /Dara started a sub-agent \(qa-reviewer, opus\): Review the cart fix/.test(text)));
  assert.ok(texts.some(text => /sub-agent finished: Review the cart fix/.test(text)));
  assert.ok(!desk.rooms.messages(room.id).some(item => item.from.id === dara.id && /APPROVE/.test(item.text)), 'the sub-agent\'s words stay in its card');
  const runId = store.get('specialist', dara.id).roomRuns[room.id];
  assert.ok(store.events(runId, { visible: true }).some(event => event.kind === 'subagent-done'), 'the chat can show the card');
});

test('an agent who @mentions someone who is not in the room is told so, with where that agent is', async () => {
  const { desk, dara, vanna, room } = setup();
  const other = desk.rooms.create('Billing', [vanna.id]);
  desk.rooms.removeMember(room.id, vanna.id);
  await desk.rooms.post(room.id, { fromAgentId: dara.id, text: '@vanna can you check the invoice?' });
  const note = desk.rooms.messages(room.id).find(item => item.from.type === 'system' && /@vanna is not in this room/.test(item.text));
  assert.ok(note, 'a note in the room'); assert.match(note.text, /Vanna is in Billing/);
  assert.ok(other);
});

test('the person naming agents and a task assigns it to them; agents add teammates or pass it on, and nothing new is started', async () => {
  const { desk, store, dara, vanna, room } = setup({ replies: ['On it.', 'On it too.', 'Taking the tests.'] });
  await desk.rooms.post(room.id, { text: '@dara please check #49760' });
  let task = store.get('task', 't1');
  assert.equal(task.roomWork.agentId, dara.id, 'Dara leads it'); assert.deepEqual(desk.taskTeam(task), [dara.id]);
  const added = await desk.shareTask({ taskId: 't1', add: [vanna.id], from: dara.id, roomId: room.id, by: 'Dara' });
  assert.deepEqual(added.team, ['Dara', 'Vanna']);
  assert.ok(desk.rooms.messages(room.id).some(item => /Vanna joins Dara on #49760/.test(item.text)), 'the room hears who joined');
  await desk.shareTask({ taskId: 't1', pass: vanna.id, from: dara.id, roomId: room.id, by: 'Dara' });
  task = store.get('task', 't1');
  assert.equal(task.roomWork.agentId, vanna.id, 'Vanna leads it now'); assert.deepEqual(desk.taskTeam(task), [vanna.id]);
  assert.ok(!store.list('run').some(run => run.role === 'worker'), 'no separate run was started');
  assert.match(desk.rooms.promptFor(desk.rooms.room(room.id), desk.rooms.messages(room.id).at(-1), dara.id), /desk_task_team/);
});

test('the person deletes a message from a room', async () => {
  const { desk, room } = setup();
  const message = await desk.rooms.post(room.id, { text: 'typo here', to: [] });
  assert.deepEqual(desk.rooms.deleteMessage(room.id, message.id), { deleted: true });
  assert.ok(!desk.rooms.messages(room.id).some(item => item.id === message.id));
  assert.throws(() => desk.rooms.deleteMessage('other-room', message.id), /not in this room/);
});

test('a group chat made from a personal chat brings the agent and the recent talk along', async () => {
  const { desk, dara, vanna } = setup();
  const room = desk.rooms.fromChat({ agentId: dara.id, name: 'Cart fix', members: [vanna.id], history: [{ from: 'The person', text: 'The cart total is wrong', at: now() }, { from: 'Dara', text: 'It skips the discount.', at: now() }] });
  assert.deepEqual(room.members.sort(), [dara.id, vanna.id].sort());
  const texts = desk.rooms.messages(room.id).map(item => `${item.from.label}: ${item.text}`);
  assert.equal(texts[0], 'You: The cart total is wrong'); assert.equal(texts[1], 'Dara: It skips the discount.');
  assert.match(texts.at(-1), /Started from your personal chat with Dara/);
});

test('a renamed agent shows its new name on its old messages', async () => {
  const { desk, store, dara, room } = setup();
  await desk.rooms.post(room.id, { fromAgentId: dara.id, text: 'Old news', to: [] });
  store.put('specialist', dara.id, { ...store.get('specialist', dara.id), name: 'Sokha' });
  assert.equal(desk.rooms.messages(room.id).find(item => item.text === 'Old news').from.label, 'Sokha');
});

test('Rex Agent in a group chat gets its own instructions, not the old issue dispatcher', () => {
  const { desk, room } = setup();
  const text = desk.prompt({ id: 'main-room', role: 'coordinator', roomAgent: 'main', roomOf: room.id, taskIds: [] });
  assert.match(text, /You are the main agent of Rex Desk/);
  assert.ok(!/selected IDs/.test(text));
});

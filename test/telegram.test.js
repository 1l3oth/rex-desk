import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { TelegramBridge as Bridge, telegramLink, splitReply, hideTelegramTag } from '../src/telegram.js';

// The bridge the coordinator would hold (desk.telegram), so the fake desk can start turns the way the coordinator does.
class TelegramBridge extends Bridge { constructor(desk, options) { super(desk, options); desk.telegram = this; } }

// A tiny in-memory stand-in for the store and coordinator the bridge talks to. encrypt/decrypt are identity, so the saved
// connector secret round-trips as JSON. desk.answer and desk.specialistTurn just record what the bridge asked them to do.
function makeDesk({ directory } = {}) {
  const records = new Map(), key = (kind, id) => `${kind}:${id}`;
  const store = {
    directory,
    list: kind => [...records.entries()].filter(([k]) => k.startsWith(`${kind}:`)).map(([, value]) => value),
    get: (kind, id) => records.get(key(kind, id)) ?? null,
    put: (kind, id, value) => { records.set(key(kind, id), value); },
    delete: (kind, id) => { records.delete(key(kind, id)); },
    encrypt: text => text, decrypt: text => text,
    config: () => ({ control: { language: 'en' } }),
    emit: () => {}, event: () => {},
  };
  const answered = [], turns = [];
  const desk = {
    store,
    answer: (id, answer) => { const it = store.get('interaction', id); if (!it || it.state !== 'pending') throw new Error('This question is no longer waiting for an answer.'); store.put('interaction', id, { ...it, state: 'answered', answer }); answered.push({ id, answer }); return { answered: true }; },
    // As the coordinator does: the turn starts with its Telegram destination (onTurnStart). The prompt is recorded with its
    // [Telegram #id] mark shown as [Telegram], since the id is random.
    specialistTurn: async (agentId, { prompt, telegram }) => {
      // prompt: as the app chat shows it (the hidden source and tag line taken out); sent: what the agent really gets.
      turns.push({ agentId, prompt: hideTelegramTag(prompt).replace(/^\[Telegram #[0-9a-f]{12}\]/, '[Telegram]') }); (desk.prompts ||= []).push(prompt);
      desk.telegram?.onTurnStart(`run-${agentId}`, `turn-${turns.length}`, telegram);
      return { id: `run-${agentId}` };
    },
    specialists: { ensureMain: () => {}, get: id => store.get('specialist', id) },
  };
  return { desk, store, answered, turns };
}

// A fake Telegram server. Records every outgoing call; sendMessage returns incrementing message ids.
function makeFetcher({ updates = [], file = null, fileBytes = Buffer.from('audio'), failFiles = 0 } = {}) {
  const sent = []; let nextId = 100;
  const fetcher = async (urlString, options) => {
    const url = new URL(urlString);
    if (url.pathname.includes('/file/bot')) { sent.push({ method: 'file', path: url.pathname }); if (failFiles > 0) { failFiles -= 1; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } return { ok: true, arrayBuffer: async () => fileBytes }; }
    const method = url.pathname.split('/').pop();
    const body = options?.body ? JSON.parse(options.body) : {};
    sent.push({ method, body });
    if (method === 'getUpdates') return { ok: true, json: async () => ({ ok: true, result: updates }) };
    if (method === 'getFile') return { ok: true, json: async () => ({ ok: true, result: file || { file_path: 'voice/file_1.oga' } }) };
    if (method === 'sendMessage') return { ok: true, json: async () => ({ ok: true, result: { message_id: ++nextId, chat: body } }) };
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  return { fetcher, sent };
}

function linkedStore(store, values = { botToken: 'T:tok', chatId: 555, chatName: 'Rex' }) {
  store.put('connector', 'telegram-1', { id: 'telegram-1', connectorId: 'telegram', name: 'Telegram @rexbot', kind: 'token', at: '2026-11-24T00:00:00.000Z' });
  store.put('secret', 'connector:telegram-1', store.encrypt(JSON.stringify(values)));
}

test('link: only the chat that sends the one-time pairing code is linked, and the code is used up', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store, { botToken: 'T:tok' }); // token saved, not linked yet
  const first = makeFetcher({ updates: [] });
  const bridge = new TelegramBridge(desk, { fetcher: first.fetcher });
  const asked = await bridge.link();
  assert.equal(asked.linked, false); assert.match(asked.code, /^[A-Z2-9]{6}$/);
  assert.equal(first.sent.length, 0, 'the first press only makes a code');

  // A stranger pressing Start (or guessing) is not linked, even if their message is the newest.
  const stranger = makeFetcher({ updates: [
    { update_id: 7, message: { message_id: 1, chat: { id: 555, type: 'private', first_name: 'Rex' }, text: `/start ${asked.code}` } },
    { update_id: 8, message: { message_id: 2, chat: { id: 666, type: 'private', first_name: 'Stranger' }, text: '/start' } },
    { update_id: 9, message: { message_id: 3, chat: { id: 777, type: 'private', first_name: 'Guess' }, text: 'ABC234' } },
  ] });
  bridge.fetcher = stranger.fetcher;
  const done = await bridge.link();
  assert.deepEqual([done.linked, done.name], [true, 'Rex']);
  const values = JSON.parse(store.decrypt(store.get('secret', 'connector:telegram-1')));
  assert.equal(values.chatId, 555); assert.equal(values.chatName, 'Rex');
  assert.equal(values.pairCode, undefined, 'the code is used up');
  assert.equal(store.get('telegram', 'state').offset, 8, 'only up to the code is used up; what came after stays for the poll loop');
});

test('link: no code match means no link; an expired code is replaced', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store, { botToken: 'T:tok', pairCode: 'OLDOLD', pairUntil: Date.now() - 1000 });
  const only = makeFetcher({ updates: [{ update_id: 1, message: { message_id: 1, chat: { id: 666, type: 'private', first_name: 'Stranger' }, text: '/start OLDOLD' } }] });
  const bridge = new TelegramBridge(desk, { fetcher: only.fetcher });
  const fresh = await bridge.link();
  assert.equal(fresh.linked, false); assert.notEqual(fresh.code, 'OLDOLD');
  const again = await bridge.link();
  assert.equal(again.linked, false, 'the stranger sent the expired code, not the new one');
  assert.equal(JSON.parse(store.get('secret', 'connector:telegram-1')).chatId, undefined);
});

test('relink while polling: the pending code in the running loop moves the link; other chats are still ignored', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const { code } = await bridge.link();
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 666, type: 'private', first_name: 'Stranger' }, text: '/start' } }, telegramLink(store));
  assert.equal(JSON.parse(store.get('secret', 'connector:telegram-1')).chatId, 555);
  assert.equal(turns.length, 0);
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 888, type: 'private', first_name: 'New' }, text: code.toLowerCase() } }, telegramLink(store));
  const values = JSON.parse(store.get('secret', 'connector:telegram-1'));
  assert.deepEqual([values.chatId, values.chatName, values.pairCode], [888, 'New', undefined]);
  assert.equal(sent.at(-1).body.chat_id, 888);
  assert.equal(turns.length, 0, 'the code is never routed to an agent');
});

test('an agent texts the person: the message is prefixed with the agent name and recorded for reply routing', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store);
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  await bridge.sendFromAgent('web', 'Web Agent', 'build is green');
  const call = sent.find(item => item.method === 'sendMessage');
  assert.equal(call.body.chat_id, 555);
  assert.match(call.body.text, /^Web Agent\nbuild is green/);
  const saved = store.list('tgmsg').find(item => item.kind === 'agent');
  assert.equal(saved.agentId, 'web');
});

test('sendFromAgent errors clearly when Telegram is not connected or not linked', async () => {
  const notConnected = makeDesk();
  const bridge1 = new TelegramBridge(notConnected.desk, { fetcher: makeFetcher().fetcher });
  await assert.rejects(() => bridge1.sendFromAgent('main', 'Rex Agent', 'hi'), /not connected/i);

  const unlinked = makeDesk();
  linkedStore(unlinked.store, { botToken: 'T:tok' }); // no chatId
  const bridge2 = new TelegramBridge(unlinked.desk, { fetcher: makeFetcher().fetcher });
  await assert.rejects(() => bridge2.sendFromAgent('main', 'Rex Agent', 'hi'), /not linked/i);
});

test('a desk_ask with choices goes to Telegram as answer buttons, and a button press answers it', async () => {
  const { desk, store, answered } = makeDesk();
  linkedStore(store);
  store.put('run', 'r1', { id: 'r1', main: true });
  const interaction = { id: 'i1', runId: 'r1', kind: 'question', method: 'desk', title: 'Ship it?', state: 'pending',
    request: { requestedSchema: { type: 'object', properties: { choice: { type: 'string', options: [{ label: 'Yes' }, { label: 'Not yet' }] } }, required: [] } } };
  store.put('interaction', 'i1', interaction);
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  await bridge.onAsk(interaction);
  const ask = sent.find(item => item.method === 'sendMessage');
  assert.match(ask.body.text, /Rex Agent asks:\nShip it\?/);
  assert.deepEqual(ask.body.reply_markup.inline_keyboard.map(row => row[0].callback_data), ['i1:o:0', 'i1:o:1']);
  const asked = store.list('tgmsg').find(item => item.kind === 'ask');
  assert.deepEqual([asked.interactionId, asked.field], ['i1', 'choice']);

  const found = telegramLink(store);
  await bridge.handleCallback({ id: 'cb1', data: 'i1:o:1', message: { chat: { id: 555 }, message_id: Number(asked.id) } }, found);
  assert.deepEqual(answered, [{ id: 'i1', answer: { action: 'accept', content: { choice: 'Not yet' } } }]);
});

test('a button press counts only from the linked chat, on the message that carried that question', async () => {
  const { desk, store, answered } = makeDesk();
  linkedStore(store);
  store.put('run', 'r1', { id: 'r1', main: true });
  const approval = id => ({ id, runId: 'r1', kind: 'approval', method: 'desk', title: `Push ${id}?`, state: 'pending', request: { requestedSchema: { type: 'object', properties: {} } } });
  store.put('interaction', 'a1', approval('a1')); store.put('interaction', 'a2', approval('a2'));
  const { fetcher } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  await bridge.onAsk(approval('a1')); await bridge.onAsk(approval('a2'));
  const msgOf = id => Number(store.list('tgmsg').find(item => item.interactionId === id).id);
  const found = telegramLink(store);
  // From another chat: ignored.
  await bridge.handleCallback({ id: 'x1', data: 'a1:accept', message: { chat: { id: 999 }, message_id: msgOf('a1') } }, found);
  // No original message: ignored.
  await bridge.handleCallback({ id: 'x2', data: 'a1:accept' }, found);
  // Forged data: a1's answer pressed on a2's message, or on a message Rex Desk never sent.
  await bridge.handleCallback({ id: 'x3', data: 'a1:accept', message: { chat: { id: 555 }, message_id: msgOf('a2') } }, found);
  await bridge.handleCallback({ id: 'x4', data: 'a1:accept', message: { chat: { id: 555 }, message_id: 4242 } }, found);
  assert.deepEqual(answered, []);
  // The real button on the real message in the linked chat.
  await bridge.handleCallback({ id: 'ok', data: 'a1:accept', message: { chat: { id: 555 }, message_id: msgOf('a1') } }, found);
  assert.deepEqual(answered.map(item => item.id), ['a1']);
});

test('a plain desk_ask gets no buttons and a text reply to it answers it', async () => {
  const { desk, store, answered } = makeDesk();
  linkedStore(store);
  store.put('run', 'r1', { id: 'r1', specialistId: 'web' });
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  const interaction = { id: 'q9', runId: 'r1', kind: 'question', method: 'desk', title: 'What name?', state: 'pending',
    request: { requestedSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } } };
  store.put('interaction', 'q9', interaction);
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  await bridge.onAsk(interaction);
  const ask = sent.find(item => item.method === 'sendMessage');
  assert.ok(!ask.body.reply_markup, 'no buttons for a free-text question');
  assert.match(ask.body.text, /Reply to this message/);
  const askMsgId = Number(store.list('tgmsg').find(item => item.kind === 'ask').id);
  const found = telegramLink(store);
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'Rex Desk', reply_to_message: { message_id: askMsgId } } }, found);
  assert.deepEqual(answered, [{ id: 'q9', answer: { action: 'accept', content: { answer: 'Rex Desk' } } }]);
});

test('a reply to an agent message goes into that agent chat; a message from a different chat is ignored', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  const { fetcher } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  await bridge.sendFromAgent('web', 'Web Agent', 'need your OK');
  const agentMsgId = Number(store.list('tgmsg').find(item => item.kind === 'agent').id);
  const found = telegramLink(store);
  // Wrong chat: ignored.
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 999 }, text: 'sneaky', reply_to_message: { message_id: agentMsgId } } }, found);
  assert.equal(turns.length, 0, 'a message from an unlinked chat is never routed');
  // Right chat, reply to the agent message: routed to that agent.
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: 'go ahead', reply_to_message: { message_id: agentMsgId } } }, found);
  assert.deepEqual(turns, [{ agentId: 'web', prompt: '[Telegram] go ahead' }]);
});

test('a plain non-reply message goes to Rex Agent (main) when no agent has written on Telegram yet', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  const { fetcher } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const found = telegramLink(store);
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'what is up' } }, found);
  assert.deepEqual(turns, [{ agentId: 'main', prompt: '[Telegram] what is up' }]);
  // A bot command is not routed.
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: '/start' } }, found);
  assert.equal(turns.length, 1);
});

test('voice note: transcribed when a transcriber is available, posted as audio when not', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rex-tg-'));
  // With a transcriber (no new keys needed): the text reaches the replied agent.
  const withStt = makeDesk({ directory });
  linkedStore(withStt.store);
  withStt.store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  const bridgeA = new TelegramBridge(withStt.desk, { fetcher: makeFetcher().fetcher, transcribe: async () => ({ text: 'please deploy' }) });
  await bridgeA.sendFromAgent('web', 'Web Agent', 'ready?');
  const agentMsgId = Number(withStt.store.list('tgmsg').find(item => item.kind === 'agent').id);
  await bridgeA.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, voice: { file_id: 'v1' }, reply_to_message: { message_id: agentMsgId } } }, telegramLink(withStt.store));
  assert.equal(withStt.turns.at(-1).agentId, 'web');
  assert.match(withStt.turns.at(-1).prompt, /transcribed\): please deploy/);

  // No transcriber: the audio is saved and the agent is told it was not transcribed.
  const noStt = makeDesk({ directory });
  linkedStore(noStt.store);
  const bridgeB = new TelegramBridge(noStt.desk, { fetcher: makeFetcher().fetcher, transcribe: null });
  await bridgeB.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, voice: { file_id: 'v2' } } }, telegramLink(noStt.store));
  assert.equal(noStt.turns.at(-1).agentId, 'main');
  assert.match(noStt.turns.at(-1).prompt, /not transcribed/);
});

test('stop waits for the poll loop, so nothing writes to the store after it resolves', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store);
  let polls = 0, inTurn;
  const turnStarted = new Promise(resolve => { inTurn = resolve; });
  // The agent turn for the message is slow; stop is called in the middle of it.
  desk.specialistTurn = async () => { inTurn(); await new Promise(resolve => setTimeout(resolve, 50)); };
  const fetcher = async (urlString, options) => {
    if (urlString.endsWith('/setMyCommands')) return { ok: true, json: async () => ({ ok: true, result: true }) };
    polls += 1;
    if (polls === 1) return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 41, message: { chat: { id: 555 }, text: 'hi' } }] }) };
    await new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const bridge = new TelegramBridge(desk, { fetcher });
  bridge.start();
  await turnStarted;
  let closed = false; const writes = [];
  const put = store.put; store.put = (...args) => { if (closed) writes.push(args[0]); return put(...args); };
  await bridge.stop(); closed = true;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(store.get('telegram', 'state').offset, 42, 'the handled update is saved before stop resolves');
  assert.deepEqual(writes, [], 'nothing is written after stop resolves');
  assert.equal(polls, 1, 'no new poll after stop');
});

test('stop while idling (not linked yet) resolves at once', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store, { botToken: 'T:tok' });
  const bridge = new TelegramBridge(desk, { fetcher: makeFetcher().fetcher });
  bridge.start();
  const started = Date.now(); await bridge.stop();
  assert.ok(Date.now() - started < 1000, 'the 8 s idle sleep is woken by stop');
});

test('a removed or replaced bot connection: its queued updates are dropped and its offset is not reused', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  store.put('telegram', 'state', { id: 'state', linkId: 'telegram-1', offset: 500 });
  const offsets = []; let polls = 0;
  const fetcher = async (urlString, options) => {
    if (urlString.endsWith('/setMyCommands')) return { ok: true, json: async () => ({ ok: true, result: true }) };
    const body = JSON.parse(options.body); polls += 1;
    if (polls === 1) {
      offsets.push(body.offset);
      // While this long poll waits, the person removes the connection and adds a new bot.
      store.delete('connector', 'telegram-1'); store.delete('secret', 'connector:telegram-1');
      store.put('connector', 'telegram-2', { id: 'telegram-2', connectorId: 'telegram', name: 'Telegram @newbot', kind: 'token', at: '2026-11-24T01:00:00.000Z' });
      store.put('secret', 'connector:telegram-2', JSON.stringify({ botToken: 'T:new', chatId: 555 }));
      return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 501, message: { chat: { id: 555 }, text: 'from the old bot' } }] }) };
    }
    offsets.push(body.offset);
    await new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const bridge = new TelegramBridge(desk, { fetcher });
  bridge.start();
  for (let i = 0; i < 50 && polls < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await bridge.stop();
  assert.deepEqual(turns, [], 'nothing from the old bot reaches an agent');
  assert.deepEqual(offsets, [500, 0], 'the new bot starts from its own offset, not the old one');
  assert.notEqual(store.get('telegram', 'state').linkId, 'telegram-2', 'the dropped batch saved nothing for the new bot');
});

test('a reply or button on a message sent through an old connection is not acted on', async () => {
  const { desk, store, answered, turns } = makeDesk();
  linkedStore(store);
  store.put('run', 'r1', { id: 'r1', main: true });
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  const approval = { id: 'a1', runId: 'r1', kind: 'approval', method: 'desk', title: 'Push?', state: 'pending', request: { requestedSchema: { type: 'object', properties: {} } } };
  store.put('interaction', 'a1', approval);
  const bridge = new TelegramBridge(desk, { fetcher: makeFetcher().fetcher });
  await bridge.onAsk(approval); await bridge.sendFromAgent('web', 'Web Agent', 'ready?');
  const askId = Number(store.list('tgmsg').find(item => item.kind === 'ask').id), agentId = Number(store.list('tgmsg').find(item => item.kind === 'agent').id);
  // The connection is replaced by a new bot linked to the same chat; the new bot reuses message numbers.
  store.delete('connector', 'telegram-1');
  store.put('connector', 'telegram-2', { id: 'telegram-2', connectorId: 'telegram', name: 'Telegram @newbot', kind: 'token', at: '2026-11-24T01:00:00.000Z' });
  store.put('secret', 'connector:telegram-2', JSON.stringify({ botToken: 'T:new', chatId: 555 }));
  const found = telegramLink(store);
  await bridge.handleCallback({ id: 'cb', data: 'a1:accept', message: { chat: { id: 555 }, message_id: askId } }, found);
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'yes', reply_to_message: { message_id: askId } } }, found);
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: 'go', reply_to_message: { message_id: agentId } } }, found);
  assert.deepEqual(answered, [], 'the old approval is not answered');
  assert.ok(!turns.some(turn => turn.agentId === 'web'), 'a reply to the old agent message does not reach that agent');
});

test('link: a pairing code far back in a long queue is found by moving through the batches', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store, { botToken: 'T:tok' });
  const bridge = new TelegramBridge(desk, { fetcher: makeFetcher().fetcher });
  const { code } = await bridge.link();
  // 250 messages from other chats, then the code. The fake honours offset and limit like Telegram.
  const queue = Array.from({ length: 250 }, (_, i) => ({ update_id: 1000 + i, message: { message_id: i, chat: { id: 9000 + i, type: 'private', first_name: 'Noise' }, text: 'hi' } }));
  queue.push({ update_id: 1250, message: { message_id: 999, chat: { id: 555, type: 'private', first_name: 'Rex' }, text: `/start ${code}` } });
  const asked = [];
  bridge.fetcher = async (urlString, options) => {
    const body = JSON.parse(options.body); asked.push(body.offset || 0);
    const result = queue.filter(update => update.update_id >= (body.offset || 0)).slice(0, body.limit || 100);
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  const done = await bridge.link();
  assert.deepEqual([done.linked, done.name], [true, 'Rex']);
  assert.deepEqual(asked, [0, 1100, 1200], 'each batch starts after the last one; the same batch is never read twice');
  assert.equal(store.get('telegram', 'state').offset, 1251);
  // With no code in the queue, the next press starts after what was already read.
  const empty = makeDesk(); linkedStore(empty.store, { botToken: 'T:tok', pairCode: 'ZZZZZZ', pairUntil: Date.now() + 60000 });
  const reads = [];
  const other = new TelegramBridge(empty.desk, { fetcher: async (u, o) => { const b = JSON.parse(o.body); reads.push(b.offset || 0); const result = queue.slice(0, 250).filter(x => x.update_id >= (b.offset || 0)).slice(0, b.limit); return { ok: true, json: async () => ({ ok: true, result }) }; } });
  assert.equal((await other.link()).linked, false);
  assert.deepEqual(reads, [0, 1100, 1200, 1250]);
  reads.length = 0; await other.link();
  assert.deepEqual(reads, [1250], 'a second press does not reread the old batches');
});

// ---------- personal chat: no Reply needed, replies come back, voice and files ----------

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'rex-tg-'));

test('plain message with no Reply goes to the agent that last wrote on Telegram; a Reply still picks that message agent', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  store.put('specialist', 'qa', { id: 'qa', name: 'QA Agent' });
  const bridge = new TelegramBridge(desk, { fetcher: makeFetcher().fetcher });
  const found = telegramLink(store);
  await bridge.sendFromAgent('web', 'Web Agent', 'build is ready');
  const webMsg = Number(store.list('tgmsg').find(item => item.agentId === 'web').id);
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'nice, ship it' } }, found);
  assert.equal(turns.at(-1).agentId, 'web', 'no Reply: the agent that last wrote gets it');
  // A question from the QA Agent makes it the last one that wrote.
  store.put('run', 'qa-run', { id: 'qa-run', specialistId: 'qa' });
  await bridge.onAsk({ id: 'i1', runId: 'qa-run', method: 'desk', kind: 'question', title: 'Which build?', request: { requestedSchema: {} } });
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: 'how is the test going' } }, found);
  assert.equal(turns.at(-1).agentId, 'qa');
  // A Reply on the older Web Agent message still goes to the Web Agent.
  await bridge.handleUpdate({ update_id: 3, message: { chat: { id: 555 }, text: 'and you?', reply_to_message: { message_id: webMsg } } }, found);
  assert.equal(turns.at(-1).agentId, 'web');
  // An agent that was removed: back to Rex Agent.
  store.delete('specialist', 'web');
  await bridge.handleUpdate({ update_id: 4, message: { chat: { id: 555 }, text: 'anyone?' } }, found);
  assert.equal(turns.at(-1).agentId, 'main');
});

test('a turn started from Telegram sends its final reply back once; app turns and agents that already texted are not sent', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store);
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const found = telegramLink(store);
  const texts = () => sent.filter(call => call.method === 'sendMessage').map(call => call.body.text);
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'what is up' } }, found);
  await bridge.onTurnResult('run-main', 'All good here.');
  await bridge.onTurnResult('run-main', 'All good here.');
  assert.deepEqual(texts(), ['Rex Agent\nAll good here.'], 'sent once, with the agent name');
  // A turn started in the app (no Telegram mark) never goes to Telegram.
  await bridge.onTurnResult('run-web', 'app only');
  assert.equal(texts().length, 1);
  // The agent texted the person itself during the Telegram turn: the final reply is not sent again.
  await bridge.sendFromAgent('web', 'Web Agent', 'hi');
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: 'status?' } }, found);
  await bridge.sendFromAgent('web', 'Web Agent', 'Deploying now.', { runId: 'run-web' });
  await bridge.onTurnResult('run-web', 'Deploying now.');
  assert.deepEqual(texts().slice(1), ['Web Agent\nhi', 'Web Agent\nDeploying now.']);
  // A long reply is split cleanly into Telegram-sized parts, never cut mid-word.
  await bridge.handleUpdate({ update_id: 3, message: { chat: { id: 555 }, text: 'long one please' } }, found);
  const long = Array.from({ length: 120 }, (_, index) => `Paragraph ${index} has some words in it to make it long enough.`).join('\n\n');
  await bridge.onTurnResult('run-web', long);
  const parts = texts().slice(3);
  assert.ok(parts.length >= 2 && parts.every(part => part.length <= 3800));
  assert.equal(parts.join('\n\n').replace('Web Agent\n', ''), long);
  assert.ok(splitReply('x'.repeat(20000)).length <= 4);
});

test('voice note: the audio is always saved and its path given; a download blip is retried; a missing transcriber is said plainly', async () => {
  const directory = tempDir();
  const { desk, store, turns } = makeDesk({ directory });
  linkedStore(store);
  const { fetcher } = makeFetcher({ failFiles: 1, fileBytes: Buffer.from('OggS-voice') });
  const bridge = new TelegramBridge(desk, { fetcher, transcribe: async () => ({ error: 'ffmpeg is not installed on this computer' }) });
  bridge.retryMs = 1;
  await bridge.handleUpdate({ update_id: 1, message: { message_id: 40, chat: { id: 555 }, voice: { file_id: 'v1', file_size: 9 } } }, telegramLink(store));
  const prompt = turns.at(-1).prompt;
  assert.match(prompt, /^\[Telegram\] The person sent a voice note\. It was not transcribed: ffmpeg is not installed on this computer\./);
  const saved = /Attached files \(read them from these paths\):\n- (.+)$/.exec(prompt)[1];
  assert.equal(readFileSync(saved, 'utf8'), 'OggS-voice');
  assert.ok(saved.startsWith(path.join(directory, 'uploads')), 'saved in the uploads folder');
  assert.match(saved, /voice-40\.oga$/);
  // Transcribed: the words and the audio path both reach the agent.
  const ok = new TelegramBridge(desk, { fetcher: makeFetcher().fetcher, transcribe: async () => ({ text: 'please deploy' }) });
  await ok.handleUpdate({ update_id: 2, message: { message_id: 41, chat: { id: 555 }, voice: { file_id: 'v2' } } }, telegramLink(store));
  assert.match(turns.at(-1).prompt, /transcribed\): please deploy\n\nAttached files/);
  // Telegram down for good: the agent is told why, with the cause.
  const down = new TelegramBridge(desk, { fetcher: makeFetcher({ failFiles: 9 }).fetcher, transcribe: async () => ({ text: 'x' }) });
  down.retryMs = 1;
  await down.handleUpdate({ update_id: 3, message: { message_id: 42, chat: { id: 555 }, voice: { file_id: 'v3' } } }, telegramLink(store));
  assert.match(turns.at(-1).prompt, /could not be saved, the download from Telegram failed \(fetch failed: ECONNRESET\)/);
});

test('photos and files are downloaded into the uploads folder and posted to the agent as attachments with the caption', async () => {
  const directory = tempDir();
  const { desk, store, turns } = makeDesk({ directory });
  linkedStore(store);
  const { fetcher } = makeFetcher({ file: { file_path: 'photos/file_9.jpg' }, fileBytes: Buffer.from('JPEG') });
  const bridge = new TelegramBridge(desk, { fetcher });
  await bridge.handleUpdate({ update_id: 1, message: { message_id: 50, chat: { id: 555 }, caption: 'the save button is grey', photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 99 }] } }, telegramLink(store));
  let prompt = turns.at(-1).prompt;
  assert.match(prompt, /^\[Telegram\] The person sent a photo with this caption: the save button is grey\.\n\nAttached files \(read them from these paths\):\n- /);
  const photo = /\n- (.+)$/.exec(prompt)[1];
  assert.equal(readFileSync(photo, 'utf8'), 'JPEG');
  assert.match(photo, /photo-50\.jpg$/);
  // A document keeps its own name; one over 20 MB is not downloaded and the agent is told.
  await bridge.handleUpdate({ update_id: 2, message: { message_id: 51, chat: { id: 555 }, document: { file_id: 'd1', file_name: 'log.txt', file_size: 10 } } }, telegramLink(store));
  prompt = turns.at(-1).prompt;
  assert.match(prompt, /sent a file \(no caption\)\.\n\nAttached files/);
  assert.match(prompt, /log\.txt$/);
  await bridge.handleUpdate({ update_id: 3, message: { message_id: 52, chat: { id: 555 }, document: { file_id: 'd2', file_name: 'big.zip', file_size: 30 * 1024 * 1024 } } }, telegramLink(store));
  assert.match(turns.at(-1).prompt, /could not be saved: it is over 20 MB/);
});

// ---------- command menu: /agents, /status, /help ----------

test('command menu: set once when the linked loop starts, with /agents, /status and /help', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store);
  const commands = []; let polls = 0;
  const fetcher = async (urlString, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    if (urlString.endsWith('/setMyCommands')) { commands.push(body.commands.map(item => item.command)); return { ok: true, json: async () => ({ ok: true, result: true }) }; }
    polls += 1;
    if (polls < 3) return { ok: true, json: async () => ({ ok: true, result: [] }) };
    await new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const bridge = new TelegramBridge(desk, { fetcher });
  bridge.start();
  for (let i = 0; i < 50 && polls < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await bridge.stop();
  assert.deepEqual(commands, [['agents', 'status', 'help']], 'set once, not on every poll');
});

test('/help and /start answer with the help, /status lists the team, and no command reaches an agent', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent', runId: 'run-web' });
  store.put('specialist', 'qa', { id: 'qa', name: 'QA Agent' });
  store.put('team-task', 't1', { id: 't1', workerId: 'qa', state: 'working' });
  store.put('team-task', 't2', { id: 't2', workerId: 'qa', state: 'done' });
  store.put('interaction', 'i1', { id: 'i1', state: 'pending' });
  desk.live = new Set(['run-web']);
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const found = telegramLink(store);
  const said = () => sent.filter(call => call.method === 'sendMessage').at(-1).body.text;
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: '/help' } }, found);
  assert.match(said(), /\/agents/);
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: '/start' } }, found);
  assert.match(said(), /Just send a message/);
  await bridge.handleUpdate({ update_id: 3, message: { chat: { id: 555 }, text: '/status@rexbot' } }, found);
  const status = said();
  assert.match(status, /Rex Agent: free/);
  assert.match(status, /Web Agent: working/);
  assert.match(status, /QA Agent: free, 1 open task(?!s)/);
  assert.match(status, /1 question waits for you/);
  await bridge.handleUpdate({ update_id: 4, message: { chat: { id: 555 }, text: '/nope' } }, found);
  assert.match(said(), /do not know that command/);
  assert.deepEqual(turns, []);
});

test('/agents shows buttons; a press on that message picks who gets the next plain message, other presses do nothing', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const found = telegramLink(store);
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: '/agents' } }, found);
  const menu = sent.filter(call => call.method === 'sendMessage').at(-1);
  const buttons = menu.body.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map(button => button.callback_data), ['agent=main', 'agent=web']);
  assert.match(buttons[0].text, /^\* Rex Agent/, 'the current agent is marked');
  const menuId = Number(store.list('tgmsg').find(item => item.kind === 'agents').id);
  // A press from another chat, or on another message, changes nothing.
  await bridge.handleCallback({ id: 'c1', data: 'agent=web', message: { chat: { id: 999 }, message_id: menuId } }, found);
  await bridge.handleCallback({ id: 'c2', data: 'agent=web', message: { chat: { id: 555 }, message_id: 12345 } }, found);
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: 'hello' } }, found);
  assert.equal(turns.at(-1).agentId, 'main');
  // A real press picks the Web Agent and the menu message says so.
  await bridge.handleCallback({ id: 'c3', data: 'agent=web', message: { chat: { id: 555 }, message_id: menuId } }, found);
  assert.ok(sent.some(call => call.method === 'editMessageText' && /Web Agent/.test(call.body.text)));
  await bridge.handleUpdate({ update_id: 3, message: { chat: { id: 555 }, text: 'build it' } }, found);
  assert.equal(turns.at(-1).agentId, 'web');
  // An agent that no longer exists cannot be picked.
  await bridge.handleCallback({ id: 'c4', data: 'agent=gone', message: { chat: { id: 555 }, message_id: menuId } }, found);
  await bridge.handleUpdate({ update_id: 4, message: { chat: { id: 555 }, text: 'still you?' } }, found);
  assert.equal(turns.at(-1).agentId, 'web');
});

test('an explicit send that fails keeps the automatic reply; only a send that worked, from that chat, replaces it', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store);
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  const { fetcher, sent } = makeFetcher();
  let failNext = false;
  const flaky = async (urlString, options) => {
    if (failNext && urlString.endsWith('/sendMessage')) { failNext = false; return { ok: true, json: async () => ({ ok: false, description: 'Too Many Requests' }) }; }
    return fetcher(urlString, options);
  };
  const bridge = new TelegramBridge(desk, { fetcher: flaky });
  const found = telegramLink(store);
  const texts = () => sent.filter(call => call.method === 'sendMessage').map(call => call.body.text);
  store.put('tgmsg', '1', { id: '1', kind: 'agent', agentId: 'web', linkId: found.link.id });
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'status?', reply_to_message: { message_id: 1 } } }, found);
  failNext = true;
  await assert.rejects(bridge.sendFromAgent('web', 'Web Agent', 'Deploying now.', { runId: 'run-web' }));
  // A message from another chat of the same agent, or with no chat (the bug bot report), does not count for this turn.
  await bridge.sendFromAgent('web', 'Web Agent', 'from a room', { runId: 'room-run' });
  await bridge.sendFromAgent('web', 'Bug bot', 'morning report');
  await bridge.onTurnResult('run-web', 'Deployed.');
  assert.deepEqual(texts(), ['Web Agent\nfrom a room', 'Bug bot\nmorning report', 'Web Agent\nDeployed.'], 'the final reply still went out');
});

test('queued Telegram messages are told apart by their own id: the same words from two chats across a relink stay two messages', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store);
  store.put('specialist', 'web', { id: 'web', name: 'Web Agent' });
  store.put('run', 'run-web', { id: 'run-web', queued: [] });
  // The Web Agent is busy with a turn from the app: messages wait in its queue, as coordinator.say does.
  desk.specialistTurn = async (agentId, { prompt }) => { const run = store.get('run', 'run-web'); store.put('run', 'run-web', { ...run, queued: [...run.queued, prompt] }); return { id: 'run-web' }; };
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const texts = () => sent.filter(call => call.method === 'sendMessage').map(call => ({ chat: call.body.chat_id, text: call.body.text }));
  await bridge.routeToAgent('web', 'ship it?', telegramLink(store));
  linkedStore(store, { botToken: 'T:tok', chatId: 777, chatName: 'Other' });
  await bridge.routeToAgent('web', 'ship it?', telegramLink(store));
  const [first, second] = store.get('run', 'run-web').queued;
  assert.notEqual(first, second, 'each entry has its own id');
  assert.equal(bridge.queuedChat('run-web', first), 'telegram-1:555');
  assert.equal(bridge.queuedChat('run-web', second), 'telegram-1:777');
  assert.equal(bridge.queuedChat('run-web', 'ship it?'), '', 'an app message with the same words is the app');
  assert.equal(bridge.turnChat('run-web'), '', 'the running app turn is not marked');
  await bridge.onTurnResult('run-web', 'private app answer');
  // The turn for the second entry answers chat 777, the new chat, and only it; the first entry still waits for its own turn.
  const replyTo = bridge.batchReplyTo('run-web', [second]);
  assert.equal(replyTo.chatId, '777');
  bridge.onTurnStart('run-web', 'turn-2', replyTo);
  assert.ok(store.get('tgqueued', replyTo.keys[0]) === null && bridge.queuedChat('run-web', first) === 'telegram-1:555');
  await bridge.onTurnResult('run-web', 'Shipped.');
  assert.deepEqual(texts(), [{ chat: 777, text: 'Web Agent\nShipped.' }]);
});

test('the Telegram reply belongs to one turn: a failed, stopped or stale Telegram turn never makes the next app turn answer there', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store);
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const texts = () => sent.filter(call => call.method === 'sendMessage').map(call => call.body.text);
  // A Telegram turn fails (or is stopped): its end clears the destination; another turn's end leaves it alone.
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'what is up' } }, telegramLink(store));
  assert.equal(bridge.onTurnEnd('run-main', 'turn-other'), null);
  assert.equal(bridge.onTurnEnd('run-main', 'turn-1').chatId, '555');
  // The person resumes the chat from the app: that turn has no destination, so its reply stays in the app.
  bridge.onTurnStart('run-main', 'turn-app', null);
  await bridge.onTurnResult('run-main', 'app answer');
  // A destination left by a turn that never reported its end (a crash) is cleared by the next app turn's start too.
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: 'again' } }, telegramLink(store));
  bridge.onTurnStart('run-main', 'turn-app-2', null);
  await bridge.onTurnResult('run-main', 'another app answer');
  assert.deepEqual(texts(), []);
  // A turn Rex Desk follows again after a restart keeps its destination, and its reply still goes out.
  await bridge.handleUpdate({ update_id: 3, message: { chat: { id: 555 }, text: 'third' } }, telegramLink(store));
  bridge.onTurnStart('run-main', 'turn-followed', null, { attach: true });
  await bridge.onTurnResult('run-main', 'Here.');
  assert.deepEqual(texts(), ['Rex Agent\nHere.']);
});

test('a pending Telegram reply goes only to the chat it came from: after a relink to another chat it is not sent', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store);
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'what is up' } }, telegramLink(store));
  assert.equal(store.get('tgturn', 'run-main').chatId, '555');
  linkedStore(store, { botToken: 'T:tok', chatId: 777, chatName: 'Someone else' });
  await bridge.onTurnResult('run-main', 'private answer');
  assert.deepEqual(sent.filter(call => call.method === 'sendMessage'), [], 'the new chat never gets the old chat reply');
});

test('each Telegram message tells the agent its chat and tag on the first line; desk_telegram with that tag texts exactly that chat', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  const { fetcher, sent } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const texts = () => sent.filter(call => call.method === 'sendMessage').map(call => ({ chat: call.body.chat_id, text: call.body.text }));
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'hello' } }, telegramLink(store));
  await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 555 }, text: 'again' } }, telegramLink(store));
  assert.match(desk.prompts[0], /^\[Telegram #[0-9a-f]{12}\] Telegram, Rex \(tg:1\)\nhello$/);
  assert.match(desk.prompts[1], /\(tg:1\)\nagain$/, 'the same chat keeps its tag');
  assert.deepEqual(turns.map(turn => turn.prompt), ['[Telegram] hello', '[Telegram] again'], 'the app chat shows the message as before');
  // Another chat linked later gets its own tag; the old tag no longer sends anywhere.
  linkedStore(store, { botToken: 'T:tok', chatId: 777, chatName: 'Dara' });
  await bridge.handleUpdate({ update_id: 3, message: { chat: { id: 777 }, text: 'hi' } }, telegramLink(store));
  assert.match(desk.prompts[2], /Telegram, Dara \(tg:2\)\nhi$/);
  await bridge.sendFromAgent('main', 'Rex Agent', 'To you.', { tag: 'tg:2' });
  await assert.rejects(bridge.sendFromAgent('main', 'Rex Agent', 'Old chat.', { tag: 'tg:1' }), /tg:1 is no longer linked/);
  await assert.rejects(bridge.sendFromAgent('main', 'Rex Agent', 'Nobody.', { tag: 'tg:9' }), /no Telegram chat tagged tg:9/);
  // Without a tag it goes to the linked chat, as before.
  await bridge.sendFromAgent('main', 'Rex Agent', 'Plain.');
  assert.deepEqual(texts(), [{ chat: 777, text: 'Rex Agent\nTo you.' }, { chat: 777, text: 'Rex Agent\nPlain.' }]);
});

test('the hidden tag line is taken out of what the app chat shows, and nothing else is', () => {
  const key = '0123456789ab';
  assert.equal(hideTelegramTag(`[Telegram #${key}] Telegram, Rex (tg:3)\nship it?`), `[Telegram #${key}] ship it?`);
  assert.equal(hideTelegramTag(`[Telegram #${key}] Telegram, Rex (tg:3)\na\n[Telegram #${key}] Telegram, Rex (tg:3)\nb`), `[Telegram #${key}] a\n[Telegram #${key}] b`);
  assert.equal(hideTelegramTag('Telegram, Rex (tg:3)\nwritten in the app'), 'Telegram, Rex (tg:3)\nwritten in the app');
  assert.equal(hideTelegramTag(`[Telegram #${key}] plain`), `[Telegram #${key}] plain`);
});

// ---- review f5391ce2 ----
import * as botUse from '../src/bot-use.js';
const { readBot: holdBot, botReader: readerOf, noteBotAnswer: noteAnswer } = botUse;
// A Telegram that records which token asked getUpdates.
function tokenFetcher(updates = []) {
  const asked = [];
  const fetcher = async (urlString, options) => {
    const url = new URL(urlString), [, token, method] = url.pathname.match(/\/bot([^/]+)\/(\w+)/) || [];
    if (method === 'getUpdates') asked.push(decodeURIComponent(token));
    return { ok: true, json: async () => ({ ok: true, result: method === 'getUpdates' ? updates : { message_id: 1 } }) };
  };
  return { asked, fetcher };
}
// Another use holds a read of bot 'T' until it is cancelled; then change() runs, and only then does that read end.
function otherRead(store, change) {
  const abort = new AbortController();
  const done = holdBot(store, 'T', { connectorId: 'telegram-bugs' }, abort, signal => new Promise(resolve => signal.addEventListener('abort', () => { change(); resolve([]); })));
  return done;
}

test('review f5391ce2 (1): a poll that waited for the bot reads nothing when its connection was removed meanwhile', async () => {
  const { desk, store } = makeDesk(); linkedStore(store);
  const other = otherRead(store, () => { store.delete('connector', 'telegram-1'); store.delete('secret', 'connector:telegram-1'); });
  const { asked, fetcher } = tokenFetcher(); const bridge = new TelegramBridge(desk, { fetcher });
  bridge.start(); await other; await new Promise(resolve => setTimeout(resolve, 50));
  await bridge.stop();
  assert.deepEqual(asked, [], 'the removed connection never polls with its old token');
});

test('review f5391ce2 (1): pairing that waited for the bot stops when the connection was replaced meanwhile', async () => {
  const { desk, store } = makeDesk(); linkedStore(store, { botToken: 'T:tok', pairCode: 'ABC234', pairUntil: Date.now() + 60000 });
  const other = otherRead(store, () => linkedStore(store, { botToken: 'T:new' }));
  const { asked, fetcher } = tokenFetcher(); const bridge = new TelegramBridge(desk, { fetcher });
  await assert.rejects(() => bridge.link(), /changed while it was pairing/); await other;
  assert.deepEqual(asked, []);
});

test('review f5391ce2 (1): a read that waited is skipped when another use owns the bot by then', async () => {
  const records = new Map(), store = { get: (k, id) => records.get(`${k}:${id}`) ?? null, put: (k, id, v) => records.set(`${k}:${id}`, v), delete: (k, id) => records.delete(`${k}:${id}`), list: () => [] };
  let owner = 'a', read = 0;
  const first = holdBot(store, 'B', { agentId: 'b' }, new AbortController(), signal => new Promise(resolve => signal.addEventListener('abort', () => { owner = 'b'; resolve(); })));
  const second = await holdBot(store, 'B', { agentId: 'a' }, new AbortController(), async () => { read++; return []; }, () => owner === 'a');
  await first;
  assert.equal(read, 0, 'nothing is read for a use that no longer owns the bot'); assert.equal(second, botUse.SKIPPED);
});

test('review f5391ce2 (2): messages sent right after the pairing code are kept for the poll loop', async () => {
  const { desk, store } = makeDesk(); linkedStore(store, { botToken: 'T:tok', pairCode: 'ABC234', pairUntil: Date.now() + 60000 });
  const { fetcher } = tokenFetcher([
    { update_id: 7, message: { message_id: 1, chat: { id: 555, type: 'private', first_name: 'Rex' }, text: '/start ABC234' } },
    { update_id: 8, message: { message_id: 2, chat: { id: 555, type: 'private', first_name: 'Rex' }, text: 'hello right after pairing' } },
  ]);
  const bridge = new TelegramBridge(desk, { fetcher });
  assert.equal((await bridge.link()).linked, true);
  assert.equal(store.get('telegram', 'state').offset, 8, 'the next poll starts at the message after the code');
});

test('review f5391ce2 (3): an agent bot whose token cannot be read never wins the bot', () => {
  const { store } = makeDesk(); linkedStore(store, { botToken: '42:tok', chatId: 555, chatName: 'Rex' });
  store.put('agentbot', 'qa', { id: 'qa', botId: '42' }); store.put('secret', 'agentbot:qa', 'not json');
  // The personal bot's token was turned down once; the unreadable agent token must still not take the bot over.
  noteAnswer(store, { connectorId: 'telegram' }, '42:tok', { code: 401 });
  assert.equal(readerOf(store, { agentId: 'qa' }).reads, false);
  assert.equal(readerOf(store, { connectorId: 'telegram' }).reads, true);
});

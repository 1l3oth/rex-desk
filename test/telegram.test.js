import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramBridge, telegramLink } from '../src/telegram.js';

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
    specialistTurn: async (agentId, { prompt }) => { turns.push({ agentId, prompt }); },
    specialists: { ensureMain: () => {}, get: id => store.get('specialist', id) },
  };
  return { desk, store, answered, turns };
}

// A fake Telegram server. Records every outgoing call; sendMessage returns incrementing message ids.
function makeFetcher({ updates = [], file = null, fileBytes = Buffer.from('audio') } = {}) {
  const sent = []; let nextId = 100;
  const fetcher = async (urlString, options) => {
    const url = new URL(urlString);
    if (url.pathname.includes('/file/bot')) return { ok: true, arrayBuffer: async () => fileBytes };
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
  assert.equal(store.get('telegram', 'state').offset, 10, 'offset skips past the code');
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
  assert.deepEqual(turns, [{ agentId: 'web', prompt: 'go ahead' }]);
});

test('a plain non-reply message goes to Rex Agent (main)', async () => {
  const { desk, store, turns } = makeDesk();
  linkedStore(store);
  const { fetcher } = makeFetcher();
  const bridge = new TelegramBridge(desk, { fetcher });
  const found = telegramLink(store);
  await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 555 }, text: 'what is up' } }, found);
  assert.deepEqual(turns, [{ agentId: 'main', prompt: 'what is up' }]);
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

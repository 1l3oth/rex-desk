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

test('link: saves the one chat that pressed Start, and reports when no one has yet', async () => {
  const { desk, store } = makeDesk();
  linkedStore(store, { botToken: 'T:tok' }); // token saved, not linked yet
  const first = makeFetcher({ updates: [] });
  const bridge = new TelegramBridge(desk, { fetcher: first.fetcher });
  const none = await bridge.link();
  assert.equal(none.linked, false); assert.match(none.hint, /press Start/i);

  const second = makeFetcher({ updates: [{ update_id: 7, message: { message_id: 1, chat: { id: 555, type: 'private', first_name: 'Rex' }, text: '/start' } }] });
  bridge.fetcher = second.fetcher;
  const done = await bridge.link();
  assert.deepEqual([done.linked, done.name], [true, 'Rex']);
  const values = JSON.parse(store.decrypt(store.get('secret', 'connector:telegram-1')));
  assert.equal(values.chatId, 555); assert.equal(values.chatName, 'Rex');
  assert.equal(store.get('telegram', 'state').offset, 8, 'offset skips past the /start');
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
  await bridge.handleCallback({ id: 'cb1', data: 'i1:o:1', message: { chat: { id: 555 }, message_id: 900 } }, found);
  assert.deepEqual(answered, [{ id: 'i1', answer: { action: 'accept', content: { choice: 'Not yet' } } }]);
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

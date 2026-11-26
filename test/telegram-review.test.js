import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { ClaudeRunner } from '../src/runners.js';
import { telegramLink } from '../src/telegram.js';

// L105 review: the real desk and its setup routes, with a fake Telegram and a fake AI. No real bot or token.
const token = (id, letter = 'A') => `${id}:${letter.repeat(24)}`;
const SORRY = "I couldn't answer just now. Please send your message again in a little while.";
const NO_ANSWER = 'I could not use that answer. Please answer it in Rex Desk.';

async function desk(name) {
  const data = path.join(os.tmpdir(), `tg-review-${name}-${process.pid}`, 'data'), plan = [], sent = [], real = globalThis.fetch;
  const sdk = { query: () => { const next = plan.shift() || []; return Object.assign((async function* () { yield* next; })(), { close() {}, async interrupt() {} }); } };
  // Every call to Telegram, from any part of the desk, stops here. A bot's id is the number its token starts with.
  const telegram = async (url, options) => {
    if (!String(url).startsWith('https://api.telegram.org/')) return real(url, options);
    const [, bot, method] = String(url).match(/bot([^/]+)\/(\w+)/), id = Number(decodeURIComponent(bot).split(':')[0]), body = JSON.parse(options?.body || '{}');
    if (method === 'getMe') return Response.json({ ok: true, result: { id, username: `fake${id}_bot` } });
    if (['sendMessage', 'answerCallbackQuery'].includes(method)) sent.push({ method, chat: body.chat_id, text: body.text });
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  globalThis.fetch = telegram;
  const app = await createApp({ dataDirectory: data, port: 0, requireAccount: false, runnerFactory: options => new ClaudeRunner({ ...options, sdk }) });
  for (const part of [app.desk.agentBots, app.desk.telegram, app.desk.bugBot]) part.fetcher = telegram;
  for (const [id, agent] of [['qa', 'QA'], ['dev', 'Dev']]) app.desk.store.put('specialist', id, { id, name: agent, slug: id, kind: 'worker', provider: 'claude', purpose: 'test', createdAt: new Date().toISOString() });
  const post = async (route, input) => {
    const response = await real(`http://127.0.0.1:${app.server.address().port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  // The three places a person can set up a bot.
  const setUp = {
    personal: value => post('/api/connectors/catalog/telegram', { botToken: value }),
    bugs: value => post('/api/bugbot/connect', { botToken: value }),
    agent: (value, agent = 'qa') => post(`/api/agents/${agent}/telegram/connect`, { botToken: value }),
  };
  const close = async () => { globalThis.fetch = real; await app.close(); };
  return { app, plan, sent, setUp, close };
}

test('an answer that cannot be used gets fixed words in the personal bot chat, never the error', async () => {
  const { app, sent, close } = await desk('answer');
  try {
    const { desk: { store, telegram } } = app;
    store.put('secret', 'connector:mine', store.encrypt(JSON.stringify({ botToken: token(700001), chatId: '9' })));
    store.put('connector', 'mine', { id: 'mine', connectorId: 'telegram', name: 'Telegram', at: new Date().toISOString() });
    store.put('interaction', 'q1', { id: 'q1', state: 'pending', request: { requestedSchema: { properties: { answer: { type: 'string', enum: ['Yes'] } } } } });
    store.put('tgmsg', '41', { id: '41', kind: 'ask', interactionId: 'q1', linkId: 'mine' });
    app.desk.answer = () => { throw new Error('SECRET-detail in C:\\private\\file.json'); };
    await telegram.answerAsk('q1', 'answer', 'Yes', telegramLink(store), 5);
    await telegram.handleCallback({ id: 'press', data: 'q1:o:0', message: { message_id: 41, chat: { id: 9 } } }, telegramLink(store));
    assert.deepEqual(sent.map(item => [item.method, item.text]), [['sendMessage', NO_ANSWER], ['answerCallbackQuery', NO_ANSWER]]);
  } finally { await close(); }
});

test('a Claude sign-in error never reaches Telegram, also from a chat that is open in the Claude app', async () => {
  const { app, plan, sent, setUp, close } = await desk('signin');
  try {
    await setUp.agent(token(800001));
    const record = app.desk.store.get('agentbot', 'qa');
    const message = text => app.desk.agentBots.handle('qa', { update_id: 1, message: { chat: { id: 7, type: 'private' }, from: { first_name: 'Rex' }, text } });
    await message(record.pairCode);
    const ask = async (text, remote) => {
      const run = app.desk.store.get('specialist', 'qa').runId;
      if (remote) app.desk.store.put('run', run, { ...app.desk.store.get('run', run), inApp: { on: true } });
      const from = sent.length; plan.push([{ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: text }]);
      await message('hello');
      for (let i = 0; i < 400 && (plan.length || app.desk.live.size); i++) await new Promise(resolve => setTimeout(resolve, 25));
      await new Promise(resolve => setTimeout(resolve, 200));
      return sent.slice(from).map(item => item.text);
    };
    assert.deepEqual(await ask('All good.'), ['All good.']);
    assert.deepEqual(await ask('Not logged in · Please run /login', true), [SORRY], 'open in the Claude app');
    assert.deepEqual(await ask('All good again.', true), ['All good again.'], 'a good reply there still goes');
    assert.deepEqual(await ask('Not logged in · Please run /login'), [SORRY]);
  } finally { await close(); }
});

test('media from anyone but the owner is ignored; a stranger\'s text still gets the owner-only reply', async () => {
  const { app, sent, setUp, close } = await desk('stranger');
  try {
    await setUp.agent(token(900001));
    const from = (id, extra) => app.desk.agentBots.handle('qa', { update_id: 1, message: { chat: { id, type: 'private' }, from: { first_name: 'Someone' }, ...extra } });
    const said = async run => { const at = sent.length; await run(); return sent.slice(at).map(item => item.text); };
    const media = [{ photo: [] }, { voice: {} }, { document: {} }, { sticker: {} }, { video: {}, caption: 'look' }, { photo: [], media_group_id: 'g' }, { pinned_message: {} }];
    for (const item of media) assert.deepEqual(await said(() => from(99, item)), [], `before the owner is linked: ${Object.keys(item)}`);
    await from(7, { text: app.desk.store.get('agentbot', 'qa').pairCode });
    for (const item of media) assert.deepEqual(await said(() => from(99, item)), [], `a stranger: ${Object.keys(item)}`);
    assert.deepEqual(await said(() => from(99, { text: 'hi' })), ['This agent only talks to its owner.']);
    assert.deepEqual(await said(() => from(7, { photo: [] })), ['Only text works here for now. Please send your message as text.']);
  } finally { await close(); }
});

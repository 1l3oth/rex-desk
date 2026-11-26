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

test('a bot has one use: every setup refuses a bot another one holds, even with a newer token of it', async () => {
  for (const first of ['personal', 'bugs', 'agent']) {
    for (const second of ['personal', 'bugs', 'agent'].filter(item => item !== first)) {
      const { app, setUp, close } = await desk(`${first}-${second}`);
      try {
        assert.equal((await setUp[first](token(500001))).status, 200, `${first} takes a free bot`);
        const saved = () => JSON.stringify([app.desk.store.list('connector'), app.desk.store.list('agentbot'), app.desk.store.list('secret').length]), before = saved();
        const refused = await setUp[second](token(500001, 'N'));
        assert.equal(refused.status, 400, `${second} after ${first}`);
        assert.match(refused.error, { personal: /your personal Telegram bot/, bugs: /the bug report bot/, agent: /QA's own bot|belongs to QA/ }[first]);
        assert.ok(!/AAAA|NNNN/.test(refused.error), 'no token in the words');
        assert.equal(saved(), before, `${second} saved nothing`);
        assert.equal((await setUp[second](token(500002))).status, 200, `${second} takes its own bot`);
      } finally { await close(); }
    }
  }
});

test('a bot has one use: the same use can set its own bot again, and two setups at once cannot both get one bot', async () => {
  const { app, setUp, close } = await desk('again');
  try {
    for (const [use, id] of [['personal', 600001], ['bugs', 600002], ['agent', 600003]]) for (const letter of ['A', 'B']) assert.equal((await setUp[use](token(id, letter))).status, 200, `${use} again`);
    assert.equal((await setUp.agent(token(600003), 'dev')).status, 400, 'another agent');
    const both = await Promise.all([setUp.bugs(token(600009)), setUp.agent(token(600009), 'dev'), setUp.personal(token(600009))]);
    assert.deepEqual(both.map(item => item.status).sort(), [200, 400, 400]);
  } finally { await close(); }
});

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

test('a bot saved in two places is read by one of them only, the same one on every start, and the next one takes over once it is disconnected (L105 review)', async () => {
  const { app, close } = await desk('one-reader');
  const store = app.desk.store, polls = [], parts = [app.desk.telegram, app.desk.bugBot, app.desk.agentBots];
  // A fake Telegram that remembers which token text asked for updates. One bot (777), three token texts of it.
  const fake = async (url, options) => {
    const [, bot, method] = String(url).match(/bot([^/]+)\/(\w+)/), text = decodeURIComponent(bot), id = Number(text.split(':')[0]);
    if (method === 'getMe') return Response.json({ ok: true, result: { id, username: `fake${id}_bot` } });
    if (method === 'getUpdates') { polls.push(text); await new Promise(resolve => setTimeout(resolve, 40)); return Response.json({ ok: true, result: [] }); }
    return Response.json({ ok: true, result: true });
  };
  for (const part of parts) { part.fetcher = fake; part.waitMs = 40; }
  // Saved by an older version, before a bot could have only one use.
  const save = (id, connectorId, values) => { store.put('connector', id, { id, connectorId, at: new Date().toISOString() }); store.put('secret', `connector:${id}`, store.encrypt(JSON.stringify(values))); };
  save('mine', 'telegram', { botToken: token(777, 'A'), chatId: '42' });
  save('bugs', 'telegram-bugs', { botToken: token(777, 'C'), botUsername: 'fake777_bot', botId: 777 });
  store.put('agentbot', 'qa', { id: 'qa', botId: 777, botUsername: 'fake777_bot', ownerChatId: '', groups: [], pending: [], offset: 0 });
  store.put('secret', 'agentbot:qa', store.encrypt(JSON.stringify({ botToken: token(777, 'B') })));
  const readers = async () => { polls.length = 0; await new Promise(resolve => setTimeout(resolve, 600)); return [...new Set(polls)].sort(); };
  const start = () => { for (const part of parts) part.start(); }, stop = () => Promise.all(parts.map(part => part.stop()));
  try {
    start();
    assert.deepEqual(await readers(), [token(777, 'A')], 'only the personal bot reads it');
    assert.equal(app.desk.agentBots.status('qa').readBy.kind, 'personal', "QA's bot says who reads it");
    assert.equal(app.desk.bugBot.status().readBy.kind, 'personal');
    await stop(); start();
    assert.deepEqual(await readers(), [token(777, 'A')], 'the same one after a restart');
    // Disconnected: the next one reads it, without a restart.
    store.delete('connector', 'mine'); store.delete('secret', 'connector:mine');
    assert.deepEqual(await readers(), [token(777, 'C')], 'then the bug report bot');
    assert.equal(app.desk.agentBots.status('qa').readBy.kind, 'bugs');
    app.desk.bugBot.disconnect();
    assert.deepEqual(await readers(), [token(777, 'B')], "then QA's own bot");
    assert.equal(app.desk.agentBots.status('qa').readBy, null);
  } finally { await stop(); await close(); }
});

// A fake Telegram for the reader tests. how: token text -> 'ok' (a short poll), 'hang' (a long poll that ends only when it is
// cancelled), 'revoked' (401 to everything) or 'offline' (the network fails). It counts getUpdates in flight per bot.
function fakeBots(how) {
  const live = new Map(), state = { max: 0, polls: [], aborted: [] };
  state.fetch = async (url, options) => {
    const [, bot, method] = String(url).match(/bot([^/]+)\/(\w+)/), text = decodeURIComponent(bot), id = Number(text.split(':')[0]), kind = how[text] || 'ok';
    if (kind === 'revoked') return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' });
    if (method === 'getMe') return Response.json({ ok: true, result: { id, username: `fake${id}_bot` } });
    if (method !== 'getUpdates') return Response.json({ ok: true, result: { message_id: 1 } });
    if (kind === 'offline') throw new TypeError('fetch failed');
    state.polls.push(text); live.set(id, (live.get(id) || 0) + 1); state.max = Math.max(state.max, live.get(id));
    const wait = JSON.parse(options?.body || '{}').timeout === 0 ? 5 : kind === 'hang' ? 5000 : 40;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        options?.signal?.addEventListener('abort', () => { clearTimeout(timer); state.aborted.push(text); reject(new DOMException('cancelled', 'AbortError')); });
      });
    } finally { live.set(id, live.get(id) - 1); }
    return Response.json({ ok: true, result: [] });
  };
  return state;
}
async function readerDesk(name, how) {
  const made = await desk(name), store = made.app.desk.store, fake = fakeBots(how), parts = [made.app.desk.telegram, made.app.desk.bugBot, made.app.desk.agentBots];
  for (const part of parts) { part.fetcher = fake.fetch; part.waitMs = 40; }
  const save = (id, connectorId, values) => { store.put('connector', id, { id, connectorId, at: new Date().toISOString() }); store.put('secret', `connector:${id}`, store.encrypt(JSON.stringify(values))); };
  const agent = (id, value) => { store.put('agentbot', id, { id, botId: 777, botUsername: 'fake777_bot', ownerChatId: '', groups: [], pending: [], offset: 0 }); store.put('secret', `agentbot:${id}`, store.encrypt(JSON.stringify({ botToken: value }))); };
  const readers = async (ms = 600) => { fake.polls.length = 0; await new Promise(resolve => setTimeout(resolve, ms)); return [...new Set(fake.polls)].sort(); };
  const start = () => { for (const part of parts) part.start(); };
  const close = async () => { await Promise.all(parts.map(part => part.stop())); await made.close(); };
  return { ...made, store, fake, save, agent, readers, start, close };
}
const bugValues = value => ({ botToken: value, botUsername: 'fake777_bot', botId: 777 });

test('a personal bot not paired yet, or a token Telegram turned down, never keeps a working use from reading the bot; a network error hands nothing over (L105 review)', async () => {
  // Not paired: the personal bot never polls, so the bug report bot reads the bot.
  let d = await readerDesk('unpaired', {});
  try {
    d.save('mine', 'telegram', { botToken: token(777, 'A') });
    d.save('bugs', 'telegram-bugs', bugValues(token(777, 'C')));
    d.start();
    assert.deepEqual(await d.readers(), [token(777, 'C')], 'the bug report bot reads while the personal bot is not paired');
    assert.equal(d.app.desk.bugBot.status().readBy, null);
  } finally { await d.close(); }
  // Revoked: the personal bot's token gets 401, so the bug report bot takes over; once that one is turned down too, QA's bot.
  const how = { [token(777, 'A')]: 'revoked' };
  d = await readerDesk('revoked', how);
  try {
    d.save('mine', 'telegram', { botToken: token(777, 'A'), chatId: '42' });
    d.save('bugs', 'telegram-bugs', bugValues(token(777, 'C')));
    d.agent('qa', token(777, 'B'));
    d.start();
    assert.deepEqual(await d.readers(), [token(777, 'C')], 'the bug report bot reads once the personal token is turned down');
    assert.equal(d.app.desk.agentBots.status('qa').readBy.kind, 'bugs');
    how[token(777, 'C')] = 'revoked';
    assert.deepEqual(await d.readers(), [token(777, 'B')], "then QA's own bot");
    // A new token for the personal bot is not the failed one: it reads again.
    d.save('mine', 'telegram', { botToken: token(777, 'D'), chatId: '42' }); d.app.desk.telegram.kick();
    assert.deepEqual(await d.readers(), [token(777, 'D')], 'a new personal token reads again');
  } finally { await d.close(); }
  // Offline: the personal bot cannot reach Telegram for a moment. That says nothing about its token: nobody else takes over.
  d = await readerDesk('offline', { [token(777, 'A')]: 'offline' });
  try {
    d.save('mine', 'telegram', { botToken: token(777, 'A'), chatId: '42' });
    d.save('bugs', 'telegram-bugs', bugValues(token(777, 'C')));
    d.start();
    assert.deepEqual(await d.readers(), [], 'no other use reads the bot on a network error');
    assert.equal(d.app.desk.bugBot.status().readBy.kind, 'personal');
  } finally { await d.close(); }
});

test('a reader that is disconnected ends its poll before the next one asks, for every use and for pairing (L105 review)', async () => {
  const d = await readerDesk('handover', { [token(777, 'A')]: 'hang', [token(777, 'C')]: 'hang', [token(777, 'B')]: 'hang' });
  const call = async (method, route) => (await fetch(`http://127.0.0.1:${d.app.server.address().port}${route}`, { method, headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: method === 'DELETE' ? undefined : '{}' })).status;
  try {
    d.save('mine', 'telegram', { botToken: token(777, 'A'), chatId: '42' });
    d.save('bugs', 'telegram-bugs', bugValues(token(777, 'C')));
    d.agent('qa', token(777, 'B'));
    d.start();
    assert.deepEqual(await d.readers(300), [token(777, 'A')]);
    // The personal bot is removed in Settings while its long poll is out.
    assert.equal(await call('DELETE', '/api/connectors/links/mine'), 200);
    assert.deepEqual(await d.readers(300), [token(777, 'C')], 'the bug report bot reads next');
    assert.ok(d.fake.aborted.includes(token(777, 'A')), "the personal bot's poll was cancelled");
    assert.equal(d.fake.max, 1, 'never two polls of one bot at once');
    assert.equal(await call('POST', '/api/bugbot/disconnect'), 200);
    assert.deepEqual(await d.readers(300), [token(777, 'B')], "then QA's own bot");
    assert.equal(d.fake.max, 1);
    // Pairing a new personal bot of the same bot: refused while QA's bot reads it, and its reads never run beside a poll.
    d.save('mine2', 'telegram', { botToken: token(777, 'E') });
    await assert.rejects(d.app.desk.telegram.link(), /also saved as QA's own bot/);
    d.app.desk.agentBots.disconnect('qa');
    const first = await d.app.desk.telegram.link();
    assert.equal(first.linked, false);
    await d.app.desk.telegram.link();
    assert.ok(d.fake.polls.includes(token(777, 'E')), 'the Link button read the bot');
    assert.equal(d.fake.max, 1, 'pairing waited for the old poll to end');
  } finally { await d.close(); }
});
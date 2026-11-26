import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { ClaudeRunner } from '../src/runners.js';
import { OWN_BOT, hideTelegramTag } from '../src/telegram.js';

// A turn a Telegram message started, end to end: the real desk and the real Claude runner, with a fake AI and a fake Telegram.
const TOKEN = '100001:AAAAAAAAAAAAAAAAAAAAAAAA';
const RAW = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"SECRET-detail"},"request_id":"req_SECRET"}';
const SORRY = "I couldn't answer just now. Please send your message again in a little while.";
const result = extra => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, ...extra });

async function desk(name) {
  const data = path.join(os.tmpdir(), `tg-turns-${name}-${process.pid}`, 'data'), plan = [];
  // What the next turn does: messages the fake AI sends back, or an error the runner throws.
  const prompts = [];
  const sdk = { query: ({ prompt }) => { prompts.push(String(prompt)); const next = plan.shift(); return Object.assign((async function* () { if (next instanceof Error) throw next; yield* next; })(), { close() {}, async interrupt() {} }); } };
  const app = await createApp({ dataDirectory: data, port: 0, requireAccount: false, runnerFactory: options => new ClaudeRunner({ ...options, sdk }) });
  const sent = [];
  const telegram = async (url, options) => {
    const method = String(url).split('/').pop(), body = JSON.parse(options?.body || '{}');
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { id: 100001, username: 'qa_bot' } }) };
    if (method === 'sendMessage') sent.push(body.text);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  app.desk.agentBots.fetcher = telegram; app.desk.telegram.fetcher = telegram;
  app.desk.store.put('specialist', 'qa', { id: 'qa', name: 'QA', slug: 'qa', kind: 'worker', provider: 'claude', purpose: 'test', createdAt: new Date().toISOString() });
  const message = text => app.desk.agentBots.handle('qa', { update_id: 1, message: { chat: { id: 7, type: 'private' }, from: { id: 7, first_name: 'Tester' }, text } });
  const { pairCode } = await app.desk.agentBots.connect('qa', TOKEN);
  await message(`/start ${pairCode}`);
  // Sends one message from Telegram and gives back what the bot sent once that turn is over.
  const ask = async turn => {
    const from = sent.length; plan.push(turn);
    await message('hello');
    for (let i = 0; i < 400 && (plan.length || app.desk.live.size); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(app.desk.live.size, 0, 'the turn ended');
    await new Promise(resolve => setTimeout(resolve, 150));
    return sent.slice(from);
  };
  return { app, ask, sent, prompts, message };
}

test('a failed turn sends a short plain message on Telegram, never the raw error', async () => {
  const { app, ask } = await desk('failed');
  try {
    assert.deepEqual(await ask([result({ result: 'All good.' })]), ['All good.'], 'a good turn still sends its answer');
    assert.deepEqual(await ask([result({ is_error: true, result: RAW })]), [SORRY], 'an error result');
    assert.deepEqual(await ask([result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: [RAW] })]), [SORRY], 'an error with no words');
    assert.deepEqual(await ask(new Error(RAW)), [SORRY], 'the runner fails before any result');
    assert.deepEqual(await ask([result({ result: 'Not logged in · Please run /login' })]), [SORRY], 'a signed-out profile');
    // A usage limit with no other account to switch to.
    app.desk.agents.alternative = async () => null;
    assert.deepEqual(await ask([result({ result: 'Claude AI usage limit reached|1790000000' })]), [SORRY], 'a usage limit told as an ordinary reply');
  } finally { await app.close(); }
});

test('a message from an agent bot says its answer goes back by itself, and desk_telegram never switches to the personal bot', async () => {
  const { app, ask, sent, prompts } = await desk('tool');
  try {
    const { desk: { store, telegram } } = app;
    // The personal bot is connected and linked too: the trap this closes.
    store.put('secret', 'connector:personal', store.encrypt(JSON.stringify({ botToken: '100003:BBBBBBBBBBBBBBBBBBBBBBBB', chatId: '9' })));
    store.put('connector', 'personal', { id: 'personal', connectorId: 'telegram', name: 'Telegram', at: new Date().toISOString() });
    await ask([result({ result: 'Here.' })]);
    const prompt = prompts.at(-1), line = prompt.split('\n').find(text => text.startsWith('[Telegram #'));
    assert.match(line, /your final answer is sent back to this chat by itself.*desk_text_person, never desk_telegram\. \(tg:\d+\)$/);
    assert.doesNotMatch(hideTelegramTag(`${line}\nhello`), /final answer|tg:/, 'the app chat does not show that line');
    const tag = store.list('tgchat').find(item => item.linkId === 'agentbot:qa').tag, from = sent.length;
    await assert.rejects(() => telegram.sendFromAgent('qa', 'QA', 'hi', { tag }), { message: OWN_BOT });
    telegram.onTurnStart('bot-turn', 'one', { agentId: 'qa', linkId: 'agentbot:qa', chatId: '7' });
    const personalTag = telegram.chatTag('personal', '9');
    for (const options of [{ runId: 'bot-turn' }, { runId: 'bot-turn', tag: personalTag }]) await assert.rejects(() => telegram.sendFromAgent('qa', 'QA', 'hi', options), { message: OWN_BOT });
    assert.equal(sent.length, from, 'nothing was sent');
    assert.equal(store.get('tgturn', 'bot-turn').sent, false, 'so the final answer still goes out');
    assert.match(OWN_BOT, /final answer is sent back.*desk_text_person/);
    assert.deepEqual(await telegram.sendFromAgent('qa', 'QA', 'from the app', { runId: 'app-turn' }), { sent: true }, 'an app turn still reaches the personal bot');
  } finally { await app.close(); }
});

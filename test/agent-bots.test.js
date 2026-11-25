import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBridge } from '../src/telegram.js';
import { AgentBots } from '../src/agent-bots.js';

// L105: each agent owns its own Telegram bot. A tiny in-memory desk and a fake Telegram server, no network.
function setup() {
  const records = new Map(), key = (kind, id) => `${kind}:${id}`;
  const store = {
    list: kind => [...records.entries()].filter(([k]) => k.startsWith(`${kind}:`)).map(([, value]) => value),
    get: (kind, id) => records.get(key(kind, id)) ?? null, put: (kind, id, value) => { records.set(key(kind, id), value); }, delete: (kind, id) => { records.delete(key(kind, id)); },
    encrypt: text => text, decrypt: text => text, config: () => ({}), emit: () => {}, event: () => {},
  };
  store.put('specialist', 'a1', { id: 'a1', name: 'Ann' }); store.put('specialist', 'a2', { id: 'a2', name: 'Bo' });
  const turns = [], sent = [];
  const desk = { store, specialists: { ensureMain: () => {} }, specialistTurn: async (agentId, { prompt, telegram }) => { turns.push({ agentId, prompt, telegram }); desk.telegram.onTurnStart(`run-${agentId}`, `t${turns.length}`, telegram); } };
  desk.telegram = new TelegramBridge(desk, { fetcher: async () => { throw new Error('personal bot not used'); } });
  const bots = { 111111: { id: 111111, username: 'ann_bot' }, 222222: { id: 222222, username: 'bo_bot' } };
  const fetcher = async (url, options) => {
    const [, token, method] = String(url).match(/bot([^/]+)\/(\w+)$/); const body = options?.body ? JSON.parse(options.body) : {};
    if (method === 'getMe') { const me = bots[token.split(':')[0]]; return { json: async () => me ? { ok: true, result: me } : { ok: false, description: 'Unauthorized' } }; }
    sent.push({ token, method, ...body }); return { json: async () => ({ ok: true, result: true }) };
  };
  desk.agentBots = new AgentBots(desk, { fetcher });
  return { desk, store, turns, sent, agentBots: desk.agentBots };
}
const T1 = '111111:AAAAAAAAAAAAAAAAAAAAAAAA', T2 = '222222:BBBBBBBBBBBBBBBBBBBBBBBB';
const private1 = (text, id = 7) => ({ update_id: 1, message: { chat: { id, type: 'private' }, from: { first_name: 'Rex' }, text } });

test('connect saves the token encrypted, never in the status, and one bot belongs to one agent', async () => {
  const { agentBots, store } = setup();
  const status = await agentBots.connect('a1', T1);
  assert.equal(status.connected, true); assert.equal(status.botUsername, 'ann_bot'); assert.ok(status.pairCode);
  assert.ok(!JSON.stringify(status).includes('AAAA')); assert.ok(!JSON.stringify(store.get('agentbot', 'a1')).includes('AAAA'));
  await assert.rejects(() => agentBots.connect('a2', T1), /already belongs to Ann/);
  await assert.rejects(() => agentBots.connect('a2', 'nonsense'), /does not look like/);
  assert.equal((await agentBots.connect('a2', T2)).botUsername, 'bo_bot');
});

test('only the chat that sends the code becomes the owner, and its message reaches that agent and the Inbox', async () => {
  const { agentBots, desk, turns, sent } = setup();
  const { pairCode } = await agentBots.connect('a1', T1);
  await agentBots.handle('a1', private1('hello'));
  assert.equal(turns.length, 0); assert.match(sent.at(-1).text, /not set up yet/);
  await agentBots.handle('a1', private1(`/start ${pairCode}`));
  assert.equal(agentBots.status('a1').ownerLinked, true);
  await agentBots.handle('a1', private1('stranger', 99));
  assert.equal(turns.length, 0); assert.match(sent.at(-1).text, /only talks to its owner/);
  await agentBots.handle('a1', private1('Please fix the login'));
  assert.equal(turns.length, 1); assert.equal(turns[0].agentId, 'a1'); assert.match(turns[0].prompt, /Please fix the login/); assert.equal(turns[0].telegram.linkId, 'agentbot:a1');
  assert.equal(desk.telegram.inboxView().length, 1); assert.equal(desk.telegram.inboxView()[0].agentId, 'a1');
  // The agent's final reply goes back through this agent's bot, not the personal one.
  await desk.telegram.onTurnResult('run-a1', 'Done, it works now.');
  assert.deepEqual(sent.at(-1), { token: T1, method: 'sendMessage', chat_id: '7', text: 'Done, it works now.' });
});

test('groups: unknown groups wait to be allowed, allowed groups answer only when the bot is mentioned', async () => {
  const { agentBots, turns } = setup();
  await agentBots.connect('a1', T1);
  const group = text => ({ update_id: 2, message: { chat: { id: -100123, type: 'supergroup', title: 'Team' }, from: { first_name: 'Sam' }, text } });
  await agentBots.handle('a1', group('@ann_bot hi'));
  assert.equal(turns.length, 0); assert.deepEqual(agentBots.status('a1').pending, [{ id: '-100123', title: 'Team' }]);
  agentBots.allowGroup('a1', '-100123');
  assert.equal(agentBots.status('a1').pending.length, 0); assert.equal(agentBots.status('a1').groups[0].title, 'Team');
  await agentBots.handle('a1', group('just chatting'));
  assert.equal(turns.length, 0);
  await agentBots.handle('a1', group('@ann_bot what is the status?'));
  assert.equal(turns.length, 1); assert.match(turns[0].prompt, /what is the status\?/); assert.doesNotMatch(turns[0].prompt, /@ann_bot/);
  agentBots.disconnect('a1'); assert.equal(agentBots.status('a1').connected, false);
});

test('the agent can text its owner or an allowed group itself, and nobody else', async () => {
  const { agentBots, sent } = setup();
  await assert.rejects(() => agentBots.send('a1', 'hi'), /no Telegram bot/);
  const { pairCode } = await agentBots.connect('a1', T1);
  await assert.rejects(() => agentBots.send('a1', 'hi'), /not linked/);
  await agentBots.handle('a1', private1(`/start ${pairCode}`));
  assert.deepEqual(await agentBots.send('a1', 'Build is done.'), { sent: true, to: 'owner' });
  assert.deepEqual(sent.at(-1), { token: T1, method: 'sendMessage', chat_id: '7', text: 'Build is done.' });
  await assert.rejects(() => agentBots.send('a1', 'hi', '-100999'), /not allowed/);
  agentBots.allowGroup('a1', '-100123', 'Team');
  await agentBots.send('a1', 'Hello team', 'team');
  assert.equal(sent.at(-1).chat_id, '-100123');
  await assert.rejects(() => agentBots.send('a1', '  '), /Write the message/);
});

test('a turn started from a group or another chat cannot make the agent text the owner or another group', async () => {
  const { agentBots, store } = setup();
  const { pairCode } = await agentBots.connect('a1', T1);
  await agentBots.handle('a1', private1(`/start ${pairCode}`));
  agentBots.allowGroup('a1', '-100123', 'Team'); agentBots.allowGroup('a1', '-100456', 'Other');
  store.put('tgturn', 'r1', { id: 'r1', turnId: 't', agentId: 'a1', linkId: 'agentbot:a1', chatId: '-100123' });
  await assert.rejects(() => agentBots.send('a1', 'secret', 'owner', { runId: 'r1' }), /Only the bot owner/);
  await assert.rejects(() => agentBots.send('a1', 'spam', 'Other', { runId: 'r1' }), /Only the bot owner/);
  store.put('tgturn', 'r2', { id: 'r2', turnId: 't', agentId: 'a1', linkId: 'agentbot:a1', chatId: '7' });
  assert.equal((await agentBots.send('a1', 'ok', 'owner', { runId: 'r2' })).sent, true);
  assert.equal((await agentBots.send('a1', 'from the app', 'owner', { runId: 'r3' })).sent, true);
});

test('a failing Telegram call shows only a fixed message, never the token or Telegram text', async () => {
  const { agentBots } = setup();
  const leaking = new AgentBots({ store: agentBots.store, telegram: {} }, { fetcher: async url => { throw new Error(`fetch failed for ${url}`); } });
  await assert.rejects(() => leaking.connect('a1', T1), error => /could not be reached/.test(error.message) && !error.message.includes('AAAA'));
  await assert.rejects(() => agentBots.connect('a1', '999999:CCCCCCCCCCCCCCCCCCCCCCCC'), error => /refused getMe/.test(error.message) && !/Unauthorized|CCCC/.test(error.message));
});

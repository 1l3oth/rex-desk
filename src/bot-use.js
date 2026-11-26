// One use per Telegram bot. A bot's messages can have only one reader, so it is the personal bot (telegram.js), the bug
// report bot (bug-bot.js) or one agent's own bot (agent-bots.js), never two. Every place a bot token is set up asks here,
// right before it saves, with no wait in between, so two setups at once cannot both get one bot.

import { createHash } from 'node:crypto';

// The two bots saved as connections, by their connector id.
const CONNECTIONS = { telegram: 'your personal Telegram bot', 'telegram-bugs': 'the bug report bot' };

// The number before ':' in a token is the bot's id, so a bot is known even when one side holds an older token of it.
export const botIdOf = token => String(token || '').trim().split(':')[0];

// Throws when another use holds this bot. mine: the use being set up, so it may save its own bot again.
// { connectorId: 'telegram' | 'telegram-bugs' } or { agentId }.
export function assertBotFree(store, botId, mine) {
  const refuse = words => { throw new Error(`That bot is already ${words}. Make a separate bot for this in @BotFather.`); };
  for (const link of store.list('connector')) {
    if (!CONNECTIONS[link.connectorId] || link.connectorId === mine.connectorId) continue;
    const secret = store.get('secret', `connector:${link.id}`); if (!secret) continue;
    let saved = ''; try { saved = botIdOf(JSON.parse(store.decrypt(secret)).botToken); } catch { continue; }
    if (saved === String(botId)) refuse(CONNECTIONS[link.connectorId]);
  }
  const taken = store.list('agentbot').find(item => String(item.botId) === String(botId) && item.id !== mine.agentId);
  if (taken) refuse(`${taken.id === 'main' ? 'Rex Agent' : store.get('specialist', taken.id)?.name || 'another agent'}'s own bot`);
}

// ---- one reader per bot (L105 review) ----
// A bot saved in two places before the check above existed (or by an older version) must still be read by one of them only:
// two getUpdates on one bot make Telegram answer 409, and a batch one side takes is lost to the other. Every use of a bot,
// matched by the bot's id and never by the token text, is listed in a fixed order: the personal bot, the bug report bot, then
// the agents' own bots by agent id. The first one reads the bot, on every start; the others wait, show who reads it, and
// read it themselves as soon as that one is disconnected, without a restart.
// Only a use that can read is picked: the personal bot once a chat is paired (until then it never polls), and a token Telegram
// has not turned down. A token Telegram answers 401 or 404 for (revoked, or no such bot) is marked failed for that exact
// token, so the next saved use takes over; a network error or a 409 never counts. A failed use reads again only when no
// working use is left, or once a new token is saved.
const ORDER = ['telegram', 'telegram-bugs'];
const tokenHash = token => createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
const useKey = mine => mine.agentId ? `agent:${mine.agentId}` : String(mine.connectorId || '');
const failed = (store, use, token) => store.get('botfail', useKey(use))?.token === tokenHash(token);
const linkUse = (store, connectorId) => {
  const links = store.list('connector').filter(item => item.connectorId === connectorId).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  for (const link of links) {
    const secret = store.get('secret', `connector:${link.id}`); if (!secret) continue;
    let values; try { values = JSON.parse(store.decrypt(secret)); } catch { continue; }
    if (!values?.botToken) continue;
    const use = { connectorId };
    return { use, botId: String(values.botId || botIdOf(values.botToken)), paired: connectorId !== 'telegram' || Boolean(values.chatId), failed: failed(store, use, values.botToken), reader: { kind: connectorId === 'telegram' ? 'personal' : 'bugs', name: '' } };
  }
  return null;
};
export function botUses(store) {
  const uses = ORDER.map(connectorId => linkUse(store, connectorId)).filter(Boolean);
  const agents = store.list('agentbot').sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const item of agents) {
    const secret = store.get('secret', `agentbot:${item.id}`);
    let token = ''; try { token = secret ? JSON.parse(store.decrypt(secret)).botToken || '' : ''; } catch { /* unreadable */ }
    const botId = String(item.botId || botIdOf(token)); if (!botId) continue;
    const use = { agentId: item.id };
    // A token that is missing or cannot be read (a broken or foreign seal) cannot poll, so it never wins the bot: it waits like
    // an unpaired use, and lack says why for its card.
    uses.push({ use, botId, paired: Boolean(token), lack: token ? '' : secret ? 'unreadable' : 'missing', failed: Boolean(token) && failed(store, use, token), reader: { kind: 'agent', name: item.id === 'main' ? 'Rex Agent' : store.get('specialist', item.id)?.name || '' } });
  }
  return uses;
}
const same = (left, right) => (left.connectorId || '') === (right.connectorId || '') && (left.agentId || '') === (right.agentId || '');
// The use that reads this bot now. mine: { connectorId } or { agentId }. reads: true for the reader (or a bot saved once);
// otherwise readBy says which one reads it, for the setup screen: { kind: personal | bugs | agent, name } (null when none does).
export function botReader(store, mine) {
  const uses = botUses(store), own = uses.find(item => same(item.use, mine));
  if (!own) return { reads: true, readBy: null };
  const able = uses.filter(item => item.botId === own.botId && item.paired);
  // An agent bot whose token is missing or cannot be read on this computer never reads: why says so (missing | unreadable), so
  // its card never shows Connected.
  if (!own.paired && own.reader.kind === 'agent') return { reads: false, readBy: null, why: own.lack };
  // A personal bot not paired yet never reads; it pairs once no working use reads the bot (TelegramBridge.link).
  if (!own.paired) return { reads: false, readBy: able.find(item => !item.failed)?.reader || null };
  const first = able.find(item => !item.failed) || able[0];
  if (!first) return { reads: false, readBy: null };
  // An agent bot whose token Telegram turned down (401 or 404, noteBotAnswer) shows Not reading (why: refused) and the Save token
  // box, even while it still asks as the last use left; a network error, a 409 or a 5xx never marks it, so an outage never shows this.
  const refused = own.failed && own.reader.kind === 'agent' ? { why: 'refused' } : {};
  return same(first.use, mine) ? { reads: true, readBy: null, ...refused } : { reads: false, readBy: first.reader, ...refused };
}
// What a Telegram answer means for this use's token: 401 or 404 marks it failed (the next use takes over), a good answer
// clears that. Anything else (a network error, a 409, a timeout) changes nothing.
export function noteBotAnswer(store, mine, token, error = null) {
  const code = Number(error?.code) || 0, key = useKey(mine);
  if (!error) { if (store.get('botfail', key)) store.delete('botfail', key); return; }
  if (code === 401 || code === 404) store.put('botfail', key, { id: key, token: tokenHash(token), code, at: new Date().toISOString() });
}

// ---- one getUpdates at a time per bot ----
// A poll is a long wait (up to 45 s). When the reader changes (a disconnect, a failed token), the new reader must not ask while
// the old one is still waiting, or Telegram answers 409 and a batch can go to the old side. Every getUpdates of a bot (the poll
// loops and the Link button) goes through here: a read by another use is cancelled and waited for first, a read by this same
// use is waited for, and only then does this one start. abort: the caller's AbortController, so another use can cancel it.
// still: checked once this read holds the bot, after any wait: the connection may have been removed or replaced, or another use
// may now own the bot. When it says no, nothing is read and SKIPPED comes back, so the caller looks again from the top.
const inFlight = new WeakMap();
export const SKIPPED = Symbol('skipped');
export async function readBot(store, botId, mine, abort, read, still = () => true) {
  let reads = inFlight.get(store); if (!reads) inFlight.set(store, reads = new Map());
  const key = String(botId);
  // A waiter that may no longer read (removed, replaced, or another use owns the bot) gives up before it cancels anyone: a stale
  // one must never end the poll of the use that does own the bot. It is checked again after every wait, and once it holds the bot.
  for (let now = reads.get(key); now; now = reads.get(key)) {
    if (abort.signal.aborted || !still()) return SKIPPED;
    if (!same(now.use, mine)) now.abort.abort();
    await now.done;
  }
  let finish; const entry = { use: mine, abort, done: new Promise(resolve => { finish = resolve; }) };
  reads.set(key, entry);
  try { return abort.signal.aborted || !still() ? SKIPPED : await read(abort.signal); } finally { if (reads.get(key) === entry) reads.delete(key); finish(); }
}
// Cancels this use's read in flight and resolves once it has ended.
export async function endBotRead(store, mine) {
  const reads = inFlight.get(store); if (!reads) return;
  for (const now of [...reads.values()]) if (same(now.use, mine)) { now.abort.abort(); await now.done; }
}

// One use per Telegram bot. A bot's messages can have only one reader, so it is the personal bot (telegram.js), the bug
// report bot (bug-bot.js) or one agent's own bot (agent-bots.js), never two. Every place a bot token is set up asks here,
// right before it saves, with no wait in between, so two setups at once cannot both get one bot.

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
const ORDER = ['telegram', 'telegram-bugs'];
const linkUse = (store, connectorId) => {
  const links = store.list('connector').filter(item => item.connectorId === connectorId).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  for (const link of links) {
    const secret = store.get('secret', `connector:${link.id}`); if (!secret) continue;
    let values; try { values = JSON.parse(store.decrypt(secret)); } catch { continue; }
    if (values?.botToken) return { use: { connectorId }, botId: String(values.botId || botIdOf(values.botToken)), reader: { kind: connectorId === 'telegram' ? 'personal' : 'bugs', name: '' } };
  }
  return null;
};
export function botUses(store) {
  const uses = ORDER.map(connectorId => linkUse(store, connectorId)).filter(Boolean);
  const agents = store.list('agentbot').filter(item => store.get('secret', `agentbot:${item.id}`)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const item of agents) {
    let botId = String(item.botId || '');
    if (!botId) { try { botId = botIdOf(JSON.parse(store.decrypt(store.get('secret', `agentbot:${item.id}`))).botToken); } catch { continue; } }
    uses.push({ use: { agentId: item.id }, botId, reader: { kind: 'agent', name: item.id === 'main' ? 'Rex Agent' : store.get('specialist', item.id)?.name || '' } });
  }
  return uses;
}
const same = (left, right) => (left.connectorId || '') === (right.connectorId || '') && (left.agentId || '') === (right.agentId || '');
// The use that reads this bot now. mine: { connectorId } or { agentId }. reads: true for the reader (or a bot saved once);
// otherwise readBy says which one reads it, for the setup screen: { kind: personal | bugs | agent, name } (null when it reads).
export function botReader(store, mine) {
  const uses = botUses(store), own = uses.find(item => same(item.use, mine));
  if (!own) return { reads: true, readBy: null };
  const first = uses.find(item => item.botId === own.botId);
  return same(first.use, mine) ? { reads: true, readBy: null } : { reads: false, readBy: first.reader };
}

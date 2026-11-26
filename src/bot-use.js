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

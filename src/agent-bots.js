// One Telegram bot per agent (L105). Each agent owns its own bot: the person pastes the bot's token in that agent's
// Connectors tab, sends a one-time code to the bot to make themselves its owner, and can then allow it in groups. The owner's
// private messages (and messages in allowed groups that mention the bot) go to that agent as a message from Telegram, show
// in the Inbox, and the agent's final reply goes back to the chat it came from. The token stays encrypted on this computer.
import { randomInt, randomUUID } from 'node:crypto';
import { fromTelegram } from './telegram.js';

const API = 'https://api.telegram.org';
// What a person can send besides text. Telegram's own notices (someone joined, a message was pinned) are none of these.
const MEDIA = ['photo', 'video', 'video_note', 'voice', 'audio', 'document', 'animation', 'sticker', 'contact', 'location', 'poll', 'dice'];
export const TEXT_ONLY = 'Only text works here for now. Please send your message as text.';
const TOKEN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const clip = (text, size = 3800) => { const value = String(text ?? ''); return value.length > size ? `${value.slice(0, size - 1)}…` : value; };
const codeIn = text => String(text || '').trim().replace(/^\/start(@\w+)?\s*/i, '').trim().toUpperCase();
const PAIR_MS = 30 * 60 * 1000;
// Rex Desk's two other bots, saved as connections. One bot has one reader, so none of them can also be an agent's.
const OTHER_BOTS = { telegram: 'your personal Telegram bot', 'telegram-bugs': 'the bug report bot' };
export const linkOf = agentId => `agentbot:${agentId}`;
const nameOf = from => [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || '';

export class AgentBots {
  constructor(desk, { fetcher = fetch } = {}) { this.desk = desk; this.store = desk.store; this.fetcher = fetcher; this.running = false; this.loops = new Map(); }

  // Errors never carry Telegram's own text or the request address (both can hold the token): only a fixed message.
  async call(token, method, params = {}, timeoutMs = 15000) {
    let data;
    try {
      const response = await this.fetcher(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
      data = await response.json().catch(() => ({}));
    } catch { throw new Error('Telegram could not be reached.'); }
    if (!data.ok) throw new Error(`Telegram refused ${method}${data.error_code ? ` (${data.error_code})` : ''}.`);
    return data.result;
  }
  agent(agentId) {
    if (agentId === 'main') return { id: 'main', name: 'Rex Agent' };
    const agent = this.store.get('specialist', agentId); return agent ? { id: agent.id, name: agent.name } : null;
  }
  record(agentId) { return this.store.get('agentbot', agentId) || null; }
  token(agentId) {
    const secret = this.store.get('secret', linkOf(agentId)); if (!secret) return '';
    try { return JSON.parse(this.store.decrypt(secret)).botToken || ''; } catch { return ''; }
  }
  // What the tab shows. The token is never part of it.
  status(agentId) {
    const record = this.record(agentId);
    if (!record) return { connected: false };
    const fresh = record.pairCode && Number(record.pairUntil) > Date.now();
    return { connected: true, botUsername: record.botUsername, owner: record.ownerName || '', ownerLinked: Boolean(record.ownerChatId), pairCode: record.ownerChatId ? '' : (fresh ? record.pairCode : ''), groups: record.groups || [], pending: record.pending || [] };
  }
  // Which of the other two already uses this bot, or ''. The number before ':' in a token is the bot's id, so a bot is
  // found even when one side holds an older token of it.
  usedElsewhere(botId) {
    for (const link of this.store.list('connector').filter(item => OTHER_BOTS[item.connectorId])) {
      const secret = this.store.get('secret', `connector:${link.id}`); if (!secret) continue;
      let saved = ''; try { saved = String(JSON.parse(this.store.decrypt(secret)).botToken || ''); } catch { continue; }
      if (saved.split(':')[0] === String(botId)) return OTHER_BOTS[link.connectorId];
    }
    return '';
  }
  async connect(agentId, botToken) {
    const agent = this.agent(agentId); if (!agent) throw new Error('That agent is gone.');
    const token = String(botToken || '').trim();
    if (!TOKEN.test(token)) throw new Error('That does not look like a bot token. Copy it from @BotFather: it looks like 123456:ABC-...');
    const me = await this.call(token, 'getMe', {}, 10000).catch(error => { throw new Error(`Telegram did not accept that token: ${error.message}`); });
    const taken = this.store.list('agentbot').find(item => String(item.botId) === String(me.id) && item.id !== agentId);
    if (taken) throw new Error(`That bot already belongs to ${this.agent(taken.id)?.name || 'another agent'}. Make a separate bot for each agent in @BotFather.`);
    const other = this.usedElsewhere(me.id);
    if (other) throw new Error(`That bot is already ${other}. Make a separate bot for this agent in @BotFather.`);
    this.store.put('secret', linkOf(agentId), this.store.encrypt(JSON.stringify({ botToken: token })));
    this.store.put('agentbot', agentId, { id: agentId, botId: me.id, botUsername: me.username || '', ownerChatId: '', ownerName: '', groups: [], pending: [], offset: 0, pairCode: newCode(), pairUntil: Date.now() + PAIR_MS, at: new Date().toISOString() });
    await this.call(token, 'deleteWebhook', {}, 10000).catch(() => {});
    this.ensureLoop(agentId);
    return this.status(agentId);
  }
  disconnect(agentId) {
    this.loops.get(agentId)?.abort?.abort(); this.loops.delete(agentId);
    this.store.delete('agentbot', agentId); this.store.delete('secret', linkOf(agentId));
    return { connected: false };
  }
  // A new code, to link another person's chat as the owner.
  newCode(agentId) {
    const record = this.record(agentId); if (!record) throw new Error('Connect the bot first.');
    this.store.put('agentbot', agentId, { ...record, ownerChatId: '', ownerName: '', pairCode: newCode(), pairUntil: Date.now() + PAIR_MS });
    return this.status(agentId);
  }
  allowGroup(agentId, id, title = '') {
    const record = this.record(agentId); if (!record) throw new Error('Connect the bot first.');
    const gid = String(id || '').trim(); if (!/^-?\d+$/.test(gid)) throw new Error('A group id is a number, like -1001234567890.');
    const known = (record.pending || []).find(item => String(item.id) === gid);
    const groups = [...(record.groups || []).filter(item => String(item.id) !== gid), { id: gid, title: String(title || known?.title || '').slice(0, 80) }];
    this.store.put('agentbot', agentId, { ...record, groups, pending: (record.pending || []).filter(item => String(item.id) !== gid) });
    return this.status(agentId);
  }
  removeGroup(agentId, id) {
    const record = this.record(agentId); if (!record) throw new Error('Connect the bot first.');
    this.store.put('agentbot', agentId, { ...record, groups: (record.groups || []).filter(item => String(item.id) !== String(id)) });
    return this.status(agentId);
  }

  // ---- polling: one long poll per connected agent ----
  start() { this.running = true; for (const record of this.store.list('agentbot')) this.ensureLoop(record.id); }
  async stop() { this.running = false; const loops = [...this.loops.values()]; for (const loop of loops) loop.abort?.abort(); await Promise.allSettled(loops.map(loop => loop.done)); this.loops.clear(); }
  ensureLoop(agentId) {
    if (!this.running || this.loops.has(agentId)) return;
    const loop = { abort: null, done: null }; this.loops.set(agentId, loop);
    loop.done = this.poll(agentId, loop).finally(() => { if (this.loops.get(agentId) === loop) this.loops.delete(agentId); });
  }
  async poll(agentId, loop) {
    while (this.running && this.loops.get(agentId) === loop) {
      const record = this.record(agentId), token = this.token(agentId); if (!record || !token) return;
      try {
        loop.abort = new AbortController();
        const response = await this.fetcher(`${API}/bot${token}/getUpdates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: record.offset || 0, timeout: 30, allowed_updates: ['message', 'my_chat_member'] }), signal: loop.abort.signal });
        const data = await response.json().catch(() => ({})); if (!data.ok) throw new Error(data.description || 'getUpdates failed');
        for (const update of data.result) {
          if (!this.running || this.loops.get(agentId) !== loop) return;
          try { await this.handle(agentId, update); } catch (error) { this.store.event?.('', 'telegram-error', { message: `agent bot: ${error.message}` }, true); }
          const now = this.record(agentId); if (!now) return;
          this.store.put('agentbot', agentId, { ...now, offset: Math.max(now.offset || 0, update.update_id + 1) });
        }
      } catch {
        if (!this.running || this.loops.get(agentId) !== loop) return;
        await new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref?.(); });
      }
    }
  }

  async handle(agentId, update) {
    const record = this.record(agentId), token = this.token(agentId); if (!record || !token) return;
    const say = (chatId, text) => this.call(token, 'sendMessage', { chat_id: chatId, text: clip(text) }).catch(() => {});
    const joined = update.my_chat_member;
    if (joined) {
      if (['group', 'supergroup'].includes(joined.chat?.type) && ['member', 'administrator'].includes(joined.new_chat_member?.status)) this.noteGroup(agentId, joined.chat);
      return;
    }
    const message = update.message; if (!message?.chat) return;
    const chat = message.chat, text = String(message.text || '').trim(), agentName = this.agent(agentId)?.name || 'this agent';
    if (chat.type === 'private') {
      // Media and notices from anyone but the owner get no reply at all. Until an owner is linked, nobody is the owner.
      if (!text && String(chat.id) !== String(record.ownerChatId)) return;
      if (!record.ownerChatId) {
        if (record.pairCode && Number(record.pairUntil) > Date.now() && codeIn(text) === record.pairCode) {
          const name = nameOf(message.from) || 'you';
          this.store.put('agentbot', agentId, { ...record, ownerChatId: String(chat.id), ownerName: name, pairCode: '', pairUntil: 0 });
          this.store.emit?.('change', { kind: 'connector' });
          return say(chat.id, `Linked. You can talk to ${agentName} here.`);
        }
        return say(chat.id, 'This bot is not set up yet. Send the code shown in Rex Desk, in the agent\'s Connectors tab.');
      }
      if (String(chat.id) !== String(record.ownerChatId)) return say(chat.id, 'This agent only talks to its owner.');
      if (!text) return this.textOnly(agentId, message, say);
      if (text.startsWith('/')) return say(chat.id, `You are talking with ${agentName}. Write a message and it goes to them.`);
      return this.route(agentId, chat, text, record.ownerName || 'the person');
    }
    if (!['group', 'supergroup'].includes(chat.type)) return;
    if (!(record.groups || []).some(item => String(item.id) === String(chat.id))) { this.noteGroup(agentId, chat); return; }
    const me = `@${record.botUsername}`.toLowerCase();
    // A photo or file is for the bot when its caption mentions it or it replies to the bot.
    const addressed = (text || String(message.caption || '')).toLowerCase().includes(me) || String(message.reply_to_message?.from?.id) === String(record.botId);
    if (!addressed) return;
    if (!text) return this.textOnly(agentId, message, say);
    const stripped = text.replace(new RegExp(me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').trim() || text;
    return this.route(agentId, chat, stripped, `${nameOf(message.from) || 'Someone'} in ${chat.title || 'a group'}`);
  }
  // Media is not passed to the agent yet, and the person is told so, once for an album (each of its pictures is a message).
  textOnly(agentId, message, say) {
    if (!MEDIA.some(kind => message[kind])) return;
    if (message.media_group_id) {
      const album = `${agentId}:${message.chat.id}:${message.media_group_id}`;
      if (this.album === album) return;
      this.album = album;
    }
    return say(message.chat.id, TEXT_ONLY);
  }
  noteGroup(agentId, chat) {
    const record = this.record(agentId); if (!record) return;
    const known = list => (list || []).some(item => String(item.id) === String(chat.id));
    if (known(record.pending) || known(record.groups)) return;
    this.store.put('agentbot', agentId, { ...record, pending: [...(record.pending || []), { id: String(chat.id), title: String(chat.title || '').slice(0, 80) }].slice(-20) });
    this.store.emit?.('change', { kind: 'connector' });
  }
  // The message goes to the agent as a message from Telegram; its reply goes back to this chat (src/telegram.js onTurnResult).
  async route(agentId, chat, text, who) {
    const bridge = this.desk.telegram, link = linkOf(agentId);
    if (agentId === 'main') this.desk.specialists.ensureMain();
    const tag = bridge.chatTag(link, chat.id), key = randomUUID().replaceAll('-', '').slice(0, 12);
    // Said on the hidden first line, so the agent does not look for a tool to answer with.
    const owner = String(chat.id) === String(this.record(agentId)?.ownerChatId);
    const how = `This came through your own bot: your final answer is sent back to this chat by itself, so do not send it with a tool.${owner ? ' Only for an extra message use desk_text_person, never desk_telegram.' : ''}`;
    const prompt = fromTelegram(text, key, `Telegram, ${String(who).replace(/\s+/g, ' ').slice(0, 40)}. ${how} (${tag})`);
    const replyTo = { agentId, linkId: link, chatId: String(chat.id), at: new Date().toISOString(), keys: [key] };
    this.store.put('tgqueued', key, { id: key, ...replyTo, keys: undefined });
    try { await this.desk.specialistTurn(agentId, { prompt, telegram: replyTo }); } catch (error) { this.store.delete('tgqueued', key); throw error; }
    bridge.noteInbox(agentId, { values: { chatName: `${this.agent(agentId)?.name || 'Agent'} bot: ${who}` } }, tag, text);
  }
  // The agent starts a message itself (desk_text_person): to its owner, or to one allowed group. Only these two can ever be written to.
  async send(agentId, text, to = 'owner', { runId = '' } = {}) {
    const record = this.record(agentId), token = this.token(agentId);
    if (!record || !token) throw new Error('This agent has no Telegram bot. Connect one in its Connectors tab.');
    // Only the owner can make the agent write first: a turn that a group or another chat started may only be answered in that chat.
    const turn = runId ? this.store.get('tgturn', runId) : null;
    if (turn && !(turn.linkId === linkOf(agentId) && record.ownerChatId && String(turn.chatId) === String(record.ownerChatId))) throw new Error("Only the bot owner can ask you to text someone. Answer in the chat the message came from.");
    const body = String(text ?? '').trim(); if (!body) throw new Error('Write the message first.');
    let chatId = record.ownerChatId;
    if (to !== 'owner') {
      const group = (record.groups || []).find(item => String(item.id) === String(to) || (item.title && item.title.toLowerCase() === String(to).toLowerCase()));
      if (!group) throw new Error('That group is not allowed for this bot. The person allows groups in the Connectors tab.');
      chatId = group.id;
    } else if (!chatId) throw new Error('The owner has not linked this bot yet. They send the code from the Connectors tab to the bot.');
    await this.call(token, 'sendMessage', { chat_id: chatId, text: clip(body) });
    return { sent: true, to: to === 'owner' ? 'owner' : String(chatId) };
  }
  // The agent's final reply, back to the chat that asked (called from TelegramBridge.onTurnResult).
  async reply(turn, text) {
    const agentId = String(turn.linkId).slice('agentbot:'.length), record = this.record(agentId), token = this.token(agentId);
    if (!record || !token) return;
    const allowed = String(turn.chatId) === String(record.ownerChatId) || (record.groups || []).some(item => String(item.id) === String(turn.chatId));
    if (!allowed) return;
    await this.call(token, 'sendMessage', { chat_id: turn.chatId, text: clip(String(text).trim()) });
  }
}

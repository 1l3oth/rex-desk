// One Telegram bot per agent (L105). Each agent owns its own bot: the person pastes the bot's token in that agent's
// Connectors tab, sends a one-time code to the bot to make themselves its owner, and can then allow it in groups. The owner's
// private messages (and messages in allowed groups that mention the bot) go to that agent as a message from Telegram, show
// in the Inbox, and the agent's final reply goes back to the chat it came from. The token stays encrypted on this computer.
import { randomInt, randomUUID } from 'node:crypto';
import { fromTelegram } from './telegram.js';
import { SKIPPED, assertBotFree, botReader, endBotRead, noteBotAnswer, readBot } from './bot-use.js';

const API = 'https://api.telegram.org';
// What a person can send besides text. Telegram's own notices (someone joined, a message was pinned) are none of these.
const MEDIA = ['photo', 'video', 'video_note', 'voice', 'audio', 'document', 'animation', 'sticker', 'contact', 'location', 'poll', 'dice'];
export const TEXT_ONLY = 'Only text works here for now. Please send your message as text.';
export const ROOM_TEXT_ONLY = 'Only text messages sync with Rex Desk. Media is not synced.';
const ROOM_MEDIA_NOTE = '[Media/files attached in Rex Desk are not synced]';
const TG_MEDIA_NOTE = '[Media not synced from Telegram]';
const ROOM_MAP_MAX = 2000;
const TOKEN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const clip = (text, size = 3800) => { const value = String(text ?? ''); return value.length > size ? `${value.slice(0, size - 1)}…` : value; };
const splitTelegramText = value => {
  const text = String(value || ''), chunks = [];
  for (let rest = text; rest.length > 3800;) {
    let cut = rest.lastIndexOf('\n', 3800); if (cut < 1200) cut = rest.lastIndexOf(' ', 3800); if (cut < 1200) cut = 3800;
    chunks.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [' '];
};
// Strip local attachment blocks and local upload images before sending a room message to Telegram, so local paths never leak.
function roomTextForTelegram(message) {
  let raw = String(message?.text || ''), hasMedia = false;
  if (message?.from?.type === 'human') raw = raw.replace(/\s*\(Sent by voice: [^)]*\)\s*$/, '');
  raw = raw.replace(/\n*Attached files \(read them from these paths\):\n((?:- .+\n?)+)/g, () => { hasMedia = true; return ''; });
  raw = raw.replace(/\s*Attached files \(read them from these paths\):\s*-\s+(.+)$/s, () => { hasMedia = true; return ''; });
  raw = raw.replace(/!\[[^\]]*\]\(\/api\/uploads\/[^)\s]+\)/g, () => { hasMedia = true; return ''; });
  const clean = raw.trim();
  if (!clean) return hasMedia ? ROOM_MEDIA_NOTE : '';
  return hasMedia ? `${clean}\n\n${ROOM_MEDIA_NOTE}` : clean;
}
const codeIn = text => String(text || '').trim().replace(/^\/start(@\w+)?\s*/i, '').trim().toUpperCase();
const PAIR_MS = 30 * 60 * 1000;
export const linkOf = agentId => `agentbot:${agentId}`;
const nameOf = from => [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || '';

export class AgentBots {
  constructor(desk, { fetcher = fetch } = {}) { this.desk = desk; this.store = desk.store; this.fetcher = fetcher; this.running = false; this.loops = new Map(); this.roomQueues = new Map(); }

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
    const reader = botReader(this.store, { agentId });
    return { connected: true, readBy: reader.readBy, why: reader.why || '', botUsername: record.botUsername, owner: record.ownerName || '', ownerLinked: Boolean(record.ownerChatId), pairCode: record.ownerChatId ? '' : (fresh ? record.pairCode : ''), groups: record.groups || [], pending: record.pending || [] };
  }
  roomAuthor(message, record) {
    if (message.from?.type === 'agent') return String(message.from.label || this.agent(message.from.id)?.name || 'Agent').trim() || 'Agent';
    if (message.from?.type === 'human') return String(this.store.config?.()?.profile?.name || this.store.config?.()?.name || record?.ownerName || 'You').trim() || 'You';
    return String(message.from?.label || 'Rex Desk').trim() || 'Rex Desk';
  }
  noteRoomMessage(entry) {
    const id = String(entry.id || `${entry.agentId}:${entry.groupId}:${entry.telegramMessageId}`);
    this.store.put('roomtgmsg', id, { ...entry, id, groupId: String(entry.groupId), telegramMessageId: String(entry.telegramMessageId), at: entry.at || new Date().toISOString() });
    const rows = this.store.list('roomtgmsg').filter(item => item.roomId === entry.roomId).sort((left, right) => String(left.at || '').localeCompare(String(right.at || '')));
    for (const old of rows.slice(0, Math.max(0, rows.length - ROOM_MAP_MAX))) this.store.delete('roomtgmsg', old.id);
  }
  roomSyncState(roomId) {
    const room = this.desk.rooms?.room?.(roomId), link = room?.telegramSync || null;
    if (!link) return null;
    if (!room.members.includes(link.agentId)) return { active: false, reason: 'member_removed' };
    const record = this.record(link.agentId), token = this.token(link.agentId);
    if (!record || !token) return { active: false, reason: 'bot_disconnected' };
    if (!(record.groups || []).some(group => String(group.id) === String(link.groupId))) return { active: false, reason: 'group_removed' };
    const reader = botReader(this.store, { agentId: link.agentId });
    if (!reader.reads || reader.why) return { active: false, reason: 'bot_not_reading', why: reader.why || '', readBy: reader.readBy || null };
    return { active: true, reason: '' };
  }
  roomOptions(roomId) {
    const room = this.desk.rooms?.room?.(roomId); if (!room) return [];
    const rooms = this.desk.rooms?.list?.() || [];
    return room.members.flatMap(agentId => {
      const record = this.record(agentId);
      if (!record || !this.token(agentId)) return [];
      return (record.groups || []).map(group => {
        const gid = String(group.id);
        const usedBy = rooms.find(item => item.id !== roomId && String(item.telegramSync?.groupId) === gid)?.name || '';
        return { agentId, agentName: this.agent(agentId)?.name || 'Agent', botUsername: record.botUsername || '', groupId: gid, groupTitle: group.title || gid, ...(usedBy ? { usedBy } : {}) };
      });
    });
  }
  roomSync(roomId) {
    const room = this.desk.rooms.room(roomId), linked = room.telegramSync || null, state = this.roomSyncState(roomId);
    return { linked, options: this.roomOptions(roomId), active: Boolean(state?.active), reason: state?.reason || '' };
  }
  setRoomSync(roomId, { agentId, groupId } = {}) {
    const room = this.desk.rooms.room(roomId), id = String(agentId || ''), gid = String(groupId || '');
    if (!room.members.includes(id)) throw new Error('Add the bot agent to this room first.');
    const record = this.record(id);
    if (!record || !this.token(id)) throw new Error('Connect this agent’s Telegram bot first.');
    const group = (record.groups || []).find(item => String(item.id) === gid);
    if (!group) throw new Error('Allow this Telegram group in the agent’s Connectors tab first.');
    const occupied = this.desk.rooms.list().find(item => item.id !== roomId && String(item.telegramSync?.groupId) === gid);
    if (occupied) throw new Error('This Telegram group is already linked to another room.');
    this.store.put('room', roomId, { ...room, telegramSync: { agentId: id, groupId: gid, groupTitle: group.title || gid, botUsername: record.botUsername || '' } });
    return this.roomSync(roomId);
  }
  clearRoomSync(roomId) {
    const room = this.desk.rooms.room(roomId), { telegramSync, ...rest } = room;
    this.store.put('room', roomId, rest);
    return this.roomSync(roomId);
  }
  mirrorRoomMessage(message) {
    if (!message?.roomId || message.telegram) return Promise.resolve();
    const room = this.desk.rooms?.room?.(message.roomId), link = room?.telegramSync;
    if (!link || !['human', 'agent'].includes(message.from?.type)) return Promise.resolve();
    const previous = this.roomQueues.get(room.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.sendRoomMessage(room, link, message)).catch(() => {
      this.store.event?.('', 'room-telegram-error', { roomId: room.id, message: 'Could not sync a room message to Telegram.' }, true);
    });
    this.roomQueues.set(room.id, next);
    void next.finally(() => { if (this.roomQueues.get(room.id) === next) this.roomQueues.delete(room.id); });
    return next;
  }
  async sendRoomMessage(room, link, message) {
    const record = this.record(link.agentId), token = this.token(link.agentId);
    if (!room.members.includes(link.agentId) || !record || !token || !(record.groups || []).some(item => String(item.id) === String(link.groupId))) throw new Error('Telegram link is unavailable.');
    const body = roomTextForTelegram(message);
    if (!body) return;
    const author = this.roomAuthor(message, record);
    const chunks = splitTelegramText(`${author}:\n${body}`);
    const mapped = message.replyTo ? this.store.list('roomtgmsg').filter(item => item.roomId === room.id && item.roomMessageId === message.replyTo && String(item.groupId) === String(link.groupId)) : [];
    const parent = mapped.find(item => item.agentId === link.agentId) || mapped[0] || null;
    let replyId = parent?.telegramMessageId;
    for (const text of chunks) {
      const replyNum = replyId ? (Number(replyId) || replyId) : '';
      const sent = await this.call(token, 'sendMessage', { chat_id: link.groupId, text, ...(replyNum ? { reply_to_message_id: replyNum, allow_sending_without_reply: true } : {}) });
      replyId = sent.message_id;
      this.noteRoomMessage({ roomId: room.id, roomMessageId: message.id, agentId: link.agentId, groupId: String(link.groupId), telegramMessageId: sent.message_id });
    }
  }
  async connect(agentId, botToken) {
    const agent = this.agent(agentId); if (!agent) throw new Error('That agent is gone.');
    const token = String(botToken || '').trim();
    if (!TOKEN.test(token)) throw new Error('That does not look like a bot token. Copy it from @BotFather: it looks like 123456:ABC-...');
    const me = await this.call(token, 'getMe', {}, 10000).catch(error => { throw new Error(`Telegram did not accept that token: ${error.message}`); });
    const taken = this.store.list('agentbot').find(item => String(item.botId) === String(me.id) && item.id !== agentId);
    if (taken) throw new Error(`That bot already belongs to ${this.agent(taken.id)?.name || 'another agent'}. Make a separate bot for each agent in @BotFather.`);
    assertBotFree(this.store, me.id, { agentId });
    this.store.put('secret', linkOf(agentId), this.store.encrypt(JSON.stringify({ botToken: token })));
    this.store.put('agentbot', agentId, { id: agentId, botId: me.id, botUsername: me.username || '', ownerChatId: '', ownerName: '', groups: [], pending: [], offset: 0, pairCode: newCode(), pairUntil: Date.now() + PAIR_MS, at: new Date().toISOString() });
    await this.call(token, 'deleteWebhook', {}, 10000).catch(() => {});
    this.ensureLoop(agentId);
    return this.status(agentId);
  }
  // A new token for the bot this agent already has, when its saved one is missing or cannot be read (or was made again in
  // @BotFather). The owner, groups and read position stay. A token of a different bot is refused: that bot never takes over
  // this pairing; connecting a different bot is Disconnect, then Connect.
  async replaceToken(agentId, botToken) {
    const record = this.record(agentId); if (!record) throw new Error('Connect the bot first.');
    const token = String(botToken || '').trim();
    if (!TOKEN.test(token)) throw new Error('That does not look like a bot token. Copy it from @BotFather: it looks like 123456:ABC-...');
    const me = await this.call(token, 'getMe', {}, 10000).catch(error => { throw new Error(`Telegram did not accept that token: ${error.message}`); });
    if (String(me.id) !== String(record.botId)) throw new Error('That token is for a different bot. Paste the token of this bot, or disconnect and connect the other bot.');
    assertBotFree(this.store, me.id, { agentId });
    const now = this.record(agentId); if (!now || String(now.botId) !== String(me.id)) throw new Error('This bot changed meanwhile. Try again.');
    this.store.put('secret', linkOf(agentId), this.store.encrypt(JSON.stringify({ botToken: token })));
    this.store.put('agentbot', agentId, { ...now, botUsername: me.username || now.botUsername });
    noteBotAnswer(this.store, { agentId }, token, null);
    await this.call(token, 'deleteWebhook', {}, 10000).catch(() => {});
    this.ensureLoop(agentId);
    return this.status(agentId);
  }
  // Its poll still out is cancelled at once; the next use of the same bot waits for it to end before it asks (bot-use.js readBot).
  disconnect(agentId) {
    this.loops.get(agentId)?.abort?.abort(); this.loops.delete(agentId);
    this.store.delete('agentbot', agentId); this.store.delete('secret', linkOf(agentId));
    void endBotRead(this.store, { agentId });
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
      // Another use of the same bot reads it (bot-use.js botReader): wait, and read it once that one is disconnected.
      if (!botReader(this.store, { agentId }).reads) { await new Promise(resolve => { const timer = setTimeout(resolve, this.waitMs ?? 3000); timer.unref?.(); }); continue; }
      try {
        const abort = loop.abort = new AbortController(), mine = { agentId };
        const data = await readBot(this.store, String(record.botId), mine, abort, async signal => {
          const response = await this.fetcher(`${API}/bot${token}/getUpdates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: record.offset || 0, timeout: 30, allowed_updates: ['message', 'my_chat_member'] }), signal });
          const answer = await response.json().catch(() => ({}));
          // A 401 or 404 means Telegram turned this token down: the next saved use of the bot takes over (bot-use.js).
          noteBotAnswer(this.store, mine, token, answer.ok ? null : { code: answer.error_code });
          return answer;
        }, () => this.running && this.loops.get(agentId) === loop && this.token(agentId) === token && String(this.record(agentId)?.botId) === String(record.botId) && botReader(this.store, mine).reads);
        // The bot changed or another use took it while this one waited for the bot: look again from the top.
        if (data === SKIPPED) continue;
        if (!data.ok) throw new Error('getUpdates failed');
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
    const say = (chatId, text, extra = {}) => this.call(token, 'sendMessage', { chat_id: chatId, text: clip(text), ...extra }).catch(() => {});
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
    if (message.from?.is_bot || String(message.from?.id || '') === String(record.botId)) return;
    if (!(record.groups || []).some(item => String(item.id) === String(chat.id))) { this.noteGroup(agentId, chat); return; }
    const me = record.botUsername ? `@${record.botUsername}`.toLowerCase() : '';
    const mentionRe = record.botUsername ? new RegExp(`(?<![\\w@])@${record.botUsername.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'ig') : null;
    // A photo or file is for the bot when its caption mentions it or it replies to the bot.
    const caption = String(message.caption || '').trim();
    const addressed = (me && (text || caption).toLowerCase().includes(me)) || String(message.reply_to_message?.from?.id) === String(record.botId);
    const roomsList = this.desk.rooms?.list?.() || [];
    const groupRoom = roomsList.find(item => String(item.telegramSync?.groupId) === String(chat.id) && item.members.includes(item.telegramSync?.agentId));
    if (groupRoom) {
      // One bot bridges a synced Telegram group; any other agent bot allowed in the same group stays quiet to avoid duplicates and loops.
      if (groupRoom.telegramSync.agentId !== agentId) return;
      const msgId = message.message_id != null ? String(message.message_id) : '';
      if (msgId && this.store.get('roomtgmsg', `${agentId}:${chat.id}:${msgId}`)) return;
      const hasMedia = MEDIA.some(kind => message[kind]);
      if (!text && !hasMedia) return;
      if (!text && hasMedia) {
        await this.textOnly(agentId, message, say, { replyTo: message.message_id, text: ROOM_TEXT_ONLY });
        if (!caption) return;
      }
      const rawText = text || caption;
      const botMentioned = Boolean(mentionRe && rawText.match(mentionRe));
      const stripped = (mentionRe ? rawText.replace(mentionRe, '').trim() : rawText) || rawText;
      const postedText = !text && hasMedia ? `${TG_MEDIA_NOTE}\n${stripped}` : stripped;
      const replyTgId = message.reply_to_message?.message_id != null ? String(message.reply_to_message.message_id) : '';
      const mapped = replyTgId ? (this.store.get('roomtgmsg', `${agentId}:${chat.id}:${replyTgId}`) || this.store.list('roomtgmsg').find(item => item.roomId === groupRoom.id && String(item.groupId) === String(chat.id) && String(item.telegramMessageId) === replyTgId)) : null;
      const parentMsg = mapped?.roomMessageId ? this.store.get('roommsg', mapped.roomMessageId) : null;
      const replyToId = parentMsg?.roomId === groupRoom.id ? parentMsg.id : '';
      const mentionedAgents = this.desk.rooms.mentionsIn(groupRoom, stripped).filter(id => id !== 'you');
      const targetIds = mentionedAgents.length ? mentionedAgents
        : parentMsg?.roomId === groupRoom.id && parentMsg.from?.type === 'agent' && groupRoom.members.includes(parentMsg.from.id) ? [parentMsg.from.id]
        : botMentioned ? [agentId]
        : ['you'];
      const to = targetIds.map(id => id === 'you' ? 'you' : (this.desk.rooms.member(id).handle || this.desk.rooms.member(id).name));
      const senderLabel = nameOf(message.from) || 'Telegram member';
      await this.desk.rooms.post(groupRoom.id, { text: postedText, replyTo: replyToId, telegramSender: { agentId, groupId: String(chat.id), messageId: msgId, id: String(message.from?.id || ''), label: senderLabel }, to });
      this.desk.telegram?.noteInbox(agentId, { values: { chatName: `${groupRoom.name}: ${chat.title || 'Telegram group'}` } }, `agentbot:${agentId}:${chat.id}`, `${senderLabel}: ${postedText}`, { roomId: groupRoom.id });
      return;
    }
    if (!addressed) return;
    if (!text) return this.textOnly(agentId, message, say);
    const stripped = (mentionRe ? text.replace(mentionRe, '').trim() : text) || text;
    return this.route(agentId, chat, stripped, `${nameOf(message.from) || 'Someone'} in ${chat.title || 'a group'}`);
  }
  // Media is not passed to the agent yet, and the person is told so, once for an album (each of its pictures is a message).
  textOnly(agentId, message, say, { replyTo = '', text = TEXT_ONLY } = {}) {
    if (!MEDIA.some(kind => message[kind])) return;
    if (message.media_group_id) {
      const album = `${agentId}:${message.chat.id}:${message.media_group_id}`;
      if (this.album === album) return;
      this.album = album;
    }
    return say(message.chat.id, text, replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {});
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

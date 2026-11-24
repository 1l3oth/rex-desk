// Two-way Telegram bridge. The person links ONE Telegram chat to their bot (Settings -> Connectors -> Telegram); from then on
// Rex Desk's agents can text that chat (desk_telegram), their desk_ask questions appear there with the suggested answers as
// reply buttons, and when the person replies to an agent's message (or presses a button) it flows back into that agent's chat,
// exactly as if typed in the app. Long polling via getUpdates while the app runs; no public webhook. The bot token stays
// server-side (encrypted in the connector secret); agents never see it and it never appears in logs or chat.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = 'https://api.telegram.org';
// One-time pairing code: only the chat that sends it to the bot can be linked, so a stranger who happens to press Start on the
// bot is never linked. No look-alike letters; good for 10 minutes; cleared once used.
const LINK_PAGES = 20;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', PAIR_LENGTH = 6, PAIR_TTL_MS = 10 * 60 * 1000;
const newPairCode = () => Array.from({ length: PAIR_LENGTH }, () => PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]).join('');
// The code a message carries: "/start CODE" (from a t.me/<bot>?start=CODE link) or the code typed on its own.
const codeIn = text => String(text || '').trim().replace(/^\/start(@\w+)?\s*/i, '').trim().toUpperCase();
export const pendingPairCode = values => (values?.pairCode && Number(values.pairUntil) > Date.now() ? values.pairCode : '');
const chatNameOf = chat => [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : String(chat.id));
const clip = (text, size = 3800) => { const value = String(text ?? ''); return value.length > size ? `${value.slice(0, size - 1)}…` : value; };
// A long reply cut into Telegram-sized parts at paragraph, then line, then word breaks; at most maxParts, the last one clipped.
export function splitReply(text, size = 3800, maxParts = 4) {
  const parts = []; let rest = String(text ?? '').trim();
  while (rest && parts.length < maxParts) {
    if (rest.length <= size) { parts.push(rest); break; }
    if (parts.length === maxParts - 1) { parts.push(clip(rest, size)); break; }
    const window = rest.slice(0, size);
    const cut = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')].find(at => at > size / 2) ?? size;
    parts.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  return parts.filter(Boolean);
}
// What a message from Telegram looks like in the agent's chat: marked, so the agent knows its final reply goes back there.
export const TELEGRAM_MARK = '[Telegram]';
const fromTelegram = text => `${TELEGRAM_MARK} ${text}`;
// Telegram lets a bot download files up to 20 MB.
const MAX_DOWNLOAD = 20 * 1024 * 1024;
// A turn started from Telegram sends its final reply back for this long; a turn that never ends does not hold the mark forever.
const TURN_TTL_MS = 2 * 60 * 60 * 1000;
const attachedBlock = files => (files.length ? `\n\nAttached files (read them from these paths):\n${files.map(file => `- ${file}`).join('\n')}` : '');
const safeName = name => path.basename(String(name || 'file')).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120) || 'file';

// The newest saved Telegram connector and its decrypted values ({ botToken, chatId?, chatName? }), or null when none is saved.
export function telegramLink(store) {
  const links = store.list('connector').filter(item => item.connectorId === 'telegram').sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  for (const link of links) {
    const secret = store.get('secret', `connector:${link.id}`);
    if (!secret) continue;
    let values; try { values = JSON.parse(store.decrypt(secret)); } catch { continue; }
    if (values?.botToken) return { link, values };
  }
  return null;
}

// Merge new values (e.g. the linked chat id) into a connector's encrypted secret, without ever logging them.
function saveValues(store, linkId, values) {
  store.put('secret', `connector:${linkId}`, store.encrypt(JSON.stringify(values)));
}

// The getUpdates offset belongs to one connection (one bot). A removed or replaced connection's offset is never reused, so
// the new bot starts from what Telegram still holds for it, and nothing queued for the old bot is ever read again.
const offsetFor = (store, linkId) => { const state = store.get('telegram', 'state'); return state?.linkId === linkId ? Number(state.offset) || 0 : 0; };
const saveOffset = (store, linkId, offset) => store.put('telegram', 'state', { id: 'state', linkId, offset });

export class TelegramBridge {
  // desk: the coordinator (desk.store, desk.answer, desk.specialistTurn, desk.specialists...). options.fetcher and
  // options.transcribe are injectable for tests. transcribe(oggBuffer, language) -> { text } | null (null = could not).
  constructor(desk, { fetcher = fetch, transcribe = null } = {}) {
    this.desk = desk; this.store = desk.store; this.fetcher = fetcher; this.transcribe = transcribe;
    this.running = false; this.polling = false; this.retryMs = 1000;
  }

  // ---- Telegram Bot API ----
  async call(token, method, params = {}, { timeoutMs = 15000 } = {}) {
    const response = await this.fetcher(`${API}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
    return data.result;
  }

  // ---- Linking: the chat that sends the one-time pairing code is remembered (local only) ----
  // Called by the Link button route. First press: makes a code to send to the bot. Next presses: a one-shot getUpdates looks
  // for a private message carrying that code (the poll loop idles until a chat is linked, so no 409 conflict). When a chat is
  // already linked (Relink), the running poll loop sees the code instead (handleUpdate), so no second getUpdates is made.
  async link(linkId = '') {
    const found = telegramLink(this.store);
    if (!found) throw new Error('Connect the bot token first.');
    const { link } = found; let { values } = found;
    if (linkId && link.id !== linkId) throw new Error('That Telegram connection is gone.');
    let code = pendingPairCode(values);
    const waiting = current => ({ linked: false, code: current, hint: `Send ${current} to your bot in Telegram, then tap Link again.` });
    if (!code) {
      code = newPairCode(); values = { ...values, pairCode: code, pairUntil: Date.now() + PAIR_TTL_MS };
      saveValues(this.store, link.id, values); this.store.emit?.('change', { kind: 'connector' });
      return waiting(code);
    }
    if (values.chatId) return waiting(code);
    // Read the queue a batch at a time, moving the offset past each batch, until the code turns up or the queue is empty.
    // Nothing is linked yet, so the skipped messages are never routed anywhere; a capped number of pages per press.
    let offset = offsetFor(this.store, link.id);
    for (let page = 0; page < LINK_PAGES; page++) {
      const updates = await this.call(values.botToken, 'getUpdates', { offset, timeout: 0, limit: 100 }, { timeoutMs: 10000 });
      if (!updates.length) break;
      const message = updates.map(update => update.message || update.edited_message)
        .find(item => item?.chat?.type === 'private' && codeIn(item.text) === code);
      offset = updates[updates.length - 1].update_id + 1;
      saveOffset(this.store, link.id, offset);
      if (message) {
        const name = this.pair(link.id, values, message.chat);
        this.kick();
        return { linked: true, name };
      }
    }
    return waiting(code);
  }

  // Save the chat that sent the code as the one linked chat, and use the code up.
  pair(linkId, values, chat) {
    const name = chatNameOf(chat), { pairCode, pairUntil, ...rest } = values;
    saveValues(this.store, linkId, { ...rest, chatId: chat.id, chatName: name });
    this.store.emit?.('change', { kind: 'connector' });
    return name;
  }

  linkedName() { return telegramLink(this.store)?.values?.chatName || ''; }

  // ---- Outgoing: an agent texts the person ----
  // agentId/name identify the sender; the message is prefixed with the agent name so the person knows who wrote.
  async sendFromAgent(agentId, name, text) {
    const found = telegramLink(this.store);
    if (!found) throw new Error('Telegram is not connected. Add it in Settings -> Connectors.');
    if (!found.values.chatId) throw new Error('Telegram is connected but not linked yet. Open the bot, press Start, and tap Link in Settings.');
    // The agent wrote to Telegram itself during a Telegram turn: its final reply is not sent again.
    for (const turn of this.store.list('tgturn')) if (turn.agentId === agentId && !turn.sent) this.store.put('tgturn', turn.id, { ...turn, sent: true });
    await this.sendParts(found, agentId, name, text);
    return { sent: true };
  }
  // Send an agent's words in one message (or a few clean parts when long), each recorded so a Reply on it reaches that agent,
  // and remember the agent as the one that last wrote, so the person's next plain message goes to it.
  async sendParts(found, agentId, name, text) {
    const parts = splitReply(String(text || '').trim(), 3800 - String(name).length - 1);
    for (const [index, part] of parts.entries()) {
      const message = await this.call(found.values.botToken, 'sendMessage', { chat_id: found.values.chatId, text: clip(index ? part : `${name}\n${part}`) });
      if (message?.message_id) this.store.put('tgmsg', String(message.message_id), { id: String(message.message_id), kind: 'agent', agentId, linkId: found.link.id, at: new Date().toISOString() });
    }
    this.noteLastAgent(found, agentId);
  }
  noteLastAgent(found, agentId) { if (agentId && found) this.store.put('telegram', 'last', { id: 'last', agentId, linkId: found.link.id, at: new Date().toISOString() }); }
  // The agent a plain message (no Reply) goes to: the one that last wrote to the person on Telegram, while it still exists;
  // else Rex Agent.
  lastAgent(found) {
    const last = this.store.get('telegram', 'last');
    if (!last?.agentId || last.linkId !== found.link.id) return 'main';
    return last.agentId === 'main' || this.store.get('specialist', last.agentId) ? last.agentId : 'main';
  }

  // ---- A turn that started from Telegram answers on Telegram ----
  // Called by the coordinator when a run's turn ends (agent-result). Only a turn a Telegram message started is sent back,
  // once; turns started in the app never reach Telegram.
  async onTurnResult(runId, text) {
    const turn = this.store.get('tgturn', runId); if (!turn) return;
    this.store.delete('tgturn', runId);
    if (turn.sent || Date.now() - Date.parse(turn.at) > TURN_TTL_MS || !String(text || '').trim()) return;
    const found = telegramLink(this.store);
    if (!found?.values?.chatId || found.link.id !== turn.linkId) return;
    const name = turn.agentId === 'main' ? 'Rex Agent' : this.store.get('specialist', turn.agentId)?.name || 'Agent';
    try { await this.sendParts(found, turn.agentId, name, text); }
    catch (error) { this.store.event?.('', 'telegram-error', { message: `reply: ${error.message}` }, true); }
  }

  // ---- Outgoing: an agent's desk_ask shows up with answer buttons ----
  // Called from coordinator.beginAsk for desk questions/approvals. Best-effort: a failure never blocks the ask in the app.
  async onAsk(interaction) {
    try {
      const found = telegramLink(this.store);
      if (!found?.values?.chatId) return;
      if (interaction.method !== 'desk' || !['question', 'approval'].includes(interaction.kind)) return;
      const who = this.agentForRun(interaction.runId);
      const schema = interaction.request?.requestedSchema || {};
      const buttons = this.askButtons(interaction.id, interaction.kind, schema);
      const needsText = !buttons.length;
      const head = `${who.name} ${interaction.kind === 'approval' ? 'needs your OK' : 'asks'}:`;
      const foot = needsText ? '\n\nReply to this message with your answer.' : '';
      const message = await this.call(found.values.botToken, 'sendMessage', {
        chat_id: found.values.chatId, text: clip(`${head}\n${interaction.title}${foot}`),
        ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
      if (message?.message_id) this.store.put('tgmsg', String(message.message_id), { id: String(message.message_id), kind: 'ask', interactionId: interaction.id, agentId: who.id, field: this.answerField(schema), linkId: found.link.id, at: new Date().toISOString() });
      this.noteLastAgent(found, who.id);
    } catch { /* the app's Needs you still has the question; Telegram is a bonus channel */ }
  }

  // Buttons from the schema: enum/options values become one button each; a plain approval gets Approve / No.
  askButtons(interactionId, kind, schema) {
    const props = schema.properties || {};
    for (const [field, property] of Object.entries(props)) {
      const choices = property.enum ? property.enum.map(value => ({ value, label: value })) : (property.options || []).map(option => ({ value: option.label, label: option.label }));
      if (choices.length) return choices.slice(0, 8).map((choice, index) => [{ text: clip(choice.label, 60), callback_data: `${interactionId}:o:${index}` }]);
    }
    if (kind === 'approval') return [[{ text: 'Approve', callback_data: `${interactionId}:accept` }, { text: 'No', callback_data: `${interactionId}:decline` }]];
    return [];
  }

  // The field a free-text reply answers (the first field, or the default 'answer').
  answerField(schema) { const keys = Object.keys(schema.properties || {}); return keys[0] || 'answer'; }

  // ---- Incoming: the long-poll loop ----
  start() { if (this.running) return; this.running = true; this.loopDone = this.loop(); }
  // Stops polling and resolves once the loop has ended, so the store can be closed safely afterwards.
  async stop() { this.running = false; this.abort?.abort(); this.wake?.(); await this.loopDone; this.loopDone = null; }
  kick() { /* wake an idling loop promptly after a link */ this.wake?.(); }

  async loop() {
    while (this.running) {
      const found = telegramLink(this.store);
      // Idle (no getUpdates) until a chat is linked, so the Link button's one-shot getUpdates never hits a 409 conflict.
      if (!found?.values?.chatId) { await this.sleep(8000); continue; }
      try {
        const offset = offsetFor(this.store, found.link.id);
        this.abort = new AbortController();
        const updates = await this.callAbortable(found.values.botToken, 'getUpdates', { offset, timeout: 45, allowed_updates: ['message', 'callback_query'] }, 55000, this.abort.signal);
        for (const update of updates) {
          if (!this.running) break;
          // Read the link fresh for each update: a Relink code or a new linked chat may have been saved during the long poll.
          // When the connection was removed or replaced meanwhile, the rest of this batch came from the old bot: drop it.
          const current = telegramLink(this.store);
          if (current?.link?.id !== found.link.id) break;
          try { await this.handleUpdate(update, current); } catch (error) { this.store.event?.('', 'telegram-error', { message: error.message }, true); }
          saveOffset(this.store, found.link.id, Math.max(offset, update.update_id + 1));
        }
      } catch (error) {
        if (!this.running) break;
        // 409 (another getUpdates in flight) or a network blip: back off and retry.
        await this.sleep(5000);
      }
    }
    this.polling = false;
  }

  sleep(ms) { return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); }; }); }
  async callAbortable(token, method, params, timeoutMs, signal) {
    const response = await this.fetcher(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: signal || AbortSignal.timeout(timeoutMs) });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
    return data.result;
  }

  // A message Rex Desk sent through this connection (a reply or button on it can be acted on), or null. Records from a
  // removed or replaced connection never match: another bot reuses the same message numbers.
  sentMessage(found, messageId) {
    const record = messageId == null ? null : this.store.get('tgmsg', String(messageId));
    return record && record.linkId === found.link.id ? record : null;
  }

  async handleUpdate(update, found) {
    if (update.callback_query) return this.handleCallback(update.callback_query, found);
    const message = update.message || update.edited_message;
    if (!message) return;
    // Relink while the loop runs: a private chat sending the pending code becomes the linked chat.
    const code = pendingPairCode(found.values);
    if (code && message.chat?.type === 'private' && codeIn(message.text) === code) {
      const name = this.pair(found.link.id, found.values, message.chat);
      return this.call(found.values.botToken, 'sendMessage', { chat_id: message.chat.id, text: clip(`Linked to Rex Desk as ${name}.`) }).catch(() => {});
    }
    // Only the one linked chat is ever accepted; anything else is ignored.
    if (String(message.chat?.id) !== String(found.values.chatId)) return;
    if (message.voice || message.audio) return this.handleVoice(message, found);
    if (message.photo || message.document || message.video || message.animation) return this.handleFile(message, found);
    const text = String(message.text || '').trim();
    if (!text) return;
    const context = this.sentMessage(found, message.reply_to_message?.message_id);
    if (context?.kind === 'ask') return this.answerAsk(context.interactionId, context.field, text, found, message.message_id);
    if (text.startsWith('/')) return; // bot commands like /start are not routed
    return this.routeToAgent(this.targetFor(message, found), text, found);
  }

  // Who a message is for. A Reply on an agent's message (or its question) goes to that agent; a plain message, with no Reply,
  // goes to the agent that last wrote to the person on Telegram, else Rex Agent. The person never needs Reply.
  targetFor(message, found) {
    const context = this.sentMessage(found, message.reply_to_message?.message_id);
    if (context?.agentId) return context.agentId;
    return this.lastAgent(found);
  }

  async handleCallback(query, found) {
    const data = String(query.data || ''), token = found.values.botToken;
    const ack = (text = '') => this.call(token, 'answerCallbackQuery', { callback_query_id: query.id, ...(text ? { text } : {}) }).catch(() => {});
    const colon = data.indexOf(':'); if (colon < 0) return ack();
    const interactionId = data.slice(0, colon), rest = data.slice(colon + 1);
    // Only a button on the question Rex Desk sent to the linked chat counts: the press must come from that chat, on that
    // message, and the message must be the one that carried this question.
    const origin = query.message;
    if (!origin || String(origin.chat?.id) !== String(found.values.chatId)) return ack();
    const sentAsk = this.sentMessage(found, origin.message_id);
    if (sentAsk?.kind !== 'ask' || sentAsk.interactionId !== interactionId) return ack();
    const interaction = this.store.get('interaction', interactionId);
    if (!interaction || interaction.state !== 'pending') { await ack('Already answered'); return this.clearButtons(query, token); }
    let answer;
    if (rest === 'accept') answer = { action: 'accept', content: {} };
    else if (rest === 'decline') answer = { action: 'decline' };
    else if (rest.startsWith('o:')) {
      const schema = interaction.request?.requestedSchema || {}, field = this.answerField(schema), property = schema.properties?.[field] || {};
      const choices = property.enum ? property.enum.slice() : (property.options || []).map(option => option.label);
      const value = choices[Number(rest.slice(2))];
      if (value === undefined) return ack();
      answer = { action: 'accept', content: { [field]: value } };
    } else return ack();
    try { this.desk.answer(interactionId, answer); await ack('Sent'); } catch (error) { await ack(error.message); }
    return this.clearButtons(query, token);
  }

  clearButtons(query, token) {
    const message = query.message; if (!message) return;
    return this.call(token, 'editMessageReplyMarkup', { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }

  answerAsk(interactionId, field, text, found, replyToId) {
    const interaction = this.store.get('interaction', interactionId);
    if (!interaction || interaction.state !== 'pending') return this.call(found.values.botToken, 'sendMessage', { chat_id: found.values.chatId, text: 'That question was already answered.', reply_to_message_id: replyToId }).catch(() => {});
    try { this.desk.answer(interactionId, { action: 'accept', content: { [field || 'answer']: text } }); }
    catch (error) { return this.call(found.values.botToken, 'sendMessage', { chat_id: found.values.chatId, text: clip(`Could not use that answer: ${error.message}`), reply_to_message_id: replyToId }).catch(() => {}); }
  }

  // Start (or join) the agent's turn with the message marked as from Telegram, and mark that turn so its final reply is sent
  // back to Telegram by itself.
  async routeToAgent(agentId, text, found = telegramLink(this.store)) {
    if (agentId === 'main') this.desk.specialists.ensureMain();
    const run = await this.desk.specialistTurn(agentId, { prompt: fromTelegram(text) });
    if (run?.id && found) this.store.put('tgturn', run.id, { id: run.id, agentId, linkId: found.link.id, at: new Date().toISOString(), sent: false });
    this.noteLastAgent(found, agentId);
  }

  // Download one Telegram file (getFile, then the file itself) into Rex Desk's uploads folder, so the agent can read it and
  // the chat shows it. Tried three times: one network blip no longer loses a voice note. Returns { path, buffer } or { error }.
  async download(found, fileId, name, size = 0) {
    if (size > MAX_DOWNLOAD) return { error: 'it is over 20 MB, which Telegram does not let a bot download' };
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = await this.call(found.values.botToken, 'getFile', { file_id: fileId });
        const response = await this.fetcher(`${API}/file/bot${found.values.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(60000) });
        if (response.ok === false) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = path.extname(String(file.file_path || '')), base = safeName(name);
        return { path: this.saveFile(buffer, path.extname(base) ? base : `${base}${ext}`), buffer };
      } catch (error) { last = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, this.retryMs * (attempt + 1))); }
    }
    // The cause (like ECONNRESET) is kept; the token never is: it only sits in the URL, which is not part of the message.
    const reason = [last?.message, last?.cause?.code || last?.cause?.message].filter(Boolean).join(': ') || 'unknown error';
    this.store.event?.('', 'telegram-error', { message: `file download: ${reason}` }, true);
    return { error: `the download from Telegram failed (${reason})` };
  }
  // The uploads folder in the files folder (like files attached in the app), one new folder per file. Falls back to the data
  // folder when the store has no files folder.
  saveFile(buffer, name) {
    const root = this.store.media ? this.store.media('uploads') : path.join(this.store.directory, 'uploads');
    const dir = path.join(root, randomUUID()); mkdirSync(dir, { recursive: true });
    const out = path.join(dir, safeName(name)); writeFileSync(out, buffer); return out;
  }

  // Photos, files and short videos: downloaded and posted into the agent's chat as attachments, with the caption.
  async handleFile(message, found) {
    const agentId = this.targetFor(message, found);
    const photo = Array.isArray(message.photo) && message.photo.length ? message.photo[message.photo.length - 1] : null;
    const item = photo || message.document || message.video || message.animation;
    const kind = photo ? 'a photo' : message.document ? 'a file' : 'a video';
    const name = photo ? `photo-${message.message_id || Date.now()}.jpg` : item.file_name || `${message.document ? 'file' : 'video'}-${message.message_id || Date.now()}`;
    const saved = await this.download(found, item.file_id, name, item.file_size || 0);
    const caption = String(message.caption || '').trim();
    const said = `The person sent ${kind}${caption ? ` with this caption: ${caption}` : ' (no caption)'}.`;
    const prompt = saved.path ? `${said}${attachedBlock([saved.path])}` : `${said} It could not be saved: ${saved.error}.`;
    return this.routeToAgent(agentId, prompt, found);
  }

  // Voice notes: saved into the uploads folder (the agent always gets the file path), transcribed when a transcriber is ready,
  // and posted into the agent's chat. When it cannot be transcribed, the agent is told plainly why.
  async handleVoice(message, found) {
    const agentId = this.targetFor(message, found);
    const audio = message.voice || message.audio;
    const saved = await this.download(found, audio.file_id, audio.file_name || `voice-${message.message_id || Date.now()}`, audio.file_size || 0);
    let text = '', why = saved.error ? `the audio could not be saved, ${saved.error}` : '';
    if (saved.buffer && !this.transcribe) why = 'no transcriber is set up';
    if (saved.buffer && this.transcribe) {
      try {
        const result = await this.transcribe(saved.buffer, this.store.config().control?.language || 'en');
        text = String(result?.text || '').trim();
        if (!text) why = result?.error || 'the transcriber returned no words';
      } catch (error) { why = error.message; }
    }
    const files = attachedBlock(saved.path ? [saved.path] : []);
    const prompt = text ? `Voice note from the person (transcribed): ${text}${files}` : `The person sent a voice note. It was not transcribed: ${why}.${files}`;
    return this.routeToAgent(agentId, prompt, found);
  }

  agentForRun(runId) {
    const run = runId && this.store.get('run', runId);
    const id = run?.roomAgent || run?.specialistId || (run?.main ? 'main' : '');
    if (!id || id === 'main') return { id: 'main', name: 'Rex Agent' };
    const agent = this.store.get('specialist', id);
    return { id, name: agent?.name || 'agent' };
  }
}

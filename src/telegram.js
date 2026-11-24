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
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', PAIR_LENGTH = 6, PAIR_TTL_MS = 10 * 60 * 1000;
const newPairCode = () => Array.from({ length: PAIR_LENGTH }, () => PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]).join('');
// The code a message carries: "/start CODE" (from a t.me/<bot>?start=CODE link) or the code typed on its own.
const codeIn = text => String(text || '').trim().replace(/^\/start(@\w+)?\s*/i, '').trim().toUpperCase();
export const pendingPairCode = values => (values?.pairCode && Number(values.pairUntil) > Date.now() ? values.pairCode : '');
const chatNameOf = chat => [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : String(chat.id));
const clip = (text, size = 3800) => { const value = String(text ?? ''); return value.length > size ? `${value.slice(0, size - 1)}…` : value; };

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

export class TelegramBridge {
  // desk: the coordinator (desk.store, desk.answer, desk.specialistTurn, desk.specialists...). options.fetcher and
  // options.transcribe are injectable for tests. transcribe(oggBuffer, language) -> { text } | null (null = could not).
  constructor(desk, { fetcher = fetch, transcribe = null } = {}) {
    this.desk = desk; this.store = desk.store; this.fetcher = fetcher; this.transcribe = transcribe;
    this.running = false; this.polling = false;
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
    const updates = await this.call(values.botToken, 'getUpdates', { timeout: 0, limit: 50 }, { timeoutMs: 10000 });
    const message = [...updates].reverse().map(update => update.message || update.edited_message)
      .find(item => item?.chat?.type === 'private' && codeIn(item.text) === code);
    if (!message) return waiting(code);
    const name = this.pair(link.id, values, message.chat);
    // Skip past the code so the loop never treats it as a reply.
    const lastId = updates.length ? updates[updates.length - 1].update_id : 0;
    this.store.put('telegram', 'state', { id: 'state', offset: lastId + 1 });
    this.kick();
    return { linked: true, name };
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
    const body = `${name}\n${String(text || '').trim()}`;
    const message = await this.call(found.values.botToken, 'sendMessage', { chat_id: found.values.chatId, text: clip(body) });
    if (message?.message_id) this.store.put('tgmsg', String(message.message_id), { id: String(message.message_id), kind: 'agent', agentId, at: new Date().toISOString() });
    return { sent: true };
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
      if (message?.message_id) this.store.put('tgmsg', String(message.message_id), { id: String(message.message_id), kind: 'ask', interactionId: interaction.id, field: this.answerField(schema), at: new Date().toISOString() });
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
        const offset = this.store.get('telegram', 'state')?.offset || 0;
        this.abort = new AbortController();
        const updates = await this.callAbortable(found.values.botToken, 'getUpdates', { offset, timeout: 45, allowed_updates: ['message', 'callback_query'] }, 55000, this.abort.signal);
        for (const update of updates) {
          if (!this.running) break;
          // Read the link fresh for each update: a Relink code or a new linked chat may have been saved during the long poll.
          try { await this.handleUpdate(update, telegramLink(this.store) || found); } catch (error) { this.store.event?.('', 'telegram-error', { message: error.message }, true); }
          this.store.put('telegram', 'state', { id: 'state', offset: Math.max(offset, update.update_id + 1) });
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
    const text = String(message.text || '').trim();
    if (!text) return;
    const context = message.reply_to_message ? this.store.get('tgmsg', String(message.reply_to_message.message_id)) : null;
    if (context?.kind === 'ask') return this.answerAsk(context.interactionId, context.field, text, found, message.message_id);
    if (context?.kind === 'agent') return this.routeToAgent(context.agentId, text);
    // A plain message (not a reply, not a command) goes to Rex Agent, the main agent.
    if (text.startsWith('/')) return; // bot commands like /start are not routed
    return this.routeToAgent('main', text);
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
    const sentAsk = this.store.get('tgmsg', String(origin.message_id));
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

  async routeToAgent(agentId, text) {
    if (agentId === 'main') this.desk.specialists.ensureMain();
    await this.desk.specialistTurn(agentId, { prompt: text });
  }

  // Voice notes: download the audio, transcribe it if a transcriber is available (no new keys), and post the text (plus the
  // audio) into the target agent's chat. With no transcoder, post the audio and say it was not transcribed.
  async handleVoice(message, found) {
    const context = message.reply_to_message ? this.store.get('tgmsg', String(message.reply_to_message.message_id)) : null;
    const agentId = context?.kind === 'agent' ? context.agentId : 'main';
    const fileId = (message.voice || message.audio).file_id;
    let buffer = null, saved = '';
    try {
      const file = await this.call(found.values.botToken, 'getFile', { file_id: fileId });
      const response = await this.fetcher(`${API}/file/bot${found.values.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(20000) });
      buffer = Buffer.from(await response.arrayBuffer());
      saved = this.saveAudio(buffer, file.file_path);
    } catch (error) { this.store.event?.('', 'telegram-error', { message: `voice download: ${error.message}` }, true); }
    let text = '';
    if (buffer && this.transcribe) { try { const result = await this.transcribe(buffer, this.store.config().control?.language || 'en'); text = String(result?.text || '').trim(); } catch { /* fall back to audio-only */ } }
    const prompt = text
      ? `Voice note from the person (transcribed): ${text}${saved ? `\n(audio: ${saved})` : ''}`
      : `The person sent a voice note${saved ? ` (audio saved at ${saved})` : ''}. It was not transcribed automatically.`;
    if (agentId === 'main') this.desk.specialists.ensureMain();
    await this.desk.specialistTurn(agentId, { prompt });
  }

  saveAudio(buffer, filePath) {
    try {
      if (!this.store.directory) return '';
      const dir = path.join(this.store.directory, 'telegram');
      mkdirSync(dir, { recursive: true });
      const ext = (String(filePath).split('.').pop() || 'oga').replace(/[^a-z0-9]/gi, '') || 'oga';
      const out = path.join(dir, `voice-${randomUUID().slice(0, 8)}.${ext}`);
      writeFileSync(out, buffer); return out;
    } catch { return ''; }
  }

  agentForRun(runId) {
    const run = runId && this.store.get('run', runId);
    const id = run?.roomAgent || run?.specialistId || (run?.main ? 'main' : '');
    if (!id || id === 'main') return { id: 'main', name: 'Rex Agent' };
    const agent = this.store.get('specialist', id);
    return { id, name: agent?.name || 'agent' };
  }
}

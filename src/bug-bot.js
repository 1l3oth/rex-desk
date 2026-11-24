// The bug-report group bot. A SEPARATE Telegram bot from the personal link in telegram.js: it is added to customer groups,
// it only files bug reports, and it never routes a message to an agent or runs anything. The person (Rex or the manager)
// allows the groups it may work in; it leaves any other group. In an allowed group, a customer @mentions the bot (or replies
// to its "Got it, #N" message, or writes "#N") to file or add to a report. Jev sorts each message into bug, feature request
// or chat: chat is dropped, a feature request gets a polite reply and never reaches an agent, a bug goes to a hidden queue
// until the person approves it. Safety: only pictures and short videos (files up to 20 MB) are kept, other files are deleted
// with a warning, links from non-admins are deleted, and emails / phone numbers / key-like text are hidden in the saved
// report. A per-person rate limit, duplicate merging and a mute for repeat spammers keep the groups clean.
//
// The bot token stays server-side (encrypted in the connector secret); agents never see it and it never appears in logs.
import { createHash, randomBytes } from 'node:crypto';
import { askJev, jevQuestions, severityLabels } from './jev.js';

const API = 'https://api.telegram.org';
const CONNECTOR = 'telegram-bugs';

// ---- small text helpers ----
const clip = (text, size = 3800) => { const value = String(text ?? ''); return value.length > size ? `${value.slice(0, size - 1)}…` : value; };
const norm = text => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---- connector / token (its own saved connection, separate from the personal telegram link) ----
// The newest saved telegram-bugs connector and its decrypted values ({ botToken, botUsername?, groups?, reportAt? }), or null.
export function bugBotLink(store) {
  const links = store.list('connector').filter(item => item.connectorId === CONNECTOR).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  for (const link of links) {
    const secret = store.get('secret', `connector:${link.id}`);
    if (!secret) continue;
    let values; try { values = JSON.parse(store.decrypt(secret)); } catch { continue; }
    if (values?.botToken) return { link, values };
  }
  return null;
}

// ---- allowed groups ----
export const isAllowedGroup = (groups, chatId) => (groups || []).some(group => String(group.id) === String(chatId));

// ---- mention / reference parsing ----
// Did this message @mention the bot? Telegram marks a mention as an entity over the text or caption; a text_mention points at
// the bot's user id. A plain "@name" in the body counts too.
export function mentionsBot(message, botUsername, botId) {
  const handle = `@${String(botUsername || '').toLowerCase()}`;
  const body = String(message?.text ?? message?.caption ?? '');
  const entities = message?.entities || message?.caption_entities || [];
  for (const entity of entities) {
    if (entity.type === 'mention' && body.slice(entity.offset, entity.offset + entity.length).toLowerCase() === handle) return true;
    if (entity.type === 'text_mention' && botId && String(entity.user?.id) === String(botId)) return true;
  }
  return Boolean(botUsername) && body.toLowerCase().includes(handle);
}

// A report reference the message points at: a reply to an ack message carries nothing, but "#7" or a leading "7" in the text
// names report 7. Returns the number or null.
export function parseRef(text) {
  const match = /(?:^|\s)#?(\d{1,6})\b/.exec(String(text || '').trim());
  return match ? Number(match[1]) : null;
}

// ---- media / safety ----
// What the message carries: a photo, a video or animation (short clip), a document (a real file), or nothing. Size in bytes
// when Telegram gives it (photos never do). file_id is what getFile / delete need.
export function extractMedia(message) {
  if (!message) return { kind: 'none' };
  if (Array.isArray(message.photo) && message.photo.length) { const best = message.photo[message.photo.length - 1]; return { kind: 'photo', fileId: best.file_id, size: best.file_size || 0 }; }
  if (message.video) return { kind: 'video', fileId: message.video.file_id, size: message.video.file_size || 0, mime: message.video.mime_type || '' };
  if (message.animation) return { kind: 'video', fileId: message.animation.file_id, size: message.animation.file_size || 0, mime: message.animation.mime_type || '' };
  if (message.document) return { kind: 'document', fileId: message.document.file_id, size: message.document.file_size || 0, mime: message.document.mime_type || '', fileName: message.document.file_name || '' };
  if (message.audio || message.voice) return { kind: 'document', fileId: (message.audio || message.voice).file_id, size: (message.audio || message.voice).file_size || 0, mime: 'audio' };
  if (message.sticker) return { kind: 'sticker', fileId: message.sticker.file_id, size: message.sticker.file_size || 0 };
  return { kind: 'none' };
}

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

// Should this message be deleted on sight, and why? Pictures and short videos up to 20 MB stay. A document, audio, or other
// file is removed with a warning. A link posted by someone who is not a group admin is removed (spam control). Admins are
// trusted and never filtered.
export function safetyVerdict(message, { isAdmin = false } = {}) {
  if (isAdmin) return { drop: false };
  const media = extractMedia(message);
  if (media.kind === 'document' || media.kind === 'sticker') return { drop: true, reason: 'file-type', warn: 'I keep pictures and short videos only, so I removed that file. Describe the problem and attach a screenshot or a short clip.' };
  if ((media.kind === 'photo' || media.kind === 'video') && media.size > MAX_MEDIA_BYTES) return { drop: true, reason: 'too-big', warn: 'That file is over 20 MB, so I removed it. Please send a smaller screenshot or a short clip.' };
  const entities = message?.entities || message?.caption_entities || [];
  const hasLink = entities.some(entity => entity.type === 'url' || entity.type === 'text_link') || /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}/i.test(String(message?.text ?? message?.caption ?? ''));
  if (hasLink) return { drop: true, reason: 'link', warn: 'Links are not allowed here from members, so I removed that. Tell me the problem in words.' };
  return { drop: false };
}

// Hide the private things a report should not store in the clear: email addresses, phone numbers, and long key-like runs.
export function redact(text) {
  return String(text || '')
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[hidden email]')
    // Keys before phone numbers: a long alphanumeric run can contain a digit span a phone rule would otherwise chew into.
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[hidden key]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, match => (match.replace(/\D/g, '').length >= 8 ? '[hidden number]' : match));
}

// ---- Jev sorting ----
// Jev sorts a group message into a kind and a severity, using typed questions only (no generated text is parsed).
export const bugBotQuestions = {
  kind: { type: 'choice', instructions: 'A customer wrote this in a product support group. What is it?', criteria: {
    bug: 'Something in the product is broken, wrong, or not working as it should',
    feature: 'A request for something new, or a change to how the product works',
    chat: 'Small talk, thanks, a question already answered, or nothing actionable about the product' } },
  severity: jevQuestions.severity,
};
// Read Jev's answers into a plain result. Defaults keep an unclear message out of the agents' way (treated as chat).
export function sortReport(answers = {}) {
  const kind = answers.kind?.choice || 'chat';
  const score = answers.severity?.score;
  const severity = Number.isFinite(score) ? Math.round(score) : null;
  return { kind, severity, severityLabel: severity === null ? '' : severityLabels[severity] };
}

// ---- versions ----
// Compare two dotted versions (0.0.115 vs 0.0.99): 1, 0 or -1, or null when either is unreadable.
export function compareVersions(a, b) {
  const parts = value => String(value || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(Number);
  const left = parts(a), right = parts(b);
  if (left.length < 3 || right.length < 3 || [...left, ...right].some(Number.isNaN)) return null;
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  return 0;
}
// Is version a the same as or newer than b? Anything unreadable is never at least.
export const atLeastVersion = (a, b) => { const order = compareVersions(a, b); return order !== null && order >= 0; };

// ---- per-person rate limit, mute, duplicate merge ----
export const RATE = { windowMs: 10 * 60 * 1000, max: 5, muteMs: 24 * 60 * 60 * 1000, strikesToMute: 3 };
// Decide whether to accept this person's message now. Keeps the last window of send times; over the limit earns a strike, and
// enough strikes mutes them for a day. Returns the next bucket to save and what to do.
export function rateCheck(bucket, now = Date.now(), rate = RATE) {
  const state = { times: [], strikes: 0, mutedUntil: 0, ...(bucket || {}) };
  if (state.mutedUntil && state.mutedUntil > now) return { allowed: false, muted: true, justMuted: false, bucket: state };
  const times = state.times.filter(time => now - time < rate.windowMs);
  if (times.length >= rate.max) {
    const strikes = state.strikes + 1;
    if (strikes >= rate.strikesToMute) return { allowed: false, muted: true, justMuted: true, bucket: { times: [], strikes: 0, mutedUntil: now + rate.muteMs } };
    return { allowed: false, muted: false, justMuted: false, overLimit: true, bucket: { ...state, times, strikes } };
  }
  return { allowed: true, muted: false, justMuted: false, bucket: { times: [...times, now], strikes: state.strikes, mutedUntil: 0 } };
}

// An open report from the same person in the same group whose text matches closely: the new message is merged into it rather
// than filed again.
export function findDuplicate(reports, { groupId, reporterId, text }) {
  const body = norm(redact(text));
  if (!body || body.length < 6) return null;
  return reports.find(report => report.status !== 'done' && report.status !== 'rejected'
    && String(report.groupId) === String(groupId) && String(report.reporterId) === String(reporterId)
    && norm(report.text) === body) || null;
}

// ---- reply linking ----
export const OPEN_STATUSES = new Set(['new', 'queued', 'approved']);
export const openReportsFor = (reports, groupId, reporterId) => reports
  .filter(report => OPEN_STATUSES.has(report.status) && String(report.groupId) === String(groupId) && String(report.reporterId) === String(reporterId))
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

// Which report a follow-up message (not a fresh @mention) adds to. A reply to the bot's own "Got it, #N" message attaches to
// N. A message that names "#N" attaches to N when that report belongs to this person. Otherwise it falls to the sender's own
// open reports: exactly one means attach to it; several means ask which (the caller offers buttons); none means ignore.
export function linkTarget(reports, { groupId, reporterId, text, ackReportNum = null }) {
  const byId = num => reports.find(report => report.num === num && String(report.groupId) === String(groupId)) || null;
  if (ackReportNum != null) { const hit = byId(ackReportNum); if (hit) return { report: hit }; }
  const ref = parseRef(text);
  if (ref != null) { const hit = byId(ref); if (hit && String(hit.reporterId) === String(reporterId)) return { report: hit }; }
  const open = openReportsFor(reports, groupId, reporterId);
  if (open.length === 1) return { report: open[0] };
  if (open.length > 1) return { choices: open };
  return {};
}

// ---- the bot ----
export class BugBot {
  // desk: the coordinator (desk.store, desk.localTasks, desk.specialists, desk.telegram). options.fetcher is injectable.
  constructor(desk, { fetcher = fetch } = {}) {
    this.desk = desk; this.store = desk.store; this.fetcher = fetcher;
    this.running = false;
  }

  // ---- Telegram Bot API ----
  async call(token, method, params = {}, { timeoutMs = 15000, signal } = {}) {
    const response = await this.fetcher(`${API}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
    return data.result;
  }

  // ---- saved state ----
  // The polling offset belongs to one bot: the saved connection and a fingerprint of its token (never the token itself). A
  // replaced token starts again from 0, so the new bot's first updates are not skipped by the old bot's offset.
  botKey(found) { return `${found.link.id}:${createHash('sha256').update(String(found.values.botToken || '')).digest('hex').slice(0, 16)}`; }
  offsetFor(found) { const state = this.store.get('bugbot', 'state'); return state?.bot === this.botKey(found) ? Number(state.offset) || 0 : 0; }
  saveOffset(found, offset) { this.store.put('bugbot', 'state', { id: 'state', bot: this.botKey(found), offset }); }
  reports() { return this.store.list('bugreport'); }
  groups(values) { return (values || bugBotLink(this.store)?.values || {}).groups || []; }
  nextNum() { return Math.max(0, ...this.reports().map(report => Number(report.num) || 0)) + 1; }
  bucket(userId) { return this.store.get('bugrate', String(userId)); }
  saveBucket(userId, bucket) { this.store.put('bugrate', String(userId), { id: String(userId), ...bucket }); }

  // ---- connect the bug bot's own token (its setup screen, separate from the personal Telegram link) ----
  // Validates the token with getMe, then saves (or updates) the one telegram-bugs connection, keeping any allowed groups.
  async connect(botToken) {
    const token = String(botToken || '').trim();
    if (!token) throw new Error('Paste the bot token from @BotFather.');
    const me = await this.call(token, 'getMe').catch(() => { throw new Error('Telegram does not know that bot token. Copy it again from @BotFather.'); });
    const existing = bugBotLink(this.store);
    const values = { ...(existing?.values || {}), botToken: token, botUsername: me?.username || '', botId: me?.id || '' };
    const id = existing?.link?.id || `${CONNECTOR}-${Date.now().toString(36)}`;
    if (!existing) this.store.put('connector', id, { id, connectorId: CONNECTOR, name: me?.username ? `Bug bot @${me.username}` : 'Bug bot', kind: 'token', at: new Date().toISOString() });
    this.saveValues(id, values);
    // A different bot: drop the old bot's offset and cut off a poll still waiting on the old token, so its batch is never used.
    if (existing?.values?.botToken !== token) { this.store.delete('bugbot', 'state'); this.abort?.abort(); }
    this.kick();
    return { connected: true, botUsername: values.botUsername };
  }
  setReportTime(at) {
    const found = bugBotLink(this.store); if (!found) throw new Error('Connect the bug-report bot token first.');
    const clean = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(at)) ? String(at) : '09:00';
    this.saveValues(found.link.id, { ...found.values, reportAt: clean });
    return { reportAt: clean };
  }
  disconnect() {
    const found = bugBotLink(this.store); if (!found) return { removed: false };
    this.store.delete('connector', found.link.id); this.store.delete('secret', `connector:${found.link.id}`);
    this.store.emit?.('change', { kind: 'connector' });
    return { removed: true };
  }

  // ---- group allow-list management (called from the setup screen routes) ----
  allowGroup(chatId, title) {
    const found = bugBotLink(this.store); if (!found) throw new Error('Connect the bug-report bot token first.');
    const pending = this.store.get('bugpending', String(chatId));
    const groups = this.groups(found.values).filter(group => String(group.id) !== String(chatId));
    groups.push({ id: String(chatId), title: String(title || pending?.title || '').slice(0, 120), addedAt: new Date().toISOString() });
    this.saveValues(found.link.id, { ...found.values, groups });
    this.store.delete('bugpending', String(chatId));
    return { allowed: true, groups };
  }
  removeGroup(chatId) {
    const found = bugBotLink(this.store); if (!found) return { removed: false };
    const groups = this.groups(found.values).filter(group => String(group.id) !== String(chatId));
    this.saveValues(found.link.id, { ...found.values, groups });
    return { removed: true, groups };
  }
  saveValues(linkId, values) { this.store.put('secret', `connector:${linkId}`, this.store.encrypt(JSON.stringify(values))); this.store.emit?.('change', { kind: 'connector' }); }

  // ---- the long-poll loop ----
  start() { if (this.running) return; this.running = true; this.loopDone = this.loop(); }
  async stop() { this.running = false; this.abort?.abort(); this.wake?.(); await this.loopDone; this.loopDone = null; }
  kick() { this.wake?.(); }
  sleep(ms) { return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); }; }); }

  async loop() {
    while (this.running) {
      const found = bugBotLink(this.store);
      if (!found?.values?.botToken) { await this.sleep(8000); continue; }
      // Fill the bot's own @username and id once, so mentions resolve and the setup screen can show the handle.
      if (!found.values.botUsername || !found.values.botId) {
        try { const me = await this.call(found.values.botToken, 'getMe'); this.saveValues(found.link.id, { ...found.values, botUsername: me?.username || '', botId: me?.id || '' }); continue; } catch { /* retry next loop */ }
      }
      try {
        const offset = this.offsetFor(found);
        this.abort = new AbortController();
        const updates = await this.call(found.values.botToken, 'getUpdates',
          { offset, timeout: 45, allowed_updates: ['message', 'callback_query', 'my_chat_member'] },
          { timeoutMs: 55000, signal: this.abort.signal });
        for (const update of updates) {
          if (!this.running) break;
          // The bot changed while this batch was in flight (another token, or a removed link): drop the rest of it.
          const current = bugBotLink(this.store);
          if (!current || this.botKey(current) !== this.botKey(found)) break;
          try { await this.handleUpdate(update, current); } catch (error) { this.store.event?.('', 'bugbot-error', { message: error.message }, true); }
          this.saveOffset(found, Math.max(offset, update.update_id + 1));
        }
      } catch (error) {
        if (!this.running) break;
        // A failing poll (a wrong token, another app polling the same bot, no network) is logged once per new reason, so the
        // owner can see why reports stop arriving; a repeat of the same reason is not logged again.
        const reason = String(error?.message || error || 'unknown error').slice(0, 300);
        if (reason !== this.lastPollError) { this.lastPollError = reason; this.store.event?.('', 'bugbot-error', { message: `poll: ${reason}` }, true); }
        await this.sleep(5000);
        continue;
      }
      this.lastPollError = '';
    }
  }

  // ---- update routing ----
  async handleUpdate(update, found) {
    if (update.callback_query) return this.handleCallback(update.callback_query, found);
    if (update.my_chat_member) return this.handleMembership(update.my_chat_member, found);
    const message = update.message; if (!message) return;
    const chat = message.chat || {};
    if (chat.type !== 'group' && chat.type !== 'supergroup') return; // only groups; private chats to this bot are ignored
    // Any group the person has not allowed: note it (so the owner can allow it from the setup screen), then leave.
    if (!isAllowedGroup(this.groups(found.values), chat.id)) { this.notePending(chat); await this.leave(found, chat.id); return; }
    this.store.delete('bugpending', String(chat.id));

    const isAdmin = await this.isAdmin(found, chat.id, message.from?.id);
    // Safety first: a bad file or a member's link is deleted before anything is filed.
    const verdict = safetyVerdict(message, { isAdmin });
    if (verdict.drop) { await this.deleteAndWarn(found, message, verdict.warn); return; }

    const body = String(message.text ?? message.caption ?? '').trim();
    const replyToAck = this.ackReportNum(found, message.reply_to_message);
    const isMention = mentionsBot(message, found.values.botUsername, found.values.botId);
    const ref = parseRef(body);
    const hasContent = extractMedia(message).kind !== 'none' || body.length > 0;
    const addresses = isMention || replyToAck != null || ref != null;
    // A bare message (no mention, no reference) is only for the bot when the sender already has an open report to extend.
    const openOwn = openReportsFor(this.reports(), chat.id, message.from?.id);
    const bareFollowUp = !addresses && openOwn.length > 0 && hasContent;
    if (!addresses && !bareFollowUp) return;

    // Rate limit each person. Over the limit is dropped quietly; a repeat spammer is muted for a day with one notice.
    const rate = rateCheck(this.bucket(message.from?.id));
    this.saveBucket(message.from?.id, rate.bucket);
    if (rate.justMuted) { await this.reply(found, chat.id, message.message_id, 'You are sending too many messages, so I muted you here for a day.'); return; }
    if (!rate.allowed) return;

    await this.fileOrAdd(found, message, { chat, body, replyToAck, isMention, ref });
  }

  // File a new report or add to an existing one, after Jev sorts the message.
  async fileOrAdd(found, message, { chat, body, replyToAck, isMention, ref }) {
    const reporterId = message.from?.id;
    const reporterName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || (message.from?.username ? `@${message.from.username}` : String(reporterId));
    const media = extractMedia(message);
    const mediaRef = media.kind === 'photo' || media.kind === 'video' ? [{ kind: media.kind, fileId: media.fileId, albumId: message.media_group_id || '' }] : [];

    // Follow-up to a named report: a reply to the "Got it, #N" message, or a "#N" the sender wrote without a fresh mention.
    if (replyToAck != null || (ref != null && !isMention)) {
      const link = linkTarget(this.reports(), { groupId: chat.id, reporterId, text: body, ackReportNum: replyToAck });
      if (link.report) return this.appendToReport(found, link.report, { text: body, media: mediaRef, message });
    }
    // A bare follow-up with no mention and no reference attaches to the sender's own open report(s); ask which if several.
    if (!isMention && replyToAck == null && ref == null) {
      const link = linkTarget(this.reports(), { groupId: chat.id, reporterId, text: body });
      if (link.report) return this.appendToReport(found, link.report, { text: body, media: mediaRef, message });
      if (link.choices) return this.askWhich(found, message, { text: body, media: mediaRef, choices: link.choices });
      return;
    }

    // A fresh report. Merge an exact duplicate instead of filing twice.
    const dup = findDuplicate(this.reports(), { groupId: chat.id, reporterId, text: body });
    if (dup) return this.appendToReport(found, dup, { text: body, media: mediaRef, message, duplicate: true });

    // Sort it with Jev. Only the redacted text leaves this computer. No key or a Jev failure files it as an unsorted bug so nothing is lost.
    const sort = await this.sort(body).catch(() => ({ kind: 'bug', severity: null, severityLabel: '' }));
    if (sort.kind === 'chat') return; // small talk is ignored, no report, no reply
    if (sort.kind === 'feature') {
      const num = this.saveReport({ chat, reporterId, reporterName, body, media: mediaRef, sort, status: 'feature', approved: false });
      await this.reply(found, chat.id, message.message_id, `Thanks for the idea. I passed it on as request #${num}. Feature requests are reviewed by the team, not fixed right away.`);
      return;
    }
    // A bug: filed hidden in the queue until the person approves it.
    const num = this.saveReport({ chat, reporterId, reporterName, body, media: mediaRef, sort, status: 'queued', approved: false });
    await this.reply(found, chat.id, message.message_id, `Got it, #${num}. I logged this${sort.severityLabel ? ` as ${sort.severityLabel.toLowerCase()}` : ''} and the team will look. Reply here to add more.`, { ack: num });
  }

  // Save a report and remember the ack message so a reply to it links back.
  saveReport({ chat, reporterId, reporterName, body, media, sort, status, approved }) {
    const num = this.nextNum();
    const report = { id: `bug-${num}`, num, groupId: String(chat.id), groupTitle: chat.title || '', reporterId: String(reporterId), reporterName,
      text: redact(body), kind: sort.kind, severity: sort.severity, severityLabel: sort.severityLabel, media: media || [],
      status, approved: Boolean(approved), hidden: !approved, taskId: '', fixedVersion: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.store.put('bugreport', report.id, report);
    return num;
  }

  async appendToReport(found, report, { text, media, message, duplicate = false }) {
    const entry = { at: new Date().toISOString(), text: redact(text), media: media || [] };
    const updated = { ...report, updatedAt: entry.at, text: report.text, adds: [...(report.adds || []), entry], media: [...(report.media || []), ...(media || [])] };
    this.store.put('bugreport', report.id, updated);
    if (!duplicate) await this.reply(found, message.chat.id, message.message_id, `Added to #${report.num}.`, { ack: report.num });
  }

  // Several open reports and no clear target: hold the message and ask which report it belongs to with buttons.
  // Each picker is its own held record, bound to this bot, group, message, reporter and the report numbers it offered, so a
  // button press can only attach that held text to one of those reports, by that reporter, in that group.
  async askWhich(found, message, { text, media, choices }) {
    const offered = choices.slice(0, 6);
    const pickId = randomBytes(6).toString('hex');
    this.store.put('bugpick', pickId, { id: pickId, linkId: found.link.id, botId: String(found.values.botId || ''), groupId: String(message.chat.id),
      messageId: message.message_id, reporterId: String(message.from?.id), nums: offered.map(report => report.num),
      text: redact(text), media: media || [], at: new Date().toISOString() });
    const buttons = offered.map(report => [{ text: clip(`#${report.num} ${report.text || report.kind}`, 60), callback_data: `pick:${pickId}:${report.num}` }]);
    const sent = await this.call(found.values.botToken, 'sendMessage', { chat_id: message.chat.id, reply_to_message_id: message.message_id, text: 'Which report is this about?', reply_markup: { inline_keyboard: buttons } }).catch(() => null);
    // Remember the bot message that carries the buttons: a press only counts from that very message. No message, no picker.
    if (sent?.message_id) this.store.put('bugpick', pickId, { ...this.store.get('bugpick', pickId), promptId: sent.message_id });
    else this.store.delete('bugpick', pickId);
  }

  // Jev sort. Returns { kind, severity, severityLabel }.
  async sort(body) {
    const apiKey = this.desk.jev?.apiKey?.() || '';
    if (!apiKey || !body) return { kind: 'bug', severity: null, severityLabel: '' };
    const model = this.store.config().jev?.model || undefined;
    const state = { text: clip(redact(body), 4000) }; // redacted before it is sent to OpenRouter
    const result = await askJev({ apiKey, model, state, questions: bugBotQuestions, fetcher: this.desk.jev.fetcher });
    return sortReport(result.answers);
  }

  // ---- outgoing helpers ----
  async reply(found, chatId, replyTo, text, { ack = null } = {}) {
    try {
      const message = await this.call(found.values.botToken, 'sendMessage', { chat_id: chatId, reply_to_message_id: replyTo, text: clip(text) });
      if (ack != null && message?.message_id) this.store.put('bugmsg', String(message.message_id), { id: String(message.message_id), groupId: String(chatId), num: ack, linkId: found.link.id });
      return message;
    } catch { return null; }
  }
  // The report number a replied-to message acknowledged, if it was one of the bot's own "Got it, #N" messages here.
  ackReportNum(found, replyTo) {
    if (!replyTo) return null;
    const record = this.store.get('bugmsg', String(replyTo.message_id));
    return record && record.linkId === found.link.id ? Number(record.num) : null;
  }
  async deleteAndWarn(found, message, warn) {
    await this.call(found.values.botToken, 'deleteMessage', { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
    if (warn) await this.reply(found, message.chat.id, undefined, warn).catch(() => {});
  }
  async leave(found, chatId) { await this.call(found.values.botToken, 'leaveChat', { chat_id: chatId }).catch(() => {}); }
  async isAdmin(found, chatId, userId) {
    if (!userId) return false;
    try { const member = await this.call(found.values.botToken, 'getChatMember', { chat_id: chatId, user_id: userId }); return ['creator', 'administrator'].includes(member?.status); }
    catch { return false; }
  }

  // The bot was added to a group: note it for the owner, then leave if it is not allowed, so it never lingers uninvited.
  async handleMembership(update, found) {
    const status = update.new_chat_member?.status, chat = update.chat || {};
    if (!['member', 'administrator'].includes(status)) return;
    if (isAllowedGroup(this.groups(found.values), chat.id)) { this.store.delete('bugpending', String(chat.id)); return; }
    this.notePending(chat);
    await this.leave(found, chat.id);
  }
  // A group the bot saw but is not allowed into, kept so the owner can approve it on the setup screen (then re-add the bot).
  notePending(chat) { if (chat?.id && (chat.type === 'group' || chat.type === 'supergroup')) this.store.put('bugpending', String(chat.id), { id: String(chat.id), title: chat.title || '', seenAt: new Date().toISOString() }); }
  pending() { return this.store.list('bugpending'); }

  // A "which report?" button press attaches the held message to the chosen report.
  async handleCallback(query, found) {
    const token = found.values.botToken, data = String(query.data || '');
    const ack = (text = '') => this.call(token, 'answerCallbackQuery', { callback_query_id: query.id, ...(text ? { text } : {}) }).catch(() => {});
    const match = /^pick:([0-9a-f]{12}):(\d{1,6})$/.exec(data);
    if (!match) return ack();
    const pickId = match[1], num = Number(match[2]), held = this.store.get('bugpick', pickId);
    const groupId = String(query.message?.chat?.id ?? '');
    // Bound to this bot, a group still on the allowlist, the bot message that carried the buttons, the reporter and the
    // reports it offered. A group removed since then, or a press from any other message, attaches nothing.
    const bound = held && held.linkId === found.link.id && held.botId === String(found.values.botId || '')
      && held.groupId === groupId && isAllowedGroup(this.groups(found.values), groupId)
      && held.promptId != null && String(held.promptId) === String(query.message?.message_id ?? '') && String(held.reporterId) === String(query.from?.id) && (held.nums || []).includes(num);
    if (held && held.reporterId !== String(query.from?.id)) return ack('Only the person who wrote it can choose.');
    if (!bound) return ack('That report is gone.');
    const report = this.reports().find(item => item.num === num && String(item.groupId) === held.groupId && String(item.reporterId) === held.reporterId && OPEN_STATUSES.has(item.status));
    if (!report) return ack('That report is gone.');
    this.store.delete('bugpick', pickId);
    await this.appendToReport(found, report, { text: held.text, media: held.media, message: query.message });
    return ack('Added');
  }

  // ---- approval (from the setup screen) ----
  // The person approves a queued bug: it leaves the hidden queue and becomes a Rex Desk task for the App Agent to take.
  approve(reportId) {
    const report = this.store.get('bugreport', reportId); if (!report) throw new Error('That report is gone.');
    if (report.approved) return report;
    const taskId = report.taskId;
    try {
      const assignee = this.appAgentName();
      if (this.desk.localTasks) {
        // Fire-and-forget task creation; the report keeps the task id once it is made.
        void this.desk.localTasks.create({ title: clip(`Bug #${report.num}: ${report.text || 'from Telegram'}`, 120),
          description: `Reported in Telegram group ${report.groupTitle || report.groupId} by ${report.reporterName}.\n\n${report.text}`,
          status: 'todo', priority: report.severity >= 3 ? 'high' : 'normal', project: 'rex-desk', ...(assignee ? { assignee } : {}),
          tags: ['telegram', 'bug'] }, { by: 'Bug bot' }).then(made => {
            const fresh = this.store.get('bugreport', reportId);
            if (fresh && made?.id) this.store.put('bugreport', reportId, { ...fresh, taskId: made.id });
          }).catch(() => {});
      }
    } catch { /* approval still stands even if the task could not be made */ }
    const updated = { ...report, approved: true, hidden: false, status: 'approved', taskId, updatedAt: new Date().toISOString() };
    this.store.put('bugreport', reportId, updated);
    return updated;
  }
  reject(reportId) {
    const report = this.store.get('bugreport', reportId); if (!report) throw new Error('That report is gone.');
    const updated = { ...report, status: 'rejected', hidden: true, updatedAt: new Date().toISOString() };
    this.store.put('bugreport', reportId, updated);
    return updated;
  }
  appAgentName() {
    const agent = this.store.list('specialist').find(item => /app[\s_-]?agent/i.test(String(item.name || '')));
    return agent?.name || '';
  }

  // ---- daily report + fixed notices (called by the server timer) ----
  // Once a day at the report time, send Rex (through the personal Telegram link) a morning summary of the queue, and tell each
  // group when a reported bug shipped, with the version.
  async dailyTick(now = new Date()) {
    const found = bugBotLink(this.store); if (!found?.values?.botToken) return;
    await this.notifyFixed(found).catch(() => {});
    const at = found.values.reportAt || '09:00';
    const [hour, minute] = at.split(':').map(Number);
    const meta = this.store.get('bugbot', 'daily') || {};
    const today = now.toISOString().slice(0, 10);
    if (meta.lastDate === today) return;
    if (now.getHours() < hour || (now.getHours() === hour && now.getMinutes() < minute)) return;
    this.store.put('bugbot', 'daily', { id: 'daily', lastDate: today });
    await this.sendMorningReport().catch(() => {});
  }
  // The version this Rex Desk runs: the installed app's own version, else the desk's.
  runningVersion() { return String(this.desk.version || process.env.REX_DESK_VERSION || this.store.config().version || ''); }
  // The version a done report's fix shipped in, or '' while that is not confirmed. Only the task's own confirmed
  // shippedVersion counts, and only once this desk runs at least that version. A task without one is never announced.
  shippedVersion(report, task) {
    const shipped = String(task.shippedVersion || '');
    return shipped && atLeastVersion(this.runningVersion(), shipped) ? shipped : '';
  }
  async notifyFixed(found) {
    // A report whose task is done and whose fix is in a shipped version gets one group reply crediting the fix. It counts as
    // announced only once Telegram accepted that message; a failed send is tried again on the next tick.
    for (const report of this.reports().filter(item => item.taskId && !item.fixedAnnounced && item.status !== 'rejected')) {
      const task = this.store.get('task', report.taskId);
      if (task?.status !== 'done') continue;
      const version = this.shippedVersion(report, task);
      if (!version) continue;
      const sent = await this.reply(found, report.groupId, undefined, `Good news: #${report.num} is fixed in version ${version}. Thanks for reporting it.`).catch(() => null);
      if (!sent?.message_id) continue;
      const fresh = this.store.get('bugreport', report.id) || report;
      this.store.put('bugreport', report.id, { ...fresh, fixedAnnounced: true, fixedVersion: version, status: 'done', updatedAt: new Date().toISOString() });
    }
  }
  async sendMorningReport() {
    const queued = this.reports().filter(report => report.status === 'queued');
    const approved = this.reports().filter(report => report.status === 'approved');
    if (!queued.length && !approved.length) return;
    const lines = ['Bug bot morning report:',
      `${queued.length} waiting for your OK, ${approved.length} approved and with the App Agent.`,
      ...queued.slice(0, 10).map(report => `#${report.num} (${report.severityLabel || 'unsorted'}) ${clip(report.text, 80)} — ${report.groupTitle || report.groupId}`)];
    // Delivered through the person's own linked Telegram chat (the bug bot never messages Rex's agents).
    await this.desk.telegram?.sendFromAgent?.('main', 'Bug bot', lines.join('\n')).catch(() => {});
  }

  // What the setup screen shows: the connection, allowed groups, and the queue counts (hidden reports stay server-side).
  status() {
    const found = bugBotLink(this.store);
    const reports = this.reports();
    return {
      connected: Boolean(found?.values?.botToken), botUsername: found?.values?.botUsername || '',
      reportAt: found?.values?.reportAt || '09:00', groups: this.groups(found?.values), pending: this.pending(),
      queue: reports.filter(report => report.status === 'queued').map(this.publicReport),
      features: reports.filter(report => report.status === 'feature').map(this.publicReport),
      approved: reports.filter(report => report.status === 'approved').map(this.publicReport),
    };
  }
  publicReport(report) { return { id: report.id, num: report.num, text: report.text, kind: report.kind, severityLabel: report.severityLabel, groupTitle: report.groupTitle, reporterName: report.reporterName, createdAt: report.createdAt, taskId: report.taskId }; }
}

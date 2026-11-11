import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const clip = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };
const working = new Set(['queued', 'starting', 'running', 'verifying', 'waiting']);
const settled = new Set(['finished', 'needs_evidence', 'failed']);
const KEEP = 300;
// HTTP headers carry ASCII only; anything else (Korean, emoji) goes in as RFC 2047, which ntfy reads.
const header = text => /^[ -~]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
export const TONES = ['chime', 'soft', 'pop', 'bell'];
const DEFAULTS = { windows: true, inapp: true, sound: true, volume: 0.6, tone: 'chime', preview: true, roomGap: 60, dndUntil: 0, push: { on: false, server: 'https://ntfy.sh', topic: '', always: false },
  kinds: { ask: true, reply: true, room: 'all', failed: true }, quiet: { on: false, from: '22:00', to: '08:00' } };

// A Windows toast. The text goes in through the environment, never into the script, so nothing in an agent's message can run as a command.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$t = [Security.SecurityElement]::Escape($env:REX_TOAST_TITLE); $b = [Security.SecurityElement]::Escape($env:REX_TOAST_BODY)',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$audio = if ($env:REX_TOAST_SOUND) { "<audio src=\'ms-winsoundevent:Notification." + $env:REX_TOAST_SOUND + "\'/>" } else { "<audio silent=\'true\'/>" }',
  '$xml.LoadXml("<toast><visual><binding template=\'ToastGeneric\'><text>$t</text><text>$b</text></binding></visual>$audio</toast>")',
  "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('; ');
export function windowsToast(title, body, { sound = 'Default' } = {}) {
  if (process.platform !== 'win32') return;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
    { windowsHide: true, timeout: 15000, env: { ...process.env, REX_TOAST_TITLE: clip(title, 100), REX_TOAST_BODY: clip(body, 220), REX_TOAST_SOUND: /^(Default|IM|Mail|Reminder|SMS)$/.test(sound) ? sound : '' } }, () => {});
}

// Every notification is kept in a list the person can read in Rex Desk, with unread counts on each chat.
// A Windows toast goes out only when Rex Desk is not the window they are looking at; a chat that is open on screen is read at once.
// Muted chats still keep their notifications, read and quiet.
export class Notifier {
  constructor(store, { show = windowsToast, focused = () => false, viewing = () => '', enabled = () => true, minGapMs = 2500 } = {}) {
    Object.assign(this, { store, show, focused, viewing, enabled, minGapMs }); this.states = new Map(); this.seen = new Set(); this.lastAt = 0; this.roomToast = new Map(); this.started = false;
  }
  start() {
    if (this.started) return this; this.started = true;
    for (const run of this.store.list('run')) this.states.set(run.id, run.state);
    for (const item of this.store.list('interaction')) this.seen.add(item.id);
    for (const item of this.store.list('roommsg')) this.seen.add(`msg:${item.id}`);
    this.store.on('change', event => { try { this.onChange(event); } catch { /* a notification never breaks the app */ } });
    return this;
  }
  prefs() {
    const saved = this.store.get('prefs', 'notify') || {};
    const prefs = { ...DEFAULTS, ...saved, kinds: { ...DEFAULTS.kinds, ...(saved.kinds || {}) }, quiet: { ...DEFAULTS.quiet, ...(saved.quiet || {}) }, push: { ...DEFAULTS.push, ...(saved.push || {}) }, mutes: saved.mutes || [] };
    // A private topic name, made once: whoever knows it can read the pushes, so it is long and random.
    if (!prefs.push.topic) { prefs.push.topic = `rexdesk-${randomUUID().replaceAll('-', '').slice(0, 24)}`; this.store.put('prefs', 'notify', { ...saved, id: 'notify', push: prefs.push }); }
    return prefs;
  }
  // What the person chose on the Notifications screen. Only known settings are kept.
  setPrefs(input = {}) {
    const prefs = this.prefs(), next = { ...prefs, id: 'notify' }, time = value => /^\d{2}:\d{2}$/.test(String(value)) ? String(value) : null;
    for (const key of ['windows', 'inapp', 'sound', 'preview']) if (input[key] !== undefined) next[key] = Boolean(input[key]);
    if (input.volume !== undefined) next.volume = Math.max(0, Math.min(1, Number(input.volume) || 0));
    if (input.tone !== undefined && TONES.includes(input.tone)) next.tone = input.tone;
    if (input.roomGap !== undefined) next.roomGap = [0, 60, 300, 900].includes(Number(input.roomGap)) ? Number(input.roomGap) : 60;
    if (input.kinds) for (const [kind, value] of Object.entries(input.kinds)) if (kind in DEFAULTS.kinds) next.kinds[kind] = kind === 'room' ? (['all', 'mentions', 'off'].includes(value) ? value : 'all') : Boolean(value);
    if (input.quiet) next.quiet = { on: input.quiet.on !== undefined ? Boolean(input.quiet.on) : prefs.quiet.on, from: time(input.quiet.from) || prefs.quiet.from, to: time(input.quiet.to) || prefs.quiet.to };
    if (input.push) {
      const push = { ...prefs.push };
      if (input.push.on !== undefined) push.on = Boolean(input.push.on);
      if (input.push.always !== undefined) push.always = Boolean(input.push.always);
      if (input.push.server !== undefined) { const url = String(input.push.server).trim().replace(/\/+$/, ''); if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) throw new Error('Type the ntfy server address, like https://ntfy.sh.'); push.server = url; }
      if (input.push.newTopic) push.topic = `rexdesk-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      next.push = push;
    }
    if (input.dndMinutes !== undefined) next.dndUntil = Number(input.dndMinutes) > 0 ? Date.now() + Number(input.dndMinutes) * 60000 : 0;
    this.store.put('prefs', 'notify', next); return next;
  }
  // Quiet hours or Do not disturb: notifications are kept, but nothing pops up and nothing makes a sound.
  quietNow(at = new Date()) {
    const prefs = this.prefs(); if (prefs.dndUntil && Date.now() < prefs.dndUntil) return true;
    if (!prefs.quiet.on) return false;
    const minutes = at.getHours() * 60 + at.getMinutes(), [fh, fm] = prefs.quiet.from.split(':').map(Number), [th, tm] = prefs.quiet.to.split(':').map(Number), from = fh * 60 + fm, to = th * 60 + tm;
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  }
  muted(key) { return this.prefs().mutes.includes(key); }
  mute(key, on) { const prefs = this.prefs(), mutes = new Set(prefs.mutes); if (on) mutes.add(key); else mutes.delete(key); this.store.put('prefs', 'notify', { ...prefs, mutes: [...mutes] }); return { muted: on }; }
  runTitle(run) {
    const agentId = run?.roomAgent || run?.specialistId;
    if (run?.main || agentId === 'main') return 'Rex Agent';
    return (agentId && this.store.get('specialist', agentId)?.name) || run?.title || 'An agent';
  }
  // The chat a run's conversation shows in: Rex Agent's chat, an agent's personal chat, or the run itself.
  targetOfRun(run) { return run?.main ? { type: 'main', id: '' } : { type: 'run', id: run?.id || '' }; }
  onChange({ kind, id }) {
    if (kind === 'interaction') {
      const item = this.store.get('interaction', id);
      if (!item || item.state !== 'pending' || this.seen.has(id)) return;
      this.seen.add(id);
      this.notify({ kind: 'ask', title: `${item.kind === 'approval' ? 'Needs your OK' : 'Needs your answer'} · ${this.runTitle(this.store.get('run', item.runId))}`, body: item.title, target: { type: 'inbox', id: '' } });
    } else if (kind === 'run') {
      const run = this.store.get('run', id); if (!run) return;
      const before = this.states.get(id); this.states.set(id, run.state);
      if (!before || !working.has(before) || !settled.has(run.state)) return;
      if (run.roomAgent) return; // a group chat turn is told by its messages
      if (run.state === 'failed') return this.notify({ kind: 'failed', title: `${this.runTitle(run)} stopped`, body: run.error || 'The run failed.', target: this.targetOfRun(run) });
      const last = this.store.events(id, { visible: true, limit: 20 }).filter(event => ['agent-text', 'message'].includes(event.kind)).at(-1);
      this.notify({ kind: 'reply', title: `${this.runTitle(run)} replied`, body: last?.text || last?.message || 'It finished its turn.', target: this.targetOfRun(run) });
    } else if (kind === 'roommsg') {
      const message = this.store.get('roommsg', id);
      if (!message || this.seen.has(`msg:${id}`)) return; this.seen.add(`msg:${id}`);
      if (message.from?.type !== 'agent') return;
      const room = this.store.get('room', message.roomId), toYou = /(^|[^\w@])@you\b/i.test(String(message.text || '')); // only an explicit @you: an agent's ordinary reply is not a question to you
      // In a busy room, one pop-up per chosen gap; every message still counts as unread. A message to you always pops up.
      const gap = this.prefs().roomGap * 1000, quiet = !toYou && gap > 0 && Date.now() - (this.roomToast.get(message.roomId) || 0) < gap;
      if (!quiet) this.roomToast.set(message.roomId, Date.now());
      this.notify({ kind: toYou ? 'mention' : 'room', title: toYou ? `${message.from.label} asked you in ${room?.name || 'a room'}` : `${message.from.label} in ${room?.name || 'a room'}`, body: message.text, target: { type: 'room', id: message.roomId }, toast: !quiet, from: message.from.label });
    }
  }
  keyOf(target) { return `${target.type}:${target.id || ''}`; }
  // Whether this kind of notification is turned on. Group chat messages can be all, only the ones to you, or none.
  wanted(kind) { const kinds = this.prefs().kinds; if (kind === 'room') return kinds.room === 'all'; if (kind === 'mention') return kinds.room !== 'off'; return kinds[kind] !== false; }
  notify({ kind = 'reply', title, body, target = { type: 'inbox', id: '' }, toast = true, from = '' }) {
    const prefs = this.prefs(), key = this.keyOf(target), looking = this.focused() && this.viewing() === key, muted = this.muted(key), wanted = this.wanted(kind), quiet = this.quietNow();
    // alert: the in-app pop-up and its sound may show it; toast: a Windows pop-up too.
    const alert = toast && wanted && !muted && !quiet && !looking;
    const notice = { id: randomUUID(), at: new Date().toISOString(), kind, title: clip(title, 120), body: clip(body, 400), target, key, from, read: looking || muted || !wanted, alert };
    this.store.put('notice', notice.id, notice); this.prune();
    // A push to the phone (ntfy) when the person is away from this window, or always if they chose that.
    if (alert && prefs.push.on && (prefs.push.always || !this.focused()) && this.enabled()) void this.push({ kind, title, body: prefs.preview ? body : 'Open Rex Desk to read it.' });
    if (!alert || !prefs.windows || !this.enabled() || this.focused()) return notice;
    const now = Date.now(); if (now - this.lastAt < this.minGapMs) return notice; this.lastAt = now;
    this.show(title, prefs.preview ? body : 'Open Rex Desk to read it.', { sound: prefs.sound ? (kind === 'ask' || kind === 'mention' ? 'Reminder' : kind === 'failed' ? 'Default' : 'IM') : '' }); return notice;
  }
  async push({ kind = 'reply', title, body, test = false }) {
    const { push } = this.prefs();
    try {
      const response = await (this.fetch || fetch)(`${push.server}/${push.topic}`, { method: 'POST', body: clip(body, 1000), signal: AbortSignal.timeout(10000),
        headers: { Title: header(clip(title, 120)), Priority: kind === 'ask' || kind === 'mention' || kind === 'failed' ? '4' : '3', Tags: kind === 'failed' ? 'warning' : kind === 'ask' || kind === 'mention' ? 'raising_hand' : 'speech_balloon', ...(this.pushClick?.() ? { Click: this.pushClick() } : {}) } });
      this.pushError = response.ok ? '' : `ntfy answered ${response.status}.`;
    } catch (error) { this.pushError = error.message; }
    if (test && this.pushError) throw new Error(`The phone push did not go out: ${this.pushError}`);
    return { sent: !this.pushError };
  }
  testPush() { return this.push({ kind: 'reply', title: 'Rex Desk', body: 'Phone notifications work. You will get one when an agent replies, asks or stops.', test: true }); }
  test() { return this.notify({ kind: 'reply', title: 'Rex Desk', body: 'This is how a notification looks and sounds.', target: { type: 'notices', id: '' } }); }
  prune() { const all = this.store.list('notice').sort((a, b) => String(b.at).localeCompare(String(a.at))); for (const old of all.slice(KEEP)) this.store.delete('notice', old.id); }
  read({ key = '', all = false } = {}) {
    let count = 0;
    for (const notice of this.store.list('notice')) if (!notice.read && (all || notice.key === key)) { this.store.put('notice', notice.id, { ...notice, read: true }); count++; }
    return { read: count };
  }
  summary() {
    const all = this.store.list('notice').sort((a, b) => String(b.at).localeCompare(String(a.at))), unread = all.filter(item => !item.read);
    const byKey = {}; for (const item of unread) byKey[item.key] = (byKey[item.key] || 0) + 1;
    const prefs = this.prefs(); return { unread: unread.length, byKey, recent: all.slice(0, 60), mutes: prefs.mutes, prefs: { ...prefs, quietNow: this.quietNow(), pushError: this.pushError || '' } };
  }
}

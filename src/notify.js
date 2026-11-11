import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const clip = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };
const working = new Set(['queued', 'starting', 'running', 'verifying', 'waiting']);
const settled = new Set(['finished', 'needs_evidence', 'failed']);
const KEEP = 300, ROOM_TOAST_GAP = 60000;

// A Windows toast. The text goes in through the environment, never into the script, so nothing in an agent's message can run as a command.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$t = [Security.SecurityElement]::Escape($env:REX_TOAST_TITLE); $b = [Security.SecurityElement]::Escape($env:REX_TOAST_BODY)',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml("<toast><visual><binding template=\'ToastGeneric\'><text>$t</text><text>$b</text></binding></visual></toast>")',
  "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('; ');
export function windowsToast(title, body) {
  if (process.platform !== 'win32') return;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
    { windowsHide: true, timeout: 15000, env: { ...process.env, REX_TOAST_TITLE: clip(title, 100), REX_TOAST_BODY: clip(body, 220) } }, () => {});
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
  prefs() { return this.store.get('prefs', 'notify') || { id: 'notify', mutes: [] }; }
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
      const room = this.store.get('room', message.roomId);
      // In a busy room, one toast a minute; every message still counts as unread.
      const quiet = Date.now() - (this.roomToast.get(message.roomId) || 0) < ROOM_TOAST_GAP;
      if (!quiet) this.roomToast.set(message.roomId, Date.now());
      this.notify({ kind: 'room', title: `${message.from.label} in ${room?.name || 'a room'}`, body: message.text, target: { type: 'room', id: message.roomId }, toast: !quiet });
    }
  }
  keyOf(target) { return `${target.type}:${target.id || ''}`; }
  notify({ kind = 'reply', title, body, target = { type: 'inbox', id: '' }, toast = true }) {
    const key = this.keyOf(target), looking = this.focused() && this.viewing() === key, muted = this.muted(key);
    const notice = { id: randomUUID(), at: new Date().toISOString(), kind, title: clip(title, 120), body: clip(body, 400), target, key, read: looking || muted };
    this.store.put('notice', notice.id, notice); this.prune();
    if (!toast || muted || !this.enabled() || this.focused()) return notice;
    const now = Date.now(); if (now - this.lastAt < this.minGapMs) return notice; this.lastAt = now;
    this.show(title, body); return notice;
  }
  prune() { const all = this.store.list('notice').sort((a, b) => String(b.at).localeCompare(String(a.at))); for (const old of all.slice(KEEP)) this.store.delete('notice', old.id); }
  read({ key = '', all = false } = {}) {
    let count = 0;
    for (const notice of this.store.list('notice')) if (!notice.read && (all || notice.key === key)) { this.store.put('notice', notice.id, { ...notice, read: true }); count++; }
    return { read: count };
  }
  summary() {
    const all = this.store.list('notice').sort((a, b) => String(b.at).localeCompare(String(a.at))), unread = all.filter(item => !item.read);
    const byKey = {}; for (const item of unread) byKey[item.key] = (byKey[item.key] || 0) + 1;
    return { unread: unread.length, byKey, recent: all.slice(0, 60), mutes: this.prefs().mutes };
  }
}

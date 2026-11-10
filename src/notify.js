import { execFile } from 'node:child_process';

const clip = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };
const working = new Set(['queued', 'starting', 'running', 'verifying', 'waiting']);
const settled = new Set(['finished', 'needs_evidence', 'failed']);

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

// Tells the person when an agent needs them or has answered, but only while Rex Desk is not the window they are looking at.
export class Notifier {
  constructor(store, { show = windowsToast, focused = () => false, enabled = () => true, minGapMs = 2500 } = {}) {
    Object.assign(this, { store, show, focused, enabled, minGapMs }); this.states = new Map(); this.seen = new Set(); this.lastAt = 0; this.started = false;
  }
  start() {
    if (this.started) return this; this.started = true;
    for (const run of this.store.list('run')) this.states.set(run.id, run.state);
    for (const item of this.store.list('interaction')) this.seen.add(item.id);
    this.store.on('change', event => { try { this.onChange(event); } catch { /* a notification never breaks the app */ } });
    return this;
  }
  runTitle(run) { return run?.title || (run?.main ? 'Rex Agent' : 'An agent'); }
  onChange({ kind, id }) {
    if (kind === 'interaction') {
      const item = this.store.get('interaction', id);
      if (!item || item.state !== 'pending' || this.seen.has(id)) return;
      this.seen.add(id);
      this.notify(`${item.kind === 'approval' ? 'Needs your OK' : 'Needs your answer'} · ${this.runTitle(this.store.get('run', item.runId))}`, item.title);
    } else if (kind === 'run') {
      const run = this.store.get('run', id); if (!run) return;
      const before = this.states.get(id); this.states.set(id, run.state);
      if (!before || !working.has(before) || !settled.has(run.state)) return;
      if (run.state === 'failed') return this.notify(`${this.runTitle(run)} stopped`, run.error || 'The run failed.');
      const last = this.store.events(id, { visible: true, limit: 20 }).filter(event => ['agent-text', 'message'].includes(event.kind)).at(-1);
      this.notify(`${this.runTitle(run)} replied`, last?.text || last?.message || 'It finished its turn.');
    }
  }
  notify(title, body) {
    if (!this.enabled() || this.focused()) return;
    const now = Date.now(); if (now - this.lastAt < this.minGapMs) return; this.lastAt = now;
    this.show(title, body);
  }
}

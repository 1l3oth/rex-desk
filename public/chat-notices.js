import { askConfirm } from './confirm.js';
import { t, locale } from './i18n.js';
import { avatarHtml } from './chat-rooms.js';
// Notifications: everything agents said or asked while you were elsewhere, newest first, with unread counts on each chat.
// A new one pops up at the bottom right with a sound (both can be turned off), and you can open it or answer it from there.
// The settings decide what counts, how it reaches you, and when Rex Desk stays quiet.
const KIND = { ask: [t('Needs you'), 'ask'], reply: [t('Replied'), 'reply'], room: [t('Group chat'), 'room'], mention: [t('To you'), 'ask'], failed: [t('Stopped'), 'failed'] };
const TONES = [['chime', t('Chime')], ['soft', t('Soft')], ['pop', t('Pop')], ['bell', t('Bell')]];

// The key of the chat on screen, the same key the server gives each notification.
export function noticeKey(view) {
  if (view.type === 'main') return 'main:';
  if (view.type === 'room' || view.type === 'run') return `${view.type}:${view.id}`;
  if (view.type === 'inbox') return 'inbox:';
  return '';
}
export const unreadFor = (ui, key) => ui.snap?.notices?.byKey?.[key] || 0;
const when = at => { const minutes = Math.round((Date.now() - Date.parse(at)) / 60000); return minutes < 1 ? t('now') : minutes < 60 ? t`${minutes} min` : minutes < 1440 ? t`${Math.round(minutes / 60)} h` : new Date(at).toLocaleDateString(locale(), { month: 'short', day: 'numeric' }); };
const who = item => item.from || String(item.title || '').replace(/ (replied|stopped|in .*|asked you.*)$/, '').replace(/^(Needs your (OK|answer) · )/, '') || t('Rex Desk');

// ---------- sounds, made in the page (no files) ----------
let audio = null;
export function playTone(tone = 'chime', kind = 'reply', volume = 0.6) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    // A sound started while the context is still suspended was lost: play only once resume() has finished.
    if (audio.state === 'suspended') { audio.resume().then(() => playNotes(tone, kind, volume), () => {}); return; }
    playNotes(tone, kind, volume);
  } catch { /* no sound on this device */ }
}
function playNotes(tone, kind, volume) {
  try {
    const notes = kind === 'ask' || kind === 'mention' ? [[784, 0], [988, 0.11], [1319, 0.22]] : kind === 'failed' ? [[392, 0], [294, 0.16]]
      : { chime: [[880, 0], [1319, 0.12]], soft: [[660, 0]], pop: [[520, 0], [780, 0.06]], bell: [[1047, 0], [1568, 0.02]] }[tone] || [[880, 0]];
    const start = audio.currentTime + 0.01, master = audio.createGain(); master.gain.value = Math.max(0, Math.min(1, volume)) * 0.35; master.connect(audio.destination);
    for (const [frequency, offset] of notes) {
      const osc = audio.createOscillator(), gain = audio.createGain(), length = tone === 'bell' ? 0.9 : tone === 'pop' ? 0.12 : 0.32;
      osc.type = tone === 'pop' ? 'triangle' : 'sine'; osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset); gain.gain.exponentialRampToValueAtTime(1, start + offset + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + length);
      osc.connect(gain); gain.connect(master); osc.start(start + offset); osc.stop(start + offset + length + 0.05);
    }
  } catch { /* no sound on this device */ }
}

// Browsers and the desktop window keep page sound locked until the person clicks or types once: unlock it on that first
// gesture, so a later Needs you chime is heard even if nothing has played yet.
if (typeof window !== 'undefined') {
  const unlock = () => { try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') void audio.resume().catch(() => {}); } catch { /* no sound */ } };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
}

// ---------- the list, a dropdown under the bell ----------
function noticeListHtml(ctx) {
  const { ui, esc } = ctx, data = ui.snap?.notices || { recent: [], unread: 0, prefs: {} }, prefs = data.prefs || {};
  const filter = ui.noticeFilter === 'unread' ? 'unread' : 'all', list = data.recent.filter(item => filter === 'all' || !item.read);
  const dnd = prefs.dndUntil && prefs.dndUntil > Date.now();
  const row = item => { const [label, tone] = KIND[item.kind] || [t('Update'), 'reply'], name = who(item);
    return `<li class="nt-row${item.read ? '' : ' unread'}"><button type="button" class="nt-open" data-action="nt-open" data-key="${esc(item.key)}" data-type="${esc(item.target.type)}" data-id="${esc(item.target.id || '')}">
      ${avatarHtml(ctx, { name, size: 'sm' })}<span class="nt-text"><span class="nt-top"><b>${esc(item.title)}</b><span class="nt-kind ${tone}">${esc(label)}</span></span><small>${esc(item.body)}</small></span><span class="nt-when">${esc(when(item.at))}${item.read ? '' : '<i class="nt-dot"></i>'}</span></button></li>`; };
  return `<div class="nt-pane-head"><h2>${t`Notifications`}</h2>${dnd ? `<span class="nt-kind">${t`Do not disturb`}</span>` : prefs.quietNow ? `<span class="nt-kind">${t`Quiet hours`}</span>` : ''}<span class="spacer"></span>
      <button type="button" class="nt-gear" data-action="nt-settings" title="${t`Notification settings`}" aria-label="${t`Notification settings`}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg></button></div>
    <div class="nt-bar"><div class="pseg"><button type="button" class="tab ${filter === 'all' ? 'on' : ''}" data-action="nt-filter" data-tab="all">${t`All`}</button><button type="button" class="tab ${filter === 'unread' ? 'on' : ''}" data-action="nt-filter" data-tab="unread">${t('Unread')}${data.unread ? `<span class="tcount">${data.unread}</span>` : ''}</button></div><span class="spacer"></span>${data.unread ? `<button type="button" class="btn small quiet" data-action="nt-readall">${t`Mark all as read`}</button>` : ''}</div>
    ${list.length ? `<ul class="nt-list">${list.map(row).join('')}</ul>` : `<div class="nt-empty"><b>${filter === 'unread' ? t('All caught up') : t('Nothing yet')}</b><small>${t`When an agent replies, asks you something or stops, it shows here.`}</small></div>`}`;
}
let pane = null, paneHtml = '';
// A phone-sized screen: pop-ups sit at the top and desktop-only settings are left out.
const onPhone = () => Boolean(window.matchMedia?.('(max-width:760px)').matches);
function placePane() {
  if (!pane) return;
  const bell = document.querySelector('.tile[data-action="nt-panel"]'), box = bell?.getBoundingClientRect(), narrow = window.innerWidth < 640;
  // Under the window bar's bell, right-aligned; otherwise beside the list, level with the bell row, never past the bottom.
  if (bell?.closest('.win-bar') && !narrow) { pane.style.left = `${Math.round(Math.max(8, box.right - pane.offsetWidth))}px`; pane.style.top = `${Math.round(box.bottom + 8)}px`; return; }
  pane.style.left = narrow || !box ? '8px' : `${Math.round(box.right + 14)}px`;
  pane.style.top = narrow || !box ? '56px' : `${Math.round(Math.max(8, Math.min(box.top - 12, window.innerHeight - pane.offsetHeight - 12)))}px`;
}
function drawPane(ctx) {
  if (!pane) return;
  const html = noticeListHtml(ctx);
  if (html !== paneHtml) { const top = pane.querySelector('.nt-list')?.scrollTop || 0; paneHtml = html; pane.innerHTML = html; const next = pane.querySelector('.nt-list'); if (next) next.scrollTop = top; }
  placePane();
}
export function closeNoticePane() { pane?.remove(); pane = null; paneHtml = ''; document.querySelector('.tile[data-action="nt-panel"]')?.classList.remove('active'); }
export function toggleNoticePane(ctx) {
  if (pane) return closeNoticePane();
  // The list shows everything the pop-ups said, so open pop-ups go away instead of sitting over it.
  document.querySelector('.nt-stack')?.replaceChildren();
  pane = document.createElement('div'); pane.className = 'nt-pane'; pane.setAttribute('role', 'dialog'); pane.setAttribute('aria-label', t('Notifications'));
  document.body.append(pane); drawPane(ctx); document.querySelector('.tile[data-action="nt-panel"]')?.classList.add('active');
  pane.querySelector('.tab.on')?.focus();
}
document.addEventListener('mousedown', event => { if (pane && !event.target.closest?.('.nt-pane,.tile[data-action="nt-panel"],.nt-stack')) closeNoticePane(); });
document.addEventListener('keydown', event => { if (pane && event.key === 'Escape') closeNoticePane(); });
window.addEventListener('resize', placePane);

// ---------- the notification settings (a tab in Settings) ----------
export function noticeSettingsHtml(ctx) {
  const { ui, esc } = ctx, data = ui.snap.notices || { recent: [], unread: 0, mutes: [], prefs: {} }, prefs = data.prefs || {}, mutes = new Set(data.mutes || []);
  const chats = [{ key: 'main:', name: t('Rex Agent') }, ...(ui.snap.rooms || []).map(room => ({ key: `room:${room.id}`, name: room.name, sub: t('Group chat') })),
    ...(ui.snap.specialists || []).filter(agent => agent.runId).map(agent => ({ key: `run:${agent.runId}`, name: agent.name, sub: agent.projectSlug }))];
  const toggle = (name, on, label, help = '') => `<label class="nt-switch"><input type="checkbox" data-nt-pref="${name}" ${on ? 'checked' : ''}><span class="nt-track" aria-hidden="true"></span><span class="nt-lbl"><b>${label}</b>${help ? `<small>${help}</small>` : ''}</span></label>`;
  const select = (name, value, options) => `<select data-nt-pref="${name}">${options.map(([key, label]) => `<option value="${key}" ${String(value) === String(key) ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  const kinds = prefs.kinds || {}, quiet = prefs.quiet || {}, dnd = prefs.dndUntil && prefs.dndUntil > Date.now();
  // Phone pushes through the ntfy app: subscribe once to this computer's private topic.
  const push = prefs.push || {};
  if (!ui.pushQr && !ui.pushQrLoading && push.topic) { ui.pushQrLoading = true; ctx.api('/notices/push-qr').then(result => { ui.pushQr = result; ui.pushQrLoading = false; window.__rexNoticeSettingsRedraw?.(); }).catch(() => { ui.pushQrLoading = false; }); }
  const phone = `<section class="card nt-card nt-phone"><h3>${t`Phone`}</h3>
      ${toggle('push.on', push.on, t('Push to my phone'), t('Through the free ntfy app. Arrives even when Rex Desk is closed on the phone.'))}
      <ol class="nt-steps"><li>${t`Install ${'<b>ntfy</b>'} from the App Store or Google Play.`}</li><li>${t`In ntfy press ${'<b>+</b>'}, then scan this code or paste the topic.`}</li><li>${t`Press ${`<b>${t`Send a test push`}</b>`}.`}</li></ol>
      <div class="nt-qr">${ui.pushQr?.svg || `<span class="muted small">${t`Making the code…`}</span>`}</div>
      <div class="nt-topic"><code>${esc(push.topic || '')}</code><button type="button" class="btn small" data-action="nt-copy-topic">${t`Copy`}</button></div>
      ${toggle('push.always', push.always, t('Also while I am at this computer'), t('Off: the phone gets it only when Rex Desk is not the window in front.'))}
      <div class="nt-chips"><button type="button" class="btn small primary" data-action="nt-push-test">${t`Send a test push`}</button><button type="button" class="btn small quiet" data-action="nt-new-topic" title="${t`Use if someone else got this topic`}">${t`New private topic`}</button></div>
      ${prefs.pushError ? `<p class="small warn-text">${t`Last push failed: ${esc(prefs.pushError)}`}</p>` : ''}
      <details class="nt-adv"><summary>${t`Own ntfy server`}</summary><input type="url" data-nt-pref="push.server" value="${esc(push.server || 'https://ntfy.sh')}" aria-label="${t`ntfy server address`}"><small class="muted">${t`Anyone with the topic name can read the pushes on ntfy.sh. Turn off "Show the message in pop-ups" to send only who wrote.`}</small></details></section>`;
  return `<div class="nt-settings">
    ${phone}
    <section class="card nt-card"><h3>${t`Do not disturb`}</h3>
      ${dnd ? `<p class="nt-dnd on">${t`Quiet until ${esc(new Date(prefs.dndUntil).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }))}`}</p><button type="button" class="btn small" data-action="nt-dnd" data-minutes="0">${t`Turn off`}</button>`
        : `<div class="nt-chips">${[[30, '30 min'], [60, '1 hour'], [180, '3 hours'], [720, t('Until tomorrow')]].map(([minutes, label]) => `<button type="button" class="btn small" data-action="nt-dnd" data-minutes="${minutes}">${label}</button>`).join('')}</div>`}
      ${toggle('quiet.on', quiet.on, t('Quiet hours every day'), t('Kept in the list, but no pop-ups and no sound.'))}
      <div class="nt-row2"><label>${t`From`}<input type="time" data-nt-pref="quiet.from" value="${esc(quiet.from || '22:00')}"></label><label>To<input type="time" data-nt-pref="quiet.to" value="${esc(quiet.to || '08:00')}"></label></div>
      ${prefs.quietNow && !dnd ? `<p class="muted small">${t`Quiet hours are on now.`}</p>` : ''}</section>
    <section class="card nt-card"><h3>${t`What to tell you`}</h3>
      ${toggle('kinds.ask', kinds.ask !== false, t('Questions and approvals'), t('An agent waits for your answer or OK.'))}
      ${toggle('kinds.reply', kinds.reply !== false, t('Replies in personal chats'), t('An agent finished answering you.'))}
      ${toggle('kinds.failed', kinds.failed !== false, t('Stopped or failed work'))}
      <label class="nt-field"><span><b>${t`Group chats`}</b><small>${t`Messages that @mention you always count, unless this is Off.`}</small></span>${select('kinds.room', kinds.room || 'all', [['all', t('Every message')], ['mentions', t('Only messages to me')], ['off', t('Off')]])}</label>
      <label class="nt-field"><span><b>${t`Busy group chats`}</b><small>${t`How often one room may pop up.`}</small></span>${select('roomGap', prefs.roomGap ?? 60, [[0, t('Every message')], [60, t('At most once a minute')], [300, t('Every 5 minutes')], [900, t('Every 15 minutes')]])}</label></section>
    <section class="card nt-card"><h3>${t`How it reaches you`}</h3>
      ${toggle('inapp', prefs.inapp !== false, t('Pop-up inside Rex Desk'), onPhone() ? t('At the top of the screen, for chats you are not looking at.') : t('Bottom right, for chats you are not looking at.'))}
      ${onPhone() ? '' : toggle('windows', prefs.windows !== false, t('Windows pop-ups'), t('When Rex Desk is not the window in front.'))}
      ${toggle('preview', prefs.preview !== false, t('Show the message in pop-ups'), t('Off: pop-ups only say who wrote.'))}
      ${toggle('sound', prefs.sound !== false, t('Sound'))}
      <div class="nt-row2"><label>${t('Tone')}${select('tone', prefs.tone || 'chime', TONES)}</label><label>${t`Volume`}<input type="range" min="0" max="1" step="0.05" data-nt-pref="volume" value="${esc(prefs.volume ?? 0.6)}"></label></div>
      <div class="nt-chips"><button type="button" class="btn small" data-action="nt-hear">${t`Play`}</button><button type="button" class="btn small primary" data-action="nt-test">${t`Send a test notification`}</button></div>
      <p class="muted small">${t`Questions use a rising three-note sound, stops a falling one, so you can tell them apart without looking.`}</p></section>
    <section class="card nt-card"><h3>${t`Mute a chat`}</h3><p class="muted small">${t`No pop-ups, no sound and no unread count. Its messages stay in the list.`}</p>
      <ul class="nt-mutes">${chats.map(chat => `<li>${avatarHtml(ctx, { name: chat.name, size: 'sm' })}<span class="nt-mname"><b>${esc(chat.name)}</b>${chat.sub ? `<small>${esc(chat.sub)}</small>` : ''}</span><button type="button" class="btn small${mutes.has(chat.key) ? ' on' : ' quiet'}" data-action="nt-mute" data-key="${esc(chat.key)}" data-on="${mutes.has(chat.key) ? '0' : '1'}">${mutes.has(chat.key) ? t('Muted') : t('Mute')}</button></li>`).join('')}</ul></section>
  </div>`;
}

async function savePref(ctx, name, value) {
  const [group, key] = name.split('.'), data = key ? { [group]: { [key]: value } } : { [group]: value };
  try { await ctx.api('/notices/prefs', { method: 'POST', data }); await ctx.refresh(); } catch (error) { ctx.toast(error.message, true); }
}
export async function noticesAction(ctx, action, target) {
  const { api, ui, refresh, open } = ctx, prefs = ui.snap.notices?.prefs || {};
  if (action === 'nt-panel') { toggleNoticePane(ctx); return; }
  if (action === 'nt-settings') { closeNoticePane(); ctx.openSettings('notify'); return; }
  if (action === 'nt-filter') { ui.noticeFilter = target.dataset.tab; drawPane(ctx); return; }
  if (action === 'nt-readall') { await api('/notices/read', { method: 'POST', data: { all: true } }); await refresh(); return; }
  if (action === 'nt-mute') { await api('/notices/mute', { method: 'POST', data: { key: target.dataset.key, on: target.dataset.on === '1' } }); await refresh(); return; }
  if (action === 'nt-dnd') { await api('/notices/prefs', { method: 'POST', data: { dndMinutes: Number(target.dataset.minutes) } }); await refresh(); return; }
  if (action === 'nt-hear') { playTone(prefs.tone, 'reply', prefs.volume ?? 0.6); return; }
  if (action === 'nt-push-test') { try { await api('/notices/push-test', { method: 'POST', data: {} }); ctx.toast(t('Test push sent. Check your phone.')); } catch (error) { ctx.toast(error.message, true); } await refresh(); return; }
  if (action === 'nt-copy-topic') { await navigator.clipboard.writeText(prefs.push?.topic || ''); ctx.toast(t('Topic copied.')); return; }
  if (action === 'nt-new-topic') { if (!await askConfirm(t('Make a new private topic? Your phone stops getting pushes until you subscribe to the new one.'))) return; await api('/notices/prefs', { method: 'POST', data: { push: { newTopic: true } } }); ui.pushQr = null; await refresh(); return; }
  if (action === 'nt-test') { await api('/notices/test', { method: 'POST', data: {} }); await refresh(); return; }
  if (action === 'nt-read') { await api('/notices/read', { method: 'POST', data: { key: target.dataset.key } }).catch(() => {}); target.closest('.nt-pop')?.remove(); await refresh(); return; }
  if (action === 'nt-open') {
    await api('/notices/read', { method: 'POST', data: { key: target.dataset.key } }).catch(() => {}); target.closest('.nt-pop')?.remove();
    // A test notification points at the list itself.
    if (target.dataset.type === 'notices') { if (!pane) toggleNoticePane(ctx); await refresh(); return; }
    closeNoticePane(); open(target.dataset.type === 'inbox' ? 'inbox' : target.dataset.type, target.dataset.id || '');
  }
}
document.addEventListener('change', event => {
  const name = event.target.dataset?.ntPref; if (!name || !window.__rexCtx) return;
  const value = event.target.type === 'checkbox' ? event.target.checked : event.target.type === 'range' ? Number(event.target.value) : event.target.value;
  void savePref(window.__rexCtx, name, value);
  if (name === 'tone' || name === 'volume') { const prefs = window.__rexCtx.ui.snap.notices?.prefs || {}; playTone(name === 'tone' ? value : prefs.tone, 'reply', name === 'volume' ? value : prefs.volume ?? 0.6); }
});

// ---------- the pop-ups, stacked at the bottom right ----------
let seen = null;
function stack() { let box = document.querySelector('.nt-stack'); if (!box) { box = document.createElement('div'); box.className = 'nt-stack'; box.setAttribute('aria-live', 'polite'); document.body.append(box); } return box; }
function popUp(ctx, item, more) {
  const { esc } = ctx, prefs = ctx.ui.snap.notices?.prefs || {}, [label, tone] = KIND[item.kind] || [t('Update'), 'reply'], name = who(item);
  const chat = item.target.type === 'room' ? (ctx.ui.snap.rooms || []).find(room => room.id === item.target.id)?.name : '';
  const canReply = ['room', 'run', 'main'].includes(item.target.type);
  const card = document.createElement('div'); card.className = `nt-pop ${tone}`; card.setAttribute('role', 'status');
  const open = `data-action="nt-open" data-key="${esc(item.key)}" data-type="${esc(item.target.type)}" data-id="${esc(item.target.id || '')}"`;
  card.innerHTML = `<div class="nt-pop-head">${avatarHtml(ctx, { name, size: 'sm' })}<span class="nt-pop-who"><b>${esc(name)}</b><small>${t`${esc([chat, label].filter(Boolean).join(' · '))} · now`}</small></span><button type="button" class="nt-pop-link" data-action="nt-read" data-key="${esc(item.key)}">${t`Mark read`}</button><button type="button" class="nt-pop-x" aria-label="${t`Dismiss`}" title="${t`Dismiss`}">×</button></div>
    <button type="button" class="nt-pop-body" ${open}>${prefs.preview === false ? `<em>${t`New message`}</em>` : esc(String(item.body).replace(/\*\*/g, '').replace(/\s+/g, ' '))}${more ? `<span class="nt-more">${t`+${more} more`}</span>` : ''}</button>
    <div class="nt-pop-row">${canReply ? `<form class="nt-reply" data-key="${esc(item.key)}" data-type="${esc(item.target.type)}" data-id="${esc(item.target.id || '')}"><input type="text" placeholder="${t`Reply…`}" aria-label="${t`Reply`}" maxlength="4000"><button type="submit" class="btn small primary">${t`Send`}</button></form>` : ''}<button type="button" class="btn small" ${open}>${t`Open`}</button></div>
    <i class="nt-life" aria-hidden="true"></i>`;
  const box = stack(); box.prepend(card); while (box.children.length > 3) box.lastElementChild.remove();
  let timer = 0; const arm = () => { clearTimeout(timer); timer = setTimeout(() => card.remove(), 8000); };
  card.addEventListener('mouseenter', () => clearTimeout(timer)); card.addEventListener('mouseleave', () => { if (!card.contains(document.activeElement)) arm(); });
  card.addEventListener('focusin', () => clearTimeout(timer));
  card.querySelector('.nt-pop-x').addEventListener('click', () => card.remove());
  card.querySelector('.nt-reply')?.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target, text = form.querySelector('input').value.trim(); if (!text) return;
    try {
      const type = form.dataset.type, id = form.dataset.id;
      if (type === 'room') await ctx.api(`/rooms/${id}/messages`, { method: 'POST', data: { text } });
      else { const runId = type === 'main' ? (ctx.ui.snap.runs || []).find(run => run.main)?.id : id; if (runId) await ctx.api(`/runs/${runId}/say`, { method: 'POST', data: { text } }); }
      await ctx.api('/notices/read', { method: 'POST', data: { key: form.dataset.key } }).catch(() => {});
      card.remove(); ctx.toast(t('Sent.')); await ctx.refresh();
    } catch (error) { ctx.toast(error.message, true); }
  });
  arm();
}
// The chats open in the split view's panes (each pane is an embedded page): the person is looking at them already.
function openInPanes() {
  const keys = new Set();
  for (const frame of document.querySelectorAll('.sp-frame')) {
    const hash = decodeURIComponent((frame.getAttribute('src') || '').split('#')[1] || ''), [, type, id] = hash.split('/');
    if (type === 'main') keys.add('main:'); else if (['run', 'room'].includes(type) && id) keys.add(`${type}:${id}`);
  }
  return keys;
}
// Voice mode is on screen somewhere in this window (its body writes this every few seconds): no pop-ups, no sounds.
const voiceOnScreen = () => { try { return Date.now() - Number(localStorage.getItem('rex-voice-live') || 0) < 5000; } catch { return false; } };
const embedded = new URLSearchParams(location.search).has('embed');
export function watchNotices(ctx) {
  const { ui } = ctx, recent = ui.snap?.notices?.recent || [], prefs = ui.snap?.notices?.prefs || {};
  drawPane(ctx); window.__rexNoticeSettingsRedraw?.();
  const key = noticeKey(ui.view); if (window.rexView !== key) { window.rexView = key; window.rexPresence?.(); }
  if (!seen) { seen = new Set(recent.map(item => item.id)); return; }
  const looking = openInPanes();
  const fresh = recent.filter(item => !seen.has(item.id) && item.alert && !item.read && item.key !== key && !looking.has(item.key));
  for (const item of recent) seen.add(item.id);
  // A pane of the split view is a page of its own: only the window around it pops up, once, not every pane.
  if (embedded || voiceOnScreen()) return;
  if (!fresh.length || prefs.inapp === false) return;
  popUp(ctx, fresh[0], fresh.length - 1);
  if (prefs.sound !== false) playTone(prefs.tone, fresh[0].kind, prefs.volume ?? 0.6);
}

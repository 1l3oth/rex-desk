import { t, locale } from './i18n.js';
// Phone notifications without ntfy (web push). Turned on from the phone itself: one button, the phone asks to allow, and a
// test notice comes back. The phone's own browser keeps the subscription; the desk saves it with the Rex Desk account, so
// every computer of the account can send to it. Permission is asked only right after the tap, never on load.

const PHONE_KEY = 'rex-webpush-phone';
const env = (w = globalThis) => {
  const nav = w.navigator || {}, ua = String(nav.userAgent || '');
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  return {
    phone: ios || /Android|Mobile/.test(ua), ios,
    standalone: Boolean(w.matchMedia?.('(display-mode: standalone)')?.matches || nav.standalone === true),
    secure: w.isSecureContext !== false, worker: 'serviceWorker' in nav, push: 'PushManager' in w, notices: 'Notification' in w,
    permission: 'Notification' in w ? w.Notification.permission : 'default',
  };
};

// What this device can do right now, before anything is asked. 'off' means the button can be pressed.
export function baseState(e, { signedIn = true } = {}) {
  if (!e.phone) return 'computer';
  if (!signedIn) return 'signed-out';
  if (e.ios && !e.standalone) return 'ios-home';
  if (!e.secure) return 'insecure';
  if (!e.worker || !e.push || !e.notices) return e.ios ? 'ios-old' : 'unsupported';
  if (e.permission === 'denied') return 'blocked';
  return 'off';
}

const state = { name: '', note: '', checked: false, key: '', busy: '' };
export const webPushState = state;

// Looks once at the phone (permission, its saved subscription) and asks its desk for the account's key.
export async function checkWebPush(ctx, w = globalThis) {
  if (state.checked) return; state.checked = true;
  const e = env(w);
  let info = { signedIn: true, publicKey: '' };
  if (e.phone) { try { info = await ctx.api('/notices/webpush'); } catch { info = { signedIn: true, publicKey: '' }; } }
  state.key = info.publicKey || '';
  state.name = baseState(e, info);
  if (state.name === 'off' && e.permission === 'granted') {
    try { const reg = await w.navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription(); if (sub && w.localStorage.getItem(PHONE_KEY)) state.name = 'on'; } catch { /* stays off */ }
  }
  // Removed from a computer, or pushed out by an 11th phone: the account no longer has it, so it is off here too.
  if (state.name === 'on') {
    await loadPhones(ctx);
    if (Array.isArray(list.phones) && !list.phones.some(phone => phone.id === w.localStorage.getItem(PHONE_KEY))) {
      w.localStorage.removeItem(PHONE_KEY); state.name = 'off'; state.note = t('This phone was removed from your phones, so it gets no notices. Press Turn on to get them again.');
    }
  }
  if (state.name === 'off' && !state.key && info.error) { state.name = 'error'; state.note = info.error; }
  ctx.redraw?.();
}

const keyBytes = text => { const plain = text.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(plain + '='.repeat((4 - plain.length % 4) % 4)); return Uint8Array.from(bin, ch => ch.charCodeAt(0)); };
const phoneName = (e, w) => (e.ios ? 'iPhone' : /Android/.test(w.navigator?.userAgent || '') ? 'Android phone' : 'Phone');

// The tap. Asking to allow comes first, straight from the tap, as iPhone requires.
export async function turnOnWebPush(ctx, w = globalThis) {
  const e = env(w), step = (busy, note = '') => { state.busy = busy; state.note = note; ctx.redraw?.(); };
  step('allow');
  let permission;
  try { permission = await w.Notification.requestPermission(); } catch { permission = w.Notification.permission; }
  if (permission === 'denied') { state.name = 'blocked'; return step(''); }
  if (permission !== 'granted') { state.name = 'off'; return step('', t('Notifications were not allowed. Press Turn on and choose Allow.')); }
  try {
    step('save');
    if (!state.key) { const info = await ctx.api('/notices/webpush'); if (!info.signedIn) { state.name = 'signed-out'; return step(''); } state.key = info.publicKey || ''; }
    if (!state.key) throw new Error(t('Rex Desk could not get ready to send notices. Try again in a minute.'));
    const reg = await w.navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.key) });
    const phone = await ctx.api('/notices/webpush/phone', { method: 'POST', data: { subscription: sub.toJSON(), name: phoneName(e, w) } });
    w.localStorage.setItem(PHONE_KEY, phone.id);
    step('test');
    await ctx.api('/notices/webpush/test', { method: 'POST', data: { phone: phone.id } });
    state.name = 'on'; step('', t('Test sent. It should arrive in a few seconds.'));
    void loadPhones(ctx);
  } catch (error) { state.name = 'error'; step('', error.message || t('Turning on did not work. Try again.')); }
}

export async function testWebPush(ctx, w = globalThis) {
  state.busy = 'test'; state.note = ''; ctx.redraw?.();
  try { await ctx.api('/notices/webpush/test', { method: 'POST', data: { phone: w.localStorage.getItem(PHONE_KEY) || '' } }); state.note = t('Test sent. It should arrive in a few seconds.'); }
  catch (error) { state.note = error.message; if (/no longer turned on/i.test(error.message)) { w.localStorage.removeItem(PHONE_KEY); state.name = 'off'; } }
  state.busy = ''; ctx.redraw?.();
}

// The row in Notifications settings. Each state says in plain words what is true and what to do.
export function webPushHtml(esc, deskError = '', w = globalThis) {
  const e = env(w), s = state.name || 'off', busy = state.busy;
  const button = (action, label) => `<button type="button" class="btn small${action === 'nt-wp-on' ? ' primary' : ''}" data-action="${action}" ${busy ? 'disabled' : ''}>${label}</button>`;
  const busyLabel = { allow: t('Waiting for Allow…'), save: t('Turning on…'), test: t('Sending a test…') }[busy];
  const lines = {
    computer: [t('Turned on from your phone'), t('Open Rex Desk on your phone, then Settings, Notifications, and press Turn on.')],
    'signed-out': [t('Sign in to Rex Desk to get phone notifications.'), t('The ntfy app under Other ways still works without signing in.')],
    'ios-home': [t('Add Rex Desk to your Home Screen first'), t('On iPhone, notifications work only in the Rex Desk app on the Home Screen.')],
    insecure: [t('Needs a secure address'), t('Open Rex Desk on this phone through your Rex Desk link (https), then turn this on.')],
    'ios-old': [t('Needs iOS 16.4 or later'), t('Update the iPhone, or use the ntfy app under Other ways.')],
    unsupported: [t('This browser cannot show Rex Desk notifications'), t('Use the ntfy app under Other ways.')],
    blocked: [t('Notifications are blocked for Rex Desk'), e.ios ? t('Open iPhone Settings, Notifications, Rex Desk, and turn on Allow Notifications. Then press Check again.') : t('Tap the lock next to the address, then Permissions, Notifications, Allow. In the installed app: hold its icon, App info, Notifications. Then press Check again.')],
    off: [t('Notifications on this phone'), t('Get a notice when an agent replies or needs you. Tap it to open the chat.')],
    on: [t('On for this phone'), t('You get a notice when an agent replies or needs you. Tap it to open the chat.')],
    error: [t('Not turned on'), ''],
  }[s] || ['', ''];
  const action = busy ? `<button type="button" class="btn small" disabled>${busyLabel}</button>`
    : s === 'off' ? button('nt-wp-on', t('Turn on')) : s === 'on' ? button('nt-wp-test', t('Send a test')) : s === 'error' ? button('nt-wp-on', t('Try again')) : s === 'blocked' ? button('nt-wp-check', t('Check again')) : '';
  const steps = s === 'ios-home' ? `<ol class="nt-steps nt-wp-steps"><li>${t`Tap the Share button in Safari.`}</li><li>${t`Tap Add to Home Screen, then Add.`}</li><li>${t`Open Rex Desk from the Home Screen and come back here.`}</li></ol>` : '';
  const note = state.note ? `<p class="small ${s === 'error' ? 'warn-text' : 'muted'} nt-wp-note" role="status">${esc(state.note)}</p>` : '';
  const desk = deskError && s !== 'signed-out' ? `<p class="small warn-text nt-wp-note">${esc(deskError)}</p>` : '';
  return `<div class="nt-wp" data-wp-state="${s}"><div class="nt-wp-row"><span class="nt-lbl"><b>${lines[0]}</b>${lines[1] ? `<small>${lines[1]}</small>` : ''}</span>${action}</div>${steps}${note}${desk}</div>`;
}

// ---------- the account's phones: which ones get notices, and Remove ----------
// Shown on every device signed in to the account, so a lost or old phone can be cut off from any computer.
const list = { phones: null, asked: false, signedIn: true, loading: false, error: '', removing: '', note: '', noteBad: false };
export const webPushList = list;

let loading = null;
export function loadPhones(ctx) { list.asked = true; loading ??= readPhones(ctx).finally(() => { loading = null; }); return loading; }
async function readPhones(ctx) {
  list.loading = true; ctx.redraw?.();
  try {
    const out = await ctx.api('/notices/webpush/phones');
    list.signedIn = out?.signedIn !== false; list.phones = Array.isArray(out?.phones) ? out.phones : null;
    list.error = list.phones || !list.signedIn ? '' : (out?.error || t('Rex Desk could not load your phones.'));
  } catch (error) { list.phones = null; list.error = error.message || t('Rex Desk could not load your phones.'); }
  list.loading = false; ctx.redraw?.();
}

const thisPhone = w => { try { return w.localStorage?.getItem(PHONE_KEY) || ''; } catch { return ''; } };
async function subscriptionOf(w) { const reg = await w.navigator?.serviceWorker?.getRegistration?.(); return (await reg?.pushManager?.getSubscription()) || null; }
async function dropSubscription(w) {
  try { const sub = await subscriptionOf(w); if (!sub) return true; return (await sub.unsubscribe()) !== false; } catch { return false; }
}

// Remove, after the person said yes. The list shows the account's real answer, never a success that did not happen.
export async function removePhone(ctx, id, w = globalThis) {
  list.removing = id; list.note = ''; ctx.redraw?.();
  try {
    await ctx.api(`/notices/webpush/phones/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (id === thisPhone(w)) { w.localStorage.removeItem(PHONE_KEY); await dropSubscription(w); state.name = 'off'; state.note = t('Turned off for this phone. Press Turn on to get notices again.'); }
    list.removing = ''; list.note = t('Removed. That phone gets no more notices.'); list.noteBad = false;
    await loadPhones(ctx);
  } catch (error) { list.removing = ''; list.note = error.message || t('The phone was not removed. Try again.'); list.noteBad = true; ctx.redraw?.(); }
}

const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
// Every sign-out on a phone comes here first: the phone's entry is taken off the account and the phone itself stops
// listening, so the next person holding it reads no agent messages. Offline or failing, the phone still stops listening
// and the sign-out goes on; the answer says plainly what is left. api is null when the desk already signed this phone out.
export async function signOutPhone(api, w = globalThis) {
  const id = thisPhone(w);
  let sub = null; try { sub = await subscriptionOf(w); } catch { /* none */ }
  if (!id && !sub) return { left: '', removed: true, stopped: true };
  let removed = !id;
  if (id && api) { try { await within(api(`/notices/webpush/phones/${encodeURIComponent(id)}`, { method: 'DELETE' }), 6000); removed = true; } catch { removed = false; } }
  const stopped = await dropSubscription(w);
  try { w.localStorage.removeItem(PHONE_KEY); } catch { /* private mode */ }
  Object.assign(state, { name: '', note: '', checked: false, busy: '' }); list.phones = null;
  const left = stopped && removed ? ''
    : stopped ? t('This phone no longer gets Rex Desk notices. It may still be listed under your phones until the next notice clears it, or remove it in Settings, Notifications on a computer.')
      : t('This phone may still get Rex Desk notices. Remove it in Settings, Notifications on a computer, or turn off notifications for Rex Desk in the phone settings.');
  if (left) { try { w.sessionStorage?.setItem('rex-signout-note', left); } catch { /* private mode */ } }
  return { left, removed, stopped };
}

const added = iso => {
  const at = new Date(iso); if (!iso || Number.isNaN(at.getTime())) return '';
  try { return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(at); } catch { return at.toISOString().slice(0, 10); }
};

// The list under the Turn on row: name, when it was added, "This phone" on the one in hand, and Remove.
export function phonesHtml(esc, w = globalThis) {
  const s = state.name;
  if (s === 'signed-out') return '';
  if (!list.signedIn) return `<div class="nt-wp-list"><p class="small muted nt-wp-empty">${t`Sign in to Rex Desk to see the phones that get notices.`}</p></div>`;
  const head = `<p class="nt-wp-head">${t`Phones that get notices`}</p>`;
  const note = list.note ? `<p class="small ${list.noteBad ? 'warn-text' : 'muted'} nt-wp-note" role="status">${esc(list.note)}</p>` : '';
  if (!list.phones) {
    const body = list.error && !list.loading
      ? `<div class="nt-wp-row"><span class="nt-lbl"><small class="warn-text">${t`Could not load your phones: ${esc(list.error)}`}</small></span><button type="button" class="btn small" data-action="nt-wp-list">${t`Try again`}</button></div>`
      : `<p class="small muted nt-wp-empty" role="status">${t`Looking up your phones…`}</p>`;
    return `<div class="nt-wp-list">${head}${body}${note}</div>`;
  }
  if (!list.phones.length) return `<div class="nt-wp-list">${head}<p class="small muted nt-wp-empty">${t`No phone gets notices yet. Turn them on from Rex Desk on the phone.`}</p>${note}</div>`;
  const mine = thisPhone(w);
  const rows = list.phones.map(phone => {
    const busy = list.removing === phone.id, when = added(phone.created);
    return `<li class="nt-wp-phone" data-phone="${esc(phone.id)}"><span class="nt-lbl"><b>${esc(phone.name)}${phone.id === mine ? ` <span class="nt-wp-me">${t`This phone`}</span>` : ''}</b>${when ? `<small>${t`Added ${esc(when)}`}</small>` : ''}</span><button type="button" class="btn small quiet danger" data-action="nt-wp-remove" data-id="${esc(phone.id)}" data-name="${esc(phone.name)}" ${list.removing ? 'disabled' : ''}>${busy ? t('Removing…') : t('Remove')}</button></li>`;
  }).join('');
  return `<div class="nt-wp-list">${head}<ul class="nt-wp-phones">${rows}</ul>${note}</div>`;
}

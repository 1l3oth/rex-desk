// Install Rex Desk on a phone: a short animated guide that shows each tap on a small drawn phone, step by step.
// iPhone has no install button for web apps, so it shows Share, Add to Home Screen, Add. Android Chrome gets a real
// Install button when the browser offers one, and the menu steps when it does not.
// It opens by itself once on a phone browser that has not installed Rex Desk, and showInstallGuide() opens it again.
import { t } from './i18n.js';

const SEEN = 'rex-install-guide-seen';
let offer = null;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); offer = event; document.querySelector('.ig')?.dispatchEvent(new Event('ig-offer')); });
window.addEventListener('appinstalled', () => { offer = null; closeGuide(); });

export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export function phoneKind(agent = navigator.userAgent, touch = navigator.maxTouchPoints || 0) {
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && touch > 1)) return 'ios';
  if (/Android/.test(agent)) return 'android';
  return '';
}

const ICONS = {
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4M6 11v9h12v-9"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V4h12"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  tabs: '<svg viewBox="0 0 24 24"><rect x="4" y="7" width="12" height="13" rx="2"/><path d="M8 4h12v12"/></svg>',
  install: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const APP = '<img src="/icon-192.png" alt="">';
const lines = n => Array.from({ length: n }, (_, i) => `<i style="width:${[86, 64, 78, 52, 70][i % 5]}%"></i>`).join('');
const page = `<div class="ig-page">${lines(5)}</div>`;
const home = () => `<div class="ig-scene ig-home"><div class="ig-grid">${'<span></span>'.repeat(7)}<span class="ig-new">${APP}<b>Rex Desk</b></span></div></div>`;

// The address the phone has open, as the drawings show it (none when there is none).
const here = () => esc(location.host || '');
const esc = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const card = () => `<div class="ig-card">${APP}<div><b>Rex Desk</b>${here() ? `<small>${here()}</small>` : ''}</div></div>`;
// A page on plain http (not this computer) cannot be installed as an app: the browser makes a shortcut, which opens in the
// browser and needs a connection to the computer running Rex Desk.
export const secureHere = () => window.isSecureContext !== false;
// What the home screen icon opens. app: an installed web app (full screen). Otherwise a shortcut: on Android it opens in Chrome;
// on an iPhone over plain http Safari decides, so only the connection is promised.
const opened = (kind, secure, app) => app ? t('Open Rex Desk from your home screen. It opens full screen, like an app.')
  : kind === 'ios' ? t('Open Rex Desk from your home screen. It is a shortcut to this page and needs a connection to your computer.')
  : secure ? t('Open Rex Desk from your home screen. It is a shortcut, so it opens in Chrome.')
  : t('Open Rex Desk from your home screen. It is a shortcut to this page, so it opens in the browser and needs a connection to your computer.');

// Each step: what to do, and the drawn screen. .ig-tap marks where the finger goes. alt: a second way the phone may show,
// with a button that follows it (go: the step it jumps to; shortcut: Android's Create shortcut path).
// iPhone (Safari, iOS 26 and later): the compact bar hides Share behind More; the bottom and top bars show Share directly.
// Open as Web App shows only for some pages, so it is named as "if you see it", and not drawn on plain http.
// Android (Chrome): Add to home screen (or Install app, or Install and create shortcut), then Install (an app that opens in its
// own window) or Create shortcut (opens in Chrome; the only choice on plain http).
const STEPS = {
  ios: secure => [
    { say: t('Tap More (•••) at the bottom of Safari. If you see Share in the bar at the bottom or top instead, tap Share, then tap I tapped Share below.'), alt: { label: t('I tapped Share'), go: 2 }, scene: `<div class="ig-scene ig-ios-more">${page}<div class="ig-bar ig-bottom">${ICONS.back}<span class="ig-url">${here()}</span><span class="ig-tap">${ICONS.more}</span></div></div>` },
    { say: t('Tap Share.'), scene: `<div class="ig-scene ig-ios-menu">${page}<div class="ig-menu ig-menu-low"><div class="ig-row">${ICONS.book}<span>${t('Bookmarks')}</span></div><div class="ig-row ig-tap ig-pick">${ICONS.share}<span>${t('Share')}</span></div></div><div class="ig-bar ig-bottom">${ICONS.back}<span class="ig-url">${here()}</span>${ICONS.more}</div></div>` },
    { say: t('Scroll down and tap Add to Home Screen.'), scene: `<div class="ig-scene ig-ios-sheet">${page}<div class="ig-sheet"><div class="ig-row">${ICONS.copy}<span>${t('Copy')}</span></div><div class="ig-row">${ICONS.book}<span>${t('Add to Reading List')}</span></div><div class="ig-row ig-tap ig-pick">${ICONS.plus}<span>${t('Add to Home Screen')}</span></div></div></div>` },
    secure
      ? { say: t('If you see Open as Web App, leave it on. Then tap Add at the top right.'), scene: `<div class="ig-scene ig-ios-add"><div class="ig-head"><span>${t('Cancel')}</span><b>${t('Add to Home Screen')}</b><span class="ig-tap ig-link">${t('Add')}</span></div>${card()}<div class="ig-toggle"><span>${t('Open as Web App')}</span><i class="on"></i></div></div>` }
      : { say: t('Tap Add at the top right.'), scene: `<div class="ig-scene ig-ios-add"><div class="ig-head"><span>${t('Cancel')}</span><b>${t('Add to Home Screen')}</b><span class="ig-tap ig-link">${t('Add')}</span></div>${card()}</div>` },
    { say: opened('ios', secure, secure), scene: home() },
  ],
  android: (secure, shortcut) => {
    const app = secure && !shortcut;
    const add = { say: t('Tap Create shortcut. It opens Rex Desk in Chrome.'), scene: `<div class="ig-scene ig-and-install">${page}<div class="ig-dialog"><b>${t('Add to home screen')}</b><div class="ig-choice ig-tap ig-pick">${ICONS.plus}<span>${t('Create shortcut')}</span></div></div></div>` };
    return [
      { say: t('Tap the menu (⋮) at the top right of Chrome.'), scene: `<div class="ig-scene ig-and-menu"><div class="ig-bar ig-top"><span class="ig-url">${here()}</span><span class="ig-tap">${ICONS.dots}</span></div>${page}</div>` },
      { say: app ? t('Tap Add to home screen. If the menu shows Install app or Install and create shortcut instead, tap that, then tap I tapped Install below.') : t('Tap Add to home screen.'), ...(app ? { alt: { label: t('I tapped Install'), go: 3 } } : {}),
        scene: `<div class="ig-scene ig-and-list"><div class="ig-bar ig-top"><span class="ig-url">${here()}</span>${ICONS.dots}</div>${page}<div class="ig-menu"><div class="ig-row">${ICONS.tabs}<span>${t('New tab')}</span></div><div class="ig-row">${ICONS.book}<span>${t('Bookmarks')}</span></div><div class="ig-row ig-tap ig-pick">${ICONS.install}<span>${t('Add to home screen')}</span></div></div></div>` },
      app
        ? { say: t('Tap Install. It adds Rex Desk as an app that opens in its own window. If there is no Install, tap Create shortcut instead.'), alt: { label: t('I tapped Create shortcut'), shortcut: true, go: 3 }, scene: `<div class="ig-scene ig-and-install">${page}<div class="ig-dialog"><b>${t('Add to home screen')}</b><div class="ig-choice ig-tap ig-pick">${ICONS.install}<span>${t('Install')}</span></div><div class="ig-choice">${ICONS.plus}<span>${t('Create shortcut')}</span></div></div></div>` }
        : add,
      app
        ? { say: t('Tap Install again to confirm.'), scene: `<div class="ig-scene ig-and-install">${page}<div class="ig-dialog"><b>${t('Install app?')}</b>${card()}<div class="ig-acts"><span>${t('Cancel')}</span><span class="ig-tap ig-link">${t('Install')}</span></div></div></div>` }
        : { say: t('Tap Add.'), scene: `<div class="ig-scene ig-and-install">${page}<div class="ig-dialog"><b>${t('Add to home screen')}</b>${card()}<div class="ig-acts"><span>${t('Cancel')}</span><span class="ig-tap ig-link">${t('Add')}</span></div></div></div>` },
      { say: opened('android', secure, app), scene: home() },
    ];
  },
};

export function closeGuide() {
  const root = document.querySelector('.ig'); if (!root) return;
  root.classList.add('ig-out'); setTimeout(() => root.remove(), 220);
}

export function showInstallGuide({ kind = phoneKind() || 'ios', secure = secureHere() } = {}) {
  document.querySelector('.ig')?.remove();
  try { localStorage.setItem(SEEN, '1'); } catch { /* private window */ }
  const state = { kind, step: 0, shortcut: false };
  const root = document.createElement('div'); root.className = 'ig'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', t('Install Rex Desk'));
  document.body.append(root);
  const draw = () => {
    const steps = STEPS[state.kind](secure, state.shortcut); const step = steps[state.step]; const last = state.step === steps.length - 1;
    const quick = state.kind === 'android' && secure && offer;
    root.innerHTML = `<div class="ig-box">
      <div class="ig-top-row"><b class="ig-title">${t('Install Rex Desk')}</b><button class="ig-x" data-ig="close" aria-label="${t('Close')}">${ICONS.close}</button></div>
      <div class="ig-seg" role="tablist">${[['ios', 'iPhone'], ['android', 'Android']].map(([key, label]) => `<button role="tab" aria-selected="${state.kind === key}" class="${state.kind === key ? 'on' : ''}" data-ig="kind" data-kind="${key}">${label}</button>`).join('')}</div>
      ${quick ? `<button class="ig-quick" data-ig="install">${ICONS.install}${t('Install now')}</button>` : ''}
      <div class="ig-stage"><div class="ig-phone">${step.scene}<span class="ig-finger" aria-hidden="true"></span></div></div>
      <div class="ig-step" aria-live="polite"><small>${t`Step ${state.step + 1} of ${steps.length}`}</small><p>${step.say}</p>${step.alt ? `<button class="ig-alt" data-ig="go">${step.alt.label}</button>` : ''}</div>
      <div class="ig-foot"><div class="ig-dots">${steps.map((_, i) => `<i class="${i === state.step ? 'on' : i < state.step ? 'done' : ''}"></i>`).join('')}</div>
        <div class="ig-btns">${state.step ? `<button class="btn small" data-ig="back">${t('Back')}</button>` : ''}<button class="btn small primary" data-ig="${last ? 'close' : 'next'}">${last ? t('Done') : t('Next')}</button></div></div>
    </div>`;
    place();
  };
  // The finger starts low and travels to whatever this step taps, so it follows the drawing on any screen size.
  const place = () => requestAnimationFrame(() => {
    const phone = root.querySelector('.ig-phone'); const target = root.querySelector('.ig-tap'); const finger = root.querySelector('.ig-finger');
    if (!phone || !finger) return;
    if (!target) { finger.hidden = true; return; }
    // Layout offsets, not on-screen boxes: the menu or sheet may be mid-animation (scaled or slid) when this runs.
    let x = target.offsetWidth / 2; let y = target.offsetHeight / 2;
    for (let node = target; node && node !== phone; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; }
    finger.style.setProperty('--x', `${x}px`); finger.style.setProperty('--y', `${y}px`);
  });
  root.addEventListener('ig-offer', draw);
  root.addEventListener('click', async event => {
    if (event.target === root) return closeGuide();
    const act = event.target.closest('[data-ig]')?.dataset.ig; if (!act) return;
    if (act === 'close') closeGuide();
    else if (act === 'next') { state.step++; draw(); }
    else if (act === 'go') { const alt = STEPS[state.kind](secure, state.shortcut)[state.step].alt; if (alt.shortcut) state.shortcut = true; state.step = alt.go; draw(); }
    else if (act === 'back') { state.step = Math.max(0, state.step - 1); if (state.step < 3) state.shortcut = false; draw(); }
    else if (act === 'kind') { state.kind = event.target.closest('[data-kind]').dataset.kind; state.step = 0; state.shortcut = false; draw(); }
    else if (act === 'install' && offer) { const asked = offer; offer = null; await asked.prompt(); const { outcome } = await asked.userChoice; if (outcome === 'accepted') closeGuide(); else draw(); }
  });
  root.addEventListener('keydown', event => { if (event.key === 'Escape') closeGuide(); });
  draw();
  root.querySelector('[data-ig="next"]')?.focus({ preventScroll: true });
  return root;
}

// Once, on a phone browser where Rex Desk is not installed, after the first screen has settled. The app calls this on every
// refresh, so one plan waits at a time; while the tour, a dialog or the New computer card (naming this computer) is open it
// waits, and a later refresh plans it again.
let planned = false;
export function maybeInstallGuide({ delay = 4000 } = {}) {
  if (planned || installed() || !phoneKind() || document.querySelector('[data-newpc]')) return;
  try { if (localStorage.getItem(SEEN)) return; } catch { return; }
  planned = true;
  setTimeout(() => { planned = false; if (!installed() && !document.querySelector('.tour-back, .dialog-back, [data-newpc], .ig')) showInstallGuide(); }, delay);
}

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

// Each step: what to do, and the drawn screen. .ig-tap marks where the finger goes.
const STEPS = {
  ios: () => [
    { say: t('Tap the Share button at the bottom of Safari.'), scene: `<div class="ig-scene ig-ios-share">${page}<div class="ig-bar ig-bottom">${ICONS.back}${ICONS.fwd}<span class="ig-tap">${ICONS.share}</span>${ICONS.book}${ICONS.tabs}</div></div>` },
    { say: t('Scroll down and tap Add to Home Screen.'), scene: `<div class="ig-scene ig-ios-sheet">${page}<div class="ig-sheet"><div class="ig-row">${ICONS.copy}<span>${t('Copy')}</span></div><div class="ig-row">${ICONS.book}<span>${t('Add to Reading List')}</span></div><div class="ig-row ig-tap ig-pick">${ICONS.plus}<span>${t('Add to Home Screen')}</span></div></div></div>` },
    { say: t('Tap Add at the top right.'), scene: `<div class="ig-scene ig-ios-add"><div class="ig-head"><span>${t('Cancel')}</span><b>${t('Add to Home Screen')}</b><span class="ig-tap ig-link">${t('Add')}</span></div><div class="ig-card">${APP}<div><b>Rex Desk</b><small>app.rexdesk.dev</small></div></div></div>` },
    { say: t('Open Rex Desk from your home screen. It opens full screen, like an app.'), scene: home() },
  ],
  android: () => [
    { say: t('Tap the menu at the top right of Chrome.'), scene: `<div class="ig-scene ig-and-menu"><div class="ig-bar ig-top"><span class="ig-url">app.rexdesk.dev</span><span class="ig-tap">${ICONS.dots}</span></div>${page}</div>` },
    { say: t('Tap Install app. Some phones call it Add to Home screen.'), scene: `<div class="ig-scene ig-and-list"><div class="ig-bar ig-top"><span class="ig-url">app.rexdesk.dev</span>${ICONS.dots}</div>${page}<div class="ig-menu"><div class="ig-row">${ICONS.tabs}<span>${t('New tab')}</span></div><div class="ig-row">${ICONS.book}<span>${t('Bookmarks')}</span></div><div class="ig-row ig-tap ig-pick">${ICONS.install}<span>${t('Install app')}</span></div></div></div>` },
    { say: t('Tap Install.'), scene: `<div class="ig-scene ig-and-install">${page}<div class="ig-dialog"><b>${t('Install app?')}</b><div class="ig-card">${APP}<div><b>Rex Desk</b><small>app.rexdesk.dev</small></div></div><div class="ig-acts"><span>${t('Cancel')}</span><span class="ig-tap ig-link">${t('Install')}</span></div></div></div>` },
    { say: t('Open Rex Desk from your home screen. It opens full screen, like an app.'), scene: home() },
  ],
};

export function closeGuide() {
  const root = document.querySelector('.ig'); if (!root) return;
  root.classList.add('ig-out'); setTimeout(() => root.remove(), 220);
}

export function showInstallGuide({ kind = phoneKind() || 'ios' } = {}) {
  document.querySelector('.ig')?.remove();
  try { localStorage.setItem(SEEN, '1'); } catch { /* private window */ }
  const state = { kind, step: 0 };
  const root = document.createElement('div'); root.className = 'ig'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', t('Install Rex Desk'));
  document.body.append(root);
  const draw = () => {
    const steps = STEPS[state.kind](); const step = steps[state.step]; const last = state.step === steps.length - 1;
    const quick = state.kind === 'android' && offer;
    root.innerHTML = `<div class="ig-box">
      <div class="ig-top-row"><b class="ig-title">${t('Install Rex Desk')}</b><button class="ig-x" data-ig="close" aria-label="${t('Close')}">${ICONS.close}</button></div>
      <div class="ig-seg" role="tablist">${[['ios', 'iPhone'], ['android', 'Android']].map(([key, label]) => `<button role="tab" aria-selected="${state.kind === key}" class="${state.kind === key ? 'on' : ''}" data-ig="kind" data-kind="${key}">${label}</button>`).join('')}</div>
      ${quick ? `<button class="ig-quick" data-ig="install">${ICONS.install}${t('Install now')}</button>` : ''}
      <div class="ig-stage"><div class="ig-phone">${step.scene}<span class="ig-finger" aria-hidden="true"></span></div></div>
      <div class="ig-step" aria-live="polite"><small>${t`Step ${state.step + 1} of ${steps.length}`}</small><p>${step.say}</p></div>
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
    else if (act === 'back') { state.step = Math.max(0, state.step - 1); draw(); }
    else if (act === 'kind') { state.kind = event.target.closest('[data-kind]').dataset.kind; state.step = 0; draw(); }
    else if (act === 'install' && offer) { const asked = offer; offer = null; await asked.prompt(); const { outcome } = await asked.userChoice; if (outcome === 'accepted') closeGuide(); else draw(); }
  });
  root.addEventListener('keydown', event => { if (event.key === 'Escape') closeGuide(); });
  draw();
  root.querySelector('[data-ig="next"]')?.focus({ preventScroll: true });
  return root;
}

// Once, on a phone browser where Rex Desk is not installed, after the first screen has settled. The app calls this on every
// refresh, so one plan waits at a time; while the tour or a dialog is open it waits, and a later refresh plans it again.
let planned = false;
export function maybeInstallGuide({ delay = 4000 } = {}) {
  if (planned || installed() || !phoneKind()) return;
  try { if (localStorage.getItem(SEEN)) return; } catch { return; }
  planned = true;
  setTimeout(() => { planned = false; if (!installed() && !document.querySelector('.tour-back, .dialog-back, .ig')) showInstallGuide(); }, delay);
}

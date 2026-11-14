// "Like Rex Desk?" card asking for a star on GitHub. It stays out of the way: only after a month of use, only once Rex Desk
// has been open (and in view) for 2 hours that day, at most once a day. Star on GitHub opens the repo and the card never
// comes back; Later waits a week; × waits 3 days. Kept on this computer.
import { SOCIAL } from '/social-icons.js';

const KEY = 'rex-desk-star', REPO = 'https://github.com/1l3oth/rex-desk';
const DAY = 86400000, MONTH = 30 * DAY, OPEN_FOR = 2 * 3600000, TICK = 60000;
const today = () => new Date().toLocaleDateString('en-CA');
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const write = value => { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* private window */ } };

export function due(state = read(), now = Date.now()) {
  if (state.starred || !state.firstSeen) return false;
  return now - state.firstSeen >= MONTH && state.day === today() && (state.openMs || 0) >= OPEN_FOR && now >= (state.snoozeUntil || 0) && state.shownDay !== today();
}

function show() {
  if (document.getElementById('star-card')) return;
  const state = read(); write({ ...state, shownDay: today() });
  const github = SOCIAL.github;
  const card = document.createElement('aside'); card.id = 'star-card'; card.setAttribute('role', 'region'); card.setAttribute('aria-label', 'Support Rex Desk');
  card.innerHTML = `<button type="button" class="sc-x" data-star="close" aria-label="Not now">×</button>
    <div class="sc-head"><span class="sc-mark"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${github.path}" fill="currentColor"/></svg></span><b>Like Rex Desk?</b></div>
    <p>A star on GitHub helps more people find it, and keeps it free and open source.</p>
    <div class="sc-acts"><button type="button" class="btn quiet" data-star="later">Later</button><button type="button" class="btn primary" data-star="star"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/></svg> Star on GitHub</button></div>`;
  card.addEventListener('click', event => {
    const act = event.target.closest('[data-star]')?.dataset.star; if (!act) return;
    const now = Date.now(), current = read();
    if (act === 'star') { window.open(REPO, '_blank', 'noopener'); write({ ...current, starred: true }); }
    else write({ ...current, snoozeUntil: now + (act === 'later' ? 7 : 3) * DAY });
    card.remove();
  });
  document.body.append(card);
}

// Counts the minutes Rex Desk is open and in view, per day, and shows the card when it is due.
export function watchForStar() {
  const start = read(); if (!start.firstSeen) write({ ...start, firstSeen: Date.now() });
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    const state = read(), day = today();
    write({ ...state, day, openMs: (state.day === day ? state.openMs || 0 : 0) + TICK });
    if (due()) show();
  };
  setInterval(tick, TICK);
  if (due()) show();
}
// For trying it: window.rexShowStar() shows the card now.
window.rexShowStar = show;

import { t } from './i18n.js';
// See-through window: how solid the desktop window is, so what is behind it shows through (privacy, or keeping an eye on
// another app). Drag left for more see-through, right for solid; the window changes while dragging, and the value is saved
// on release on this computer and put back when Rex Desk opens again. Never below 20%, so the window never disappears.
// Ctrl+Shift+0, or the tray item "Make the window solid", makes it solid at once. Windows desktop app only.
export const LEAST = 20;
const KEY = 'rex-solid';
export const seeThroughHere = () => window.__REX_SHELL === 'windows' && !document.documentElement.classList.contains('embed');
const clean = value => Math.max(LEAST, Math.min(100, Math.round(Number(value) || 100)));
export const savedSolid = () => { try { return clean(localStorage.getItem(KEY) ?? 100); } catch { return 100; } };

let pending = null, sent = null;
// Asks the window to change, at most once a frame while the slider moves.
function apply(value) {
  pending = clean(value);
  if (sent !== null) return;
  sent = requestAnimationFrame(() => { sent = null; window.open(`https://rexdesk.window/solid?v=${pending}`, '_blank'); });
}
function save(value) { try { localStorage.setItem(KEY, String(clean(value))); } catch { /* private mode */ } }
function showAll(value) {
  for (const slider of document.querySelectorAll('[data-solid]')) { slider.value = String(value); slider.closest('[data-solid-box]')?.style.setProperty('--solid', `${value}%`); }
  for (const label of document.querySelectorAll('[data-solid-value]')) label.textContent = value >= 100 ? t('Solid') : `${value}%`;
}
export function setSolid(value, { keep = true } = {}) { const solid = clean(value); apply(solid); if (keep) save(solid); showAll(solid); return solid; }

// A slider, for the window bar (compact) or Settings.
export function solidSlider({ compact = false } = {}) {
  const value = savedSolid();
  return `<span class="solid-box${compact ? ' compact' : ''}" data-solid-box style="--solid:${value}%"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>`
    + `<input type="range" min="${LEAST}" max="100" step="1" value="${value}" data-solid aria-label="${t`How solid the window is`}" title="${t`See-through window: left shows more of what is behind it`}">`
    + `${compact ? '' : `<output data-solid-value>${value >= 100 ? t('Solid') : `${value}%`}</output>`}</span>`;
}

let wired = false;
export function wireSeeThrough() {
  if (wired || !seeThroughHere()) return; wired = true;
  // Opening Rex Desk again puts back the last saved value.
  const start = savedSolid(); if (start < 100) apply(start);
  document.addEventListener('input', event => { if (event.target.matches?.('[data-solid]')) { const value = clean(event.target.value); apply(value); showAll(value); } });
  document.addEventListener('change', event => { if (event.target.matches?.('[data-solid]')) save(event.target.value); });
  document.addEventListener('click', event => { if (event.target.closest?.('[data-solid-reset]')) setSolid(100); });
  document.addEventListener('keydown', event => { if (event.ctrlKey && event.shiftKey && (event.key === '0' || event.code === 'Digit0')) { event.preventDefault(); setSolid(100); } });
  // The tray item made it solid: the slider and the saved value follow.
  window.__rexSolid = value => { save(value); showAll(clean(value)); };
}

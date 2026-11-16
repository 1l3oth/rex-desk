import { t } from './i18n.js';
// The desktop app's own window bar. Windows: no system title bar, so Rex Desk draws minimize, maximize and close in glass.
// Mac: the three dots stay where they are, over the left end of the same bar. In a plain browser nothing is added.
// A button asks the app by opening https://rexdesk.window/<action>; the app does it and no window opens.
// Every page the desktop window shows uses it (the app, the sign-in page), so the window can always be moved and closed.
export const windowShell = () => document.documentElement.classList.contains('embed') ? '' : (window.__REX_SHELL || '');

export function windowBar(middle = '<span class="win-fill"></span>') {
  const shell = windowShell();
  if (shell !== 'windows' && shell !== 'macos') return null;
  const ask = action => { window.open(`https://rexdesk.window/${action}`, '_blank'); };
  const bar = document.createElement('div');
  bar.className = `win-bar ${shell}`; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', t('Window'));
  // The Rex Desk name sits in the window bar, where a window's title belongs.
  const brand = `<span class="win-brand"><img src="/favicon.svg" alt="" width="20" height="20"><b>${t`Rex Desk`}</b></span>`;
  bar.innerHTML = shell === 'windows' ? `${brand}${middle}
    <button type="button" class="win-btn" data-win="minimize" aria-label="${t`Minimize`}" title="${t`Minimize`}"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.5h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
    <button type="button" class="win-btn" data-win="maximize" aria-label="${t`Maximize or restore`}" title="${t`Maximize`}"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></button>
    <button type="button" class="win-btn close" data-win="close" aria-label="${t`Close`}" title="${t`Close (Rex Desk keeps running in the tray)`}"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`
    : `${brand}${middle}`;
  document.documentElement.classList.add('has-win-bar', `shell-${shell}`);
  document.body.prepend(bar);
  bar.addEventListener('click', event => { const button = event.target.closest('[data-win]'); if (button) ask(button.dataset.win); });
  // Dragging the empty bar moves the window; a double click maximizes or restores it.
  bar.addEventListener('mousedown', event => { if (event.button === 0 && !event.target.closest('button') && event.detail === 1) ask('drag'); });
  bar.addEventListener('dblclick', event => { if (!event.target.closest('button')) ask('maximize'); });
  return bar;
}

import { t } from './i18n.js';
// The app's own "Are you sure?" box. The browser's confirm() returns false at once in the macOS app (Tauri's WKWebView), so
// nothing that asked first could ever happen there. This one looks like a settings sheet: the question, then Cancel and the
// action, Enter presses the focused button (the action at first) and Esc cancels. A question that deletes or stops something gets a red action button.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const RISKY = /^(?:delete|remove|clear|end|unsend|throw away|stop|sign (?:this computer )?out|keep .* out of)\b/i;

export function askConfirm(message, { ok = '', danger = RISKY.test(String(message).trim()) } = {}) {
  const [title, ...rest] = String(message).split(/\n\s*\n/);
  return new Promise(resolve => {
    const back = document.createElement('div'), before = document.activeElement;
    back.className = 'dialog-back confirm-back';
    back.innerHTML = `<div class="dialog confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <p id="confirm-title" class="confirm-text">${esc(title)}</p>${rest.length ? `<p class="confirm-more">${esc(rest.join('\n\n'))}</p>` : ''}
      <div class="confirm-foot"><button type="button" class="btn" data-confirm="no">${t`Cancel`}</button><button type="button" class="btn primary${danger ? ' danger-fill' : ''}" data-confirm="yes">${esc(ok || t('OK'))}</button></div></div>`;
    const done = answer => { back.remove(); document.removeEventListener('keydown', key, true); before?.focus?.(); resolve(answer); };
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(false); }
      else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); done(document.activeElement?.dataset?.confirm !== 'no'); }
      else if (event.key === 'Tab') { const buttons = [...back.querySelectorAll('button')], at = buttons.indexOf(document.activeElement); event.preventDefault(); buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus(); }
    };
    back.addEventListener('click', event => { const button = event.target.closest('[data-confirm]'); if (button) done(button.dataset.confirm === 'yes'); else if (event.target === back) done(false); });
    document.addEventListener('keydown', key, true);
    document.body.append(back); back.querySelector('[data-confirm="yes"]').focus();
  });
}

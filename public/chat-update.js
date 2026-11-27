import { t } from './i18n.js';
// The card that tells the person a new version is downloaded and checked. Nothing installs until they press Update now;
// Later hides the card for a day, and the button in Settings stays.
const LATER = 'rex-desk-update-later', SHOWN = 4;
const laterChoice = () => { try { return JSON.parse(localStorage.getItem(LATER) || '{}'); } catch { return {}; } };
const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// Release notes arrive as one paragraph or as lines ("- item"). Each change becomes one list item.
export function noteItems(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  const items = lines.length > 1 ? lines : lines.flatMap(line => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/));
  return items.map(item => item.replace(/[.;]\s*$/, '').trim()).filter(Boolean);
}

export function showUpdateCard(update) {
  let card = document.getElementById('update-card');
  // A split pane is the same app in an iframe (?embed=1): the card shows once, in the main window, never in each pane.
  if (document.documentElement.classList.contains('embed')) { card?.remove(); return; }
  // Shown from the moment a new version starts downloading (with how much has arrived), then as ready to install.
  // A new version that cannot download or install yet (the drive is full) shows too, with the reason, instead of nothing.
  // An install that did not take shows first: what is known about it, and where the installer is to run it by hand.
  const failed = !update?.downloading && update?.installFailed?.version ? update.installFailed : null;
  const loading = !failed && !update?.ready && update?.downloading, blocked = !failed && !update?.ready && !loading && update?.problem && update?.available?.version;
  const version = failed ? failed.version : update?.ready ? update.available?.version : loading ? update.downloading.version : blocked ? update.available.version : '', later = laterChoice();
  if (!version || (later.version === version && later.until > Date.now())) { card?.remove(); return; }
  if (card?.dataset.version === version && card.dataset.ready === String(Boolean(update.ready)) && card.dataset.failed === String(Boolean(failed))) { renderFoot(card, update); return; }
  card?.remove();
  card = document.createElement('aside'); card.id = 'update-card'; card.dataset.version = version; card.dataset.ready = String(Boolean(update.ready)); card.dataset.failed = String(Boolean(failed));
  card.setAttribute('role', 'region'); card.setAttribute('aria-labelledby', 'update-card-title');
  card.innerHTML = `<header class="uc-head"><span class="uc-mark">${ICON}</span><div class="uc-title"><h2 id="update-card-title"></h2><p class="uc-meta"></p></div>
      <button type="button" class="uc-close" data-action="update-later" aria-label="${t`Remind me later`}">${CLOSE}</button></header>
    <ul class="uc-notes"></ul><button type="button" class="uc-more" hidden></button>
    <p class="uc-error" role="alert" hidden></p>
    <footer class="uc-foot"></footer>`;
  card.querySelector('h2').textContent = failed ? t`Rex Desk ${version} did not install` : update.ready ? t`Rex Desk ${version} is ready` : blocked ? t`Rex Desk ${version} is waiting` : t`Downloading Rex Desk ${version}`;
  card.querySelector('.uc-meta').textContent = failed ? (update.current ? t`You still have ${update.current}` : '') : update.ready ? (update.current ? t`Downloaded and checked · you have ${update.current}` : t('Downloaded and checked')) : blocked ? (update.current ? t`Not downloaded yet · you have ${update.current}` : t('Not downloaded yet')) : (update.current ? t`In the background · you have ${update.current}` : t('In the background'));
  const items = failed ? [] : noteItems(update.available?.notes);
  const list = card.querySelector('.uc-notes'), more = card.querySelector('.uc-more');
  for (const [index, text] of items.entries()) { const item = document.createElement('li'); item.textContent = text; if (index >= SHOWN) item.hidden = true; list.append(item); }
  list.hidden = !items.length;
  if (items.length > SHOWN) {
    more.hidden = false; more.textContent = t`Show all ${items.length} changes`;
    more.onclick = () => { for (const item of list.children) item.hidden = false; more.remove(); };
  }
  renderFoot(card, update);
  document.body.append(card);
}

// What is known about an update that did not install, in the person's language. The installer's own stop reason (its log) is
// shown as it wrote it.
function failedText(failed) {
  if (failed.why === 'gone') return t('The downloaded installer is gone, so the update could not run. Check for updates to download it again.');
  if (failed.why === 'not-started') return t('The installer did not start. Press Install manually to run it yourself.');
  if (failed.stopped) return t`The installer stopped: ${failed.stopped}`;
  if (failed.why === 'not-installed') return t('The update did not install. Press Install manually to run the installer yourself.');
  return failed.reason || '';
}

const who = names => names.length === 1 ? names[0] : names.length === 2 ? t`${names[0]} and ${names[1]}` : t`${names[0]}, ${names[1]} and ${names.length - 2} more`;
// The bottom of the card follows what is going on: free to update, agents working (updating would cut them off), or
// waiting for them to finish. Only this part redraws, so an expanded list of changes stays open.
function renderFoot(card, update) {
  const foot = card.querySelector('.uc-foot'), error = card.querySelector('.uc-error');
  if (card.dataset.failed === 'true' && update.installFailed) {
    error.textContent = failedText(update.installFailed); error.hidden = false;
    const key = `failed#${update.ready ? 1 : 0}`;
    if (foot.dataset.key !== key) {
      foot.dataset.key = key;
      foot.innerHTML = `<p class="uc-hint">${update.installFailed.installer ? t('Running the installer closes Rex Desk, so let working agents finish first.') : ''}</p><div class="uc-actions"><button type="button" class="btn quiet" data-action="update-later">${t`Later`}</button>${update.installFailed.installer ? `<button type="button" class="btn quiet" data-action="update-reveal">${t`Install manually`}</button>` : ''}${update.ready ? `<button type="button" class="btn primary" data-action="update-install">${t`Try again`}</button>` : ''}</div>`;
    }
    return;
  }
  // Why updating cannot go on (the drive is full, the last start could not move the data), said on the card from the server.
  if (update.problem) { error.textContent = update.problem; error.hidden = false; error.dataset.problem = '1'; }
  else if (error.dataset.problem) { error.hidden = true; delete error.dataset.problem; }
  if (!update.ready && !update.downloading) {
    if (foot.dataset.key !== 'blocked') { foot.dataset.key = 'blocked'; foot.innerHTML = `<p class="uc-hint">${t`It downloads by itself once there is room.`}</p><div class="uc-actions"><button type="button" class="btn quiet" data-action="update-later">${t`Later`}</button></div>`; }
    return;
  }
  // Downloading: a bar with how much has arrived, and Later.
  if (!update.ready && update.downloading) {
    const { received = 0, total = 0 } = update.downloading, mb = bytes => (bytes / 1048576).toFixed(1), share = total ? Math.min(100, Math.round(received / total * 100)) : 0;
    if (!foot.querySelector('.uc-progress')) { foot.dataset.key = 'downloading'; foot.innerHTML = `<div class="uc-progress"><div class="uc-bar" role="progressbar" aria-label="${t`Download`}" aria-valuemin="0" aria-valuemax="100"><i></i></div><p class="uc-hint"></p></div><div class="uc-actions"><button type="button" class="btn quiet" data-action="update-later">${t`Later`}</button></div>`; }
    const bar = foot.querySelector('.uc-bar'); bar.setAttribute('aria-valuenow', String(share)); bar.querySelector('i').style.width = total ? `${share}%` : '30%'; bar.classList.toggle('uc-bar-unknown', !total);
    foot.querySelector('.uc-hint').textContent = total ? t`${mb(received)} of ${mb(total)} MB` : t`${mb(received)} MB so far`;
    return;
  }
  const busy = update.busy || [], key = `${busy.join('|')}#${update.whenIdle ? 1 : 0}`;
  if (foot.dataset.key === key) return; foot.dataset.key = key;
  const one = busy.length === 1;
  const [hint, actions] = update.whenIdle && busy.length
    ? [`<span class="uc-wait" aria-hidden="true"></span>${one ? t`Installs by itself when ${esc(who(busy))} finishes.` : t`Installs by itself when ${esc(who(busy))} finish.`}`, `<button type="button" class="btn quiet" data-action="update-cancel">${t`Don’t wait`}</button>`]
    : busy.length
      ? [one ? t`${esc(who(busy))} is working. Updating restarts Rex Desk and would cut it off.` : t`${esc(who(busy))} are working. Updating restarts Rex Desk and would cut them off.`, `<button type="button" class="btn quiet" data-action="update-later">${t`Later`}</button><button type="button" class="btn primary" data-action="update-when-idle">${one ? t`Update when it finishes` : t`Update when they finish`}</button>`]
      : [t('Rex Desk restarts and opens again in about a minute.'), `<button type="button" class="btn quiet" data-action="update-later">${t`Later`}</button><button type="button" class="btn primary" data-action="update-install">${t`Update now`}</button>`];
  foot.innerHTML = `<p class="uc-hint">${hint}</p><div class="uc-actions">${actions}</div>`;
}
const esc = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

// "Update when it finishes" (or cancel it): the server installs by itself once no agent is working.
export async function updateWhenIdle(api, wait = true) {
  const card = document.getElementById('update-card'), error = card?.querySelector('.uc-error');
  if (error) error.hidden = true;
  try { await api('/update/install', { method: 'POST', data: wait ? { whenIdle: true } : { cancel: true } }); }
  catch (failure) { if (error) { error.textContent = failure.message; error.hidden = false; } }
}

// Coming back to Rex Desk (switching to its window, unlocking the computer) asks for an update check, at most every two
// minutes, so a version published while the person was away shows at once. The server tells the page when it finds one.
let watching = false, askedAt = Date.now();
export function watchForUpdates(api) {
  if (watching) return; watching = true;
  const ask = () => { if (document.visibilityState !== 'visible' || Date.now() - askedAt < 120000) return; askedAt = Date.now(); void api('/update/check', { method: 'POST' }).catch(() => {}); };
  document.addEventListener('visibilitychange', ask); addEventListener('focus', ask);
}

// The version whose card the person put off with Later, while it is still waiting: the window bar shows an Update button for it.
export function updateDeferred(update) {
  const version = update?.ready ? update.available?.version : update?.downloading?.version || '', later = laterChoice();
  return version && later.version === version && later.until > Date.now() ? version : '';
}
// The Update button in the window bar brings the card back.
export function updateShow(update) {
  try { localStorage.removeItem(LATER); } catch { /* private window */ }
  showUpdateCard(update);
}

export function updateLater() {
  const card = document.getElementById('update-card'); if (!card) return;
  try { localStorage.setItem(LATER, JSON.stringify({ version: card.dataset.version, until: Date.now() + 24 * 3600000 })); } catch { /* private window */ }
  card.remove();
}

// "Cannot reach your computer" says nothing about what to do. When the server did not answer, it is asked again for a few
// seconds (a restart can hold it up), and the reason it gives (a full drive, a busy port) is shown instead.
export async function whyUnreachable(api, failure, { tries = 4, pause = 2500 } = {}) {
  if (failure?.message !== t('Cannot reach your computer. Trying again.') && failure?.message !== t('Your computer answered too slowly. Trying again.')) return failure?.message || '';
  for (let index = 0; index < tries; index++) {
    await new Promise(resolve => setTimeout(resolve, pause));
    try { const state = await api('/state', { timeout: 5000 }); return state?.update?.problem || t('Rex Desk was busy for a moment. Press Update now again.'); } catch { /* still not answering */ }
  }
  return t('Rex Desk is not answering. The drive may be full, or the old Rex Desk is still closing. Close Rex Desk, open it again, then press Update now.');
}

// Opens the folder of the installer that did not install, with the file selected, so the person can run it by hand.
export async function revealInstaller(api) {
  const error = document.querySelector('#update-card .uc-error');
  const hint = document.querySelector('#update-card .uc-hint');
  try {
    const shown = await api('/update/reveal', { method: 'POST' });
    if (shown?.opened === false) { if (error) { error.textContent = t`Rex Desk could not open the folder. Open it yourself: ${shown.folder}`; error.hidden = false; } return; }
    if (hint) hint.textContent = `${t('The installer is selected in the window that opened. Double-click it to run it.')} ${t('Running the installer closes Rex Desk, so let working agents finish first.')}`;
  } catch (failure) { if (error) { error.textContent = failure.message; error.hidden = false; } }
}

export async function installUpdate(api) {
  const card = document.getElementById('update-card'), button = card?.querySelector('[data-action="update-install"]'), error = card?.querySelector('.uc-error');
  if (button) { button.disabled = true; button.textContent = t('Updating…'); }
  if (error) error.hidden = true;
  try { await api('/update/install', { method: 'POST', data: {} }); }
  catch (failure) {
    // Agents still working, or the download went away: say why here and let the person try again.
    if (button) { button.disabled = false; button.textContent = t('Update now'); }
    // The installer did not start: a button opens its folder with the file selected, to run it by hand.
    if (button && /installer did not start/i.test(failure.message) && !card.querySelector('[data-action="update-reveal"]')) { const manual = document.createElement('button'); manual.type = 'button'; manual.className = 'btn quiet'; manual.dataset.action = 'update-reveal'; manual.textContent = t('Install manually'); button.before(manual); }
    if (error) { error.textContent = await whyUnreachable(api, failure); error.hidden = false; return; }
    throw failure;
  }
  card?.remove();
  document.getElementById('app').innerHTML = `<div class="boot"><svg class="boot-mark" viewBox="0 0 64 64" width="44" height="44" aria-hidden="true"><defs><linearGradient id="rex-mark-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a97ff"/><stop offset="1" stop-color="#3a72e8"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="14" fill="url(#rex-mark-g)"/><g fill="#fff"><rect x="16" y="16" width="14" height="14" rx="3"/><rect x="34" y="16" width="14" height="14" rx="3"/><rect x="16" y="34" width="14" height="14" rx="3"/><rect x="34" y="34" width="14" height="14" rx="3" opacity=".47"/></g></svg><span>${t`Updating Rex Desk. It reopens by itself in about a minute.`}</span><i class="boot-bar"></i></div>`;
}

// Rex Desk opens from this computer's copy first; while it then syncs with the cloud backup (changes from your other
// computers, and uploading what changed here), a small note at the bottom left says so. It goes away when the sync is done.
export function showSyncNote(cloud) {
  let note = document.getElementById('sync-note');
  if (!cloud?.syncing) { note?.remove(); return; }
  if (note) return;
  note = document.createElement('div'); note.id = 'sync-note'; note.setAttribute('role', 'status');
  note.innerHTML = `<span class="sn-dot" aria-hidden="true"></span>${t`Syncing with your cloud backup…`}`;
  document.body.append(note);
}

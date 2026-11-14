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
  // Shown from the moment a new version starts downloading (with how much has arrived), then as ready to install.
  const loading = !update?.ready && update?.downloading, version = update?.ready ? update.available?.version : loading ? update.downloading.version : '', later = laterChoice();
  if (!version || (later.version === version && later.until > Date.now())) { card?.remove(); return; }
  if (card?.dataset.version === version && card.dataset.ready === String(Boolean(update.ready))) { renderFoot(card, update); return; }
  card?.remove();
  card = document.createElement('aside'); card.id = 'update-card'; card.dataset.version = version; card.dataset.ready = String(Boolean(update.ready));
  card.setAttribute('role', 'region'); card.setAttribute('aria-labelledby', 'update-card-title');
  card.innerHTML = `<header class="uc-head"><span class="uc-mark">${ICON}</span><div class="uc-title"><h2 id="update-card-title"></h2><p class="uc-meta"></p></div>
      <button type="button" class="uc-close" data-action="update-later" aria-label="Remind me later">${CLOSE}</button></header>
    <ul class="uc-notes"></ul><button type="button" class="uc-more" hidden></button>
    <p class="uc-error" role="alert" hidden></p>
    <footer class="uc-foot"></footer>`;
  card.querySelector('h2').textContent = update.ready ? `Rex Desk ${version} is ready` : `Downloading Rex Desk ${version}`;
  card.querySelector('.uc-meta').textContent = update.ready ? (update.current ? `Downloaded and verified · you have ${update.current}` : 'Downloaded and verified') : (update.current ? `In the background · you have ${update.current}` : 'In the background');
  const items = noteItems(update.available?.notes);
  const list = card.querySelector('.uc-notes'), more = card.querySelector('.uc-more');
  for (const [index, text] of items.entries()) { const item = document.createElement('li'); item.textContent = text; if (index >= SHOWN) item.hidden = true; list.append(item); }
  list.hidden = !items.length;
  if (items.length > SHOWN) {
    more.hidden = false; more.textContent = `Show all ${items.length} changes`;
    more.onclick = () => { for (const item of list.children) item.hidden = false; more.remove(); };
  }
  renderFoot(card, update);
  document.body.append(card);
}

const who = names => names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
// The bottom of the card follows what is going on: free to update, agents working (updating would cut them off), or
// waiting for them to finish. Only this part redraws, so an expanded list of changes stays open.
function renderFoot(card, update) {
  const foot = card.querySelector('.uc-foot');
  // Downloading: a bar with how much has arrived, and Later.
  if (!update.ready && update.downloading) {
    const { received = 0, total = 0 } = update.downloading, mb = bytes => (bytes / 1048576).toFixed(1), share = total ? Math.min(100, Math.round(received / total * 100)) : 0;
    if (!foot.querySelector('.uc-progress')) { foot.dataset.key = 'downloading'; foot.innerHTML = '<div class="uc-progress"><div class="uc-bar" role="progressbar" aria-label="Download" aria-valuemin="0" aria-valuemax="100"><i></i></div><p class="uc-hint"></p></div><div class="uc-actions"><button type="button" class="btn quiet" data-action="update-later">Later</button></div>'; }
    const bar = foot.querySelector('.uc-bar'); bar.setAttribute('aria-valuenow', String(share)); bar.querySelector('i').style.width = total ? `${share}%` : '30%'; bar.classList.toggle('uc-bar-unknown', !total);
    foot.querySelector('.uc-hint').textContent = total ? `${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB so far`;
    return;
  }
  const busy = update.busy || [], key = `${busy.join('|')}#${update.whenIdle ? 1 : 0}`;
  if (foot.dataset.key === key) return; foot.dataset.key = key;
  const one = busy.length === 1;
  const [hint, actions] = update.whenIdle && busy.length
    ? [`<span class="uc-wait" aria-hidden="true"></span>Installs by itself when ${esc(who(busy))} ${one ? 'finishes' : 'finish'}.`, '<button type="button" class="btn quiet" data-action="update-cancel">Don’t wait</button>']
    : busy.length
      ? [`${esc(who(busy))} ${one ? 'is' : 'are'} working. Updating restarts Rex Desk and would cut ${one ? 'it' : 'them'} off.`, `<button type="button" class="btn quiet" data-action="update-later">Later</button><button type="button" class="btn primary" data-action="update-when-idle">Update when ${one ? 'it finishes' : 'they finish'}</button>`]
      : ['Rex Desk restarts and opens again in about a minute.', '<button type="button" class="btn quiet" data-action="update-later">Later</button><button type="button" class="btn primary" data-action="update-install">Update now</button>'];
  foot.innerHTML = `<p class="uc-hint">${hint}</p><div class="uc-actions">${actions}</div>`;
}
// The colours of the theme on screen, as #rrggbb, so the update window that runs while Rex Desk restarts looks like it.
function themeColours() {
  const probe = document.createElement('i'); probe.style.display = 'none'; document.body.append(probe);
  const hex = (value, fallback) => { probe.style.color = ''; probe.style.color = value; const resolved = getComputedStyle(probe).color, unit = resolved.startsWith('color(') ? 255 : 1, match = resolved.replace(/^color\(\s*srgb/, '').match(/\d*\.?\d+/g); return match && match.length >= 3 ? `#${match.slice(0, 3).map(part => Math.min(255, Math.round(Number(part) * unit)).toString(16).padStart(2, '0')).join('')}` : fallback; };
  const style = getComputedStyle(document.documentElement), read = (name, fallback) => hex(style.getPropertyValue(name).trim() || fallback, fallback);
  const colours = { panel: read('--solid', read('--panel', '#16181d')), ink: read('--ink', '#e6e8eb'), muted: read('--muted', '#9aa3b1'), accent: read('--accent', '#5a97ff'), line: read('--line', '#2a2f37') };
  probe.remove(); return colours;
}
const esc = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

// "Update when it finishes" (or cancel it): the server installs by itself once no agent is working.
export async function updateWhenIdle(api, wait = true) {
  const card = document.getElementById('update-card'), error = card?.querySelector('.uc-error');
  if (error) error.hidden = true;
  try { await api('/update/install', { method: 'POST', data: wait ? { whenIdle: true, theme: themeColours() } : { cancel: true } }); }
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

export async function installUpdate(api) {
  const card = document.getElementById('update-card'), button = card?.querySelector('[data-action="update-install"]'), error = card?.querySelector('.uc-error');
  if (button) { button.disabled = true; button.textContent = 'Updating…'; }
  if (error) error.hidden = true;
  try { await api('/update/install', { method: 'POST', data: { theme: themeColours() } }); }
  catch (failure) {
    // Agents still working, or the download went away: say why here and let the person try again.
    if (button) { button.disabled = false; button.textContent = 'Update now'; }
    if (error) { error.textContent = failure.message; error.hidden = false; return; }
    throw failure;
  }
  card?.remove();
  document.getElementById('app').innerHTML = '<div class="boot"><svg class="boot-mark" viewBox="0 0 64 64" width="44" height="44" aria-hidden="true"><defs><linearGradient id="rex-mark-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a97ff"/><stop offset="1" stop-color="#3a72e8"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="14" fill="url(#rex-mark-g)"/><g fill="#fff"><rect x="16" y="16" width="14" height="14" rx="3"/><rect x="34" y="16" width="14" height="14" rx="3"/><rect x="16" y="34" width="14" height="14" rx="3"/><rect x="34" y="34" width="14" height="14" rx="3" opacity=".47"/></g></svg><span>Updating Rex Desk. It reopens by itself in about a minute.</span><i class="boot-bar"></i></div>';
}

// Rex Desk opens from this computer's copy first; while it then syncs with the cloud backup (changes from your other
// computers, and uploading what changed here), a small note at the bottom left says so. It goes away when the sync is done.
export function showSyncNote(cloud) {
  let note = document.getElementById('sync-note');
  if (!cloud?.syncing) { note?.remove(); return; }
  if (note) return;
  note = document.createElement('div'); note.id = 'sync-note'; note.setAttribute('role', 'status');
  note.innerHTML = '<span class="sn-dot" aria-hidden="true"></span>Syncing with your cloud backup…';
  document.body.append(note);
}

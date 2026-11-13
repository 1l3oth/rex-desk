// The card that tells the person a new version is downloaded and checked. Nothing installs until they press Restart to
// update; Later hides the card for a day, and the button in Settings stays.
const LATER = 'rex-desk-update-later';
const laterChoice = () => { try { return JSON.parse(localStorage.getItem(LATER) || '{}'); } catch { return {}; } };

export function showUpdateCard(update) {
  let card = document.getElementById('update-card');
  const version = update?.ready ? update.available?.version : '', later = laterChoice();
  if (!version || (later.version === version && later.until > Date.now())) { card?.remove(); return; }
  if (card?.dataset.version === version) return;
  card?.remove();
  card = document.createElement('aside'); card.id = 'update-card'; card.dataset.version = version; card.setAttribute('role', 'status');
  card.innerHTML = '<h2></h2><p></p><div class="update-actions"><button type="button" class="btn primary" data-action="update-install">Restart to update</button><button type="button" class="btn quiet" data-action="update-later">Later</button></div>';
  card.querySelector('h2').textContent = `Rex Desk ${version} is ready`;
  const notes = card.querySelector('p'); notes.textContent = update.available.notes || ''; notes.hidden = !update.available.notes;
  document.body.append(card);
}

export function updateLater() {
  const card = document.getElementById('update-card'); if (!card) return;
  try { localStorage.setItem(LATER, JSON.stringify({ version: card.dataset.version, until: Date.now() + 24 * 3600000 })); } catch { /* private window */ }
  card.remove();
}

export async function installUpdate(api) {
  await api('/update/install', { method: 'POST' });
  document.getElementById('update-card')?.remove();
  document.getElementById('app').innerHTML = '<div class="boot"><img class="boot-mark" src="/favicon.svg" alt=""><span>Updating Rex Desk. It reopens by itself in about a minute.</span><i class="boot-bar"></i></div>';
}

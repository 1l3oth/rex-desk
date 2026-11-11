// Notifications: everything agents said or asked while you were elsewhere, newest first, with unread counts on each chat.
// A new one for a chat you are not looking at pops up for a few seconds; click it to go there. Chats can be muted.
const KIND = { ask: 'Needs you', reply: 'Replied', room: 'Group chat', failed: 'Stopped' };

// The key of the chat on screen, the same key the server gives each notification.
export function noticeKey(view) {
  if (view.type === 'main') return 'main:';
  if (view.type === 'room' || view.type === 'run') return `${view.type}:${view.id}`;
  if (view.type === 'inbox') return 'inbox:';
  return '';
}
export const unreadFor = (ui, key) => ui.snap?.notices?.byKey?.[key] || 0;

const openOf = target => target.type === 'inbox' ? ['inbox', ''] : target.type === 'main' ? ['main', ''] : [target.type, target.id];
const when = at => { const minutes = Math.round((Date.now() - Date.parse(at)) / 60000); return minutes < 1 ? 'now' : minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)} h` : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' }); };

export function noticesStage(ctx) {
  const { ui, esc } = ctx, data = ui.snap.notices || { recent: [], unread: 0, mutes: [] }, mutes = new Set(data.mutes || []);
  const filter = ui.noticeFilter === 'unread' ? 'unread' : 'all', list = data.recent.filter(item => filter === 'all' || !item.read);
  const row = item => `<li class="nt-row${item.read ? '' : ' unread'}"><button type="button" class="nt-open" data-action="nt-open" data-key="${esc(item.key)}" data-type="${esc(item.target.type)}" data-id="${esc(item.target.id || '')}">
      <span class="nt-kind ${esc(item.kind)}">${esc(KIND[item.kind] || 'Update')}</span><span class="nt-text"><b>${esc(item.title)}</b><small>${esc(item.body)}</small></span><span class="nt-when">${esc(when(item.at))}</span></button></li>`;
  const chats = [{ key: 'main:', name: 'Rex Agent' }, ...(ui.snap.rooms || []).map(room => ({ key: `room:${room.id}`, name: room.name, sub: 'Group chat' })),
    ...(ui.snap.specialists || []).filter(agent => agent.runId).map(agent => ({ key: `run:${agent.runId}`, name: agent.name, sub: agent.projectSlug }))];
  const muteRow = chat => `<li><span><b>${esc(chat.name)}</b>${chat.sub ? `<small>${esc(chat.sub)}</small>` : ''}</span><button type="button" class="btn small${mutes.has(chat.key) ? '' : ' quiet'}" data-action="nt-mute" data-key="${esc(chat.key)}" data-on="${mutes.has(chat.key) ? '0' : '1'}">${mutes.has(chat.key) ? 'Muted · Unmute' : 'Mute'}</button></li>`;
  const pops = ui.snap.config?.notify !== false;
  const feed = `<div class="page notices">
    <div class="nt-main">
      <div class="nt-bar"><div class="pseg"><button type="button" class="tab ${filter === 'all' ? 'on' : ''}" data-action="nt-filter" data-tab="all">All</button><button type="button" class="tab ${filter === 'unread' ? 'on' : ''}" data-action="nt-filter" data-tab="unread">Unread${data.unread ? `<span class="tcount">${data.unread}</span>` : ''}</button></div><span class="spacer"></span>${data.unread ? '<button type="button" class="btn small" data-action="nt-readall">Mark all as read</button>' : ''}</div>
      ${list.length ? `<ul class="nt-list">${list.map(row).join('')}</ul>` : `<div class="empty"><h2>${filter === 'unread' ? 'All caught up' : 'Nothing yet'}</h2><p>When an agent replies, asks you something or stops, it shows here.</p></div>`}
    </div>
    <aside class="nt-side card"><h3>How you are told</h3>
      <label class="nt-check"><input type="checkbox" data-nt-pops ${pops ? 'checked' : ''}><span>Windows pop-ups when Rex Desk is not the window in front</span></label>
      <p class="muted small">Inside Rex Desk, a new message for another chat pops up at the bottom for a few seconds. Busy group chats pop up at most once a minute.</p>
      <h3>Mute a chat</h3><p class="muted small">A muted chat stays quiet: no pop-ups and no unread count. Its messages are still here.</p>
      <ul class="nt-mutes">${chats.map(muteRow).join('')}</ul></aside>
  </div>`;
  return { title: 'Notifications', meta: data.unread ? `${data.unread} unread` : 'All caught up', feed, top: true };
}

export async function noticesAction(ctx, action, target) {
  const { api, ui, refresh, open } = ctx;
  if (action === 'nt-filter') { ui.noticeFilter = target.dataset.tab; ctx.render(); return; }
  if (action === 'nt-readall') { await api('/notices/read', { method: 'POST', data: { all: true } }); await refresh(); return; }
  if (action === 'nt-mute') { await api('/notices/mute', { method: 'POST', data: { key: target.dataset.key, on: target.dataset.on === '1' } }); await refresh(); return; }
  if (action === 'nt-open') { await api('/notices/read', { method: 'POST', data: { key: target.dataset.key } }).catch(() => {}); hidePop(); open(target.dataset.type === 'inbox' ? 'inbox' : target.dataset.type, target.dataset.id || ''); }
}

// ---------- the pop-up inside Rex Desk ----------
let seen = null, popTimer = 0;
function hidePop() { document.querySelector('.nt-pop')?.remove(); clearTimeout(popTimer); }
export function watchNotices(ctx) {
  const { ui, esc } = ctx, recent = ui.snap?.notices?.recent || [];
  const key = noticeKey(ui.view); if (window.rexView !== key) { window.rexView = key; window.rexPresence?.(); }
  if (!seen) { seen = new Set(recent.map(item => item.id)); return; }
  const here = noticeKey(ui.view), fresh = recent.filter(item => !seen.has(item.id) && !item.read && item.key !== here);
  for (const item of recent) seen.add(item.id);
  if (!fresh.length) return;
  const item = fresh[0], more = fresh.length - 1;
  hidePop();
  const pop = document.createElement('div'); pop.className = 'nt-pop'; pop.setAttribute('role', 'status');
  pop.innerHTML = `<button type="button" class="nt-pop-open" data-action="nt-open" data-key="${esc(item.key)}" data-type="${esc(item.target.type)}" data-id="${esc(item.target.id || '')}"><b>${esc(item.title)}</b><small>${esc(item.body)}</small>${more ? `<em>and ${more} more</em>` : ''}</button><button type="button" class="nt-pop-x" aria-label="Dismiss">×</button>`;
  pop.querySelector('.nt-pop-x').addEventListener('click', hidePop);
  document.body.append(pop); popTimer = setTimeout(hidePop, 6000);
}
document.addEventListener('change', async event => {
  if (!event.target.matches?.('[data-nt-pops]')) return;
  const ctx = window.__rexCtx; if (!ctx) return;
  try { await ctx.api('/config', { method: 'PUT', data: { ...ctx.ui.snap.config, notify: event.target.checked } }); await ctx.refresh(); } catch (error) { ctx.toast(error.message, true); }
});

// Split view: up to four chats side by side (agents from any project, Rex Agent, group chats). Each pane is a full chat of
// its own, with its own message box. Drag a pane by its bar onto another to swap them; the layout is remembered.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const KEY = 'rex-split';
const read = () => { try { const saved = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(saved) ? saved.slice(0, 4) : []; } catch { return []; } };
const save = panes => { try { localStorage.setItem(KEY, JSON.stringify(panes.slice(0, 4))); } catch {} };
const hashOf = pane => {
  if (pane.type === 'specialist') { const agent = (window.__rexCtx?.ui?.snap?.specialists || []).find(item => item.id === pane.id); if (agent?.runId) return `#/run/${encodeURIComponent(agent.runId)}`; }
  return pane.type === 'main' ? '#/main' : `#/${pane.type}/${encodeURIComponent(pane.id)}`;
};

function choices() {
  const snap = window.__rexCtx?.ui?.snap || {};
  return [{ type: 'main', id: '', label: 'Rex Agent', hint: 'Knows every project' },
    // An agent opens on its own chat (once it has one), not on its card.
    ...(snap.specialists || []).filter(agent => agent.kind !== 'main').map(agent => ({ type: 'specialist', id: agent.id, label: agent.name, hint: agent.projectSlug || '' })),
    ...(snap.rooms || []).map(room => ({ type: 'room', id: room.id, label: room.name, hint: 'Group chat' }))];
}
const nameOf = pane => choices().find(item => item.type === pane.type && item.id === pane.id)?.label || 'Chat';

export function splitStage() {
  const panes = read();
  const pane = (item, index) => `<section class="sp-pane" data-sp="${index}"><header class="sp-bar" draggable="true" data-sp-drag="${index}" title="Drag onto another pane to swap them">
      <span class="sp-grip" aria-hidden="true">⋮⋮</span><b>${esc(nameOf(item))}</b><span class="spacer"></span>
      <button type="button" class="sp-btn" data-sp-full="${index}" title="Open it alone" aria-label="Open ${esc(nameOf(item))} alone"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>
      <button type="button" class="sp-btn" data-sp-close="${index}" title="Close this pane" aria-label="Close this pane"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header>
    <iframe class="sp-frame" src="/?embed=1${hashOf(item)}" title="${esc(nameOf(item))}" loading="lazy"></iframe></section>`;
  const used = new Set(panes.map(item => `${item.type}:${item.id}`));
  const free = choices().filter(item => !used.has(`${item.type}:${item.id}`));
  const adder = panes.length < 4 ? `<section class="sp-pane sp-add"><div class="sp-add-in"><h3>Add a chat</h3><p>Put up to four chats side by side.</p>
      <div class="sp-find"><input type="search" placeholder="Find an agent or a group chat" data-sp-find aria-label="Find a chat"></div>
      <ul class="sp-choices">${free.map(item => `<li><button type="button" data-sp-add="${esc(item.type)}" data-sp-id="${esc(item.id)}" data-find="${esc(`${item.label} ${item.hint}`.toLowerCase())}"><b>${esc(item.label)}</b><small>${esc(item.hint)}</small></button></li>`).join('') || '<li class="muted">Every chat is already open.</li>'}</ul></div></section>` : '';
  const count = panes.length + (adder ? 1 : 0);
  return { title: 'Split view', meta: panes.length ? `${panes.length} of 4 chats` : 'Put chats side by side', top: true,
    feed: `<div class="sp-grid sp-n${Math.max(1, count)}" id="sp-grid" data-keep="split-${panes.map(item => `${item.type}:${item.id}`).join(',')}">${panes.map(pane).join('')}${adder}</div>` };
}

const redraw = () => window.__rexCtx?.refresh?.({ full: true });
document.addEventListener('click', event => {
  const add = event.target.closest?.('[data-sp-add]');
  if (add) { const panes = read(); panes.push({ type: add.dataset.spAdd, id: add.dataset.spId || '' }); save(panes); redraw(); return; }
  const shut = event.target.closest?.('[data-sp-close]');
  if (shut) { const panes = read(); panes.splice(Number(shut.dataset.spClose), 1); save(panes); redraw(); return; }
  const full = event.target.closest?.('[data-sp-full]');
  if (full) { const item = read()[Number(full.dataset.spFull)]; if (item) window.__rexCtx?.open(item.type, item.id); }
});
document.addEventListener('input', event => {
  if (!event.target.matches?.('[data-sp-find]')) return;
  const words = event.target.value.trim().toLowerCase();
  for (const button of document.querySelectorAll('[data-sp-add]')) button.parentElement.hidden = Boolean(words) && !button.dataset.find.includes(words);
});
// Drag a pane's bar onto another pane to swap the two.
let dragging = -1;
document.addEventListener('dragstart', event => { const bar = event.target.closest?.('[data-sp-drag]'); if (!bar) return; dragging = Number(bar.dataset.spDrag); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(dragging)); document.getElementById('sp-grid')?.classList.add('sp-dragging'); });
document.addEventListener('dragover', event => { const pane = event.target.closest?.('.sp-pane[data-sp]'); if (dragging < 0 || !pane) return; event.preventDefault(); for (const other of document.querySelectorAll('.sp-pane.sp-over')) other.classList.remove('sp-over'); if (Number(pane.dataset.sp) !== dragging) pane.classList.add('sp-over'); });
document.addEventListener('drop', event => {
  const pane = event.target.closest?.('.sp-pane[data-sp]'); if (dragging < 0 || !pane) return; event.preventDefault();
  const to = Number(pane.dataset.sp), panes = read();
  if (to !== dragging && panes[to] && panes[dragging]) { [panes[to], panes[dragging]] = [panes[dragging], panes[to]]; save(panes); }
  dragging = -1; redraw();
});
document.addEventListener('dragend', () => { dragging = -1; document.getElementById('sp-grid')?.classList.remove('sp-dragging'); for (const other of document.querySelectorAll('.sp-pane.sp-over')) other.classList.remove('sp-over'); });

// Split view: up to four chats side by side (agents from any project, Rex Agent, group chats). Each pane is a full chat of
// its own, with its own message box. Drag a pane by its bar onto another to swap them; the layout is remembered.
import { avatarHtml } from '/chat-rooms.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const KEY = 'rex-split';
const read = () => { try { const saved = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(saved) ? saved.slice(0, 4) : []; } catch { return []; } };
const save = panes => { try { localStorage.setItem(KEY, JSON.stringify(panes.slice(0, 4))); } catch {} };
const hashOf = pane => {
  if (pane.type === 'specialist') { const agent = (window.__rexCtx?.ui?.snap?.specialists || []).find(item => item.id === pane.id); if (agent?.runId) return `#/run/${encodeURIComponent(agent.runId)}`; }
  return pane.type === 'main' ? '#/main' : `#/${pane.type}/${encodeURIComponent(pane.id)}`;
};

// What an agent is doing, in the words and colours of the chat list, so the picker shows at a glance who is free.
const STATE = { busy: ['Working', 'working', 0], replying: ['Working', 'working', 0], waiting: ['Needs you', 'warn', 1], idle: ['Asleep', 'good', 2], offline: ['Offline', 'off', 3] };
const stateOf = status => { const [word, dot, rank] = STATE[status?.state] || ['Ready', 'good', 2]; return { word: ['busy', 'replying'].includes(status?.state) && status.label ? status.label : word, dot, rank }; };
function choices() {
  const snap = window.__rexCtx?.ui?.snap || {}, main = (snap.specialists || []).find(agent => agent.kind === 'main');
  return [{ type: 'main', id: '', label: 'Rex Agent', hint: 'Knows every project', state: stateOf(main?.status), main: true },
    // An agent opens on its own chat (once it has one), not on its card.
    ...(snap.specialists || []).filter(agent => agent.kind !== 'main').map(agent => ({ type: 'specialist', id: agent.id, label: agent.name, hint: agent.projectSlug || '', state: stateOf(agent.status), agent })),
    ...(snap.rooms || []).map(room => ({ type: 'room', id: room.id, label: room.name, hint: 'Group chat' }))];
}
const nameOf = pane => choices().find(item => item.type === pane.type && item.id === pane.id)?.label || 'Chat';

// The list of chats that are not open yet, with each agent's face and what it is doing.
function pickerHtml(panes) {
  const used = new Set(panes.map(item => `${item.type}:${item.id}`));
  // Working agents first, then the ones waiting for you, then asleep, then offline; group chats after the agents.
  const free = choices().filter(item => !used.has(`${item.type}:${item.id}`)).map((item, order) => ({ item, order })).sort((a, b) => (a.item.state?.rank ?? 9) - (b.item.state?.rank ?? 9) || a.order - b.order).map(entry => entry.item);
  const ctx = window.__rexCtx, face = item => item.state && ctx ? `<span class="avwrap">${avatarHtml(ctx, { name: item.label, agent: item.agent || null, size: 'sm' })}<span class="sdot ${item.state.dot}"></span></span>` : '';
  return `<div class="sp-add-in"><h3>Add a chat</h3><p>Put up to four chats side by side.</p>
      <div class="sp-find"><input type="search" placeholder="Find an agent or a group chat" data-sp-find aria-label="Find a chat"></div>
      <ul class="sp-choices">${free.map(item => `<li><button type="button" data-sp-add="${esc(item.type)}" data-sp-id="${esc(item.id)}" data-find="${esc(`${item.label} ${item.hint}`.toLowerCase())}">${face(item)}<span class="sp-ct"><b>${esc(item.label)}</b><small>${item.state ? `<span class="sp-st ${item.state.dot}">${esc(item.state.word)}</span> · ` : ''}${esc(item.hint)}</small></span></button></li>`).join('') || '<li class="muted">Every chat is already open.</li>'}</ul></div>`;
}

export function splitStage() {
  const panes = read();
  const pane = (item, index) => `<section class="sp-pane" data-sp="${index}"><header class="sp-bar" draggable="true" data-sp-drag="${index}" title="Drag onto another pane to swap them">
      <span class="sp-grip" aria-hidden="true">⋮⋮</span><b>${esc(nameOf(item))}</b><span class="spacer"></span>
      <button type="button" class="sp-btn" data-sp-full="${index}" title="Open it alone" aria-label="Open ${esc(nameOf(item))} alone"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>
      <button type="button" class="sp-btn" data-sp-close="${index}" title="Close this pane" aria-label="Close this pane"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header>
    <iframe class="sp-frame" src="/?embed=1${hashOf(item)}" title="${esc(nameOf(item))}" loading="lazy"></iframe></section>`;
  // With no chat open the picker fills the screen; once chats are open it is a popup behind the Add a chat button, so
  // two chats can have the whole width.
  const adder = panes.length ? '' : `<section class="sp-pane sp-add">${pickerHtml(panes)}</section>`;
  const count = panes.length + (adder ? 1 : 0);
  const addButton = panes.length && panes.length < 4 ? `<button type="button" class="btn small" data-sp-picker><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> Add a chat</button>` : '';
  return { title: 'Split view', meta: panes.length ? `${panes.length} of 4 chats` : 'Put chats side by side', top: true, actions: addButton,
    feed: `<div class="sp-grid sp-n${Math.max(1, count)}" id="sp-grid" data-keep="split-${panes.map(item => `${item.type}:${item.id}`).join(',')}">${panes.map(pane).join('')}${adder}</div>` };
}

const redraw = () => window.__rexCtx?.refresh?.({ full: true });
document.addEventListener('click', event => {
  const add = event.target.closest?.('[data-sp-add]');
  if (add) { const panes = read(); if (panes.length < 4) panes.push({ type: add.dataset.spAdd, id: add.dataset.spId || '' }); save(panes); document.querySelector('.sp-pop')?.remove(); redraw(); return; }
  // The Add a chat button: the picker as a popup over the open chats.
  if (event.target.closest?.('[data-sp-picker]')) {
    const back = document.createElement('div'); back.className = 'dialog-back sp-pop';
    back.innerHTML = `<div class="dialog sp-dialog" role="dialog" aria-label="Add a chat"><button type="button" class="ra-x" data-sp-pop-close aria-label="Close">×</button>${pickerHtml(read())}</div>`;
    document.body.append(back); back.querySelector('[data-sp-find]')?.focus(); return;
  }
  const pop = document.querySelector('.sp-pop');
  if (pop && (event.target === pop || event.target.closest?.('[data-sp-pop-close]'))) { pop.remove(); return; }
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
document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('.sp-pop')?.remove(); });

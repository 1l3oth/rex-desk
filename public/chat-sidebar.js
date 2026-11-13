// The sidebar's lists of agents and group chats: the person's own order and pins (dragged, or Alt+Up/Down), saved with their
// workspace so every computer shows the same. Agents are grouped by where they are: pinned, on this computer, on other
// computers (dimmed, and the group folds away). A filter box finds an agent by name or project.
const PIN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/></svg>';
const here = agent => agent.status?.state !== 'offline' && !agent.remote;

// The person's order: pinned ones in pin order, then the rest in their dragged order, then anything new by name.
function arrange(items, saved = {}) {
  const pins = (saved.pins || []).filter(id => items.some(item => item.id === id));
  const rank = new Map((saved.order || []).map((id, index) => [id, index]));
  const byOrder = (left, right) => (rank.has(left.id) ? rank.get(left.id) : 1e6) - (rank.has(right.id) ? rank.get(right.id) : 1e6) || String(left.name).localeCompare(String(right.name));
  return { pinned: pins.map(id => items.find(item => item.id === id)), rest: items.filter(item => !pins.includes(item.id)).sort(byOrder), pins };
}

const rowHtml = (ctx, kind, item, inner, pinned, search = '') => {
  const { esc } = ctx;
  return `<div class="drag-row${pinned ? ' pinned' : ''}" draggable="true" data-drag-kind="${kind}" data-drag-id="${esc(item.id)}" data-search="${esc(search.toLowerCase())}">${inner}`
    + `<button type="button" class="pin-btn${pinned ? ' on' : ''}" data-action="pin-toggle" data-kind="${kind}" data-id="${esc(item.id)}" title="${pinned ? 'Unpin' : 'Pin to the top'}" aria-label="${pinned ? `Unpin ${esc(item.name)}` : `Pin ${esc(item.name)} to the top`}" aria-pressed="${pinned}">${PIN}</button></div>`;
};
const subhead = (ctx, key, title, count, foldable) => {
  const shut = foldable && ctx.isCollapsed?.(key);
  return `<button type="button" class="sub-sec${shut ? ' shut' : ''}" ${foldable ? `data-action="sec-toggle" data-sec="${key}" aria-expanded="${!shut}"` : 'tabindex="-1"'} data-drop-pin="${key === 'pinned-agents' || key === 'pinned-rooms' ? 'yes' : ''}">${foldable ? '<span class="chev" aria-hidden="true">▾</span>' : ''}${title}<span class="cnt">${count}</span></button>`;
};

export function agentListHtml(ctx, agents, inner) {
  const { ui, esc } = ctx, saved = ui.snap.sidebar?.agents || {}, { pinned, rest } = arrange(agents, saved);
  const search = agent => `${agent.name} ${agent.projectSlug || ''}`;
  const rows = (list, isPinned) => list.map(agent => rowHtml(ctx, 'agents', agent, inner(agent), isPinned, search(agent))).join('');
  const local = rest.filter(here), away = rest.filter(agent => !here(agent));
  const filter = agents.length > 6 ? `<label class="rail-filter"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" data-rail-filter="agents" value="${esc(ui.agentFilter || '')}" placeholder="Filter agents or projects" aria-label="Filter agents or projects"></label>` : '';
  return filter
    + (pinned.length ? `${subhead(ctx, 'pinned-agents', 'Pinned', pinned.length, false)}<div class="drag-list" data-list="agents" data-pins="yes">${rows(pinned, true)}</div>` : '')
    + (local.length ? `${subhead(ctx, 'agents-here', 'On this computer', local.length, away.length > 0 || pinned.length > 0)}${ctx.isCollapsed?.('agents-here') ? '' : `<div class="drag-list" data-list="agents">${rows(local, false)}</div>`}` : '')
    + (away.length ? `${subhead(ctx, 'agents-away', 'On other computers', away.length, true)}${ctx.isCollapsed?.('agents-away') ? '' : `<div class="drag-list away" data-list="agents">${rows(away, false)}</div>`}` : '');
}

export function roomListHtml(ctx, rooms, inner) {
  const { ui } = ctx, { pinned, rest } = arrange(rooms, ui.snap.sidebar?.rooms || {});
  const rows = (list, isPinned) => list.map(room => rowHtml(ctx, 'rooms', room, inner(room), isPinned, room.name)).join('');
  return (pinned.length ? `${subhead(ctx, 'pinned-rooms', 'Pinned', pinned.length, false)}<div class="drag-list" data-list="rooms" data-pins="yes">${rows(pinned, true)}</div>` : '')
    + `<div class="drag-list" data-list="rooms">${rows(rest, false)}</div>`;
}

// Hides the rows the filter does not match, without drawing the sidebar again (the cursor stays in the box).
export function applyFilter(root, text) {
  const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const row of root.querySelectorAll('.drag-row[data-drag-kind="agents"]')) row.hidden = words.length > 0 && !words.every(word => row.dataset.search.includes(word));
}

// Saving: the order of every row of that kind as it shows now, and the pins.
async function save(ctx, kind, order, pins) {
  const { ui, api, renderAll, toast } = ctx;
  ui.snap.sidebar = { ...(ui.snap.sidebar || {}), [kind]: { order, pins } }; renderAll();
  try { ui.snap.sidebar = await api('/sidebar', { method: 'POST', data: { kind, order, pins } }); }
  catch (error) { toast(error.message, true); }
}
const currentOrder = kind => [...document.querySelectorAll(`.drag-row[data-drag-kind="${kind}"]`)].map(row => row.dataset.dragId);
const currentPins = (ctx, kind) => [...(ctx.ui.snap.sidebar?.[kind]?.pins || [])];

export function togglePin(ctx, kind, id) {
  const pins = currentPins(ctx, kind), order = currentOrder(kind);
  void save(ctx, kind, order, pins.includes(id) ? pins.filter(item => item !== id) : [...pins, id]);
}

// Moving a row: before or after another row, into or out of the pinned list.
function move(ctx, kind, id, targetId, after, intoPins) {
  let order = currentOrder(kind).filter(item => item !== id), pins = currentPins(ctx, kind).filter(item => item !== id);
  const at = targetId ? order.indexOf(targetId) + (after ? 1 : 0) : order.length;
  order.splice(Math.max(0, at), 0, id);
  if (intoPins) { const pinAt = targetId && pins.includes(targetId) ? pins.indexOf(targetId) + (after ? 1 : 0) : pins.length; pins.splice(pinAt, 0, id); }
  void save(ctx, kind, order, pins);
}

export function initSidebarDrag(ctx) {
  if (initSidebarDrag.done) return; initSidebarDrag.done = true;
  let dragging = null;
  const clear = () => document.querySelectorAll('.drop-before,.drop-after,.drop-pin').forEach(element => element.classList.remove('drop-before', 'drop-after', 'drop-pin'));
  document.addEventListener('dragstart', event => {
    const row = event.target.closest?.('.drag-row'); if (!row) return;
    dragging = { kind: row.dataset.dragKind, id: row.dataset.dragId };
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragging.id);
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  document.addEventListener('dragend', event => { event.target.closest?.('.drag-row')?.classList.remove('dragging'); clear(); dragging = null; });
  document.addEventListener('dragover', event => {
    if (!dragging) return;
    const row = event.target.closest?.('.drag-row'), pinHead = event.target.closest?.('[data-drop-pin="yes"]'), list = event.target.closest?.('.drag-list');
    const same = element => element && (element.dataset.dragKind || element.dataset.list || element.closest('.sec')?.querySelector('.drag-list')?.dataset.list) === dragging.kind;
    if (pinHead && same(pinHead.nextElementSibling)) { event.preventDefault(); clear(); pinHead.classList.add('drop-pin'); return; }
    if (row && row.dataset.dragKind === dragging.kind && row.dataset.dragId !== dragging.id) {
      event.preventDefault(); clear();
      const box = row.getBoundingClientRect(); row.classList.add(event.clientY > box.top + box.height / 2 ? 'drop-after' : 'drop-before');
    } else if (list && list.dataset.list === dragging.kind) event.preventDefault();
  });
  document.addEventListener('drop', event => {
    if (!dragging) return;
    const row = event.target.closest?.('.drag-row'), pinHead = event.target.closest?.('[data-drop-pin="yes"]');
    event.preventDefault();
    if (pinHead) move(ctx, dragging.kind, dragging.id, '', true, true);
    else if (row && row.dataset.dragKind === dragging.kind && row.dataset.dragId !== dragging.id) {
      const after = row.classList.contains('drop-after'), intoPins = Boolean(row.closest('[data-pins="yes"]'));
      move(ctx, dragging.kind, dragging.id, row.dataset.dragId, after, intoPins);
    }
    clear(); dragging = null;
  });
  // Alt+Up / Alt+Down moves the row that has focus, for the keyboard.
  document.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const row = document.activeElement?.closest?.('.drag-row'); if (!row) return;
    event.preventDefault();
    const rows = [...document.querySelectorAll(`.drag-row[data-drag-kind="${row.dataset.dragKind}"]`)], index = rows.indexOf(row), target = rows[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!target) return;
    const id = row.dataset.dragId;
    move(ctx, row.dataset.dragKind, id, target.dataset.dragId, event.key === 'ArrowDown', Boolean(target.closest('[data-pins="yes"]')));
    requestAnimationFrame(() => document.querySelector(`.drag-row[data-drag-id="${CSS.escape(id)}"] .item`)?.focus());
  });
  document.addEventListener('focusin', event => { ctx.ui.filterFocused = Boolean(event.target.closest?.('[data-rail-filter]')); });
  document.addEventListener('input', event => {
    const box = event.target.closest?.('[data-rail-filter]'); if (!box) return;
    ctx.ui.agentFilter = box.value; applyFilter(document, box.value);
  });
}

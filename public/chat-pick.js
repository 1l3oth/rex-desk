// Pickers: a styled list that opens as a popover, in place of the browser's own dropdown. It keeps a hidden input with the chosen value,
// so the rest of the page reads it by id like any field. A picker with an action does something when an item is chosen instead of keeping a value.
const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const actions = {};
let state = null;

export const setPickActions = map => Object.assign(actions, map);
export const pickerOpen = () => Boolean(state);

export function pickerHtml(ctx, { id, name = '', label = '', items, value = '', placeholder = 'Choose…', searchable = false, action = '', compact = false }) {
  const { ui, esc } = ctx, stored = action ? undefined : ui.picks?.[id];
  const current = items.find(item => item.value === (stored ?? value)) || items.find(item => item.value === value) || null;
  return `<span class="pick2 ${compact ? 'compact' : ''}" data-pick="${esc(id)}"><button type="button" class="pick2-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label || placeholder)}"><span class="pick2-label ${current ? '' : 'ph'}">${esc(current ? current.label : placeholder)}</span>${CHEVRON}</button><input type="hidden" id="${esc(id)}" ${name ? `name="${esc(name)}"` : ''} value="${esc(current?.value ?? '')}" data-items="${esc(JSON.stringify(items))}" data-searchable="${searchable ? 1 : 0}" data-action-name="${esc(action)}" data-placeholder="${esc(placeholder)}"></span>`;
}

function visible() { const query = state.query.toLowerCase(); return state.items.filter(item => !query || `${item.label} ${item.hint || ''}`.toLowerCase().includes(query)); }
function draw(ctx) {
  const list = state.pop.querySelector('.pop-list'), shown = visible();
  state.index = Math.max(0, Math.min(state.index, shown.length - 1));
  list.innerHTML = shown.length ? shown.map((item, index) => `<button type="button" role="option" class="pop-item ${item.value === state.input.value ? 'on' : ''} ${index === state.index ? 'act' : ''}" data-i="${index}" ${item.disabled ? 'disabled' : ''}><span class="pop-text"><b>${ctx.esc(item.label)}</b>${item.hint ? `<small>${ctx.esc(item.hint)}</small>` : ''}</span>${item.meta ? `<span class="pop-meta">${ctx.esc(item.meta)}</span>` : ''}${item.value === state.input.value && !state.action ? CHECK : ''}</button>`).join('') : '<div class="pop-empty">Nothing matches.</div>';
  state.shown = shown; state.pop.querySelector('.act')?.scrollIntoView({ block: 'nearest' });
}
function place() {
  const rect = state.button.getBoundingClientRect(), pop = state.pop, room = window.innerHeight - rect.bottom, above = room < 280 && rect.top > room;
  pop.style.minWidth = `${Math.max(rect.width, 240)}px`; pop.style.maxWidth = `${Math.min(420, window.innerWidth - 24)}px`;
  pop.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12))}px`;
  if (above) { pop.style.bottom = `${window.innerHeight - rect.top + 6}px`; pop.style.top = 'auto'; } else { pop.style.top = `${rect.bottom + 6}px`; pop.style.bottom = 'auto'; }
  pop.style.maxHeight = `${Math.max(180, Math.min(360, (above ? rect.top : room) - 16))}px`;
}
export function closePicker() {
  if (!state) return;
  state.button.setAttribute('aria-expanded', 'false'); state.pop.remove(); const focus = state.button; state = null; focus.focus?.();
}
function openPicker(ctx, wrapper) {
  closePicker();
  const input = wrapper.querySelector('input'), button = wrapper.querySelector('button'), items = JSON.parse(input.dataset.items || '[]');
  const pop = document.createElement('div'); pop.className = 'pop'; pop.setAttribute('role', 'listbox');
  pop.innerHTML = `${input.dataset.searchable === '1' ? '<input class="pop-search" placeholder="Search…" autocomplete="off" aria-label="Search">' : ''}<div class="pop-list"></div>`;
  document.body.append(pop); button.setAttribute('aria-expanded', 'true');
  state = { wrapper, input, button, items, pop, query: '', index: Math.max(0, items.findIndex(item => item.value === input.value)), action: input.dataset.actionName };
  draw(ctx); place(); (pop.querySelector('.pop-search') || pop).focus?.();
}
function choose(ctx, item) {
  if (!item || item.disabled || !state) return;
  const { input, wrapper, action } = state, id = input.id; closePicker();
  if (action) { input.value = ''; void actions[action]?.(item.value, ctx); return; }
  input.value = item.value; ctx.ui.picks[id] = item.value;
  wrapper.querySelector('.pick2-label').textContent = item.label; wrapper.querySelector('.pick2-label').classList.remove('ph');
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function initPickers(ctx) {
  ctx.ui.picks = ctx.ui.picks || {};
  document.addEventListener('click', event => {
    const button = event.target.closest('.pick2-btn');
    if (button) { event.preventDefault(); const wrapper = button.closest('.pick2'); if (state?.wrapper === wrapper) closePicker(); else openPicker(ctx, wrapper); return; }
    const item = event.target.closest('.pop-item'); if (item && state) { choose(ctx, state.shown[Number(item.dataset.i)]); return; }
    if (state && !event.target.closest('.pop')) closePicker();
  });
  document.addEventListener('keydown', event => {
    if (!state) return;
    const list = state.shown || [];
    if (event.key === 'Escape') { event.preventDefault(); closePicker(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (list.length) { state.index = (state.index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length; draw(ctx); } }
    else if (event.key === 'Enter') { event.preventDefault(); choose(ctx, list[state.index]); }
  }, true);
  document.addEventListener('input', event => { if (state && event.target.classList?.contains('pop-search')) { state.query = event.target.value; state.index = 0; draw(ctx); } });
  window.addEventListener('resize', closePicker);
  document.addEventListener('scroll', event => { if (state && !event.target.closest?.('.pop')) closePicker(); }, true);
}

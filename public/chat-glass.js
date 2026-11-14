import { updateDeferred } from '/chat-update.js';
// The glass controls: a slider that changes how see-through Rex Desk is while you drag it, and buttons (and Ctrl+B,
// Ctrl+.) that slide the list and the side panel away and back. Choices are remembered on this computer.
const root = document.documentElement;
const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const DEFAULT = 72;

const level = () => { const saved = Number(read('rex-glass', DEFAULT)); return Number.isFinite(saved) ? Math.min(100, Math.max(0, saved)) : DEFAULT; };
function setLevel(value, keep = true) {
  root.style.setProperty('--g', (value / 100).toFixed(2));
  if (keep) save('rex-glass', String(value));
}
const paneOff = pane => root.classList.contains(`${pane}-off`);
function setPane(pane, off, keep = true) {
  root.classList.toggle(`${pane}-off`, off);
  if (keep) save(`rex-${pane}-off`, off ? '1' : '');
  for (const button of document.querySelectorAll(`[data-pane="${pane}"]`)) button.setAttribute('aria-pressed', String(!off));
}

setLevel(level(), false);
setPane('rail', read('rex-rail-off', '') === '1', false);
setPane('side', read('rex-side-off', '') === '1', false);

function openSlider(anchor) {
  document.querySelector('.glass-pop')?.remove();
  const pop = document.createElement('div'); pop.className = 'glass-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Glass');
  pop.innerHTML = `<h3>Glass <output>${level()}%</output></h3><p>How see-through Rex Desk is.</p>
    <input type="range" min="0" max="100" step="1" value="${level()}" aria-label="Transparency">
    <div class="glass-ends"><span>Solid</span><span>Clear</span></div>
    <div class="glass-row"><button type="button" data-glass="0">Solid</button><button type="button" data-glass="${DEFAULT}">Default</button><button type="button" data-glass="100">Clear</button></div>`;
  document.body.append(pop);
  const box = anchor.getBoundingClientRect(), width = 264;
  pop.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, box.left))}px`;
  pop.style.bottom = `${Math.max(12, innerHeight - box.top + 8)}px`;
  const range = pop.querySelector('input'), output = pop.querySelector('output');
  // Dragging changes one CSS variable and nothing else: no script draws anything again, so it follows the pointer.
  range.addEventListener('input', () => { setLevel(Number(range.value)); output.textContent = `${range.value}%`; });
  pop.addEventListener('click', event => { const preset = event.target.closest('[data-glass]'); if (!preset) return; range.value = preset.dataset.glass; range.dispatchEvent(new Event('input')); });
  const close = event => {
    if (event.type === 'keydown' ? event.key !== 'Escape' : pop.contains(event.target) || event.target.closest('[data-glass-open]')) return;
    pop.remove(); removeEventListener('pointerdown', close, true); removeEventListener('keydown', close, true);
  };
  addEventListener('pointerdown', close, true); addEventListener('keydown', close, true);
  range.focus();
}

document.addEventListener('click', event => {
  const open = event.target.closest('[data-glass-open]');
  if (open) { const shown = document.querySelector('.glass-pop'); if (shown) shown.remove(); else openSlider(open); return; }
  const toggle = event.target.closest('[data-pane]');
  if (toggle) setPane(toggle.dataset.pane, !paneOff(toggle.dataset.pane));
});
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (event.key.toLowerCase() === 'b') { event.preventDefault(); setPane('rail', !paneOff('rail')); }
  else if (event.key === '.') { event.preventDefault(); setPane('side', !paneOff('side')); }
});
// The app redraws its header and list from time to time: keep the buttons' pressed state right, and tell the
// stylesheet how wide the side panel is so the chat takes exactly that room back.
let paneQueued = false;
new MutationObserver(() => { if (paneQueued) return; paneQueued = true; requestAnimationFrame(() => { paneQueued = false; syncPanes(); }); }).observe(document.body, { childList: true, subtree: true });
let badgeShown = -1;
function syncBar() {
  const snap = window.__rexCtx?.ui?.snap; if (!snap) return;
  const waiting = (snap.notices?.unread || 0) + (snap.interactions || []).filter(item => item.state === 'pending').length;
  if (shell && waiting !== badgeShown) { badgeShown = waiting; window.open(`https://rexdesk.window/badge?n=${waiting}`, '_blank'); }
  const working = (snap.specialists || []).filter(agent => ['busy', 'replying'].includes(agent.status?.state)).length + ((snap.runs || []).some(run => run.role === 'coordinator' && run.main && ['starting', 'running', 'queued', 'verifying'].includes(run.state)) ? 1 : 0);
  // An update put off with Later waits here as a small button; pressing it opens the card again.
  const update = document.querySelector('.win-update'), deferred = updateDeferred(snap.update) && !document.getElementById('update-card') ? updateDeferred(snap.update) : '';
  if (update) { update.hidden = !deferred; const title = deferred ? `Rex Desk ${deferred} is ${snap.update?.ready ? 'ready to install' : 'downloading'}` : ''; if (update.title !== title) update.title = title; }
  const pill = document.querySelector('.win-working'); if (pill) { pill.hidden = !working; const text = `${working} working`; if (pill.lastElementChild.textContent !== text) pill.lastElementChild.textContent = text; }
  const badge = document.querySelector('.win-bell b'), unread = snap.notices?.unread || 0; if (badge) { badge.hidden = !unread; const text = unread > 99 ? '99+' : String(unread); if (badge.textContent !== text) badge.textContent = text; }
}
function syncPanes() {
  syncBar();
  for (const pane of ['rail', 'side']) for (const button of document.querySelectorAll(`[data-pane="${pane}"]`)) { const pressed = String(!paneOff(pane)); if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed); }
  const side = document.querySelector('.stage > .side.on');
  if (side && !paneOff('side')) { const width = `${side.offsetWidth}px`; if (root.style.getPropertyValue('--side-w') !== width) root.style.setProperty('--side-w', width); }
}

// The desktop app's own window bar. Windows: no system title bar, so Rex Desk draws minimize, maximize and close in glass.
// Mac: the three dots stay where they are, over the left end of the same bar. In a plain browser nothing is added.
// A button asks the app by opening https://rexdesk.window/<action>; the app does it and no window opens.
const shell = document.documentElement.classList.contains('embed') ? '' : window.__REX_SHELL;
if (shell === 'windows' || shell === 'macos') {
  const ask = action => { window.open(`https://rexdesk.window/${action}`, '_blank'); };
  const bar = document.createElement('div');
  bar.className = `win-bar ${shell}`; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Window');
  // The Rex Desk name sits in the window bar, where a window's title belongs; the list below starts with Rex Agent.
  const brand = '<span class="win-brand"><img src="/favicon.svg" alt="" width="20" height="20"><b>Rex Desk</b></span>';
  const mac = shell === 'macos', key = mac ? '⌘ K' : 'Ctrl K';
  const middle = `<span class="win-fill"></span><button type="button" class="win-search" data-palette-open title="Search or jump to anything (${key})"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Search or jump to a chat, agent or task</span><kbd>${key}</kbd></button><span class="win-fill"></span>
    <button type="button" class="win-update" data-action="update-show" hidden><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><span>Update</span></button>
    <button type="button" class="win-working" data-open="main" data-id="" hidden title="Agents working right now"><i></i><span></span></button>
    <button type="button" class="win-bell tile" data-action="nt-panel" aria-label="Notifications" title="Notifications"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><b hidden></b></button>`;
  bar.innerHTML = shell === 'windows' ? `${brand}${middle}
    <button type="button" class="win-btn" data-win="minimize" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.5h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
    <button type="button" class="win-btn" data-win="maximize" aria-label="Maximize or restore" title="Maximize"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></button>
    <button type="button" class="win-btn close" data-win="close" aria-label="Close" title="Close (Rex Desk keeps running in the tray)"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`
    : `${brand}${middle}`;
  document.documentElement.classList.add('has-win-bar', `shell-${shell}`);
  document.body.prepend(bar);
  bar.addEventListener('click', event => { const button = event.target.closest('[data-win]'); if (button) ask(button.dataset.win); });
  // Dragging the empty bar moves the window; a double click maximizes or restores it.
  bar.addEventListener('mousedown', event => { if (event.button === 0 && !event.target.closest('button') && event.detail === 1) ask('drag'); });
  bar.addEventListener('dblclick', event => { if (!event.target.closest('button')) ask('maximize'); });
}

// Each theme's own layer behind the app: Cyberpunk's grid, Gojo's stars and ring, Crayon's doodles, Sakura's petals.
// Crayon also needs a small SVG filter that makes lines look drawn by hand.
const fx = document.createElement('div'); fx.className = 'skin-fx'; fx.setAttribute('aria-hidden', 'true');
document.body.prepend(fx);
const rough = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
rough.setAttribute('width', '0'); rough.setAttribute('height', '0'); rough.setAttribute('aria-hidden', 'true');
rough.innerHTML = '<filter id="crayon-rough"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="4"/></filter>';
document.body.append(rough);
function dressSkin() {
  fx.replaceChildren();
  if (root.dataset.skin !== 'sakura' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let i = 0; i < 18; i++) {
    const petal = document.createElement('i');
    petal.style.left = `${(i * 53) % 100}%`; petal.style.animationDuration = `${11 + (i * 7) % 9}s`; petal.style.animationDelay = `${-((i * 1.7) % 14)}s`;
    petal.style.setProperty('--dx', `${((i % 5) - 2) * 60}px`); petal.style.setProperty('--turn', `${360 + (i % 4) * 120}deg`);
    petal.style.scale = String(0.6 + (i % 4) * 0.2);
    fx.append(petal);
  }
}
dressSkin();
new MutationObserver(dressSkin).observe(root, { attributes: true, attributeFilter: ['data-skin'] });


// Settings > General > Look: picking a theme changes the app at once.
const paintSwatches = () => { for (const button of document.querySelectorAll('.st-skin:not([data-painted])')) { button.dataset.painted = '1'; button.style.setProperty('--a', button.dataset.a); button.style.setProperty('--b', button.dataset.b); button.style.setProperty('--base', button.dataset.base); } };
const onceAFrame = fn => { let queued = false; return () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(); }); }; };
new MutationObserver(onceAFrame(paintSwatches)).observe(document.body, { childList: true, subtree: true });
document.addEventListener('click', event => {
  const pick = event.target.closest('[data-st-skin]'); if (!pick) return;
  window.rexSkin?.set(pick.dataset.stSkin);
  for (const button of document.querySelectorAll('[data-st-skin]')) { const on = button === pick; button.classList.toggle('on', on); button.setAttribute('aria-checked', String(on)); }
});
// Effects stop while Rex Desk is hidden or minimised, so a theme never uses the computer when nobody is looking.
const rest = () => root.classList.toggle('fx-rest', document.hidden);
document.addEventListener('visibilitychange', rest); rest();


// Warm countdowns in the list tick once a second in place: only their text changes, nothing is drawn again.
const tickWarm = () => {
  for (const item of document.querySelectorAll('.item[data-warm]')) {
    const left = Math.round((new Date(item.dataset.warm).getTime() - Date.now()) / 1000), sub = item.querySelector('.sub');
    if (!sub) continue;
    if (!sub.dataset.base) sub.dataset.base = sub.textContent.replace(/^Asleep · ?/, '');
    if (left <= 0) { item.removeAttribute('data-warm'); sub.textContent = sub.dataset.base ? `Asleep · ${sub.dataset.base}` : 'Asleep'; item.title = 'Asleep: not running and using no memory. Its cache has gone cold, so the next message starts from scratch.'; continue; }
    const text = `Warm ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (sub.textContent !== text) sub.textContent = text;
    item.title = `Asleep, cache still warm for ${Math.ceil(left / 60)} min: a message now is quicker and cheaper.`;
    item.style.setProperty('--warm', String(Math.max(0, Math.min(1, left / Number(item.dataset.ttl || 300)))));
  }
};
setInterval(() => { if (!document.hidden) tickWarm(); }, 1000);
new MutationObserver(onceAFrame(tickWarm)).observe(document.body, { childList: true, subtree: true });

document.addEventListener('click', event => {
  const pick = event.target.closest('[data-st-size]'); if (!pick) return;
  window.rexSize?.set(pick.dataset.stSize);
  for (const button of document.querySelectorAll('[data-st-size]')) { const on = button === pick; button.classList.toggle('on', on); button.setAttribute('aria-checked', String(on)); }
});

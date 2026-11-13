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
new MutationObserver(() => {
  for (const pane of ['rail', 'side']) for (const button of document.querySelectorAll(`[data-pane="${pane}"]`)) { const pressed = String(!paneOff(pane)); if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed); }
  const side = document.querySelector('.stage > .side.on');
  if (side && !paneOff('side')) { const width = `${side.offsetWidth}px`; if (root.style.getPropertyValue('--side-w') !== width) root.style.setProperty('--side-w', width); }
}).observe(document.body, { childList: true, subtree: true });

// The desktop app's own window bar. Windows: no system title bar, so Rex Desk draws minimize, maximize and close in glass.
// Mac: the three dots stay where they are, over the left end of the same bar. In a plain browser nothing is added.
// A button asks the app by opening https://rexdesk.window/<action>; the app does it and no window opens.
const shell = window.__REX_SHELL;
if (shell === 'windows' || shell === 'macos') {
  const ask = action => { window.open(`https://rexdesk.window/${action}`, '_blank'); };
  const bar = document.createElement('div');
  bar.className = `win-bar ${shell}`; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Window');
  bar.innerHTML = shell === 'windows' ? `<span class="win-fill"></span>
    <button type="button" class="win-btn" data-win="minimize" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.5h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
    <button type="button" class="win-btn" data-win="maximize" aria-label="Maximize or restore" title="Maximize"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></button>
    <button type="button" class="win-btn close" data-win="close" aria-label="Close" title="Close (Rex Desk keeps running in the tray)"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`
    : '<span class="win-fill"></span>';
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

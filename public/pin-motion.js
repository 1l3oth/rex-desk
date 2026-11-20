// Motion for pinning: rows glide to their new place (FLIP), the pin icon gets a short press, and a pin made in a chat flies
// to the Pinned tab, which nods. Web Animations only (the page blocks inline style attributes; values set from code are fine).
// Short and ease-out; with reduced motion nothing moves, and only a quick fade confirms the change.
const EASE = 'cubic-bezier(.16,1,.3,1)';
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const visible = rect => rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;

// Measures every element that has a key, runs change() (which draws the screen again), then moves each element from where it
// was to where it is now. New elements fade in; elements off screen are left alone, so long lists stay cheap.
export function flip(selector, keyOf, change) {
  const before = new Map();
  for (const element of document.querySelectorAll(selector)) { const key = keyOf(element), rect = element.getBoundingClientRect(); if (key && visible(rect)) before.set(key, rect); }
  const result = change();
  const settle = () => {
    for (const element of document.querySelectorAll(selector)) {
      const key = keyOf(element), now = element.getBoundingClientRect(); if (!key || !visible(now)) continue;
      const was = before.get(key);
      if (reduced()) { if (!was || Math.abs(was.top - now.top) > 2) element.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: 'linear' }); continue; }
      if (!was) { element.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE }); continue; }
      const dx = was.left - now.left, dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: Math.min(320, 200 + Math.abs(dy) / 8), easing: EASE });
    }
  };
  if (result && typeof result.then === 'function') return result.then(value => { settle(); return value; });
  settle(); return result;
}

// The pin icon's press: a small tilt and drop, then it settles. The icon moves, not its button, so the button keeps its place.
export function press(button) {
  const icon = button?.querySelector?.('svg') || button; if (!icon?.animate) return null;
  if (reduced()) return icon.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 140 });
  return icon.animate([
    { transform: 'rotate(0deg) translateY(0) scale(1)' },
    { transform: 'rotate(-24deg) translateY(1.5px) scale(.86)', offset: 0.38 },
    { transform: 'rotate(4deg) translateY(0) scale(1.04)', offset: 0.72 },
    { transform: 'rotate(0deg) translateY(0) scale(1)' },
  ], { duration: 280, easing: EASE });
}

// A nod for whatever received the pin (the Pinned tab, its count).
export function bump(target) {
  if (!target?.animate) return;
  if (reduced()) { target.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 180 }); return; }
  target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 260, easing: EASE });
}

// A small pin flies from where it was pinned to the Pinned tab, shrinking and fading as it lands.
const PIN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/></svg>';
export function fly(from, target) {
  if (!from || !target) return Promise.resolve();
  const to = target.getBoundingClientRect(); if (!visible(to)) return Promise.resolve();
  if (reduced()) { bump(target); return Promise.resolve(); }
  const dot = document.createElement('span'); dot.className = 'pin-fly'; dot.setAttribute('aria-hidden', 'true'); dot.innerHTML = PIN;
  const size = 24, startX = from.left + from.width / 2 - size / 2, startY = from.top + from.height / 2 - size / 2;
  dot.style.left = `${startX}px`; dot.style.top = `${startY}px`; document.body.append(dot);
  const dx = to.left + to.width / 2 - size / 2 - startX, dy = to.top + to.height / 2 - size / 2 - startY, lift = Math.min(60, Math.abs(dx) / 4 + 18);
  const run = dot.animate([
    { transform: 'translate(0, 0) scale(.6)', opacity: 0 },
    { transform: `translate(${dx * 0.12}px, ${dy * 0.12 - 10}px) scale(1)`, opacity: 1, offset: 0.18 },
    { transform: `translate(${dx * 0.6}px, ${dy * 0.6 - lift}px) scale(.9)`, opacity: 1, offset: 0.6 },
    { transform: `translate(${dx}px, ${dy}px) scale(.45)`, opacity: 0.2 },
  ], { duration: 420, easing: 'cubic-bezier(.3,.7,.2,1)' });
  return run.finished.catch(() => {}).then(() => { dot.remove(); bump(target); });
}

// A row about to go away (unpinned from the Pinned list): it slips out before the list closes the gap.
export function leave(element) {
  if (!element?.animate) return Promise.resolve();
  const run = reduced() ? element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' })
    : element.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(10px)' }], { duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  return run.finished.catch(() => {});
}

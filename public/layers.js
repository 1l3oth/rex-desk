// Popups stack in the order they open: one opened from inside another (a dialog from the agent profile, a confirm box
// from a dialog) always sits on top of it, never behind. The window bar (90) and the search palette (95) stay above all.
const LAYERS = '.dialog-back, .agp-modal';
const depth = el => Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
export function liftLayer(el) {
  const top = Math.max(0, ...[...document.querySelectorAll(LAYERS)].filter(other => other !== el).map(depth));
  if (depth(el) <= top) el.style.zIndex = String(Math.min(top + 1, 89));
}
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches(LAYERS)) liftLayer(node);
}).observe(document.body, { childList: true });

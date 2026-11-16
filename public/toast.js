// A short notice at the bottom of the window. It opens in the top layer (a manual popover), so no dialog, backdrop,
// file window or full page view can cover it, and it is shown again each time so it lands above anything opened since.
let timer;
export function showToast(text, bad = false, ms = 4000) {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const layered = typeof box.showPopover === 'function';
  if (layered && !box.hasAttribute('popover')) box.setAttribute('popover', 'manual');
  box.textContent = text;
  box.className = bad ? 'bad' : '';
  if (layered) { if (box.matches(':popover-open')) box.hidePopover(); box.showPopover(); }
  void box.offsetWidth; // start the fade-in from the hidden state
  box.className = `on${bad ? ' bad' : ''}`;
  clearTimeout(timer);
  timer = setTimeout(() => {
    box.className = bad ? 'bad' : '';
    timer = setTimeout(() => { if (layered && box.matches(':popover-open')) box.hidePopover(); }, 250);
  }, ms);
}

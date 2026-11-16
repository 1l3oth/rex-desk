// A picture in a chat opens here, full screen inside Rex Desk: the desktop app has no browser tab to open it in.
// Arrows step through the other pictures of the same chat; Esc or a click beside the picture closes it.
const state = { list: [], index: 0, actual: false, view: { k: 1, x: 0, y: 0 }, pointers: new Map(), moved: false };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const ICON = {
  close: '<path d="M6 6l12 12M18 6 6 18"/>', prev: '<path d="M15 5l-7 7 7 7"/>', next: '<path d="M9 5l7 7-7 7"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M11 8v6M8 11h6"/>', fit: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M8 11h6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', save: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

function box() {
  let dialog = document.getElementById('img-viewer');
  if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'img-viewer'; dialog.className = 'iv'; dialog.setAttribute('aria-label', 'Picture'); document.body.append(dialog); }
  return dialog;
}
function draw() {
  const dialog = box(), item = state.list[state.index], many = state.list.length > 1;
  const name = item.alt || decodeURIComponent(item.src.split('?')[0].split('/').pop()).replace(/^\d{10,}-/, '');
  dialog.innerHTML = `<div class="iv-head"><strong title="${esc(name)}">${esc(name)}</strong>${many ? `<span class="iv-count">${state.index + 1} / ${state.list.length}</span>` : ''}<span class="iv-sp"></span>
      <button type="button" class="iv-btn" data-iv="zoom" title="${state.actual ? 'Fit to the window' : 'Actual size'}" aria-label="${state.actual ? 'Fit to the window' : 'Actual size'}">${svg(state.actual ? 'fit' : 'zoom')}</button>
      <button type="button" class="iv-btn" data-iv="file" title="Open in the file window" aria-label="Open in the file window">${svg('file')}</button>
      <a class="iv-btn" href="${esc(item.src)}" download title="Save" aria-label="Save">${svg('save')}</a>
      <button type="button" class="iv-btn" data-iv="close" title="Close (Esc)" aria-label="Close">${svg('close')}</button></div>
    <div class="iv-stage" data-iv="backdrop"><img src="${esc(item.src)}" alt="${esc(name)}" data-iv="image" draggable="false"></div>
    ${many ? `<button type="button" class="iv-nav prev" data-iv="prev" aria-label="Previous picture">${svg('prev')}</button><button type="button" class="iv-nav next" data-iv="next" aria-label="Next picture">${svg('next')}</button>` : ''}`;
}
export function openImage(src, scope = document) {
  const all = [...scope.querySelectorAll('img.md-media')].map(img => ({ src: img.getAttribute('src'), alt: img.getAttribute('alt') || '' }));
  const list = all.some(item => item.src === src) ? all : [{ src, alt: '' }];
  Object.assign(state, { list, index: Math.max(0, list.findIndex(item => item.src === src)), actual: false });
  state.view = { k: 1, x: 0, y: 0 }; draw(); const dialog = box(); if (!dialog.dataset.gestures) { dialog.dataset.gestures = '1'; wireGestures(dialog); } if (!dialog.open) dialog.showModal();
}
function step(by) { if (state.list.length > 1) { state.index = (state.index + by + state.list.length) % state.list.length; state.actual = false; state.view = { k: 1, x: 0, y: 0 }; draw(); } }

// Zoom and pan: pinch with two fingers, drag with one when zoomed in, the mouse wheel, or a tap or click on the picture
// (2.5x at that spot, and back to fit). The picture moves by transform, so the page never scrolls under the finger.
const MAX = 8;
function apply(smooth = true) {
  const image = document.querySelector('#img-viewer .iv-stage img'); if (!image) return;
  image.style.transition = smooth ? '' : 'none'; // a finger moves it at once; a tap or the wheel eases
  const { k, x, y } = state.view; state.actual = k > 1.01;
  image.style.transform = `translate(${x}px, ${y}px) scale(${k})`; image.classList.toggle('zoomed', state.actual);
  const zoom = document.querySelector('#img-viewer [data-iv="zoom"]'); if (zoom) { const label = state.actual ? 'Fit to the window' : 'Zoom in'; zoom.title = label; zoom.setAttribute('aria-label', label); zoom.innerHTML = svg(state.actual ? 'fit' : 'zoom'); }
}
// Zoom to k keeping the point (px, py) of the stage (from its centre) still.
function zoomAt(k, px = 0, py = 0) {
  const view = state.view, next = Math.min(MAX, Math.max(1, k));
  if (next === 1) { state.view = { k: 1, x: 0, y: 0 }; apply(); return; }
  state.view = { k: next, x: px - (px - view.x) * next / view.k, y: py - (py - view.y) * next / view.k }; apply();
}
const fromCentre = (stage, event) => { const box = stage.getBoundingClientRect(); return [event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2]; };
function wireGestures(dialog) {
  dialog.addEventListener('pointerdown', event => {
    const stage = event.target.closest('.iv-stage'); if (!stage) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); state.moved = false;
    if (state.pointers.size === 2) { const [a, b] = [...state.pointers.values()]; state.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: state.view.k, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, x: state.view.x, y: state.view.y }; }
    stage.setPointerCapture?.(event.pointerId);
  });
  dialog.addEventListener('pointermove', event => {
    const stage = dialog.querySelector('.iv-stage'), last = state.pointers.get(event.pointerId); if (!stage || !last) return;
    const dx = event.clientX - last.x, dy = event.clientY - last.y; state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (Math.abs(dx) + Math.abs(dy) > 1) state.moved = true;
    if (state.pointers.size >= 2 && state.pinch) {
      const [a, b] = [...state.pointers.values()], pinch = state.pinch, d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const box = stage.getBoundingClientRect(), mx = (a.x + b.x) / 2 - box.left - box.width / 2, my = (a.y + b.y) / 2 - box.top - box.height / 2;
      const k = Math.min(MAX, Math.max(1, pinch.k * d / pinch.d)), ox = pinch.mx - box.left - box.width / 2, oy = pinch.my - box.top - box.height / 2;
      state.view = k === 1 ? { k: 1, x: 0, y: 0 } : { k, x: mx - (ox - pinch.x) * k / pinch.k, y: my - (oy - pinch.y) * k / pinch.k }; apply(false);
    } else if (state.view.k > 1) { state.view = { ...state.view, x: state.view.x + dx, y: state.view.y + dy }; apply(false); }
  });
  const end = event => { state.pointers.delete(event.pointerId); if (state.pointers.size < 2) state.pinch = null; };
  dialog.addEventListener('pointerup', end); dialog.addEventListener('pointercancel', end);
  dialog.addEventListener('wheel', event => {
    const stage = event.target.closest('.iv-stage'); if (!stage) return;
    event.preventDefault(); const [px, py] = fromCentre(stage, event); zoomAt(state.view.k * Math.exp(-event.deltaY * 0.0018), px, py);
  }, { passive: false });
}

export function wireImageViewer() {
  document.addEventListener('click', event => {
    const image = event.target.closest?.('img.md-media'); if (!image || image.closest('#img-viewer')) return;
    event.preventDefault(); event.stopPropagation();
    openImage(image.getAttribute('src'), image.closest('#feed-inner, .side-body') || document);
  }, true);
  document.addEventListener('click', event => {
    const dialog = document.getElementById('img-viewer'); if (!dialog?.open || !dialog.contains(event.target)) return;
    const act = event.target.closest('[data-iv]')?.dataset.iv;
    // The end of a drag or a pinch is not a click: it neither closes the viewer nor zooms.
    if (state.moved && (act === 'backdrop' || act === 'image')) { state.moved = false; return; }
    if (act === 'close' || act === 'backdrop' || event.target === dialog) dialog.close();
    else if (act === 'prev') step(-1); else if (act === 'next') step(1);
    else if (act === 'zoom') zoomAt(state.view.k > 1.01 ? 1 : 2.5);
    else if (act === 'image') { const stage = event.target.closest('.iv-stage'), [px, py] = fromCentre(stage, event); zoomAt(state.view.k > 1.01 ? 1 : 2.5, px, py); }
    else if (act === 'file') { const src = state.list[state.index].src; dialog.close(); window.rexOpenFile?.(src, { view: 'preview' }); }
  });
  document.addEventListener('keydown', event => {
    const dialog = document.getElementById('img-viewer'); if (!dialog?.open) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); } else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
  });
}

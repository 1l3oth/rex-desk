// A picture in a chat opens here, full screen inside Rex Desk: the desktop app has no browser tab to open it in.
// Arrows step through the other pictures of the same chat; Esc or a click beside the picture closes it.
const state = { list: [], index: 0, actual: false };
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
    <div class="iv-stage${state.actual ? ' actual' : ''}" data-iv="backdrop"><img src="${esc(item.src)}" alt="${esc(name)}" data-iv="image"></div>
    ${many ? `<button type="button" class="iv-nav prev" data-iv="prev" aria-label="Previous picture">${svg('prev')}</button><button type="button" class="iv-nav next" data-iv="next" aria-label="Next picture">${svg('next')}</button>` : ''}`;
}
export function openImage(src, scope = document) {
  const all = [...scope.querySelectorAll('img.md-media')].map(img => ({ src: img.getAttribute('src'), alt: img.getAttribute('alt') || '' }));
  const list = all.some(item => item.src === src) ? all : [{ src, alt: '' }];
  Object.assign(state, { list, index: Math.max(0, list.findIndex(item => item.src === src)), actual: false });
  draw(); const dialog = box(); if (!dialog.open) dialog.showModal();
}
function step(by) { if (state.list.length > 1) { state.index = (state.index + by + state.list.length) % state.list.length; state.actual = false; draw(); } }

export function wireImageViewer() {
  document.addEventListener('click', event => {
    const image = event.target.closest?.('img.md-media'); if (!image || image.closest('#img-viewer')) return;
    event.preventDefault(); event.stopPropagation();
    openImage(image.getAttribute('src'), image.closest('#feed-inner, .side-body') || document);
  }, true);
  document.addEventListener('click', event => {
    const dialog = document.getElementById('img-viewer'); if (!dialog?.open || !dialog.contains(event.target)) return;
    const act = event.target.closest('[data-iv]')?.dataset.iv;
    if (act === 'close' || act === 'backdrop' || event.target === dialog) dialog.close();
    else if (act === 'prev') step(-1); else if (act === 'next') step(1);
    else if (act === 'zoom' || act === 'image') { state.actual = !state.actual; draw(); }
    else if (act === 'file') { const src = state.list[state.index].src; dialog.close(); window.rexOpenFile?.(src, { view: 'preview' }); }
  });
  document.addEventListener('keydown', event => {
    const dialog = document.getElementById('img-viewer'); if (!dialog?.open) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); } else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
  });
}

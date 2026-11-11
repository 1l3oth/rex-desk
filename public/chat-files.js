// The file window: any file opens here in a tab, from a path in a chat, a file an agent shows, or the Files list.
// Code and text open in an editor (CodeMirror 5, served from the installed package) with save and Prettier; Markdown, HTML
// and CSV also have a preview; pictures, videos, sound, PDFs, Excel and Word files have a viewer. The window can shrink to
// a small button and come back with its tabs as they were.
import { markdown } from '/chat-markdown.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const state = { tabs: [], active: -1, shown: false, big: false, ctx: null, lastShown: null };
const editors = new Map();
const PREVIEW = new Set(['markdown', 'html', 'csv']);

// ---------- CodeMirror, loaded on first use ----------
const MODES = {
  js: ['javascript'], mjs: ['javascript'], cjs: ['javascript'], json: ['javascript', { name: 'javascript', json: true }], jsonc: ['javascript', { name: 'javascript', json: true }],
  ts: ['javascript', 'text/typescript'], tsx: ['javascript', 'jsx', 'text/typescript-jsx'], jsx: ['javascript', 'xml', 'jsx', 'jsx'], mts: ['javascript', 'text/typescript'],
  css: ['css'], scss: ['css', 'text/x-scss'], less: ['css', 'text/x-less'],
  html: ['xml', 'javascript', 'css', 'htmlmixed'], htm: ['xml', 'javascript', 'css', 'htmlmixed'], vue: ['xml', 'javascript', 'css', 'htmlmixed'], jsp: ['xml', 'javascript', 'css', 'htmlmixed'],
  xml: ['xml'], svg: ['xml'], md: ['markdown'], markdown: ['markdown'], mdx: ['markdown'], yaml: ['yaml'], yml: ['yaml'],
  py: ['python'], java: ['clike', 'text/x-java'], kt: ['clike', 'text/x-kotlin'], scala: ['clike', 'text/x-scala'], c: ['clike', 'text/x-csrc'], h: ['clike', 'text/x-csrc'],
  cpp: ['clike', 'text/x-c++src'], hpp: ['clike', 'text/x-c++src'], cs: ['clike', 'text/x-csharp'], go: ['go'], rs: ['rust'], rb: ['ruby'], lua: ['lua'], swift: ['swift'],
  php: ['xml', 'javascript', 'css', 'htmlmixed', 'clike', 'php', 'application/x-httpd-php'], sql: ['sql', 'text/x-sql'], sh: ['shell'], bash: ['shell'], zsh: ['shell'],
  ps1: ['powershell'], psm1: ['powershell'], properties: ['properties'], ini: ['properties'], env: ['properties'], toml: ['toml'], dockerfile: ['dockerfile'], diff: ['diff'], patch: ['diff'],
  gradle: ['groovy'], groovy: ['groovy'], r: ['r'], dart: ['dart'], graphql: ['javascript'],
};
const ADDONS = ['addon/mode/simple.js', 'addon/edit/matchbrackets.js', 'addon/edit/closebrackets.js', 'addon/selection/active-line.js', 'addon/dialog/dialog.js', 'addon/search/searchcursor.js', 'addon/search/search.js', 'addon/search/jump-to-line.js'];
const loaded = new Map();
function load(src) {
  if (loaded.has(src)) return loaded.get(src);
  const done = new Promise((resolve, reject) => {
    if (src.endsWith('.css')) { const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: src }); link.onload = resolve; link.onerror = reject; document.head.append(link); return; }
    const script = Object.assign(document.createElement('script'), { src, async: false }); script.onload = resolve; script.onerror = () => reject(new Error(`Could not load ${src}`)); document.head.append(script);
  });
  loaded.set(src, done); return done;
}
async function codeMirror(ext) {
  await Promise.all([load('/vendor/codemirror/lib/codemirror.css'), load('/vendor/codemirror/addon/dialog/dialog.css')]);
  await load('/vendor/codemirror/lib/codemirror.js');
  for (const addon of ADDONS) await load(`/vendor/codemirror/${addon}`);
  const spec = MODES[ext] || [], modes = spec.filter(item => typeof item === 'string' && !item.includes('/'));
  for (const mode of modes) await load(`/vendor/codemirror/mode/${mode}/${mode}.js`).catch(() => {});
  const last = spec[spec.length - 1];
  return typeof last === 'object' || (typeof last === 'string' && last.includes('/')) ? last : modes[modes.length - 1] || null;
}

// ---------- opening ----------
const extOf = name => { const lower = name.toLowerCase(); return lower === 'dockerfile' ? 'dockerfile' : lower.includes('.') ? lower.split('.').pop() : ''; };
const remember = () => { try { localStorage.setItem('rex-desk-files', JSON.stringify({ paths: state.tabs.map(tab => tab.path), active: state.active, shown: state.shown })); } catch { /* private window */ } };
export async function openFile(ctx, input, { line = 0, run = '', room = '' } = {}) {
  state.ctx = ctx;
  try {
    const info = await ctx.api(`/files/open?path=${encodeURIComponent(input)}${run ? `&run=${encodeURIComponent(run)}` : ''}${room ? `&room=${encodeURIComponent(room)}` : ''}`);
    let index = state.tabs.findIndex(tab => tab.path === info.path);
    if (index < 0) { state.tabs.push({ ...info, saved: info.text, view: info.kind === 'html' || info.kind === 'csv' ? 'code' : info.kind === 'markdown' ? 'preview' : 'code' }); index = state.tabs.length - 1; }
    const tab = state.tabs[index]; tab.line = line || info.line || 0;
    state.active = index; state.shown = true; remember(); draw();
  } catch (error) { ctx.toast(error.message, true); }
}
function closeTab(index) {
  const tab = state.tabs[index]; if (!tab) return;
  if (dirty(tab) && !confirm(`${tab.name} has changes that are not saved. Close it anyway?`)) return;
  editors.get(tab.path)?.wrap.remove(); editors.delete(tab.path);
  state.tabs.splice(index, 1);
  if (state.active >= state.tabs.length) state.active = state.tabs.length - 1;
  if (!state.tabs.length) state.shown = false;
  remember(); draw();
}
const dirty = tab => { const editor = editors.get(tab.path)?.cm; return Boolean(editor && tab.editable && editor.getValue() !== tab.saved); };

// ---------- actions ----------
async function save(tab, force = false) {
  const { api, toast } = state.ctx, editor = editors.get(tab.path)?.cm; if (!editor) return;
  const text = editor.getValue();
  try {
    const result = await api('/files/save', { method: 'POST', data: { path: tab.path, text, mtime: tab.mtime, force } });
    tab.saved = text; tab.text = text; tab.mtime = result.mtime; toast(`Saved ${tab.name}.`); drawChrome(); if (tab.view === 'preview') drawBody();
  } catch (error) {
    if (/changed this file after you opened it/.test(error.message)) { if (confirm(`${tab.name} changed on disk after you opened it. Save your version over it?`)) return save(tab, true); return; }
    toast(error.message, true);
  }
}
async function format(tab) {
  const { api, toast } = state.ctx, editor = editors.get(tab.path)?.cm; if (!editor) return;
  try {
    const { text } = await api('/files/format', { method: 'POST', data: { path: tab.path, text: editor.getValue() } });
    if (text === editor.getValue()) return toast('Already formatted.');
    const cursor = editor.getCursor(), top = editor.getScrollInfo().top;
    editor.operation(() => { editor.setValue(text); editor.setCursor(cursor); editor.scrollTo(null, top); });
    toast('Formatted with Prettier. Save to keep it.'); drawChrome();
  } catch (error) { toast(error.message.split('\n')[0], true); }
}
async function reload(tab) {
  if (dirty(tab) && !confirm(`Throw away your changes to ${tab.name} and load it from disk?`)) return;
  const info = await state.ctx.api(`/files/open?path=${encodeURIComponent(tab.path)}`);
  Object.assign(tab, info, { saved: info.text }); const editor = editors.get(tab.path)?.cm; if (editor) editor.setValue(info.text ?? '');
  draw();
}

// ---------- drawing ----------
const raw = (tab, extra = '') => `/api/files/raw?path=${encodeURIComponent(tab.path)}${extra}`;
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
const ICON = { image: 'IMG', video: 'VID', audio: 'AUD', pdf: 'PDF', sheet: 'XLS', doc: 'DOC', markdown: 'MD', html: 'HTML', csv: 'CSV', binary: 'BIN' };
function shell() {
  let box = document.querySelector('.fw'); if (box) return box;
  box = document.createElement('section'); box.className = 'fw'; box.setAttribute('aria-label', 'Files');
  box.innerHTML = '<div class="fw-head"><div class="fw-tabs" role="tablist"></div><div class="fw-wins"><button type="button" class="fw-ic" data-fw="big" title="Bigger or smaller (window)" aria-label="Bigger or smaller"></button><button type="button" class="fw-ic" data-fw="hide" title="Hide (your tabs stay)" aria-label="Hide the file window">&#8211;</button><button type="button" class="fw-ic" data-fw="close-all" title="Close all files" aria-label="Close all files">&#215;</button></div></div><div class="fw-bar"></div><div class="fw-body"></div>';
  box.insertAdjacentHTML('beforeend', ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => `<div class="fw-rs fw-rs-${edge}" data-edge="${edge}" aria-hidden="true"></div>`).join(''));
  document.body.append(box);
  box.addEventListener('click', onClick);
  box.addEventListener('pointerdown', startMove);
  box.querySelector('.fw-head').addEventListener('dblclick', event => { if (!event.target.closest('button')) { state.big = !state.big; place(); drawChrome(); editors.get(state.tabs[state.active]?.path)?.cm?.refresh(); } });
  place();
  return box;
}

// ---------- moving and resizing ----------
// Drag the top bar to move the window; drag an edge or a corner to resize it. Where it was is remembered.
const MIN_W = 420, MIN_H = 260;
function loadGeo() { try { return JSON.parse(localStorage.getItem('rex-desk-files-geo') || 'null'); } catch { return null; } }
function saveGeo(geo) { try { localStorage.setItem('rex-desk-files-geo', JSON.stringify(geo)); } catch { /* private window */ } }
function fit(geo) {
  const width = Math.min(Math.max(geo.w, MIN_W), window.innerWidth - 16), height = Math.min(Math.max(geo.h, MIN_H), window.innerHeight - 16);
  return { w: width, h: height, x: Math.min(Math.max(geo.x, 8 - width + 120), window.innerWidth - 120), y: Math.min(Math.max(geo.y, 0), window.innerHeight - 40) };
}
function place() {
  const box = document.querySelector('.fw'); if (!box) return;
  const geo = state.big || window.innerWidth < 640 ? null : loadGeo();
  for (const key of ['left', 'top', 'width', 'height', 'right', 'bottom']) box.style[key] = '';
  if (!geo) return;
  const at = fit(geo);
  Object.assign(box.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, height: `${at.h}px`, right: 'auto', bottom: 'auto' });
}
function startMove(event) {
  if (event.button !== 0 || state.big || window.innerWidth < 640) return;
  const box = event.currentTarget, edge = event.target.closest('.fw-rs')?.dataset.edge || '';
  const grab = !edge && event.target.closest('.fw-head') && !event.target.closest('button,a,input,summary');
  if (!edge && !grab) return;
  event.preventDefault();
  const start = box.getBoundingClientRect(), from = { x: event.clientX, y: event.clientY };
  box.classList.add('moving'); box.setPointerCapture(event.pointerId);
  const move = next => {
    const dx = next.clientX - from.x, dy = next.clientY - from.y;
    let { left: x, top: y, width: w, height: h } = start;
    if (grab) { x += dx; y += dy; }
    if (edge.includes('e')) w += dx;
    if (edge.includes('s')) h += dy;
    if (edge.includes('w')) { const width = Math.max(w - dx, MIN_W); x += w - width; w = width; }
    if (edge.includes('n')) { const height = Math.max(h - dy, MIN_H); y += h - height; h = height; }
    const at = fit({ x, y, w, h });
    Object.assign(box.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, height: `${at.h}px`, right: 'auto', bottom: 'auto' });
    editors.get(state.tabs[state.active]?.path)?.cm?.refresh();
  };
  const stop = () => {
    box.classList.remove('moving'); box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', stop); box.removeEventListener('pointercancel', stop);
    const rect = box.getBoundingClientRect(); saveGeo({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
  };
  box.addEventListener('pointermove', move); box.addEventListener('pointerup', stop); box.addEventListener('pointercancel', stop);
}
window.addEventListener('resize', () => place());
function pill() {
  let button = document.querySelector('.fw-pill');
  if (!state.tabs.length || state.shown) { button?.remove(); return; }
  if (!button) { button = document.createElement('button'); button.type = 'button'; button.className = 'fw-pill'; button.dataset.fw = 'show'; button.addEventListener('click', onClick); document.body.append(button); }
  const unsaved = state.tabs.filter(dirty).length;
  button.innerHTML = `<span class="fw-pill-ic" aria-hidden="true">&lt;/&gt;</span>Files<span class="fw-pill-n">${state.tabs.length}</span>${unsaved ? `<span class="fw-dot" title="${unsaved} not saved"></span>` : ''}`;
  button.title = state.tabs.map(tab => tab.name).join(', ');
}
function draw() {
  pill();
  const box = document.querySelector('.fw');
  if (!state.shown || !state.tabs.length) { box?.classList.add('hidden'); return; }
  shell().classList.remove('hidden'); drawChrome(); drawBody();
}
function drawChrome() {
  const box = shell(), tab = state.tabs[state.active]; if (!tab) return;
  box.classList.toggle('big', state.big);
  box.querySelector('[data-fw="big"]').innerHTML = state.big ? '&#10697;' : '&#9634;';
  box.querySelector('.fw-tabs').innerHTML = state.tabs.map((item, index) => `<div class="fw-tab ${index === state.active ? 'on' : ''}" role="tab" aria-selected="${index === state.active}"><button type="button" class="fw-tab-name" data-fw="tab" data-index="${index}" title="${esc(item.path)}">${ICON[item.kind] ? `<span class="fw-k">${ICON[item.kind]}</span>` : ''}${esc(item.name)}${dirty(item) ? '<span class="fw-dot" aria-label="not saved"></span>' : ''}</button><button type="button" class="fw-tab-x" data-fw="tab-close" data-index="${index}" aria-label="Close ${esc(item.name)}">&#215;</button></div>`).join('');
  const views = PREVIEW.has(tab.kind) && tab.editable ? `<div class="pseg fw-views"><button type="button" class="tab ${tab.view === 'code' ? 'on' : ''}" data-fw="view" data-view="code">Code</button><button type="button" class="tab ${tab.view === 'preview' ? 'on' : ''}" data-fw="view" data-view="preview">Preview</button>${tab.kind !== 'csv' ? `<button type="button" class="tab ${tab.view === 'split' ? 'on' : ''}" data-fw="view" data-view="split">Both</button>` : ''}</div>` : '';
  box.querySelector('.fw-bar').innerHTML = `<button type="button" class="fw-path" data-fw="copy" title="Copy the path">${esc(tab.path)}</button><span class="muted small">${size(tab.size)}</span><span class="spacer"></span>${views}
    ${tab.editable && tab.formattable ? '<button type="button" class="btn small" data-fw="format" title="Format with Prettier (Shift+Alt+F)">Format</button>' : ''}
    ${tab.editable ? `<button type="button" class="btn small ${dirty(tab) ? 'primary' : ''}" data-fw="save" title="Save (Ctrl+S)">${dirty(tab) ? 'Save' : 'Saved'}</button>` : ''}
    <details class="fw-more"><summary class="btn small" aria-label="More">&#8943;</summary><div class="fw-menu"><button type="button" data-fw="reload">Load again from disk</button><button type="button" data-fw="app">Open in its program</button><button type="button" data-fw="folder">Show in folder</button><a href="${raw(tab, '&download=1')}" download>Download</a></div></details>`;
}
function drawBody() {
  const box = shell(), body = box.querySelector('.fw-body'), tab = state.tabs[state.active]; if (!tab) return;
  for (const [file, item] of editors) item.wrap.classList.toggle('hidden', file !== tab.path || tab.view === 'preview');
  body.querySelector('.fw-view')?.remove();
  body.classList.toggle('split', tab.view === 'split');
  if (tab.editable) {
    if (tab.view !== 'code') body.insertAdjacentHTML('beforeend', `<div class="fw-view">${preview(tab)}</div>`);
    if (tab.view !== 'preview') void editorFor(tab, body);
    return;
  }
  body.insertAdjacentHTML('beforeend', `<div class="fw-view">${viewer(tab)}</div>`);
  if (tab.kind === 'sheet') void drawSheet(tab, body.querySelector('.fw-view'));
}
function preview(tab) {
  const text = editors.get(tab.path)?.cm?.getValue() ?? tab.text ?? '';
  if (tab.kind === 'markdown') return `<div class="fw-md md">${markdown(text)}</div>`;
  if (tab.kind === 'html') return `<iframe class="fw-frame" src="${raw(tab, `&v=${tab.mtime}`)}" title="Preview of ${esc(tab.name)}" sandbox="allow-scripts"></iframe>${dirty(tab) ? '<p class="fw-note">The preview shows the saved file. Save to see your changes.</p>' : ''}`;
  if (tab.kind === 'csv') { const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 1000).map(line => line.split(tab.ext === '.tsv' ? '\t' : /,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(cell => cell.replace(/^"|"$/g, '').replaceAll('""', '"'))); return table(rows); }
  return '';
}
const table = rows => `<div class="fw-table-wrap"><table class="fw-table"><tbody>${rows.map((row, index) => `<tr><th>${index + 1}</th>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
function viewer(tab) {
  const src = raw(tab, `&v=${tab.mtime}`);
  if (tab.kind === 'image') return `<div class="fw-media"><img src="${src}" alt="${esc(tab.name)}"></div>`;
  if (tab.kind === 'video') return `<div class="fw-media"><video src="${src}" controls preload="metadata"></video></div>`;
  if (tab.kind === 'audio') return `<div class="fw-media"><audio src="${src}" controls></audio></div>`;
  if (tab.kind === 'pdf') return `<iframe class="fw-frame" src="${src}" title="${esc(tab.name)}"></iframe>`;
  if (tab.kind === 'doc') return `<iframe class="fw-frame" src="/api/files/doc?path=${encodeURIComponent(tab.path)}&v=${tab.mtime}" title="${esc(tab.name)}" sandbox></iframe>`;
  if (tab.kind === 'sheet') return '<div class="fw-sheet"><p class="muted">Reading the workbook…</p></div>';
  return `<div class="fw-empty"><b>${esc(tab.name)}</b><p>${tab.kind === 'binary' ? 'This kind of file has no viewer here.' : 'This file is too big to edit here.'} Open it in its program, or download it.</p><div class="row"><button type="button" class="btn primary small" data-fw="app">Open in its program</button><a class="btn small" href="${raw(tab, '&download=1')}" download>Download</a></div></div>`;
}
async function drawSheet(tab, view) {
  try {
    tab.book ||= await state.ctx.api(`/files/sheet?path=${encodeURIComponent(tab.path)}`);
    const sheet = tab.book.sheets[tab.sheet || 0]; if (!view.isConnected) return;
    view.innerHTML = `<div class="fw-sheet">${tab.book.sheets.length > 1 ? `<div class="fw-sheets">${tab.book.sheets.map((item, index) => `<button type="button" class="tab ${index === (tab.sheet || 0) ? 'on' : ''}" data-fw="sheet" data-index="${index}">${esc(item.name)}</button>`).join('')}</div>` : ''}${sheet.rows.length ? table(sheet.rows) : '<p class="muted">This sheet is empty.</p>'}${sheet.more ? '<p class="fw-note">Only the first 1000 rows and 60 columns show here. Open it in Excel for all of it.</p>' : ''}<p class="fw-note">Read only. Open it in its program to change it.</p></div>`;
  } catch (error) { view.innerHTML = `<div class="fw-empty"><p>${esc(error.message)}</p></div>`; }
}
async function editorFor(tab, body) {
  let item = editors.get(tab.path);
  if (!item) {
    const wrap = document.createElement('div'); wrap.className = 'fw-editor'; body.prepend(wrap);
    item = { wrap, cm: null }; editors.set(tab.path, item);
    const mode = await codeMirror(extOf(tab.name)).catch(() => null);
    if (!window.CodeMirror) { wrap.innerHTML = '<p class="fw-note">The editor did not load.</p>'; return; }
    item.cm = window.CodeMirror(wrap, { value: tab.text ?? '', mode, lineNumbers: true, matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true, indentUnit: 2, tabSize: 2, lineWrapping: tab.kind === 'markdown',
      extraKeys: { 'Ctrl-S': () => save(tab), 'Cmd-S': () => save(tab), 'Shift-Alt-F': () => format(tab), 'Alt-G': 'jumpToLine' } });
    item.cm.on('change', () => { drawChrome(); pill(); if (tab.view === 'split') { const view = body.querySelector('.fw-view'); if (view && tab.kind === 'markdown') view.innerHTML = preview(tab); } });
  }
  if (!item.cm) return;
  item.wrap.classList.remove('hidden'); item.cm.refresh();
  if (tab.line) { const line = tab.line - 1; item.cm.setCursor({ line, ch: 0 }); item.cm.scrollIntoView({ line, ch: 0 }, 120); item.cm.addLineClass(line, 'background', 'fw-hit'); setTimeout(() => item.cm?.removeLineClass(line, 'background', 'fw-hit'), 2400); tab.line = 0; }
  item.cm.focus();
}
async function onClick(event) {
  const target = event.target.closest('[data-fw]'); if (!target) return;
  const tab = state.tabs[state.active], act = target.dataset.fw, { api, toast } = state.ctx;
  try {
    if (act === 'tab') { state.active = Number(target.dataset.index); remember(); draw(); }
    else if (act === 'tab-close') closeTab(Number(target.dataset.index));
    else if (act === 'hide') { state.shown = false; remember(); draw(); }
    else if (act === 'show') { state.shown = true; remember(); draw(); }
    else if (act === 'big') { state.big = !state.big; place(); drawChrome(); editors.get(tab?.path)?.cm?.refresh(); }
    else if (act === 'close-all') { const unsaved = state.tabs.filter(dirty); if (unsaved.length && !confirm(`${unsaved.map(item => item.name).join(', ')} not saved. Close all anyway?`)) return; for (const item of editors.values()) item.wrap.remove(); editors.clear(); state.tabs = []; state.active = -1; state.shown = false; remember(); draw(); }
    else if (act === 'view') { tab.view = target.dataset.view; drawChrome(); drawBody(); }
    else if (act === 'sheet') { tab.sheet = Number(target.dataset.index); drawBody(); }
    else if (act === 'save') await save(tab);
    else if (act === 'format') await format(tab);
    else if (act === 'reload') { target.closest('details')?.removeAttribute('open'); await reload(tab); }
    else if (act === 'copy') { await navigator.clipboard.writeText(tab.path); toast('Path copied.'); }
    else if (act === 'app' || act === 'folder') { target.closest('details')?.removeAttribute('open'); await api('/files/reveal', { method: 'POST', data: { path: tab.path, how: act === 'folder' ? 'folder' : 'app' } }); }
  } catch (error) { toast(error.message, true); }
}

// ---------- wiring ----------
// A path in a chat (`src/server.js:42`) opens here; so does any element with data-file-open.
export function wireFiles(ctx) {
  state.ctx = ctx;
  document.addEventListener('click', event => {
    const target = event.target.closest?.('[data-file-open]'); if (!target) return;
    event.preventDefault(); event.stopPropagation();
    void openFile(ctx, target.dataset.fileOpen, { run: target.dataset.fileRun || ctx.currentRunId?.() || '', room: ctx.ui.view.type === 'room' ? ctx.ui.view.id : '' });
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.shown && document.querySelector('.fw')?.contains(document.activeElement) && !document.querySelector('.CodeMirror-dialog')) { state.shown = false; remember(); draw(); }
  });
  window.addEventListener('beforeunload', event => { if (state.tabs.some(dirty)) { event.preventDefault(); event.returnValue = ''; } });
  window.rexOpenFile = (path, options) => openFile(ctx, path, options);
  // Tabs from last time come back hidden behind the Files button.
  try {
    const saved = JSON.parse(localStorage.getItem('rex-desk-files') || 'null');
    if (saved?.paths?.length) void (async () => { for (const path of saved.paths) { const info = await ctx.api(`/files/open?path=${encodeURIComponent(path)}`).catch(() => null); if (info) state.tabs.push({ ...info, saved: info.text, view: info.kind === 'markdown' ? 'preview' : 'code' }); } state.active = Math.min(Math.max(saved.active, 0), state.tabs.length - 1); state.shown = false; draw(); })();
  } catch { /* private window */ }
}
// A file an agent showed with desk_show_file opens once, where the person is.
export function watchShownFile(ctx) {
  const shown = ctx.ui.snap?.shownFile;
  // The first look only notes what was shown before this window opened.
  if (state.lastShown === null) { state.lastShown = shown?.id || ''; return; }
  if (!shown?.id) return;
  if (shown.id === state.lastShown) return;
  state.lastShown = shown.id;
  void openFile(ctx, shown.path, { line: shown.line });
}

import { askConfirm } from './confirm.js';
import { t, locale } from './i18n.js';
import { skeletonHtml } from './chat-skeleton.js';
// Settings › Storage: what Rex Desk keeps and how much room it takes, here and in the cloud; one-click clean-ups; and a
// file browser like Explorer or Finder (folders on the left, files on the right) to look, preview, show in folder and delete.

const size = value => { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let amount = Number(value) || 0, at = 0; while (amount >= 1024 && at < units.length - 1) { amount /= 1024; at += 1; } return `${amount.toFixed(amount >= 100 || at === 0 ? 0 : 1)} ${units[at]}`; };
const day = iso => iso ? new Date(iso).toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i, VIDEO = /\.(mp4|webm|mov)$/i;
const KIND_COLORS = { chat: '#3b6cf6', raw: '#e0663f', records: '#8b8fa3', files: '#1f9d63', backups: '#c98a12', models: '#9b5de5' };
const KIND_LABELS = () => ({ chat: t('Chat history'), raw: t('Raw agent output'), records: t('Other records'), files: t('Files'), backups: t('Backups and app copies'), models: t('Voice models') });
const PLACE_LABELS = () => ({ uploads: t('Files you attached'), artifacts: t('Agent files and evidence'), 'room-images': t('Group chat pictures'), 'old-artifacts': t('Older agent files'), backups: t('Database backups'), handoffs: t('Chat handoffs'), runtime: t('Agent copies of the app') });
const CLEAN_LABELS = () => ({
  'raw-output': [t('Raw agent output older than 30 days'), t('What agents printed while working (tool results, logs). Messages and the agent\'s memory of the chat stay; old runs show fewer details in Activity.')],
  'old-media': [t('Screenshots and recordings older than 60 days'), t('Agents\' evidence pictures and videos. The chat shows "file removed" where they were.')],
  duplicates: [t('Duplicate files'), t('The same file kept more than once. The oldest copy stays.')],
  'old-backups': [t('Database backups older than 30 days'), t('Copies Rex Desk made before big changes. The newest stays.')],
  'old-copies': [t('Old copies of the app for agents'), t('Agents run from a copy of the current version; older ones are left over from updates.')],
});
const ICON = {
  folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  reveal: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.8 13.2 12 15.5l2.2-2.3"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
};

// The server answers at once with its last count (or none yet) and counts again behind it; while it counts, the page
// asks again every few seconds and redraws (onUpdate) when the new numbers are in.
let countTimer = 0;
export async function loadStorage(ctx, state, { keepPlace = true, onUpdate } = {}) {
  const box = state.storage || (state.storage = { place: '', folder: '', sort: 'size', selected: new Set(), query: '' });
  try {
    box.data = await ctx.api('/storage');
    if (!keepPlace || !box.data.places.some(place => place.id === box.place)) { box.place = box.data.places[0]?.id || ''; box.folder = ''; }
    await listFolder(ctx, state);
  } catch (error) { box.error = error.message; }
  if (onUpdate) box.onUpdate = onUpdate;
  waitForCount(ctx, state);
  // The cloud side: the account's database and file space, from its plan. It can take a few seconds, so the page shows
  // first and the cloud rows fill in (grey rows until then).
  if (!box.billing) box.billingLoading = true;
  void ctx.api('/billing', { timeout: 8000 }).catch(() => null).then(billing => { box.billing = billing; box.billingLoading = false; box.onUpdate?.(); });
}
function waitForCount(ctx, state, tries = 0) {
  clearTimeout(countTimer);
  const box = state.storage; if (!box?.data?.counting || tries > 200) return;
  countTimer = setTimeout(async () => {
    if (state.section !== 'storage' || !document.querySelector('[data-sg-page]')) return;
    try { const data = await ctx.api('/storage'); box.data = data; if (!data.counting) box.onUpdate?.(); } catch { /* asked again below */ }
    waitForCount(ctx, state, tries + 1);
  }, 3000);
}
async function listFolder(ctx, state) {
  const box = state.storage; box.selected = new Set();
  if (box.query) { box.list = { items: (await ctx.api(`/storage/search?q=${encodeURIComponent(box.query)}`)).items, search: true }; return; }
  box.list = box.place ? await ctx.api(`/storage/list?place=${encodeURIComponent(box.place)}&folder=${encodeURIComponent(box.folder)}`) : { items: [] };
}

function usageHtml(ctx, box) {
  const usage = box.data.usage, labels = KIND_LABELS(), total = usage?.total || 1;
  // Drawn with SVG attributes: the app's security rules do not allow style="" on elements.
  let x = 0;
  const bar = (usage?.kinds || []).filter(kind => kind.bytes > 0).map(kind => { const width = Math.max(kind.bytes / total * 1000, 4), rect = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(width - 3, 1).toFixed(1)}" height="14" fill="${KIND_COLORS[kind.id]}"><title>${ctx.esc(labels[kind.id])} · ${size(kind.bytes)}</title></rect>`; x += width; return rect; }).join('');
  const legend = (usage?.kinds || []).map(kind => `<li><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="3" fill="${KIND_COLORS[kind.id]}"/></svg><span>${ctx.esc(labels[kind.id])}</span><b>${size(kind.bytes)}</b></li>`).join('');
  const space = box.billing?.space, db = space?.database, files = space?.files;
  const cloudRow = (label, used, limit) => used == null ? '' : `<div class="sg-cloud-row"><span>${label}</span><svg class="sg-meter" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${ctx.esc(`${label}: ${size(used)}${limit ? ` / ${size(limit)}` : ''}`)}"><rect width="100" height="8" rx="4" class="sg-meter-back"/><rect width="${limit ? Math.max(1, Math.min(100, used / limit * 100)).toFixed(1) : 0}" height="8" rx="4" class="sg-meter-fill"/></svg><b>${size(used)}${limit ? ` <small>/ ${size(limit)}</small>` : ''}</b></div>`;
  const cloud = !box.billing ? (box.billingLoading ? skeletonHtml(2) : '') : !box.billing.signedIn ? `<p class="muted small">${t`Sign in with your Rex Desk account to see your cloud space.`}</p>`
    : (db || files) ? `${cloudRow(t('Cloud database'), db?.used, db?.limit)}${cloudRow(t('Cloud files'), files?.used, files?.limit)}<p class="muted small">${t`Cleaning up here also deletes the cloud copy. The cloud number updates within a few minutes.`}</p>`
    : `<p class="muted small">${t`Cloud backup is off, so nothing is kept in the cloud.`}</p>`;
  return `<section class="sg-card" aria-labelledby="sg-use"><div class="sg-head"><h3 id="sg-use">${t`On this computer`}</h3>${box.data.counting && usage ? `<small class="muted">${t`Updating…`}</small>` : ''}<b class="sg-total">${usage ? size(usage.total) : ''}</b></div>
    ${!usage ? skeletonHtml(3) : `<svg class="sg-bar" viewBox="0 0 ${Math.max(x, 1).toFixed(1)} 14" preserveAspectRatio="none" role="img" aria-label="${t`What takes the space`}">${bar}</svg><ul class="sg-legend">${legend}</ul>`}
    <div class="sg-head sg-cloudhead"><h3>${t`In the cloud`}</h3></div>${cloud}</section>`;
}

function cleanHtml(ctx, box) {
  const labels = CLEAN_LABELS(), busy = box.busy;
  const rows = box.data.suggestions.map(item => {
    const [label, note] = labels[item.id] || [item.label, item.note], done = box.done?.[item.id];
    return `<li class="sg-clean"><div class="sg-clean-text"><b>${ctx.esc(label)}</b><small>${ctx.esc(note)}</small>${done ? `<span class="sg-done">${t`Freed ${size(done.freed)}: ${size(done.before)} before, ${size(done.after)} now.`}</span>` : ''}</div>
      ${item.bytes == null ? `<span class="sg-clean-size muted">${t`Not checked`}</span><button type="button" class="btn small" data-sg="twins"${busy ? ' disabled' : ''}>${busy === 'twins' ? t('Looking…') : t('Find duplicates')}</button>`
        : `<span class="sg-clean-size">${item.bytes ? size(item.bytes) : t('Nothing')}</span><button type="button" class="btn small${item.bytes ? ' primary' : ''}" data-sg="clean" data-id="${ctx.esc(item.id)}"${!item.bytes || busy ? ' disabled' : ''}>${busy === item.id ? t('Cleaning…') : t('Clean up')}</button>`}</li>`;
  }).join('');
  return `<section class="sg-card" aria-labelledby="sg-clean"><div class="sg-head"><h3 id="sg-clean">${t`Clean up`}</h3></div>${rows ? `<ul class="sg-cleans">${rows}</ul>` : `<p class="muted">${t`Counting what Rex Desk keeps…`}</p>`}</section>`;
}

function browserHtml(ctx, box) {
  const { esc } = ctx, labels = PLACE_LABELS(), list = box.list || { items: [] };
  const usage = Object.fromEntries((box.data.usage?.places || []).map(place => [place.id, place.bytes]));
  const tree = box.data.places.map(place => `<button type="button" class="sg-place${place.id === box.place && !box.query ? ' on' : ''}" data-sg="place" data-id="${esc(place.id)}" title="${esc(place.directory)}">${ICON.folder}<span>${esc(labels[place.id] || place.label)}</span><small>${place.id in usage ? size(usage[place.id]) : ''}</small></button>`).join('');
  const items = [...list.items].sort((left, right) => box.sort === 'name' ? left.name.localeCompare(right.name) : box.sort === 'date' ? String(right.modified).localeCompare(String(left.modified)) : right.size - left.size || Number(right.folder) - Number(left.folder));
  const selected = items.filter(item => box.selected.has(`${item.place || box.place}\n${item.path}`)), freed = selected.reduce((sum, item) => sum + item.size, 0);
  const crumbs = box.query ? `<span>${t`Search: ${esc(box.query)}`}</span>` : `<button type="button" class="sg-crumb" data-sg="crumb" data-path="">${esc(labels[box.place] || '')}</button>${box.folder.split(/[\\/]/).filter(Boolean).map((part, index, parts) => `<span aria-hidden="true">›</span><button type="button" class="sg-crumb" data-sg="crumb" data-path="${esc(parts.slice(0, index + 1).join('/'))}">${esc(part)}</button>`).join('')}`;
  const rows = items.map(item => {
    const key = `${item.place || box.place}\n${item.path}`, place = item.place || box.place, url = `/api/storage/file?place=${encodeURIComponent(place)}&path=${encodeURIComponent(item.path)}`;
    const thumb = item.folder ? `<span class="sg-ic">${ICON.folder}</span>` : IMAGE.test(item.name) ? `<img class="sg-thumb" src="${esc(url)}" alt="" loading="lazy">` : `<span class="sg-ic">${ICON.file}</span>`;
    const owner = item.owner?.name ? (item.owner.agentId ? `<button type="button" class="sg-owner" data-sg="chat" data-agent="${esc(item.owner.agentId)}" title="${t`Open its chat`}">${esc(item.owner.name)}</button>` : `<span class="sg-owner">${esc(item.owner.name)}</span>`) : '<span class="sg-owner muted">-</span>';
    const name = item.folder ? `<button type="button" class="sg-name" data-sg="open" data-path="${esc(item.path)}">${esc(item.name)}</button>` : `<a class="sg-name" href="${esc(url)}" target="_blank" rel="noopener" data-sg-preview="${IMAGE.test(item.name) || VIDEO.test(item.name) ? '1' : ''}">${esc(item.name)}</a>`;
    const sub = [item.folder ? (item.files === 1 ? t('1 file') : t`${item.files} files`) : '', ''].filter(Boolean).join(' · ');
    return `<tr class="${box.selected.has(key) ? 'on' : ''}"><td class="sg-check">${item.locked ? `<span class="sg-lock" title="${t`Agents run from this now, so it stays`}">●</span>` : `<input type="checkbox" data-sg-pick="${esc(key)}" aria-label="${t`Select ${esc(item.name)}`}"${box.selected.has(key) ? ' checked' : ''}>`}</td>
      <td><div class="sg-file">${thumb}<div class="sg-fname">${name}<small>${sub ? `${esc(sub)}${item.owner?.name ? ' · ' : ''}` : ''}${item.owner?.name ? owner : ''}</small></div></div></td><td class="sg-num">${size(item.size)}</td><td class="sg-date">${esc(day(item.modified))}</td>
      <td class="sg-acts">${item.folder ? '' : `<button type="button" class="sg-icon-btn" data-sg="reveal" data-place="${esc(place)}" data-path="${esc(item.path)}" title="${t`Show in folder`}" aria-label="${t`Show ${esc(item.name)} in its folder`}">${ICON.reveal}</button>`}</td></tr>`;
  }).join('');
  const sortButton = (id, label) => `<button type="button" class="sg-sort${box.sort === id ? ' on' : ''}" data-sg="sort" data-id="${id}" aria-pressed="${box.sort === id}">${label}</button>`;
  return `<section class="sg-card sg-browser" aria-labelledby="sg-files"><div class="sg-head"><h3 id="sg-files">${t`Files`}</h3><input type="search" class="sg-search" name="sg-search" value="${esc(box.query)}" placeholder="${t`Search file names`}" aria-label="${t`Search file names`}" autocomplete="off"></div>
    <div class="sg-split"><nav class="sg-tree" aria-label="${t`Rex Desk folders`}">${tree}</nav>
    <div class="sg-pane"><div class="sg-bar2">${box.folder && !box.query ? `<button type="button" class="btn small quiet" data-sg="up" aria-label="${t`Up one folder`}">${ICON.up}</button>` : ''}<div class="sg-crumbs">${crumbs}</div><span class="spacer"></span><span class="sg-sortby">${t`Sort`}</span>${sortButton('size', t('Size'))}${sortButton('date', t('Date'))}${sortButton('name', t('Name'))}</div>
    ${selected.length ? `<div class="sg-selbar" role="status"><span>${t`${selected.length} selected · ${size(freed)}`}</span><button type="button" class="btn small" data-sg="clear">${t`Clear`}</button><button type="button" class="btn small danger" data-sg="delete">${t`Delete`}</button></div>` : ''}
    ${items.length ? `<div class="sg-tablewrap"><table class="sg-table"><thead><tr><th class="sg-check"><span class="sg-sr">${t`Select`}</span></th><th>${t`Name`}</th><th class="sg-num">${t`Size`}</th><th>${t`Date`}</th><th><span class="sg-sr">${t`Actions`}</span></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="sh-empty">${box.query ? t('No file with that name.') : t('This folder is empty.')}</p>`}
    </div></div></section>`;
}

export function storageHtml(ctx, state) {
  const box = state.storage;
  if (!box?.data) return `<h2>${t`Storage`}</h2><p class="muted">${box?.error ? ctx.esc(box.error) : t('Counting what Rex Desk keeps…')}</p>`;
  return `<h2 data-sg-page>${t`Storage`}</h2><p class="muted">${t`Only Rex Desk's own data is here. Your project folders and notes are never touched.`}</p>${usageHtml(ctx, box)}${cleanHtml(ctx, box)}${browserHtml(ctx, box)}`;
}

let searchTimer = 0;
export function storageInput(ctx, state, event, draw) {
  if (!event.target.matches?.('[name="sg-search"]')) return false;
  const box = state.storage; clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { box.query = event.target.value.trim(); await listFolder(ctx, state); draw(); const input = document.querySelector('[name="sg-search"]'); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }, 300);
  return true;
}

export async function storageClick(ctx, state, target, draw) {
  const box = state.storage; if (!box) return false;
  const pick = target.closest?.('[data-sg-pick]');
  if (pick) { const key = pick.dataset.sgPick; if (pick.checked) box.selected.add(key); else box.selected.delete(key); draw(); return true; }
  const button = target.closest?.('[data-sg]'); if (!button) return false;
  const action = button.dataset.sg;
  if (action === 'place') { box.place = button.dataset.id; box.folder = ''; box.query = ''; await listFolder(ctx, state); draw(); return true; }
  if (action === 'open' || action === 'crumb') { box.folder = button.dataset.path; await listFolder(ctx, state); draw(); return true; }
  if (action === 'up') { box.folder = box.folder.split(/[\\/]/).slice(0, -1).join('/'); await listFolder(ctx, state); draw(); return true; }
  if (action === 'sort') { box.sort = button.dataset.id; draw(); return true; }
  if (action === 'clear') { box.selected = new Set(); draw(); return true; }
  if (action === 'reveal') { await ctx.api('/storage/reveal', { method: 'POST', data: { place: button.dataset.place, path: button.dataset.path } }); return true; }
  if (action === 'chat') { document.querySelector('.dialog-back.settings')?.remove(); ctx.open?.('specialist', button.dataset.agent); return true; }
  if (action === 'delete') {
    const items = [...box.selected].map(key => { const [place, path] = key.split('\n'); return { place, path }; });
    const bytes = (box.list?.items || []).filter(item => box.selected.has(`${item.place || box.place}\n${item.path}`)).reduce((sum, item) => sum + item.size, 0);
    if (!await askConfirm(t`Delete ${items.length} items? ${size(bytes)} of space comes back. They are also deleted from the cloud backup, and chats show "file removed" where they were.`)) return true;
    try { const result = await ctx.api('/storage/delete', { method: 'POST', data: { items } }); ctx.toast(t`Deleted. ${size(result.freed)} freed.`); }
    catch (error) { ctx.toast(error.message, true); }
    await loadStorage(ctx, state); draw(); return true;
  }
  // Duplicates are looked for only on request: it reads every file of the same size, which takes a while on a big desk.
  if (action === 'twins') {
    box.busy = 'twins'; draw();
    try { box.data = { ...box.data, ...(await ctx.api('/storage/duplicates', { method: 'POST', data: {}, timeout: 600000 })) }; }
    catch (error) { ctx.toast(error.message, true); }
    box.busy = ''; draw(); return true;
  }
  if (action === 'clean') {
    const id = button.dataset.id, [label] = CLEAN_LABELS()[id] || [id];
    if (id === 'raw-output' && !await askConfirm(t`Delete raw agent output older than 30 days? Messages and the agents' memory of their chats stay. This can take a minute on a big desk.`)) return true;
    box.busy = id; draw();
    try { const result = await ctx.api('/storage/clean', { method: 'POST', data: { id }, timeout: 600000 }); box.done = { ...(box.done || {}), [id]: result }; ctx.toast(t`${label}: ${size(result.freed)} freed.`); }
    catch (error) { ctx.toast(error.message, true); }
    box.busy = ''; await loadStorage(ctx, state); draw(); return true;
  }
  return false;
}

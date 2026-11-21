import { askConfirm } from './confirm.js';
import { t, locale } from './i18n.js';
// Monitor: what uses this computer's memory, split into what is Rex Desk's own and what was opened outside it,
// so the person can end the right thing without guessing. Rex Agent reads and uses the same list (desk_monitor).
const gb = mb => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
const ago = at => { if (!at) return ''; const minutes = Math.round((Date.now() - Date.parse(at)) / 60000); return minutes < 60 ? t`${Math.max(1, minutes)} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : t`${Math.round(minutes / 1440)} days`; };

const SECTIONS = [
  { side: 'desk', title: t('In Rex Desk'), help: t('Started by Rex Desk for your agents. Idle agents use no memory: an agent\'s process ends when its reply is done.'), groups: [
    ['agents', t('Agents working now'), t('Stop'), t('No agent is working right now.')],
    ['previews', t('Previews'), t('End'), ''], ['browsers', t('Test browsers'), t('End'), ''] ] },
  { side: 'left', title: t('Left behind'), help: t('Nothing uses these any more. Free memory now ends them all.'), groups: [
    ['leftovers', t('Tools whose app closed'), t('End'), ''], ['servers', t('Other servers (another project or another Rex Desk)'), t('End'), ''] ] },
  { side: 'outside', title: t('Outside Rex Desk'), help: t('Claude Code you opened yourself, in Orca, a terminal or an editor. Rex Desk never ends these by itself. Ending one closes that conversation; anything it was doing stops.'), groups: [
    ['terminals', t('Claude Code windows'), t('End'), t('None open.')] ] },
];

function row(ctx, key, item, verb, side) {
  const { esc } = ctx, state = item.busy === true ? `<span class="mo-state busy">${t`busy`}</span>` : item.busy === false ? `<span class="mo-state idle">${t`idle`}</span>` : '';
  const action = key === 'agents' && item.runId ? `data-action="mo-stop" data-run="${esc(item.runId)}"` : `data-action="mo-end" data-pid="${item.pid}" data-side="${side}" data-label="${esc(item.label)}"`;
  return `<li class="mo-row ${side}"><span class="mo-badge ${side}">${side === 'outside' ? t('Outside') : side === 'left' ? t('Left behind') : t('Rex Desk')}</span>
    <span class="mo-what"><b>${esc(item.label)}</b><small title="${esc(item.cmd)}">${esc([item.detail, `pid ${item.pid}`].filter(Boolean).join(' · '))}</small></span>
    <span class="mo-num">${gb(item.mb)}<small>${esc(ago(item.started))}${state ? ' · ' : ''}${state}</small></span>
    <button type="button" class="btn small${key === 'agents' ? ' danger' : side === 'outside' ? ' quiet danger' : ''}" ${action}>${verb}</button></li>`;
}

export function monitorStage(ctx) {
  const { ui, esc } = ctx, data = ui.monitor;
  if (!data) return { title: t('Monitor'), meta: t('Reading this computer…'), feed: `<div class="empty"><p>${t`Reading what uses memory…`}</p></div>` };
  const used = data.totalMb - data.freeMb, share = Math.round((used / data.totalMb) * 100), low = data.freeMb / data.totalMb < 0.15;
  const total = keys => keys.reduce((sum, key) => sum + (data.groups[key] || []).reduce((inner, item) => inner + item.mb, 0), 0);
  const section = ({ side, title, help, groups }) => {
    const keys = groups.map(([key]) => key), count = keys.reduce((sum, key) => sum + (data.groups[key] || []).length, 0);
    if (!count && side === 'left') return '';
    const body = groups.map(([key, label, verb, empty]) => { const items = data.groups[key] || []; if (!items.length) return empty ? `<p class="muted small mo-empty">${esc(empty)}</p>` : '';
      return `<h4>${esc(label)} <span>${items.length}</span></h4><ul class="mo-list">${items.map(item => row(ctx, key, item, verb, side)).join('')}</ul>`; }).join('');
    return `<section class="card mo-sec ${side}"><header><h3>${esc(title)}</h3><span class="mo-mb">${count ? `${gb(total(keys))} · ${count}` : 'none'}</span></header><p class="muted small">${esc(help)}</p>${body}</section>`;
  };
  const cleaned = (data.cleaned || []).slice(-5).reverse().map(entry => `<li><b>${esc(new Date(entry.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }))}</b> ${esc(entry.reason)}: ${esc(entry.what.join(', '))}</li>`).join('');
  const auto = ui.snap.config?.autoFree !== false;
  const feed = `<div class="page monitor">
    <section class="card mo-top">
      <div class="mo-head"><div><p class="mo-free"><b>${gb(data.freeMb)}</b> ${t`free of ${gb(data.totalMb)}`}${low ? ` <span class="mo-low">${t`Low`}</span>` : ''}</p><p class="muted small">${t`Rex Desk itself uses ${gb(data.deskMb)} · checked ${esc(new Date(data.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}`}</p></div>
        <div class="mo-actions"><button type="button" class="btn primary" data-action="mo-clean">${t`Free memory now`}</button><button type="button" class="btn" data-action="mo-refresh">${t`Check again`}</button></div></div>
      <meter class="mo-bar" min="0" max="100" low="70" high="85" optimum="20" value="${share}" aria-label="${t`${share}% of memory in use`}">${share}%</meter>
      <label class="mo-auto"><input type="checkbox" data-mo-auto ${auto ? 'checked' : ''}><span>${t`Free memory by itself when it runs low, and hold agent loops until it is back`}</span></label>
      <p class="muted small">${t`You can also ask Rex Agent: "what is using my memory?" or "free some memory". It asks you before ending anything opened outside Rex Desk.`}</p></section>
    <div class="mo-grid">${SECTIONS.map(section).join('')}</div>
    ${data.others?.length ? `<section class="card mo-sec"><header><h3>${t`Other programs`}</h3></header><p class="muted small">${t`Not Claude Code and not Rex Desk. Close them in their own window if you need memory.`}</p><ul class="mo-plain">${data.others.map(item => `<li><span>${esc(item.name)}</span><span>${gb(item.mb)}</span></li>`).join('')}</ul></section>` : ''}
    ${cleaned ? `<section class="card mo-sec"><header><h3>${t`Freed lately`}</h3></header><ul class="mo-log">${cleaned}</ul></section>` : ''}
  </div>`;
  return { title: t('Monitor'), meta: data.liveRuns.length === 1 ? t`${gb(data.freeMb)} free · ${data.liveRuns.length} agent working` : t`${gb(data.freeMb)} free · ${data.liveRuns.length} agents working`, feed, top: true };
}

export async function monitorAction(ctx, action, target) {
  const { api, toast, ui } = ctx;
  if (action === 'mo-clean') { const result = await api('/monitor/clean', { method: 'POST', data: {} }); toast(result.cleaned.length ? result.cleaned.length === 1 ? t`Freed ${result.cleaned.length} item.` : t`Freed ${result.cleaned.length} items.` : t('Nothing to free: everything running is in use.')); }
  else if (action === 'mo-end') {
    const outside = target.dataset.side === 'outside', label = target.dataset.label || 'this process';
    if (!await askConfirm(outside ? t`End "${label}"? It was opened outside Rex Desk. Its conversation closes and anything it was doing stops.` : t`End "${label}"?`)) return;
    const result = await api('/monitor/end', { method: 'POST', data: { pid: Number(target.dataset.pid), outside } }); toast(t`Ended ${result.what || 'it'}.`);
  } else if (action === 'mo-stop') { await api(`/runs/${target.dataset.run}/stop`, { method: 'POST', data: {} }); toast(t('Stopped.')); }
  ui.monitor = await api('/monitor?fresh=1'); await ctx.refresh();
}

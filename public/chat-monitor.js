// Monitor: what uses this computer's memory, grouped the way the person thinks about it, with a button to free what nobody uses.
// Idle agents use no memory: an agent's Claude process ends after each reply. Only working agents, previews and leftovers do.
const GROUPS = [
  ['agents', 'Agents working now', 'Each working agent runs Claude Code and its tools. It ends by itself when the reply is done.'],
  ['previews', 'Previews of runs', 'App servers an agent started to test a change (Tomcat, dev servers).'],
  ['browsers', 'Test browsers', 'Browsers Rex Desk opened to record tests.'],
  ['leftovers', 'Leftover helpers', 'Tool servers whose app already closed. Safe to end.'],
  ['servers', 'Other Rex Desk servers', 'Older copies of Rex Desk still running in the background.'],
  ['terminals', 'Claude Code in your terminals', 'Sessions you opened yourself, outside Rex Desk. Rex Desk never ends these.'],
];
const ENDABLE = new Set(['previews', 'browsers', 'leftovers', 'servers']);
const gb = mb => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

export function monitorStage(ctx) {
  const { ui, esc } = ctx, data = ui.monitor;
  if (!data) return { title: 'Monitor', meta: 'Reading this computer…', feed: '<div class="empty"><p>Reading what uses memory…</p></div>' };
  const used = data.totalMb - data.freeMb, share = Math.round((used / data.totalMb) * 100), low = data.freeMb / data.totalMb < 0.15;
  const ago = at => { const minutes = Math.round((Date.now() - Date.parse(at)) / 60000); return minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`; };
  const group = ([key, title, help]) => {
    const item = data.groups[key] || { count: 0, mb: 0, items: [] };
    if (!item.count && key !== 'agents') return '';
    const rows = key === 'agents' ? data.liveRuns.map(run => `<li><span class="mo-name">${esc(run.title)}</span><span class="muted small">${esc(run.state)}</span><button type="button" class="btn small danger" data-action="mo-stop" data-run="${esc(run.id)}">Stop</button></li>`).join('')
      : item.items.slice(0, 12).map(entry => `<li><span class="mo-name" title="${esc(entry.cmd)}">${esc(entry.name.replace(/\.exe$/i, ''))} <small class="muted">${esc(entry.cmd.replace(/^"?[^"\s]+"?\s*/, '').slice(0, 90))}</small></span><span class="muted small">${gb(entry.mb)}${entry.started ? ` · ${ago(entry.started)}` : ''}</span>${ENDABLE.has(key) ? `<button type="button" class="btn small" data-action="mo-end" data-pid="${entry.pid}">End</button>` : ''}</li>`).join('');
    return `<section class="card mo-group"><h3>${esc(title)} <span class="mo-mb">${item.count ? `${gb(item.mb)} · ${item.count}` : 'none'}</span></h3><p class="muted small">${esc(help)}</p>${rows ? `<ul class="mo-list">${rows}</ul>` : key === 'agents' ? '<p class="small">No agent is working. Idle agents use no memory.</p>' : ''}</section>`;
  };
  const cleaned = (data.cleaned || []).slice(-5).reverse().map(entry => `<li><b>${esc(new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</b> ${esc(entry.reason)}: ${esc(entry.what.join(', '))}</li>`).join('');
  const auto = ui.snap.config?.autoFree !== false;
  const feed = `<div class="page monitor">
    <section class="card mo-top"><meter class="mo-bar${low ? ' low' : ''}" min="0" max="100" low="70" high="85" optimum="20" value="${share}" aria-label="${share}% of memory in use">${share}%</meter>
      <p class="mo-sum"><b>${gb(data.freeMb)} free</b> of ${gb(data.totalMb)}${low ? ' · <span class="warn-text">Low</span>' : ''} <span class="muted">· Rex Desk itself uses ${gb(data.deskMb)}</span></p>
      <div class="row"><button type="button" class="btn primary" data-action="mo-clean">Free memory now</button><button type="button" class="btn" data-action="mo-refresh">Check again</button>
      <label class="mo-auto"><input type="checkbox" data-mo-auto ${auto ? 'checked' : ''}> Free memory by itself when it runs low, and hold agent loops until it is back</label></div>
      <p class="muted small">Free memory ends previews and test browsers of runs that are not working, and leftover helpers. It never stops an agent that is working or your own terminals.</p></section>
    ${GROUPS.map(group).join('')}
    ${data.others?.length ? `<section class="card mo-group"><h3>Everything else on this computer</h3><ul class="mo-list">${data.others.map(item => `<li><span class="mo-name">${esc(item.name)}</span><span class="muted small">${gb(item.mb)}</span></li>`).join('')}</ul></section>` : ''}
    ${cleaned ? `<section class="card mo-group"><h3>Freed lately</h3><ul class="mo-log">${cleaned}</ul></section>` : ''}
  </div>`;
  return { title: 'Monitor', meta: `${gb(data.freeMb)} free · ${data.liveRuns.length} agent${data.liveRuns.length === 1 ? '' : 's'} working`, feed, top: true };
}

export async function monitorAction(ctx, action, target) {
  const { api, toast, ui } = ctx;
  if (action === 'mo-clean') { const result = await api('/monitor/clean', { method: 'POST', data: {} }); toast(result.cleaned.length ? `Freed: ${result.cleaned.length} item${result.cleaned.length === 1 ? '' : 's'}.` : 'Nothing to free: everything running is in use.'); }
  else if (action === 'mo-end') { if (!confirm('End this process? Its work is lost if it was still needed.')) return; await api('/monitor/end', { method: 'POST', data: { pid: Number(target.dataset.pid) } }); toast('Ended.'); }
  else if (action === 'mo-stop') { await api(`/runs/${target.dataset.run}/stop`, { method: 'POST', data: {} }); toast('Stopped.'); }
  ui.monitor = await api('/monitor?fresh=1'); await ctx.refresh();
}

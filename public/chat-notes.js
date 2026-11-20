import { t, locale } from './i18n.js';
// The agent card's Soul and Memory tabs (L49). Soul: who the agent is; it only proposes changes, the person decides. Memory: the
// agent's own notebook, 8 KB at most. Both keep their history (Restore) and can be exported as SOUL.md and MEMORY.md.
const LIMIT = 8 * 1024;
const when = at => at ? new Date(at).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const size = bytes => `${Math.round(bytes / 102.4) / 10} KB`;

// The notes are fetched once per agent, then drawn from this cache, so a screen refresh never loses them.
function load(ctx, agentId) {
  const { ui, api } = ctx; ui.notes ||= {}; ui.notesLoading ||= {};
  if (ui.notesLoading[agentId]) return;
  ui.notesLoading[agentId] = true;
  api(`/specialists/${agentId}/notes`).then(data => { ui.notes[agentId] = data; }, error => { ui.notes[agentId] = { error: error.message }; })
    .finally(() => { ui.notesLoading[agentId] = false; ctx.renderAll(); });
}
export function notesSection(ctx, agent) {
  const { ui, esc } = ctx, data = ui.notes?.[agent.id];
  if (!data) { load(ctx, agent.id); return `<section class="ag-sec ag-notes"><h2>${t`Soul and memory`}</h2><p class="ag-help">${t`Loading…`}</p></section>`; }
  if (data.error) return `<section class="ag-sec ag-notes"><h2>${t`Soul and memory`}</h2><p class="ag-help">${esc(data.error)}</p></section>`;
  const tab = ui.notesTab === 'memory' ? 'memory' : 'soul', note = data[tab] || { text: '' }, history = data.history?.[tab] || [];
  const bytes = new Blob([note.text || '']).size, pending = tab === 'soul' ? data.soul?.pending : null;
  const tabs = `<div class="nt-tabs" role="tablist">${[['soul', t('Soul')], ['memory', t('Memory')]].map(([id, label]) => `<button type="button" role="tab" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}" data-action="spec-notes-tab" data-tab="${id}">${label}${id === 'soul' && data.soulPending ? '<i class="nt-dot" aria-hidden="true"></i>' : ''}</button>`).join('')}<span class="spacer"></span><button type="button" class="btn small quiet" data-action="spec-notes-export">${t`Export`}</button></div>`;
  const help = tab === 'soul' ? t`Who ${esc(agent.name)} is. It reads this every session and can only propose changes; you decide.` : t`${esc(agent.name)}'s own notebook: decisions, findings and finished work it wants to keep. It reads this every session and tidies it.`;
  const proposal = pending ? `<div class="nt-proposal"><p><b>${t`${esc(pending.by || agent.name)} proposes a change`}</b>${pending.reason ? ` · ${esc(pending.reason)}` : ''}</p><pre>${esc(pending.text)}</pre><div class="row"><button type="button" class="btn small primary" data-action="spec-notes-accept">${t`Accept`}</button><button type="button" class="btn small" data-action="spec-notes-decline">${t`Decline`}</button></div></div>` : '';
  const meter = tab === 'memory' ? `<progress class="nt-meter" max="${LIMIT}" value="${Math.min(LIMIT, bytes)}" aria-label="${t`${size(bytes)} of 8 KB`}"></progress><small class="nt-size">${t`${size(bytes)} of 8 KB`}</small>` : '';
  const written = note.at ? `<small class="nt-when">${t`Last written ${esc(when(note.at))}${note.by ? t` by ${esc(note.by)}` : ''}`}</small>` : `<small class="nt-when">${t`Nothing written yet.`}</small>`;
  const list = history.length ? `<details class="nt-history"><summary>${t`Earlier versions`} <span>${history.length}</span></summary><ul>${history.map(item => `<li><span><b>${esc(when(item.at || item.replacedAt))}</b>${item.by ? ` · ${esc(item.by)}` : ''}<small>${esc(String(item.text || '').split('\n').find(line => line.trim()) || t('Empty'))}</small></span><button type="button" class="btn small quiet" data-action="spec-notes-restore" data-id="${esc(item.id)}">${t`Restore`}</button></li>`).join('')}</ul></details>` : '';
  return `<section class="ag-sec ag-notes agp-sec">${tabs.replace('<div class="nt-tabs"', `<div class="nt-tabs" title="${help}"`)}${proposal}
    <textarea id="nt-text" rows="14" spellcheck="false" maxlength="9000" placeholder="${tab === 'memory' ? t`Empty. ${esc(agent.name)} writes here after decisions, corrections and finished work.` : ''}">${esc(note.text || '')}</textarea>
    <div class="nt-foot">${meter}${written}<span class="spacer"></span>${tab === 'memory' && note.text ? `<button type="button" class="btn small quiet" data-action="spec-notes-clear">${t`Clear`}</button>` : ''}<button type="button" class="btn small primary" data-action="spec-notes-save">${t`Save`}</button></div>${list}</section>`;
}
function download(name, text) { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' })); link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 2000); }
export function exportNotes(ctx, agent) {
  const data = ctx.ui.notes?.[agent.id]; if (!data) return;
  download(`${agent.slug || agent.name}-SOUL.md`, data.soul?.text || ''); setTimeout(() => download(`${agent.slug || agent.name}-MEMORY.md`, data.memory?.text || ''), 300);
}
// The card's buttons. True when the action was one of these.
export async function notesAction(ctx, action, target, agent) {
  const { ui, api, toast } = ctx, tab = ui.notesTab === 'memory' ? 'memory' : 'soul', base = `/specialists/${agent.id}/notes`;
  const reload = async () => { ui.notes[agent.id] = await api(base); ctx.renderAll(); };
  if (action === 'spec-notes-tab') { ui.notesTab = target.dataset.tab; ctx.renderAll(); return true; }
  if (action === 'spec-notes-export') { exportNotes(ctx, agent); return true; }
  if (action === 'spec-notes-save') { await api(base, { method: 'PUT', data: { kind: tab, text: document.getElementById('nt-text')?.value ?? '' } }); toast(t('Saved.')); await reload(); return true; }
  if (action === 'spec-notes-clear') { if (!confirm(t`Clear ${agent.name}'s memory? The old text stays under Earlier versions.`)) return true; await api(base, { method: 'PUT', data: { kind: 'memory', text: '' } }); await reload(); return true; }
  if (action === 'spec-notes-restore') { await api(`${base}/restore`, { method: 'POST', data: { kind: tab, historyId: target.dataset.id } }); toast(t('Put back.')); await reload(); return true; }
  if (action === 'spec-notes-accept' || action === 'spec-notes-decline') { await api(`${base}/decide`, { method: 'POST', data: { accept: action === 'spec-notes-accept' } }); toast(action === 'spec-notes-accept' ? t('Soul updated.') : t('Declined.')); await reload(); return true; }
  return false;
}

import { t } from './i18n.js';
import { askConfirm } from './confirm.js';
import { skeletonHtml } from './chat-skeleton.js';
// Market: one list of what agents can use on this computer (skills, commands, MCP servers) and the connectors, in the
// style of a system settings list. A switch per row turns an item on or off for the agent picked at the top; everything
// is on by default. "Used by" says how many agents have it on. The install box at the top adds new ones.

const KINDS = [['', t('All')], ['skill', t('Skills')], ['command', t('Commands')], ['mcp', t('MCP')], ['connector', t('Connectors')]];
const GROUP = { skill: t('Skills'), command: t('Commands'), mcp: t('MCP servers'), connector: t('Connectors') };
const PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const key = item => `${item.kind}:${item.name}`;
const shown = (item, query, kind) => (!kind || item.kind === kind) && (!query || `${item.name} ${item.description || ''}`.toLowerCase().includes(query));

export const MARKET_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/></svg>';

export async function loadMarket(ctx) {
  const { ui, api } = ctx;
  ui.market = await api('/market');
  if (!ui.marketBox) void api('/toolbox').then(box => { ui.marketBox = box; ctx.renderAll(); }).catch(() => { ui.marketBox = { servers: [], skills: [], commands: [] }; });
}

function usedBy(item, agents) {
  if (item.kind === 'connector') return item.enabled ? t('Connected') : t('Paused');
  if (item.fixed) return t('Always on for every agent');
  const on = agents.filter(agent => !agent.off.includes(key(item))).length;
  return on === agents.length ? t('Used by all agents') : on ? t`Used by ${on} of ${agents.length} agents` : t('Used by no agent');
}

// Whether Rex Desk may remove it (the same rule the old Settings list used).
function removable(ui, item) {
  const box = ui.marketBox; if (!box) return '';
  if (item.kind === 'skill') return box.skills.find(entry => entry.name === item.name)?.removable ? 'remove-skill' : '';
  if (item.kind === 'mcp') return box.servers.find(entry => entry.name === item.name)?.removable ? 'remove-server' : '';
  if (item.kind === 'command') return box.commands.some(entry => entry.name === item.name) ? 'remove-command' : '';
  return '';
}

function row(ctx, item, agent, agents, query) {
  const { esc, ui } = ctx, on = !agent?.off.includes(key(item)), remove = removable(ui, item);
  const name = item.kind === 'command' ? `/${item.name}` : item.name;
  const sub = item.error ? `<span class="mk-bad">${esc(t`Not working: ${item.error}`)}</span>` : item.description ? `<span class="mk-desc">${esc(item.description)}</span>` : '';
  const control = item.kind === 'connector' ? `<button type="button" class="btn small" data-action="mk-manage">${t`Manage`}</button>`
    : item.fixed || !agent ? '' : `<label class="switch"><input type="checkbox" role="switch" data-action="mk-switch" data-key="${esc(key(item))}" ${on ? 'checked' : ''} aria-label="${esc(t`${name} for ${agent.name}`)}"><span></span></label>`;
  return `<li class="mk-row${on ? '' : ' off'}"${shown(item, query, '') ? '' : ' hidden'} data-mk="${esc(`${item.name} ${item.description || ''}`.toLowerCase())}" data-kind="${item.kind}"><div class="mk-text"><b>${esc(name)}</b>${sub}<small class="mk-used-sm">${esc(usedBy(item, agents))}</small></div><span class="mk-used">${esc(usedBy(item, agents))}</span>${remove ? `<button type="button" class="mk-remove" data-action="mk-remove" data-what="${remove}" data-name="${esc(item.name)}">${t`Remove`}</button>` : ''}${control}</li>`;
}

export function marketStage(ctx) {
  const { ui, esc } = ctx, data = ui.market;
  const head = { title: t('Market'), meta: t('Skills, commands and MCP servers your agents can use'), top: true };
  if (!data) return { ...head, feed: `<div class="page mk">${skeletonHtml(6)}</div>` };
  const agents = data.agents || [], agent = agents.find(item => item.id === ui.marketAgent) || agents[0];
  const query = String(ui.marketQuery || '').trim().toLowerCase(), kind = ui.marketKind || '';
  const items = data.items || [];
  const groups = Object.keys(GROUP).map(group => {
    const list = items.filter(item => item.kind === group);
    if (!list.length || (kind && kind !== group)) return '';
    return `<section class="mk-group" data-group="${group}"${list.some(item => shown(item, query, '')) ? '' : ' hidden'}><h3>${GROUP[group]} <span class="cnt">${list.length}</span></h3><ul class="mk-list">${list.map(item => row(ctx, item, agent, agents, query)).join('')}</ul></section>`;
  }).join('');
  const busy = ui.marketBusy, result = ui.marketResult;
  const add = `<details class="mk-add"${ui.marketAddOpen ? ' open' : ''}><summary data-action="mk-add-toggle"><span class="mk-plus">${PLUS}</span><span class="mk-text"><b>${t`Add a skill, command or MCP server`}</b><span class="mk-desc">${t`Paste the install line from its page`}</span></span></summary>
    <div class="mk-add-body"><textarea name="mk-install" rows="2" spellcheck="false" autocomplete="off" aria-label="${t`Install command`}" placeholder="claude mcp add notion --transport http https://mcp.notion.com/mcp"${busy ? ' disabled' : ''}>${esc(ui.marketText || '')}</textarea>
    <div class="mk-add-foot"><span class="tb-kinds">${['claude mcp add …', 'npx skills add owner/repo', '{ "mcpServers": … }', t`a GitHub link or folder`].map(item => `<code>${esc(item)}</code>`).join('')}</span><button type="button" class="btn primary small" data-action="mk-install"${busy ? ' disabled' : ''}>${busy ? t('Installing…') : t('Install')}</button></div>
    ${result ? `<ul class="mk-result" role="status">${result.map(item => `<li class="${item.ok ? 'ok' : 'bad'}">${esc(item.ok ? t`${item.name}: installed, agents can find it` : `${item.name}: ${item.error}`)}</li>`).join('')}</ul>` : ''}</div></details>`;
  const bar = `<div class="mk-bar"><label class="mk-for"><span>${t`For`}</span><select data-mk-agent aria-label="${t`Agent`}">${agents.map(item => `<option value="${esc(item.id)}"${item.id === agent?.id ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
    <input type="search" class="mk-search" data-mk-search placeholder="${t`Search`}" aria-label="${t`Search the market`}" value="${esc(ui.marketQuery || '')}" autocomplete="off"></div>
    <div class="mk-seg" role="tablist" aria-label="${t`Show`}">${KINDS.map(([id, label]) => `<button type="button" role="tab" aria-selected="${kind === id}" class="${kind === id ? 'on' : ''}" data-action="mk-kind" data-kind="${id}">${label}</button>`).join('')}</div>`;
  const none = !items.some(item => shown(item, query, kind));
  return { ...head, meta: data.computer ? t`On ${data.computer}. Each of your computers has its own list.` : head.meta,
    feed: `<div class="page mk">${bar}${add}<div class="mk-groups">${groups}</div><p class="muted mk-none"${none ? '' : ' hidden'}>${t`Nothing matches.`}</p></div>` };
}

// Search filters the rows in place, so the box keeps focus while the person types.
export function filterMarket(ctx) {
  const query = String(ctx.ui.marketQuery || '').trim().toLowerCase(), page = document.querySelector('.page.mk'); if (!page) return;
  for (const item of page.querySelectorAll('.mk-row')) item.hidden = Boolean(query) && !item.dataset.mk.includes(query);
  for (const group of page.querySelectorAll('.mk-group')) group.hidden = ![...group.querySelectorAll('.mk-row')].some(item => !item.hidden);
  const none = page.querySelector('.mk-none'); if (none) none.hidden = [...page.querySelectorAll('.mk-row')].some(item => !item.hidden);
}

export async function marketAction(ctx, action, target) {
  const { ui, api, toast, renderAll } = ctx;
  if (action === 'mk-kind') { ui.marketKind = target.dataset.kind || ''; renderAll(); queueMicrotask(() => filterMarket(ctx)); return; }
  if (action === 'mk-add-toggle') { ui.marketAddOpen = !target.closest('details')?.open; return; }
  if (action === 'mk-manage') { ctx.openSettings('connectors'); return; }
  if (action === 'mk-switch') {
    const agent = (ui.market?.agents || []).find(item => item.id === ui.marketAgent) || ui.market?.agents?.[0]; if (!agent) return;
    try { ui.market = await api('/market/switch', { method: 'POST', data: { agent: agent.id, key: target.dataset.key, on: target.checked } }); ctx.ui.tools = {}; }
    catch (error) { target.checked = !target.checked; toast(error.message, true); }
    renderAll(); queueMicrotask(() => filterMarket(ctx)); return;
  }
  if (action === 'mk-install') {
    const box = document.querySelector('[name="mk-install"]'), text = box?.value.trim() || '';
    if (!text) { box?.focus(); return; }
    Object.assign(ui, { marketText: text, marketBusy: true, marketResult: null }); renderAll();
    try { const result = await api('/toolbox', { method: 'POST', data: { what: 'install', text } }); ui.marketBox = result; ui.marketResult = result.check || []; ui.marketText = ''; ui.market = await api('/market'); }
    catch (error) { ui.marketResult = [{ ok: false, name: t('Install'), error: error.message }]; }
    finally { ui.marketBusy = false; renderAll(); }
    return;
  }
  if (action === 'mk-remove') {
    const name = target.dataset.name;
    if (!await askConfirm(t`Remove ${name}?`)) return;
    try { ui.marketBox = await api('/toolbox', { method: 'POST', data: { what: target.dataset.what, name } }); ui.market = await api('/market'); toast(t('Removed.')); }
    catch (error) { toast(error.message, true); }
    renderAll();
  }
}

export function initMarket(ctx) {
  document.addEventListener('input', event => {
    if (!event.target.matches?.('[data-mk-search]')) return;
    ctx.ui.marketQuery = event.target.value; filterMarket(ctx);
  });
  document.addEventListener('change', event => {
    if (!event.target.matches?.('[data-mk-agent]')) return;
    ctx.ui.marketAgent = event.target.value; ctx.renderAll(); queueMicrotask(() => filterMarket(ctx));
  });
}

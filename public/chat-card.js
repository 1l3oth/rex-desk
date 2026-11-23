import { t } from './i18n.js';
import { aiId, aiName, aiChoices, confirmAiSwitch } from './ai-names.js';
// A small profile card for an agent, opened by clicking its picture or name in a chat: who it is, what it is doing,
// and the settings people change most (AI, model, account, its own loop, its name), saved as soon as they change.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let card = null, current = '';

function close() { card?.remove(); card = null; current = ''; }
function place(anchor) {
  const box = anchor.getBoundingClientRect(), width = 320, height = card.offsetHeight || 380;
  const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
  const below = box.bottom + 8 + height < window.innerHeight;
  card.style.left = `${left}px`; card.style.top = `${below ? box.bottom + 6 : Math.max(8, box.top - height - 6)}px`;
}
function html(ctx, agent) {
  const { ui } = ctx, provider = aiId(agent.provider);
  const models = ui.snap.choices?.providers?.[provider]?.models || ui.snap.choices?.models || [], efforts = ui.snap.choices?.providers?.[provider]?.efforts || [];
  const accounts = (ui.accounts?.[provider]?.profiles || []).filter(item => item.loggedIn);
  const status = agent.status || {};
  const select = (name, value, options) => `<select data-card="${name}">${options.map(([key, label]) => `<option value="${esc(key)}" ${String(value ?? '') === String(key) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  return `<div class="pc-head">${ctx.avatar({ name: agent.name })}<div class="pc-who"><div class="pc-name"><b>${esc(agent.name)}</b><button type="button" class="pc-edit" data-card-act="rename" title="${t`Rename`}" aria-label="${t`Rename ${esc(agent.name)}`}">&#9998;</button></div><small>@${esc(agent.slug || '')}${agent.projectSlug ? ` · ${esc(agent.projectSlug)}` : ''}${agent.device ? ` · ${esc(agent.device)}` : ''}</small>${agent.projectPath ? `<small class="pc-path" title="${esc(agent.projectPath)}">${esc(agent.projectPath)}</small>` : ''}<span class="pc-state ${esc(status.state || '')}"><i></i>${esc(status.label || t('Idle'))}</span></div><button type="button" class="pc-x" data-card-act="close" aria-label="${t`Close`}">&#215;</button></div>
    ${agent.purpose ? `<p class="pc-about">${esc(agent.purpose)}</p>` : ''}
    <div class="pc-rows">
      <label><span>AI</span>${select('provider', provider, aiChoices().map(item => [item.id, item.label]))}</label>
      <label><span>${t`Model`}</span>${select('model', agent.model || '', [['', t('Default')], ...models.map(model => [model.id, model.label])])}</label>
      <label><span>${t`Effort`}</span>${select('effort', agent.effort || '', [['', t('Chat picks')], ...efforts.map(level => [level, ({ low: t('Low'), medium: t('Medium'), high: t('High'), xhigh: t('Extra high'), max: t('Max') })[level] || level])])}</label>
      <label><span>${t`Account`}</span>${select('profile', agent.profile || '', [['', t('Same as everyone')], ...accounts.map(item => [item.profile, item.account || item.label])])}</label>
    </div>
    <div class="pc-acts"><button type="button" class="btn small primary" data-card-act="chat">${t`Message`}</button><button type="button" class="btn small" data-card-act="card">${t`Full card`}</button></div>`;
}
async function save(ctx, agent, field, value) {
  const { api, toast, refresh } = ctx;
  const data = field === 'model' ? { rules: agent.rules, unsure: agent.unsure || [], model: value } : { [field]: value };
  try {
    await api(`/specialists/${agent.id}`, { method: 'PUT', data });
    toast({ provider: t`${agent.name} now runs on ${aiName(value)}.`, model: t('Model saved.'), effort: t('Effort saved.'), profile: value ? t`${agent.name} now uses that account.` : t`${agent.name} uses the same account as everyone.` }[field]);
    await refresh({ full: true }); redraw(ctx);
  } catch (error) { toast(error.message, true); }
}
function redraw(ctx) {
  if (!card) return; const agent = (ctx.ui.snap.specialists || []).find(item => item.id === current); if (!agent) return close();
  card.innerHTML = html(ctx, agent);
}
export function openAgentCard(ctx, agentId, anchor) {
  const agent = (ctx.ui.snap.specialists || []).find(item => item.id === agentId);
  if (!agent) return false;
  if (card && current === agentId) { close(); return true; }
  close(); current = agentId;
  card = document.createElement('div'); card.className = 'pcard'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', `${agent.name}'s card`);
  card.innerHTML = html(ctx, agent); document.body.append(card); place(anchor);
  card.addEventListener('change', event => { const field = event.target.dataset.card; if (field) { const fresh = (ctx.ui.snap.specialists || []).find(item => item.id === current); if (!fresh) return; const value = event.target.value;
    if (field === 'provider' && aiId(fresh.provider) !== value) { void confirmAiSwitch(fresh.name, value).then(yes => yes ? save(ctx, fresh, field, value) : redraw(ctx)); return; }
    void save(ctx, fresh, field, value); } });
  card.addEventListener('click', async event => {
    const act = event.target.closest('[data-card-act]')?.dataset.cardAct; if (!act) return;
    const fresh = (ctx.ui.snap.specialists || []).find(item => item.id === current); if (!fresh) return close();
    if (act === 'close') return close();
    if (act === 'chat') { close(); document.body.insertAdjacentHTML('beforeend', `<button hidden id="pc-open" data-open="specialist" data-id="${esc(fresh.id)}"></button>`); document.getElementById('pc-open').click(); document.getElementById('pc-open')?.remove(); return; }
    if (act === 'card') { close(); document.body.insertAdjacentHTML('beforeend', `<button hidden id="pc-open" data-open="specialist" data-id="${esc(fresh.id)}" data-profile="1"></button>`); document.getElementById('pc-open').click(); document.getElementById('pc-open')?.remove(); return; }
    if (act === 'rename') {
      const name = card.querySelector('.pc-name'); name.innerHTML = `<input type="text" value="${esc(fresh.name)}" maxlength="40" aria-label="${t`New name`}"><button type="button" class="btn small primary" data-card-act="rename-save">${t`Save`}</button>`;
      const input = name.querySelector('input'); input.focus(); input.select();
      input.addEventListener('keydown', key => { if (key.key === 'Enter') { key.preventDefault(); name.querySelector('[data-card-act="rename-save"]').click(); } if (key.key === 'Escape') { key.stopPropagation(); redraw(ctx); } });
      return;
    }
    if (act === 'rename-save') {
      const value = card.querySelector('.pc-name input')?.value.trim(); if (!value || value === fresh.name) return redraw(ctx);
      try { await ctx.api(`/specialists/${fresh.id}/rename`, { method: 'POST', data: { name: value } }); ctx.toast(t`Renamed to ${value}.`); await ctx.refresh({ full: true }); redraw(ctx); } catch (error) { ctx.toast(error.message, true); }
    }
  });
  return true;
}
// Clicking an agent's picture or name anywhere it carries data-agent-card opens its card.
export function wireAgentCards(ctx) {
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('[data-agent-card]');
    if (anchor) { if (openAgentCard(ctx, anchor.dataset.agentCard, anchor)) { event.preventDefault(); event.stopPropagation(); } return; }
    if (card && !event.target.closest?.('.pcard')) close();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && card && !event.target.closest?.('.pc-name')) close(); });
  window.addEventListener('resize', close);
}

import { askConfirm } from './confirm.js';
import { t } from './i18n.js';
// Settings, Connectors: every outside app this desk is linked to, grouped by kind (task trackers, chat, code hosts, docs).
// Empty until the person adds one, so a desk that connects nothing shows no app names at all. The list of what can be
// connected comes from the server (src/connectors.js), so a new connector needs no change here.

const TYPE_NAMES = { tasks: t('Task trackers'), work: t('Project tools'), chat: t('Chat'), code: t('Code hosts'), docs: t('Docs and files'), tools: t('Developer tools') };
const TRACKERS = ['orbit', 'flow', 'morningmate'];
const NAMES = { orbit: 'Orbit', flow: 'Flow', morningmate: 'Morningmate' };
export const connectorName = type => NAMES[type] || type;

// A real brand mark (Simple Icons, CC0, in public/connectors/) drawn in the text colour through a CSS mask (chat.css,
// one rule per icon: the page allows no inline styles), or a plain letter tile.
export const logoHtml = (item, esc) => String(item?.icon || '').startsWith('letter:')
  ? `<span class="cx-logo cx-letter" aria-hidden="true">${esc(item.icon.slice(7))}</span>`
  : `<span class="cx-logo" aria-hidden="true" data-icon="${esc(String(item?.icon || '').replace(/\.svg$/, ''))}"></span>`;

export async function loadConnectors(ctx, state, draw) {
  if (state.extra.connectorsLoading) return;
  state.extra.connectorsLoading = true;
  try { state.extra.connectors = await ctx.api('/connectors'); } catch (error) { state.extra.connectors = { types: [], connectors: [], connections: [], accounts: [], error: error.message }; }
  state.extra.connectorsLoading = false; draw();
}

const ago = at => { const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60000); return !at ? t('not synced yet') : minutes < 1 ? t('synced just now') : minutes < 60 ? t`synced ${minutes} min ago` : minutes < 1440 ? t`synced ${Math.round(minutes / 60)} h ago` : t`synced ${Math.round(minutes / 1440)} d ago`; };

// The page. trackers: the Flow and Morningmate cards (chat-trackers.js), which keep their own editor for now.
export function connectorsHtml(ctx, state, cfg, { trackers = '', syncField = '' } = {}) {
  const { ui, esc } = ctx, data = state.extra.connectors;
  if (!data) return `<h2>${t`Connectors`}</h2>`;
  const byId = new Map(data.connectors.map(item => [item.id, item])), syncs = new Map((ui.snap.sync || []).map(item => [item.sourceId, item]));
  const pick = state.extra.connectorPick;
  if (pick === 'orbit') return orbitFormHtml(ctx, state, cfg);
  if (pick && pick !== 'all') return catalogFormHtml(ctx, state, data);
  if (pick) return pickerHtml(ctx, data);
  const count = id => (ui.snap.tasks || []).filter(task => task.sourceId === id).length;
  const rows = {};
  for (const item of data.connections.filter(item => byId.get(item.connectorId)?.id && !['flow', 'morningmate'].includes(item.connectorId))) {
    const kind = byId.get(item.connectorId), sync = syncs.get(item.id), busy = state.extra.connectorBusy === item.id;
    const sub = sync?.error ? `<span class="tb-status bad"><i aria-hidden="true"></i>${esc(sync.error)}</span>` : `<span>${esc(kind.name)} · ${count(item.id) === 1 ? t('1 task') : t`${count(item.id)} tasks`} · ${ago(sync?.at)}${item.enabled ? '' : ` · ${t('Off')}`}</span>`;
    const report = kind.gives.includes('report') ? `<label class="cx-opt"><input type="checkbox" data-cn-report="${esc(item.id)}" ${item.options.sendReport ? 'checked' : ''}> ${t`Agents send their final report here`}</label>` : '';
    (rows[kind.type] ||= []).push(`<li class="tb-row cx-row">${logoHtml(kind, esc)}<div class="tb-text"><b>${esc(item.name)}</b>${sub}${report}</div>
      <button type="button" class="btn small" data-cn-sync="${esc(item.id)}" ${busy ? 'disabled' : ''}>${busy ? t('Syncing…') : t('Sync')}</button>
      <button type="button" class="btn small quiet" data-cn-edit="${esc(item.id)}">${t`Change`}</button>
      <button type="button" class="btn small quiet danger" data-cn-remove="${esc(item.id)}" aria-label="${esc(t`Remove ${item.name}`)}">${t`Remove`}</button></li>`);
  }
  for (const account of data.accounts || []) {
    const kind = byId.get(account.connectorId); if (!kind) continue;
    (rows[kind.type] ||= []).push(`<li class="tb-row cx-row">${logoHtml(kind, esc)}<div class="tb-text"><b>${t`${esc(kind.name)} account`}</b><span>${t`Every agent can search and read your Orbit goals, notes and knowledge.`}</span></div>
      <button type="button" class="btn small quiet danger" data-cn-signout="${esc(account.connectorId)}">${t`Disconnect`}</button></li>`);
  }
  const items = new Map((data.catalog?.items || []).map(item => [item.id, item]));
  for (const link of data.links || []) {
    const kind = items.get(link.connectorId); if (!kind) continue;
    const sub = link.error ? `<span class="tb-status bad"><i aria-hidden="true"></i>${esc(link.error)}</span>` : `<span>${esc(howLine(kind, true))}</span>`;
    (rows[kind.group] ||= []).push(`<li class="tb-row cx-row">${logoHtml(kind, esc)}<div class="tb-text"><b>${esc(link.name)}</b>${sub}</div>
      <button type="button" class="btn small quiet danger" data-cn-unlink="${esc(link.id)}" aria-label="${esc(t`Remove ${link.name}`)}">${t`Remove`}</button></li>`);
  }
  const hasTrackers = Boolean(trackers);
  const groups = (data.catalog?.groups || data.types).map(type => {
    const list = rows[type.id] || [], extra = type.id === 'tasks' ? trackers : '';
    if (!list.length && !extra) return '';
    return `<h3>${TYPE_NAMES[type.id] || esc(type.name)}</h3>${list.length ? `<ul class="tb-list">${list.join('')}</ul>` : ''}${extra}`;
  }).join('');
  const empty = !groups && !hasTrackers;
  return `<h2>${t`Connectors`}</h2><p class="muted">${t`Link the apps your team already uses. Rex Desk tasks are built in, so you need nothing here to start.`}</p>
    ${empty ? `<div class="cx-empty"><p>${t`No apps connected.`}</p></div>` : `${syncField}${groups}`}
    <div class="st-actions"><button type="button" class="btn small${empty ? ' primary' : ''}" data-cn-add>${t`Add connector`}</button></div>`;
}

// How an item connects, in one line, from its catalog hint. after: the line under a connected row.
function howLine(item, after = false) {
  const { kind, auth } = item.connect || {};
  if (kind === 'remote-mcp' && auth === 'oauth') return after ? t`Agents can use ${item.name}. You sign in the first time one does.` : t`Sign in with ${item.name}`;
  if (kind === 'remote-mcp' && auth === 'none') return after ? t`Agents can use ${item.name}.` : t('No sign-in');
  if (kind === 'local-mcp') return after ? t`Agents can use ${item.name}. It runs on this computer.` : t('Runs on this computer');
  if (kind === 'webhook') return after ? t('Messages go to one channel.') : t('Paste a webhook address');
  if (kind === 'device') return t('Sign in');
  if (kind === 'remote-mcp') return after ? t`Agents can use ${item.name}.` : t('Paste a key');
  return after ? t('Key saved, locked on this computer.') : t('Paste a key');
}

function pickerHtml({ esc }, data) {
  const linked = new Set((data.links || []).map(link => link.connectorId));
  const groups = (data.catalog?.groups || []).map(group => {
    const items = data.catalog.items.filter(item => item.group === group.id);
    if (!items.length) return '';
    return `<h3>${TYPE_NAMES[group.id] || esc(group.name)}</h3><ul class="cx-grid">${items.map(item => {
      const ready = item.phase === 1, attrs = !ready ? 'disabled' : TRACKERS.includes(item.id) ? (item.id === 'orbit' ? 'data-cn-pick="orbit"' : `data-tr-add="${esc(item.id)}" data-cn-picked`) : `data-cn-pick="${esc(item.id)}"`;
      const sub = !ready ? t('Later') : linked.has(item.id) && item.tier === 'mcp' ? t('Connected') : howLine(item);
      return `<li><button type="button" class="cx-pick" ${attrs}>${logoHtml(item, esc)}<span class="cx-pname">${esc(item.name)}</span><small>${esc(sub)}</small></button></li>`;
    }).join('')}</ul>`;
  }).join('');
  return `<h2>${t`Add connector`}</h2><p class="muted">${t`Pick the app to link. Rex Desk checks that it really connects before anything is saved.`}</p>${groups}
    <div class="st-actions"><button type="button" class="btn small" data-cn-back>${t`Back`}</button></div>`;
}

const FIELD_LABELS = () => ({ apiKey: t('API key'), token: t('Token'), botToken: t('Bot token'), webhookUrl: t('Webhook address'), folder: t('Folder'), host: t('Address') });
const SECRET = ['apiKey', 'token', 'botToken', 'webhookUrl'];
// One catalog item: its fields, where to find them, then one button: Check, then Add once the check passed.
function catalogFormHtml({ esc }, state, data) {
  const item = (data.catalog?.items || []).find(entry => entry.id === state.extra.connectorPick); if (!item) return '';
  const values = state.extra.cnValues || {}, probe = state.extra.cnProbe, busy = state.extra.connectorBusy === 'catalog', labels = FIELD_LABELS();
  const fields = (item.connect.fields || []).map(raw => {
    const name = raw.replace(/\?$/, ''), optional = raw.endsWith('?') || name === 'host', secret = SECRET.includes(name);
    const hint = name === 'host' ? 'gitlab.com' : name === 'folder' ? 'D:\\work\\docs' : '';
    return `<label class="st-field"><span>${labels[name] || esc(name)}${optional ? ` <em class="muted">${t`optional`}</em>` : ''}</span><input data-cn-field="${esc(name)}" type="${secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" value="${esc(values[name] || '')}" placeholder="${esc(hint)}"></label>`;
  }).join('');
  const okLine = () => probe.needs === 'sign-in' ? t`${item.name} answered. You sign in with ${item.name} the first time an agent uses it.` : probe.tools != null ? (probe.tools === 1 ? t('It works: 1 tool for your agents.') : t`It works: ${probe.tools} tools for your agents.`) : probe.label ? t`It works: ${probe.label}.` : t('It works.');
  const line = busy ? `<p class="cx-probe muted" role="status">${t`Checking…`}</p>`
    : !probe ? ''
    : probe.ok ? `<p class="cx-probe ok" role="status">${esc(okLine())}</p>`
    : `<p class="cx-probe error-text" role="alert">${esc(probe.error || t('It did not connect.'))}</p>`;
  const button = probe?.ok ? `<button type="button" class="btn small primary" data-cn-save ${busy ? 'disabled' : ''}>${t`Add`}</button>` : `<button type="button" class="btn small primary" data-cn-probe ${busy ? 'disabled' : ''}>${probe ? t('Check again') : t('Check')}</button>`;
  const help = [item.connect.helpUrl && fields ? `<a href="${esc(item.connect.helpUrl)}" target="_blank" rel="noopener noreferrer">${t`Where to find it`}</a>` : '', item.connect.source && (item.connect.source !== item.connect.helpUrl || !fields) ? `<a href="${esc(item.connect.source)}" target="_blank" rel="noopener noreferrer">${t`${item.name} docs`}</a>` : ''].filter(Boolean).join(' · ');
  return `<h2>${t`Connect ${esc(item.name)}`}</h2><p class="muted">${esc(howLine(item))}.${item.note ? ` ${esc(item.note)}` : ''}</p>
    ${fields ? `<div class="cx-form">${fields}</div>` : ''}${help ? `<p class="small">${help}</p>` : ''}${line}
    <div class="st-actions">${button}<button type="button" class="btn small" data-cn-back>${t`Back`}</button></div>`;
}

// Orbit: one goal's tasks with a project key, or the account sign-in that gives every agent your goals and notes.
function orbitFormHtml({ esc }, state, cfg) {
  const editing = state.extra.connectorEdit ? (cfg.sources || []).find(item => item.id === state.extra.connectorEdit) : null;
  const signedIn = (state.extra.connectors?.accounts || []).some(item => item.connectorId === 'orbit'), login = state.extra.orbitLogin;
  const account = signedIn ? '' : login ? `<p>${t`Open Orbit and approve this code:`}</p><p class="orbit-code">${esc(login.userCode)}</p><p><a class="btn small primary" href="${esc(login.url)}" target="_blank" rel="noopener noreferrer">${t`Open Orbit to approve`}</a> <span class="muted small">${t`Waiting for you to approve…`}</span></p>`
    : `<p class="muted">${t`Give every agent your Orbit goals, notes and knowledge (search, read, add notes). You approve it once in Orbit; no key to copy.`}</p><div class="st-actions"><button type="button" class="btn small" data-cn-signin="orbit">${t`Sign in to Orbit`}</button></div>`;
  const busy = state.extra.connectorBusy === 'orbit-form';
  return `<h2>${editing ? t`Change ${esc(editing.name)}` : t('Connect an Orbit goal')}</h2><p class="muted">${t`Brings one goal's tasks into Tasks. For your goals, notes and knowledge in every agent, use the Orbit account sign-in instead. One Orbit goal per connection. In Orbit open the goal, then Settings → API → Generate Project Key, and paste the key (it starts with dgm_).`}</p>
    <div class="cx-form">
      <label class="st-field"><span>${t`Name`}</span><input data-cn-field="name" type="text" maxlength="80" value="${esc(editing?.name || 'Orbit')}"></label>
      <label class="st-field"><span>${t`Project key`}</span><input data-cn-field="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${editing?.hasKey ? t('Saved. Paste a new key to replace it.') : 'dgm_…'}"></label>
      <label class="st-field"><span>${t`Bring in`}</span><select data-cn-field="statusFilter">${[['active', t('Work that is on: To do, In progress, In review, Blocked')], ['unfinished', t('Everything not done, with the backlog')], ['all', t('Everything, done too')]].map(([value, label]) => `<option value="${value}" ${(editing?.statusFilter || 'active') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="cx-opt"><input type="checkbox" data-cn-field="sendReport" ${editing?.sendReport ? 'checked' : ''}> ${t`Agents send their final report here`}</label>
      <details><summary>${t`Orbit address`}</summary><label class="st-field"><span>${t`Address`}</span><input data-cn-field="baseUrl" type="url" value="${esc(editing?.baseUrl || 'https://orbitkh.vercel.app')}"></label></details>
    </div>
    ${state.extra.connectorError ? `<p class="error-text" role="alert">${esc(state.extra.connectorError)}</p>` : ''}
    <div class="st-actions"><button type="button" class="btn small primary" data-cn-orbit-save ${busy ? 'disabled' : ''}>${busy ? t('Checking the key…') : editing ? t('Save and sync') : t('Connect and sync')}</button><button type="button" class="btn small" data-cn-back>${t`Back`}</button></div>
    ${editing ? '' : `<h3>${t`Orbit account`}</h3><div class="cx-account">${account}</div>`}`;
}

// Clicks on the page. Returns true when it handled the click.
export async function connectorsClick(ctx, state, target, back, draw) {
  const { api, toast, refresh } = ctx, hit = name => target.closest(`[data-${name}]`);
  const reload = async () => { state.extra.connectors = await api('/connectors').catch(() => state.extra.connectors); await refresh({ full: true }); draw(); };
  if (hit('cn-add')) { state.extra.connectorPick = 'all'; state.extra.connectorError = ''; draw(); return true; }
  if (hit('cn-back')) { state.extra.cnProbe = null; state.extra.cnValues = {}; state.extra.connectorPick = ''; state.extra.connectorEdit = ''; state.extra.connectorError = ''; state.extra.orbitLogin = null; draw(); return true; }
  // Flow and Morningmate open their card in the list (chat-trackers.js adds it); this just leaves the picker.
  if (hit('cn-picked')) { state.extra.connectorPick = ''; return false; }
  const picked = hit('cn-pick'); if (picked) { state.extra.connectorPick = picked.dataset.cnPick; state.extra.connectorEdit = ''; state.extra.cnProbe = null; state.extra.cnValues = {}; draw(); return true; }
  const values = () => Object.fromEntries([...back.querySelectorAll('[data-cn-field]')].map(input => [input.dataset.cnField, input.value]));
  if (hit('cn-probe') || hit('cn-save')) {
    const id = state.extra.connectorPick, saving = Boolean(hit('cn-save')); state.extra.cnValues = values();
    state.extra.connectorBusy = 'catalog'; draw();
    try {
      if (saving) { const result = await api(`/connectors/catalog/${encodeURIComponent(id)}`, { method: 'POST', data: state.extra.cnValues }); toast(t`${result.saved.name} connected.`); state.extra.connectorPick = ''; state.extra.cnValues = {}; state.extra.cnProbe = null; }
      else state.extra.cnProbe = await api(`/connectors/catalog/${encodeURIComponent(id)}/probe`, { method: 'POST', data: state.extra.cnValues });
    } catch (error) { state.extra.cnProbe = { ok: false, error: error.message }; }
    state.extra.connectorBusy = ''; if (saving) await reload(); else draw(); return true;
  }
  const unlink = hit('cn-unlink');
  if (unlink) {
    const link = (state.extra.connectors?.links || []).find(entry => entry.id === unlink.dataset.cnUnlink); if (!link) return true;
    if (!await askConfirm(t`Remove ${link.name}? Agents stop using it; nothing changes in the app itself.`)) return true;
    try { await api(`/connectors/links/${encodeURIComponent(link.id)}`, { method: 'DELETE' }); } catch (error) { toast(error.message, true); }
    await reload(); return true;
  }
  const edit = hit('cn-edit'); if (edit) { state.extra.connectorPick = 'orbit'; state.extra.connectorEdit = edit.dataset.cnEdit; draw(); return true; }
  const sync = hit('cn-sync');
  if (sync) {
    state.extra.connectorBusy = sync.dataset.cnSync; draw();
    try { const result = await api(`/connectors/${encodeURIComponent(sync.dataset.cnSync)}/sync`, { method: 'POST', data: {} }); const failed = (Array.isArray(result) ? result : []).find(item => item.error); if (failed) toast(failed.error, true); }
    catch (error) { toast(error.message, true); }
    state.extra.connectorBusy = ''; await reload(); return true;
  }
  const remove = hit('cn-remove');
  if (remove) {
    const item = state.extra.connectors?.connections.find(entry => entry.id === remove.dataset.cnRemove); if (!item) return true;
    if (!await askConfirm(t`Remove ${item.name}? Its tasks leave the list; nothing changes in ${connectorName(item.connectorId)}.`)) return true;
    try { await api(`/connectors/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); } catch (error) { toast(error.message, true); }
    await reload(); return true;
  }
  if (hit('cn-signout')) { try { await api('/connectors/orbit/account', { method: 'DELETE' }); } catch (error) { toast(error.message, true); } await reload(); return true; }
  if (hit('cn-signin')) { void orbitSignIn(ctx, state, back, draw); return true; }
  if (hit('cn-orbit-save')) {
    const field = name => back.querySelector(`[data-cn-field="${name}"]`);
    const data = { id: state.extra.connectorEdit || '', name: field('name')?.value, apiKey: field('apiKey')?.value, statusFilter: field('statusFilter')?.value, baseUrl: field('baseUrl')?.value, sendReport: Boolean(field('sendReport')?.checked) };
    state.extra.connectorBusy = 'orbit-form'; state.extra.connectorError = ''; draw();
    try {
      const result = await api('/connectors/orbit', { method: 'POST', data });
      toast(result.sync?.error ? t`Connected, but the sync failed: ${result.sync.error}` : t`${result.source.name}: ${result.sync?.count ?? 0} tasks brought in.`, Boolean(result.sync?.error));
      state.extra.connectorPick = ''; state.extra.connectorEdit = '';
    } catch (error) { state.extra.connectorError = error.message; }
    state.extra.connectorBusy = ''; await reload(); return true;
  }
  return false;
}

// The "send report" box on a connected row saves at once.
export async function connectorsChange(ctx, state, target, draw) {
  // Changing a checked box clears the check, so Add always matches what is in the boxes.
  const typed = target.closest?.('[data-cn-field]');
  if (typed && state.extra.cnProbe && state.extra.connectorPick && state.extra.connectorPick !== 'orbit') { state.extra.cnValues = { ...(state.extra.cnValues || {}), [typed.dataset.cnField]: typed.value }; state.extra.cnProbe = null; draw(); return true; }
  const box = target.closest?.('[data-cn-report]'); if (!box) return false;
  try { await ctx.api(`/connectors/${encodeURIComponent(box.dataset.cnReport)}`, { method: 'PATCH', data: { options: { sendReport: box.checked } } }); state.extra.connectors = await ctx.api('/connectors'); }
  catch (error) { ctx.toast(error.message, true); box.checked = !box.checked; }
  draw(); return true;
}

async function orbitSignIn(ctx, state, back, draw) {
  try {
    const login = await ctx.api('/connectors/orbit/account/start', { method: 'POST', data: {} });
    state.extra.orbitLogin = login; draw(); window.open(login.url, '_blank', 'noopener');
    const until = Date.now() + login.expiresIn * 1000;
    while (Date.now() < until && document.body.contains(back) && state.extra.orbitLogin === login) {
      await new Promise(resolve => setTimeout(resolve, login.interval * 1000));
      const result = await ctx.api('/connectors/orbit/account/poll', { method: 'POST', data: {} });
      if (result.connected) { ctx.toast(t('Orbit connected. Agents can use your goals and notes from their next reply.')); state.extra.orbitLogin = null; state.extra.connectorPick = ''; state.extra.connectors = await ctx.api('/connectors'); draw(); return; }
    }
    if (state.extra.orbitLogin === login) { state.extra.orbitLogin = null; ctx.toast(t('The code expired before it was approved.'), true); draw(); }
  } catch (error) { state.extra.orbitLogin = null; ctx.toast(error.message, true); draw(); }
}

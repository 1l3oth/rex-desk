import { askConfirm } from './confirm.js';
import { t } from './i18n.js';
// Settings, Connectors: every outside app this desk is linked to, grouped by kind (task trackers, chat, code hosts, docs).
// Empty until the person adds one, so a desk that connects nothing shows no app names at all. The list of what can be
// connected comes from the server (src/connectors.js), so a new connector needs no change here.

const TYPE_NAMES = { tasks: t('Task trackers'), work: t('Project tools'), chat: t('Chat'), code: t('Code hosts'), docs: t('Docs and files'), tools: t('Developer tools') };
const TRACKERS = ['orbit', 'flow', 'morningmate'];
const NAMES = { orbit: 'Orbit', flow: 'Flow', morningmate: 'Morningmate' };
export const connectorName = type => NAMES[type] || type;

// The company's own logo. Colour marks (public/connectors/color/) show as pictures; dark brands (GitHub, Notion, Vercel,
// Sentry) and the folder are drawn in the text colour through a CSS mask (chat.css, one rule per icon: the page allows no
// inline styles), so they stay visible in dark mode. An old letter tile still works for a catalog that names one.
export const logoHtml = (item, esc) => {
  const icon = String(item?.icon || '');
  if (icon.startsWith('letter:')) return `<span class="cx-logo cx-letter" aria-hidden="true">${esc(icon.slice(7))}</span>`;
  if (icon.startsWith('color/')) return `<img class="cx-logo cx-img" src="/connectors/${esc(icon)}" alt="" aria-hidden="true" loading="lazy" decoding="async">`;
  return `<span class="cx-logo" aria-hidden="true" data-icon="${esc(icon.replace(/\.svg$/, ''))}"></span>`;
};

export async function loadConnectors(ctx, state, draw) {
  if (state.extra.connectorsLoading) return;
  state.extra.connectorsLoading = true;
  try { state.extra.connectors = await ctx.api('/connectors'); } catch (error) { state.extra.connectors = { types: [], connectors: [], connections: [], accounts: [], error: error.message }; }
  state.extra.connectorsLoading = false; draw();
}

const ago = at => { const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60000); return !at ? t('not synced yet') : minutes < 1 ? t('synced just now') : minutes < 60 ? t`synced ${minutes} min ago` : minutes < 1440 ? t`synced ${Math.round(minutes / 60)} h ago` : t`synced ${Math.round(minutes / 1440)} d ago`; };

// One linked connection: its state line (or its failed sync, kept on its own row), then Sync, Change and Remove.
function connectionRow({ ui, esc }, state, item, kind, tag) {
  const sync = (ui.snap.sync || []).find(entry => entry.sourceId === item.id), busy = state.extra.connectorBusy === item.id;
  const tasks = (ui.snap.tasks || []).filter(task => task.sourceId === item.id).length;
  // A failed sync stays on its own row (a Sync click or a save that synced), never on the add form.
  const failed = state.extra.syncErrors?.[item.id] ?? sync?.error;
  const sub = failed ? `<span class="tb-status bad"><i aria-hidden="true"></i>${esc(failed)}</span>` : `<span>${esc(kind.name)} · ${tasks === 1 ? t('1 task') : t`${tasks} tasks`} · ${ago(sync?.at)}${item.enabled ? '' : ` · ${t('Off')}`}</span>`;
  const report = kind.gives.includes('report') ? `<label class="cx-opt"><input type="checkbox" data-cn-report="${esc(item.id)}" ${item.options.sendReport ? 'checked' : ''}> ${t`Agents send their final report here`}</label>` : '';
  return `<li class="tb-row cx-row">${logoHtml(kind, esc)}<div class="tb-text"><span class="mk-name"><b>${esc(item.name)}</b><span class="mk-tag">${esc(tag)}</span></span>${sub}${report}</div>
      <button type="button" class="btn small" data-cn-sync="${esc(item.id)}" ${busy ? 'disabled' : ''}>${busy ? t('Syncing…') : t('Sync')}</button>
      <button type="button" class="btn small quiet" data-cn-edit="${esc(item.id)}">${failed ? t('Paste a new key') : t('Change')}</button>
      <button type="button" class="btn small quiet danger" data-cn-remove="${esc(item.id)}" aria-label="${esc(t`Remove ${item.name}`)}">${t`Remove`}</button></li>`;
}

// The page. trackers: the Flow and Morningmate cards (chat-trackers.js), which keep their own editor for now.
export function connectorsHtml(ctx, state, cfg, { trackers = '', syncField = '' } = {}) {
  const { ui, esc } = ctx, data = state.extra.connectors;
  if (!data) return `<h2>${t`Connectors`}</h2>`;
  const byId = new Map(data.connectors.map(item => [item.id, item]));
  const pick = state.extra.connectorPick;
  if (pick === 'orbit') return orbitFormHtml(ctx, state, cfg, byId.get('orbit'));
  if (pick && pick !== 'all') return catalogFormHtml(ctx, state, data);
  if (pick) return pickerHtml(ctx, data);
  const rows = {};
  for (const item of data.connections.filter(item => byId.get(item.connectorId)?.id && !['flow', 'morningmate', 'orbit'].includes(item.connectorId))) {
    const kind = byId.get(item.connectorId);
    (rows[kind.type] ||= []).push(connectionRow(ctx, state, item, kind, t('API')));
  }
  // Orbit (goals and account) only speaks MCP, so it shows in Market under MCP servers, not here.
  for (const account of (data.accounts || []).filter(item => item.connectorId !== 'orbit')) {
    const kind = byId.get(account.connectorId); if (!kind) continue;
    (rows[kind.type] ||= []).push(`<li class="tb-row cx-row">${logoHtml(kind, esc)}<div class="tb-text"><b>${t`${esc(kind.name)} account`}</b><span>${t`Every agent can search and read your Orbit goals, notes and knowledge.`}</span></div>
      <button type="button" class="btn small quiet danger" data-cn-signout="${esc(account.connectorId)}">${t`Disconnect`}</button></li>`);
  }
  const items = new Map((data.catalog?.items || []).map(item => [item.id, item]));
  for (const link of data.links || []) {
    const kind = items.get(link.connectorId); if (!kind) continue;
    const sub = link.error ? `<span class="tb-status bad"><i aria-hidden="true"></i>${esc(link.error)}</span>` : `<span>${esc(howLine(kind, true))}</span>`;
    (rows[kind.group] ||= []).push(`<li class="tb-row cx-row">${logoHtml(kind, esc)}<div class="tb-text"><span class="mk-name"><b>${esc(link.name)}</b><span class="mk-tag">${esc(tagOf(kind))}</span></span>${sub}</div>
      <button type="button" class="btn small quiet danger" data-cn-unlink="${esc(link.id)}" aria-label="${esc(t`Remove ${link.name}`)}">${t`Remove`}</button></li>`);
  }
  const hasTrackers = Boolean(trackers);
  const groups = (data.catalog?.groups || data.types).map(type => {
    const list = rows[type.id] || [], extra = type.id === 'tasks' ? trackers : '';
    if (!list.length && !extra) return '';
    return `<h3>${TYPE_NAMES[type.id] || esc(type.name)}</h3>${list.length ? `<ul class="tb-list">${list.join('')}</ul>` : ''}${extra}`;
  }).join('');
  const empty = !groups && !hasTrackers;
  return `<h2>${t`Connectors`}</h2><p class="muted">${t`Apps Rex Desk reaches through their API with a key you paste (API), or that agents use as an MCP server (MCP). Skills, commands, hooks and your other MCP servers are in Market.`}</p>
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

// API: Rex Desk calls the app with a key you pasted and fetches its data. MCP: agents use the app's own MCP server.
const tagOf = item => /mcp/.test(item?.connect?.kind || '') ? t('MCP') : t('API');

function pickerHtml({ esc }, data) {
  const linked = new Set((data.links || []).map(link => link.connectorId));
  const groups = (data.catalog?.groups || []).map(group => {
    const items = data.catalog.items.filter(item => item.group === group.id && item.id !== 'orbit');
    if (!items.length) return '';
    return `<h3>${TYPE_NAMES[group.id] || esc(group.name)}</h3><ul class="cx-grid">${items.map(item => {
      const ready = item.phase === 1, attrs = !ready ? 'disabled' : TRACKERS.includes(item.id) ? (item.id === 'orbit' ? 'data-cn-pick="orbit"' : `data-tr-add="${esc(item.id)}" data-cn-picked`) : `data-cn-pick="${esc(item.id)}"`;
      const sub = !ready ? t('Later') : linked.has(item.id) && item.tier === 'mcp' ? t('Connected') : howLine(item);
      return `<li><button type="button" class="cx-pick" ${attrs}>${logoHtml(item, esc)}<span class="cx-pname">${esc(item.name)} <span class="mk-tag">${esc(tagOf(item))}</span></span><small>${esc(sub)}</small></button></li>`;
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
function orbitFormHtml(ctx, state, cfg, kind) {
  const { esc } = ctx;
  const editing = state.extra.connectorEdit ? (cfg.sources || []).find(item => item.id === state.extra.connectorEdit) : null;
  const signedIn = (state.extra.connectors?.accounts || []).some(item => item.connectorId === 'orbit'), login = state.extra.orbitLogin;
  const account = signedIn ? `<ul class="tb-list"><li class="tb-row cx-row">${logoHtml(kind, esc)}<div class="tb-text"><b>${t`Orbit account`}</b><span>${t`Every agent can search and read your Orbit goals, notes and knowledge.`}</span></div>
      <button type="button" class="btn small quiet danger" data-cn-signout="orbit">${t`Disconnect`}</button></li></ul>` : login ? `<p>${t`Open Orbit and approve this code:`}</p><p class="orbit-code">${esc(login.userCode)}</p><p><a class="btn small primary" href="${esc(login.url)}" target="_blank" rel="noopener noreferrer">${t`Open Orbit to approve`}</a> <span class="muted small">${t`Waiting for you to approve…`}</span></p>`
    : `<p class="muted">${t`Give every agent your Orbit goals, notes and knowledge (search, read, add notes). You approve it once in Orbit; no key to copy.`}</p><div class="st-actions"><button type="button" class="btn small" data-cn-signin="orbit">${t`Sign in to Orbit`}</button></div>`;
  const busy = state.extra.connectorBusy === 'orbit-form';
  // Only the error of this very form: an add error never shows on a change form, nor the other way round.
  const formError = state.extra.connectorError?.form === (editing?.id || 'new') ? state.extra.connectorError.text : '';
  const goals = editing ? [] : (state.extra.connectors?.connections || []).filter(item => item.connectorId === 'orbit');
  // Orbit speaks only MCP: Market lists it under MCP servers, and its Manage button opens this page.
  const top = editing ? '' : `<h2>Orbit <span class="mk-tag">${t`MCP`}</span></h2><p class="muted">${t`Orbit connects through its MCP server: agents use your goals, notes and knowledge, and a goal's tasks come into Tasks.`}</p>
    ${goals.length ? `<h3>${t`Goals`}</h3><ul class="tb-list">${goals.map(item => connectionRow(ctx, state, item, kind, t('MCP'))).join('')}</ul>` : ''}
    <h3>${t`Orbit account`}</h3><div class="cx-account">${account}</div>`;
  return `${top}<${editing ? 'h2' : 'h3'}>${editing ? t`Change ${esc(editing.name)}` : t('Connect an Orbit goal')}</${editing ? 'h2' : 'h3'}><p class="muted">${t`Brings one goal's tasks into Tasks. For your goals, notes and knowledge in every agent, use the Orbit account sign-in instead. One Orbit goal per connection. In Orbit open the goal, then Settings → API → Generate Project Key, and paste the key (it starts with dgm_).`}</p>
    <div class="cx-form">
      <label class="st-field"><span>${t`Name`}</span><input data-cn-field="name" type="text" maxlength="80" value="${esc(editing?.name || 'Orbit')}"></label>
      <label class="st-field"><span>${t`Project key`}</span><input data-cn-field="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${editing?.hasKey ? t('Saved. Paste a new key to replace it.') : 'dgm_…'}"></label>
      <label class="st-field"><span>${t`Bring in`}</span><select data-cn-field="statusFilter">${[['active', t('Work that is on: To do, In progress, In review, Blocked')], ['unfinished', t('Everything not done, with the backlog')], ['all', t('Everything, done too')]].map(([value, label]) => `<option value="${value}" ${(editing?.statusFilter || 'active') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="cx-opt"><input type="checkbox" data-cn-field="sendReport" ${editing?.sendReport ? 'checked' : ''}> ${t`Agents send their final report here`}</label>
      <details><summary>${t`Orbit address`}</summary><label class="st-field"><span>${t`Address`}</span><input data-cn-field="baseUrl" type="url" value="${esc(editing?.baseUrl || (state.extra.connectors?.connectors || []).find(item => item.id === 'orbit')?.baseUrl || '')}"></label></details>
    </div>
    ${formError ? `<p class="error-text" role="alert">${esc(formError)}</p>` : ''}
    <div class="st-actions"><button type="button" class="btn small primary" data-cn-orbit-save ${busy ? 'disabled' : ''}>${busy ? t('Checking the key…') : editing ? t('Save and sync') : t('Connect and sync')}</button><button type="button" class="btn small" data-cn-back>${t`Back`}</button></div>`;
}

// Clicks on the page. Returns true when it handled the click.
export async function connectorsClick(ctx, state, target, back, draw) {
  const { api, toast, refresh } = ctx, hit = name => target.closest(`[data-${name}]`);
  const reload = async () => { state.extra.connectors = await api('/connectors').catch(() => state.extra.connectors); await refresh({ full: true }); draw(); };
  if (hit('cn-add')) { state.extra.connectorPick = 'all'; state.extra.connectorError = ''; draw(); return true; }
  if (hit('cn-back')) { const toOrbit = state.extra.connectorPick === 'orbit' && Boolean(state.extra.connectorEdit); state.extra.cnProbe = null; state.extra.cnValues = {}; state.extra.connectorPick = ''; state.extra.connectorEdit = ''; state.extra.connectorError = ''; state.extra.orbitLogin = null; if (toOrbit) state.extra.connectorPick = 'orbit'; draw(); return true; }
  // Flow and Morningmate open their card in the list (chat-trackers.js adds it); this just leaves the picker.
  if (hit('cn-picked')) { state.extra.connectorPick = ''; return false; }
  const picked = hit('cn-pick'); if (picked) { state.extra.connectorPick = picked.dataset.cnPick; state.extra.connectorEdit = ''; state.extra.connectorError = ''; state.extra.cnProbe = null; state.extra.cnValues = {}; draw(); return true; }
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
  const edit = hit('cn-edit'); if (edit) { state.extra.connectorPick = 'orbit'; state.extra.connectorEdit = edit.dataset.cnEdit; state.extra.connectorError = ''; draw(); return true; }
  const sync = hit('cn-sync');
  if (sync) {
    const id = sync.dataset.cnSync, errors = state.extra.syncErrors ||= {};
    state.extra.connectorBusy = id; draw();
    try { const result = await api(`/connectors/${encodeURIComponent(id)}/sync`, { method: 'POST', data: {} }); const failed = (Array.isArray(result) ? result : []).find(item => item.error); if (failed) errors[id] = failed.error; else delete errors[id]; }
    catch (error) { errors[id] = error.message; }
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
      const result = await api('/connectors/orbit', { method: 'POST', data }), errors = state.extra.syncErrors ||= {};
      // Saved: a sync that then fails belongs on the connection's row, not on the form.
      if (result.sync?.error) errors[result.source.id] = result.sync.error; else delete errors[result.source.id];
      toast(result.sync?.error ? t`Connected, but the sync failed: ${result.sync.error}` : t`${result.source.name}: ${result.sync?.count ?? 0} tasks brought in.`, Boolean(result.sync?.error));
      state.extra.connectorPick = 'orbit'; state.extra.connectorEdit = '';
    } catch (error) { state.extra.connectorError = { form: data.id || 'new', text: error.message }; }
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
      if (result.connected) { ctx.toast(t('Orbit connected. Agents can use your goals and notes from their next reply.')); state.extra.orbitLogin = null; state.extra.connectorPick = 'orbit'; state.extra.connectors = await ctx.api('/connectors'); draw(); return; }
    }
    if (state.extra.orbitLogin === login) { state.extra.orbitLogin = null; ctx.toast(t('The code expired before it was approved.'), true); draw(); }
  } catch (error) { state.extra.orbitLogin = null; ctx.toast(error.message, true); draw(); }
}

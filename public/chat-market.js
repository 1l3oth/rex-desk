import { t } from './i18n.js';
import { askConfirm } from './confirm.js';
import { skeletonHtml } from './chat-skeleton.js';
import { pickerHtml } from './chat-pick.js';
// Market: one list of what agents can use on this computer (MCP servers, API connections, skills, commands, hooks), in the
// style of a system settings list. A switch per row turns an item on or off for the agent picked at the top; everything
// is on by default. "Used by" says how many agents have it on. The add box at the top adds new ones.

// Each kind gets a plain label on its row, so it is clear what it is: an MCP server, an app reached through its API with a key,
// a skill (a folder, or only a SKILL.md file), a slash command, or a hook.
const KINDS = [['', t('All')], ['mcp', t('MCP')], ['connector', t('API')], ['skill', t('Skills')], ['command', t('Commands')], ['hook', t('Hooks')]];
const GROUP = { mcp: t('MCP servers'), connector: t('API connections'), skill: t('Skills'), command: t('Commands'), hook: t('Hooks') };
const TAG = item => item.kind === 'mcp' ? t('MCP') : item.kind === 'connector' ? t('API') : item.kind === 'skill' ? (item.file ? t('Skill file') : t('Skill')) : item.kind === 'command' ? t('Command') : t('Hook');
// What Rex Agent is asked when the person presses "What is this?" or "Ask AI" (an agent prompt, so it stays in English).
const KIND_ASK = { mcp: 'an MCP server', connector: 'an API connection (a connector that uses a key)', skill: 'a skill', command: 'a slash command', hook: 'a hook' };
const ADD_TABS = [['line', t('Install line')], ['skill-file', t('Skill file')], ['command', t('Command')], ['hook', t('Hook')]];
const HOOK_EVENTS = [['PreToolUse', t('Before a tool runs')], ['PostToolUse', t('After a tool runs')], ['UserPromptSubmit', t('When you send a message')], ['Stop', t('When the agent finishes')], ['SessionStart', t('When a chat starts')], ['Notification', t('When the agent needs you')]];
const PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const key = item => `${item.kind}:${item.name}`;
const shown = (item, query, kind) => (!kind || item.kind === kind) && (!query || `${item.name} ${item.description || ''}`.toLowerCase().includes(query));

export const MARKET_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/></svg>';

export async function loadMarket(ctx) {
  const { ui, api } = ctx;
  ui.market = await api('/market');
  // The toolbox check also asks each MCP server for its tools; once done, the list again so each server shows its tools.
  if (!ui.marketBox) void api('/toolbox').then(async box => { ui.marketBox = box; ui.market = await api('/market').catch(() => ui.market); ctx.renderAll(); }).catch(() => { ui.marketBox = { servers: [], skills: [], commands: [] }; });
}

function usedBy(item, agents) {
  if (item.kind === 'connector') return item.enabled ? t('Connected') : t('Paused');
  if (item.orbit) return item.orbit.signedIn || item.orbit.goals ? t('Connected') : t('Not connected yet');
  if (item.remote) return t('Not connected yet');
  if (item.kind === 'hook') return t('Runs for every agent');
  if (item.fixed) return t('Always on for every agent');
  const on = agents.filter(agent => !agent.off.includes(key(item))).length;
  return on === agents.length ? t('Used by all agents') : on ? t`Used by ${on} of ${agents.length} agents` : t('Used by no agent');
}

// Whether Rex Desk may remove it (the same rule the old Settings list used).
function removable(ui, item) {
  if (item.kind === 'hook') return 'remove-hook';
  const box = ui.marketBox; if (!box) return '';
  if (item.kind === 'skill') return box.skills.find(entry => entry.name === item.name)?.removable ? 'remove-skill' : '';
  if (item.kind === 'mcp') return box.servers.find(entry => entry.name === item.name)?.removable ? 'remove-server' : '';
  if (item.kind === 'command') return box.commands.some(entry => entry.name === item.name) ? 'remove-command' : '';
  return '';
}

function row(ctx, item, agent, agents, query) {
  const { esc, ui } = ctx, on = !agent?.off.includes(key(item)), remove = removable(ui, item);
  const name = item.kind === 'command' ? `/${item.name}` : item.name;
  const about = item.orbit ? [item.orbit.signedIn || !item.orbit.goals ? t('Your Orbit goals, notes and knowledge') : '', item.orbit.goals === 1 ? t('Tasks of 1 goal') : item.orbit.goals ? t`Tasks of ${item.orbit.goals} goals` : ''].filter(Boolean).join(' · ') : item.remote ? t`${item.description} · Sign in with your ${item.name} account` : item.description;
  const servers = item.orbit?.servers?.length ? `<span class="mk-desc">${item.orbit.servers.map(server => esc(t`${server.name}: ${server.url}`)).join(' · ')}</span>` : '';
  const sub = item.error ? `<span class="mk-bad">${esc(t`Not working: ${item.error}`)}</span>` : about ? `<span class="mk-desc">${esc(about)}</span>` : '';
  const ask = `<button type="button" class="mk-ask" data-action="mk-explain" data-kind="${item.kind}" data-name="${esc(name)}" data-tag="${esc(TAG(item))}">${t`Ask AI`}</button>`;
  const control = item.remote ? `<button type="button" class="btn small" data-action="mk-manage" data-pick="${esc(item.remote)}">${t`Connect`}</button>`
    : item.kind === 'connector' || item.orbit ? `<button type="button" class="btn small" data-action="mk-manage"${item.orbit ? ' data-orbit' : ''}>${item.orbit && !item.orbit.signedIn && !item.orbit.goals ? t`Connect` : t`Manage`}</button>`
    : item.fixed || !agent ? '' : `<label class="switch"><input type="checkbox" role="switch" data-action="mk-switch" data-key="${esc(key(item))}" ${on ? 'checked' : ''} aria-label="${esc(t`${name} for ${agent.name}`)}"><span></span></label>`;
  const removeButton = remove ? `<button type="button" class="mk-remove" data-action="mk-remove" data-what="${remove}" data-name="${esc(item.kind === 'hook' ? item.id : item.name)}" data-label="${esc(name)}">${t`Remove`}</button>` : '';
  return `<li class="mk-row${on ? '' : ' off'}"${shown(item, query, '') ? '' : ' hidden'} data-mk="${esc(`${item.name} ${item.description || ''}`.toLowerCase())}" data-kind="${item.kind}"><div class="mk-text"><span class="mk-name"><b>${esc(name)}</b><span class="mk-tag">${esc(TAG(item))}</span></span>${sub}${servers}<small class="mk-used-sm">${esc(usedBy(item, agents))}</small></div><span class="mk-used">${esc(usedBy(item, agents))}</span>${ask}${removeButton}${control}</li>`;
}

// The add box: an install line, a SKILL.md pasted or uploaded and named, a slash command, or a hook.
function addHtml(ctx) {
  const { ui, esc } = ctx, busy = ui.marketBusy, result = ui.marketResult, tab = ui.marketAddTab || 'line', off = busy ? ' disabled' : '';
  const tabs = `<div class="mk-seg mk-add-tabs" role="tablist" aria-label="${t`What to add`}">${ADD_TABS.map(([id, label]) => `<button type="button" role="tab" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}" data-action="mk-add-tab" data-tab="${id}">${label}</button>`).join('')}</div>`;
  const draft = ui.marketDraft || {}, keep = name => ` value="${esc(draft[name] || '')}"`;
  const field = (label, control) => `<label class="mk-field"><span>${label}</span>${control}</label>`;
  const name = placeholder => field(t('Name'), `<input name="mk-name" type="text" maxlength="60" autocomplete="off" spellcheck="false" placeholder="${placeholder}"${keep('mk-name')}${off}>`);
  const foot = (left, action, label) => `<div class="mk-add-foot">${left || '<span></span>'}<button type="button" class="btn primary small" data-action="${action}"${off}>${busy ? t('Adding…') : label}</button></div>`;
  const body = tab === 'skill-file' ? `<p class="mk-hint">${t`A skill can be just one SKILL.md file: steps an agent follows. Paste it or upload it, and give it a name.`}</p>${name('release-notes')}
      <textarea name="mk-text" rows="6" spellcheck="false" aria-label="${t`SKILL.md text`}" placeholder="---&#10;name: release-notes&#10;description: Write short release notes from the commits&#10;---"${off}>${esc(draft['mk-text'] || '')}</textarea>
      ${foot(`<label class="btn small mk-upload">${t`Upload SKILL.md`}<input type="file" accept=".md,text/markdown,text/plain" data-mk-upload hidden${off}></label>`, 'mk-add-skill-file', t('Add skill'))}`
    : tab === 'command' ? `<p class="mk-hint">${t`A command is a saved message. Type / and its name in any chat, and the agent does what it says.`}</p>${name('review')}
      <textarea name="mk-text" rows="4" spellcheck="false" aria-label="${t`What the command says`}" placeholder="${esc(t('Review my last change and list any bugs.'))}"${off}>${esc(draft['mk-text'] || '')}</textarea>
      ${foot('', 'mk-add-command', t('Add command'))}`
    : tab === 'hook' ? `<p class="mk-hint">${t`A hook runs a command on this computer by itself at a set moment, like after every file an agent edits.`}</p>
      <div class="mk-pair">${field(t('When'), pickerHtml(ctx, { id: 'mk-hook-event', label: t('When'), items: HOOK_EVENTS.map(([value, label]) => ({ value, label })), value: ui.marketHookEvent || 'PostToolUse', compact: true }))}${field(t('Only for tool'), `<input name="mk-matcher" type="text" maxlength="80" autocomplete="off" spellcheck="false" placeholder="${esc(t('Any tool, or e.g. Edit|Write'))}"${keep('mk-matcher')}${off}>`)}</div>
      ${field(t('Command'), `<input name="mk-text" type="text" autocomplete="off" spellcheck="false" placeholder="npx prettier --write ."${keep('mk-text')}${off}>`)}
      ${foot('', 'mk-add-hook', t('Add hook'))}`
    : `<textarea name="mk-install" rows="2" spellcheck="false" autocomplete="off" aria-label="${t`Install command`}" placeholder="claude mcp add notion --transport http https://mcp.notion.com/mcp"${off}>${esc(ui.marketText || '')}</textarea>
      <div class="mk-add-foot"><span class="tb-kinds">${['claude mcp add …', 'npx skills add owner/repo', '{ "mcpServers": … }', t`a GitHub link or folder`].map(item => `<code>${esc(item)}</code>`).join('')}</span><button type="button" class="btn primary small" data-action="mk-install"${off}>${busy ? t('Installing…') : t('Install')}</button></div>`;
  return `<details class="mk-add"${ui.marketAddOpen ? ' open' : ''}><summary data-action="mk-add-toggle"><span class="mk-plus">${PLUS}</span><span class="mk-text"><b>${t`Add an MCP server, skill, command or hook`}</b><span class="mk-desc">${t`Paste an install line, a SKILL.md file, a command or a hook`}</span></span></summary>
    <div class="mk-add-body">${tabs}${body}
    ${result ? `<ul class="mk-result" role="status">${result.map(item => `<li class="${item.ok ? 'ok' : 'bad'}">${esc(item.ok ? t`${item.name}: installed, agents can find it` : `${item.name}: ${item.error ? t(item.error) : ''}`)}</li>`).join('')}</ul>` : ''}</div></details>`;
}

export function marketStage(ctx) {
  const { ui, esc } = ctx, data = ui.market;
  const head = { title: t('Market'), meta: t('MCP servers, API connections, skills, commands and hooks your agents can use'), top: true };
  if (!data) return { ...head, feed: `<div class="page mk">${skeletonHtml(6)}</div>` };
  const agents = data.agents || [], agent = agents.find(item => item.id === ui.marketAgent) || agents[0];
  const query = String(ui.marketQuery || '').trim().toLowerCase(), kind = ui.marketKind || '';
  const items = data.items || [];
  const groups = Object.keys(GROUP).map(group => {
    const list = items.filter(item => item.kind === group);
    if (!list.length || (kind && kind !== group)) return '';
    return `<section class="mk-group" data-group="${group}"${list.some(item => shown(item, query, '')) ? '' : ' hidden'}><h3><span>${GROUP[group]} <span class="cnt">${list.length}</span></span><button type="button" class="mk-what" data-action="mk-explain" data-kind="${group}">${t`What is this?`}</button></h3><ul class="mk-list">${list.map(item => row(ctx, item, agent, agents, query)).join('')}</ul></section>`;
  }).join('');
  const bar = `<div class="mk-bar"><div class="mk-for"><span>${t`For`}</span>${pickerHtml(ctx, { id: 'mk-agent', label: t('Agent'), items: agents.map(item => ({ value: item.id, label: item.name })), value: agent?.id || '', searchable: agents.length > 8, compact: true })}</div>
    <input type="search" class="mk-search" data-mk-search placeholder="${t`Search`}" aria-label="${t`Search the market`}" value="${esc(ui.marketQuery || '')}" autocomplete="off"></div>
    <div class="mk-seg" role="tablist" aria-label="${t`Show`}">${KINDS.map(([id, label]) => `<button type="button" role="tab" aria-selected="${kind === id}" class="${kind === id ? 'on' : ''}" data-action="mk-kind" data-kind="${id}">${label}</button>`).join('')}</div>`;
  const none = !items.some(item => shown(item, query, kind));
  return { ...head, meta: data.computer ? t`On ${data.computer}. Each of your computers has its own list.` : head.meta,
    feed: `<div class="page mk">${bar}${addHtml(ctx)}<div class="mk-groups">${groups}</div><p class="muted mk-none"${none ? '' : ' hidden'}>${t`Nothing matches.`}</p></div>` };
}

// Search filters the rows in place, so the box keeps focus while the person types.
export function filterMarket(ctx) {
  const query = String(ctx.ui.marketQuery || '').trim().toLowerCase(), page = document.querySelector('.page.mk'); if (!page) return;
  for (const item of page.querySelectorAll('.mk-row')) item.hidden = Boolean(query) && !item.dataset.mk.includes(query);
  for (const group of page.querySelectorAll('.mk-group')) group.hidden = ![...group.querySelectorAll('.mk-row')].some(item => !item.hidden);
  const none = page.querySelector('.mk-none'); if (none) none.hidden = [...page.querySelectorAll('.mk-row')].some(item => !item.hidden);
}

const ADDS = { 'mk-add-skill-file': 'add-skill-file', 'mk-add-command': 'add-command', 'mk-add-hook': 'add-hook' };

export async function marketAction(ctx, action, target) {
  const { ui, api, toast, renderAll } = ctx;
  if (action === 'mk-kind') { ui.marketKind = target.dataset.kind || ''; renderAll(); queueMicrotask(() => filterMarket(ctx)); return; }
  if (action === 'mk-add-toggle') { ui.marketAddOpen = !target.closest('details')?.open; return; }
  if (action === 'mk-add-tab') { Object.assign(ui, { marketAddTab: target.dataset.tab, marketResult: null, marketDraft: {} }); renderAll(); return; }
  if (action === 'mk-manage') { ctx.openSettings('connectors', target.dataset.pick ? { connectorPick: target.dataset.pick } : target.hasAttribute('data-orbit') ? { connectorPick: 'orbit' } : {}); return; }
  // "What is this?" on a group, or "Ask AI" on a row: the question goes to Rex Agent, who explains it simply.
  if (action === 'mk-explain') {
    const kind = target.dataset.kind, what = target.dataset.name ? `the ${target.dataset.tag} "${target.dataset.name}" in my Market (${KIND_ASK[kind] || 'a tool'})` : KIND_ASK[kind] || 'this';
    try { await ctx.askMain(`What is ${what}? What does it do, and how do I use it in Rex Desk? Explain it like I am five with the eli5 skill, so I learn while I use it.`); }
    catch (error) { toast(error.message, true); }
    return;
  }
  if (action === 'mk-switch') {
    const agent = (ui.market?.agents || []).find(item => item.id === ui.marketAgent) || ui.market?.agents?.[0]; if (!agent) return;
    try { ui.market = await api('/market/switch', { method: 'POST', data: { agent: agent.id, key: target.dataset.key, on: target.checked } }); ctx.ui.tools = {}; }
    catch (error) { target.checked = !target.checked; toast(error.message, true); }
    renderAll(); queueMicrotask(() => filterMarket(ctx)); return;
  }
  if (ADDS[action]) {
    const page = document.querySelector('.page.mk'), value = name => page?.querySelector(`[name="${name}"]`)?.value.trim() || '';
    const text = value('mk-text'), data = { what: ADDS[action], name: value('mk-name'), text, command: text, matcher: value('mk-matcher'), event: ui.marketHookEvent || 'PostToolUse' };
    Object.assign(ui, { marketBusy: true, marketResult: null }); renderAll();
    try { const result = await api('/toolbox', { method: 'POST', data }); ui.marketBox = result; ui.marketResult = [{ ok: true, name: result.added }]; ui.marketDraft = {}; ui.market = await api('/market'); }
    catch (error) { ui.marketResult = [{ ok: false, name: t('Not added'), error: error.message }]; }
    finally { ui.marketBusy = false; renderAll(); queueMicrotask(() => filterMarket(ctx)); }
    return;
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
    if (!await askConfirm(t`Remove ${target.dataset.label || name}?`)) return;
    try { ui.marketBox = await api('/toolbox', { method: 'POST', data: { what: target.dataset.what, name } }); ui.market = await api('/market'); toast(t('Removed.')); }
    catch (error) { toast(error.message, true); }
    renderAll();
  }
}

export function initMarket(ctx) {
  document.addEventListener('input', event => {
    // What the person types in the add box is kept, so a redraw (a save, a new message) does not wipe it.
    if (event.target.closest?.('.mk-add-body') && /^mk-(name|text|matcher)$/.test(event.target.name || '')) { (ctx.ui.marketDraft ||= {})[event.target.name] = event.target.value; return; }
    if (!event.target.matches?.('[data-mk-search]')) return;
    ctx.ui.marketQuery = event.target.value; filterMarket(ctx);
  });
  document.addEventListener('change', event => {
    if (event.target.matches?.('#mk-hook-event')) { ctx.ui.marketHookEvent = event.target.value; return; }
    // An uploaded SKILL.md fills the text box; its file name fills the name when that is still empty.
    if (event.target.matches?.('[data-mk-upload]')) {
      const file = event.target.files?.[0]; if (!file) return;
      void file.text().then(text => {
        const page = document.querySelector('.page.mk'), box = page?.querySelector('[name="mk-text"]'), name = page?.querySelector('[name="mk-name"]');
        if (box) box.value = text; const draft = (ctx.ui.marketDraft ||= {}); draft['mk-text'] = text;
        const guess = file.name.replace(/\.md$/i, '').replace(/^skill$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        if (name && !name.value && guess) { name.value = guess; draft['mk-name'] = guess; }
      });
      return;
    }
    if (!event.target.matches?.('#mk-agent')) return;
    ctx.ui.marketAgent = event.target.value; ctx.renderAll(); queueMicrotask(() => filterMarket(ctx));
  });
}

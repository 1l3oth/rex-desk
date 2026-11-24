import { askConfirm } from './confirm.js';
import { t } from './i18n.js';
// Flow and Morningmate connections, edited inside Settings → Connectors (they used to live on the old /classic page).
// The cards are a working copy kept in state.trackers, so loading projects or adding a person never loses what was typed.
const TYPES = { morningmate: [t('Morningmate')], flow: [t('Flow')] };
const FILTERS = [['active', t('Request and In progress')], ['unfinished', t('All unfinished (includes review and hold)')], ['all', t('All statuses')]];
const accounts = value => [...new Set(String(value || '').split(/[,;\n]/).map(item => item.trim()).filter(Boolean))];
const isTracker = source => source.type === 'flow' || source.type === 'morningmate';

export function trackerDraft(ui, cfg = ui.snap.config) {
  return (cfg?.sources || []).filter(isTracker).map(source => ({ ...source, projectIds: [...(source.projectIds || [])], statusMap: { ...(source.statusMap || {}) }, apiKey: source.apiKey || '' }));
}

// Copy what is typed in the cards into the working copy, so a redraw keeps it.
export function readTrackers(back, state) {
  for (const source of state.trackers || []) {
    const value = key => back.querySelector(`[name="tr.${source.id}.${key}"]`);
    for (const key of ['name', 'type', 'baseUrl', 'apiKey', 'userId', 'repositoryId', 'statusFilter']) if (value(key)) source[key] = value(key).value;
    if (value('clearKey')) source.clearKey = value('clearKey').checked;
    for (const phase of ['working', 'review', 'done']) if (value(`status.${phase}`)) source.statusMap[phase] = value(`status.${phase}`).value;
    const boxes = [...back.querySelectorAll(`[data-tr-project="${source.id}"]`)];
    if (boxes.length) source.projectIds = [...new Set([...source.projectIds.filter(id => !boxes.some(box => box.value === id)), ...boxes.filter(box => box.checked).map(box => box.value)])];
    else if (value('projectIds')) source.projectIds = value('projectIds').value.split(/[,\s]+/).filter(Boolean);
  }
}

// The projects and people of a connection: the ones loaded just now in this Settings window, else the last ones the page has.
const directoryOf = (ui, state, id) => state.directories?.[id] || (ui.snap?.directories || []).find(item => item.sourceId === id);

export function trackersHtml({ ui, esc }, state, cfg = ui.snap.config) {
  const repositories = cfg?.repositories || [];
  const card = source => {
    const id = source.id, directory = directoryOf(ui, state, id), chosen = accounts(source.userId), busy = state.trackerBusy === id;
    const projects = directory?.projects || [], people = directory?.employees || [];
    const projectList = projects.length
      ? `<input type="search" class="st-tr-search" data-tr-search="${id}" placeholder="${t`Search projects`}" aria-label="${t`Search projects`}"><div class="st-tr-projects">${projects.map(project => `<label class="st-tr-project" data-tr-name="${esc(String(project.name).toLowerCase())}"><input type="checkbox" data-tr-project="${id}" value="${esc(project.id)}" ${source.projectIds.includes(String(project.id)) ? 'checked' : ''}><span>${esc(project.name)}<small>${esc(project.id)}</small></span></label>`).join('')}</div>`
      : `<p class="muted">${directory ? t('No projects came back. Check the key and load again.') : t('Load the projects to pick them by name.')}</p><label class="st-field"><span>${t`Project IDs`}</span><input name="tr.${id}.projectIds" value="${esc(source.projectIds.join(', '))}" spellcheck="false" placeholder="12345, 67890"></label>`;
    const person = account => people.find(item => item.id === account || item.email === account);
    return `<details class="st-repo st-tracker" ${state.openTracker === id ? 'open' : ''} data-tr-card="${id}"><summary><b>${esc(source.name || TYPES[source.type]?.[0])}</b><span class="muted">${(source.projectIds.length === 1 ? t`${esc(TYPES[source.type]?.[0] || source.type)} · ${source.projectIds.length} project` : t`${esc(TYPES[source.type]?.[0] || source.type)} · ${source.projectIds.length} projects`) + (source.hasKey ? '' : t` · no key`)}</span></summary>
      <div class="st-row"><label class="st-field"><span>${t`Name`}</span><input name="tr.${id}.name" value="${esc(source.name)}"></label><label class="st-field"><span>${t`Service`}</span><select name="tr.${id}.type">${Object.entries(TYPES).map(([value, [label]]) => `<option value="${value}" ${source.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <label class="st-field"><span>${t`API address`}</span><input name="tr.${id}.baseUrl" value="${esc(source.baseUrl)}" spellcheck="false" type="url"></label>
      <label class="st-field"><span>${t('API key')}${source.hasKey ? t(' (saved; leave empty to keep it)') : ''}</span><input name="tr.${id}.apiKey" type="password" autocomplete="new-password" value="${esc(source.apiKey || '')}" placeholder="${source.hasKey ? t('Saved') : t('Paste your API key')}"><small>${t`A user API key from the service's developer portal. Kept locked on this computer.`}</small></label>
      ${source.hasKey ? `<label class="st-check"><input type="checkbox" name="tr.${id}.clearKey" ${source.clearKey ? 'checked' : ''}><span><b>${t`Delete the saved key`}</b></span></label>` : ''}
      <div class="st-actions"><button type="button" class="btn small primary" data-tr-connect="${id}" ${busy ? 'disabled' : ''}>${busy ? t('Loading projects and people…') : directory ? t('Load projects and people again') : t('Connect and load projects')}</button><button type="button" class="btn small quiet" data-tr-agent="${id}" title="${t`An agent looks them up through your installed Flow or Morningmate MCP`}">${t`Find them with an agent`}</button></div>
      <fieldset class="st-tr-set"><legend>${t`Projects to sync`}</legend>${projectList}</fieldset>
      <fieldset class="st-tr-set"><legend>${t`Whose tasks`}</legend>
        ${chosen.length ? `<div class="st-chips">${chosen.map(account => `<span class="st-chip">${esc(person(account)?.name || account)}<button type="button" class="ag-x" data-tr-unperson="${id}" data-account="${esc(account)}" aria-label="${t`Remove`}">×</button></span>`).join('')}</div>` : `<p class="muted">${t`Nobody chosen: the account of the API key is used.`}</p>`}
        <input type="hidden" name="tr.${id}.userId" value="${esc(chosen.join(', '))}">
        ${people.length ? `<input data-tr-person="${id}" list="tr-people-${id}" placeholder="${t`Add a person: type a name or email`}" aria-label="${t`Add a person`}"><datalist id="tr-people-${id}">${people.map(item => `<option value="${esc(item.id)}">${esc([item.name, item.email, item.department].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>` : `<input data-tr-person="${id}" placeholder="${t`Add an account ID or email`}" aria-label="${t`Add an account`}">`}
        <small>${t`A task syncs when it is given to one of these people.`}</small></fieldset>
      <div class="st-row"><label class="st-field"><span>${t`Statuses to sync`}</span><select name="tr.${id}.statusFilter">${FILTERS.map(([value, label]) => `<option value="${value}" ${(source.statusFilter || 'active') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="st-field"><span>${t`Project for its tasks`}</span><select name="tr.${id}.repositoryId"><option value="">${t`Choose a project…`}</option>${repositories.map(repo => `<option value="${esc(repo.id)}" ${repo.id === source.repositoryId ? 'selected' : ''}>${esc(repo.name)}</option>`).join('')}</select></label></div>
      <details><summary class="muted">${t`Status names in the task app`}</summary><p class="muted">${t`The status to set in the task app when work starts, goes to review and is done. Empty leaves the task app as it is.`}</p><div class="st-row">${['working', 'review', 'done'].map(phase => `<label class="st-field"><span>${phase[0].toUpperCase()}${phase.slice(1)}</span><input name="tr.${id}.status.${phase}" value="${esc(source.statusMap?.[phase] || '')}" spellcheck="false"></label>`).join('')}</div></details>
      <button type="button" class="btn small quiet danger" data-tr-remove="${id}">${t`Remove this connection`}</button></details>`;
  };
  // The cards only; Settings, Connectors adds a new one from its picker (data-tr-add) and puts these under Task trackers.
  return (state.trackers || []).map(card).join('');
}

// The sources list to save: Orbit sources as they are, plus the edited Flow and Morningmate cards.
export function trackerSources(ui, state, cfg = ui.snap.config) {
  return [...(cfg?.sources || []).filter(source => !isTracker(source)), ...(state.trackers || []).map(source => ({ ...source, projectIds: source.projectIds.map(String) }))];
}

// Clicks inside the cards. Returns true when it handled the click.
export async function trackerClick({ ui, api, toast, refresh }, state, target, back, draw) {
  const hit = name => target.closest(`[data-${name}]`);
  if (hit('tr-add')) {
    readTrackers(back, state); const type = hit('tr-add').dataset.trAdd, id = crypto.randomUUID();
    state.trackers.push({ id, name: TYPES[type][0], type, baseUrl: (state.extra.connectors?.connectors || []).find(item => item.id === type)?.baseUrl || '', apiKey: '', projectIds: [], userId: '', repositoryId: '', statusFilter: 'active', statusMap: {} });
    state.openTracker = id; draw(); return true;
  }
  if (hit('tr-remove')) {
    const id = hit('tr-remove').dataset.trRemove, source = state.trackers.find(item => item.id === id);
    if (!await askConfirm(t`Remove ${source?.name || 'this connection'}? Its tasks stop syncing.`)) return true;
    readTrackers(back, state); state.trackers = state.trackers.filter(item => item.id !== id); draw(); return true;
  }
  if (hit('tr-unperson')) {
    readTrackers(back, state); const button = hit('tr-unperson'), source = state.trackers.find(item => item.id === button.dataset.trUnperson);
    source.userId = accounts(source.userId).filter(account => account !== button.dataset.account).join(', '); state.openTracker = source.id; draw(); return true;
  }
  const connect = hit('tr-connect') || hit('tr-agent');
  if (connect) {
    readTrackers(back, state); const id = connect.dataset.trConnect || connect.dataset.trAgent, source = state.trackers.find(item => item.id === id), agent = Boolean(connect.dataset.trAgent);
    state.trackerBusy = id; state.openTracker = id; draw();
    try {
      const result = await api(agent ? '/sources/setup-agent' : '/sources/connect', { method: 'POST', data: agent ? { source, provider: 'claude' } : source });
      Object.assign(source, { hasKey: result.source.hasKey, apiKey: '', clearKey: false });
      // Keep the projects and people the server just loaded on the card: a page refresh already on its way carries the state from
      // before, and the card stayed on 'Load the projects'.
      if (result.directory) (state.directories ||= {})[id] = result.directory;
      await refresh();
      const directory = directoryOf(ui, state, id);
      if (!agent && !source.projectIds.length && directory?.projects?.length === 1) source.projectIds = [String(directory.projects[0].id)];
      toast(agent ? t('An agent is looking them up. Its questions come to you in the chat.') : t('Connected. Pick the projects and people.'));
    } finally { state.trackerBusy = ''; draw(); }
    return true;
  }
  return false;
}

// Typing in the search box filters the projects; picking a person adds them.
export function trackerInput(back, state, event, draw) {
  const search = event.target.dataset?.trSearch;
  if (search) { const query = event.target.value.trim().toLowerCase(); for (const row of back.querySelectorAll(`[data-tr-card="${search}"] .st-tr-project`)) row.hidden = Boolean(query) && !row.dataset.trName.includes(query) && !row.textContent.toLowerCase().includes(query); return true; }
  const personFor = event.target.dataset?.trPerson;
  if (personFor && event.type === 'change' && event.target.value.trim()) {
    readTrackers(back, state); const source = state.trackers.find(item => item.id === personFor);
    source.userId = [...accounts(source.userId), event.target.value.trim()].join(', '); state.openTracker = personFor;
    // A change can fire while the box loses focus; redrawing inside that blur breaks the page, so redraw just after it.
    setTimeout(draw); return true;
  }
  return false;
}

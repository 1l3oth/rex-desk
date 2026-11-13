// Flow and Morningmate connections, edited inside Settings → Task sources (they used to live on the old /classic page).
// The cards are a working copy kept in state.trackers, so loading projects or adding a person never loses what was typed.
const TYPES = { morningmate: ['Morningmate'], flow: ['Flow'] };
const FILTERS = [['active', 'Request and In progress'], ['unfinished', 'All unfinished (includes review and hold)'], ['all', 'All statuses']];
const accounts = value => [...new Set(String(value || '').split(/[,;\n]/).map(item => item.trim()).filter(Boolean))];
const isTracker = source => source.type === 'flow' || source.type === 'morningmate';

export function trackerDraft(ui) {
  return (ui.snap.config?.sources || []).filter(isTracker).map(source => ({ ...source, projectIds: [...(source.projectIds || [])], statusMap: { ...(source.statusMap || {}) }, apiKey: '' }));
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

export function trackersHtml({ ui, esc }, state) {
  const repositories = ui.snap.config?.repositories || [];
  const card = source => {
    const id = source.id, directory = (ui.snap.directories || []).find(item => item.sourceId === id), chosen = accounts(source.userId), busy = state.trackerBusy === id;
    const projects = directory?.projects || [], people = directory?.employees || [];
    const projectList = projects.length
      ? `<input type="search" class="st-tr-search" data-tr-search="${id}" placeholder="Search projects" aria-label="Search projects"><div class="st-tr-projects">${projects.map(project => `<label class="st-tr-project" data-tr-name="${esc(String(project.name).toLowerCase())}"><input type="checkbox" data-tr-project="${id}" value="${esc(project.id)}" ${source.projectIds.includes(String(project.id)) ? 'checked' : ''}><span>${esc(project.name)}<small>${esc(project.id)}</small></span></label>`).join('')}</div>`
      : `<p class="muted">${directory ? 'No projects came back. Check the key and load again.' : 'Load the projects to pick them by name.'}</p><label class="st-field"><span>Project IDs</span><input name="tr.${id}.projectIds" value="${esc(source.projectIds.join(', '))}" spellcheck="false" placeholder="12345, 67890"></label>`;
    const person = account => people.find(item => item.id === account || item.email === account);
    return `<details class="st-repo st-tracker" ${state.openTracker === id ? 'open' : ''} data-tr-card="${id}"><summary><b>${esc(source.name || TYPES[source.type]?.[0])}</b><span class="muted">${esc(TYPES[source.type]?.[0] || source.type)} · ${source.projectIds.length} project${source.projectIds.length === 1 ? '' : 's'}${source.hasKey ? '' : ' · no key'}</span></summary>
      <div class="st-row"><label class="st-field"><span>Name</span><input name="tr.${id}.name" value="${esc(source.name)}"></label><label class="st-field"><span>Service</span><select name="tr.${id}.type">${Object.entries(TYPES).map(([value, [label]]) => `<option value="${value}" ${source.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <label class="st-field"><span>API address</span><input name="tr.${id}.baseUrl" value="${esc(source.baseUrl)}" spellcheck="false" type="url"></label>
      <label class="st-field"><span>API key${source.hasKey ? ' (saved; leave empty to keep it)' : ''}</span><input name="tr.${id}.apiKey" type="password" autocomplete="new-password" value="${esc(source.apiKey || '')}" placeholder="${source.hasKey ? 'Saved' : 'Paste your API key'}"><small>A user API key from the service's developer portal. Kept encrypted on this computer.</small></label>
      ${source.hasKey ? `<label class="st-check"><input type="checkbox" name="tr.${id}.clearKey" ${source.clearKey ? 'checked' : ''}><span><b>Delete the saved key</b></span></label>` : ''}
      <div class="st-actions"><button type="button" class="btn small primary" data-tr-connect="${id}" ${busy ? 'disabled' : ''}>${busy ? 'Loading projects and people…' : directory ? 'Load projects and people again' : 'Connect and load projects'}</button><button type="button" class="btn small quiet" data-tr-agent="${id}" title="An agent looks them up through your installed Flow or Morningmate MCP">Find them with an agent</button></div>
      <fieldset class="st-tr-set"><legend>Projects to sync</legend>${projectList}</fieldset>
      <fieldset class="st-tr-set"><legend>Whose tasks</legend>
        ${chosen.length ? `<div class="st-chips">${chosen.map(account => `<span class="st-chip">${esc(person(account)?.name || account)}<button type="button" class="ag-x" data-tr-unperson="${id}" data-account="${esc(account)}" aria-label="Remove">×</button></span>`).join('')}</div>` : '<p class="muted">Nobody chosen: the account of the API key is used.</p>'}
        <input type="hidden" name="tr.${id}.userId" value="${esc(chosen.join(', '))}">
        ${people.length ? `<input data-tr-person="${id}" list="tr-people-${id}" placeholder="Add a person: type a name or email" aria-label="Add a person"><datalist id="tr-people-${id}">${people.map(item => `<option value="${esc(item.id)}">${esc([item.name, item.email, item.department].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>` : `<input data-tr-person="${id}" placeholder="Add an account ID or email" aria-label="Add an account">`}
        <small>A task syncs when one of these people is its assignee.</small></fieldset>
      <div class="st-row"><label class="st-field"><span>Statuses to sync</span><select name="tr.${id}.statusFilter">${FILTERS.map(([value, label]) => `<option value="${value}" ${(source.statusFilter || 'active') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="st-field"><span>Project for its tasks</span><select name="tr.${id}.repositoryId"><option value="">Choose a project…</option>${repositories.map(repo => `<option value="${esc(repo.id)}" ${repo.id === source.repositoryId ? 'selected' : ''}>${esc(repo.name)}</option>`).join('')}</select></label></div>
      <details><summary class="muted">Tracker status names</summary><p class="muted">The tracker status to set when work starts, goes to review and is done. Empty leaves the tracker as it is.</p><div class="st-row">${['working', 'review', 'done'].map(phase => `<label class="st-field"><span>${phase[0].toUpperCase()}${phase.slice(1)}</span><input name="tr.${id}.status.${phase}" value="${esc(source.statusMap?.[phase] || '')}" spellcheck="false"></label>`).join('')}</div></details>
      <button type="button" class="btn small quiet danger" data-tr-remove="${id}">Remove this connection</button></details>`;
  };
  return `<h3>Flow and Morningmate</h3><p class="muted">Brings in the tasks assigned to the people you choose, from the projects you pick. Press Save when you are done.</p>
    ${(state.trackers || []).map(card).join('') || '<p class="muted">No Flow or Morningmate connection yet.</p>'}
    <div class="st-actions"><button type="button" class="btn small" data-tr-add="morningmate">+ Add a connection</button></div>`;
}

// The sources list to save: Orbit sources as they are, plus the edited Flow and Morningmate cards.
export function trackerSources(ui, state) {
  return [...(ui.snap.config?.sources || []).filter(source => !isTracker(source)), ...(state.trackers || []).map(source => ({ ...source, projectIds: source.projectIds.map(String) }))];
}

// Clicks inside the cards. Returns true when it handled the click.
export async function trackerClick({ ui, api, toast, refresh }, state, target, back, draw) {
  const hit = name => target.closest(`[data-${name}]`);
  if (hit('tr-add')) {
    readTrackers(back, state); const type = hit('tr-add').dataset.trAdd, id = crypto.randomUUID();
    state.trackers.push({ id, name: TYPES[type][0], type, baseUrl: 'https://api.morningmate.com', apiKey: '', projectIds: [], userId: '', repositoryId: '', statusFilter: 'active', statusMap: {} });
    state.openTracker = id; draw(); return true;
  }
  if (hit('tr-remove')) {
    const id = hit('tr-remove').dataset.trRemove, source = state.trackers.find(item => item.id === id);
    if (!confirm(`Remove ${source?.name || 'this connection'}? Its tasks stop syncing. Press Save to make it final.`)) return true;
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
      await refresh();
      const directory = (ui.snap.directories || []).find(item => item.sourceId === id);
      if (!agent && !source.projectIds.length && directory?.projects?.length === 1) source.projectIds = [String(directory.projects[0].id)];
      toast(agent ? 'An agent is looking them up. Its questions come to you in the chat.' : 'Connected. Pick the projects and people, then Save.');
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

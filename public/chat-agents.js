import { pickerHtml } from '/chat-pick.js';
// Specialist agents: one identity per project. The card shows who the agent is and what it was told; the person can rename, edit or duplicate it.
const providerName = name => name === 'codex' ? 'Codex (retired)' : 'Claude Code';

// Agents are grouped under their project; a project with several agents folds away. Folded groups are remembered on this computer.
const FOLDED = 'rex-agent-groups-folded';
const folded = () => { try { return new Set(JSON.parse(localStorage.getItem(FOLDED) || '[]')); } catch { return new Set(); } };
export function toggleGroup(project) { const set = folded(); if (set.has(project)) set.delete(project); else set.add(project); try { localStorage.setItem(FOLDED, JSON.stringify([...set])); } catch {} }
// The sidebar list: one group per project, with that project's agents under it. item(agent, grouped) draws one row.
export function agentGroups(ctx, agents, item) {
  const { ui, esc } = ctx, groups = new Map();
  for (const agent of agents) { const key = agent.projectSlug || 'other'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(agent); }
  const shut = folded(), active = ui.view.type === 'specialist' ? agents.find(agent => agent.id === ui.view.id)?.projectSlug : '';
  if (groups.size === 1 && agents.length === 1) return item(agents[0], false);
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([project, list]) => {
    const open = !shut.has(project) || project === active, busy = list.filter(agent => ['busy', 'replying'].includes(agent.status?.state)).length, waiting = list.filter(agent => agent.status?.state === 'waiting').length;
    return `<div class="agroup${open ? ' open' : ''}"><button class="agroup-head" data-action="agent-group" data-project="${esc(project)}" aria-expanded="${open}"><svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="agroup-name">${esc(project)}</span>${waiting ? `<span class="dot warn" title="${waiting} waiting for you"></span>` : busy ? `<span class="dot working" title="${busy} working"></span>` : ''}<span class="agroup-count">${list.length}</span></button>${open ? `<div class="agroup-list">${list.map(agent => item(agent, true)).join('')}</div>` : ''}</div>`;
  }).join('');
}

export function agentStage(ctx) {
  const { ui, esc } = ctx, agent = (ui.snap.specialists || []).find(item => item.id === ui.view.id);
  if (!agent) return { title: 'Agent', meta: '', feed: '<div class="empty"><h2>That agent is gone.</h2></div>' };
  delete ui.picks['sp-model']; delete ui.picks['sp-provider'];
  const origin = agent.cloneOf ? (ui.snap.specialists || []).find(item => item.id === agent.cloneOf) : null;
  const state = agent.status?.state || 'idle', tone = { busy: 'working', replying: 'working', waiting: 'warn', idle: 'good' }[state] || '';
  const unsure = (agent.unsure || []).filter(Boolean), lessons = agent.lessons || [];
  const ai = agent.provider === 'codex' ? 'codex' : 'claude', aiChoices = ui.snap.choices?.providers?.[ai] || ui.snap.choices || {};
  const models = [{ value: '', label: 'Default', hint: 'The model set in Settings' }, ...(aiChoices.models || []).map(model => ({ value: model.id, label: model.label }))];
  const head = `<header class="ag-head">${ctx.avatar({ name: agent.name, size: 'xl' })}
    <div class="ag-who">
      <form class="ag-name" data-agent-rename><input id="sp-name" type="text" maxlength="40" value="${esc(agent.name)}" aria-label="Agent name" spellcheck="false"><button class="btn small" type="submit" hidden>Rename</button></form>
      <p class="ag-line"><span class="dot ${tone}"></span>${esc(agent.status?.label || 'Idle')} on <a href="#" data-open="project" data-id="${esc(agent.projectSlug)}">${esc(agent.projectSlug)}</a></p>
      <p class="ag-path" title="${esc(agent.projectPath)}"><code>${esc(agent.projectPath)}</code></p>
    </div>
    <div class="ag-actions"><button class="btn primary" data-action="spec-chat">Chat with ${esc(agent.name)}</button><button class="btn" data-action="spec-duplicate">Duplicate</button></div>
  </header>`;
  const questions = unsure.length ? `<section class="ag-ask"><h2>${esc(agent.name)} is not sure about</h2><ul>${unsure.map((text, index) => `<li><span>${esc(text)}</span><span class="ag-ask-do"><button class="btn small" data-action="spec-answer" data-index="${index}">Answer</button><button class="btn small quiet" data-action="spec-settled" data-index="${index}" title="Mark as settled" aria-label="Mark as settled">Settled</button></span></li>`).join('')}</ul></section>` : '';
  const rules = `<section class="ag-sec"><h2>Rules from you</h2><p class="ag-help">${esc(agent.name)} follows these on every task in ${esc(agent.projectSlug)}.</p>
    <textarea id="sp-rules" rows="${Math.min(16, Math.max(6, Math.ceil(String(agent.rules || '').length / 60) + String(agent.rules || '').split(/\n/).length))}" spellcheck="false" placeholder="How ${esc(agent.name)} should work here. For example: ask before changing the database.">${esc(agent.rules)}</textarea>
    <div class="ag-save"><button class="btn primary" data-action="spec-save" disabled>Save rules</button></div></section>`;
  const lessonList = lessons.length ? `<ul class="ag-lessons">${lessons.map((lesson, index) => `<li><span>${esc(lesson.text)}</span><button type="button" class="ag-x" data-action="spec-forget" data-index="${index}" title="Forget this lesson" aria-label="Forget this lesson"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></li>`).join('')}</ul>` : `<p class="ag-help">None yet. When you correct ${esc(agent.name)}, it keeps the lesson here.</p>`;
  const chosen = new Set(agent.taskSources || []), options = [['local', 'Rex Desk tasks', 'Kept here, made by you or the agents'], ...(ui.snap.config?.sources || []).map(source => [source.id, source.name, source.type === 'flow' ? 'Flow tracker' : 'Morningmate tracker'])];
  const taskSources = `<div class="ag-sources">${options.map(([id, label, hint]) => `<label><input type="checkbox" data-task-source="${esc(id)}" ${chosen.has(id) ? 'checked' : ''}><span>${esc(label)}<small>${esc(hint)}</small></span></label>`).join('')}</div>${chosen.size ? '' : `<p class="ag-help">Not set. ${esc(agent.name)} asks you before it looks for tasks.</p>`}`;
  // The agent's own loop: how often it looks at its tasks by itself, and what it does on each look.
  const loop = { on: true, every: 60, prompt: '', ...(agent.loop || {}) }, everyLabel = minutes => minutes >= 1440 ? 'Once a day' : minutes >= 60 ? `Every ${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `Every ${minutes} minutes`;
  const loopBox = `<section class="ag-sec ag-loop"><h2>Own loop</h2>
    <label class="ag-loop-on"><input type="checkbox" data-loop-on ${loop.on ? 'checked' : ''}><span>${esc(agent.name)} checks its own tasks and starts work by itself</span></label>
    <div class="ag-loop-row"><select data-loop-every aria-label="How often">${[15, 30, 60, 120, 240, 1440].map(minutes => `<option value="${minutes}" ${Number(loop.every) === minutes ? 'selected' : ''}>${everyLabel(minutes)}</option>`).join('')}</select><button type="button" class="btn small" data-action="spec-loop-now">Check now</button></div>
    <textarea data-loop-prompt rows="3" maxlength="2000" placeholder="What to do on each check (optional). For example: pick up QA issues first and test them in the browser.">${esc(loop.prompt || '')}</textarea>
    <p class="ag-help">${loop.lastAt ? `Last check ${esc(new Date(loop.lastAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}. ` : ''}A check is skipped, using nothing, when its tasks have not changed. It follows the ${esc(agent.projectSlug)} workflow and asks you before anything risky.</p></section>`;
  const side = `<aside class="ag-side">
    <section class="ag-sec"><h2>What ${esc(agent.projectSlug)} is for</h2><p>${esc(agent.purpose || 'Not recorded yet.')}</p></section>
    <section class="ag-sec"><h2>Lessons learned</h2>${lessonList}</section>
    <section class="ag-sec"><h2>Tasks come from</h2>${taskSources}</section>
    ${loopBox}
    <section class="ag-sec"><h2>AI</h2>${pickerHtml(ctx, { id: 'sp-provider', label: 'AI', value: ai, items: [{ value: 'claude', label: 'Claude Code', hint: 'Claude subscription' }, { value: 'codex', label: 'Codex', hint: 'ChatGPT subscription' }] })}<p class="ag-help">Switching starts a fresh session; the chat so far is handed over.</p></section>
    <section class="ag-sec"><h2>${ai === 'codex' ? 'Codex' : 'Claude'} account</h2>${pickerHtml(ctx, { id: 'sp-profile', label: 'Account', value: agent.profile || '', items: [{ value: '', label: 'Same as everyone', hint: 'The account chosen at the bottom left' }, ...((ui.accounts?.[ai]?.profiles) || []).filter(item => item.loggedIn).map(item => ({ value: item.profile, label: item.account || item.label, hint: [item.label, item.plan].filter(Boolean).join(' · ') }))] })}</section>
    <section class="ag-sec"><h2>Model</h2>${pickerHtml(ctx, { id: 'sp-model', label: 'Model', value: agent.model || '', items: models })}</section>
    <section class="ag-sec ag-meta"><p>Created by ${esc(agent.createdBy || 'you')}${origin ? `, copied from ${esc(origin.name)}` : ''}.</p><button class="btn small danger" data-action="spec-remove">Remove ${esc(agent.name)}</button></section>
  </aside>`;
  const feed = `<div class="page ag" data-agent="${esc(agent.id)}">${head}${questions}<div class="ag-body"><div class="ag-main">${rules}</div>${side}</div></div>`;
  return { title: agent.name, meta: `${providerName(agent.provider)} · ${agent.projectSlug}`, feed, top: true };
}

function dialog(ctx, { title, nameValue = '', projects = null, submit }) {
  const { esc, toast } = ctx, back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog"><h2>${esc(title)}</h2><label>Name<input type="text" name="name" value="${esc(nameValue)}" maxlength="40" required></label>${projects ? `<label>Project${pickerHtml(ctx, { id: 'newagent-project', name: 'project', label: 'Project', searchable: projects.length > 6, value: (projects.find(project => project.selected) || projects[0] || {}).slug || '', items: projects.map(project => ({ value: project.slug, label: project.slug })) })}</label>` : ''}<div class="row"><button class="btn primary">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`;
  document.body.append(back); back.querySelector('input').select();
  back.addEventListener('click', event => { if (event.target === back || event.target.dataset.close !== undefined) back.remove(); });
  back.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await submit(Object.fromEntries(new FormData(event.target))); back.remove(); } catch (error) { toast(error.message, true); }
  });
}

// The loop settings save as soon as they change.
let loopWired = false;
export function wireLoop(ctx) {
  if (loopWired) return; loopWired = true;
  const save = async data => { const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id); if (!agent) return; try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { loop: data } }); await ctx.refresh(); } catch (error) { ctx.toast(error.message, true); } };
  document.addEventListener('change', event => {
    if (event.target.matches?.('[data-loop-on]')) void save({ on: event.target.checked });
    else if (event.target.matches?.('[data-loop-every]')) void save({ every: Number(event.target.value) });
  });
  document.addEventListener('focusout', event => { if (event.target.matches?.('[data-loop-prompt]')) { const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id); if (agent && event.target.value !== (agent.loop?.prompt || '')) void save({ prompt: event.target.value }); } });
}
export async function agentAction(ctx, action, target = null) {
  const { ui, api, toast, refresh, open } = ctx, value = id => document.getElementById(id)?.value ?? '';
  const agent = (ui.snap.specialists || []).find(item => item.id === ui.view.id);
  if (action === 'spec-new') {
    let projects = ui.memory?.projects || [];
    if (!projects.length) { toast('Looking for your projects…'); await api('/memory/scan', { method: 'POST', data: {} }); await refresh(); projects = ui.memory?.projects || []; }
    if (!projects.length) return toast('No projects were found on this computer.', true);
    const current = ui.view.type === 'project' ? ui.view.id : '';
    return dialog(ctx, { title: 'New agent', projects: projects.map(project => ({ slug: project.slug, selected: project.slug === current })), submit: async form => {
      const created = await api('/specialists', { method: 'POST', data: { name: form.name, projectSlug: form.project } }); await refresh(); open('specialist', created.id); } });
  }
  if (!agent) return;
  if (action === 'spec-chat') {
    let runId = agent.runId;
    // An agent on a computer that is off: its chat lives there, so it opens when that computer is back.
    if (agent.remote && agent.status?.state === 'offline') { toast(`${agent.name} is offline: ${agent.device} is off. Its chat opens when it is back; messages in rooms wait for it.`); return; }
    if (!runId) { await api(`/specialists/${agent.id}/say`, { method: 'POST', data: { text: 'Introduce yourself in one or two lines: who you are and which project you look after.' } }); await refresh(); runId = (ui.snap.specialists || []).find(item => item.id === agent.id)?.runId; }
    if (runId) open('run', runId); return;
  }
  if (action === 'spec-answer') {
    const question = (agent.unsure || []).filter(Boolean)[Number(target.dataset.index)] || '';
    let runId = agent.runId; if (!runId) { await agentAction(ctx, 'spec-chat'); return; }
    ui.drafts.set(`run:${runId}`, `About "${question}": `); open('run', runId); setTimeout(() => { const box = document.getElementById('draft'); if (box) { box.value = `About "${question}": `; box.focus(); } }, 50); return;
  }
  if (action === 'spec-loop-now') { await api(`/specialists/${agent.id}/loop`, { method: 'POST', data: {} }); toast(`${agent.name} is checking its tasks.`); await refresh(); return; }
  if (action === 'spec-settled') {
    const unsure = (agent.unsure || []).filter(Boolean).filter((_, index) => index !== Number(target.dataset.index));
    await api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: agent.rules, unsure, model: agent.model || '' } }); await refresh(); return;
  }
  if (action === 'spec-forget') { await api(`/specialists/${agent.id}/lessons/${target.dataset.index}`, { method: 'DELETE' }); await refresh(); return; }
  if (action === 'spec-rename') { await api(`/specialists/${agent.id}/rename`, { method: 'POST', data: { name: value('sp-name') } }); toast('Renamed.'); await refresh({ full: true }); }
  else if (action === 'spec-save') {
    await api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: value('sp-rules'), unsure: agent.unsure || [], model: value('sp-model') } });
    toast('Rules saved.'); await refresh({ full: true });
  } else if (action === 'spec-duplicate') {
    dialog(ctx, { title: `Duplicate ${agent.name}`, nameValue: `${agent.name} 2`, submit: async form => {
      const copy = await api(`/specialists/${agent.id}/duplicate`, { method: 'POST', data: { name: form.name } }); await refresh(); open('specialist', copy.id); toast('Duplicated. It has the same project and rules, and its own conversation.'); } });
  } else if (action === 'spec-remove') {
    if (!confirm(`Remove ${agent.name}? Its card is deleted. Past runs stay.`)) return;
    await api(`/specialists/${agent.id}`, { method: 'DELETE' }); await refresh(); open('main');
  }
}

// The name saves when you press Enter or leave the field; the rules button wakes up only after you change something.
export function initAgentCard(ctx) {
  document.addEventListener('submit', async event => {
    if (!event.target.matches?.('[data-agent-rename]')) return; event.preventDefault(); event.stopPropagation();
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id), name = document.getElementById('sp-name').value.trim();
    if (!agent || !name || name === agent.name) return;
    try { await agentAction(ctx, 'spec-rename'); } catch (error) { ctx.toast(error.message, true); }
  }, true);
  document.addEventListener('focusout', event => { if (event.target.id === 'sp-name') event.target.form?.requestSubmit(); });
  // Ticking where tasks come from saves at once.
  document.addEventListener('change', async event => {
    if (event.target.dataset?.taskSource === undefined) return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id); if (!agent) return;
    const taskSources = [...document.querySelectorAll('[data-task-source]:checked')].map(box => box.dataset.taskSource);
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { taskSources } }); document.activeElement?.blur?.(); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  // The AI picked for this agent is saved at once; its model and account go back to the defaults of that AI.
  document.addEventListener('change', async event => {
    if (event.target.id !== 'sp-provider') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id); if (!agent || agent.provider === event.target.value) return;
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { provider: event.target.value } }); ctx.toast(`${agent.name} now runs on ${event.target.value === 'codex' ? 'Codex' : 'Claude Code'}.`); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  // An account picked for this agent is saved at once.
  document.addEventListener('change', async event => {
    if (event.target.id !== 'sp-profile') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id); if (!agent) return;
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { profile: event.target.value } }); ctx.toast(event.target.value ? 'This agent now uses that Claude account.' : 'This agent uses the same account as everyone.'); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  // A model picked from the list is saved at once.
  document.addEventListener('change', async event => {
    if (event.target.id !== 'sp-model') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id); if (!agent) return;
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: agent.rules, unsure: agent.unsure || [], model: event.target.value } }); ctx.toast('Model saved.'); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  document.addEventListener('input', event => {
    if (event.target.id !== 'sp-rules') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id), save = document.querySelector('[data-action="spec-save"]');
    if (save) save.disabled = event.target.value === (agent?.rules || '');
  });
}

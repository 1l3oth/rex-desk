import { t, locale } from './i18n.js';
import { pickerHtml } from '/chat-pick.js';
// Specialist agents: one identity per project. The card shows who the agent is and what it was told; the person can rename, edit or duplicate it.
const providerName = name => name === 'codex' ? t('Codex') : name === 'gemini' ? t('Gemini (Antigravity)') : t('Claude Code');

// Agents are grouped under their project; a project with several agents folds away. Folded groups are remembered on this computer.
const FOLDED = 'rex-agent-groups-folded';
const folded = () => { try { return new Set(JSON.parse(localStorage.getItem(FOLDED) || '[]')); } catch { return new Set(); } };
export function toggleGroup(project) { const set = folded(); if (set.has(project)) set.delete(project); else set.add(project); try { localStorage.setItem(FOLDED, JSON.stringify([...set])); } catch {} }
// The sidebar list: one group per project, with that project's agents under it. item(agent, grouped) draws one row.
export function agentGroups(ctx, agents, item) {
  const { ui, esc } = ctx, groups = new Map();
  for (const agent of agents) { const key = agent.projectSlug || t('For anything'); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(agent); }
  const shut = folded(), active = ui.view.type === 'specialist' ? agents.find(agent => agent.id === ui.view.id)?.projectSlug : '';
  if (groups.size === 1 && agents.length === 1) return item(agents[0], false);
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([project, list]) => {
    const open = !shut.has(project) || project === active, busy = list.filter(agent => ['busy', 'replying'].includes(agent.status?.state)).length, waiting = list.filter(agent => agent.status?.state === 'waiting').length;
    return `<div class="agroup${open ? ' open' : ''}"><button class="agroup-head" data-action="agent-group" data-project="${esc(project)}" aria-expanded="${open}"><svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="agroup-name">${esc(project)}</span>${waiting ? `<span class="dot warn" title="${t`${waiting} waiting for you`}"></span>` : busy ? `<span class="dot working" title="${t`${busy} working`}"></span>` : ''}<span class="agroup-count">${list.length}</span></button>${open ? `<div class="agroup-list">${list.map(agent => item(agent, true)).join('')}</div>` : ''}</div>`;
  }).join('');
}

export function agentStage(ctx) {
  const { ui, esc } = ctx, agent = (ui.snap.specialists || []).find(item => item.id === ui.view.id);
  if (!agent) return { title: t('Agent'), meta: '', feed: `<div class="empty"><h2>${t`That agent is gone.`}</h2></div>` };
  delete ui.picks['sp-model']; delete ui.picks['sp-provider'];
  const origin = agent.cloneOf ? (ui.snap.specialists || []).find(item => item.id === agent.cloneOf) : null;
  const state = agent.status?.state || 'idle', tone = { busy: 'working', replying: 'working', waiting: 'warn', idle: 'good' }[state] || '';
  const unsure = (agent.unsure || []).filter(Boolean), lessons = agent.lessons || [];
  const ai = ['codex', 'gemini'].includes(agent.provider) ? agent.provider : 'claude', aiChoices = ui.snap.choices?.providers?.[ai] || ui.snap.choices || {};
  const models = [{ value: '', label: t('Default'), hint: t('The model set in Settings') }, ...(aiChoices.models || []).map(model => ({ value: model.id, label: model.label }))];
  const head = `<header class="ag-head">${ctx.avatar({ name: agent.name, size: 'xl' })}
    <div class="ag-who">
      <form class="ag-name" data-agent-rename><input id="sp-name" type="text" maxlength="40" value="${esc(agent.name)}" aria-label="${t`Agent name`}" spellcheck="false"><button class="btn small" type="submit" hidden>${t`Rename`}</button></form>
      <p class="ag-line"><span class="dot ${tone}"></span>${esc(agent.status?.label || t('Idle'))}${agent.projectSlug ? ` on <a href="#" data-open="project" data-id="${esc(agent.projectSlug)}">${esc(agent.projectSlug)}</a>` : t(' · not tied to a project')}${agent.device ? ` ${agent.remote ? t`· works on ${`<b>${esc(agent.device)}</b>`}` : t`· works on ${`<b>${esc(agent.device)}</b>`} (this computer)`}` : ''}</p>
      ${agent.projectPath || agent.projectSlug ? `<p class="ag-path" title="${esc(agent.projectPath)}">${t`Main folder`} <code>${esc(agent.projectPath || t('not set'))}</code></p>` : ''}
    </div>
    <div class="ag-actions"><button class="btn primary" data-action="spec-chat">${t`Chat with ${esc(agent.name)}`}</button><button class="btn" data-action="spec-duplicate">${t`Duplicate`}</button>${agent.kind !== 'main' && !agent.pinned ? `<button class="btn${agent.follows !== false ? ' primary' : ''}" data-action="spec-follow" aria-pressed="${agent.follows !== false}" title="${t`When you write to it from a computer, it moves there and works there`}">${agent.follows !== false ? t`Works where you are: on` : t`Works where you are: off`}</button>` : ''}${agent.remote && !agent.pinned ? `<button class="btn" data-action="spec-move" title="${t`Make this agent work on this computer, with the same chat`}">${t`Move to this computer`}</button>` : ''}</div>${agent.pinned ? `<p class="ag-help">${t`Runs only on ${esc(agent.device || t('its computer'))} (set in Settings, Projects).`}${agent.noCloud ? t` Kept out of the cloud.` : ''}</p>` : agent.noCloud ? `<p class="ag-help">${t`Kept out of the cloud (set in Settings, Projects).`}</p>` : ''}
  </header>`;
  const questions = unsure.length ? `<section class="ag-ask"><h2>${t`${esc(agent.name)} is not sure about`}</h2><ul>${unsure.map((text, index) => `<li><span>${esc(text)}</span><span class="ag-ask-do"><button class="btn small" data-action="spec-answer" data-index="${index}">${t`Answer`}</button><button class="btn small quiet" data-action="spec-settled" data-index="${index}" title="${t`Mark as settled`}" aria-label="${t`Mark as settled`}">${t`Settled`}</button></span></li>`).join('')}</ul></section>` : '';
  const rules = `<section class="ag-sec"><h2>${t`Rules from you`}</h2><p class="ag-help">${agent.projectSlug ? t`${esc(agent.name)} follows these on every task in ${esc(agent.projectSlug)}.` : t`${esc(agent.name)} follows these in everything it does.`}</p>
    <textarea id="sp-rules" rows="${Math.min(16, Math.max(6, Math.ceil(String(agent.rules || '').length / 60) + String(agent.rules || '').split(/\n/).length))}" spellcheck="false" placeholder="${t`How ${esc(agent.name)} should work here. For example: ask before changing the database.`}">${esc(agent.rules)}</textarea>
    <div class="ag-save"><button class="btn primary" data-action="spec-save" disabled>${t`Save rules`}</button></div></section>`;
  const lessonList = lessons.length ? `<ul class="ag-lessons">${lessons.map((lesson, index) => `<li><span>${esc(lesson.text)}</span><button type="button" class="ag-x" data-action="spec-forget" data-index="${index}" title="${t`Forget this lesson`}" aria-label="${t`Forget this lesson`}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></li>`).join('')}</ul>` : `<p class="ag-help">${t`None yet. When you correct ${esc(agent.name)}, it keeps the lesson here.`}</p>`;
  const chosen = new Set(agent.taskSources || []), options = [['local', t('Rex Desk tasks'), t('Kept here, made by you or the agents')], ...(ui.snap.config?.sources || []).map(source => [source.id, source.name, source.type === 'flow' ? t('Flow tasks') : t('Morningmate tasks')])];
  const taskSources = `<div class="ag-sources">${options.map(([id, label, hint]) => `<label><input type="checkbox" data-task-source="${esc(id)}" ${chosen.has(id) ? 'checked' : ''}><span>${esc(label)}<small>${esc(hint)}</small></span></label>`).join('')}</div>${chosen.size ? '' : `<p class="ag-help">${t`Not set. ${esc(agent.name)} asks you before it looks for tasks.`}</p>`}`;
  // The agent's own loop: how often it looks at its tasks by itself, and what it does on each look.
  const loop = { on: true, every: 60, prompt: '', ...(agent.loop || {}) }, everyLabel = minutes => minutes >= 1440 ? t('Once a day') : minutes >= 60 ? (minutes === 60 ? t`Every ${minutes / 60} hour` : t`Every ${minutes / 60} hours`) : t`Every ${minutes} minutes`;
  const STEP = { 15: '15m', 30: '30m', 60: '1h', 120: '2h', 240: '4h', 1440: '1 day' }, next = loop.on && loop.lastAt ? new Date(new Date(loop.lastAt).getTime() + Number(loop.every) * 60000) : null;
  const nextIn = next ? Math.max(0, Math.round((next.getTime() - Date.now()) / 60000)) : null;
  const loopBox = `<section class="ag-sec ag-loop${loop.on ? ' on' : ''}"><div class="lp-head"><div><h2>${t`Own loop`}</h2><p>${t`${esc(agent.name)} checks its own tasks and starts work by itself.`}</p></div>
      <label class="switch" title="${loop.on ? t('Turn the loop off') : t('Turn the loop on')}"><input type="checkbox" role="switch" data-loop-on ${loop.on ? 'checked' : ''} aria-label="${t`Own loop`}"><span></span></label></div>
    <div class="lp-body">
      <div class="lp-every" role="radiogroup" aria-label="${t`How often`}">${[15, 30, 60, 120, 240, 1440].map(minutes => `<label title="${everyLabel(minutes)}"><input type="radio" name="loop-every-${esc(agent.id)}" value="${minutes}" data-loop-every ${Number(loop.every) === minutes ? 'checked' : ''}><span>${STEP[minutes]}</span></label>`).join('')}</div>
      <textarea data-loop-prompt rows="3" maxlength="2000" placeholder="${t`What to do on each check (optional). For example: pick up QA issues first and test them in the browser.`}">${esc(loop.prompt || '')}</textarea>
      <div class="lp-foot"><span class="lp-status">${loop.on ? `<i class="lp-dot"></i>${nextIn === null ? t('First check soon') : nextIn <= 0 ? t('Checking soon') : t`Next check in ${nextIn >= 60 ? `${Math.round(nextIn / 60)} h` : t`${nextIn} min`}`}` : t('Off')}${loop.lastAt ? `<small>${t`Last ${esc(new Date(loop.lastAt).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}`}</small>` : ''}</span>
        <button type="button" class="btn small lp-now" data-action="spec-loop-now"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>${t`Check now`}</button></div>
      <p class="ag-help">${agent.projectSlug ? t`A check costs nothing when its tasks have not changed. It follows the ${esc(agent.projectSlug)} workflow and asks you before anything risky.` : t`A check costs nothing when its tasks have not changed. It asks you before anything risky.`}</p>
    </div></section>`;
  const side = `<aside class="ag-side">
    <section class="ag-sec"><h2>${t`What ${esc(agent.projectSlug || agent.name)} is for`}</h2><p>${esc(agent.purpose || t('Not recorded yet.'))}</p></section>
    <section class="ag-sec"><h2>${t`Lessons learned`}</h2>${lessonList}</section>
    <section class="ag-sec"><h2>${t`Tasks come from`}</h2>${taskSources}</section>
    ${loopBox}
    <section class="ag-sec"><h2>AI</h2>${pickerHtml(ctx, { id: 'sp-provider', label: 'AI', value: ai, items: [{ value: 'claude', label: t('Claude Code'), hint: t('Your Claude plan') }, { value: 'codex', label: t('Codex'), hint: t('Your ChatGPT plan') }, { value: 'gemini', label: t('Gemini'), hint: t('Google account, through Antigravity') }] })}<p class="ag-help">${t`Switching starts fresh; the new AI gets a summary of the chat so far.`}</p></section>
    <section class="ag-sec"><h2>${t`${ai === 'codex' ? t('Codex') : ai === 'gemini' ? t('Google (Antigravity)') : t('Claude')} account`}</h2>${pickerHtml(ctx, { id: 'sp-profile', label: t('Account'), value: agent.profile || '', items: [{ value: '', label: t('Same as everyone'), hint: t('The account chosen at the bottom left') }, ...((ui.accounts?.[ai]?.profiles) || []).filter(item => item.loggedIn).map(item => ({ value: item.profile, label: item.account || item.label, hint: [item.label, item.plan].filter(Boolean).join(' · ') }))] })}</section>
    <section class="ag-sec"><h2>${t`Model`}</h2>${pickerHtml(ctx, { id: 'sp-model', label: t('Model'), value: agent.model || '', items: models })}</section>
    <section class="ag-sec ag-meta"><p>${t`Created by ${esc(agent.createdBy || t('you'))}${origin ? t`, copied from ${esc(origin.name)}` : ''}.`}</p><button class="btn small danger" data-action="spec-remove">${t`Remove ${esc(agent.name)}`}</button></section>
  </aside>`;
  const feed = `<div class="page ag" data-agent="${esc(agent.id)}">${head}${questions}<div class="ag-body"><div class="ag-main">${rules}</div>${side}</div></div>`;
  return { title: agent.name, meta: [providerName(agent.provider), agent.projectSlug].filter(Boolean).join(' · '), feed, top: true };
}

function dialog(ctx, { title, nameValue = '', projects = null, submit }) {
  const { esc, toast } = ctx, back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog"><h2>${esc(title)}</h2><label>${t`Name`}<input type="text" name="name" value="${esc(nameValue)}" maxlength="40" required></label>${projects ? `<label>${t('Project')}${pickerHtml(ctx, { id: 'newagent-project', name: 'project', label: t('Project'), searchable: projects.length > 6, value: (projects.find(project => project.selected) || projects[0] || {}).slug || '', items: projects.map(project => ({ value: project.slug, label: project.label || project.slug, ...(project.hint ? { hint: project.hint } : {}) })) })}</label><label>${t`What is it for?`}<textarea name="purpose" rows="3" maxlength="400" placeholder="${t`Like: helps me write posts for my shop. Needed when there is no project.`}"></textarea></label>` : ''}<div class="row"><button class="btn primary">${t`Create`}</button><button class="btn" type="button" data-close>${t`Cancel`}</button></div></form>`;
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
// An agent whose saved chat was deleted still names it; a new chat starts then, once even when the screen draws again meanwhile.
const starting = new Set(), introduced = new Set();
export const savedChatGone = (ctx, agent) => Boolean(agent?.runId) && !ctx.runById(agent.runId);
export async function openAgentChat(ctx, agent) {
  const { ui, api, toast, refresh, open } = ctx;
  // An agent on a computer that is off: its chat lives there, so it opens when that computer is back.
  if (agent.remote && agent.status?.state === 'offline' && !(agent.runId && ctx.runById(agent.runId))) { toast(t`${agent.name} is offline: ${agent.device} is off. Its chat opens when it is back; messages in rooms wait for it.`); return; }
  let runId = agent.runId && ctx.runById(agent.runId) ? agent.runId : '';
  // An agent on another computer: its chat arrives from there. Starting one from here on every redraw sent it the same
  // greeting dozens of times, so its card opens instead, and what the person writes there starts the chat.
  if (!runId && agent.remote) { open('specialist', agent.id); if (!introduced.has(agent.id)) { introduced.add(agent.id); toast(t`${agent.name}'s chat is on ${agent.device || t('its computer')}. It shows here once that computer shares it; or write to ${agent.name} from its card.`); } return; }
  if (!runId) {
    if (starting.has(agent.id) || introduced.has(agent.id)) { open('specialist', agent.id); return; } starting.add(agent.id); introduced.add(agent.id);
    // When it cannot start, the card opens, so a screen left on the deleted chat does not try again on every redraw.
    try { await api(`/specialists/${agent.id}/say`, { method: 'POST', data: { text: 'Introduce yourself in one or two lines: who you are and which project you look after.' } }); await refresh(); }
    catch (error) { toast(t`${agent.name} could not start a chat: ${error.message}`, true); open('specialist', agent.id); return; }
    finally { starting.delete(agent.id); }
    runId = (ui.snap.specialists || []).find(item => item.id === agent.id)?.runId;
  }
  if (runId) open('run', runId);
}
// A run an agent did moves into an agent's personal chat: its own agent, or another one on the same project (one that replaces it).
export const chatTakers = (ctx, run) => {
  const agents = (ctx.ui.snap.specialists || []).filter(agent => !agent.remote), owner = agents.find(agent => agent.id === run?.specialistId);
  if (!run || run.roomAgent || run.roomOf || agents.some(agent => agent.runId === run.id)) return [];
  return agents.filter(agent => owner ? agent.projectSlug === owner.projectSlug : Boolean(run.repositoryId) && agent.repositoryId === run.repositoryId).sort((left, right) => (right.id === owner?.id) - (left.id === owner?.id));
};
export function moveRunDialog(ctx, run) {
  const { esc, api, toast, refresh, open } = ctx, takers = chatTakers(ctx, run); if (!takers.length) return toast(t('No agent on this project can take this run.'), true);
  const back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog"><h2>${t`Move to a personal chat`}</h2><p class="muted small">${t`The agent you pick gets this run as its chat: click it in the sidebar to see this work and keep talking. Its current chat stays under Earlier chats.`}</p><label>${t`Agent`}<select name="agent">${takers.map(agent => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join('')}</select></label><div class="row"><button class="btn primary">${t`Move`}</button><button class="btn" type="button" data-close>${t`Cancel`}</button></div></form>`;
  document.body.append(back);
  back.addEventListener('click', event => { if (event.target === back || event.target.dataset.close !== undefined) back.remove(); });
  back.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const agentId = new FormData(event.target).get('agent');
    try { const agent = await api(`/specialists/${agentId}/take-run`, { method: 'POST', data: { runId: run.id } }); back.remove(); await refresh({ full: true }); toast(t`This run is now ${agent.name}'s chat.`); open('run', run.id); } catch (error) { toast(error.message, true); }
  });
}
export async function agentAction(ctx, action, target = null) {
  const { ui, api, toast, refresh, open } = ctx, value = id => document.getElementById(id)?.value ?? '';
  // The agent is the one being viewed, or the one a button names (so the same actions work from a chat's Profile panel).
  const agent = (ui.snap.specialists || []).find(item => item.id === (target?.dataset?.agentId || ui.view.id));
  if (action === 'spec-new') {
    let projects = ui.memory?.projects || [];
    if (!projects.length) { toast(t('Looking for your projects…')); await api('/memory/scan', { method: 'POST', data: {} }).catch(() => {}); await refresh(); projects = ui.memory?.projects || []; }
    const current = ui.view.type === 'project' ? ui.view.id : '';
    // An agent does not need a code project: the first choice makes one for anything else (writing, research, study, planning).
    const choices = [{ slug: '', label: t('No project'), hint: t('An agent for anything: writing, research, study, planning'), selected: !current }, ...projects.map(project => ({ slug: project.slug, selected: project.slug === current }))];
    return dialog(ctx, { title: t('New agent'), projects: choices, submit: async form => {
      if (!form.project && !String(form.purpose || '').trim()) throw new Error(t('Say what this agent is for.'));
      const created = await api('/specialists', { method: 'POST', data: { name: form.name, projectSlug: form.project, purpose: form.purpose } }); await refresh(); open('specialist', created.id); } });
  }
  if (!agent) return;
  if (action === 'spec-chat') return openAgentChat(ctx, agent);
  if (action === 'chat-pick') { await api(`/specialists/${agent.id}/chat-pick`, { method: 'POST', data: { node: target.dataset.node } }); toast(t('Kept. Every computer now shows this chat.')); await refresh({ full: true }); return; }
  if (action === 'spec-answer') {
    const question = (agent.unsure || []).filter(Boolean)[Number(target.dataset.index)] || '';
    const runId = agent.runId && ctx.runById(agent.runId) ? agent.runId : ''; if (!runId) { await agentAction(ctx, 'spec-chat'); return; }
    ui.drafts.set(`run:${runId}`, `About "${question}": `); open('run', runId); setTimeout(() => { const box = document.getElementById('draft'); if (box) { box.value = t`About "${question}": `; box.focus(); } }, 50); return;
  }
  if (action === 'spec-loop-now') { await api(`/specialists/${agent.id}/loop`, { method: 'POST', data: {} }); toast(t`${agent.name} is checking its tasks.`); await refresh(); return; }
  if (action === 'spec-settled') {
    const unsure = (agent.unsure || []).filter(Boolean).filter((_, index) => index !== Number(target.dataset.index));
    await api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: agent.rules, unsure, model: agent.model || '' } }); await refresh(); return;
  }
  if (action === 'spec-forget') { await api(`/specialists/${agent.id}/lessons/${target.dataset.index}`, { method: 'DELETE' }); await refresh(); return; }
  if (action === 'spec-rename') { await api(`/specialists/${agent.id}/rename`, { method: 'POST', data: { name: value('sp-name') } }); toast(t('Renamed.')); await refresh({ full: true }); }
  else if (action === 'spec-save') {
    await api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: value('sp-rules'), unsure: agent.unsure || [], model: value('sp-model') } });
    toast(t('Rules saved.')); await refresh({ full: true });
  } else if (action === 'spec-follow') {
    await api(`/specialists/${agent.id}/follow`, { method: 'POST', data: { on: agent.follows === false } });
    toast(agent.follows !== false ? t('It stays on its own computer now.') : t('It now works on whichever computer you write to it from.')); await refresh({ full: true });
  } else if (action === 'spec-move') {
    if (!confirm(t`Move ${agent.name} to this computer?

Its chat comes along and it starts fresh from a summary of the chat. Code that was not pushed on ${agent.device || t('the other computer')} stays there, so push it first.`)) return;
    const moved = await api(`/specialists/${agent.id}/move`, { method: 'POST', data: {} }); await refresh({ full: true });
    toast(t`${agent.name} now works on this computer, in ${moved.folder}.`);
  } else if (action === 'spec-duplicate') {
    dialog(ctx, { title: t`Duplicate ${agent.name}`, nameValue: `${agent.name} 2`, submit: async form => {
      const copy = await api(`/specialists/${agent.id}/duplicate`, { method: 'POST', data: { name: form.name } }); await refresh(); open('specialist', copy.id); toast(t('Duplicated. It has the same project and rules, and its own conversation.')); } });
  } else if (action === 'spec-remove') {
    if (!confirm(t`Remove ${agent.name}? Its card is deleted. Past runs stay.`)) return;
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
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { provider: event.target.value } }); ctx.toast(t`${agent.name} now runs on ${event.target.value === 'codex' ? t('Codex') : event.target.value === 'gemini' ? t('Gemini') : t('Claude Code')}.`); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  // An account picked for this agent is saved at once.
  document.addEventListener('change', async event => {
    if (event.target.id !== 'sp-profile') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id); if (!agent) return;
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { profile: event.target.value } }); ctx.toast(event.target.value ? t('This agent now uses that Claude account.') : t('This agent uses the same account as everyone.')); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  // A model picked from the list is saved at once.
  document.addEventListener('change', async event => {
    if (event.target.id !== 'sp-model') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id); if (!agent) return;
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: agent.rules, unsure: agent.unsure || [], model: event.target.value } }); ctx.toast(t('Model saved.')); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  document.addEventListener('input', event => {
    if (event.target.id !== 'sp-rules') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === ctx.ui.view.id), save = document.querySelector('[data-action="spec-save"]');
    if (save) save.disabled = event.target.value === (agent?.rules || '');
  });
}

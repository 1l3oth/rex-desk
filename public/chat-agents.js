import { t, locale } from './i18n.js';
import { notesSection, notesAction, exportNotes } from './chat-notes.js';
import { pickerHtml } from '/chat-pick.js';
import { whereHtml } from '/chat-where.js';
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

export function agentStage(ctx, id = (ctx.ui.profileId || ctx.ui.view.id)) {
  const { ui, esc } = ctx, agent = (ui.snap.specialists || []).find(item => item.id === id);
  if (!agent) return { title: t('Agent'), meta: '', feed: `<div class="empty"><h2>${t`That agent is gone.`}</h2></div>` };
  delete ui.picks['sp-model']; delete ui.picks['sp-provider'];
  const origin = agent.cloneOf ? (ui.snap.specialists || []).find(item => item.id === agent.cloneOf) : null;
  const state = agent.status?.state || 'idle', tone = { busy: 'working', replying: 'working', waiting: 'warn', idle: 'good' }[state] || '';
  const unsure = (agent.unsure || []).filter(Boolean), lessons = agent.lessons || [];
  const ai = ['codex', 'gemini'].includes(agent.provider) ? agent.provider : 'claude', aiChoices = ui.snap.choices?.providers?.[ai] || ui.snap.choices || {};
  const models = [{ value: '', label: t('Default'), hint: t('The model set in Settings') }, ...(aiChoices.models || []).map(model => ({ value: model.id, label: model.label }))];
  // The page reads like a system Settings app: grouped lists of rows on hairlines, the label on the left, the control on the
  // right; a heading above each group and a note under it. One tab at a time.
  const row = (label, control, sub = '', extra = '') => `<div class="agp-r${extra}"><div class="agp-rl"><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div><div class="agp-rc">${control}</div></div>`;
  const block = (body, extra = '') => `<div class="agp-r agp-block${extra}">${body}</div>`;
  const group = (title, rows, note = '', extra = '') => `<section class="agp-grp${extra}">${title ? `<h2 class="agp-gh">${title}</h2>` : ''}<div class="agp-list">${rows}</div>${note ? `<p class="agp-note">${note}</p>` : ''}</section>`;
  const toggle = (attrs, on, label) => `<label class="switch agp-switch"><input type="checkbox" role="switch" ${attrs} ${on ? 'checked' : ''} aria-label="${label}"><span></span></label>`;
  const chosen = new Set(agent.taskSources || []), options = [['local', t('Rex Desk tasks'), t('Kept here, made by you or the agents')], ...(ui.snap.config?.sources || []).map(source => [source.id, source.name, source.type === 'flow' ? t('Flow tasks') : t('Morningmate tasks')])];
  const taskSources = group(t('Tasks come from'), options.map(([id, label, hint]) => row(esc(label), toggle(`data-task-source="${esc(id)}"`, chosen.has(id), esc(label)), esc(hint))).join(''),
    chosen.size ? '' : t`Not set. ${esc(agent.name)} asks you before it looks for tasks.`);
  // The agent's own loop: how often it looks at its tasks by itself, and what it does on each look.
  const loop = { on: true, every: 60, prompt: '', ...(agent.loop || {}) }, everyLabel = minutes => minutes >= 1440 ? t('Once a day') : minutes >= 60 ? (minutes === 60 ? t`Every ${minutes / 60} hour` : t`Every ${minutes / 60} hours`) : t`Every ${minutes} minutes`;
  const STEP = { 15: '15m', 30: '30m', 60: '1h', 120: '2h', 240: '4h', 1440: '1 day' }, next = loop.on && loop.lastAt ? new Date(new Date(loop.lastAt).getTime() + Number(loop.every) * 60000) : null;
  const nextIn = next ? Math.max(0, Math.round((next.getTime() - Date.now()) / 60000)) : null;
  // Work hours, like a shift: the loop checks only then, and is told to stop when the shift ends.
  const hours = { on: false, start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5], ...(loop.hours || {}) }, offDuty = hours.on && !onShift(hours);
  const dayName = day => new Date(2024, 0, 7 + day).toLocaleDateString(locale(), { weekday: 'short' });
  const status = loop.on && offDuty ? t`Off duty until ${esc(hours.start)}` : loop.on ? (nextIn === null ? t('First check soon') : nextIn <= 0 ? t('Checking soon') : t`Next check in ${nextIn >= 60 ? `${Math.round(nextIn / 60)} h` : t`${nextIn} min`}`) : t('Off');
  const last = loop.lastAt ? t`Last ${esc(new Date(loop.lastAt).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : '';
  const loopBox = group(t('Own loop'), row(t('Check tasks by itself'), toggle('data-loop-on', loop.on, t('Own loop')), t`${esc(agent.name)} looks at its tasks and starts work on its own.`)
      + `<div class="agp-fold${loop.on ? '' : ' off'}">`
      + row(t('How often'), `<div class="agp-seg" role="radiogroup" aria-label="${t`How often`}">${[15, 30, 60, 120, 240, 1440].map(minutes => `<label title="${everyLabel(minutes)}"><input type="radio" name="loop-every-${esc(agent.id)}" value="${minutes}" data-loop-every ${Number(loop.every) === minutes ? 'checked' : ''}><span>${STEP[minutes]}</span></label>`).join('')}</div>`)
      + row(t('Work hours'), toggle('data-loop-hours-on', hours.on, t('Work hours')), t('Checks only during these hours, and stops when they end.'))
      + (hours.on ? row(t('Hours'), `<div class="agp-time"><input type="time" data-loop-hours="start" value="${esc(hours.start)}" aria-label="${t`Starts at`}"><span>${t`to`}</span><input type="time" data-loop-hours="end" value="${esc(hours.end)}" aria-label="${t`Ends at`}"></div>`)
        + row(t('Days'), `<div class="agp-seg agp-days" role="group" aria-label="${t`Work days`}">${[1, 2, 3, 4, 5, 6, 0].map(day => `<label><input type="checkbox" data-loop-day="${day}" ${hours.days.includes(day) ? 'checked' : ''}><span>${esc(dayName(day))}</span></label>`).join('')}</div>`) : '')
      + block(`<label class="agp-blabel" for="lp-prompt-${esc(agent.id)}">${t`On each check`}</label><textarea id="lp-prompt-${esc(agent.id)}" class="agp-text" data-loop-prompt rows="2" maxlength="2000" placeholder="${t`Optional. For example: pick up QA issues first and test them in the browser.`}">${esc(loop.prompt || '')}</textarea>`)
      + row(`${loop.on ? `<i class="agp-dot${offDuty ? ' rest' : ' on'}"></i>` : ''}${status}`, `<button type="button" class="btn small" data-action="spec-loop-now">${t`Check now`}</button>`, last, ' agp-status')
      + '</div>');
  // The page is a decision surface: who the agent is and what it is doing at the top, then one tab at a time.
  const tabId = ['about', 'notes', 'work', 'setup'].includes(ui.agentTab) ? ui.agentTab : 'about';
  const where = [agent.projectSlug ? `<a href="#" data-open="project" data-id="${esc(agent.projectSlug)}">${esc(agent.projectSlug)}</a>` : esc(t('No project')), agent.device ? `${esc(agent.device)}${agent.remote ? '' : ` <span class="agp-faint">${t`(this computer)`}</span>`}` : ''].filter(Boolean).join('<span class="agp-sep" aria-hidden="true">·</span>');
  const avatar = agent.remote ? ctx.avatar({ name: agent.name, agent, size: 'xl' }) : `<button type="button" class="av-edit agp-av" data-action="avatar-pick" data-agent-id="${esc(agent.id)}" title="${t`Change ${esc(agent.name)}'s avatar`}" aria-label="${t`Change ${esc(agent.name)}'s avatar`}">${ctx.avatar({ name: agent.name, agent, size: 'xl' })}</button>`;
  // A social-profile header: a cover (the person's picture, or one drawn from the agent's own colour), a big avatar over its
  // edge, name, one line on where it works, what it is for, three numbers, and the two main buttons.
  const hue = [...String(agent.id)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  const cover = `<div class="agp-cover agp-h${hue % 12}${agent.cover ? ' has' : ''}">${agent.cover ? `<img src="${esc(agent.cover)}" alt="">` : '<svg viewBox="0 0 900 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="760" cy="30" r="170"/><circle cx="560" cy="215" r="140"/><circle cx="130" cy="15" r="110" class="dk"/><path class="dk" d="M0 150C220 90 380 190 640 120S860 110 900 130V190H0Z"/></svg>'}`
    + (agent.remote ? '' : `<span class="agp-cover-acts">${agent.cover ? `<button type="button" class="agp-cbtn" data-action="cover-reset">${t`Remove cover`}</button>` : ''}<label class="agp-cbtn">${t`Change cover`}<input type="file" accept="image/*" data-cover-upload hidden></label></span>`) + '</div>';
  const stats = [[unsure.length, unsure.length === 1 ? t('question for you') : t('questions for you')], [lessons.length, lessons.length === 1 ? t('lesson learned') : t('lessons learned')], [loop.on ? STEP[loop.every] || `${loop.every}m` : t('Off'), t('own loop')]];
  const head = `${cover}<header class="agp-head">${avatar}
    <div class="agp-who">
      <form class="ag-name agp-name" data-agent-rename><input id="sp-name" type="text" maxlength="40" value="${esc(agent.name)}" aria-label="${t`Agent name`}" spellcheck="false"><button class="btn small" type="submit" hidden>${t`Rename`}</button></form>
      <p class="agp-line"><span class="agp-state"><span class="dot ${tone}"></span>${esc(agent.status?.label || t('Idle'))}</span><span class="agp-sep" aria-hidden="true">·</span>${where}</p>
    </div>
    <div class="agp-actions"><button class="btn small" data-action="spec-duplicate">${t`Duplicate`}</button><button class="btn small primary" data-action="spec-chat">${t`Message`}</button></div>
    ${agent.purpose ? `<p class="agp-bio">${esc(agent.purpose)}</p>` : ''}
    <p class="agp-stats">${stats.map(([value, label]) => `<span><b>${esc(String(value))}</b> ${esc(label)}</span>`).join('')}</p>
  </header>`;
  const questions = unsure.length ? group(t`${esc(agent.name)} is not sure about`, unsure.map((text, index) => row(`<i class="agp-dot warn" aria-hidden="true"></i>${esc(text)}`, `<button class="btn small quiet" data-action="spec-settled" data-index="${index}" title="${t`Mark as settled`}">${t`Settled`}</button><button class="btn small" data-action="spec-answer" data-index="${index}">${t`Answer`}</button>`)).join(''), '', ' agp-ask') : '';
  const tabs = `<nav class="agp-tabs" role="tablist" aria-label="${t`Profile sections`}">${[['about', t('Profile')], ['notes', t('Soul and memory')], ['work', t('Work')], ['setup', t('Setup')]].map(([id, label]) => `<button type="button" role="tab" aria-selected="${tabId === id}" class="${tabId === id ? 'on' : ''}" data-action="spec-tab" data-tab="${id}">${label}${id === 'work' && loop.on ? '<span class="agp-live" title="' + t('Own loop is on') + '"></span>' : ''}</button>`).join('')}</nav>`;
  const lessonRows = lessons.length ? lessons.map((lesson, index) => row(`<span class="agp-wrap">${esc(lesson.text)}</span>`, `<button type="button" class="ag-x agp-x" data-action="spec-forget" data-index="${index}" title="${t`Forget this lesson`}" aria-label="${t`Forget this lesson`}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`, '', ' agp-lesson')).join('')
    : block(`<p class="agp-empty">${t`None yet. When you correct ${esc(agent.name)}, it keeps the lesson here.`}</p>`);
  const about = group(t('Rules'), block(`<textarea id="sp-rules" class="agp-text agp-rules" rows="${Math.min(16, Math.max(4, Math.ceil(String(agent.rules || '').length / 70) + String(agent.rules || '').split(/\n/).length))}" spellcheck="false" placeholder="${t`How ${esc(agent.name)} should work here. For example: ask before changing the database.`}" aria-label="${t`Rules from you`}">${esc(agent.rules)}</textarea>`)
      + `<div class="agp-r agp-actrow ag-save"><button class="btn primary small" data-action="spec-save" disabled>${t`Save rules`}</button></div>`)
    + group(`${t`Lessons learned`}${lessons.length ? ` <span class="agp-count">${lessons.length}</span>` : ''}`, lessonRows);
  // Where it works (L57): stays on one computer or follows you, the map of the person's computers, and the move steps.
  const followRows = agent.kind !== 'main' ? whereHtml(ctx, agent, { row }) : '';
  const setup = group(t('AI'), row('AI', pickerHtml(ctx, { id: 'sp-provider', label: 'AI', value: ai, items: [{ value: 'claude', label: t('Claude Code'), hint: t('Your Claude plan') }, { value: 'codex', label: t('Codex'), hint: t('Your ChatGPT plan') }, { value: 'gemini', label: t('Gemini'), hint: t('Google account, through Antigravity') }] }))
      + row(t('Account'), pickerHtml(ctx, { id: 'sp-profile', label: t('Account'), value: agent.profile || '', items: [{ value: '', label: t('Same as everyone'), hint: t('The account chosen at the bottom left') }, ...((ui.accounts?.[ai]?.profiles) || []).filter(item => item.loggedIn).map(item => ({ value: item.profile, label: item.account || item.label, hint: [item.label, item.plan].filter(Boolean).join(' · ') }))] }))
      + row(t('Model'), pickerHtml(ctx, { id: 'sp-model', label: t('Model'), value: agent.model || '', items: models })), t('Switching starts fresh with a summary of the chat.'))
    + (followRows || agent.remote || agent.noCloud ? group(t('Where it works'), `${followRows}${agent.remote && !agent.pinned ? row(t('Move'), `<button class="btn small" data-action="spec-move">${t`Move to this computer`}</button>`) : ''}${agent.noCloud ? row(t('Cloud'), `<span class="agp-value">${t`Kept out of the cloud`}</span>`) : ''}`, agent.pinned ? t('Set in Settings, Projects.') : '') : '')
    + group('', row(t`Remove ${esc(agent.name)}`, `<button class="btn small danger" data-action="spec-remove">${t`Remove`}</button>`, t`Created by ${esc(agent.createdBy || t('you'))}${origin ? t`, copied from ${esc(origin.name)}` : ''}.`));
  const work = taskSources + loopBox + scheduleBox(ctx, agent, { row, block, group, toggle });
  const body = tabId === 'notes' ? notesSection(ctx, agent) : tabId === 'work' ? work : tabId === 'setup' ? setup : about;
  // The side card: where and how it works, at a glance (the controls are in the Setup and Work tabs).
  const fact = (label, value) => `<div class="agp-fact"><span>${label}</span><b>${value}</b></div>`;
  const aside = `<aside class="agp-aside"><section class="agp-grp"><h2 class="agp-gh">${t`Where and how it works`}</h2><div class="agp-list agp-facts">${fact(t('Where it works'), agent.pinned || agent.follows === false ? t('Stays here') : t('Follows you'))}${fact(t('Computer'), esc(agent.device || t('This computer')))}${fact('AI', esc(`${providerName(agent.provider)}${agent.model ? ` · ${agent.model}` : ''}`))}${agent.projectPath ? fact(t('Main folder'), `<code class="agp-code" title="${esc(agent.projectPath)}">${esc(agent.projectPath)}</code>`) : ''}${fact(t('Check tasks by itself'), loop.on ? esc(everyLabel(loop.every)) : t('Off'))}${fact(t('Tasks come from'), esc(options.filter(([id]) => chosen.has(id)).map(([, label]) => label).join(', ') || t('Not set')))}</div></section></aside>`;
  const feed = `<div class="page ag agp" data-agent="${esc(agent.id)}">${head}${questions}${tabs}<div class="agp-cols"><div class="agp-body" role="tabpanel">${body}</div>${aside}</div></div>`;
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

// Is it work time now for these hours (the same rule as the server's inHours).
const minutesOf = value => { const [hour, minute] = String(value).split(':').map(Number); return hour * 60 + minute; };
function onShift(hours, date = new Date()) {
  const start = minutesOf(hours.start), end = minutesOf(hours.end), at = date.getHours() * 60 + date.getMinutes(), days = hours.days || [];
  if (start === end) return days.includes(date.getDay());
  if (start < end) return days.includes(date.getDay()) && at >= start && at < end;
  return at >= start ? days.includes(date.getDay()) : at < end && days.includes((date.getDay() + 6) % 7);
}
// Scheduled messages for this agent: sent into its personal chat at the set time, as if the person typed them.
const repeatLabel = item => ({ once: t('Once'), daily: t('Every day'), weekdays: t('Weekdays'), weekly: t`Every ${new Date(2024, 0, 7 + Number(item.day || 0)).toLocaleDateString(locale(), { weekday: 'long' })}` })[item.repeat] || '';
function scheduleBox(ctx, agent, { row, block, group, toggle }) {
  const { esc, ui } = ctx, items = (ui.snap.schedules || []).filter(item => item.agentId === agent.id);
  const when = item => item.on && item.nextAt ? t`Next ${new Date(item.nextAt).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : item.lastAt ? t('Sent') : t('Paused');
  const rows = items.map(item => row(`<span class="agp-wrap">${esc(item.text)}</span>`,
    `${item.repeat === 'once' && !item.on ? '' : toggle(`data-sched-on="${esc(item.id)}"`, item.on, t('On'))}<button type="button" class="icon-btn agp-x" data-action="spec-sched-del" data-id="${esc(item.id)}" title="${t`Delete`}" aria-label="${t`Delete`}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`,
    `${esc(item.time)} · ${esc(repeatLabel(item))} · ${esc(when(item))}${item.error ? ` · ${esc(item.error)}` : ''}`, item.on ? ' agp-sched' : ' agp-sched off')).join('');
  const form = block(`<form class="agp-form" data-sched-form><textarea class="agp-text" name="text" rows="2" maxlength="4000" required aria-label="${t`Message`}" placeholder="${t`For example: check new Orbit tasks and start the most urgent one.`}"></textarea>
      <div class="agp-formrow"><input type="time" name="time" value="09:00" required aria-label="${t`Time`}"><select name="repeat" aria-label="${t`How often`}"><option value="once">${t`Once`}</option><option value="daily">${t`Every day`}</option><option value="weekdays" selected>${t`Weekdays`}</option><option value="weekly">${t`Every week`}</option></select><span class="agp-grow"></span><button class="btn small primary">${t`Add`}</button></div></form>`);
  return group(t('Scheduled messages'), rows + form, t`Rex Desk sends these to ${esc(agent.name)} at the time you set, as if you typed them.`);
}
// The loop settings save as soon as they change.
let loopWired = false;
export function wireLoop(ctx) {
  if (loopWired) return; loopWired = true;
  const save = async data => { const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)); if (!agent) return; try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { loop: data } }); await ctx.refresh(); } catch (error) { ctx.toast(error.message, true); } };
  document.addEventListener('change', event => {
    if (event.target.matches?.('[data-loop-on]')) void save({ on: event.target.checked });
    else if (event.target.matches?.('[data-loop-every]')) void save({ every: Number(event.target.value) });
    else if (event.target.matches?.('[data-loop-hours-on], [data-loop-hours], [data-loop-day]')) {
      const box = event.target.closest('.lp-hours'), value = name => box.querySelector(`[data-loop-hours="${name}"]`).value;
      void save({ hours: { on: box.querySelector('[data-loop-hours-on]').checked, start: value('start'), end: value('end'), days: [...box.querySelectorAll('[data-loop-day]:checked')].map(input => Number(input.dataset.loopDay)) } });
    } else if (event.target.matches?.('[data-agent-follow]')) void agentAction(ctx, 'spec-follow', { dataset: { agentId: event.target.dataset.agentFollow || '' } }).catch(error => ctx.toast(error.message, true));
    else if (event.target.matches?.('[data-sched-on]')) void ctx.api(`/schedules/${event.target.dataset.schedOn}`, { method: 'PUT', data: { on: event.target.checked } }).then(() => ctx.refresh(), error => ctx.toast(error.message, true));
  });
  document.addEventListener('submit', async event => {
    const form = event.target.closest?.('[data-sched-form]'); if (!form) return;
    event.preventDefault(); const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)); if (!agent) return;
    const data = Object.fromEntries(new FormData(form));
    try { await ctx.api(`/specialists/${agent.id}/schedules`, { method: 'POST', data }); form.reset(); ctx.toast(t('Scheduled.')); await ctx.refresh(); } catch (error) { ctx.toast(error.message, true); }
  });
  document.addEventListener('focusout', event => { if (event.target.matches?.('[data-loop-prompt]')) { const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)); if (agent && event.target.value !== (agent.loop?.prompt || '')) void save({ prompt: event.target.value }); } });
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
  const agent = (ui.snap.specialists || []).find(item => item.id === (target?.dataset?.agentId || ui.profileId || ui.view.id));
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
  if (action === 'spec-tab') { ui.agentTab = target?.dataset?.tab || 'about'; ctx.render(); return; }
  if (action === 'chat-pick') { await api(`/specialists/${agent.id}/chat-pick`, { method: 'POST', data: { node: target.dataset.node } }); toast(t('Kept. Every computer now shows this chat.')); await refresh({ full: true }); return; }
  if (action === 'spec-answer') {
    const question = (agent.unsure || []).filter(Boolean)[Number(target.dataset.index)] || '';
    const runId = agent.runId && ctx.runById(agent.runId) ? agent.runId : ''; if (!runId) { await agentAction(ctx, 'spec-chat'); return; }
    ui.drafts.set(`run:${runId}`, `About "${question}": `); open('run', runId); setTimeout(() => { const box = document.getElementById('draft'); if (box) { box.value = t`About "${question}": `; box.focus(); } }, 50); return;
  }
  if (action === 'spec-sched-del') { await api(`/schedules/${target?.dataset?.id || ''}`, { method: 'DELETE' }); toast(t('Deleted.')); await refresh(); return; }
  if (action === 'spec-loop-now') { await api(`/specialists/${agent.id}/loop`, { method: 'POST', data: {} }); toast(t`${agent.name} is checking its tasks.`); await refresh(); return; }
  if (action === 'spec-settled') {
    const unsure = (agent.unsure || []).filter(Boolean).filter((_, index) => index !== Number(target.dataset.index));
    await api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: agent.rules, unsure, model: agent.model || '' } }); await refresh(); return;
  }
  if (action === 'spec-forget') { await api(`/specialists/${agent.id}/lessons/${target.dataset.index}`, { method: 'DELETE' }); await refresh(); return; }
  if (action === 'spec-rename') { await api(`/specialists/${agent.id}/rename`, { method: 'POST', data: { name: value('sp-name') } }); toast(t('Renamed.')); await refresh({ full: true }); }
  else if (action === 'spec-save') {
    await api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: value('sp-rules'), unsure: agent.unsure || [], model: document.getElementById('sp-model') ? value('sp-model') : agent.model || '' } });
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
  } else if (action.startsWith('spec-notes-')) { await notesAction(ctx, action, target, agent);
  } else if (action === 'spec-remove') {
    if (!confirm(t`Remove ${agent.name}? Its card, soul and memory are deleted here and in the cloud. Past runs stay.`)) return;
    // Its soul and memory go with it: offer to keep a copy first.
    if (confirm(t`Export ${agent.name}'s soul and memory first (SOUL.md and MEMORY.md)?`)) { ui.notes ||= {}; ui.notes[agent.id] ||= await api(`/specialists/${agent.id}/notes`).catch(() => null); exportNotes(ctx, agent); await new Promise(resolve => setTimeout(resolve, 700)); }
    await api(`/specialists/${agent.id}`, { method: 'DELETE' }); await refresh(); open('main');
  }
}

// The name saves when you press Enter or leave the field; the rules button wakes up only after you change something.
export function initAgentCard(ctx) {
  document.addEventListener('submit', async event => {
    if (!event.target.matches?.('[data-agent-rename]')) return; event.preventDefault(); event.stopPropagation();
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)), name = document.getElementById('sp-name').value.trim();
    if (!agent || !name || name === agent.name) return;
    try { await agentAction(ctx, 'spec-rename'); } catch (error) { ctx.toast(error.message, true); }
  }, true);
  document.addEventListener('focusout', event => { if (event.target.id === 'sp-name') event.target.form?.requestSubmit(); });
  // Ticking where tasks come from saves at once.
  document.addEventListener('change', async event => {
    if (event.target.dataset?.taskSource === undefined) return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)); if (!agent) return;
    const taskSources = [...document.querySelectorAll('[data-task-source]:checked')].map(box => box.dataset.taskSource);
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { taskSources } }); document.activeElement?.blur?.(); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  // The AI picked for this agent is saved at once; its model and account go back to the defaults of that AI.
  document.addEventListener('change', async event => {
    if (event.target.id !== 'sp-provider') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)); if (!agent || agent.provider === event.target.value) return;
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { provider: event.target.value } }); ctx.toast(t`${agent.name} now runs on ${event.target.value === 'codex' ? t('Codex') : event.target.value === 'gemini' ? t('Gemini') : t('Claude Code')}.`); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  // An account picked for this agent is saved at once.
  document.addEventListener('change', async event => {
    if (event.target.id !== 'sp-profile') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)); if (!agent) return;
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { profile: event.target.value } }); ctx.toast(event.target.value ? t('This agent now uses that Claude account.') : t('This agent uses the same account as everyone.')); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  // A model picked from the list is saved at once.
  document.addEventListener('change', async event => {
    if (event.target.id !== 'sp-model') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)); if (!agent) return;
    try { await ctx.api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: agent.rules, unsure: agent.unsure || [], model: event.target.value } }); ctx.toast(t('Model saved.')); await ctx.refresh({ full: true }); } catch (error) { ctx.toast(error.message, true); }
  });
  document.addEventListener('input', event => {
    if (event.target.id !== 'sp-rules') return;
    const agent = (ctx.ui.snap.specialists || []).find(item => item.id === (ctx.ui.profileId || ctx.ui.view.id)), save = document.querySelector('[data-action="spec-save"]');
    if (save) save.disabled = event.target.value === (agent?.rules || '');
  });
}

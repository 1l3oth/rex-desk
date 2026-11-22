// Needs you: one quiet grouped list, like a settings page. Each row: who asks, the question in one or two lines, when,
// and the answer right on the row. Longer questions open for the full text. Answered ones leave the list.
import { t } from './i18n.js';
import { avatarHtml } from '/chat-rooms.js';

const GROUPS = () => [['time', t('Newest')], ['agent', t('Agent')], ['project', t('Project')]];
const saved = () => { try { return localStorage.getItem('rex-ny-group') || 'time'; } catch { return 'time'; } };
const plain = text => String(text || '').replace(/mcp__[a-z0-9_]+?__/gi, '');
const ago = value => { const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 60000)); return minutes < 1 ? t('now') : minutes < 60 ? t`${minutes}m` : minutes < 1440 ? t`${Math.round(minutes / 60)}h` : t`${Math.round(minutes / 1440)}d`; };

// Who is asking: the agent behind the chat, its project, and a name for the row.
function asker(ctx, helpers, runId) {
  const run = ctx.runById(runId), agent = run ? helpers.personalAgent(run) : null;
  const room = run?.roomAgent ? (ctx.ui.snap.specialists || []).find(item => item.id === run.roomAgent) : null, who = agent || room;
  return { name: who?.name || (run ? helpers.runTitle(run) : t('Agent')), project: who?.projectSlug || run?.projectSlug || '', agent: who };
}

// A row answers right here when it is one approval or one question; anything bigger opens the full card below the row.
function simple(item) {
  if (['file', 'terminal'].includes(item.kind)) return false;
  const request = item.request || {}, properties = Object.entries(request.requestedSchema?.properties || {});
  if (request.questions?.length) return false;
  if (item.kind === 'approval') return !properties.length;
  return properties.length === 1 && ['string', undefined].includes(properties[0][1].type) && !properties[0][1].multiSelect;
}

function askRow(ctx, helpers, item) {
  const { esc, ui } = ctx, who = asker(ctx, helpers, item.runId), text = plain(item.title);
  const key = `ny:${item.id}`, open = ui.openSteps?.get(key) ? ' open' : '';
  const head = `<div class="ny-top"><b>${esc(who.name)}</b>${who.project ? `<span class="ny-proj">${esc(who.project)}</span>` : ''}<time datetime="${esc(item.createdAt || '')}">${esc(ago(item.createdAt))}</time></div>`;
  const avatar = avatarHtml(ctx, { name: who.name, agent: who.agent || null, size: 'sm' });
  if (!simple(item)) {
    return `<div class="ny-row" data-ny="${esc(item.id)}">${avatar}<div class="ny-body">${head}<div class="ny-q">${esc(text)}</div>
      <details class="ny-more" data-steps="${esc(key)}"${open}><summary>${item.kind === 'file' ? t('Fill in') : t('Answer')}</summary>${helpers.decisionCard(item)}</details></div></div>`;
  }
  const request = item.request || {}, [field] = Object.entries(request.requestedSchema?.properties || {});
  const detail = item.kind === 'approval' ? request.command || request.input || '' : '';
  // The question shows in two lines; a tap opens it in full (and the command an approval would run).
  const question = `<details class="ny-qd" data-steps="${esc(key)}"${open}><summary class="ny-q">${esc(text)}</summary>${detail ? `<pre>${esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 1500))}</pre>` : ''}</details>`;
  let actions;
  if (item.kind === 'approval') {
    actions = `<button class="btn small primary" name="decision" value="accept">${t`Approve`}</button>${request.allowAlways ? `<button class="btn small" name="decision" value="always" formnovalidate>${t`Always allow`}</button>` : ''}<button class="btn small" name="decision" value="decline" formnovalidate>${t`Deny`}</button>`;
  } else {
    const [name, property] = field, options = (property.options || (property.enum || []).map(label => ({ label }))).slice(0, 4);
    const draft = ui.qanswers?.get(item.id)?.[name] || '';
    actions = `${options.map(option => `<button class="btn small" name="decision" value="accept" data-quick="${esc(option.label)}" formnovalidate title="${esc(option.description || option.label)}">${esc(option.label)}</button>`).join('')}
      <span class="ny-reply"><input class="qinput" name="${esc(name)}" data-type="string" placeholder="${options.length ? t('Or type an answer') : t('Type an answer')}" autocomplete="off" value="${esc(draft)}" aria-label="${t`Your answer`}"><button class="btn small primary" name="decision" value="accept">${t`Send`}</button><button class="btn small ny-skip" name="decision" value="decline" formnovalidate>${t`Skip`}</button></span>`;
  }
  return `<form class="ny-row" data-interaction="${esc(item.id)}" data-ny="${esc(item.id)}" novalidate>${avatar}<div class="ny-body">${head}${question}<div class="ny-act">${actions}</div></div></form>`;
}

function wakeRow(ctx, helpers, wake) {
  const { esc } = ctx, who = asker(ctx, helpers, wake.runId), room = (ctx.ui.snap.rooms || []).find(item => item.id === wake.roomId);
  return `<div class="ny-row" data-ny="${esc(wake.id)}">${avatarHtml(ctx, { name: wake.from || who.name, size: 'sm' })}<div class="ny-body"><div class="ny-top"><b>${esc(wake.from || '')}</b><span class="ny-proj">${t`mentioned ${esc(who.name)} in ${esc(room?.name || 'a room')}`}</span>${wake.at || wake.createdAt ? `<time>${esc(ago(wake.at || wake.createdAt))}</time>` : ''}</div>
    <div class="ny-q">${esc(wake.text)}</div><div class="ny-act"><button class="btn small primary" data-action="wake-approve" data-id="${esc(wake.id)}">${t`Wake it up`}</button><button class="btn small" data-action="wake-dismiss" data-id="${esc(wake.id)}">${t`Dismiss`}</button></div></div></div>`;
}

export function inboxStage(ctx, helpers) {
  const asks = ctx.pending(), wakes = ctx.ui.snap.wakes || [], count = asks.length + wakes.length;
  if (!count) return { title: t('Needs you'), meta: '', feed: `<div class="empty"><h2>${t`All clear`}</h2><p>${t`Questions, approvals and wake-ups from your agents show up here.`}</p></div>` };
  const group = saved(), rows = [
    ...asks.map(item => ({ at: item.createdAt || '', html: askRow(ctx, helpers, item), who: asker(ctx, helpers, item.runId) })),
    ...wakes.map(wake => ({ at: wake.at || wake.createdAt || '', html: wakeRow(ctx, helpers, wake), who: asker(ctx, helpers, wake.runId) }))
  ].sort((left, right) => String(right.at).localeCompare(String(left.at)));
  const sections = new Map();
  for (const row of rows) {
    const label = group === 'agent' ? row.who.name : group === 'project' ? row.who.project || t('No project') : '';
    if (!sections.has(label)) sections.set(label, []); sections.get(label).push(row.html);
  }
  const { esc } = ctx;
  const seg = `<div class="kg-switch ny-seg" role="radiogroup" aria-label="${t`Group by`}">${GROUPS().map(([value, label]) => `<button type="button" role="radio" aria-checked="${group === value}" class="${group === value ? 'on' : ''}" data-ny-group="${value}">${esc(label)}</button>`).join('')}</div>`;
  const list = [...sections].map(([label, html]) => `<section class="ny-sec">${label ? `<h3>${esc(label)} <span>${html.length}</span></h3>` : ''}<div class="ny-list">${html.join('')}</div></section>`).join('');
  return { title: t('Needs you'), meta: t`${count} waiting`, top: true, actions: seg, feed: `<div class="ny">${list}</div>` };
}

// The grouping is kept on this computer; a quick answer fills the row's box before the form sends it.
export function wireInbox(ctx) {
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-ny-group]'); if (!button) return;
    try { localStorage.setItem('rex-ny-group', button.dataset.nyGroup); } catch {}
    ctx.renderAll();
  });
  document.addEventListener('submit', event => {
    const quick = event.submitter?.dataset?.quick, input = quick !== undefined && event.target.querySelector?.('.qinput');
    if (input) input.value = quick;
  }, true);
}

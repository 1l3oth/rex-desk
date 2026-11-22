// Needs you: a native split view, like Mail. The list of waiting questions sits on the left, the open one on the right
// with its answer box. On a phone the list fills the screen and a tap opens the question, with a way back.
import { t } from './i18n.js';
import { avatarHtml } from '/chat-rooms.js';
import { phoneAskHtml, ICON as DEVICE_ICON } from '/chat-devices.js';

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

// One approval or one question answers with the simple box; anything bigger shows the full card.
function simple(item) {
  if (['file', 'terminal'].includes(item.kind)) return false;
  const request = item.request || {}, properties = Object.entries(request.requestedSchema?.properties || {});
  if (request.questions?.length) return false;
  if (item.kind === 'approval') return !properties.length;
  return properties.length === 1 && ['string', undefined].includes(properties[0][1].type) && !properties[0][1].multiSelect;
}

// The row in the list on the left.
function listRow(ctx, entry, selected) {
  const { esc } = ctx, { who, item } = entry;
  return `<button type="button" class="ny-item${selected ? ' on' : ''}" data-ny-pick="${esc(item.id)}" aria-current="${selected}">${entry.phone ? `<span class="av sm ny-device" aria-hidden="true">${DEVICE_ICON.phone}</span>` : avatarHtml(ctx, { name: who.name, agent: who.agent || null, size: 'sm' })}<span class="ny-item-body"><span class="ny-item-top"><b>${esc(who.name)}</b><time datetime="${esc(entry.at)}">${esc(ago(entry.at))}</time></span>${entry.sub ? `<span class="ny-item-sub">${esc(entry.sub)}</span>` : ''}<span class="ny-item-q">${esc(entry.text)}</span></span></button>`;
}

// The open question on the right: who asks, the full question, then the answer.
function detail(ctx, helpers, entry) {
  const { esc, ui } = ctx, { who, item } = entry;
  const head = `<header class="ny-dhead"><button type="button" class="ny-back" data-ny-back aria-label="${t`Back to the list`}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>${entry.phone ? `<span class="av ny-device" aria-hidden="true">${DEVICE_ICON.phone}</span>` : avatarHtml(ctx, { name: who.name, agent: who.agent || null })}<div class="ny-dwho"><b>${esc(who.name)}</b><span>${esc([entry.sub, ago(entry.at)].filter(Boolean).join(' · '))}</span></div></header>`;
  const question = `<div class="ny-dq">${esc(entry.text)}</div>`;
  if (entry.phone) return `<div class="ny-detail">${head}<div class="ny-dcard">${phoneAskHtml(ctx, entry.phone)}</div></div>`;
  if (entry.wake) {
    return `<div class="ny-detail">${head}${question}<div class="ny-dact"><button class="btn" data-action="wake-dismiss" data-id="${esc(item.id)}">${t`Dismiss`}</button><button class="btn primary" data-action="wake-approve" data-id="${esc(item.id)}">${t`Wake it up`}</button></div></div>`;
  }
  if (item.kind === 'review') return review(ctx, item, head, question);
  if (!simple(item)) return `<div class="ny-detail">${head}${question}<div class="ny-dcard">${helpers.decisionCard(item)}</div></div>`;
  const request = item.request || {};
  if (item.kind === 'approval') {
    const command = request.command || request.input || '';
    return `<form class="ny-detail" data-interaction="${esc(item.id)}" novalidate>${head}${question}${command ? `<pre class="ny-cmd">${esc(typeof command === 'string' ? command : JSON.stringify(command, null, 2).slice(0, 4000))}</pre>` : ''}<div class="ny-dact"><button class="btn" name="decision" value="decline" formnovalidate>${t`Deny`}</button>${request.allowAlways ? `<button class="btn" name="decision" value="always" formnovalidate>${t`Always allow`}</button>` : ''}<button class="btn primary" name="decision" value="accept">${t`Approve`}</button></div></form>`;
  }
  const [[name, property]] = Object.entries(request.requestedSchema.properties), options = (property.options || (property.enum || []).map(label => ({ label }))).slice(0, 6);
  const draft = ui.qanswers?.get(item.id)?.[name] || '';
  const quick = options.length ? `<div class="ny-opts">${options.map(option => `<button type="button" class="btn" data-ny-quick="${esc(option.label)}" title="${esc(option.description || option.label)}">${esc(option.label)}</button>`).join('')}</div>` : '';
  return `<form class="ny-detail" data-interaction="${esc(item.id)}" novalidate>${head}${question}${quick}<textarea class="qinput ny-answer" name="${esc(name)}" data-type="string" rows="3" placeholder="${options.length ? t('Or type an answer') : t('Type an answer')}" aria-label="${t`Your answer`}">${esc(draft)}</textarea><div class="ny-dact"><button class="btn" name="decision" value="decline" formnovalidate>${t`Skip`}</button><button class="btn primary" name="decision" value="accept">${t`Send`}</button></div></form>`;
}

// Pictures or pages an agent needs an OK on: they show here in full, with OK, or what to change.
function review(ctx, item, head, question) {
  const { esc } = ctx, shots = (item.request?.pictures || []).map(picture => {
    const title = esc(picture.title || ''), url = esc(picture.url || '');
    const look = String(picture.type).startsWith('image/') ? `<img class="md-media" src="${url}" alt="${title}" loading="lazy">`
      : String(picture.type).startsWith('video/') ? `<video src="${url}" controls preload="metadata"></video>`
      : `<button type="button" class="btn" ${picture.page ? `data-page-open="${url}"` : `data-open-url="${url}"`}>${t`Open`} ${title}</button>`;
    return `<figure>${look}<figcaption>${title}${picture.note ? `<small>${esc(picture.note)}</small>` : ''}</figcaption></figure>`;
  }).join('');
  return `<form class="ny-detail" data-interaction="${esc(item.id)}" novalidate>${head}${question}<div class="ny-shots">${shots}</div><textarea class="ny-answer" name="change" data-type="string" rows="3" placeholder="${t`What to change, if anything`}" aria-label="${t`What to change`}"></textarea><div class="ny-dact"><button class="btn" name="decision" value="accept" data-ny-change>${t`Ask for changes`}</button><button class="btn primary" name="decision" value="accept" data-ny-ok>${t`OK`}</button></div></form>`;
}

export function inboxStage(ctx, helpers) {
  const { esc, ui } = ctx, asks = ctx.pending(), wakes = ui.snap.wakes || [], phones = ui.snap.phones?.pending || [], count = asks.length + wakes.length + phones.length;
  if (!count) return { title: t('Needs you'), meta: '', feed: `<div class="empty"><h2>${t`All clear`}</h2><p>${t`Questions, approvals and wake-ups from your agents show up here.`}</p></div>` };
  const group = saved(), entries = [
    ...asks.map(item => { const who = asker(ctx, helpers, item.runId); return { item, who, at: item.createdAt || '', text: plain(item.title), sub: who.project }; }),
    ...wakes.map(wake => {
      const who = asker(ctx, helpers, wake.runId), room = (ui.snap.rooms || []).find(item => item.id === wake.roomId);
      return { item: wake, wake: true, who: { ...who, name: wake.from || who.name, agent: null }, at: wake.at || wake.createdAt || '', text: wake.text || '', sub: t`mentioned ${who.name} in ${room?.name || 'a room'}` };
    }),
    // A new phone asking to open the desk through the relay.
    ...phones.map(phone => ({ item: { id: `phone:${phone.id}` }, phone, who: { name: t('Rex Desk'), project: '', agent: null }, at: phone.createdAt || '', text: t`${phone.name} wants to open your desk`, sub: t('Phone') }))
  ].sort((left, right) => String(right.at).localeCompare(String(left.at)));
  // The open question stays open until it is answered; then the newest one opens.
  let current = entries.find(entry => entry.item.id === ui.nySelected);
  if (!current) { current = entries[0]; ui.nyOpen = false; }
  ui.nySelected = current.item.id;
  const sections = new Map();
  for (const entry of entries) {
    const label = group === 'agent' ? entry.who.name : group === 'project' ? entry.who.project || t('No project') : '';
    if (!sections.has(label)) sections.set(label, []); sections.get(label).push(listRow(ctx, entry, entry === current));
  }
  const seg = `<div class="kg-switch ny-seg" role="radiogroup" aria-label="${t`Group by`}">${GROUPS().map(([value, label]) => `<button type="button" role="radio" aria-checked="${group === value}" class="${group === value ? 'on' : ''}" data-ny-group="${value}">${esc(label)}</button>`).join('')}</div>`;
  const list = [...sections].map(([label, rows]) => `${label ? `<h3 class="ny-sec">${esc(label)}<span>${rows.length}</span></h3>` : ''}${rows.join('')}`).join('');
  return { title: t('Needs you'), meta: t`${count} waiting`, top: true, actions: seg, feedClass: 'ny-feed',
    feed: `<div class="ny${ui.nyOpen ? ' open' : ''}"><nav class="ny-list" aria-label="${t`Waiting questions`}">${list}</nav><section class="ny-pane">${detail(ctx, helpers, current)}</section></div>` };
}

// Picking a row opens it on the right (on a phone, over the list). The grouping is kept on this computer. A suggested
// answer fills the box and sends at once.
export function wireInbox(ctx) {
  document.addEventListener('click', event => {
    const group = event.target.closest?.('[data-ny-group]');
    if (group) { try { localStorage.setItem('rex-ny-group', group.dataset.nyGroup); } catch {} ctx.renderAll(); return; }
    const pick = event.target.closest?.('[data-ny-pick]');
    if (pick) { ctx.ui.nySelected = pick.dataset.nyPick; ctx.ui.nyOpen = true; ctx.renderAll(); return; }
    if (event.target.closest?.('[data-ny-back]')) { ctx.ui.nyOpen = false; ctx.renderAll(); return; }
    const quick = event.target.closest?.('[data-ny-quick]');
    const link = event.target.closest?.('[data-open-url]'); if (link) { window.open(link.dataset.openUrl, '_blank', 'noopener'); return; }
    if (quick) { const form = quick.closest('form'), input = form?.querySelector('.qinput'); if (!input) return; input.value = quick.dataset.nyQuick; form.requestSubmit(form.querySelector('button[value=accept]')); }
  });
  // A review: OK sends no change; asking for changes needs the change written first.
  document.addEventListener('submit', event => {
    const button = event.submitter, box = event.target.querySelector?.('.ny-answer[name=change]'); if (!box || !button) return;
    if (button.dataset.nyOk !== undefined) box.value = '';
    else if (button.dataset.nyChange !== undefined && !box.value.trim()) { event.preventDefault(); event.stopImmediatePropagation(); box.focus(); box.placeholder = t('Write what to change'); }
  }, true);
}

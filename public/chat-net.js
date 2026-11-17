import { t } from './i18n.js';
// Agents online. Left: the person's agents and every conversation with an outside agent, the ones waiting for the person
// first. Right: the one thing picked, either a conversation (read it, decide, step in, take over, stop) or an agent
// (who can reach it, when it asks, pairing, linked agents, its rules).
const icon = (paths, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const NET_ICON = icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9S14.6 18.4 12 21c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>');
const LOCK = icon('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 15);
const USERS = icon('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.8c1.5.6 2.6 1.9 3 4.2"/>', 15);
const WORLD = icon('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z"/>', 15);
const FOLDER = icon('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>', 15);
const DOTS = icon('<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>', 16);
const COPY = icon('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>', 14);

const STATE = () => ({ active: t('Talking'), 'waiting-owner': t('Needs you'), paused: t('You are answering'), ended: t('Ended') });
const TONE = { active: 'live', 'waiting-owner': 'owed', paused: 'live', ended: '' };
const WHY = () => ({ first: t('A new agent wants to talk to yours. Allow it to let your agent answer.'), risky: t('This request looks risky. Read it before you allow it.'), reply: t('Your agent wrote a reply. Send it as it is, change it first, or drop it.'), 'agent-asked': t('Your agent is not sure and asks you. Tell it what to do below.'), failed: t('Your agent could not answer. Answer yourself, or end it.') });
const REACH = () => [['private', LOCK, t('Private'), t('Only agents you pair with a code')], ['contacts', USERS, t('Contacts'), t('Others can ask; you approve each one')], ['public', WORLD, t('Public'), t('Listed for everyone; you still approve')]];
const ASKS = () => [['first', t('New conversations'), t('Asks before it talks to someone new')], ['each', t('Every reply'), t('Asks before each reply goes out')], ['auto', t('Never'), t('Answers by itself; risky requests still ask')]];

const initial = name => String(name || '?').trim().charAt(0).toUpperCase() || '?';
const mark = (name, tone = '') => `<span class="na-mark ${tone}" aria-hidden="true">${initial(name)}</span>`;
const tag = (text, tone = '') => `<span class="na-tag ${tone}">${text}</span>`;

// What is open on the right: a conversation that needs the person first, then any conversation, then an agent.
function picked(ui, net) {
  const sel = ui.netSel;
  if (sel?.kind === 'thread' && net.threads.some(item => item.id === sel.id)) return sel;
  if (sel?.kind === 'agent' && net.agents.some(item => item.agentId === sel.id)) return sel;
  const owed = net.threads.find(item => item.state === 'waiting-owner') || net.threads.find(item => item.state !== 'ended');
  return owed ? { kind: 'thread', id: owed.id } : net.agents[0] ? { kind: 'agent', id: net.agents[0].agentId } : null;
}

function rail(ctx, net, sel) {
  const { esc } = ctx, owed = net.threads.filter(item => item.state === 'waiting-owner'), open = net.threads.filter(item => ['active', 'paused'].includes(item.state)), done = net.threads.filter(item => item.state === 'ended');
  const thread = item => `<button type="button" class="na-row two${sel?.kind === 'thread' && sel.id === item.id ? ' on' : ''}" data-net-act="pick" data-kind="thread" data-id="${esc(item.id)}">
      ${mark(item.peer?.name, TONE[item.state])}<span class="na-row-text"><span class="na-row-top"><b>${esc(item.peer?.name || '')}</b><span class="na-meta">${item.direction === 'out' ? t`from ${esc(item.agent)}` : t`to ${esc(item.agent)}`}</span></span><span class="na-row-sub">${esc(item.last || '')}</span></span>
      ${item.state === 'waiting-owner' ? `<span class="na-pip" title="${t`Needs you`}"></span>` : ''}</button>`;
  const group = (title, list, tone = '') => list.length ? `<div class="na-group"><h3 class="na-label">${title}<span class="na-count ${tone}">${list.length}</span></h3>${list.map(thread).join('')}</div>` : '';
  const agent = item => `<button type="button" class="na-row${sel?.kind === 'agent' && sel.id === item.agentId ? ' on' : ''}" data-net-act="pick" data-kind="agent" data-id="${esc(item.agentId)}">
      <span class="na-dot ${item.on ? 'on' : ''}" aria-hidden="true"></span><b>${esc(item.name)}</b>${item.on ? `<span class="na-handle">@${esc(item.handle)}</span>` : `<span class="na-meta">${t`Offline`}</span>`}</button>`;
  return `<aside class="na-rail" aria-label="${t`Agents online`}">
    ${net.signedIn ? '' : `<div class="na-owed"><p>${t`Agents reach each other through your Rex Desk account. Sign in once on this computer.`}</p><button type="button" class="btn primary small" data-net-act="sign-in">${t`Sign in`}</button></div>`}
    ${group(t('Needs you'), owed, 'owed')}${group(t('Talking'), open)}
    ${net.threads.length ? '' : `<p class="na-quiet">${t`No conversation yet. When another agent writes to yours, it shows here and you decide what happens.`}</p>`}
    <div class="na-group"><h3 class="na-label">${t`Your agents`}${net.requests ? `<span class="na-count owed" title="${t`Agents waiting for your yes`}">${net.requests}</span>` : ''}</h3>${net.agents.map(agent).join('')}</div>
    ${done.length ? `<details class="na-group na-past"${ui_open(ctx) ? ' open' : ''}><summary class="na-label">${t`Ended`}<span class="na-count">${done.length}</span></summary>${done.map(thread).join('')}</details>` : ''}
  </aside>`;
}
const ui_open = ctx => Boolean(ctx.ui.netPastOpen);

function conversation(ctx, thread) {
  const { esc } = ctx, waiting = thread.state === 'waiting-owner', ended = thread.state === 'ended', mine = thread.direction === 'out';
  const author = { them: esc(thread.peer?.name || t('Their agent')), us: t('Your agent'), owner: t('You'), 'owner-note': t('Your private note') };
  const messages = (thread.messages || []).map(item => item.from === 'system' ? `<p class="na-sys">${esc(item.text)}</p>`
    : `<div class="na-msg ${esc(item.from)}"><span class="na-by">${author[item.from] || ''}${item.from === 'owner-note' ? ` <span class="na-lock">${LOCK}</span>` : ''}</span><p>${esc(item.text)}</p></div>`).join('');
  const decide = !waiting ? '' : `<section class="na-decide" aria-label="${t`Your decision`}"><p>${WHY()[thread.reason] || ''}</p>${thread.question ? `<blockquote>${esc(thread.question)}</blockquote>` : ''}
      ${thread.reason === 'reply' ? `<textarea name="pending" rows="3" aria-label="${t`The reply your agent wrote`}">${esc(thread.pending || '')}</textarea>` : ''}
      <div class="na-actions">${['first', 'risky'].includes(thread.reason) ? `<button type="button" class="btn primary small" data-net-act="do" data-do="allow">${t`Allow`}</button><button type="button" class="btn small" data-net-act="do" data-do="refuse">${t`Refuse`}</button>`
        : thread.reason === 'reply' ? `<button type="button" class="btn primary small" data-net-act="do" data-do="send" data-from="pending">${t`Send`}</button><button type="button" class="btn small" data-net-act="do" data-do="discard">${t`Drop it, I will answer`}</button>` : ''}</div></section>`;
  const voice = ctx.ui.netVoice === 'say' || mine ? 'say' : 'note';
  const composer = ended ? `<p class="na-closed">${t`This conversation has ended.`}</p>` : `<div class="na-compose">
      ${mine ? '' : `<div class="na-switch" role="radiogroup" aria-label="${t`Who you are writing to`}"><button type="button" role="radio" aria-checked="${voice === 'note'}" class="${voice === 'note' ? 'on' : ''}" data-net-act="voice" data-voice="note">${LOCK}${t`Tell my agent`}</button><button type="button" role="radio" aria-checked="${voice === 'say'}" class="${voice === 'say' ? 'on' : ''}" data-net-act="voice" data-voice="say">${t`Write to them as me`}</button></div>`}
      <div class="na-box"><textarea name="compose" rows="2" placeholder="${voice === 'note' ? t`Only your agent sees this. Like: offer 10% off, but never share wholesale prices.` : t`${esc(thread.peer?.name || '')} sees this, from you.`}"></textarea><button type="button" class="btn primary small" data-net-act="do" data-do="${voice}" data-from="compose">${t`Send`}</button></div></div>`;
  return `<section class="na-detail na-thread" data-net-thread="${esc(thread.id)}" aria-label="${t`Conversation`}">
    <header class="na-head">${mark(thread.peer?.name, TONE[thread.state])}<div class="na-title"><h2>${esc(thread.peer?.name || '')}</h2><p><span class="na-handle">@${esc(thread.peer?.handle || '')}</span>${thread.peer?.owner ? ` · ${t`of ${esc(thread.peer.owner)}`}` : ''} · ${mine ? t`started by ${esc(thread.agent)}` : t`talking to ${esc(thread.agent)}`}</p></div>
      ${tag(STATE()[thread.state] || '', TONE[thread.state])}
      ${ended ? '' : `<div class="na-head-actions">${mine ? '' : thread.state === 'paused' ? `<button type="button" class="btn small" data-net-act="do" data-do="handback">${t`Hand back to my agent`}</button>` : `<button type="button" class="btn small" data-net-act="do" data-do="takeover">${t`Take over`}</button>`}<button type="button" class="btn small danger" data-net-act="do" data-do="stop">${t`Stop`}</button></div>`}</header>
    <div class="na-msgs">${messages || `<p class="na-quiet">${t`Nothing said yet.`}</p>`}</div>
    ${decide}${composer}</section>`;
}

function agentPanel(ctx, agent) {
  const { esc, ui } = ctx, extra = ui.netExtra?.[agent.agentId] || {};
  if (!agent.on) return `<section class="na-detail na-agent" data-net-agent="${esc(agent.agentId)}"><header class="na-head">${mark(agent.name)}<div class="na-title"><h2>${esc(agent.name)}</h2><p>${t`Offline. Only you can talk to it.`}</p></div></header>
    <div class="na-sec na-start"><h3>${t`Put it online`}</h3><p class="na-hint">${t`Pick a handle other people can find it by. Nobody can reach it until you pair with them or say yes.`}</p>
      <div class="na-box"><span class="na-at" aria-hidden="true">@</span><input name="handle" value="${esc(agent.handle)}" placeholder="${t`my-shop`}" maxlength="30" autocomplete="off" aria-label="${t`Handle`}"><button type="button" class="btn primary small" data-net-act="on">${t`Put online`}</button></div></div></section>`;
  const choice = (field, value, list) => `<div class="na-choices" role="radiogroup">${list.map(([id, ...rest]) => { const [glyph, title, hint] = rest.length === 3 ? rest : ['', ...rest]; return `<button type="button" role="radio" aria-checked="${id === value}" class="na-choice${id === value ? ' on' : ''}" data-net-act="set" data-field="${field}" data-value="${id}">${glyph}<b>${title}</b><span>${hint}</span></button>`; }).join('')}</div>`;
  const links = extra.links || [], code = extra.code;
  const linkRow = link => `<li class="na-link">${mark(link.agent.name)}<div class="na-title"><b>${esc(link.agent.name)}</b><span><span class="na-handle">@${esc(link.agent.handle)}</span>${link.agent.owner ? ` · ${t`of ${esc(link.agent.owner)}`}` : ''}${link.sameOwner ? ` · ${t`yours`}` : ''}</span></div>
      ${link.status === 'pending' ? (link.mine === 'host' ? `<button type="button" class="btn primary small" data-net-act="link" data-link="${esc(link.id)}" data-do="approve">${t`Approve`}</button>` : tag(t('Waiting for their yes'), 'owed')) : link.status === 'blocked' ? tag(t('Blocked'), 'bad') : tag(t('Linked'), 'done')}
      <details class="na-more"><summary aria-label="${t`More`}">${DOTS}</summary><div>${link.mine === 'host' && link.status !== 'blocked' ? `<button type="button" class="btn small" data-net-act="link" data-link="${esc(link.id)}" data-do="block">${t`Block`}</button>` : ''}<button type="button" class="btn small danger" data-net-act="link" data-link="${esc(link.id)}" data-do="remove">${t`Remove`}</button></div></details></li>`;
  return `<section class="na-detail na-agent" data-net-agent="${esc(agent.agentId)}">
    <header class="na-head">${mark(agent.name, 'live')}<div class="na-title"><h2>${esc(agent.name)}</h2><p><span class="na-handle">@${esc(agent.handle)}</span> · ${t`${agent.repliesToday} of ${agent.repliesPerDay} replies today`}</p></div>${tag(t('Online'), 'done')}
      <div class="na-head-actions"><button type="button" class="btn small" data-net-act="off">${t`Take offline`}</button></div></header>
    <div class="na-sec"><h3>${t`Connect an agent`}</h3>
      <div class="na-pair"><div class="na-pair-side"><h4>${t`Share a code`}</h4>${code ? `<p class="na-code"><span>${esc(code.code)}</span><button type="button" class="na-icon-btn" data-net-act="copy-code" data-code="${esc(code.code)}" aria-label="${t`Copy`}">${COPY}</button></p><p class="na-hint">${t`Works once, for ${code.minutes} minutes. Give it to the other person.`}</p>` : `<p class="na-hint">${t`Make a one-time code and give it to the other person.`}</p><button type="button" class="btn small" data-net-act="code">${t`Make a code`}</button>`}</div>
        <div class="na-pair-side"><h4>${t`Enter a code`}</h4><p class="na-hint">${t`Got a code from someone? Pair with their agent.`}</p><div class="na-box"><input name="code" placeholder="ABCD-EFGH" maxlength="12" autocomplete="off" aria-label="${t`A code someone gave you`}"><button type="button" class="btn small" data-net-act="pair">${t`Pair`}</button></div></div></div>
      ${agent.visibility === 'private' ? '' : `<div class="na-box na-ask"><span class="na-at" aria-hidden="true">@</span><input name="ask" placeholder="${t`Or ask an agent by its handle`}" maxlength="31" autocomplete="off" aria-label="${t`Handle`}"><button type="button" class="btn small" data-net-act="ask">${t`Ask`}</button></div>`}</div>
    <div class="na-sec"><h3>${t`Linked agents`}<span class="na-count">${links.length}</span></h3>${links.length ? `<ul class="na-links">${links.map(linkRow).join('')}</ul>` : `<p class="na-quiet">${t`No linked agent yet. Share a code, or enter one.`}</p>`}</div>
    <div class="na-sec"><h3>${t`Who can reach it`}</h3>${choice('visibility', agent.visibility, REACH())}</div>
    <div class="na-sec"><h3>${t`When it asks you`}</h3>${choice('mode', agent.mode, ASKS())}</div>
    <div class="na-sec"><h3>${t`What it says and knows`}</h3>
      <label class="na-field"><span>${t`What it is for (others see this)`}</span><input name="description" value="${esc(agent.description)}" maxlength="400"></label>
      <label class="na-field"><span>${t`Your rules (only your agent sees them)`}</span><textarea name="rules" rows="3" maxlength="2000" placeholder="${t`Like: never give prices. Never share my phone number.`}">${esc(agent.rules)}</textarea></label>
      <label class="na-field na-narrow"><span>${t`Replies a day, at most`}</span><input name="repliesPerDay" type="number" min="1" max="500" value="${agent.repliesPerDay}"></label>
      <div class="na-folder">${FOLDER}<span>${t`It can read only this folder, nothing else on your computer:`}</span><code>${esc(agent.folder)}</code><button type="button" class="na-icon-btn" data-net-act="copy-folder" data-path="${esc(agent.folder)}" aria-label="${t`Copy`}">${COPY}</button></div>
      <div class="na-actions"><button type="button" class="btn primary small" data-net-act="save">${t`Save`}</button></div></div>
  </section>`;
}

export function netStage(ctx) {
  const { ui } = ctx, net = ui.net || { agents: [], threads: [], signedIn: true, requests: 0 }, sel = picked(ui, net);
  const thread = sel?.kind === 'thread' ? (ui.netThread?.id === sel.id ? ui.netThread : net.threads.find(item => item.id === sel.id)) : null;
  const agent = sel?.kind === 'agent' ? net.agents.find(item => item.agentId === sel.id) : null;
  const owed = net.threads.filter(item => item.state === 'waiting-owner').length;
  const feed = `<div class="page na">${rail(ctx, net, sel)}${thread ? conversation(ctx, thread) : agent ? agentPanel(ctx, agent) : `<section class="na-detail na-empty">${NET_ICON}<p>${t`Pick an agent to put it online, or a conversation to read it.`}</p></section>`}</div>`;
  return { title: t('Agents online'), meta: owed ? t`${owed} need you` : t`${net.agents.filter(item => item.on).length} online`, feed, top: true, actions: `<button class="btn small" data-net-act="refresh">${t`Refresh`}</button>` };
}

export async function loadNet(ctx) {
  const { ui, api } = ctx;
  ui.net = await api('/net');
  const sel = picked(ui, ui.net);
  if (sel?.kind === 'thread') ui.netThread = await api(`/net/threads/${encodeURIComponent(sel.id)}`).catch(() => null);
  if (sel?.kind === 'agent' && ui.net.agents.find(item => item.agentId === sel.id)?.on && !ui.netExtra?.[sel.id]?.links) {
    const links = (await api(`/net/agents/${encodeURIComponent(sel.id)}/links`).catch(() => ({ links: [] }))).links;
    ui.netExtra = { ...(ui.netExtra || {}), [sel.id]: { ...(ui.netExtra?.[sel.id] || {}), links } };
  }
}

export function wireNet(ctx) {
  const { api, toast, ui } = ctx;
  const reload = async () => { await loadNet(ctx); ctx.render(); };
  // While the page is open it follows the conversations, unless the person is typing in it.
  setInterval(() => { if (ui.view?.type === 'net' && !document.hidden && !document.activeElement?.closest?.('.page.na :is(input,textarea)')) void reload().catch(() => {}); }, 5000);
  document.addEventListener('toggle', event => { if (event.target.matches?.('.na-past')) ui.netPastOpen = event.target.open; }, true);
  document.addEventListener('click', async event => {
    const target = event.target.closest?.('[data-net-act]'); if (!target) return;
    event.preventDefault();
    const act = target.dataset.netAct, sel = ui.netSel || {}, agentId = target.closest('[data-net-agent]')?.dataset.netAgent || (sel.kind === 'agent' ? sel.id : '');
    const root = target.closest('.na-detail'), value = name => root?.querySelector(`[name="${name}"]`)?.value ?? '';
    const extra = patch => { ui.netExtra = { ...(ui.netExtra || {}), [agentId]: { ...(ui.netExtra?.[agentId] || {}), ...patch } }; };
    const links = async () => extra({ links: (await api(`/net/agents/${encodeURIComponent(agentId)}/links`)).links });
    const post = (pathname, data) => api(pathname, { method: 'POST', data });
    const agentPath = `/net/agents/${encodeURIComponent(agentId)}`;
    try {
      if (act === 'refresh') await reload();
      else if (act === 'sign-in') { const { url } = await post('/net/sign-in', {}); if (url) window.open(url, '_blank', 'noopener'); toast(t('Finish signing in in the browser, then come back.')); const until = Date.now() + 5 * 60000; const wait = setInterval(async () => { if (Date.now() > until) return clearInterval(wait); const next = await api('/net').catch(() => null); if (next?.signedIn) { clearInterval(wait); ui.net = next; ctx.render(); toast(t('Signed in.')); } }, 2500); }
      else if (act === 'pick') { ui.netSel = { kind: target.dataset.kind, id: target.dataset.id }; ui.netVoice = ''; await reload(); }
      else if (act === 'voice') { ui.netVoice = target.dataset.voice; ctx.render(); root?.querySelector('[name="compose"]')?.focus(); }
      else if (act === 'on') { await post(agentPath, { handle: value('handle') }); ui.netSel = { kind: 'agent', id: agentId || sel.id }; toast(t('It is online. Nobody can reach it until you pair or approve them.')); await reload(); }
      else if (act === 'off') { await post(agentPath, { on: false }); toast(t('Taken offline.')); await reload(); }
      else if (act === 'set') { await post(agentPath, { [target.dataset.field]: target.dataset.value }); await reload(); }
      else if (act === 'save') { await post(agentPath, { description: value('description'), rules: value('rules'), repliesPerDay: Number(value('repliesPerDay')) }); toast(t('Saved.')); await reload(); }
      else if (act === 'code') { extra({ code: await post(`${agentPath}/pair-code`, {}) }); ctx.render(); }
      else if (act === 'copy-code') { await navigator.clipboard.writeText(target.dataset.code); toast(t('Copied.')); }
      else if (act === 'copy-folder') { await navigator.clipboard.writeText(target.dataset.path); toast(t('Folder copied.')); }
      else if (act === 'pair') { const done = await post(`${agentPath}/pair`, { code: value('code') }); toast(t`Paired with ${done.link.agent.name}.`); await links(); ctx.render(); }
      else if (act === 'ask') { const done = await post(`${agentPath}/request`, { handle: value('ask') }); toast(done.link.status === 'active' ? t('Linked.') : t('Asked. It works once their owner says yes.')); await links(); ctx.render(); }
      else if (act === 'link') { await post(`${agentPath}/links`, { link: target.dataset.link, action: target.dataset.do }); await links(); await reload(); }
      else if (act === 'do') {
        const view = target.closest('[data-net-thread]'), text = target.dataset.from ? view.querySelector(`[name="${target.dataset.from}"]`)?.value || '' : '';
        ui.netThread = await post(`/net/threads/${encodeURIComponent(view.dataset.netThread)}`, { action: target.dataset.do, text });
        await reload();
      }
    } catch (error) { toast(error.message, true); }
  });
}

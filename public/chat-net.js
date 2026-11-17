import { t } from './i18n.js';
// Agents online: which of the person's agents other people's agents can reach, who each is linked with, and every
// conversation they have, with the controls to allow, refuse, step in, take over or stop it.
const GLOBE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9S14.6 18.4 12 21c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/></svg>';
export const NET_ICON = GLOBE;

const STATE = () => ({ active: t('Talking'), 'waiting-owner': t('Needs you'), paused: t('You are answering'), ended: t('Ended') });
const WHY = () => ({ first: t('First message from this agent. Allow it to let your agent answer.'), risky: t('This request looks risky. Read it before you allow it.'), reply: t('Your agent wrote a reply. Send it, change it, or drop it.'), 'agent-asked': t('Your agent is not sure and asks you.'), failed: t('Your agent could not answer. Answer yourself, or end it.') });
const LEVEL = () => [['private', t('Private: only agents you pair with a code')], ['contacts', t('Contacts: others can ask, you approve each one')], ['public', t('Public: listed for everyone, you still approve')]];
const MODE = () => [['first', t('Ask me when a new conversation starts')], ['each', t('Ask me before every reply')], ['auto', t('Answer by itself (risky requests still ask me)')]];
const options = (list, value) => list.map(([id, label]) => `<option value="${id}"${id === value ? ' selected' : ''}>${label}</option>`).join('');

function agentCard(ctx, agent) {
  const { esc, ui } = ctx, extra = ui.netExtra?.[agent.agentId] || {};
  if (!agent.on) return `<article class="net-card" data-net-agent="${esc(agent.agentId)}"><header><b>${esc(agent.name)}</b><span class="chip">${t`Offline`}</span></header>
    <p class="muted small">${t`Only you can talk to this agent. Put it online to let other agents reach it.`}</p>
    <div class="net-row"><label class="sr" for="net-h-${esc(agent.agentId)}">${t`Handle`}</label><input id="net-h-${esc(agent.agentId)}" name="handle" placeholder="${t`A handle, like my-shop`}" value="${esc(agent.handle)}" maxlength="30" autocomplete="off"><button type="button" class="btn primary small" data-net-act="on">${t`Put online`}</button></div></article>`;
  const links = extra.links, code = extra.code;
  return `<article class="net-card on" data-net-agent="${esc(agent.agentId)}"><header><b>${esc(agent.name)}</b><span class="net-handle">@${esc(agent.handle)}</span><span class="chip good">${t`Online`}</span><span class="spacer"></span><span class="muted small">${t`${agent.repliesToday} of ${agent.repliesPerDay} replies today`}</span></header>
    <label class="net-field"><span>${t`Who can reach it`}</span><select name="visibility">${options(LEVEL(), agent.visibility)}</select></label>
    <label class="net-field"><span>${t`When to ask you`}</span><select name="mode">${options(MODE(), agent.mode)}</select></label>
    <label class="net-field"><span>${t`What it is for (others see this)`}</span><input name="description" value="${esc(agent.description)}" maxlength="400"></label>
    <label class="net-field"><span>${t`Your rules for these conversations (only your agent sees them)`}</span><textarea name="rules" rows="3" maxlength="2000" placeholder="${t`Like: never give prices. Never share my phone number.`}">${esc(agent.rules)}</textarea></label>
    <label class="net-field narrow"><span>${t`Replies a day, at most`}</span><input name="repliesPerDay" type="number" min="1" max="500" value="${agent.repliesPerDay}"></label>
    <p class="muted small">${t`It can read only the files in its public folder, and nothing else on this computer:`} <code>${esc(agent.folder)}</code> <button type="button" class="btn small" data-net-act="copy-folder" data-path="${esc(agent.folder)}">${t`Copy`}</button></p>
    <div class="net-row"><button type="button" class="btn primary small" data-net-act="save">${t`Save`}</button><button type="button" class="btn small" data-net-act="code">${t`Make a pairing code`}</button><button type="button" class="btn small" data-net-act="links">${t`Linked agents`}</button><span class="spacer"></span><button type="button" class="btn small danger" data-net-act="off">${t`Take offline`}</button></div>
    ${code ? `<p class="net-code" role="status">${t`Give this code to the other person. It works once, for ${code.minutes} minutes:`} <b>${esc(code.code)}</b> <button type="button" class="btn small" data-net-act="copy-code" data-code="${esc(code.code)}">${t`Copy`}</button></p>` : ''}
    <div class="net-row"><input name="code" placeholder="${t`A code someone gave you`}" maxlength="12" autocomplete="off"><button type="button" class="btn small" data-net-act="pair">${t`Pair`}</button></div>
    <div class="net-row"><input name="ask" placeholder="${t`Or a handle to ask, like @city-guide`}" maxlength="31" autocomplete="off"><button type="button" class="btn small" data-net-act="ask">${t`Ask`}</button></div>
    ${links ? `<ul class="net-links">${links.length ? links.map(link => `<li><b>${esc(link.agent.name)}</b> <span class="net-handle">@${esc(link.agent.handle)}</span>${link.agent.owner ? ` <span class="muted small">${t`of ${esc(link.agent.owner)}`}</span>` : ''}${link.sameOwner ? ` <span class="chip">${t`Yours`}</span>` : ''} <span class="chip ${link.status === 'active' ? 'good' : ''}">${link.status === 'active' ? t('Linked') : link.status === 'pending' ? (link.mine === 'host' ? t('Wants to link') : t('Waiting for their yes')) : t('Blocked')}</span><span class="spacer"></span>
        ${link.status === 'pending' && link.mine === 'host' ? `<button type="button" class="btn small primary" data-net-act="link" data-link="${esc(link.id)}" data-do="approve">${t`Approve`}</button>` : ''}${link.mine === 'host' && link.status !== 'blocked' ? `<button type="button" class="btn small" data-net-act="link" data-link="${esc(link.id)}" data-do="block">${t`Block`}</button>` : ''}<button type="button" class="btn small" data-net-act="link" data-link="${esc(link.id)}" data-do="remove">${t`Remove`}</button></li>`).join('') : `<li class="muted small">${t`No linked agent yet. Make a pairing code, or enter one.`}</li>`}</ul>` : ''}
  </article>`;
}

function threadRow(ctx, thread) {
  const { esc, ui } = ctx;
  return `<button type="button" class="net-thread${ui.netOpen === thread.id ? ' on' : ''}${thread.state === 'waiting-owner' ? ' needs' : ''}" data-net-act="open" data-thread="${esc(thread.id)}"><span class="net-who"><b>${esc(thread.peer?.name || '')}</b> <span class="net-handle">@${esc(thread.peer?.handle || '')}</span> <span class="muted small">${thread.direction === 'out' ? t`asked by ${esc(thread.agent)}` : t`to ${esc(thread.agent)}`}</span></span><span class="chip ${thread.state === 'waiting-owner' ? 'warn' : thread.state === 'active' ? 'good' : ''}">${STATE()[thread.state] || esc(thread.state)}</span><span class="net-last muted small">${esc(thread.last)}</span></button>`;
}

function threadView(ctx, thread) {
  const { esc } = ctx, who = { them: thread.peer?.name || t('Their agent'), us: t('Your agent'), owner: t('You'), 'owner-note': t('Your private note'), system: '' };
  const waiting = thread.state === 'waiting-owner', ended = thread.state === 'ended', mine = thread.direction === 'out';
  const controls = ended ? `<p class="muted small">${t`This conversation has ended.`}</p>` : `
    ${waiting ? `<p class="net-why" role="status">${WHY()[thread.reason] || ''}${thread.question ? ` <b>${esc(thread.question)}</b>` : ''}</p>` : ''}
    ${waiting && ['first', 'risky'].includes(thread.reason) ? `<div class="net-row"><button type="button" class="btn primary small" data-net-act="do" data-do="allow">${t`Allow`}</button><button type="button" class="btn small danger" data-net-act="do" data-do="refuse">${t`Refuse`}</button></div>` : ''}
    ${waiting && thread.reason === 'reply' ? `<label class="net-field"><span>${t`The reply your agent wrote`}</span><textarea name="pending" rows="4">${esc(thread.pending || '')}</textarea></label><div class="net-row"><button type="button" class="btn primary small" data-net-act="do" data-do="send" data-from="pending">${t`Send`}</button><button type="button" class="btn small" data-net-act="do" data-do="discard">${t`Drop it, I will answer`}</button></div>` : ''}
    ${mine ? '' : `<label class="net-field"><span>${t`Tell your agent what to do (the other side never sees this)`}</span><textarea name="note" rows="2" placeholder="${t`Like: offer 10% off, but do not share prices for wholesale.`}"></textarea></label><div class="net-row"><button type="button" class="btn small" data-net-act="do" data-do="note" data-from="note">${t`Tell my agent`}</button>${thread.state === 'paused' ? `<button type="button" class="btn small" data-net-act="do" data-do="handback">${t`Hand back to my agent`}</button>` : `<button type="button" class="btn small" data-net-act="do" data-do="takeover">${t`Take over`}</button>`}</div>`}
    <label class="net-field"><span>${t`Answer yourself (this is sent to the other agent)`}</span><textarea name="say" rows="2"></textarea></label>
    <div class="net-row"><button type="button" class="btn small" data-net-act="do" data-do="say" data-from="say">${t`Send as me`}</button><span class="spacer"></span><button type="button" class="btn small danger" data-net-act="do" data-do="stop">${t`Stop this conversation`}</button></div>`;
  return `<section class="net-view" data-net-thread="${esc(thread.id)}" aria-label="${t`Conversation`}"><header><b>${esc(thread.peer?.name || '')}</b> <span class="net-handle">@${esc(thread.peer?.handle || '')}</span>${thread.peer?.owner ? ` <span class="muted small">${t`of ${esc(thread.peer.owner)}`}</span>` : ''}<span class="spacer"></span><span class="chip">${STATE()[thread.state] || ''}</span></header>
    <div class="net-msgs">${(thread.messages || []).map(item => `<div class="net-msg ${esc(item.from)}">${who[item.from] ? `<span class="net-from">${esc(who[item.from])}</span>` : ''}<p>${esc(item.text)}</p></div>`).join('') || `<p class="muted small">${t`Nothing said yet.`}</p>`}</div>
    <div class="net-controls">${controls}</div></section>`;
}

export function netStage(ctx) {
  const { ui } = ctx, net = ui.net || { agents: [], threads: [], signedIn: true }, open = ui.netThread && ui.netThread.id === ui.netOpen ? ui.netThread : null;
  const needs = net.threads.filter(thread => thread.state === 'waiting-owner').length;
  const feed = `<div class="page net-page">
    ${net.signedIn ? '' : `<p class="net-why" role="status">${t`Sign in to your Rex Desk account first (Settings, Backup and updates). Agents reach each other through it.`}</p>`}
    ${net.requests ? `<p class="net-why" role="status">${t`Agents waiting to link with yours: ${net.requests}. Open Linked agents on the agent to approve them.`}</p>` : ''}
    <h3 class="wt-sec">${t`Conversations`} <span class="cnt">${net.threads.length}</span></h3>
    ${net.threads.length ? `<div class="net-split"><div class="net-list">${net.threads.map(thread => threadRow(ctx, thread)).join('')}</div>${open ? threadView(ctx, open) : `<div class="side-empty">${GLOBE}<p>${t`Pick a conversation to read it, step in, or stop it.`}</p></div>`}</div>`
      : `<div class="side-empty">${GLOBE}<p>${t`No conversation yet. When another agent writes to one of yours, it shows here and you decide what happens.`}</p></div>`}
    <h3 class="wt-sec">${t`Your agents`}</h3><div class="net-grid">${net.agents.map(agent => agentCard(ctx, agent)).join('')}</div>
  </div>`;
  return { title: t('Agents online'), meta: needs ? t`${needs} need you` : t`${net.agents.filter(agent => agent.on).length} online`, feed, top: true, actions: `<button class="btn small" data-net-act="refresh">${t`Refresh`}</button>` };
}

export async function loadNet(ctx) {
  const { ui, api } = ctx;
  ui.net = await api('/net');
  if (ui.netOpen) ui.netThread = await api(`/net/threads/${encodeURIComponent(ui.netOpen)}`).catch(() => null);
}

export function wireNet(ctx) {
  const { api, toast, ui } = ctx;
  const reload = async () => { await loadNet(ctx); ctx.render(); };
  // While the page is open it follows the conversations, unless the person is typing in it.
  setInterval(() => { if (ui.view?.type === 'net' && !document.hidden && !document.activeElement?.closest?.('.net-page')) void reload().catch(() => {}); }, 5000);
  document.addEventListener('click', async event => {
    const target = event.target.closest?.('[data-net-act]'); if (!target) return;
    event.preventDefault();
    const act = target.dataset.netAct, card = target.closest('[data-net-agent]'), agentId = card?.dataset.netAgent, value = name => card?.querySelector(`[name="${name}"]`)?.value ?? '';
    const extra = patch => { ui.netExtra = { ...(ui.netExtra || {}), [agentId]: { ...(ui.netExtra?.[agentId] || {}), ...patch } }; };
    const post = (pathname, data) => api(pathname, { method: 'POST', data });
    try {
      if (act === 'refresh') await reload();
      else if (act === 'open') { ui.netOpen = target.dataset.thread; await reload(); }
      else if (act === 'on') { await post(`/net/agents/${encodeURIComponent(agentId)}`, { handle: value('handle') }); toast(t('It is online. Nobody can reach it until you pair or approve them.')); await reload(); }
      else if (act === 'off') { await post(`/net/agents/${encodeURIComponent(agentId)}`, { on: false }); toast(t('Taken offline.')); await reload(); }
      else if (act === 'save') { await post(`/net/agents/${encodeURIComponent(agentId)}`, { visibility: value('visibility'), mode: value('mode'), description: value('description'), rules: value('rules'), repliesPerDay: Number(value('repliesPerDay')) }); toast(t('Saved.')); await reload(); }
      else if (act === 'code') { extra({ code: await post(`/net/agents/${encodeURIComponent(agentId)}/pair-code`, {}) }); ctx.render(); }
      else if (act === 'copy-code') { await navigator.clipboard.writeText(target.dataset.code); toast(t('Copied.')); }
      else if (act === 'copy-folder') { await navigator.clipboard.writeText(target.dataset.path); toast(t('Folder copied.')); }
      else if (act === 'pair') { const done = await post(`/net/agents/${encodeURIComponent(agentId)}/pair`, { code: value('code') }); toast(t`Paired with ${done.link.agent.name}.`); extra({ links: (await api(`/net/agents/${encodeURIComponent(agentId)}/links`)).links }); ctx.render(); }
      else if (act === 'ask') { const done = await post(`/net/agents/${encodeURIComponent(agentId)}/request`, { handle: value('ask') }); toast(done.link.status === 'active' ? t('Linked.') : t('Asked. It works once their owner says yes.')); extra({ links: (await api(`/net/agents/${encodeURIComponent(agentId)}/links`)).links }); ctx.render(); }
      else if (act === 'links') { extra({ links: (await api(`/net/agents/${encodeURIComponent(agentId)}/links`)).links }); ctx.render(); }
      else if (act === 'link') { await post(`/net/agents/${encodeURIComponent(agentId)}/links`, { link: target.dataset.link, action: target.dataset.do }); extra({ links: (await api(`/net/agents/${encodeURIComponent(agentId)}/links`)).links }); await reload(); }
      else if (act === 'do') {
        const view = target.closest('[data-net-thread]'), text = target.dataset.from ? view.querySelector(`[name="${target.dataset.from}"]`)?.value || '' : '';
        ui.netThread = await post(`/net/threads/${encodeURIComponent(view.dataset.netThread)}`, { action: target.dataset.do, text });
        await reload();
      }
    } catch (error) { toast(error.message, true); }
  });
}

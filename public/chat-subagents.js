import { t } from './i18n.js';

// A sub-agent the agent started: what it was asked, its steps, what it reported back. The card in the chat and the Sub-agents tab draw it the same way.
export function subagentHtml(item, live, { esc, markdown, openSubs, jump = false }) {
  const input = item.input, state = item.done ? (item.failed ? 'failed' : 'done') : live ? 'working' : 'stopped';
  const label = { working: t('Working…'), done: t('Done'), failed: t('Failed'), stopped: t('Stopped') }[state];
  const took = item.endedAt ? Math.max(1, Math.round((Date.parse(item.endedAt) - Date.parse(item.at)) / 1000)) : 0;
  const step = event => `<li><b>${esc(event.tool)}</b> ${esc(Object.values(event.input || {}).filter(value => typeof value === 'string').join(' · ').slice(0, 140))}</li>`;
  return `<details class="subagent ${state}"${openSubs?.has(item.id) ? ' open' : ''} data-sub="${esc(item.id)}"><summary><span class="sa-dot ${state}"></span><span class="sa-main"><b>${t('Sub-agent')}${input.description ? `: ${esc(input.description)}` : ''}</b><small>${esc([item.who, input.type, input.model, (item.steps.length === 1 ? t`${item.steps.length} step` : t`${item.steps.length} steps`), took ? `${took < 60 ? `${took}s` : t`${Math.round(took / 60)} min`}` : ''].filter(Boolean).join(' · '))}</small></span><span class="sa-state">${label}</span></summary>
    <div class="sa-body">${input.prompt ? `<p class="sa-h">${t`Asked`}</p><div class="md sa-text">${markdown(input.prompt)}</div>` : ''}${item.steps.length ? `<p class="sa-h">${t`Steps`}</p><ol class="sa-steps">${item.steps.slice(-40).map(step).join('')}</ol>` : ''}${item.result || item.text ? `<p class="sa-h">${t`Reported back`}</p><div class="md sa-text">${markdown(item.result || item.text)}</div>` : ''}${jump ? `<button type="button" class="btn small quiet" data-action="sub-jump" data-sub="${esc(item.id)}" data-run="${esc(item.runId || '')}">${t`Show in chat`}</button>` : ''}</div></details>`;
}
// Every sub-agent in a list of events, oldest first. A sub-agent started by another sub-agent is a step of its parent, not a row.
export function subagentsFromEvents(events, extra = {}) {
  const subs = new Map(), list = [];
  for (const event of events) {
    if (event.kind === 'agent-tool' && event.tool === 'Agent') { const sub = { role: 'subagent', id: event.id, input: event.input || {}, steps: [], text: '', done: false, failed: false, at: event.createdAt, ...extra }; subs.set(event.id, sub); if (subs.has(event.parent)) subs.get(event.parent).steps.push({ tool: t('Agent'), input: { description: sub.input.description } }); else list.push(sub); continue; }
    if (event.parent && subs.has(event.parent)) { const sub = subs.get(event.parent); if (event.kind === 'agent-tool') sub.steps.push(event); else if (event.kind === 'subagent-text') sub.text = event.text; continue; }
    if (event.kind === 'subagent-done') { const sub = subs.get(event.id); if (sub) Object.assign(sub, { done: true, failed: event.failed, result: event.text, endedAt: event.createdAt }); }
  }
  return list;
}
// The body of the Sub-agents tab: newest first, kept as long as the chat's history is.
export function subagentsPanel(subs, ctx, { live = () => false, jump = false } = {}) {
  const { esc, markdown, ui } = ctx;
  if (!subs.length) return `<div class="side-body"><div class="side-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="7" r="3"/><circle cx="5.5" cy="17" r="2.5"/><circle cx="18.5" cy="17" r="2.5"/><path d="M10.5 9.6 7 14.6M13.5 9.6 17 14.6"/></svg><p>${t`No sub-agents yet. When an agent starts one, it is listed here.`}</p></div></div>`;
  const sorted = [...subs].sort((left, right) => String(right.at).localeCompare(String(left.at)));
  return `<div class="side-body sa-list">${sorted.map(item => subagentHtml(item, live(item), { esc, markdown, openSubs: ui.openSubs, jump })).join('')}</div>`;
}

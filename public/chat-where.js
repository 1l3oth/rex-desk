import { t } from './i18n.js';
// "Where it works": an agent either stays on one computer or follows the person to the computer they write from.
// The full profile shows a two-part control, a small map of the person's computers with the agent's dot, and the four steps
// of a move as they really happen (the server writes them on the agent: move.steps). The side panel shows one line with a pill.
// Only computers are places: a phone or a browser window is where the person chats from, never where an agent runs.

const PIN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/></svg>';
const FOLLOW = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h12M12 7l5 5-5 5"/><circle cx="20" cy="12" r="1.3" fill="currentColor"/></svg>';
const SCREEN = '<svg viewBox="0 0 48 40" width="44" height="36" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="38" height="24" rx="3"/><path d="M18 35h12M24 28v7"/></svg>';
const STEPS = () => [['saved', t('Work saved')], ['committed', t('Committed')], ['moved', t('Moved')], ['pickedUp', t('Picked up')]];
const RECENT = 120000;

// The person's computers: this one and the others they linked (Devices). Phones are never in this list.
export function computers(ui) {
  const devices = ui.snap?.devices || {}, self = devices.self || {};
  const list = [{ id: self.id || 'here', name: self.name || t('This computer'), online: true, here: true }];
  for (const peer of devices.peers || []) if (peer.id && peer.id !== self.id && !list.some(item => item.id === peer.id)) list.push({ id: peer.id, name: peer.name || t('Another computer'), online: Boolean(peer.online) });
  return list;
}
const nodeOf = (ui, agent) => agent.node || ui.snap?.devices?.self?.id || 'here';
const nameOf = (ui, agent) => agent.device || computers(ui).find(item => item.id === nodeOf(ui, agent))?.name || t('this computer');
// A move the server is doing, or did in the last two minutes (its steps stay lit for a moment, then the chips go away).
const moveOf = agent => { const move = agent.move; if (!move || !move.steps) return null; return move.state === 'running' || move.state === 'failed' || Date.now() - Date.parse(move.at || 0) < RECENT ? move : null; };

// Full profile, Setup tab.
export function whereHtml(ctx, agent) {
  const { ui, esc } = ctx, follows = agent.follows !== false && !agent.pinned, place = nameOf(ui, agent), here = nodeOf(ui, agent);
  const locked = agent.pinned || agent.kind === 'main';
  const seg = `<div class="wh-seg${follows ? ' follow' : ''}" role="radiogroup" aria-label="${t`Where it works`}"><span class="wh-thumb" aria-hidden="true"></span>
    <button type="button" role="radio" aria-checked="${!follows}" class="${follows ? '' : 'on'}" data-action="${follows && !locked ? 'spec-follow' : ''}" data-agent-id="${esc(agent.id)}"${locked ? ' disabled' : ''}>${PIN}<span>${t`Stays on ${esc(place)}`}</span></button>
    <button type="button" role="radio" aria-checked="${follows}" class="${follows ? 'on' : ''}" data-action="${!follows && !locked ? 'spec-follow' : ''}" data-agent-id="${esc(agent.id)}"${locked ? ' disabled' : ''}>${FOLLOW}<span>${t`Follows you`}</span></button></div>`;
  const places = computers(ui);
  const map = `<div class="wh-map" data-where-map="${esc(agent.id)}" data-where-node="${esc(here)}">${places.map(item => `<div class="wh-pc${item.id === here ? ' here' : ''}${item.online ? '' : ' off'}" data-pc="${esc(item.id)}">${SCREEN}<span>${esc(item.name)}</span>${item.online ? '' : `<small>${t`Off`}</small>`}</div>`).join('')}
    <span class="wh-trail" aria-hidden="true"></span><span class="wh-dot${follows ? '' : ' pinned'}" aria-hidden="true">${ctx.avatar({ name: agent.name, agent, size: 'xs' })}<i class="wh-badge">${PIN}</i></span></div>`;
  const move = moveOf(agent);
  const chips = move ? `<div class="wh-steps" role="status" aria-label="${t`Moving`}">${STEPS().map(([key, label]) => `<span class="wh-chip${move.steps[key] ? ' done' : ''}">${move.steps[key] ? '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}${label}</span>`).join('')}</div>${move.state === 'failed' && move.error ? `<p class="wh-error" role="alert">${esc(move.error)}</p>` : ''}` : '';
  const status = follows ? t`Follows you. Now on ${`<b>${esc(place)}</b>`}.` : t`Works on ${`<b>${esc(place)}</b>`}. You can chat from any device.`;
  return `<div class="wh">${seg}${map}
    <p class="wh-status"><span class="dot good"></span><span>${status}</span></p>
    <p class="wh-phone"><span class="dot good"></span><span>${t`Works on ${`<b>${esc(place)}</b>`}. You chat from here.`}</span></p>
    ${chips}${agent.pinned ? `<p class="wh-note">${t`Set in Settings, Projects.`}</p>` : ''}</div>`;
}

// Side panel: one line with a pill that switches it.
export function whereLine(ctx, agent) {
  const { ui, esc } = ctx, follows = agent.follows !== false && !agent.pinned, place = nameOf(ui, agent);
  const pill = agent.pinned ? `<span class="wh-pill pin">${PIN}<span>${t`Pinned`}</span></span>`
    : `<button type="button" class="wh-pill${follows ? '' : ' pin'}" data-action="spec-follow" data-agent-id="${esc(agent.id)}" title="${follows ? t('Switch to stay on this computer') : t('Switch to follow you')}">${follows ? FOLLOW : PIN}<span>${follows ? t('Follows you') : t('Pinned')}</span></button>`;
  return `<div class="aps-row wh-line"><span>${t`Where it works`}</span><div><small class="wh-place">${esc(place)}</small>${pill}</div></div>`;
}

// After a draw: the dot stands over its computer. When the computer changed since the last draw, the dot hops along a
// dashed trail from the old one to the new one. Positions are set from code (the page allows no inline style attributes).
const lastNode = new Map();
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export function placeWhere() {
  for (const map of document.querySelectorAll('[data-where-map]')) {
    const id = map.dataset.whereMap, node = map.dataset.whereNode, dot = map.querySelector('.wh-dot'), target = map.querySelector(`[data-pc="${CSS.escape(node)}"]`) || map.querySelector('.wh-pc');
    if (!dot || !target) continue;
    const box = map.getBoundingClientRect(), pc = target.getBoundingClientRect(), x = pc.left - box.left + pc.width / 2 - dot.offsetWidth / 2;
    const before = lastNode.get(id), from = before && before.node !== node ? before.x : null;
    dot.style.transform = `translateX(${x}px)`;
    lastNode.set(id, { node, x });
    if (from === null || reduced() || !dot.animate) continue;
    const trail = map.querySelector('.wh-trail'), left = Math.min(from, x) + dot.offsetWidth / 2;
    trail.style.left = `${left}px`; trail.style.width = `${Math.abs(x - from)}px`;
    trail.animate([{ opacity: 0, backgroundPosition: '24px 0' }, { opacity: 0.7, offset: 0.3 }, { opacity: 0, backgroundPosition: '0 0' }], { duration: 700, easing: 'linear' });
    dot.animate([{ transform: `translateX(${from}px) translateY(0)` }, { transform: `translateX(${(from + x) / 2}px) translateY(-20px)`, offset: 0.45 }, { transform: `translateX(${x}px) translateY(0)` }], { duration: 560, easing: 'cubic-bezier(.35,0,.2,1)' });
  }
}

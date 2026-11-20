import { t } from './i18n.js';
// "Where it works": an agent either stays on one computer or follows the person to the computer they write from.
// The full profile shows a segmented control, the person's computers as a plain list (the agent's one checked), and the
// four steps of a move as they really happen (the server writes them on the agent: move.steps). The side panel shows one
// line with a pill.
// Only computers are places: a phone or a browser window is where the person chats from, never where an agent runs.

const PIN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/></svg>';
const FOLLOW = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h12M12 7l5 5-5 5"/><circle cx="20" cy="12" r="1.3" fill="currentColor"/></svg>';
const STEPS = () => [['saved', t('Work saved')], ['committed', t('Committed')], ['moved', t('Moved')], ['pickedUp', t('Picked up')]];
const RECENT = 120000;
// A failed move keeps its one-line reason on screen for half an hour, then the control is quiet again.
const FAILED_FOR = 30 * 60000;

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
const moveOf = agent => { const move = agent.move; if (!move || !move.steps) return null; const age = Date.now() - Date.parse(move.at || 0); return move.state === 'running' || (move.state === 'failed' && age < FAILED_FOR) || age < RECENT ? move : null; };

// Full profile, Setup tab: rows for the Where it works group. A segmented control picks the mode; the person's computers
// follow as a plain list, the one the agent is on marked with a check. A move shows its four steps in one quiet row.
export function whereHtml(ctx, agent, { row }) {
  const { ui, esc } = ctx, follows = agent.follows !== false && !agent.pinned, place = nameOf(ui, agent), here = nodeOf(ui, agent);
  const locked = agent.pinned || agent.kind === 'main';
  const option = (on, label) => `<button type="button" role="radio" aria-checked="${on}" class="${on ? 'on' : ''}" data-action="${!on && !locked ? 'spec-follow' : ''}" data-agent-id="${esc(agent.id)}"${locked ? ' disabled' : ''}>${label}</button>`;
  const seg = `<div class="agp-seg wh-mode" role="radiogroup" aria-label="${t`Where it works`}">${option(!follows, t('Stays here'))}${option(follows, t('Follows you'))}</div>`;
  const note = follows ? t('Moves to the computer you write from.') : t`Works on ${esc(place)}. You can chat from any device.`;
  const pcs = computers(ui).map(item => {
    const on = item.id === here;
    return `<div class="agp-r wh-pc${on ? ' here' : ''}${item.online ? '' : ' off'}"><div class="agp-rl"><span>${esc(item.name)}${item.here ? ` <span class="agp-faint">${t`(this computer)`}</span>` : ''}</span></div>
      <div class="agp-rc"><span class="agp-value">${on ? t('Working here') : item.online ? t('Online') : t('Offline')}</span>${on ? '<svg class="wh-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<span class="wh-check"></span>'}</div></div>`;
  }).join('');
  const move = moveOf(agent);
  const steps = move ? `<div class="agp-r wh-steps${move.state === 'failed' ? ' failed' : ''}" role="status" aria-label="${t`Moving`}"><div class="agp-rl"><span>${move.state === 'failed' ? t('Move failed') : move.state === 'running' ? t('Moving') : t('Moved')}</span>${move.state === 'failed' && move.error ? `<small>${esc(move.error)}</small>` : ''}</div>
    <div class="agp-rc"><ol class="wh-progress">${STEPS().map(([key, label]) => `<li class="${move.steps[key] ? 'done' : ''}">${esc(label)}</li>`).join('')}</ol></div></div>` : '';
  return row(t('Mode'), seg, note) + pcs + steps;
}

// Side panel: one line with a pill that switches it.
export function whereLine(ctx, agent) {
  const { ui, esc } = ctx, follows = agent.follows !== false && !agent.pinned, place = nameOf(ui, agent);
  const pill = agent.pinned ? `<span class="wh-pill pin">${PIN}<span>${t`Pinned`}</span></span>`
    : `<button type="button" class="wh-pill${follows ? '' : ' pin'}" data-action="spec-follow" data-agent-id="${esc(agent.id)}" title="${follows ? t('Switch to stay on this computer') : t('Switch to follow you')}">${follows ? FOLLOW : PIN}<span>${follows ? t('Follows you') : t('Pinned')}</span></button>`;
  return `<div class="aps-row wh-line"><span>${t`Where it works`}</span><div><small class="wh-place">${esc(place)}</small>${pill}</div></div>`;
}

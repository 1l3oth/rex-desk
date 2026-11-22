import { t, locale } from './i18n.js';
// Devices: the person's computers, each the workspace of its own agents, and their phone. They share the chats over Tailscale
// (and over Turso when every computer uses the same database). A computer that is off only takes its own agents offline.
export const ICON = {
  laptop: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
};
export function devicesStage(ctx) {
  const { ui, esc } = ctx, devices = ui.snap.devices || { self: {}, peers: [] }, self = devices.self || {};
  const agentsOn = node => (ui.snap.specialists || []).filter(agent => (agent.node || self.id) === node).map(agent => agent.name);
  const mine = agentsOn(self.id), address = self.addresses?.[0] || '', on = devices.peers.filter(peer => peer.online).length + 1;
  const toggle = `<label class="dv-switch"><input type="checkbox" data-action="dev-remote" ${devices.remote ? 'checked' : ''}><span class="dv-track" aria-hidden="true"></span><span><b>${t`Let my phone and other computers connect`}</b><small>${t`Only devices on your own Tailscale network can reach it. Nothing is open to the internet.`}</small></span></label>`;
  const here = `<section class="dv-card dv-here">
      <div class="dv-device"><span class="dv-icon">${ICON.laptop}</span><div class="dv-who"><input id="dev-name" class="dv-name" type="text" value="${esc(self.name || '')}" maxlength="40" aria-label="${t`Name of this computer`}" spellcheck="false"><span class="dv-state"><span class="dot good"></span>${t`This computer · on`}</span></div></div>
      <p class="dv-agents">${mine.length ? `<span class="muted">${t`Agents working here`}</span> ${mine.map(name => `<span class="dv-chip">${esc(name)}</span>`).join('')}` : `<span class="muted">${t`No agents work on this computer yet.`}</span>`}</p>
      ${toggle}
      ${devices.remote && !address ? `<p class="dv-warn">${t`Tailscale is not running on this computer. Open Tailscale and sign in; the address shows up here.`}</p>` : ''}
    </section>`;
  const phone = devices.remote && address ? `<section class="dv-card dv-phone">
      <div class="dv-phone-text"><h2>${t`Phone through Tailscale`}</h2>
        <ol class="dv-steps"><li>${t`Turn on the ${'<b>Tailscale</b>'} app on your phone, signed in to the same account.`}</li><li>${t`Scan this code with the phone camera. It opens Rex Desk already signed in.`}</li><li>${t`Add it to your home screen to open it like an app.`}</li></ol>
        <div class="dv-link"><code title="${esc(address)}">${esc(address)}</code><button class="btn small" data-action="dev-copy-link" data-link="${esc(address)}">${t`${ICON.copy} Copy link`}</button></div>
        <p class="muted small">${t`Opening the link instead of scanning? Sign in with the key under Advanced.`}</p></div>
      <img class="dv-qr" src="/api/devices/qr?v=${encodeURIComponent(address)}" alt="${t`QR code that opens Rex Desk on your phone`}" width="220" height="220">
    </section>` : `<section class="dv-card dv-phone off"><span class="dv-icon">${ICON.phone}</span><div><h2>${t`Phone through Tailscale`}</h2><p class="muted">${devices.remote ? t('Waiting for Tailscale on this computer.') : t('Turn on "Let my phone and other computers connect", then scan the code that appears here.')}</p></div></section>`;
  const relay = phoneRelayCard(ctx);
  const row = peer => `<li class="dv-peer"><span class="dv-icon small">${ICON.laptop}</span><div class="dv-who"><b>${esc(peer.name || t('Computer'))}</b><span class="dv-state"><span class="dot ${peer.online ? 'good' : 'off'}"></span>${peer.online ? t('On') : peer.lastSeen ? t`Off · seen ${esc(new Date(peer.lastSeen).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : t('Off')}</span>${agentsOn(peer.id).length ? `<span class="dv-agents small">${agentsOn(peer.id).map(name => `<span class="dv-chip">${esc(name)}</span>`).join('')}</span>` : ''}${peer.error && !peer.online ? `<span class="dv-warn small">${esc(peer.error)}</span>` : ''}</div><button class="ag-x" data-action="dev-remove" data-id="${esc(peer.id)}" title="${t`Forget this computer`}" aria-label="${t`Forget ${esc(peer.name || 'this computer')}`}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></li>`;
  const others = `<section class="dv-card"><h2>${t`My other computers`}</h2>
      ${devices.join?.state === 'other-desk' ? `<p class="dv-warn">${t`Your account already holds another desk, so this computer kept its own and is not linked to your other computers. To link it, sign in on this computer to the desk from your account (Settings, Backup and updates).`}</p>` : devices.join?.state === 'no-plan' ? `<p class="dv-warn">${t`Linking your computers and cloud backup are part of a paid plan. Buy it on rexdesk.app, then sign in again here.`}</p>` : devices.join?.state === 'failed' ? `<p class="dv-warn">${t`This computer could not join your account's shared space: ${esc(devices.join.error || '')}`}</p>` : ''}
      ${devices.peers.length ? `<ul class="dv-peers">${devices.peers.map(row).join('')}</ul>` : `<p class="muted">${t`None yet. Sign in to the same Rex Desk account on your other computer, and it shows here by itself.`}</p>`}
      <div class="dv-line"><input id="dev-url" type="text" placeholder="${t`Address of the other computer, like 100.101.102.103`}" aria-label="${t`Address of another computer`}"><button class="btn primary small" data-action="dev-add">${t`Add`}</button></div>
      <p class="muted small">${t`Same chats everywhere. When a computer is off, its agents show as offline and messages for them wait until it is back.`}</p></section>`;
  const advanced = `<details class="dv-card dv-adv"><summary>${t`Advanced: the device key`}</summary>
      <p class="muted small">${t`All your computers use the same key, and a phone that opens the link signs in with it. Keep it private.`}</p>
      <div class="dv-line"><input id="dev-key" type="password" value="${esc(devices.key || '')}" aria-label="${t`Device key`}" readonly><button class="btn small" data-action="dev-show">${t`Show`}</button><button class="btn small" data-action="dev-copy">${t`Copy`}</button></div>
      <div class="dv-line"><input id="dev-join" type="text" placeholder="${t`Paste the key from your other computer`}" aria-label="${t`Key from another computer`}"><button class="btn small" data-action="dev-join">${t`Join`}</button></div></details>`;
  return { title: t('Devices'), meta: devices.peers.length ? t`${on} of ${devices.peers.length + 1} computers on` : t`${on} of ${devices.peers.length + 1} computer on`, top: true,
    feed: `<div class="page dv"><div class="dv-col">${here}${others}${advanced}</div><div class="dv-col">${relay}${phone}</div></div>` };
}
// A phone that asks to come in through the relay: its code, to check against the one the phone shows, with Deny and Approve.
// Used here and in Needs you.
export function phoneAskHtml(ctx, item) {
  const { esc } = ctx, code = String(item.code || '');
  return `<div class="dv-ask"><div class="dv-ask-text"><b>${t`${esc(item.name)} wants to open your desk`}</b><small>${t`Approve only if the phone shows this same code.`}</small></div><span class="dv-code" aria-label="${t`Code`}">${esc(code.slice(0, 3))} ${esc(code.slice(3))}</span><div class="dv-ask-act"><button class="btn small" data-action="dev-phone-deny" data-device="${esc(item.id)}">${t`Deny`}</button><button class="btn small primary" data-action="dev-phone-approve" data-device="${esc(item.id)}" data-code="${esc(code)}">${t`Approve`}</button></div></div>`;
}
// Through your Rex Desk account: the phone opens the desk from anywhere, with no Tailscale. A new phone needs your OK here.
function phoneRelayCard(ctx) {
  const { esc, ui } = ctx, relay = ui.snap.phones; if (!relay) return '';
  const state = { online: ['good', t('Connected')], connecting: ['warn', t('Connecting')], offline: ['warn', t('Not reachable, trying again')], 'signed-out': ['off', t('Sign in to your Rex Desk account first')], 'not-paid': ['off', t('Your plan does not include this. Upgrade on rexdesk.app.')], replaced: ['off', t('Rex Desk on another computer took over this connection')] }[relay.state];
  const toggle = `<label class="dv-switch"><input type="checkbox" data-action="dev-phone-relay" ${relay.enabled ? 'checked' : ''}><span class="dv-track" aria-hidden="true"></span><span><b>${t`Open my desk from anywhere with my account`}</b><small>${t`Your phone signs in on app.rexdesk.dev, no Tailscale needed. Part of a paid plan.`}</small></span></label>`;
  const status = relay.enabled && state ? `<span class="dv-state"><span class="dot ${state[0]}"></span>${esc(state[1])}</span>` : '';
  const asks = relay.pending.map(item => phoneAskHtml(ctx, item)).join('');
  const when = value => new Date(value).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
  const phones = relay.devices.length ? `<ul class="dv-peers">${relay.devices.map(item => `<li class="dv-peer"><span class="dv-icon small">${ICON.phone}</span><div class="dv-who"><b>${esc(item.name)}</b><span class="dv-state">${t`Approved ${esc(when(item.at))}`}</span></div><button class="ag-x" data-action="dev-phone-forget" data-device="${esc(item.id)}" title="${t`Remove this phone`}" aria-label="${t`Remove ${esc(item.name)}`}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></li>`).join('')}</ul>` : '';
  return `<section class="dv-card dv-relay"><h2>${t`Phone through your account`}</h2>${toggle}${status}${asks}${phones}</section>`;
}
export async function devicesAction(ctx, action, target) {
  const { api, toast, refresh } = ctx, value = id => document.getElementById(id)?.value || '';
  const post = data => api('/peers', { method: 'POST', data });
  if (action === 'dev-rename') { await post({ action: 'rename', name: value('dev-name') }); toast(t('Renamed.')); }
  else if (action === 'dev-remote') await post({ action: 'remote', on: target.checked });
  else if (action === 'dev-show') { const box = document.getElementById('dev-key'); if (box) box.type = box.type === 'password' ? 'text' : 'password'; return; }
  else if (action === 'dev-copy') { await navigator.clipboard.writeText(value('dev-key')); toast(t('Key copied.')); return; }
  else if (action === 'dev-copy-link') { await navigator.clipboard.writeText(target.dataset.link); toast(t('Link copied.')); return; }
  else if (action === 'dev-join') { await post({ action: 'join', key: value('dev-join') }); toast(t('Joined. This computer now uses that key.')); }
  else if (action === 'dev-add') { await post({ action: 'add', url: value('dev-url') }); toast(t('Connected.')); }
  else if (action === 'dev-remove') await post({ action: 'remove', id: target.dataset.id });
  else if (action.startsWith('dev-phone-')) {
    const phone = data => api('/phone-relay', { method: 'POST', data });
    if (action === 'dev-phone-relay') await phone({ action: 'enable', on: target.checked });
    else if (action === 'dev-phone-approve') { await phone({ action: 'approve', device: target.dataset.device, code: target.dataset.code }); toast(t('Phone approved.')); }
    else if (action === 'dev-phone-deny') await phone({ action: 'deny', device: target.dataset.device });
    else if (action === 'dev-phone-forget') await phone({ action: 'forget', device: target.dataset.device });
  }
  await refresh();
}
// The name saves when you leave the field or press Enter.
export function initDevices(ctx) {
  // The "New computer" card in the sidebar.
  document.addEventListener('submit', event => {
    if (!event.target.matches?.('[data-newpc]')) return;
    event.preventDefault();
    const name = event.target.elements.name.value.trim(); if (!name) return;
    void ctx.api('/peers', { method: 'POST', data: { action: 'rename', name } }).then(() => { ctx.toast(t`This computer is now ${name}.`); return ctx.refresh(); }).catch(error => ctx.toast(error.message, true));
  });
  document.addEventListener('keydown', event => { if (event.target.id === 'dev-name' && event.key === 'Enter') { event.preventDefault(); event.target.blur(); } });
  document.addEventListener('focusout', event => {
    if (event.target.id !== 'dev-name') return;
    const now = ctx.ui.snap?.devices?.self?.name || '';
    if (event.target.value.trim() && event.target.value.trim() !== now) void devicesAction(ctx, 'dev-rename', event.target).catch(error => ctx.toast(error.message, true));
  });
}

// Devices: the person's computers, each the workspace of its own agents, and their phone. They share the chats over Tailscale
// (and over Turso when every computer uses the same database). A computer that is off only takes its own agents offline.
const ICON = {
  laptop: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
};
export function devicesStage(ctx) {
  const { ui, esc } = ctx, devices = ui.snap.devices || { self: {}, peers: [] }, self = devices.self || {};
  const agentsOn = node => (ui.snap.specialists || []).filter(agent => (agent.node || self.id) === node).map(agent => agent.name);
  const mine = agentsOn(self.id), address = self.addresses?.[0] || '', on = devices.peers.filter(peer => peer.online).length + 1;
  const toggle = `<label class="dv-switch"><input type="checkbox" data-action="dev-remote" ${devices.remote ? 'checked' : ''}><span class="dv-track" aria-hidden="true"></span><span><b>Let my phone and other computers connect</b><small>Only devices on your own Tailscale network can reach it. Nothing is open to the internet.</small></span></label>`;
  const here = `<section class="dv-card dv-here">
      <div class="dv-device"><span class="dv-icon">${ICON.laptop}</span><div class="dv-who"><input id="dev-name" class="dv-name" type="text" value="${esc(self.name || '')}" maxlength="40" aria-label="Name of this computer" spellcheck="false"><span class="dv-state"><span class="dot good"></span>This computer · on</span></div></div>
      <p class="dv-agents">${mine.length ? `<span class="muted">Agents working here</span> ${mine.map(name => `<span class="dv-chip">${esc(name)}</span>`).join('')}` : '<span class="muted">No agents work on this computer yet.</span>'}</p>
      ${toggle}
      ${devices.remote && !address ? '<p class="dv-warn">Tailscale is not running on this computer. Open Tailscale and sign in; the address shows up here.</p>' : ''}
    </section>`;
  const phone = devices.remote && address ? `<section class="dv-card dv-phone">
      <div class="dv-phone-text"><h2>Open Rex Desk on your phone</h2>
        <ol class="dv-steps"><li>Turn on the <b>Tailscale</b> app on your phone, signed in to the same account.</li><li>Scan this code with the phone camera. It opens Rex Desk already signed in.</li><li>Add it to your home screen to open it like an app.</li></ol>
        <div class="dv-link"><code title="${esc(address)}">${esc(address)}</code><button class="btn small" data-action="dev-copy-link" data-link="${esc(address)}">${ICON.copy} Copy link</button></div>
        <p class="muted small">Opening the link instead of scanning? Sign in with the key under Advanced.</p></div>
      <img class="dv-qr" src="/api/devices/qr?v=${encodeURIComponent(address)}" alt="QR code that opens Rex Desk on your phone" width="220" height="220">
    </section>` : `<section class="dv-card dv-phone off"><span class="dv-icon">${ICON.phone}</span><div><h2>Use Rex Desk on your phone</h2><p class="muted">${devices.remote ? 'Waiting for Tailscale on this computer.' : 'Turn on "Let my phone and other computers connect", then scan the code that appears here.'}</p></div></section>`;
  const row = peer => `<li class="dv-peer"><span class="dv-icon small">${ICON.laptop}</span><div class="dv-who"><b>${esc(peer.name || 'Computer')}</b><span class="dv-state"><span class="dot ${peer.online ? 'good' : 'off'}"></span>${peer.online ? 'On' : `Off${peer.lastSeen ? ` · seen ${esc(new Date(peer.lastSeen).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : ''}`}</span>${agentsOn(peer.id).length ? `<span class="dv-agents small">${agentsOn(peer.id).map(name => `<span class="dv-chip">${esc(name)}</span>`).join('')}</span>` : ''}${peer.error && !peer.online ? `<span class="dv-warn small">${esc(peer.error)}</span>` : ''}</div><button class="ag-x" data-action="dev-remove" data-id="${esc(peer.id)}" title="Forget this computer" aria-label="Forget ${esc(peer.name || 'this computer')}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></li>`;
  const others = `<section class="dv-card"><h2>My other computers</h2>
      ${devices.peers.length ? `<ul class="dv-peers">${devices.peers.map(row).join('')}</ul>` : '<p class="muted">None yet. On your other computer, open Rex Desk → Devices, paste this computer\'s key under Advanced and press Join, then add its address here.</p>'}
      <div class="dv-line"><input id="dev-url" type="text" placeholder="Address of the other computer, like 100.101.102.103" aria-label="Address of another computer"><button class="btn primary small" data-action="dev-add">Add</button></div>
      <p class="muted small">Same chats everywhere. When a computer is off, its agents show as offline and messages for them wait until it is back.</p></section>`;
  const advanced = `<details class="dv-card dv-adv"><summary>Advanced: the device key</summary>
      <p class="muted small">All your computers use the same key, and a phone that opens the link signs in with it. Keep it private.</p>
      <div class="dv-line"><input id="dev-key" type="password" value="${esc(devices.key || '')}" aria-label="Device key" readonly><button class="btn small" data-action="dev-show">Show</button><button class="btn small" data-action="dev-copy">Copy</button></div>
      <div class="dv-line"><input id="dev-join" type="text" placeholder="Paste the key from your other computer" aria-label="Key from another computer"><button class="btn small" data-action="dev-join">Join</button></div></details>`;
  return { title: 'Devices', meta: `${on} of ${devices.peers.length + 1} computer${devices.peers.length ? 's' : ''} on`, top: true,
    feed: `<div class="page dv"><div class="dv-col">${here}${others}${advanced}</div><div class="dv-col">${phone}</div></div>` };
}
export async function devicesAction(ctx, action, target) {
  const { api, toast, refresh } = ctx, value = id => document.getElementById(id)?.value || '';
  const post = data => api('/peers', { method: 'POST', data });
  if (action === 'dev-rename') { await post({ action: 'rename', name: value('dev-name') }); toast('Renamed.'); }
  else if (action === 'dev-remote') await post({ action: 'remote', on: target.checked });
  else if (action === 'dev-show') { const box = document.getElementById('dev-key'); if (box) box.type = box.type === 'password' ? 'text' : 'password'; return; }
  else if (action === 'dev-copy') { await navigator.clipboard.writeText(value('dev-key')); toast('Key copied.'); return; }
  else if (action === 'dev-copy-link') { await navigator.clipboard.writeText(target.dataset.link); toast('Link copied.'); return; }
  else if (action === 'dev-join') { await post({ action: 'join', key: value('dev-join') }); toast('Joined. This computer now uses that key.'); }
  else if (action === 'dev-add') { await post({ action: 'add', url: value('dev-url') }); toast('Connected.'); }
  else if (action === 'dev-remove') await post({ action: 'remove', id: target.dataset.id });
  await refresh();
}
// The name saves when you leave the field or press Enter.
export function initDevices(ctx) {
  document.addEventListener('keydown', event => { if (event.target.id === 'dev-name' && event.key === 'Enter') { event.preventDefault(); event.target.blur(); } });
  document.addEventListener('focusout', event => {
    if (event.target.id !== 'dev-name') return;
    const now = ctx.ui.snap?.devices?.self?.name || '';
    if (event.target.value.trim() && event.target.value.trim() !== now) void devicesAction(ctx, 'dev-rename', event.target).catch(error => ctx.toast(error.message, true));
  });
}

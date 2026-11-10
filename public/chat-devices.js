// Devices: the person's computers, each the workspace of its own agents, and the phone. They share the chats over Tailscale
// (and over Turso when every computer uses the same database). A computer that is off only takes its own agents offline.
export function devicesStage(ctx) {
  const { ui, esc } = ctx, devices = ui.snap.devices || { self: {}, peers: [] }, self = devices.self || {};
  const agentsOn = node => (ui.snap.specialists || []).filter(agent => (agent.node || self.id) === node).map(agent => agent.name);
  const row = peer => `<li class="dev"><span class="sdot ${peer.online ? 'good' : 'off'}"></span><div class="dev-main"><b>${esc(peer.name || 'Computer')}</b><span class="muted small">${peer.online ? 'On' : `Off${peer.lastSeen ? ` · last seen ${esc(new Date(peer.lastSeen).toLocaleString())}` : ''}`} · ${esc(peer.url)}</span>${agentsOn(peer.id).length ? `<span class="small">Agents: ${esc(agentsOn(peer.id).join(', '))}</span>` : ''}${peer.error && !peer.online ? `<span class="small warn-text">${esc(peer.error)}</span>` : ''}</div><button class="btn small x" data-action="dev-remove" data-id="${esc(peer.id)}" title="Forget this computer">×</button></li>`;
  const mine = agentsOn(self.id);
  return { title: 'Devices', meta: `${devices.peers.filter(peer => peer.online).length + 1} of ${devices.peers.length + 1} computers on`, feed: `<div class="page devices">
    <div class="card"><h3>This computer</h3>
      <div class="dev-line"><input id="dev-name" type="text" value="${esc(self.name || '')}" maxlength="40" aria-label="Name of this computer"><button class="btn small" data-action="dev-rename">Rename</button></div>
      <p class="muted small">${mine.length ? `Agents working here: ${esc(mine.join(', '))}.` : 'No agents work on this computer yet.'} Each agent works on the computer that has its project.</p>
      <label class="dev-toggle"><input type="checkbox" data-action="dev-remote" ${devices.remote ? 'checked' : ''}> Let my other computers and my phone connect</label>
      ${devices.remote ? (self.addresses?.length ? `<p class="small">Address: ${self.addresses.map(address => `<code>${esc(address)}</code>`).join(' ')}</p>` : '<p class="small warn-text">Tailscale is not running on this computer. Install it and sign in, then this address appears.</p>') : ''}
    </div>
    <div class="card"><h3>Key</h3>
      <p class="muted small">All your computers use the same key. Copy it from your first computer and press Join on the others. Your phone signs in with it too.</p>
      <div class="dev-line"><input id="dev-key" type="password" value="${esc(devices.key || '')}" aria-label="Device key"><button class="btn small" data-action="dev-show">Show</button><button class="btn small" data-action="dev-copy">Copy</button></div>
      <div class="dev-line"><input id="dev-join" type="text" placeholder="Paste the key from your other computer" aria-label="Key from another computer"><button class="btn small" data-action="dev-join">Join</button></div>
    </div>
    <div class="card"><h3>My other computers</h3>
      ${devices.peers.length ? `<ul class="devlist">${devices.peers.map(row).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
      <div class="dev-line"><input id="dev-url" type="text" placeholder="Address of the other computer, like 100.101.102.103" aria-label="Address of another computer"><button class="btn primary small" data-action="dev-add">Add</button></div>
      <p class="muted small">Same chats everywhere. When a computer is off, its agents show as offline and messages for them wait until it is back. With the same Turso database on every computer (Issues &amp; settings, Cloud backup), the chats also arrive while the other computer is off.</p>
    </div>
    <div class="card"><h3>Phone</h3><p class="muted small">Install Tailscale on the phone with the same account, open one of the addresses above in its browser, and sign in with the key.</p></div>
  </div>` };
}
export async function devicesAction(ctx, action, target) {
  const { api, toast, refresh } = ctx, value = id => document.getElementById(id)?.value || '';
  const post = data => api('/peers', { method: 'POST', data });
  if (action === 'dev-rename') { await post({ action: 'rename', name: value('dev-name') }); toast('Renamed.'); }
  else if (action === 'dev-remote') await post({ action: 'remote', on: target.checked });
  else if (action === 'dev-show') { const box = document.getElementById('dev-key'); if (box) box.type = box.type === 'password' ? 'text' : 'password'; return; }
  else if (action === 'dev-copy') { await navigator.clipboard.writeText(value('dev-key')); toast('Key copied.'); return; }
  else if (action === 'dev-join') { await post({ action: 'join', key: value('dev-join') }); toast('Joined. This computer now uses that key.'); }
  else if (action === 'dev-add') { await post({ action: 'add', url: value('dev-url') }); toast('Connected.'); }
  else if (action === 'dev-remove') await post({ action: 'remove', id: target.dataset.id });
  await refresh();
}

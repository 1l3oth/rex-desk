// The welcome tour's "Choose your AI" step: every AI Rex Desk can run agents on, as one list. Each row says in plain
// words what it needs, whether it is ready on this computer, and has one button to get it ready. Picking a ready row
// makes it the AI for new agents. Used only inside the tour (chat-tour.js).
const AIS = [
  { id: 'claude', name: 'Claude Code', mark: 'C', needs: 'Needs a Claude plan (Pro or Max).', best: 'Best for most people', service: 'Claude' },
  { id: 'codex', name: 'Codex', mark: 'O', needs: 'Needs a ChatGPT plan (Plus or Pro).', service: 'ChatGPT' },
  { id: 'gemini', name: 'Gemini', mark: 'G', needs: 'Needs a Google account.', service: 'Google' },
  { id: 'local', name: 'Local AI', mark: '', needs: 'Free and private. Runs on this computer, slower than the others.' },
];
const CHIP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>';
const TICK = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5"/></svg>';

export async function loadTourAi({ ui, api }, state, refreshStatus = true) {
  const [accounts, local] = await Promise.all([api(`/agents${refreshStatus ? '?refresh=1' : ''}`).catch(() => null), api('/local-ai').catch(() => null)]);
  if (accounts) ui.accounts = accounts;
  state.ai = { loaded: true, local };
}

// What one AI looks like right now: ready or not, and who is signed in.
function statusOf(ui, state, ai) {
  if (ai.id === 'local') {
    const servers = state.ai?.local?.servers || [], ollama = servers.find(item => item.id === 'ollama');
    const models = servers.filter(item => item.running).flatMap(item => item.models || []).filter(model => model.tools).length;
    if (models) return { ready: true, text: `${models} model${models === 1 ? '' : 's'} ready` };
    return { ready: false, text: ollama?.running ? 'Ollama is running. Download a model to use it.' : 'Not set up yet' };
  }
  const list = ui.accounts?.[ai.id], current = list?.profiles?.find(item => item.profile === list.selected && item.loggedIn) || list?.profiles?.find(item => item.loggedIn);
  return current ? { ready: true, text: `Signed in${current.account ? ` as ${current.account}` : ''}` } : { ready: false, text: 'Not signed in yet' };
}

export function tourAiHtml({ ui, esc }, state) {
  if (!state.ai?.loaded) return '<h2>Choose your AI</h2><p>Checking which AI is ready on this computer…</p>';
  const chosen = ui.snap.config?.provider || 'claude', anyReady = AIS.some(ai => statusOf(ui, state, ai).ready);
  const row = ai => {
    const status = statusOf(ui, state, ai), picked = ai.id === chosen && status.ready, waiting = state.aiWaiting === ai.id;
    const action = waiting ? '<span class="tai-wait"><span class="dot working"></span>Finish in the window that opened</span>'
      : ai.id === 'local' ? `<button type="button" class="btn small" data-tai-local>${status.ready ? 'Manage' : 'Set up'}</button>`
      : status.ready ? (picked ? '' : `<button type="button" class="btn small" data-tai-use="${ai.id}">Use this</button>`)
      : `<button type="button" class="btn small primary" data-tai-login="${ai.id}">Sign in</button>`;
    return `<li class="tai-row${picked ? ' on' : ''}">
      <span class="tai-mark tai-${ai.id}" aria-hidden="true">${ai.mark || CHIP}</span>
      <span class="tai-text"><b>${esc(ai.name)}${ai.best ? `<span class="tai-best">${esc(ai.best)}</span>` : ''}</b><small>${esc(ai.needs)}</small>
        <small class="tai-status${status.ready ? ' good' : ''}">${status.ready ? TICK : ''}${esc(status.text)}${picked ? '. Your agents use this one.' : ''}</small></span>
      <span class="tai-action">${action}</span></li>`;
  };
  return `<h2>Choose your AI</h2><p>Your agents need an AI to think with. Pick one you already pay for, or the free one. You can add more later in Settings.</p>
    <ul class="tai-list">${AIS.map(row).join('')}</ul>
    ${anyReady ? '' : '<p class="muted">No AI is ready yet. Press Sign in on one: a window opens, installs what is needed, and opens the sign-in in your browser.</p>'}`;
}

// Returns true when the click belonged to this step.
export async function tourAiClick(ctx, state, target, draw) {
  const { ui, api, toast, refresh } = ctx;
  const use = target.closest('[data-tai-use]');
  if (use) {
    ui.snap.config = await api('/config', { method: 'PUT', data: { ...ui.snap.config, provider: use.dataset.taiUse } }); void refresh();
    toast(`Your agents will use ${AIS.find(ai => ai.id === use.dataset.taiUse).name}.`); draw(); return true;
  }
  if (target.closest('[data-tai-local]')) { ctx.openSettings?.('localai'); return true; }
  const login = target.closest('[data-tai-login]');
  if (!login) return false;
  const id = login.dataset.taiLogin, ai = AIS.find(item => item.id === id), ready = () => statusOf(ui, state, ai).ready;
  const profile = ui.accounts?.[id]?.profiles?.[0]?.profile || '';
  const started = await api('/agents/login', { method: 'POST', data: { provider: id, profile } });
  toast(started?.installing ? `A window opened. It installs ${ai.name} first, then opens the ${ai.service} sign-in.` : `A window opened for the ${ai.service} sign-in.`);
  state.aiWaiting = id; draw();
  // The sign-in happens in the browser: look again every few seconds, for up to three minutes (ten while it installs).
  for (let tries = 0; tries < (started?.installing ? 200 : 60) && state.aiWaiting === id && document.querySelector('.tour-back'); tries++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    await loadTourAi(ctx, state);
    if (ready()) {
      state.aiWaiting = '';
      // The first AI that gets ready becomes the one agents use.
      const others = AIS.filter(item => item.id !== id && item.id !== 'local').some(item => statusOf(ui, state, item).ready);
      if (!others && ui.snap.config?.provider !== id) { ui.snap.config = await api('/config', { method: 'PUT', data: { ...ui.snap.config, provider: id } }); void refresh(); }
      toast(`Signed in. ${ai.name} is ready.`);
    }
    draw();
  }
  if (state.aiWaiting === id) { state.aiWaiting = ''; draw(); }
  return true;
}

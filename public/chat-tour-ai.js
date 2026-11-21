import { t } from './i18n.js';
import { skeletonHtml } from './chat-skeleton.js';
// "Choose your AI", in the welcome tour and in Settings, AI accounts: every AI Rex Desk can run agents on, as one list. Each row says in plain
// words what it needs, whether it is ready on this computer, and has one button to get it ready. Picking a ready row
// makes it the AI for new agents.
import { aiLogo } from '/ai-logos.js';
const AIS = [
  { id: 'claude', name: t('Claude Code'), needs: t('Needs a Claude plan (Pro or Max).'), best: t('Best for most people'), service: t('Claude') },
  { id: 'codex', name: t('Codex'), needs: t('Needs a ChatGPT plan (Plus or Pro).'), service: 'ChatGPT' },
  { id: 'gemini', name: t('Gemini'), needs: t('Needs a Google account.'), service: t('Google') },
  { id: 'local', name: t('Local AI'), needs: t('Free and private. Runs on this computer with Ollama, slower than the others.') },
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
    if (models) return { ready: true, text: models === 1 ? t`${models} model ready` : t`${models} models ready` };
    // Set up is working: say which step it is on, and how far a download is.
    const job = (state.ai?.local?.pulls || []).find(item => item.setup);
    if (job?.state === 'downloading') return { ready: false, busy: true, text: `${job.status}${job.total ? `: ${Math.floor((job.completed / job.total) * 100)}%` : ''}…` };
    if (job?.state === 'failed') return { ready: false, failed: true, text: job.error };
    return { ready: false, text: ollama?.running ? t('Ollama is here, but it has no model yet.') : t('Not on this computer yet. Set up installs it for you.') };
  }
  const list = ui.accounts?.[ai.id], current = list?.profiles?.find(item => item.profile === list.selected && item.loggedIn) || list?.profiles?.find(item => item.loggedIn);
  if (current) return { ready: true, text: current.account ? t`Signed in as ${current.account}` : t('Signed in') };
  // Not on this computer at all: one button installs it and then opens the sign-in.
  const installed = (list?.profiles || []).some(item => item.installed !== false) && Boolean(list?.profiles?.length);
  return installed ? { ready: false, text: t('On this computer, not signed in yet') } : { ready: false, missing: true, text: t('Not on this computer yet. Set up installs it, then you sign in.') };
}

export function tourAiHtml(ctx, state) {
  if (!state.ai?.loaded) return `<h2>${t`Choose your AI`}</h2><p>${t`Checking which AI is ready on this computer…`}</p>`;
  return `<h2>${t`Choose your AI`}</h2><p>${t`Your agents need an AI to think with. Pick one you already pay for, or the free one. You can add more later in Settings.`}</p>${aiListHtml(ctx, state)}`;
}
// The list itself: one row per AI.
export function aiListHtml({ ui, esc }, state) {
  if (!state.ai?.loaded) return skeletonHtml(3);
  const chosen = ui.snap.config?.provider || 'claude', anyReady = AIS.some(ai => statusOf(ui, state, ai).ready);
  const row = ai => {
    const status = statusOf(ui, state, ai), picked = ai.id === chosen && status.ready, waiting = state.aiWaiting === ai.id;
    const action = waiting ? `<span class="tai-wait"><span class="dot working"></span>${t`Finish in the window that opened`}</span>`
      : ai.id === 'local' ? (status.busy ? `<span class="tai-wait"><span class="dot working"></span>${t`Setting up`}</span>` : status.ready ? `<button type="button" class="btn small" data-tai-local>${t`Manage`}</button>` : `<button type="button" class="btn small primary" data-tai-setup>${status.failed ? t('Try again') : t('Set up')}</button>`)
      : status.ready ? (picked ? '' : `<button type="button" class="btn small" data-tai-use="${ai.id}">${t`Use this`}</button>`)
      : `<button type="button" class="btn small primary" data-tai-login="${ai.id}">${status.missing ? t('Set up') : t('Sign in')}</button>`;
    return `<li class="tai-row${picked ? ' on' : ''}">
      <span class="tai-mark" aria-hidden="true">${aiLogo(ai.id === 'local' ? 'ollama' : ai.id, 24) || CHIP}</span>
      <span class="tai-text"><b>${esc(ai.name)}${ai.best ? `<span class="tai-best">${esc(ai.best)}</span>` : ''}</b><small>${esc(ai.needs)}</small>
        <small class="tai-status${status.ready ? ' good' : status.failed ? ' bad' : ''}">${status.ready ? TICK : ''}${esc(status.text)}${picked ? '. Your agents use this one.' : ''}</small></span>
      <span class="tai-action">${action}</span></li>`;
  };
  return `<ul class="tai-list">${AIS.map(row).join('')}</ul>
    ${anyReady ? '' : `<p class="muted">${t`Nothing to install yourself. Press Set up or Sign in on one: Rex Desk installs what is missing, then opens the sign-in in your browser.`}</p>`}`;
}

// Returns true when the click belonged to this step.
export async function tourAiClick(ctx, state, target, draw, alive = () => Boolean(document.querySelector('.tour-back'))) {
  const { ui, api, toast, refresh } = ctx;
  const use = target.closest('[data-tai-use]');
  if (use) {
    ui.snap.config = await api('/config', { method: 'PUT', data: { ...ui.snap.config, provider: use.dataset.taiUse } }); void refresh();
    toast(t`Your agents will use ${AIS.find(ai => ai.id === use.dataset.taiUse).name}.`); draw(); return true;
  }
  if (target.closest('[data-tai-local]')) { ctx.openSettings?.('localai'); return true; }
  if (target.closest('[data-tai-setup]')) {
    await api('/local-ai/setup', { method: 'POST', data: {} });
    await loadTourAi(ctx, state, false); draw();
    // Follow the steps (install, start, download) until it is ready or stops with a reason.
    while (alive()) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await loadTourAi(ctx, state, false);
      const job = (state.ai?.local?.pulls || []).find(item => item.setup);
      draw();
      if (!job || job.state !== 'downloading') { if (job?.state === 'done') toast(t('Local AI is ready. Pick its model in the model list of an agent.')); break; }
    }
    return true;
  }
  const login = target.closest('[data-tai-login]');
  if (!login) return false;
  const id = login.dataset.taiLogin, ai = AIS.find(item => item.id === id), ready = () => statusOf(ui, state, ai).ready;
  const profile = ui.accounts?.[id]?.profiles?.[0]?.profile || '';
  const started = await api('/agents/login', { method: 'POST', data: { provider: id, profile } });
  toast(started?.installing ? t`A window opened. It installs ${ai.name} first, then opens the ${ai.service} sign-in.` : t`A window opened for the ${ai.service} sign-in.`);
  state.aiWaiting = id; draw();
  // The sign-in happens in the browser: look again every few seconds, for up to three minutes (ten while it installs).
  for (let tries = 0; tries < (started?.installing ? 200 : 60) && state.aiWaiting === id && alive(); tries++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    await loadTourAi(ctx, state);
    if (ready()) {
      state.aiWaiting = '';
      // The first AI that gets ready becomes the one agents use.
      const others = AIS.filter(item => item.id !== id && item.id !== 'local').some(item => statusOf(ui, state, item).ready);
      if (!others && ui.snap.config?.provider !== id) { ui.snap.config = await api('/config', { method: 'PUT', data: { ...ui.snap.config, provider: id } }); void refresh(); }
      toast(t`Signed in. ${ai.name} is ready.`);
    }
    draw();
  }
  if (state.aiWaiting === id) { state.aiWaiting = ''; draw(); }
  return true;
}

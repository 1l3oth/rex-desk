import { t } from './i18n.js';
import { aiLogo } from '/ai-logos.js';
// "Connect your AI": the last step of the first-run tour, and a gate. Nothing else opens until one AI is signed in. Three
// steps, each with a short looping picture: pick the AI you pay for, sign in (Rex Desk installs it and runs the sign-in
// hidden, so no terminal ever shows), done (a green tick, then Rex Agent opens).
const AIS = [
  { id: 'codex', label: t('I use ChatGPT'), service: 'ChatGPT', plan: t('ChatGPT Plus or Pro'), plans: 'https://chatgpt.com/pricing' },
  { id: 'claude', label: t('I use Claude'), service: 'Claude', plan: t('Claude Pro or Max'), plans: 'https://claude.com/pricing' },
  { id: 'gemini', label: t('I use Gemini'), service: 'Gemini', plan: t('A Google account'), plans: 'https://gemini.google/subscriptions/' },
  // OpenRouter has no sign-in: its API key is typed here, checked with OpenRouter, and kept encrypted on this computer.
  { id: 'openrouter', label: t('I use OpenRouter'), service: 'OpenRouter', plan: t('An OpenRouter API key'), plans: 'https://openrouter.ai/settings/keys', key: true },
  // Ollama needs no plan or sign-in: Set up installs it, starts it and downloads a first model, then agents think with it.
  { id: 'local', logo: 'ollama', label: t('I use Ollama'), service: 'Ollama', plan: t('Free, runs on this computer'), plans: 'https://ollama.com/download', local: true },
];
const TICK = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5"/></svg>';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Is this AI signed in on this computer, and as whom.
export function aiReady(ui, id) {
  const list = ui.accounts?.[id];
  return list?.profiles?.find(item => item.profile === list.selected && item.loggedIn) || list?.profiles?.find(item => item.loggedIn) || null;
}
// The first local model that can use tools, on a running server: Ollama is ready when it has one.
export function localReady(state) {
  for (const server of state.ai?.local?.servers || []) { const model = server.running && (server.models || []).find(item => item.tools); if (model) return { server: server.id, model: model.name }; }
  return null;
}
const ready = (ui, state, ai) => ai.local ? localReady(state) : aiReady(ui, ai.id);
const setupJob = state => (state.ai?.local?.pulls || []).find(item => item.setup) || null;
export const anyAiReady = (ui, state = {}) => AIS.some(ai => ready(ui, state, ai));

// The looping pictures, one per step. Plain shapes in the accent colour; they move only when the person allows motion.
function clip(step, ai) {
  const logo = ai ? aiLogo(ai.logo || ai.id, 18).replace('<svg ', '<svg x="51" y="17" ') : '';
  const pictures = {
    pick: `<rect x="8" y="22" width="34" height="40" rx="6" class="fr-l"/><rect x="47" y="22" width="34" height="40" rx="6" class="fr-l fr-pickme"/><rect x="86" y="22" width="34" height="40" rx="6" class="fr-l"/>
      <circle cx="25" cy="36" r="6" class="fr-f"/><circle cx="64" cy="36" r="6" class="fr-f"/><circle cx="103" cy="36" r="6" class="fr-f"/>
      <path d="M17 50h16M56 50h16M95 50h16" class="fr-l"/><path class="fr-cursor" d="M0 0l0 14 4-4 3 7 3-1-3-7 6 0z"/>`,
    signin: `<rect x="10" y="6" width="108" height="72" rx="6" class="fr-l"/><path d="M10 16h108" class="fr-l"/><circle cx="17" cy="11" r="1.6" class="fr-dot"/><circle cx="23" cy="11" r="1.6" class="fr-dot"/><circle cx="29" cy="11" r="1.6" class="fr-dot"/>
      <rect x="38" y="8.5" width="62" height="5" rx="2.5" class="fr-bar"/>${logo || '<circle cx="60" cy="26" r="7" class="fr-f"/>'}
      <rect x="38" y="40" width="52" height="8" rx="3" class="fr-l"/><rect x="38" y="53" width="52" height="9" rx="3" class="fr-btn"/><path class="fr-cursor fr-cursor2" d="M0 0l0 14 4-4 3 7 3-1-3-7 6 0z"/>`,
    done: `<circle cx="64" cy="42" r="26" class="fr-ok"/><path d="M52 42l8 8 16-16" class="fr-tick"/>`,
  };
  return `<svg class="fr-clip fr-clip-${step}" viewBox="0 0 128 84" aria-hidden="true">${pictures[step]}</svg>`;
}

// Some sign-ins end with a code on the browser page instead of coming back by themselves: the hidden sign-in asks for it, and
// this one field sends it there. It shows once the sign-in may ask for it, under the waiting line, so a sign-in that comes
// back by itself just finishes. A code the AI turned down says so, with Start again. A paste the AI could not take (part of the
// code, a web address) or one with no answer for a while brings the field back for the same sign-in, with a plain line.
const CODE_FAILED = 'The code may be wrong or too old. Start again to get a new code.';
function codeBox(job) {
  if (job.state !== 'signing-in' || !(job.codeAsked || job.url) || (job.codeSent && !job.codeError)) return '';
  const problem = job.sendError || job.codeProblem;
  return `${job.codeError ? `<div class="fr-error" role="alert"><b>${t`That code did not work`}</b><span>${t(CODE_FAILED)}</span></div>` : problem ? `<div class="fr-error" role="alert"><b>${t`Paste the code again`}</b><span>${t(problem)}</span></div>` : ''}
    <form class="fr-code" data-fr-codeform><label class="fr-code-label" for="fr-code">${t`Paste the code here`}</label>
    <div class="fr-key"><input id="fr-code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="2000" required><button type="submit" class="btn primary">${t`Send`}</button></div>
    <p class="fr-hint">${t`If the browser page shows a code, copy it and paste it here.`}</p></form>`;
}

export function firstRunHtml({ ui, esc }, state) {
  const fr = state.fr ||= { step: 'pick', ai: '', job: null, plans: false };
  const ai = AIS.find(item => item.id === fr.ai);
  const steps = [['pick', t('Pick your AI')], ['signin', t('Sign in')], ['done', t('Done')]], at = steps.findIndex(([id]) => id === fr.step);
  const bar = `<ol class="fr-steps">${steps.map(([id, label], index) => `<li class="${index === at ? 'on' : index < at ? 'past' : ''}"><span>${index < at ? TICK : index + 1}</span>${esc(label)}</li>`).join('')}</ol>`;
  let body = '';
  if (fr.step === 'pick') {
    const card = item => {
      const on = state.ai?.loaded && ready(ui, state, item);
      return `<button type="button" class="fr-card" data-fr-pick="${item.id}"><span class="fr-mark">${aiLogo(item.logo || item.id, 26)}</span><b>${esc(item.label)}</b><small>${on ? `<span class="fr-good">${TICK}${t`Ready on this computer`}</span>` : esc(item.plan)}</small></button>`;
    };
    // An AI that is already signed in here needs no step: one button carries on with it (the chosen one first).
    const have = state.ai?.loaded && [AIS.find(item => item.id === ui.snap.config?.provider), ...AIS].find(item => item && ready(ui, state, item));
    const go = have ? `<div class="fr-actions"><button type="button" class="btn primary" data-fr-pick="${have.id}">${t`Continue with ${have.service}`}</button></div>` : '';
    body = `<p>${have ? t`${have.service} is ready on this computer. Carry on with it, or pick another AI.` : t`Your agents think with the AI plan you already pay for. Which one do you use?`}</p>${go}<div class="fr-cards">${AIS.map(card).join('')}</div>
      <p class="fr-plans"><button type="button" class="linkish" data-fr-plans>${t`Don't have one? See plans`}</button>${fr.plans ? `<span>${AIS.map(item => `<a href="${item.plans}" target="_blank" rel="noopener">${esc(item.service)}</a>`).join('')}</span>` : ''}</p>`;
  } else if (fr.step === 'signin' && ai.local) {
    const job = setupJob(state), busy = job?.state === 'downloading' || fr.job?.state === 'starting', failed = job?.state === 'failed' || fr.job?.state === 'failed';
    const status = busy ? `<p class="fr-wait" role="status"><span class="dot working"></span>${job ? esc(`${job.status}${job.total ? `: ${Math.floor((job.completed / job.total) * 100)}%` : ''}…`) : t('Starting…')}</p>`
      : failed ? `<div class="fr-error" role="alert"><b>${t`That did not work`}</b><span>${esc(fr.job?.error || job?.error || '')}</span></div>`
      : `<p class="muted">${t`Rex Desk installs Ollama, starts it and downloads a first model that fits this computer. It is free and private, but slower than the paid AIs.`}</p>`;
    const action = busy ? '' : `<button type="button" class="btn primary" data-fr-local>${failed ? t('Try again') : t('Set up Ollama')}</button>`;
    body = `<p class="fr-lead">${t`Set up Ollama`}</p>${status}<div class="fr-actions">${action}</div>
      <p class="fr-plans"><button type="button" class="linkish" data-fr-back>${t`Pick another AI`}</button><a href="${ai.plans}" target="_blank" rel="noopener">${t`About Ollama`}</a></p>`;
  } else if (fr.step === 'signin' && ai.key) {
    body = `<p class="fr-lead">${t`Add your OpenRouter key`}</p><p class="muted">${t`Rex Desk checks the key with OpenRouter and keeps it encrypted on this computer. It is never shown in a chat.`}</p>
      <form class="fr-key" data-fr-keyform><input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="sk-or-v1-…" aria-label="${t`OpenRouter API key`}" required>
      <button type="submit" class="btn primary" ${fr.job?.state === 'starting' ? 'disabled' : ''}>${fr.job?.state === 'starting' ? t`Checking…` : t`Check and save`}</button></form>
      ${fr.job?.state === 'failed' ? `<div class="fr-error" role="alert"><b>${t`That did not work`}</b><span>${esc(fr.job.error || '')}</span></div>` : ''}
      <p class="fr-plans"><button type="button" class="linkish" data-fr-back>${t`Pick another AI`}</button><a href="${ai.plans}" target="_blank" rel="noopener">${t`Get a key on OpenRouter`}</a></p>`;
  } else if (fr.step === 'signin') {
    const job = fr.job, busy = job && ['starting', 'installing', 'signing-in', 'finished'].includes(job.state);
    const status = !job ? `<p class="muted">${t`Rex Desk sets it up for you. Your browser opens the ${ai.service} sign-in; sign in with the account that has your plan, then come back here.`}</p>`
      : job.state === 'failed' ? `<div class="fr-error" role="alert"><b>${job.codeSent ? t('That code did not work') : t('That did not work')}</b><span>${esc(job.codeSent ? t(CODE_FAILED) : job.error || t('The sign-in stopped.'))}</span></div>`
      : `<p class="fr-wait" role="status"><span class="dot working"></span>${job.state === 'installing' ? t`Getting ${ai.service} ready on this computer. This can take a minute…` : job.checking ? t('Checking this computer…') : job.state === 'starting' ? t('Starting…') : job.codeSent && !job.codeError ? t('Checking the code…') : t`Waiting for you to sign in in your browser…`}</p>
        ${job.url ? `<p class="fr-hint">${t`Browser did not open?`} <a href="${esc(job.url)}" target="_blank" rel="noopener">${t`Open the sign-in page`}</a></p>` : ''}${ai.id === 'claude' && job.state === 'signing-in' ? `<p class="fr-hint">${t`If the page says Too soon, wait a few seconds and press Authorize again.`}</p>` : ''}${codeBox(job)}`;
    const action = job?.state === 'failed' ? `<button type="button" class="btn primary" data-fr-login>${job.codeSent ? t('Start again') : t('Try again')}</button><button type="button" class="btn quiet" data-fr-window>${t`Sign in with a window instead`}</button>`
      : busy ? `${job.codeError ? `<button type="button" class="btn primary" data-fr-login>${t`Start again`}</button>` : ''}<button type="button" class="btn quiet" data-fr-cancel>${t`Cancel`}</button>` : `<button type="button" class="btn primary" data-fr-login>${t`Sign in with ${ai.service}`}</button>`;
    body = `<p class="fr-lead">${t`Sign in to ${ai.service}`}</p>${status}<div class="fr-actions">${action}</div>
      <p class="fr-plans"><button type="button" class="linkish" data-fr-back>${t`Pick another AI`}</button><a href="${ai.plans}" target="_blank" rel="noopener">${t`See ${ai.service} plans`}</a></p>`;
  } else {
    const who = ai.key ? '' : ai.local ? localReady(state)?.model : aiReady(ui, ai.id)?.account;
    body = `<p class="fr-lead fr-good">${TICK}${t`${ai.service} is connected`}</p><p class="muted">${who ? (ai.local ? t`Model: ${esc(who)}. ` : t`Signed in as ${esc(who)}. `) : ''}${t`Opening Rex Agent…`}</p>
      <div class="fr-actions"><button type="button" class="btn primary" data-fr-finish>${t`Open Rex Agent`}</button></div>`;
  }
  return `<div class="fr"><h2>${t`Connect your AI`}</h2>${bar}<div class="fr-pane">${clip(fr.step, ai)}<div class="fr-main">${body}</div></div></div>`;
}

// The OpenRouter key form: checked by the server with OpenRouter, saved only when it works. The key never stays in the page.
export async function firstRunSubmit(ctx, state, form, draw, { load, finish }) {
  const fr = state.fr; if (!fr) return false;
  if (form.matches('[data-fr-codeform]')) {
    // The code goes to the waiting sign-in; the look every few seconds (follow) then sees it finish or turn the code down.
    // A tab or line break picked up with the paste goes; a code has none.
    const input = form.querySelector('input[name=code]'), code = input.value.replace(/[\t\r\n]+/g, '').trim(); input.value = '';
    if (!code || !fr.job) return true;
    try { fr.job = { ...fr.job, ...(await ctx.api('/agents/login/code', { method: 'POST', data: { provider: fr.ai, code } })), sendError: '' }; }
    catch (error) { fr.job = { ...fr.job, codeSent: false, sendError: error.message }; }
    fr.shown = ''; draw(); return true;
  }
  if (!form.matches('[data-fr-keyform]')) return false;
  const input = form.querySelector('input[name=key]'), key = input.value.trim(); input.value = '';
  if (!key) return true;
  fr.job = { state: 'starting' }; draw();
  try { await ctx.api('/agents/openrouter-key', { method: 'POST', data: { key } }); await load(); fr.job = null; fr.step = 'done'; draw(); await connected(ctx, state, draw, finish); }
  catch (error) { fr.job = { state: 'failed', error: error.message }; draw(); }
  return true;
}

// Clicks on the connect screen. Returns true when the click was its own. finish() closes the tour and opens Rex Agent.
export async function firstRunClick(ctx, state, target, draw, { load, finish, alive }) {
  const { ui, api } = ctx, fr = state.fr;
  if (!fr) return false;
  if (target.closest('[data-fr-plans]')) { fr.plans = !fr.plans; draw(); return true; }
  const pick = target.closest('[data-fr-pick]');
  if (pick) {
    // Picked (again): the accounts are looked at anew, never an old answer or a sign-in that failed before.
    cancel(fr, api); const token = fr.token; fr.ai = pick.dataset.frPick; fr.job = { state: 'starting', url: '', checking: true }; fr.step = 'signin'; draw();
    await load().catch(() => {}); if (!alive() || fr.token !== token) return true;
    fr.job = null; fr.step = ready(ui, state, AIS.find(item => item.id === fr.ai)) ? 'done' : 'signin'; draw();
    if (fr.step === 'done') await connected(ctx, state, draw, finish);
    return true;
  }
  if (target.closest('[data-fr-back]')) { cancel(fr, api); fr.step = 'pick'; draw(); return true; }
  if (target.closest('[data-fr-cancel]')) { cancel(fr, api); draw(); return true; }
  if (target.closest('[data-fr-finish]')) { await finish(); return true; }
  if (target.closest('[data-fr-local]')) {
    fr.job = { state: 'starting' }; draw();
    try { await api('/local-ai/setup', { method: 'POST', data: {} }); fr.job = null; } catch (error) { fr.job = { state: 'failed', error: error.message }; draw(); return true; }
    // Follow the steps (install, start, download) until a model is ready or the setup stops with a reason.
    const token = fr.token = (fr.token || 0) + 1, still = () => alive() && fr.token === token && fr.ai === 'local' && fr.step === 'signin';
    await load(); draw();
    for (let tries = 0; tries < 1800 && still(); tries++) {
      await sleep(2000); if (!still()) return true;
      await load(); if (!still()) return true;
      if (localReady(state)) { fr.step = 'done'; draw(); await connected(ctx, state, draw, finish); return true; }
      draw();
      if (setupJob(state)?.state !== 'downloading') return true;
    }
    return true;
  }
  if (target.closest('[data-fr-window]')) {
    // The old way, for a computer where the hidden sign-in keeps failing: a window the person can see and type in.
    await api('/agents/login', { method: 'POST', data: { provider: fr.ai, profile: '' } });
    fr.job = { state: 'signing-in', url: '' }; draw(); await follow(ctx, state, draw, { load, finish, alive, hidden: false });
    return true;
  }
  if (!target.closest('[data-fr-login]')) return false;
  fr.job = { state: 'starting', url: '' }; draw();
  try {
    const profile = ui.accounts?.[fr.ai]?.profiles?.[0]?.profile || '';
    const started = await api('/agents/login', { method: 'POST', data: { provider: fr.ai, profile, background: true } });
    fr.job = { state: started.installing ? 'installing' : 'signing-in', url: '', error: started.error || '' };
    if (started.started === false) fr.job.state = 'failed';
  } catch (error) { fr.job = { state: 'failed', error: error.message }; }
  draw();
  if (fr.job.state !== 'failed') await follow(ctx, state, draw, { load, finish, alive, hidden: true });
  return true;
}
// A reload (or the app closed and opened again) forgets the screen, but the hidden sign-in on the server keeps waiting: ask the
// server for one still running and go straight back to its waiting screen, with the paste field. Never starts a sign-in.
export async function firstRunResume(ctx, state, draw, { load, finish, alive, show }) {
  for (const item of AIS.filter(ai => !ai.key && !ai.local)) {
    const job = await ctx.api(`/agents/login?provider=${item.id}`).catch(() => null);
    if (!job || !['installing', 'signing-in'].includes(job.state) || !alive() || state.fr?.job) continue;
    state.fr = { ...(state.fr || {}), step: 'signin', ai: item.id, plans: false, job: { ...job, sendError: '' } };
    show(); draw();
    void load().catch(() => {});
    await follow(ctx, state, draw, { load, finish, alive, hidden: true });
    return true;
  }
  return false;
}
// Stops following, and stops the hidden sign-in on the server with everything it started (no program is left waiting).
function cancel(fr, api) {
  if (api && fr.ai && fr.job && !fr.job.checking) void api('/agents/login/cancel', { method: 'POST', data: { provider: fr.ai } }).catch(() => {});
  fr.job = null; fr.token = (fr.token || 0) + 1;
}

// Looks every few seconds until the AI is signed in, the hidden sign-in fails, or the person cancels.
async function follow(ctx, state, draw, { load, finish, alive, hidden }) {
  const { api } = ctx, fr = state.fr, token = fr.token = (fr.token || 0) + 1, id = fr.ai, still = () => alive() && fr.token === token && fr.ai === id && fr.step === 'signin';
  let finishedChecks = 0; fr.shown = '';
  // Drawn only when something changed, and a code half typed in the field stays there.
  const redraw = () => {
    // fr.shown is what the page shows: a Send drawn in between clears it, so the next look always draws the server's answer.
    const sig = JSON.stringify([fr.job, fr.step]); if (sig === fr.shown) return; fr.shown = sig;
    const box = document.getElementById('fr-code'), value = box?.value || '', focused = box && document.activeElement === box;
    draw();
    const again = document.getElementById('fr-code'); if (again && value) again.value = value; if (again && focused) again.focus();
  };
  for (let tries = 0; tries < 400 && still(); tries++) {
    await sleep(3000); if (!still()) return;
    const job = hidden ? await api(`/agents/login?provider=${id}`).catch(() => null) : null;
    if (job && job.state !== 'none' && fr.job) fr.job = { ...fr.job, ...job, sendError: job.codeSent || job.state !== 'signing-in' ? '' : fr.job.sendError };
    await load();
    if (!still()) return;
    if (aiReady(ctx.ui, id)) { fr.step = 'done'; draw(); await connected(ctx, state, draw, finish); return; }
    // The sign-in program ended well, but the AI does not say it is signed in: give it two more looks, then say so.
    if (job?.state === 'finished' && ++finishedChecks > 2) fr.job = { ...fr.job, state: 'failed', error: t('The sign-in closed, but Rex Desk cannot see you signed in yet. Try again.') };
    redraw();
    if (fr.job?.state === 'failed') return;
  }
}

// Connected: the AI becomes the one new agents use, a moment for the green tick, then Rex Agent opens.
async function connected(ctx, state, draw, finish) {
  const { ui, api, refresh } = ctx, id = state.fr.ai, local = id === 'local' ? localReady(state) : null;
  // Ollama runs through Claude Code's model list as "local:<server>/<model>", so agents get Claude as their AI and that model.
  const next = local ? { ...ui.snap.config, provider: 'claude', models: { ...ui.snap.config?.models, claude: `local:${local.server}/${local.model}` } } : { ...ui.snap.config, provider: id };
  if (local ? ui.snap.config?.models?.claude !== next.models.claude || ui.snap.config?.provider !== 'claude' : ui.snap.config?.provider !== id) { try { ui.snap.config = await api('/config', { method: 'PUT', data: next }); void refresh(); } catch {} }
  draw();
  await sleep(1800);
  if (state.fr.step === 'done' && document.querySelector('.tour-back')) await finish();
}

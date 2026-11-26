import { t, languagePicker } from './i18n.js';
// Sign in to Rex Desk. With the account service on (the real app): the Rex Desk account signs in first in the browser
// (Google, GitHub, or a 6-digit email code; a new person gets an account on the way), then the workspace passphrase opens,
// sets up or restores this person's workspace. Without it (tests, scripts): email and passphrase, as before.
import { windowBar } from '/win-bar.js';
// In the desktop app the sign-in page has the window bar too, so the window can be moved, minimized and closed.
windowBar();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const root = document.getElementById('signin');
const TABS = [['signin', t('Sign in')], ['create', t('New account')], ['cloud', t('Bring back from backup')]];
const state = { auth: null, tab: '', error: '', email: '', scene: undefined, account: '', offline: false, switching: false, provider: '', authUrl: '' };
// What a phone's sign-out could not finish (chat-webpush.js signOutPhone), said once on the sign-in page.
let phoneNote = '';
try { const left = sessionStorage.getItem('rex-signout-note'); if (left) { sessionStorage.removeItem('rex-signout-note'); phoneNote = `<p class="si-note warn" role="status">${esc(left)}</p>`; } } catch { /* private mode */ }
const ICON = {
  key: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3m-4 4 3 3m-5-1 2 2"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  google: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6z"/></svg>',
  github: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>',
};

// The server answers within about 20 seconds with { waiting: true } while the browser sign-in is open; ask again until it is done.
// A single long request is cut off by a Mac's webview after about a minute ("Load failed"), which used to show an error and open
// the browser again. A dropped connection is asked again a few times before it counts as a failure.
async function waitForBrowserSignIn(path, waiting) {
  for (let misses = 0; waiting(); ) {
    try { const answer = await post(path, {}); if (!answer.waiting) return answer; misses = 0; }
    catch (error) { if (error.name !== 'TypeError' || ++misses > 6) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  return null;
}

async function post(path, data) {
  const response = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify(data) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ? t(body.error) : t`Request failed (${response.status})`);
  return body;
}

function draw() { (state.auth.requireAccount ? drawAccount : drawLocal)(); }

// The front door of the real app. Step 1: sign in with the Rex Desk account. Step 2: the passphrase for its workspace.
function drawAccount() {
  const auth = state.auth, account = auth.account, known = auth.workspaces.filter(item => item.claimed);
  const secret = (label, name = 'passphrase', complete = 'current-password') => `<label class="st-field"><span>${label}</span><input name="${name}" type="password" autocomplete="${complete}" minlength="8" required></label>`;
  const stay = `<label class="st-check"><input type="checkbox" name="staySignedIn" checked><span><b>${t`Stay signed in on this computer`}</b></span></label>`;
  let body;
  if (!account && state.offline) {
    // The account service cannot be reached: a workspace already on this computer still opens with its passphrase.
    body = `<h2 class="si-title">${t`You are offline`}</h2><p class="si-note">${t`Rex Desk cannot reach its account service. A desk already on this computer opens with its password; sign in to your Rex Desk account again when you are back online.`}</p>
      <form id="si-form" data-mode="offline">${known.length ? `<label class="st-field"><span>${t`Desk`}</span><select name="email">${known.map(item => `<option>${esc(item.email)}</option>`).join('')}</select></label>${secret(t('Password'))}${stay}<button class="btn primary si-submit" type="submit">${t`Open my desk`}</button>` : `<p class="si-note warn">${t`This computer has no desk yet, so the first sign-in needs the internet.`}</p>`}
      <button type="button" class="btn si-submit" data-retry>${t`Try the Rex Desk sign-in again`}</button><p class="si-error" role="alert">${esc(state.error)}</p></form>`;
  } else if (!account) {
    const waiting = state.account === 'waiting';
    const occupied = auth.occupied && !state.switching;
    const ways = `<div class="si-ways si-ways-buttons" role="group" aria-label="${t`Ways to sign in`}"><button type="button" class="btn si-way" data-account data-provider="google">${t`${ICON.google} Continue with Google`}</button><button type="button" class="btn si-way" data-account data-provider="github">${t`${ICON.github} Continue with GitHub`}</button><button type="button" class="btn primary si-way" data-account data-provider="">${t`${ICON.mail} Continue with email`}</button></div>`;
    const note = occupied
      ? `<p class="si-note">${t`${esc(auth.occupied)} is signed in on this computer.`}</p>`
      : state.switching
      ? `<p class="si-note warn">${t`Switching accounts will close the current desk and stop its working agents.`}</p>`
      : `<p class="si-note">${t`A new window will open to finish signing in.`}</p>`;
    const choose = occupied
      ? `<div class="si-ways si-ways-buttons"><button type="button" class="btn primary si-way" data-account data-provider="">${t`Continue as ${esc(auth.occupied)}`}</button><button type="button" class="si-link si-center" data-switch-to>${t`Use a different account`}</button></div>`
      : ways;
    const waitLabel = state.provider === 'google' ? t`Waiting for Google…` : state.provider === 'github' ? t`Waiting for GitHub…` : t`Waiting for the email window…`;
    const waitingBody = `<p class="si-wait" role="status"><span class="si-wait-dot" aria-hidden="true"></span>${waitLabel}</p>
      <button type="button" class="si-link si-center" data-reopen>${t`Window did not open? Try again`}</button>`;
    body = `<h2 class="si-title">${t`Sign in to your desk`}</h2>${note}
      ${waiting ? waitingBody : choose}
      ${waiting ? `<button type="button" class="si-link si-center" data-cancel>${t`Cancel`}</button>` : ''}
      <p class="si-error" role="alert">${esc(state.error)}</p>
      ${occupied || waiting ? '' : `<p class="si-foot">${t`A Rex Desk account is free and keeps your desk, agents and chats. These buttons also make yours.`}</p>`}`;
  } else {
    const who = `<div class="si-who"><span class="si-avatar">${account.image ? `<img src="${esc(account.image)}" alt="" referrerpolicy="no-referrer">` : esc((account.name || account.email || '?')[0].toUpperCase())}</span><span><b>${esc(account.name || account.email)}</b><small>${esc(account.name ? account.email : t('Rex Desk account'))}</small></span><button type="button" class="si-link" data-switch>${t`Not you?`}</button></div>`;
    const unclaimed = auth.workspaces.find(item => !item.claimed);
    const steps = {
      here: { title: t('Enter your password'), note: t('It opens Rex Desk on this computer.'), fields: `${secret(t('Password'))}${stay}`, submit: t('Open my desk') },
      claim: { title: t('Make this computer’s desk yours'), note: t('This computer has a desk from before Rex Desk accounts. Create a password (8 or more letters or numbers) to lock it with your account. You become the owner of this computer.'), fields: `<input type="hidden" name="claimId" value="${esc(unclaimed?.id || '')}">${secret(t('New password'), 'passphrase', 'new-password')}${secret(t('Type it again'), 'repeat', 'new-password')}${stay}`, submit: t('Claim and open') },
      backup: { title: t('Your backup is here'), note: t('Rex Desk found your cloud backup. Enter its password and your agents, chats, pictures and settings come back.'), fields: `<input type="hidden" name="account" value="1">${secret(t('Password'))}${stay}`, submit: t('Bring back my desk') },
      new: { title: t('Create a password'), note: t`This password opens Rex Desk on this computer and keeps your agents' keys safe. If you forget it, Rex Desk cannot get it back.${known.length ? ' Your desk stays apart from the other accounts on this computer.' : ''}`, fields: `${secret(t('Password'), 'passphrase', 'new-password')}${secret(t('Type it again'), 'repeat', 'new-password')}${stay}`, submit: t('Set up my desk') },
    };
    const step = steps[account.workspace] || steps.new;
    const mode = account.workspace === 'backup' ? 'cloud' : account.workspace === 'new' ? 'create' : 'signin';

    body = `${who}<h2 class="si-title">${step.title}</h2><p class="si-note">${step.note}</p>
      <form id="si-form" data-mode="${mode}">${step.fields}<button class="btn primary si-submit" type="submit">${step.submit}</button><p class="si-error" role="alert">${esc(state.error)}</p></form>`;
  }
  root.innerHTML = `<section class="si-card" aria-labelledby="si-brand"><div class="si-brand"><img src="/favicon.svg" alt="" width="28" height="28"><h1 id="si-brand">${t`Rex Desk`}</h1></div><div class="si-lang">${languagePicker(t('Language'))}</div>${phoneNote}
    ${body}</section>`;
  root.querySelector('input[type=password], select')?.focus();
  mountScene();
}

function drawLocal() {
  const auth = state.auth, unclaimed = auth.workspaces.find(item => !item.claimed), known = auth.workspaces.filter(item => item.claimed);
  const tab = state.tab || (unclaimed || known.length ? 'signin' : 'create');
  const email = (value = '') => `<label class="st-field"><span>${t`Email`}</span><input name="email" type="email" autocomplete="username" required value="${esc(value)}"></label>`;
  const secret = (label, name = 'passphrase', complete = 'current-password') => `<label class="st-field"><span>${label}</span><input name="${name}" type="password" autocomplete="${complete}" minlength="8" required></label>`;
  const stay = `<label class="st-check"><input type="checkbox" name="staySignedIn" checked><span><b>${t`Stay signed in on this computer`}</b></span></label>`;
  // A reinstall, a cleared data folder or a new computer: the account and everything in it come back from the cloud backup.
  const back = `<p class="si-note">${t`Reinstalled Rex Desk, or your chats are gone? ${`<button type="button" class="si-link" data-tab="cloud">${t`Bring back from backup`}</button>`} brings back your agents, chats, pictures and settings.`}</p>`;
  const forms = {
    signin: `${unclaimed ? `<p class="si-note warn">${t`This computer has a desk from before accounts. Sign in with your email and a new password (8 or more letters or numbers) to make it yours. The first person to do this becomes the owner of this computer.`}</p><input type="hidden" name="claimId" value="${esc(unclaimed.id)}">` : ''}
      ${known.length ? `<div class="si-known">${known.map(item => `<button type="button" class="si-account" data-email="${esc(item.email)}"><span class="si-avatar">${esc(item.email[0].toUpperCase())}</span><span><b>${esc(item.email)}</b><small>${item.role === 'superadmin' ? t('Owner') : t('Member')}</small></span></button>`).join('')}</div>` : ''}
      ${email(state.email || (known.length === 1 ? known[0].email : ''))}${secret(t('Password'))}${stay}<button class="btn primary si-submit" type="submit">${t`Sign in`}</button>${back}`,
    create: `${email(state.email)}${secret(t('Password'), 'passphrase', 'new-password')}${secret(t('Type it again'), 'repeat', 'new-password')}${stay}<p class="si-note">${t`${auth.workspaces.length ? t('Your account gets its own desk: tasks, keys and history stay apart from other accounts on this computer.') : t('The first account on this computer becomes its owner.')} If you forget your password, Rex Desk cannot get it back.`}</p><button class="btn primary si-submit" type="submit">${t`Create account`}</button>${back}`,
    // The Rex Desk account's browser sign-in finds the backup, so no database address or key is ever typed.
    cloud: `<p class="si-note">${t`Open your account from its cloud backup (Settings, Backup and updates): after a reinstall, after this computer's data was cleared, or on a new computer. Your agents, chats, pictures and settings come back.`}</p>${state.account === 'found' ? `<p class="si-note"><b>${t`Found the backup of your Rex Desk account.`}</b> ${t`Now enter the email and password you used for it.`}</p><input type="hidden" name="account" value="1">` : `<button type="button" class="btn primary si-submit" data-account ${state.account ? 'disabled' : ''}>${state.account ? t('Waiting for you to sign in in the browser…') : t('Sign in with Rex Desk to find my backup')}</button>`}${email(state.email)}${secret(t('Password'))}${stay}<button class="btn primary si-submit" type="submit">${t`Open my account`}</button>`,
  };
  root.innerHTML = `<section class="si-card" aria-labelledby="si-title"><div class="si-brand"><img src="/favicon.svg" alt="" width="28" height="28"><h1 id="si-title">${t`Rex Desk`}</h1></div><div class="si-lang">${languagePicker(t('Language'))}</div>${phoneNote}
    ${auth.occupied ? `<p class="si-note warn">${t`${esc(auth.occupied)} is signed in on this computer. Signing in to another account closes that desk and stops its working agents.`}</p>` : ''}
    <div class="si-tabs" role="tablist">${TABS.map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === tab}" class="${key === tab ? 'on' : ''}" data-tab="${key}">${label}</button>`).join('')}</div>
    <form id="si-form" data-mode="${tab}">${forms[tab]}<p class="si-error" role="alert">${esc(state.error)}</p></form></section>`;
  (root.querySelector('input[name=email]:not([value=""])') ? root.querySelector('input[type=password]') : root.querySelector('input:not([type=hidden])'))?.focus();
  mountScene();
}

// The 3D desk sits behind the centred card; without WebGL the page stays flat and the card still reads.
function mountScene() {
  if (state.scene !== undefined) return;
  state.scene = null;
  const canvas = document.createElement('canvas'); canvas.className = 'si-scene'; canvas.setAttribute('aria-hidden', 'true'); document.body.prepend(canvas);
  import('/login-scene.js').then(module => { state.scene = module.mountLoginScene(canvas); }).catch(() => canvas.remove());
}

root.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]'); if (tab) { state.tab = tab.dataset.tab; state.error = ''; draw(); return; }
  const account = event.target.closest('[data-email]'); if (account) { state.email = account.dataset.email; draw(); return; }
  if (event.target.closest('[data-reopen]')) { if (state.authUrl) window.open(state.authUrl, '_blank', 'noopener'); return; }
  if (event.target.closest('[data-account]')) {
    const provider = event.target.closest('[data-account]')?.dataset.provider || '';
    state.provider = provider; state.authUrl = '';
    state.email = root.querySelector('input[name=email]')?.value || state.email; state.account = 'waiting'; state.error = ''; state.offline = false; draw();
    void (async () => {
      try {
        const { url } = await post('/auth/account-start', { provider }); state.authUrl = url; window.open(url, '_blank', 'noopener');
        const found = await waitForBrowserSignIn('/auth/account-finish', () => state.account === 'waiting');
        if (!found) return; // cancelled meanwhile: the Cancel button already drew the screen
        if (state.auth.requireAccount) { state.auth.account = found; state.account = ''; }
        else { state.account = 'found'; state.email ||= found?.email || ''; }
      }
      catch (error) {
        state.account = ''; state.error = error.message;
        if (state.auth.requireAccount && /could not reach its account service/i.test(error.message)) { state.offline = true; state.error = ''; }
      }
      draw();
    })();
    return;
  }
  if (event.target.closest('[data-switch-to]')) { state.switching = true; state.error = ''; draw(); return; }
  if (event.target.closest('[data-cancel]') || event.target.closest('[data-switch]')) {
    void post('/auth/account-forget', {}).catch(() => {});
    state.auth.account = null; state.account = ''; state.error = ''; draw(); return;
  }
  if (event.target.closest('[data-retry]')) { state.offline = false; state.error = ''; draw(); return; }
});
root.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, data = Object.fromEntries(new FormData(form)), mode = form.dataset.mode, submit = form.querySelector('[type=submit]');
  state.tab = mode; state.email = data.email || '';
  if (mode === 'cloud' && !data.account) { state.error = t('Sign in with Rex Desk first to find your backup.'); draw(); return; }
  if ((mode === 'create' || data.claimId) && data.repeat !== undefined && data.passphrase !== data.repeat) { state.error = t('The two passwords are not the same.'); draw(); return; }
  if (mode === 'offline') data.offline = '1';
  submit.disabled = true; submit.textContent = mode === 'cloud' ? t('Restoring your account…') : t('Signing in…');
  try {
    await post(mode === 'create' ? '/auth/create' : mode === 'cloud' ? '/auth/cloud' : '/auth/login', { ...data, staySignedIn: data.staySignedIn === 'on' });
    await state.scene?.celebrate?.();
    location.href = '/';
  } catch (error) {
    // No copy of the account here yet: go straight to the restore, with the email kept.
    if (mode === 'signin' && !state.auth.requireAccount && /no account for that email on this computer/i.test(error.message)) state.tab = 'cloud';
    // The account sign-in ended meanwhile (the app restarted): back to step 1.
    if (/sign in with rex desk first/i.test(error.message)) state.auth.account = null;
    state.error = error.message; draw();
  }
});

(async () => {
  try {
    state.auth = await fetch('/api/auth', { headers: { 'x-rex-desk': '1' } }).then(reply => reply.json());
    if (state.auth.current) { location.replace('/'); return; }
    draw();
  } catch (error) { root.innerHTML = `<p class="si-error">${t`Rex Desk is not answering: ${esc(error.message)}`}</p>`; }
})();

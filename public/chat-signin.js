// Sign in to Rex Desk. With the account service on (the real app): the Rex Desk account signs in first in the browser
// (email and password, Google or GitHub; accounts are made on rexdesk.app only), then the workspace passphrase opens,
// sets up or restores this person's workspace. Without it (tests, scripts): email and passphrase, as before.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const root = document.getElementById('signin');
const TABS = [['signin', 'Sign in'], ['create', 'New account'], ['cloud', 'Restore from backup']];
const state = { auth: null, tab: '', error: '', email: '', scene: undefined, turso: '', account: '', offline: false };
const SIGNUP = 'https://rexdesk.app/signup';
const ICON = {
  key: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3m-4 4 3 3m-5-1 2 2"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  google: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6z"/></svg>',
  github: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>',
};

async function post(path, data) {
  const response = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify(data) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function draw() { (state.auth.requireAccount ? drawAccount : drawLocal)(); }

// The front door of the real app. Step 1: sign in with the Rex Desk account. Step 2: the passphrase for its workspace.
function drawAccount() {
  const auth = state.auth, account = auth.account, known = auth.workspaces.filter(item => item.claimed);
  const secret = (label, name = 'passphrase', complete = 'current-password') => `<label class="st-field"><span>${label}</span><input name="${name}" type="password" autocomplete="${complete}" minlength="8" required></label>`;
  const stay = '<label class="st-check"><input type="checkbox" name="staySignedIn" checked><span><b>Stay signed in on this computer</b></span></label>';
  let body;
  if (!account && state.offline) {
    // The account service cannot be reached: a workspace already on this computer still opens with its passphrase.
    body = `<h2 class="si-title">You are offline</h2><p class="si-note">Rex Desk cannot reach its account service. A workspace already on this computer opens with its passphrase; sign in to your Rex Desk account again when you are back online.</p>
      <form id="si-form" data-mode="offline">${known.length ? `<label class="st-field"><span>Workspace</span><select name="email">${known.map(item => `<option>${esc(item.email)}</option>`).join('')}</select></label>${secret('Passphrase')}${stay}<button class="btn primary si-submit" type="submit">Open workspace</button>` : '<p class="si-note warn">This computer has no workspace yet, so the first sign-in needs the internet.</p>'}
      <button type="button" class="btn si-submit" data-retry>Try the Rex Desk sign-in again</button><p class="si-error" role="alert">${esc(state.error)}</p></form>`;
  } else if (!account) {
    const waiting = state.account === 'waiting';
    body = `<h2 class="si-title">Sign in to your desk</h2><p class="si-note">Use your Rex Desk account. The sign-in opens in your browser.</p>
      <div class="si-ways" aria-label="Ways to sign in"><span>${ICON.mail} Email</span><span>${ICON.google} Google</span><span>${ICON.github} GitHub</span></div>
      <button type="button" class="btn primary si-submit si-big" data-account ${waiting ? 'disabled' : ''}>${waiting ? 'Waiting for you in the browser…' : 'Sign in with Rex Desk'}</button>
      ${waiting ? '<button type="button" class="si-link si-center" data-cancel>Cancel</button>' : ''}
      <p class="si-error" role="alert">${esc(state.error)}</p>
      <p class="si-foot">No account yet? <a href="${SIGNUP}" target="_blank" rel="noopener">Create one on rexdesk.app</a></p>`;
  } else {
    const who = `<div class="si-who"><span class="si-avatar">${account.image ? `<img src="${esc(account.image)}" alt="" referrerpolicy="no-referrer">` : esc((account.name || account.email || '?')[0].toUpperCase())}</span><span><b>${esc(account.name || account.email)}</b><small>${esc(account.name ? account.email : 'Rex Desk account')}</small></span><button type="button" class="si-link" data-switch>Not you?</button></div>`;
    const unclaimed = auth.workspaces.find(item => !item.claimed);
    const steps = {
      here: { title: 'Enter your passphrase', note: 'It unlocks your workspace on this computer.', fields: `${secret('Passphrase')}${stay}`, submit: 'Open my desk' },
      claim: { title: 'Claim this computer’s workspace', note: 'This computer has a workspace from before Rex Desk accounts. Choose a passphrase (8 or more characters) to lock it with your account. You become this computer’s superadmin.', fields: `<input type="hidden" name="claimId" value="${esc(unclaimed?.id || '')}">${secret('New passphrase', 'passphrase', 'new-password')}${secret('Repeat passphrase', 'repeat', 'new-password')}${stay}`, submit: 'Claim and open' },
      backup: { title: 'Your backup is here', note: 'Rex Desk found your cloud backup. Enter its passphrase and your agents, chats, pictures and settings come back.', fields: `<input type="hidden" name="account" value="1">${secret('Passphrase')}${stay}`, submit: 'Restore my desk' },
      new: { title: 'Choose a passphrase', note: `It locks the API keys and tokens your agents use on this computer. Rex Desk cannot recover a forgotten passphrase.${known.length ? ' Your workspace stays apart from the other accounts on this computer.' : ''}`, fields: `${secret('Passphrase', 'passphrase', 'new-password')}${secret('Repeat passphrase', 'repeat', 'new-password')}${stay}`, submit: 'Set up my desk' },
    };
    const step = state.turso === 'found' ? { title: 'Your backup is here', note: 'Found your backup in your own Turso account. Enter its passphrase.', fields: `<input type="hidden" name="turso" value="1">${secret('Passphrase')}${stay}`, submit: 'Restore my desk' } : steps[account.workspace] || steps.new;
    const mode = state.turso === 'found' || account.workspace === 'backup' ? 'cloud' : account.workspace === 'new' ? 'create' : 'signin';
    const ownTurso = account.workspace === 'new' && state.turso !== 'found' ? `<details class="si-manual"><summary>My backup is in my own Turso account</summary><button type="button" class="btn si-submit" data-turso ${state.turso ? 'disabled' : ''}>${state.turso ? 'Waiting for you to sign in to Turso in the browser…' : 'Find it with Turso'}</button></details>` : '';
    body = `${who}<h2 class="si-title">${step.title}</h2><p class="si-note">${step.note}</p>
      <form id="si-form" data-mode="${mode}">${step.fields}<button class="btn primary si-submit" type="submit">${step.submit}</button><p class="si-error" role="alert">${esc(state.error)}</p></form>${ownTurso}`;
  }
  root.innerHTML = `<section class="si-card" aria-labelledby="si-brand"><div class="si-brand"><img src="/favicon.svg" alt="" width="28" height="28"><h1 id="si-brand">Rex Desk</h1></div>
    ${auth.occupied ? `<p class="si-note warn">${esc(auth.occupied)} is signed in on this computer. Signing in to another account closes that workspace and stops its running agents.</p>` : ''}${body}</section>`;
  root.querySelector('input[type=password], select')?.focus();
  mountScene();
}

function drawLocal() {
  const auth = state.auth, unclaimed = auth.workspaces.find(item => !item.claimed), known = auth.workspaces.filter(item => item.claimed);
  const tab = state.tab || (unclaimed || known.length ? 'signin' : 'create');
  const email = (value = '') => `<label class="st-field"><span>Email</span><input name="email" type="email" autocomplete="username" required value="${esc(value)}"></label>`;
  const secret = (label, name = 'passphrase', complete = 'current-password') => `<label class="st-field"><span>${label}</span><input name="${name}" type="password" autocomplete="${complete}" minlength="8" required></label>`;
  const stay = '<label class="st-check"><input type="checkbox" name="staySignedIn" checked><span><b>Stay signed in on this computer</b></span></label>';
  // A reinstall, a cleared data folder or a new computer: the account and everything in it come back from the cloud backup.
  const back = `<p class="si-note">Reinstalled Rex Desk, or your chats are gone? <button type="button" class="si-link" data-tab="cloud">Restore from backup</button> brings back your agents, chats, pictures and settings.</p>`;
  const forms = {
    signin: `${unclaimed ? `<p class="si-note warn">This computer has a workspace from before accounts. Sign in with your email and a new passphrase (8 or more characters) to claim it. The first claim becomes this computer's superadmin.</p><input type="hidden" name="claimId" value="${esc(unclaimed.id)}">` : ''}
      ${known.length ? `<div class="si-known">${known.map(item => `<button type="button" class="si-account" data-email="${esc(item.email)}"><span class="si-avatar">${esc(item.email[0].toUpperCase())}</span><span><b>${esc(item.email)}</b><small>${item.role === 'superadmin' ? 'Superadmin' : 'Member'}</small></span></button>`).join('')}</div>` : ''}
      ${email(state.email || (known.length === 1 ? known[0].email : ''))}${secret('Passphrase')}${stay}<button class="btn primary si-submit" type="submit">Sign in</button>${back}`,
    create: `${email(state.email)}${secret('Passphrase', 'passphrase', 'new-password')}${secret('Repeat passphrase', 'repeat', 'new-password')}${stay}<p class="si-note">${auth.workspaces.length ? 'Your account gets its own workspace: tasks, keys and history stay apart from other accounts on this computer.' : 'The first account on this computer becomes its superadmin.'} Rex Desk cannot recover a forgotten passphrase.</p><button class="btn primary si-submit" type="submit">Create account</button>${back}`,
    // Turso's browser sign-in finds the backup, so the database address and key are never typed. Typing them stays possible.
    cloud: `<p class="si-note">Open your account from its cloud backup (Settings, Backup and updates): after a reinstall, after this computer's data was cleared, or on a new computer. Your agents, chats, pictures and settings come back.</p>${state.account === 'found' ? '<p class="si-note"><b>Found the backup of your Rex Desk account.</b> Now enter the email and passphrase of the workspace in it.</p><input type="hidden" name="account" value="1">' : state.turso === 'found' ? '<p class="si-note"><b>Found your Rex Desk backup in Turso.</b> Now enter your email and passphrase.</p><input type="hidden" name="turso" value="1">' : `<button type="button" class="btn primary si-submit" data-account ${state.account || state.turso ? 'disabled' : ''}>${state.account ? 'Waiting for you to sign in in the browser…' : 'Sign in with Rex Desk to find my backup'}</button><button type="button" class="btn si-submit" data-turso ${state.turso || state.account ? 'disabled' : ''}>${state.turso ? 'Waiting for you to sign in to Turso in the browser…' : 'My backup is in my own Turso account'}</button><details class="si-manual"><summary>Or type the database address and key</summary><label class="st-field"><span>Database URL</span><input name="url" placeholder="libsql://your-database.turso.io" autocomplete="off" spellcheck="false"></label><label class="st-field"><span>Database token</span><input name="authToken" type="password" autocomplete="off"></label></details>`}${email(state.email)}${secret('Passphrase')}${stay}<button class="btn primary si-submit" type="submit">Open my account</button>`,
  };
  root.innerHTML = `<section class="si-card" aria-labelledby="si-title"><div class="si-brand"><img src="/favicon.svg" alt="" width="28" height="28"><h1 id="si-title">Rex Desk</h1></div>
    ${auth.occupied ? `<p class="si-note warn">${esc(auth.occupied)} is signed in on this computer. Signing in to another account closes that workspace and stops its running agents.</p>` : ''}
    <div class="si-tabs" role="tablist">${TABS.map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === tab}" class="${key === tab ? 'on' : ''}" data-tab="${key}">${label}</button>`).join('')}</div>
    <form id="si-form" data-mode="${tab}">${forms[tab]}<p class="si-error" role="alert">${esc(state.error)}</p></form></section>`;
  (root.querySelector('input[name=email]:not([value=""])') ? root.querySelector('input[type=password]') : root.querySelector('input:not([type=hidden])'))?.focus();
  mountScene();
}

// The 3D desk behind the card; without WebGL the page stays flat.
function mountScene() {
  if (state.scene !== undefined) return;
  state.scene = null;
  const canvas = document.createElement('canvas'); canvas.className = 'si-scene'; canvas.setAttribute('aria-hidden', 'true'); document.body.prepend(canvas);
  import('/login-scene.js').then(module => { state.scene = module.mountLoginScene(canvas); }).catch(() => canvas.remove());
}

root.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]'); if (tab) { state.tab = tab.dataset.tab; state.error = ''; draw(); return; }
  const account = event.target.closest('[data-email]'); if (account) { state.email = account.dataset.email; draw(); return; }
  if (event.target.closest('[data-account]')) {
    state.email = root.querySelector('input[name=email]')?.value || state.email; state.account = 'waiting'; state.error = ''; state.offline = false; draw();
    void (async () => {
      try {
        const { url } = await post('/auth/account-start', {}); window.open(url, '_blank', 'noopener');
        const found = await post('/auth/account-finish', {});
        if (state.auth.requireAccount) { state.auth.account = found; state.account = ''; state.turso = ''; }
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
  if (event.target.closest('[data-cancel]') || event.target.closest('[data-switch]')) {
    void post('/auth/account-forget', {}).catch(() => {});
    state.auth.account = null; state.account = ''; state.turso = ''; state.error = ''; draw(); return;
  }
  if (event.target.closest('[data-retry]')) { state.offline = false; state.error = ''; draw(); return; }
  if (event.target.closest('[data-turso]')) {
    state.email = root.querySelector('input[name=email]')?.value || state.email; state.turso = 'waiting'; state.error = ''; draw();
    void (async () => {
      try { const { url } = await post('/auth/turso-start', {}); window.open(url, '_blank', 'noopener'); await post('/auth/turso-finish', {}); state.turso = 'found'; }
      catch (error) { state.turso = ''; state.error = error.message; }
      draw();
    })();
  }
});
root.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, data = Object.fromEntries(new FormData(form)), mode = form.dataset.mode, submit = form.querySelector('[type=submit]');
  state.tab = mode; state.email = data.email || '';
  if (mode === 'cloud' && !data.turso && !data.account && (!data.url || !data.authToken)) { state.error = 'Sign in with Rex Desk or Turso first, or type the database address and key.'; draw(); return; }
  if ((mode === 'create' || data.claimId) && data.repeat !== undefined && data.passphrase !== data.repeat) { state.error = 'The passphrases do not match.'; draw(); return; }
  if (mode === 'offline') data.offline = '1';
  submit.disabled = true; submit.textContent = mode === 'cloud' ? 'Restoring your account…' : 'Signing in…';
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
  } catch (error) { root.innerHTML = `<p class="si-error">Rex Desk is not answering: ${esc(error.message)}</p>`; }
})();

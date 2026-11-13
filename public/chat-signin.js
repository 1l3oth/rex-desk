// Sign in to Rex Desk: pick or type an account, create one, or open an account from the Turso database another computer uses.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const root = document.getElementById('signin');
const TABS = [['signin', 'Sign in'], ['create', 'New account'], ['cloud', 'Restore from backup']];
const state = { auth: null, tab: '', error: '', email: '', scene: undefined, turso: '', account: '' };

async function post(path, data) {
  const response = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify(data) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function draw() {
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
    state.email = root.querySelector('input[name=email]')?.value || state.email; state.account = 'waiting'; state.error = ''; draw();
    void (async () => {
      try { const { url } = await post('/auth/account-start', {}); window.open(url, '_blank', 'noopener'); const found = await post('/auth/account-finish', {}); state.account = 'found'; state.email ||= found?.email || ''; }
      catch (error) { state.account = ''; state.error = error.message; }
      draw();
    })();
    return;
  }
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
  if (mode === 'create' && data.passphrase !== data.repeat) { state.error = 'The passphrases do not match.'; draw(); return; }
  submit.disabled = true; submit.textContent = mode === 'cloud' ? 'Restoring your account…' : 'Signing in…';
  try {
    await post(mode === 'create' ? '/auth/create' : mode === 'cloud' ? '/auth/cloud' : '/auth/login', { ...data, staySignedIn: data.staySignedIn === 'on' });
    await state.scene?.celebrate?.();
    location.href = '/';
  } catch (error) {
    // No copy of the account here yet: go straight to the restore, with the email kept.
    if (mode === 'signin' && /no account for that email on this computer/i.test(error.message)) state.tab = 'cloud';
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

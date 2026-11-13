import { pickerHtml } from '/chat-pick.js';
import { noticeSettingsHtml } from '/chat-notices.js';
import { voicesFor, chosenVoice } from '/chat-speak.js';
import { loadFolders, foldersHtml, folderClick, startTour } from '/chat-tour.js';
import { trackerDraft, readTrackers, trackersHtml, trackerSources, trackerClick, trackerInput } from '/chat-trackers.js';
// Settings, as a popup over the chat: the sections on the left, one section's settings on the right. Each section saves on its own,
// so a change never waits for the rest. It replaces the old "Issues & settings" page.
const SECTIONS = [
  ['general', 'General', 'Your name, theme, start with Windows'],
  ['folders', 'Folders', 'Where data, AI memory and files are kept'],
  ['notify', 'Notifications', 'Pop-ups, sound, phone, quiet hours'],
  ['agents', 'Agents', 'Workers, model, branches, pull requests'],
  ['accounts', 'Claude accounts', 'Which subscription agents use'],
  ['projects', 'Projects', 'Repositories, branches and commands'],
  ['sources', 'Task sources', 'Rex Desk, Orbit, Flow, Morningmate'],
  ['jev', 'Jev and voice', 'Ranking, computer control, speech'],
  ['schedule', 'Schedule', 'Start work on its own'],
  ['signins', 'Test sign-ins', 'Accounts agents use in previews'],
  ['devices', 'Devices and phone', 'Your other computers, your phone'],
  ['backup', 'Backup and updates', 'Cloud copy, app updates'],
  ['connect', 'Connect another AI', 'Let another assistant use Rex Desk'],
];
// The sections in groups by what they are about, so the list reads in a few chunks instead of thirteen rows.
const GROUPS = [
  ['You', ['general', 'notify', 'jev']],
  ['Agents', ['agents', 'accounts', 'schedule', 'signins']],
  ['Work', ['projects', 'sources', 'connect']],
  ['Data and devices', ['folders', 'backup', 'devices']],
];
// An icon for each section, shown in the phone's list of sections.
const ST_ICON = {
  general: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  folders: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5 12 16l2.5-2.5"/>',
  notify: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  agents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 5.5 5"/>',
  accounts: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16a3.6 3.6 0 0 1 7 0M14 10h4M14 13.5h3"/>',
  projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  sources: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
  jev: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  signins: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  devices: '<rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6M9 14v4"/><rect x="17" y="8" width="5" height="12" rx="1"/>',
  backup: '<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 7.9"/><path d="M12 12v8M9 15l3-3 3 3"/>',
  connect: '<path d="M9 15l6-6M10 6l1-1a4.2 4.2 0 0 1 6 6l-1 1M14 18l-1 1a4.2 4.2 0 0 1-6-6l1-1"/>',
};
const stIcon = id => `<span class="st-ic st-ic-${id}" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ST_ICON[id] || ''}</svg></span>`;
const ASKS = { quit_app: 'Close an app', hibernate: 'Hibernate', shutdown: 'Shut down', restart: 'Restart', sign_out: 'Sign out', stop_program: 'Stop a program', empty_trash: 'Empty the Recycle Bin' };
const LANGS = [['en', 'English'], ['km', 'Khmer'], ['ko', 'Korean']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function openSettings(ctx, section = 'general') {
  const { ui, esc, api, toast, refresh } = ctx;
  document.querySelector('.dialog-back.settings')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back settings'; document.body.append(back);
  const phone = window.matchMedia('(max-width:760px)').matches;
  const state = { section, extra: {}, list: phone && section === 'general', trackers: trackerDraft(ui) };
  const config = () => ui.snap.config || {};
  const field = (label, control, help = '') => `<label class="st-field"><span>${label}</span>${control}${help ? `<small>${help}</small>` : ''}</label>`;
  const check = (name, on, label, help = '') => `<label class="st-check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><span><b>${label}</b>${help ? `<small>${help}</small>` : ''}</span></label>`;
  const input = (name, value, attrs = '') => `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
  // GitHub accounts come from the GitHub CLI. Signing in runs GitHub's device flow: approve the shown code on github.com.
  const githubHtml = () => {
    const github = state.extra.github;
    const head = '<h3>GitHub</h3><p class="muted">Pushes, pull requests and clones use the active account. Rex Desk uses the GitHub CLI sign-in and never keeps a GitHub token.</p>';
    if (!github) return `${head}<p class="muted">Checking GitHub sign-in…</p>`;
    if (!github.installed) return `${head}<p class="error-text">The GitHub CLI (gh) is not installed on this computer.</p>`;
    const login = github.login, waiting = ['waiting', 'starting'].includes(login?.state);
    const list = github.accounts.map(account => `<li><b>${esc(account.login)}</b>${account.active ? '<span class="muted">Active</span>' : account.valid ? `<button type="button" class="btn small quiet" data-st-gh-use="${esc(account.login)}">Use</button>` : '<span class="error-text">Sign in again</span>'}</li>`).join('');
    const signIn = waiting
      ? `<div class="st-gh-code"><span>Enter this code on GitHub</span><code>${esc(login.code || '…')}</code><button type="button" class="btn small" data-st-gh-copy="${esc(login.code || '')}">Copy</button><a class="btn small" href="${esc(login.url)}" target="_blank" rel="noopener">Open GitHub</a><button type="button" class="btn small quiet" data-st-gh-cancel>Cancel</button><small class="muted">This updates by itself once you approve it.</small></div>`
      : `<div class="st-actions"><button type="button" class="btn small" data-st-gh-login>${github.accounts.length ? 'Sign in another GitHub account' : 'Sign in to GitHub'}</button></div>`;
    return `${head}<ul class="st-list">${list || '<li class="muted">No GitHub account signed in.</li>'}</ul>${signIn}${login?.state === 'failed' ? `<p class="error-text">${esc(login.error)}</p>` : ''}`;
  };
  let githubTimer = 0;
  const loadGithub = async () => {
    const before = state.extra.github?.login?.state;
    try { state.extra.github = await api('/github'); } catch (error) { state.extra.github = { installed: true, accounts: [], login: { state: 'failed', error: error.message } }; }
    if (!document.body.contains(back)) return;
    if (state.section === 'projects') draw();
    const now = state.extra.github.login?.state;
    clearTimeout(githubTimer); if (['waiting', 'starting'].includes(now)) githubTimer = setTimeout(loadGithub, 2000);
    else if (now === 'done' && before && before !== 'done') toast(`Signed in to GitHub${state.extra.github.login.account ? ` as ${state.extra.github.login.account}` : ''}.`);
  };
  const githubClick = async target => {
    if (target.closest('[data-st-gh-login]')) { target.closest('[data-st-gh-login]').disabled = true; const login = await api('/github/login', { method: 'POST' }); state.extra.github = { ...(state.extra.github || { installed: true, accounts: [] }), login }; await loadGithub(); return true; }
    if (target.closest('[data-st-gh-cancel]')) { await api('/github/login', { method: 'DELETE' }); await loadGithub(); return true; }
    const use = target.closest('[data-st-gh-use]'); if (use) { await api('/github/switch', { method: 'POST', data: { user: use.dataset.stGhUse } }); await loadGithub(); toast(`${use.dataset.stGhUse} is now the active GitHub account.`); return true; }
    const copy = target.closest('[data-st-gh-copy]'); if (copy) { await navigator.clipboard.writeText(copy.dataset.stGhCopy); toast('Copied.'); return true; }
    return false;
  };
  // Test sign-ins are edited as a working copy: a new empty row has no user name yet, which the server would drop if saved at once.
  const signins = () => (state.signins ||= (config().testAccounts || []).map(account => ({ ...account, password: '' })));
  const readSignins = () => signins().forEach((account, index) => { for (const key of ['site', 'username', 'password']) { const input = back.querySelector(`[name="ta.${index}.${key}"]`); if (input) account[key] = input.value; } });
  const panels = {
    general: () => `<h2>General</h2>
      ${ui.snap.account?.email ? `<div class="st-account"><span class="si-avatar">${esc(ui.snap.account.email[0].toUpperCase())}</span><span><b>${esc(ui.snap.account.email)}</b><small>${ui.snap.account.role === 'superadmin' ? 'Superadmin' : 'Member'} · this computer</small></span><button type="button" class="btn small" data-st-signout>Sign out</button></div>` : ''}
      ${field('Your name', input('name', config().name, 'maxlength="60"'), 'Agents call you by this name.')}
      ${field('Theme', `<select name="theme">${[['system', 'Follow Windows'], ['dark', 'Dark'], ['light', 'Light']].map(([value, label]) => `<option value="${value}" ${(window.rexTheme?.preference || 'system') === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
      ${['en', 'ko', 'km'].map(lang => field(`Reading voice, ${{ en: 'English', ko: 'Korean', km: 'Khmer' }[lang]}`, `<select data-st-voice="${lang}"><option value="">Natural voice (recommended)</option><optgroup label="Natural voices">${(state.extra.neural?.[lang] || []).map(([id, label]) => `<option value="${esc(id)}" ${chosenVoice(lang) === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</optgroup>${(state.extra.voices?.[lang] || []).length ? `<optgroup label="This computer's voices">${state.extra.voices[lang].map(voice => `<option value="${esc(voice.name)}" ${chosenVoice(lang) === voice.name ? 'selected' : ''}>${esc(voice.name)}</option>`).join('')}</optgroup>` : ''}</select>`, lang === 'en' ? "For the speaker button on agent messages. Natural voices are Microsoft's Edge voices (the same studybook uses): the text is sent to Microsoft to be read. This computer's voices stay on this computer." : '')).join('')}
      <div class="st-actions"><button type="button" class="btn small" data-st-tour>Show the setup tour again</button></div>
      ${check('autostart', state.extra.autostart?.enabled, 'Start Rex Desk when I sign in to Windows', 'So schedules, away mode and your phone keep working without opening the app.')}`,
    folders: () => `<h2>Folders</h2><p class="muted">Where Rex Desk keeps things on this computer. Move copies everything to the folder you pick and keeps the old folder as a backup. Moving the data restarts Rex Desk.</p>${foldersHtml(ctx, state)}`,
    notify: () => `<h2>Notifications</h2><p class="muted">Changes save as you make them.</p>${noticeSettingsHtml(ctx)}`,
    agents: () => `<h2>Agents</h2>
      <div class="st-row">${field('Agents working at once', input('concurrency', config().concurrency, 'type="number" min="1" max="6"'), '1 to 6. Each runs in its own copy of the project.')}
      ${field('Sync tasks every', `<span class="st-unit">${input('syncMinutes', config().syncMinutes, 'type="number" min="0" max="1440"')}<em>minutes</em></span>`, '0 syncs only when you press Sync.')}</div>
      ${field('Default model', pickerHtml(ctx, { id: 'st-model', name: 'model', label: 'Default model', value: config().models?.claude || '', items: [{ value: '', label: 'Claude Code default' }, ...(ui.snap.choices?.models || []).map(model => ({ value: model.id, label: model.label }))] }), 'An agent can have its own model on its card.')}
      ${field('Branch names start with', input('branchPrefix', config().branchPrefix, 'spellcheck="false"'), 'For example temp/rex. New branches look like temp/rex/49760-cart-total.')}
      ${field('New agents and chats start in', `<select name="defaultMode">${[['bypassPermissions', 'Dangerous: run everything without asking'], ['auto', 'Auto: safe steps run, risky ones ask'], ['acceptEdits', 'Accept edits: edit files freely, ask before commands'], ['manual', 'Ask first: ask before each step'], ['plan', 'Plan: plan only, change nothing']].map(([value, label]) => `<option value="${value}" ${(config().defaultMode || 'bypassPermissions') === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`, 'Used when you have not picked a mode for a chat. An AI without that mode asks first instead. You can still change the mode under the message box.')}
      ${check('autonomy', config().autonomy !== false, 'Let agents act on their own', 'They start work and open draft pull requests without asking you each time. Nothing is ever merged. Off: they ask first.')}
      ${check('saver', config().saver !== false, 'Save my Claude usage', 'Room chat and Away mode check-ins run on Sonnet, which uses much less of your subscription. Code changes, personal chats and Rex Agent keep the model you chose. An agent with its own model always uses it.')}
      ${check('autoPrLowRisk', config().autoPrLowRisk, 'Open draft pull requests for small, safe fixes on their own', 'Only style, text, docs or test changes with passing tests. Nothing is ever merged on its own.')}
      ${check('reportToOrbit', config().reportToOrbit, 'Let agents send their final report to Orbit', 'Through your Orbit connection, when it is set up.')}`,
    accounts: () => `<h2>Claude accounts</h2><p class="muted">Agents run on a Claude Code sign-in. You can add more accounts and switch when one runs out.</p><button type="button" class="btn primary" data-st-open="accounts">Open Claude accounts</button>`,
    projects: () => {
      // Each project that has agents: where its agents may work, and whether their chats may go to the cloud.
      const projectRulesHtml = () => {
        const rules = ui.snap.projectRules || []; if (!rules.length) return '';
        const rule = item => `<div class="st-rule"><div class="st-rule-head"><b>${esc(item.slug)}</b><span class="muted">${item.agents} agent${item.agents === 1 ? '' : 's'} · ${esc(item.computers.join(', '))}${item.here ? '' : ' · not on this computer'}</span></div>
          <label class="st-check"><input type="checkbox" data-st-rule="pinned" data-slug="${esc(item.slug)}" ${item.pinned ? 'checked' : ''}><span><b>Runs only on its computer</b><small>Its agents never move and never start on another computer. You can still chat with them from anywhere.</small></span></label>
          <label class="st-check"><input type="checkbox" data-st-rule="noCloud" data-slug="${esc(item.slug)}" ${item.noCloud ? 'checked' : ''}><span><b>Keep out of the cloud</b><small>Its chats and files go only straight between your computers. Turning this on deletes its cloud copy; turning it off sends it back.</small></span></label></div>`;
        return `<h3>Where each project's agents work</h3><p class="muted">For a project that is only on one computer, like work code. Changes save at once.</p>${rules.map(rule).join('')}`;
      };
      const repositories = config().repositories || [];
      const row = (repo, index) => `<details class="st-repo" ${state.openRepo === index ? 'open' : ''}><summary><b>${esc(repo.name)}</b><code>${esc(repo.path)}</code><span class="muted">${esc(repo.baseBranch)} → ${esc(repo.targetBranch)}</span></summary>
        <div class="st-row">${field('New work starts from', input(`repo.${index}.baseBranch`, repo.baseBranch, 'spellcheck="false"'))}${field('Pull requests go to', input(`repo.${index}.targetBranch`, repo.targetBranch, 'spellcheck="false"'))}</div>
        ${field('Set up', input(`repo.${index}.setupCommand`, repo.setupCommand, 'spellcheck="false" placeholder="Found from the project files"'))}
        ${field('Run (needs {port})', input(`repo.${index}.devCommand`, repo.devCommand, 'spellcheck="false" placeholder="Found from the project files"'))}
        ${field('Test', input(`repo.${index}.testCommand`, repo.testCommand, 'spellcheck="false" placeholder="Found from the project files"'))}
        ${field('How changes go out', `<select name="repo.${index}.push"><option value="pr" ${repo.push !== 'direct' ? 'selected' : ''}>Draft pull request</option><option value="direct" ${repo.push === 'direct' ? 'selected' : ''}>Push straight to the branch</option></select>`, 'Push straight: agents push their commits onto the target branch, with no pull request. Saying "no PR" in a chat does the same for one change.')}
        <button type="button" class="btn small quiet danger" data-st-repo-remove="${index}">Remove this project</button></details>`;
      return `<h2>Projects</h2><p class="muted">The code your agents work on. Each run gets its own copy, so your own checkout is never touched. Rex Agent can also add a project when you name it in chat.</p>
        ${repositories.length ? repositories.map(row).join('') : '<p class="muted">No projects yet.</p>'}
        ${projectRulesHtml()}
        <div class="st-add"><input data-st-repo-path placeholder="A folder, like D:\\dev\\my-app, or owner/name on GitHub to clone" spellcheck="false" aria-label="Folder of a project, or a GitHub repository to clone"><button type="button" class="btn small" data-st-repo-pick>Browse…</button><button type="button" class="btn small primary" data-st-repo-add>Add</button></div>
        ${githubHtml()}`;
    },
    sources: () => `<h2>Task sources</h2><p class="muted">Where tasks come from. Rex Desk tasks are built in.</p>
      <ul class="st-list">${(config().sources || []).filter(source => source.type === 'orbit').map(source => `<li><b>${esc(source.name)}</b><span class="muted">${esc(source.type)}${source.hasKey ? '' : ' · no key'}</span></li>`).join('') || '<li class="muted">No Orbit goal connected.</li>'}</ul>
      <div class="st-actions"><button type="button" class="btn" data-st-open="sources">Orbit and Rex Desk tasks</button></div>
      ${trackersHtml(ctx, state)}`,
    jev: () => `<h2>Jev and voice</h2>
      <h3>Ranking your issues</h3>
      ${field('OpenRouter key', `<input type="password" name="jev.apiKey" autocomplete="off" spellcheck="false" placeholder="${config().jev?.hasKey ? 'Saved. Paste a new key to replace it.' : 'sk-or-…'}">`, 'Kept encrypted on this computer and sent only to OpenRouter. Also used for the Gemini voice engine.')}
      ${config().jev?.hasKey ? check('jev.clearKey', false, 'Remove the saved key') : ''}
      <div class="st-row">${field('Jev model', input('jev.model', config().jev?.model, 'placeholder="Newest Jev release" spellcheck="false"'))}${field('Versions you ship now', input('jev.versions', config().jev?.versions, 'placeholder="App 2.0.1, website current release"'))}</div>
      ${check('jev.auto', config().jev?.auto !== false, 'Rank new and changed issues after each sync')}
      ${config().jev?.hasKey ? `<div class="st-actions"><button type="button" class="btn small" data-st-rank ${state.extra.ranking ? 'disabled' : ''}>${state.extra.ranking ? 'Ranking…' : 'Rank my issues now'}</button><small class="muted">Shift-click to check every issue again.</small></div>` : ''}
      <h3>Controlling this computer</h3>
      ${check('control.enabled', config().control?.enabled !== false, 'Let Jev control this computer when I ask')}
      ${check('control.confirm', config().control?.confirm !== false, 'Ask me before shutting down, restarting, signing out, closing apps or emptying the Recycle Bin')}
      ${check('control.agents', config().control?.agents, 'Let agents control this computer too')}
      ${(config().control?.allow || []).length ? `<div class="st-field"><span>Done without asking</span><div class="st-chips">${config().control.allow.map(action => `<span class="st-chip">${esc(ASKS[action] || action.replaceAll('_', ' '))}<button type="button" class="ag-x" data-st-allow-off="${esc(action)}" aria-label="Ask again before this">×</button></span>`).join('')}</div><small>Press × to have Jev ask you again first. "Yes, always" on a Jev question adds one here.</small></div>` : ''}
      ${field('Voice language', `<select name="control.language">${LANGS.map(([value, label]) => `<option value="${value}" ${(config().control?.language || 'en') === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
      <div class="st-actions"><button type="button" class="btn" data-st-open="voice">Voice engine and compare</button></div>`,
    schedule: () => { const schedule = config().schedule || {}; const days = schedule.days || [1, 2, 3, 4, 5]; return `<h2>Schedule</h2><p class="muted">At the set time Rex Desk syncs, Rex Agent sorts new issues, and it starts work up to your daily limit. Questions wait in Needs you.</p>
      ${check('schedule.enabled', schedule.enabled, 'Start work on its own on a schedule')}
      <div class="st-row">${field('Time', input('schedule.time', schedule.time || '09:00', 'type="time"'))}${field('Most runs a day', input('schedule.maxRuns', schedule.maxRuns || 6, 'type="number" min="1" max="20"'), 'Runs use your Claude subscription.')}</div>
      <fieldset class="st-days"><legend>Days</legend>${DAYS.map((day, index) => `<label><input type="checkbox" name="schedule.days" value="${index}" ${days.includes(index) ? 'checked' : ''}><span>${day}</span></label>`).join('')}</fieldset>
      ${check('schedule.fix', schedule.fix !== false, 'Start runs for the top-ranked issues', 'Needs a project for them.')}
      <div class="st-actions"><button type="button" class="btn small" data-st-schedule-run ${state.extra.scheduling ? 'disabled' : ''}>${state.extra.scheduling ? 'Starting…' : 'Run it now'}</button></div>`; },
    signins: () => `<h2>Test sign-ins</h2><p class="muted">An agent can sign in to a preview it starts with these, without ever seeing the password. Never used on a live production site.</p>
      ${signins().map((account, index) => `<div class="st-signin"><input name="ta.${index}.site" value="${esc(account.site || '')}" placeholder="Site, like localhost or staging.example.com" aria-label="Site"><input name="ta.${index}.username" value="${esc(account.username || '')}" placeholder="User name or email" aria-label="User name"><input type="password" name="ta.${index}.password" value="${esc(account.password || '')}" placeholder="${account.hasPassword ? 'Saved' : 'Password'}" aria-label="Password" autocomplete="new-password"><button type="button" class="ag-x" data-st-signin-remove="${index}" aria-label="Remove this sign-in">×</button></div>`).join('')}
      <button type="button" class="btn small" data-st-signin-add>+ Add a sign-in</button>`,
    devices: () => `<h2>Devices and phone</h2><p class="muted">Use Rex Desk on your phone and your other computers over Tailscale. The Devices page has the QR code for your phone.</p><button type="button" class="btn primary" data-st-go="devices">Open Devices</button>`,
    backup: () => { const database = ui.snap.database || {}, update = ui.snap.update || {}, account = database.account, hosted = Boolean(account && account.url === database.url); return `<h2>Backup and updates</h2>
      <h3>Cloud backup</h3><p>${esc((hosted ? { connected: 'Backed up with your Rex Desk account.', syncing: 'Uploading your backup…', connecting: 'Connecting to your backup…', offline: 'Your backup is offline; changes wait and upload later.', error: 'Your backup needs attention.' } : { connected: 'Copied to your Turso database.', syncing: 'Uploading to Turso…', connecting: 'Connecting to Turso…', offline: 'Turso is offline; changes wait and upload later.', error: 'Turso needs attention.' })[database.state] || 'Kept on this computer only.')}${database.pending ? ` ${Number(database.pending)} changes waiting.` : ''}</p>
      ${account ? `<div class="st-account st-cloud-account"><span class="si-avatar">${esc((account.name || account.email || '?')[0].toUpperCase())}</span><span><b>${esc(account.name || account.email)}</b><small>${esc(hosted ? `Rex Desk account${account.name ? ` · ${account.email}` : ''}. This computer renews its backup key by itself.` : `Rex Desk account${account.name ? ` · ${account.email}` : ''}. Signed in, but the backup uses another database.`)}</small></span><button type="button" class="btn small" data-st-account-out>Sign out</button></div>` : ''}
      ${database.configured ? '' : `<div class="st-cloud"><div class="st-cloud-head">${stIcon('backup')}<div><b>Back up with your Rex Desk account</b><small>Sign in with your email and password, Google or GitHub. Rex Desk makes a private cloud database for you, and your agents, chats and settings follow you to every computer you sign in on.</small></div></div><button type="button" class="btn primary" data-st-account ${state.extra.account ? 'disabled' : ''}>${esc(state.extra.account || 'Sign in with Rex Desk')}</button><p class="st-cloud-fine">Nothing to type: no address and no key. Your backup is kept in Rex Desk's cloud, in a database only your account can open.</p><p class="st-cloud-fine">No account yet? <a href="https://rexdesk.app/signup" target="_blank" rel="noopener">Create one on rexdesk.app</a></p></div>`}${database.accountNote ? `<p class="error-text" role="alert">${esc(database.accountNote)}</p>` : ''}${database.configured ? '<button type="button" class="btn" data-st-db-sync>Upload now and check</button>' : ''}
      <details class="st-db-manual"><summary>${database.configured ? 'Use another database' : 'Use my own Turso account instead'}</summary>
        ${database.configured ? '' : `<p class="muted">Keep the backup in a Turso account of your own. Sign in to Turso with GitHub or Google and Rex Desk makes the database there.</p><button type="button" class="btn" data-st-turso ${state.extra.turso ? 'disabled' : ''}>${esc(state.extra.turso || 'Set up with my Turso account')}</button><p class="muted">Or type the address and key of a database you already have:</p>`}
        <label class="st-field"><span>Database address</span><input data-st-db-url value="${esc(database.url || '')}" placeholder="libsql://your-database.turso.io" autocomplete="off" spellcheck="false"></label>
        <label class="st-field"><span>Database key${database.configured ? ' (saved; leave empty to keep it)' : ''}</span><input data-st-db-token type="password" autocomplete="new-password"></label>
        <button type="button" class="btn small" data-st-db-connect>Connect</button>
      </details>${database.error ? `<p class="error-text" role="alert">${esc(database.error)}</p>` : ''}
      <h3>App updates</h3><p>${esc(update.supported ? `This is Rex Desk ${[update.current, update.stage].filter(Boolean).join(' ')}. ` : '')}${esc(update.ready ? `Version ${update.available?.version} is downloaded and checked.` : update.available ? `Version ${update.available.version} is available.` : update.supported ? (update.checkedAt ? 'Rex Desk is up to date.' : 'Not checked yet.') : 'This copy runs from source code and updates with Git.')}</p>${update.error ? `<p class="error-text">${esc(update.error)}</p>` : ''}<div class="st-actions">${update.supported ? `<button type="button" class="btn small" data-st-update-check ${state.extra.checking ? 'disabled' : ''}>${state.extra.checking ? 'Checking…' : 'Check now'}</button>` : ''}${update.ready ? '<button type="button" class="btn primary" data-action="update-install">Install and restart</button>' : ''}</div>`; },
    connect: () => `<h2>Connect another AI</h2><p class="muted">Give this to another Claude Code session (or another assistant) so it can read your tasks and ask you questions through Rex Desk. No key is needed on this computer.</p>
      <button type="button" class="btn" data-st-prompt>Show the setup text</button>${state.extra.prompt ? `<pre class="st-prompt">${esc(state.extra.prompt)}</pre><button type="button" class="btn small" data-st-copy-prompt>Copy</button>` : ''}`,
  };
  const saves = new Set(['general', 'agents', 'projects', 'sources', 'jev', 'schedule', 'signins']);
  const draw = () => {
    // A redraw of the same section keeps the place the person scrolled to (ticking a box used to jump back to the top).
    const keep = back.dataset.section === state.section ? back.querySelector('.st-panel')?.scrollTop || 0 : 0;
    queueMicrotask(() => { back.dataset.section = state.section; const panel = back.querySelector('.st-panel'); if (panel && keep) panel.scrollTop = keep; });
    const title = (SECTIONS.find(([id]) => id === state.section) || [])[1] || 'Settings';
    back.innerHTML = `<form class="settings-pop${state.list ? ' st-listing' : ' st-open'}" aria-label="Settings"><nav class="st-nav"><div class="st-navhead"><h1>Settings</h1><button type="button" class="st-done" data-st-close>Done</button></div>${GROUPS.map(([group, ids]) => `<div class="st-group" role="group" aria-label="${group}"><span class="st-glabel" aria-hidden="true">${group}</span>${ids.map(id => SECTIONS.find(([key]) => key === id)).filter(Boolean).map(([id, label, hint]) => `<button type="button" class="${state.section === id && !state.list ? 'on' : ''}" data-st-section="${id}">${stIcon(id)}<span class="st-nl"><b>${label}</b><small>${hint}</small></span><svg class="st-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`).join('')}</div>`).join('')}</nav>
      <div class="st-body"><div class="st-mhead"><button type="button" class="st-back" data-st-back aria-label="Back to Settings"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg><span>Settings</span></button><b>${esc(title)}</b></div><div class="st-panel" data-st-panel>${panels[state.section]()}</div>
      <div class="st-foot">${saves.has(state.section) ? '<button type="button" class="btn primary" data-st-save>Save</button>' : ''}<span class="spacer"></span><button type="button" class="btn" data-st-close>Close</button></div></div>
      <button type="button" class="st-x" data-st-close aria-label="Close settings">×</button></form>`;
  };
  const values = () => Object.fromEntries([...back.querySelectorAll('[name]')].filter(el => el.type !== 'checkbox' || el.name === 'schedule.days').map(el => [el.name, el.value]));
  const checked = name => Boolean(back.querySelector(`[name="${name}"]`)?.checked);
  async function save() {
    const base = JSON.parse(JSON.stringify(config())), v = values(), next = { ...base };
    if (state.section === 'general') { next.name = v.name; window.rexTheme?.set(v.theme); await api('/autostart', { method: 'POST', data: { enabled: checked('autostart') } }).catch(() => {}); }
    if (state.section === 'agents') Object.assign(next, { defaultMode: v.defaultMode, concurrency: Number(v.concurrency), syncMinutes: Number(v.syncMinutes), branchPrefix: v.branchPrefix, autoPrLowRisk: checked('autoPrLowRisk'), reportToOrbit: checked('reportToOrbit'), saver: checked('saver'), autonomy: checked('autonomy'), models: { ...base.models, claude: back.querySelector('#st-model')?.value ?? base.models?.claude } });
    if (state.section === 'projects') next.repositories = base.repositories.map((repo, index) => ({ ...repo, ...Object.fromEntries(['baseBranch', 'targetBranch', 'setupCommand', 'devCommand', 'testCommand', 'push'].map(key => [key, v[`repo.${index}.${key}`] ?? repo[key]])) }));
    if (state.section === 'jev') { next.jev = { ...base.jev, apiKey: v['jev.apiKey'] || '', clearKey: checked('jev.clearKey'), model: v['jev.model'], versions: v['jev.versions'], auto: checked('jev.auto') }; next.control = { enabled: checked('control.enabled'), confirm: checked('control.confirm'), agents: checked('control.agents'), language: v['control.language'] }; }
    if (state.section === 'schedule') next.schedule = { enabled: checked('schedule.enabled'), time: v['schedule.time'], maxRuns: Number(v['schedule.maxRuns']), fix: checked('schedule.fix'), days: [...back.querySelectorAll('[name="schedule.days"]:checked')].map(box => Number(box.value)) };
    if (state.section === 'sources') { readTrackers(back, state); next.sources = trackerSources(ui, state); }
    if (state.section === 'signins') { readSignins(); next.testAccounts = state.signins.filter(account => account.username.trim()); }
    ui.snap.config = await api('/config', { method: 'PUT', data: next }); await refresh(); if (state.section === 'sources') state.trackers = trackerDraft(ui); state.signins = null; toast('Saved.'); draw();
  }
  back.addEventListener('click', async event => {
    const target = event.target;
    try {
      if (target === back || target.closest('[data-st-close]')) { back.remove(); return; }
      if (target.closest('[data-st-back]')) { state.list = true; draw(); return; }
      const section = target.closest('[data-st-section]'); if (section) { state.section = section.dataset.stSection; state.list = false; if (state.section === 'sources') state.trackers = trackerDraft(ui); if (state.section === 'projects') void loadGithub(); if (state.section === 'folders') void loadFolders(ctx, state).then(() => state.section === 'folders' && draw()); if (state.section === 'general') state.extra.autostart = await api('/autostart').catch(() => null); draw(); return; }
      if (await trackerClick(ctx, state, target, back, draw)) return;
      if (await folderClick(ctx, state, target, draw)) return;
      if (target.closest('[data-st-tour]')) { back.remove(); startTour(ctx); return; }
      if (await githubClick(target)) return;
      if (target.closest('[data-st-rank]')) {
        state.extra.ranking = true; draw();
        try { const result = await api('/jev/prioritize', { method: 'POST', data: { force: event.shiftKey } }); await refresh(); toast(result.failed ? `Jev rated ${result.done - result.failed} of ${result.total}; ${result.failed} failed: ${result.error}` : result.total ? `Jev rated ${result.total} issue${result.total === 1 ? '' : 's'}.` : 'Every issue is already rated. Shift-click to check them all again.', Boolean(result.failed)); }
        finally { state.extra.ranking = false; draw(); } return;
      }
      if (target.closest('[data-st-schedule-run]')) {
        state.extra.scheduling = true; draw();
        try { const result = await api('/schedule/run', { method: 'POST' }); toast(result.state === 'started' ? `Started Rex Agent on ${result.issues} new issue${result.issues === 1 ? '' : 's'}.` : result.reason, result.state !== 'started'); await refresh(); }
        finally { state.extra.scheduling = false; draw(); } return;
      }
      if (target.closest('[data-st-update-check]')) {
        state.extra.checking = true; draw();
        try { const update = await api('/update/check', { method: 'POST' }); ui.snap.update = update; toast(update.error || (update.available ? `Rex Desk ${update.available.version} is ${update.ready ? 'ready to install' : 'downloading'}.` : 'Rex Desk is up to date.'), Boolean(update.error)); }
        finally { state.extra.checking = false; draw(); } return;
      }
      if (target.closest('[data-st-save]')) { target.closest('[data-st-save]').disabled = true; await save(); return; }
      const open = target.closest('[data-st-open]'); if (open) { back.remove(); document.body.insertAdjacentHTML('beforeend', `<button hidden data-action="${open.dataset.stOpen === 'accounts' ? 'accounts' : open.dataset.stOpen === 'sources' ? 'task-connect' : 'st-voice'}" id="st-opener"></button>`); document.getElementById('st-opener').click(); document.getElementById('st-opener')?.remove(); return; }
      const go = target.closest('[data-st-go]'); if (go) { back.remove(); ctx.open(go.dataset.stGo); return; }
      if (target.closest('[data-st-signout]')) { if (!confirm('Sign out of Rex Desk on this computer? Running agents of this account stop.')) return; await api('/auth/logout', { method: 'POST', data: {} }); location.href = '/signin'; return; }
      const allowOff = target.closest('[data-st-allow-off]'); if (allowOff) { await api('/computer/allow', { method: 'POST', data: { actions: [allowOff.dataset.stAllowOff], on: false } }); await refresh(); draw(); return; }
      if (target.closest('[data-st-account]')) {
        // One click: the Rex Desk sign-in opens in the browser; the account service then makes the person's database and this computer connects to it.
        state.extra.account = 'Opening the Rex Desk sign-in…'; draw();
        try {
          // Already signed in to Rex Desk when this workspace opened: no second trip to the browser.
          const { url } = await api('/database/account-start', { method: 'POST' }); if (url) window.open(url, '_blank', 'noopener');
          state.extra.account = url ? 'Waiting for you to sign in in the browser…' : 'Turning cloud backup on…'; draw();
          const status = await api('/database/account-finish', { method: 'POST' });
          toast(status.state === 'connected' ? (status.created ? 'Cloud backup is on. Your private database was made and your history was uploaded.' : 'Cloud backup is on. This computer is connected to your backup.') : `Signed in. The backup is ${status.state}; changes wait and upload later.`, status.state !== 'connected');
          await refresh();
        } finally { state.extra.account = ''; draw(); }
        return;
      }
      if (target.closest('[data-st-account-out]')) {
        if (!confirm('Sign this computer out of your Rex Desk account? The backup keeps working for up to 30 days, then stops until you sign in again.')) return;
        await api('/database/account-signout', { method: 'POST' }); toast('Signed out of your Rex Desk account on this computer.'); await refresh(); draw(); return;
      }
      if (target.closest('[data-st-turso]')) {
        // One click: Turso's sign-in opens in the browser; Rex Desk then makes the person's own database and connects it.
        state.extra.turso = 'Opening Turso sign-in…'; draw();
        try {
          const { url } = await api('/database/turso-start', { method: 'POST' }); window.open(url, '_blank', 'noopener');
          state.extra.turso = 'Waiting for you to sign in to Turso in the browser…'; draw();
          const status = await api('/database/turso-finish', { method: 'POST' });
          toast(status.state === 'connected' ? 'Cloud backup is on. Your own Turso database was made and your history was uploaded.' : `Database made. Turso is ${status.state}; changes wait and upload later.`, status.state !== 'connected');
          await refresh();
        } finally { state.extra.turso = ''; draw(); }
        return;
      }
      // Cloud backup by hand (an existing database), and the upload check: these lived only in the old screen before.
      if (target.closest('[data-st-db-connect]')) {
        const status = await api('/database/connect', { method: 'POST', data: { url: back.querySelector('[data-st-db-url]').value.trim(), authToken: back.querySelector('[data-st-db-token]').value } });
        toast(status.state === 'connected' ? 'Turso connected. Your history was uploaded.' : `Saved. Turso is ${status.state}; changes wait and upload later.`, status.state !== 'connected'); await refresh(); draw(); return;
      }
      if (target.closest('[data-st-db-sync]')) {
        const button = target.closest('[data-st-db-sync]'); button.disabled = true; button.textContent = 'Uploading…';
        try { const result = await api('/database/sync', { method: 'POST' }); toast(result.matched ? `Everything on this computer is in the cloud: ${result.localRecords} records and ${result.localEvents} messages.` : `${result.missingRecords} records and ${result.missingEvents} messages from this computer did not reach the cloud. Check the connection and try again.`, !result.matched); }
        finally { await refresh(); draw(); }
        return;
      }
      if (target.closest('[data-st-prompt]')) { state.extra.prompt = (await api('/setup-prompt', { method: 'POST', data: { target: 'claude' } })).prompt; draw(); return; }
      if (target.closest('[data-st-copy-prompt]')) { await navigator.clipboard.writeText(state.extra.prompt); toast('Copied.'); return; }
      if (target.closest('[data-st-signin-add]')) { readSignins(); state.signins.push({ id: crypto.randomUUID(), site: '', username: '', password: '' }); draw(); back.querySelector(`[name="ta.${state.signins.length - 1}.site"]`)?.focus(); return; }
      const dropSignin = target.closest('[data-st-signin-remove]'); if (dropSignin) { readSignins(); state.signins.splice(Number(dropSignin.dataset.stSigninRemove), 1); draw(); toast('Press Save to make it final.'); return; }
      const dropRepo = target.closest('[data-st-repo-remove]'); if (dropRepo) { const repo = config().repositories[Number(dropRepo.dataset.stRepoRemove)]; if (!confirm(`Remove ${repo.name} from Rex Desk? The folder on disk stays.`)) return; ui.snap.config = await api('/config', { method: 'PUT', data: { ...config(), repositories: config().repositories.filter((_, index) => index !== Number(dropRepo.dataset.stRepoRemove)) } }); await refresh(); draw(); return; }
      if (target.closest('[data-st-repo-pick]')) { const picked = await api('/repositories/pick', { method: 'POST', data: {} }).catch(() => null); if (picked?.path) back.querySelector('[data-st-repo-path]').value = picked.path; return; }
      if (target.closest('[data-st-repo-add]')) {
        let folder = back.querySelector('[data-st-repo-path]').value.trim(); if (!folder) return toast('Type or browse to a project folder first.', true);
        // owner/name or a github.com address is cloned next to Rex Desk with the active GitHub account, then added like a folder.
        if ((!/[\\:]/.test(folder) && /^[\w.-]+\/[\w.-]+$/.test(folder)) || /^https:\/\/github\.com\//.test(folder)) {
          const button = target.closest('[data-st-repo-add]'); button.disabled = true; button.textContent = 'Cloning…';
          try { folder = (await api('/repositories/clone', { method: 'POST', data: { repository: folder } })).path; } finally { button.disabled = false; button.textContent = 'Add'; }
        }
        const found = await api('/repositories/inspect', { method: 'POST', data: { path: folder } });
        ui.snap.config = await api('/config', { method: 'PUT', data: { ...config(), repositories: [...config().repositories, { name: found.name, path: found.path, baseBranch: found.preferredBranch || 'develop', targetBranch: found.preferredBranch || 'develop' }] } });
        await refresh(); toast(`Added ${found.name}.`); draw(); return;
      }
    } catch (error) { toast(error.message, true); back.querySelector('[data-st-save]')?.removeAttribute('disabled'); }
  });
  back.addEventListener('keydown', event => { if (event.key === 'Escape') back.remove(); });
  back.addEventListener('input', event => { trackerInput(back, state, event, draw); });
  back.addEventListener('change', event => { trackerInput(back, state, event, draw); });
  back.addEventListener('toggle', event => { const card = event.target.dataset?.trCard; if (card && event.target.open) state.openTracker = card; }, true);
  // A project's two rules save at once.
  back.addEventListener('change', async event => {
    const rule = event.target.dataset?.stRule; if (!rule) return;
    const slug = event.target.dataset.slug, on = event.target.checked;
    if (rule === 'noCloud' && on && !confirm(`Keep ${slug} out of the cloud? Its chats and files are deleted from the cloud database. They stay on your computers.`)) { event.target.checked = false; return; }
    try { await api(`/project-rules/${encodeURIComponent(slug)}`, { method: 'PUT', data: { [rule]: on } }); await refresh({ full: true }); toast(rule === 'pinned' ? (on ? `${slug} now runs only on its computer.` : `${slug}'s agents can be moved again.`) : (on ? `${slug} is kept out of the cloud. Its cloud copy is being deleted.` : `${slug} uses the cloud again. Its chats are being sent back.`)); draw(); }
    catch (error) { event.target.checked = !on; toast(error.message, true); }
  });
  // The voices on this computer, for the reading voice choices.
  void api('/speak/voices').then(neural => { state.extra.neural = neural; if (state.section === 'general' && document.body.contains(back)) draw(); }).catch(() => {});
  if ('speechSynthesis' in window) void Promise.all(['en', 'ko', 'km'].map(lang => voicesFor(lang).then(list => [lang, list.map(voice => ({ name: voice.name }))]))).then(pairs => { state.extra.voices = Object.fromEntries(pairs); if (state.section === 'general' && document.body.contains(back)) draw(); });
  back.addEventListener('change', event => { const lang = event.target.dataset?.stVoice; if (!lang) return; try { if (event.target.value) localStorage.setItem(`rex-desk-voice-${lang}`, event.target.value); else localStorage.removeItem(`rex-desk-voice-${lang}`); } catch { /* private window */ } toast('Reading voice saved.'); });
  if (section === 'projects') void loadGithub();
  if (section === 'folders') void loadFolders(ctx, state).then(() => state.section === 'folders' && draw());
  if (section === 'general') void api('/autostart').then(result => { state.extra.autostart = result; if (state.section === 'general' && document.body.contains(back)) draw(); }).catch(() => {});
  // The Notifications tab saves on change; redraw it when its settings come back changed, keeping the scroll.
  let noticeHtml = '';
  window.__rexNoticeSettingsRedraw = () => {
    if (!document.body.contains(back)) { window.__rexNoticeSettingsRedraw = null; return; }
    if (state.section !== 'notify') return;
    const html = panels.notify(); if (html === noticeHtml) return; noticeHtml = html;
    const panel = back.querySelector('[data-st-panel]'), top = panel?.scrollTop || 0; if (panel) { panel.innerHTML = html; panel.scrollTop = top; }
  };
  draw(); back.querySelector('.st-nav button.on')?.focus();
}

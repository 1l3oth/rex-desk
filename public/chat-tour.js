// Where Rex Desk keeps things (shown in Settings, Folders and in the setup tour), and the setup tour a new person gets.
const ROWS = [
  ['data', 'Rex Desk data', 'Chats, tasks, settings and saved keys.', 'restart'],
  ['memory', 'AI memory', 'What agents know about you and your projects. Every agent reads it.', 'restart'],
  ['files', 'Files from agents', 'Screenshots, recordings and files you attach.', 'now'],
];

export async function loadFolders({ api }, state) { state.folders = await api('/folders').catch(error => ({ error: error.message })); return state.folders; }

export function foldersHtml({ esc }, state) {
  const folders = state.folders;
  if (!folders) return '<p class="muted">Finding your folders…</p>';
  if (folders.error) return `<p class="error-text">${esc(folders.error)}</p>`;
  const pending = { data: folders.dataPending, memory: folders.memoryPending };
  return `<div class="st-folders">${ROWS.map(([kind, label, help, when]) => `<div class="st-folder"><div class="st-folder-text"><b>${label}</b><small>${help}</small><code>${esc(folders[kind])}</code>
      ${pending[kind] ? `<small class="st-folder-note">Moves to ${esc(pending[kind])} when Rex Desk restarts.</small>` : ''}
      ${kind === 'data' && folders.dataFailed ? `<small class="error-text">The last move did not happen: ${esc(folders.dataFailed)}</small>` : ''}
      ${kind === 'files' && folders.filesInData ? `<small class="st-folder-note">Kept inside the data folder. Most people keep these in ${esc(folders.suggestedFiles)}.</small>` : ''}</div>
    <div class="st-folder-actions"><button type="button" class="btn small quiet" data-fd-open="${kind}">Open</button><button type="button" class="btn small" data-fd-change="${kind}" data-fd-when="${when}">Change…</button>${kind === 'files' && folders.filesInData ? '<button type="button" class="btn small primary" data-fd-downloads>Use Downloads</button>' : ''}</div></div>`).join('')}</div>`;
}

// Clicks on the folder rows. Returns true when it handled the click.
export async function folderClick(ctx, state, target, draw) {
  const { api, toast } = ctx;
  const open = target.closest('[data-fd-open]');
  if (open) { await api('/folders/open', { method: 'POST', data: { kind: open.dataset.fdOpen } }); return true; }
  if (target.closest('[data-fd-downloads]')) { state.folders = await api('/folders/files', { method: 'POST', data: { to: state.folders.suggestedFiles } }); toast('Files from agents now go to your Downloads folder.'); draw(); return true; }
  const change = target.closest('[data-fd-change]');
  if (!change) return false;
  const kind = change.dataset.fdChange, label = ROWS.find(([id]) => id === kind)[1];
  const picked = await api('/folders/pick', { method: 'POST', data: {} }).catch(() => null);
  if (!picked?.path) return true;
  if (kind === 'files') { state.folders = await api('/folders/files', { method: 'POST', data: { to: picked.path } }); toast(`${label} moved to ${state.folders.files}.`); draw(); return true; }
  const note = kind === 'memory' ? ' Agents start their next chat fresh, with a summary of the old one.' : '';
  if (!confirm(`Move ${label.toLowerCase()} to ${picked.path}?\n\nRex Desk restarts, copies everything there, and opens again in a few seconds. The old folder stays as a backup you can delete later.${note}`)) return true;
  await api('/folders/move', { method: 'POST', data: { kind, to: picked.path, restart: true } });
  document.body.insertAdjacentHTML('beforeend', '<div class="dialog-back tour-wait"><div class="tour-card"><h2>Moving your folder</h2><p>Rex Desk is restarting. This page opens again by itself.</p></div></div>');
  // Wait for the old server to go away, then for the new one to answer.
  await new Promise(resolve => setTimeout(resolve, 3000));
  for (let i = 0; i < 120; i++) { try { if ((await fetch('/api/folders', { cache: 'no-store' })).status < 500) break; } catch { /* still restarting */ } await new Promise(resolve => setTimeout(resolve, 1000)); }
  location.reload(); return true;
}

// The setup tour. It opens by itself for a new person (no project yet, never finished), and from Settings, General.
const STEPS = ['welcome', 'ai', 'folders', 'project', 'done'];
export function maybeStartTour(ctx) {
  const config = ctx.ui.snap?.config;
  if (!config || config.tourDismissed || (config.repositories || []).length || document.querySelector('.tour-back')) return;
  startTour(ctx);
}

export function startTour(ctx) {
  const { ui, esc, api, toast, refresh } = ctx;
  document.querySelector('.tour-back')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back tour-back'; document.body.append(back);
  const state = { step: 0 };
  void loadFolders(ctx, state).then(() => { if (STEPS[state.step] === 'folders') draw(); });
  const account = () => { const list = ui.accounts?.claude, current = list?.profiles?.find(item => item.profile === list.selected) || list?.profiles?.[0]; return current; };
  const picture = step => `<svg class="tour-pic" viewBox="0 0 120 80" aria-hidden="true">${{
    welcome: '<rect x="14" y="14" width="92" height="52" rx="8" class="tp-line"/><circle cx="38" cy="40" r="10" class="tp-fill"/><path d="M58 34h34M58 46h22" class="tp-line"/>',
    ai: '<circle cx="40" cy="40" r="16" class="tp-fill"/><path d="M62 40h20M74 32l8 8-8 8" class="tp-line"/><rect x="86" y="26" width="22" height="28" rx="5" class="tp-line"/>',
    folders: '<path d="M14 26a5 5 0 0 1 5-5h18l6 6h40a5 5 0 0 1 5 5v30a5 5 0 0 1-5 5H19a5 5 0 0 1-5-5z" class="tp-line"/><rect x="30" y="38" width="16" height="16" rx="3" class="tp-fill"/><rect x="52" y="38" width="16" height="16" rx="3" class="tp-line"/><rect x="74" y="38" width="16" height="16" rx="3" class="tp-line"/>',
    project: '<rect x="18" y="16" width="84" height="48" rx="6" class="tp-line"/><path d="M32 32l-8 8 8 8M88 32l8 8-8 8M66 28l-12 24" class="tp-line"/>',
    done: '<circle cx="60" cy="40" r="24" class="tp-fill"/><path d="M48 40l8 8 16-16" class="tp-check"/>',
  }[step]}</svg>`;
  const body = {
    welcome: () => `<h2>Welcome to Rex Desk</h2><p>AI agents work on your projects here, and you chat with them like teammates. Four short steps get you ready.</p>
      <label class="st-field"><span>What should agents call you?</span><input data-tour-name value="${esc(ui.snap.config?.name || '')}" maxlength="60"></label>`,
    ai: () => { const current = account(); return `<h2>Your AI sign-in</h2><p>Agents run on your own Claude subscription, through Claude Code on this computer.</p>
      ${current?.loggedIn ? `<p class="tour-ok">Signed in as <b>${esc(current.account || current.label)}</b>. You are set.</p>` : '<p class="tour-warn">No Claude sign-in found yet.</p>'}
      <button type="button" class="btn" data-action="accounts">${current?.loggedIn ? 'Add or switch accounts' : 'Sign in to Claude'}</button>`; },
    folders: () => `<h2>Where things are kept</h2><p>These are good places to start. You can change any of them now, or later in Settings, Folders.</p>${foldersHtml(ctx, state)}`,
    project: () => `<h2>Add your first project</h2><p>Pick the folder of some code you work on, or type owner/name to bring it from GitHub. Rex Desk never changes your own copy: agents work in their own.</p>
      <div class="st-add"><input data-tour-repo placeholder="A folder, or owner/name on GitHub" spellcheck="false" aria-label="Project folder or GitHub repository"><button type="button" class="btn small" data-tour-browse>Browse…</button><button type="button" class="btn small primary" data-tour-add>Add</button></div>
      ${(ui.snap.config?.repositories || []).length ? `<p class="tour-ok">Added: ${ui.snap.config.repositories.map(repo => `<b>${esc(repo.name)}</b>`).join(', ')}</p>` : '<p class="muted">You can skip this and ask Rex Agent to add one later.</p>'}`,
    done: () => `<h2>You are ready</h2><p>Talk to <b>Rex Agent</b> first. Tell it what you work on, and it sets up an agent for each project.</p><p class="muted">Phone and other computers: Settings, Devices and phone. This tour is in Settings, General.</p>`,
  };
  const draw = () => {
    const step = STEPS[state.step];
    back.innerHTML = `<div class="tour-card" role="dialog" aria-modal="true" aria-label="Set up Rex Desk"><div class="tour-dots">${STEPS.map((id, index) => `<span class="${index === state.step ? 'on' : index < state.step ? 'done' : ''}"></span>`).join('')}</div>
      ${picture(step)}<div class="tour-body">${body[step]()}</div>
      <div class="tour-foot">${state.step && step !== 'done' ? '<button type="button" class="btn quiet" data-tour-back>Back</button>' : '<button type="button" class="btn quiet" data-tour-skip>Skip the tour</button>'}<span class="spacer"></span><button type="button" class="btn primary" data-tour-next>${step === 'done' ? 'Start' : step === 'project' && !(ui.snap.config?.repositories || []).length ? 'Skip for now' : 'Next'}</button></div></div>`;
  };
  const finish = async () => { back.remove(); try { ui.snap.config = await api('/config', { method: 'PUT', data: { ...ui.snap.config, tourDismissed: true } }); } catch (error) { toast(error.message, true); } void refresh(); };
  const saveName = async () => {
    const name = back.querySelector('[data-tour-name]')?.value.trim();
    if (name && name !== ui.snap.config?.name) ui.snap.config = await api('/config', { method: 'PUT', data: { ...ui.snap.config, name } });
  };
  back.addEventListener('click', async event => {
    const target = event.target;
    try {
      if (target.closest('[data-tour-skip]')) { await finish(); return; }
      if (target.closest('[data-tour-back]')) { state.step = Math.max(0, state.step - 1); draw(); return; }
      if (target.closest('[data-tour-next]')) {
        if (STEPS[state.step] === 'welcome') await saveName();
        if (STEPS[state.step] === 'done') { await finish(); return; }
        state.step += 1; draw(); return;
      }
      if (await folderClick(ctx, state, target, draw)) return;
      if (target.closest('[data-tour-browse]')) { const picked = await api('/repositories/pick', { method: 'POST', data: {} }).catch(() => null); if (picked?.path) back.querySelector('[data-tour-repo]').value = picked.path; return; }
      if (target.closest('[data-tour-add]')) {
        const button = target.closest('[data-tour-add]'); let folder = back.querySelector('[data-tour-repo]').value.trim();
        if (!folder) { toast('Type or browse to a project folder first.', true); return; }
        button.disabled = true; button.textContent = 'Adding…';
        try {
          if ((!/[\\:]/.test(folder) && /^[\w.-]+\/[\w.-]+$/.test(folder)) || /^https:\/\/github\.com\//.test(folder)) folder = (await api('/repositories/clone', { method: 'POST', data: { repository: folder } })).path;
          const found = await api('/repositories/inspect', { method: 'POST', data: { path: folder } }), config = ui.snap.config;
          if (!config.repositories.some(repo => repo.path.toLowerCase() === found.path.toLowerCase())) ui.snap.config = await api('/config', { method: 'PUT', data: { ...config, repositories: [...config.repositories, { name: found.name, path: found.path, baseBranch: found.preferredBranch || 'develop', targetBranch: found.preferredBranch || 'develop' }] } });
          toast(`Added ${found.name}.`);
        } finally { draw(); }
      }
    } catch (error) { toast(error.message, true); }
  });
  back.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.matches('[data-tour-repo]')) back.querySelector('[data-tour-add]')?.click(); });
  draw(); back.querySelector('[data-tour-next]')?.focus();
}

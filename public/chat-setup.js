import { t } from './i18n.js';
// Set up Rex Desk: a short checklist at the top of Rex Agent's chat that walks a new person from nothing (no account, no AI,
// no project) to a working team. Each step ticks itself from what Rex Desk already knows; none is asked of the person.
// It hides once every step is done, or when the person closes it, and /setup (in the Help list) opens it again.
const HIDDEN = 'rexdesk.setup.hidden', OPEN = 'rexdesk.setup.open';
const TICK = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5"/></svg>';
const CHEVRON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
const read = key => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const write = (key, on) => { try { on ? localStorage.setItem(key, '1') : localStorage.removeItem(key); } catch {} };

// What Rex Agent is asked when the person presses "Do it for me". Prompts for the agent, so they stay in English.
const ASK = {
  work: 'Help me add my work to Rex Desk. Ask me whether it is a code project (a folder on this computer or a GitHub link) or other work, like writing or marketing. Add the project, or make a named workspace for the other work, yourself.',
  agent: 'Create my first agent for the work I added. Ask me what it should help with, pick a short name, and create it yourself.',
  task: 'Give my first agent a small first task that fits its work, so I can see how it works, and show me its report when it is done.',
};

// The steps, each with whether it is done, one line of how, and what "Do it for me" does (an existing app action, or a message to Rex Agent).
export function setupSteps(snap = {}, ui = {}) {
  const agents = (snap.specialists || []).filter(agent => agent.kind !== 'main' && !agent.demo);
  const main = (snap.runs || []).some(run => run.role === 'coordinator' && run.main && !run.roomAgent && run.computer === snap.computer);
  const extras = [
    { id: 'room', title: t('Group chat'), done: (snap.rooms || []).length > 0, how: t('Put several agents in one chat to plan together.'), action: 'new-room' },
    { id: 'phone', title: t('Phone'), done: Boolean(snap.devices?.remote), how: t('Reach your agents from your phone.'), settings: 'devices' },
    { id: 'backup', title: t('Backup'), done: Boolean(snap.database?.space?.paid || snap.cloudSync), how: t('Keep a copy of your desk in your account.'), settings: 'backup' },
    { id: 'updates', title: t('Updates'), done: !snap.update?.supported || !(snap.update.available || snap.update.ready), how: t('Rex Desk updates itself; install one when it is ready.'), settings: 'backup' },
  ];
  return [
    { id: 'account', title: t('Sign in to your Rex Desk account'), done: Boolean(snap.account?.email || snap.database?.account), how: t('Use an email code, Google or GitHub.'), action: 'account-open' },
    { id: 'ai', title: t('Connect your AI'), done: ['codex', 'claude', 'gemini', 'openrouter'].some(id => ui.accounts?.[id]?.profiles?.some(item => item.loggedIn)), how: t('Sign in to the AI plan you already pay for (ChatGPT, Claude or Gemini), or add an OpenRouter key.'), action: 'accounts' },
    { id: 'hello', title: t('Send Rex Agent a first message'), done: main, how: t('Say what you work on. Rex Agent sets things up from there.'), focus: true },
    { id: 'work', title: t('Add your work'), done: (snap.config?.repositories || []).length > 0 || agents.some(agent => !agent.project), how: t('A project folder, or a named workspace for work that is not code.'), ask: ASK.work },
    { id: 'agent', title: t('Create your first agent'), done: agents.length > 0, how: t('An agent with its own name and job, for one project or workspace.'), ask: ASK.agent },
    { id: 'task', title: t('Give it a first task and see the report'), done: (snap.teamTasks || []).some(task => task.state === 'done') || (snap.tasks || []).some(task => !task.demo && task.status === 'done'), how: t('Ask your agent for one small job and read what it reports back.'), ask: ASK.task },
    { id: 'extras', title: t('Extras'), done: extras.every(item => item.done), how: t('Optional: group chat, phone, backup and updates.'), extras },
  ];
}

// The checklist bar; empty when it is hidden or every step is done (unless it was opened again from /setup).
export function setupHtml({ ui, esc }) {
  if (!ui.snap) return '';
  const steps = setupSteps(ui.snap, ui), done = steps.filter(step => step.done).length, all = done === steps.length;
  if (read(HIDDEN) || (all && !ui.setupShown)) return '';
  const open = read(OPEN) || ui.setupShown, next = steps.find(step => !step.done);
  const doIt = step => step.done ? '' : step.ask ? `<button type="button" class="btn small" data-action="setup-ask" data-step="${step.id}">${t`Do it for me`}</button>`
    : step.action ? `<button type="button" class="btn small" data-action="${step.action}">${t`Do it for me`}</button>`
    : step.settings ? `<button type="button" class="btn small" data-action="setup-settings" data-section="${step.settings}">${t`Open`}</button>`
    : step.focus ? `<button type="button" class="btn small" data-action="setup-focus">${t`Write it`}</button>` : '';
  const mark = (step, number) => `<span class="su-mark${step.done ? ' done' : ''}" role="img" aria-label="${step.done ? t('Done') : t('Not done yet')}">${step.done ? TICK : number}</span>`;
  const row = (step, index) => `<li class="su-row${step.done ? ' done' : ''}">${mark(step, index + 1)}<div class="su-text"><b>${esc(step.title)}</b><span>${esc(step.how)}</span>
    ${step.extras ? `<ul class="su-extras">${step.extras.map(item => `<li class="${item.done ? 'done' : ''}">${mark(item, '')}<span><b>${esc(item.title)}</b> ${esc(item.how)}</span>${doIt(item)}</li>`).join('')}</ul>` : ''}</div>${step.extras ? '' : doIt(step)}</li>`;
  return `<section class="su${open ? ' open' : ''}" aria-label="${t`Set up Rex Desk`}">
    <div class="su-head"><button type="button" class="su-toggle" data-action="setup-toggle" aria-expanded="${open}"><b>${t`Set up Rex Desk`}</b><span class="su-count">${t`${done} of ${steps.length} done`}</span>${!open && next ? `<span class="su-next">${t`Next:`} ${esc(next.title)}</span>` : ''}<span class="su-chev">${CHEVRON}</span></button>
      <progress max="${steps.length}" value="${done}" aria-hidden="true"></progress>
      <button type="button" class="icon-btn su-close" data-action="setup-hide" aria-label="${t`Hide the setup list`}" title="${t`Hide. Type /setup to open it again.`}"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div>
    ${open ? `<ol class="su-list">${steps.map(row).join('')}</ol>` : ''}</section>`;
}

// The checklist's own buttons. Returns true when the click was one of them; app actions it reuses (account-open, accounts,
// new-room) are handled by the app as usual.
export async function setupClick(ctx, action, target, { sendMain, settings, redraw }) {
  const { ui } = ctx;
  if (action === 'setup-toggle') { const open = !(read(OPEN) || ui.setupShown); write(OPEN, open); if (!open) ui.setupShown = false; redraw(); return true; }
  if (action === 'setup-hide') { write(HIDDEN, true); ui.setupShown = false; redraw(); return true; }
  if (action === 'setup-settings') { settings(target.dataset.section); return true; }
  if (action === 'setup-focus') { document.getElementById('draft')?.focus(); return true; }
  if (action === 'setup-ask') { const text = ASK[target.dataset.step]; if (text) await sendMain(text); return true; }
  return false;
}
// /setup: opens the list again, even when everything is done.
export function showSetup(ctx) { write(HIDDEN, false); write(OPEN, true); ctx.ui.setupShown = true; }

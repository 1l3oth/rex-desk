import { t } from './i18n.js';
import { netStage, loadNet } from './chat-net.js';
// The Experimental page: things still being tried out. Two tabs. Playbook shows the Rex Desk team as a live orchestration
// view (who is on it today, what each does) with a Use button that asks Rex Agent to set the same up on one of your projects;
// A2A holds the Connect another AI view, moved here from its own rail button and marked experimental.
const icon = (paths, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// A lab flask: experimental.
export const EXP_ICON = icon('<path d="M9 3h6M10 3v6.2L4.8 18a2 2 0 0 0 1.8 3h10.8a2 2 0 0 0 1.8-3L14 9.2V3"/><path d="M8.2 14h7.6"/>');

export function expTab(ui) { return ui.expTab === 'a2a' ? 'a2a' : 'playbook'; }

// The prompt the Use button sends to Rex Agent: he asks which project, then runs the two built-in setup skills.
const USE_PROMPT = t`Set up an AI team and its first playbook for one of my projects, the way the Rex Desk team works. Ask me which project, then use the rex-setup-orchestration and rex-setup-playbook skills to plan the team and its workflow, show me the plan, and create the agents and rules once I say yes.`;

// The Rex Desk team from live data: Rex Agent (the main agent) plus every specialist whose project is rex-desk.
function teamOf(ctx) {
  const all = ctx.ui.snap?.specialists || [];
  const main = all.find(agent => agent.kind === 'main') || null;
  const mates = all.filter(agent => agent.kind !== 'main' && agent.projectSlug === 'rex-desk' && !agent.remote);
  return { main, mates };
}

// How a task flows through the team, as the "All teams and how a task flows" drawing: step cards joined by flowing arrows,
// an amber gate card that waits for Rex, and the accent Rex card. Roles are the stable pipeline; the live team list below
// names who fills each one today.
function teamFlow(ctx) {
  const esc = ctx.esc;
  const steps = [
    { who: t`Rex`, say: t`Asks for a fix or feature`, cls: 'rex' },
    { who: t`Manager`, say: t`Routes the work, opens a room for big plans`, cls: '' },
    { who: t`QA`, say: t`Finds the cause`, cls: '' },
    { who: t`App / Web`, say: t`Fixes the code and runs the tests`, cls: '' },
    { who: t`Code Reviewer`, say: t`Reviews locally on this computer`, cls: '' },
    { who: t`Rex`, say: t`Sees the screenshots and says push`, cls: 'gate' },
    { who: t`App`, say: t`Pushes to master and builds with notes`, cls: '' },
  ];
  // One ordered list: a single aligned row on a wide pane, a straight column on a narrow one; the arrows are drawn by the CSS
  // between cards, so a wrap can never leave a loose arrow at the end of a line.
  const card = step => `<li class="pb-step${step.cls ? ` ${step.cls}` : ''}"><span class="pb-who">${esc(step.who)}</span><span class="pb-do">${esc(step.say)}</span></li>`;
  return `<ol class="pb-flow" aria-label="${t`How a task flows through the Rex Desk team`}">${steps.map(card).join('')}</ol>`;
}

// The playbook in use: the Rex Agent team, shown live, the flow a task moves through, and the rules it follows.
function playbookPanel(ctx) {
  const esc = ctx.esc;
  const { main, mates } = teamOf(ctx);
  const total = mates.length + (main ? 1 : 0);
  const mateRows = [main, ...mates].filter(Boolean)
    .map(agent => `<li class="exp-mate"><span class="exp-mate-name">${esc(agent.name)}</span>${agent.purpose ? `<span class="exp-mate-bio">${esc(agent.purpose)}</span>` : ''}</li>`).join('');
  const rules = [
    t`One branch per release: every task commits on release/<next version>, one commit per task, until the deploy.`,
    t`Commit format: type(area): #TaskID, short summary, AgentName. One line, English, no Claude co-author line.`,
    t`Any UI change: send Rex before and after screenshots and wait for his OK before it goes into a release.`,
    t`AI-slop check on every UI change: native macOS and Windows settings look, compact and quiet.`,
    t`Code review runs once for the whole release branch, all pending commits together.`,
    t`Every desktop build ships short plain English release notes.`,
    t`Nothing on drive C: worktrees, temp and test data live next to the project on its drive.`,
    t`No paid services without Rex's OK.`,
  ];
  const list = items => `<ul class="exp-list">${items.map(line => `<li>${esc(line)}</li>`).join('')}</ul>`;
  return `<div class="page exp"><article class="exp-doc">
    <section class="exp-sec exp-orch">
      <h3>${t`The Rex Desk team`}</h3>
      <p class="exp-quiet">${total ? t`${total} agents working today, each with one job.` : t`No agents set up yet.`}</p>
      <p class="exp-flow-cap">${t`How a task flows`}</p>
      ${teamFlow(ctx)}
      ${mateRows ? `<ul class="exp-team">${mateRows}</ul>` : ''}
      <div class="exp-use-row">
        <button type="button" class="exp-use" data-exp-act="use">${t`Use this on my project`}</button>
        <span class="exp-use-hint">${t`Rex asks which project, then sets up the same team and playbook.`}</span>
      </div>
    </section>
    <section class="exp-sec"><h3>${t`Work rules`}</h3>${list(rules)}</section>
  </article></div>`;
}

export function expStage(ctx) {
  const tab = expTab(ctx.ui);
  const tabs = `<div class="kg-switch" role="tablist" aria-label="${t`Experimental`}">
    <button type="button" role="tab" aria-selected="${tab === 'playbook'}" class="${tab === 'playbook' ? 'on' : ''}" data-exp-tab="playbook">${t`Playbook`}</button>
    <button type="button" role="tab" aria-selected="${tab === 'a2a'}" class="${tab === 'a2a' ? 'on' : ''}" data-exp-tab="a2a">${t`A2A`}</button>
  </div>`;
  if (tab === 'a2a') {
    const net = netStage(ctx);
    return { title: t('Experimental'), meta: t`Connect another AI`, top: true, feed: net.feed,
      actions: `${tabs}<span class="exp-flag">${t`Experimental`}</span>${net.actions || ''}` };
  }
  return { title: t('Experimental'), meta: t`Rex Agent team playbook`, top: true, feed: playbookPanel(ctx),
    actions: `${tabs}<span class="exp-flag">${t`Experimental`}</span>` };
}

export function wireExp(ctx) {
  document.addEventListener('click', event => {
    const use = event.target.closest?.('[data-exp-act="use"]');
    if (use) {
      event.preventDefault();
      ctx.askMain(USE_PROMPT).catch(error => ctx.toast(error.message, true));
      return;
    }
    const target = event.target.closest?.('[data-exp-tab]'); if (!target) return;
    event.preventDefault();
    const next = target.dataset.expTab === 'a2a' ? 'a2a' : 'playbook';
    if (expTab(ctx.ui) === next) return;
    ctx.ui.expTab = next;
    ctx.render();
    if (next === 'a2a') void loadNet(ctx).then(() => ctx.render()).catch(() => {});
  });
}

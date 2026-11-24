import { t } from './i18n.js';
import { netStage, loadNet } from './chat-net.js';
// The Experimental page: things still being tried out. Two tabs. Playbook shows how the Rex Agent team works; A2A holds the
// Connect another AI view, moved here from its own rail button and marked experimental.
const icon = (paths, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// A lab flask: experimental.
export const EXP_ICON = icon('<path d="M9 3h6M10 3v6.2L4.8 18a2 2 0 0 0 1.8 3h10.8a2 2 0 0 0 1.8-3L14 9.2V3"/><path d="M8.2 14h7.6"/>');

export function expTab(ui) { return ui.expTab === 'a2a' ? 'a2a' : 'playbook'; }

// The one playbook that is in use: the Rex Agent team. Kept short and plain.
function playbookPanel() {
  const team = [
    t`Rex Agent runs over every team and only picks up cross-team plans.`,
    t`For Rex Desk, the Manager routes each piece of work to the QA, App or Web agent.`,
  ];
  const flow = [
    t`The Manager routes the work, and for bigger work opens a room to agree the plan first.`,
    t`QA finds the cause.`,
    t`The App agent fixes it; the Web agent takes the site and app UI.`,
    t`The Code Reviewer reviews locally on this computer.`,
    t`Rex says "push".`,
    t`The App agent pushes to master and builds the version with release notes.`,
  ];
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
  const samples = [
    [t`Orbit`, t`Rex's own task tool. Its own flow, not part of the Rex Agent team.`],
    [t`Flow and Morningmate`, t`Company (flow-was) tracker work, run its own way.`],
    [t`Personal`, t`Rex's personal projects and notes.`],
  ];
  const list = items => `<ul class="exp-list">${items.map(line => `<li>${line}</li>`).join('')}</ul>`;
  const steps = items => `<ol class="exp-steps">${items.map(line => `<li>${line}</li>`).join('')}</ol>`;
  return `<div class="page exp"><article class="exp-doc">
    <section class="exp-sec"><h3>${t`The team`}</h3>${list(team)}</section>
    <section class="exp-sec"><h3>${t`How a Rex Desk change moves`}</h3>${steps(flow)}</section>
    <section class="exp-sec"><h3>${t`Work rules`}</h3>${list(rules)}</section>
    <section class="exp-sec exp-samples"><h3>${t`Sample playbooks`}</h3>
      <p class="exp-quiet">${t`Not part of the Rex Agent team playbook. Here as examples only.`}</p>
      <div class="exp-cards">${samples.map(([name, line]) => `<div class="exp-card"><b>${name}</b><span>${line}</span></div>`).join('')}</div>
    </section>
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
  return { title: t('Experimental'), meta: t`Rex Agent team playbook`, top: true, feed: playbookPanel(),
    actions: `${tabs}<span class="exp-flag">${t`Experimental`}</span>` };
}

export function wireExp(ctx) {
  document.addEventListener('click', event => {
    const target = event.target.closest?.('[data-exp-tab]'); if (!target) return;
    event.preventDefault();
    const next = target.dataset.expTab === 'a2a' ? 'a2a' : 'playbook';
    if (expTab(ctx.ui) === next) return;
    ctx.ui.expTab = next;
    ctx.render();
    if (next === 'a2a') void loadNet(ctx).then(() => ctx.render()).catch(() => {});
  });
}

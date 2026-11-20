// The tab bar on the right side of a chat: small icons grouped by kind (about the chat, the work, the code), with the
// open tab's name beside its icon. The other tabs show their name on hover. A count sits on the icon as a small badge.
const ICONS = {
  profile: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  team: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.8c1.5.6 2.6 1.9 3 4.2"/>',
  worktrees: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3.5-11.2 7.4"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 10l3 2.5-3 2.5M13 15h4"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;

// tabs: [{ id, label, icon, count, owed, group }]. Tabs of one group sit together; a thin line parts the groups.
export function sideTabsHtml(esc, { tabs, current, action, close = '' }) {
  let group = null;
  const buttons = tabs.map(tab => {
    const on = tab.id === current, split = group !== null && tab.group !== group ? '<span class="stab-sep" aria-hidden="true"></span>' : '';
    group = tab.group;
    const badge = tab.count ? `<span class="stab-n${tab.owed ? ' owed' : ''}">${tab.count > 99 ? '99+' : tab.count}</span>` : '';
    return `${split}<button type="button" class="stab${on ? ' on' : ''}" data-action="${action}" data-tab="${esc(tab.id)}" title="${esc(tab.label)}" aria-label="${esc(tab.label)}" aria-pressed="${on}">${icon(tab.icon || tab.id)}${on ? `<span class="stab-l">${esc(tab.label)}</span>` : ''}${badge}</button>`;
  }).join('');
  return `<div class="side-head stabs" role="toolbar">${buttons}<span class="spacer"></span>${close}</div>`;
}

// The Team tab: the tasks this agent gave to or took from other agents, and the sub-agents it ran, in one list.
// Each part comes as a finished side-body; only its rows are kept, under its own small heading.
export function crewHtml({ taskBody, taskCount, subBody, subCount, empty, labels }) {
  if (!taskCount && !subCount) return empty;
  const inner = html => String(html || '').replace(/^<div class="side-body[^"]*">/, '').replace(/<\/div>$/, '');
  const part = (title, count, body, cls) => count ? `<section class="crew-part ${cls}"><h3 class="crew-h">${title}<span class="cnt">${count}</span></h3>${inner(body)}</section>` : '';
  return `<div class="side-body crew">${part(labels.tasks, taskCount, taskBody, 'tm')}${part(labels.subs, subCount, subBody, 'sa-list')}</div>`;
}

// The picked side tab is kept for every chat (one for personal chats, one for group chats) and over a reload, so switching
// chats, a refresh or a new message never sends the panel back to the first tab.
export const savedSideTab = key => { try { return localStorage.getItem(`rex-side-tab-${key}`) || ''; } catch { return ''; } };
export const saveSideTab = (key, tab) => { try { localStorage.setItem(`rex-side-tab-${key}`, String(tab || '')); } catch { /* private window */ } return tab; };

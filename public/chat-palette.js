// Jump to anything: Ctrl+K (⌘K on a Mac), or the search in the window bar, opens one box that finds chats, agents, rooms,
// tasks, places and settings as you type. Arrow keys move, Enter opens, Escape closes. Works in the app and in a browser.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const ICON = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
  agent: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  room: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M15 14.5a5 5 0 0 1 6.5 5"/>',
  task: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  place: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  setting: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
};
const KIND_LABEL = { chat: 'Chat', agent: 'Agent', room: 'Group chat', task: 'Task', place: 'Place', setting: 'Settings' };
const PLACES = [['inbox', 'Needs you'], ['tasks', 'Tasks'], ['person', 'Knowledge'], ['jev', 'Jev'], ['monitor', 'Memory'], ['devices', 'Devices'], ['worktrees', 'Worktrees']];
const SETTINGS = [['general', 'General, look and theme'], ['notify', 'Notifications'], ['agents', 'Agents'], ['accounts', 'Claude accounts'], ['projects', 'Projects'], ['sources', 'Task sources'], ['jev', 'Jev and voice'], ['schedule', 'Schedule'], ['devices', 'Devices and phone'], ['backup', 'Backup and updates'], ['folders', 'Folders'], ['connect', 'Connect another AI']];

function everything() {
  const ui = window.__rexCtx?.ui, snap = ui?.snap || {};
  const out = [{ kind: 'chat', label: 'Rex Agent', hint: 'Knows every project', go: ['main', ''] }];
  for (const agent of snap.specialists || []) if (agent.kind !== 'main') out.push({ kind: 'agent', label: agent.name, hint: [agent.projectSlug, agent.status?.label].filter(Boolean).join(' · '), go: ['specialist', agent.id] });
  for (const room of snap.rooms || []) out.push({ kind: 'room', label: room.name, hint: `${(room.members || []).length} agents`, go: ['room', room.id] });
  for (const [type, label] of PLACES) out.push({ kind: 'place', label, hint: '', go: [type, ''] });
  for (const task of (snap.tasks || []).filter(item => !item.demo && (item.active || item.local)).slice(0, 400)) out.push({ kind: 'task', label: task.titleEn || task.title || 'Task', hint: `#${task.taskNumber || task.externalId || ''} ${task.statusName || task.status || ''}`.trim(), go: ['task', task.id] });
  for (const [section, label] of SETTINGS) out.push({ kind: 'setting', label, hint: 'Settings', setting: section });
  return out;
}
// Words in any order; the name counts more than the hint, and a match at the start counts most.
function score(item, words) {
  const name = item.label.toLowerCase(), hint = (item.hint || '').toLowerCase();
  let total = 0;
  for (const word of words) {
    if (name.startsWith(word)) total += 6; else if (name.includes(` ${word}`) || name.includes(`_${word}`)) total += 4; else if (name.includes(word)) total += 3; else if (hint.includes(word)) total += 1; else return 0;
  }
  return total + (item.kind === 'chat' || item.kind === 'agent' ? 1 : 0);
}

let box = null, picked = 0, shown = [];
function draw(query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = everything();
  shown = words.length ? all.map(item => [item, score(item, words)]).filter(([, value]) => value).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([item]) => item)
    : all.filter(item => item.kind !== 'task').slice(0, 10);
  picked = Math.min(picked, Math.max(0, shown.length - 1));
  box.querySelector('.cp-list').innerHTML = shown.length ? shown.map((item, index) => `<li role="option" class="${index === picked ? 'on' : ''}" aria-selected="${index === picked}" data-cp="${index}">
    <span class="cp-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[item.kind]}</svg></span>
    <span class="cp-name">${esc(item.label)}${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</span><span class="cp-kind">${KIND_LABEL[item.kind]}</span></li>`).join('')
    : '<li class="cp-empty">Nothing found</li>';
  box.querySelector('.cp-list li.on')?.scrollIntoView({ block: 'nearest' });
}
function go(item) {
  close();
  if (!item) return;
  if (item.setting) { document.querySelector('[data-action="settings-open"]')?.click(); setTimeout(() => document.querySelector(`[data-st-section="${item.setting}"]`)?.click(), 150); return; }
  window.__rexCtx?.open(...item.go);
}
export function openPalette() {
  if (box) { box.querySelector('input').focus(); return; }
  picked = 0;
  box = document.createElement('div'); box.className = 'cp-back';
  box.innerHTML = `<div class="cp" role="dialog" aria-label="Jump to"><label class="cp-input"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input type="text" placeholder="Search or jump to a chat, agent, task or setting" aria-label="Search" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></label>
    <ul class="cp-list" role="listbox"></ul><div class="cp-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span></div></div>`;
  document.body.append(box);
  const input = box.querySelector('input');
  input.addEventListener('input', () => { picked = 0; draw(input.value); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); picked = Math.min(shown.length - 1, picked + 1); draw(input.value); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); picked = Math.max(0, picked - 1); draw(input.value); }
    else if (event.key === 'Enter') { event.preventDefault(); go(shown[picked]); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  box.addEventListener('mousedown', event => { if (event.target === box) close(); });
  box.addEventListener('click', event => { const row = event.target.closest('[data-cp]'); if (row) go(shown[Number(row.dataset.cp)]); });
  box.addEventListener('mousemove', event => { const row = event.target.closest('[data-cp]'); if (row && Number(row.dataset.cp) !== picked) { picked = Number(row.dataset.cp); for (const item of box.querySelectorAll('[data-cp]')) item.classList.toggle('on', Number(item.dataset.cp) === picked); } });
  draw('');
  input.focus();
}
function close() { box?.remove(); box = null; }

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); if (box) close(); else openPalette(); }
});
document.addEventListener('click', event => { if (event.target.closest?.('[data-palette-open]')) openPalette(); });

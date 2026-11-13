// What an agent is doing, shown as short lines between its messages. Consecutive steps fold into one group that stays open while the agent works.
const clip = (value, size = 70) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };
const base = value => String(value || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');

// A plain-words line for one tool call. Unknown tools still get a readable line.
export function toolLine(item) {
  const input = item.input || {}, tool = item.tool || 'a tool';
  const known = {
    desk_memory: () => `Reads project memory: ${clip(input.page || 'index', 40)}`,
    desk_memory_note: () => `Saves a note to ${clip(input.project, 40)}`,
    desk_specialists: () => 'Checks which agents exist',
    desk_create_specialist: () => `Creates the agent “${clip(input.name, 40)}” for ${clip(input.project, 40)}`,
    desk_ask: () => (input.message ? `Asks you: ${clip(input.message, 110)}` : 'Asks you a question'),
    desk_message: () => 'Sends you a message',
    desk_tasks: () => 'Reads your issues', desk_task: () => 'Reads an issue', desk_repositories: () => 'Checks the repositories',
    desk_dispatch: () => 'Asks to start a run', desk_progress: () => `Sets progress: ${clip(input.status, 30)}`,
    desk_rooms: () => 'Checks its rooms', desk_room_read: () => 'Reads its room messages', desk_room_post: () => 'Posts in a room',
    Read: () => `Reads ${base(input.file_path)}`, Write: () => `Writes ${base(input.file_path)}`, Edit: () => `Edits ${base(input.file_path)}`, MultiEdit: () => `Edits ${base(input.file_path)}`,
    Glob: () => `Looks for files: ${clip(input.pattern, 50)}`, Grep: () => `Searches for “${clip(input.pattern, 40)}”`,
    Bash: () => input.description ? clip(input.description, 80) : `Runs ${clip(input.command, 80)}`, PowerShell: () => input.description ? clip(input.description, 80) : `Runs ${clip(input.command, 80)}`,
    WebFetch: () => `Opens ${clip(input.url, 60)}`, WebSearch: () => `Searches the web: ${clip(input.query, 50)}`,
  };
  if (item.failed) return `Something failed: ${clip(item.text, 120)}`;
  return (known[tool] || (() => `Uses ${tool.replaceAll('_', ' ')}`))();
}

// `openKeys` remembers which groups the reader opened or closed, so a refresh does not undo that.
export function stepsHtml(group, { esc, hhmm, live, openKeys, specialists, link }) {
  const key = String(group[0].at), last = group.at(-1);
  const state = openKeys.get(key), open = state === undefined ? live : state;
  const lines = group.map(item => {
    if ((item.tool === 'Bash' || item.tool === 'PowerShell') && item.id) {
      const out = item.output;
      return `<li class="step"><span class="when">${esc(hhmm(item.at))}</span><span class="what">${esc(toolLine(item))}</span><button type="button" class="linkish" data-term-focus="${esc(item.id)}">view</button><span class="tstate ${out ? (out.failed ? 'bad' : 'ok') : 'run'}">${out ? (out.failed ? 'failed' : 'done') : 'running…'}</span></li>`;
    }
    const created = item.tool === 'desk_create_specialist' ? specialists.find(agent => agent.name.toLowerCase() === String(item.input?.name || '').toLowerCase()) : null;
    if (item.change) return `<li class="step"><span class="when">${esc(hhmm(item.at))}</span><span class="what">${changeHtml(item.change, esc)}</span></li>`;
    return `<li class="step ${item.failed ? 'bad' : ''}"><span class="when">${esc(hhmm(item.at))}</span><span class="what">${esc(toolLine(item))}</span>${created ? link(created) : ''}</li>`;
  }).join('');
  const word = group.length === 1 ? '1 step' : `${group.length} steps`;
  return `<details class="steps" data-steps="${esc(key)}" ${open ? 'open' : ''}><summary><span class="count">${word}</span><span class="latest">${esc(toolLine(last))}</span></summary><ul>${lines}</ul></details>`;
}

// The terminal panel beside the chat: every shell command the agent ran, with its output.
export const terminalItems = items => items.filter(item => item.role === 'tool' && (item.tool === 'Bash' || item.tool === 'PowerShell') && item.id);
// One thin line per command: whether it passed, what it did in plain words (the agent's own description of the command),
// and how long it took. A line opens to show the command and the output that matters; a failed one opens by itself.
// Steps are grouped by the reply they belong to. In a group chat each line starts with the face of the agent who ran it.
const openTerm = new Set(), closedTerm = new Set();
const NOISE = /^(Shell cwd was reset to .*|\[This command modified .*)$/;
const took = (from, to) => { const seconds = Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000)); return !to || Number.isNaN(seconds) ? '' : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
document.addEventListener('toggle', event => { const box = event.target; if (!box.matches?.('details.tl')) return; const key = box.dataset.entry; if (box.open) { openTerm.add(key); closedTerm.delete(key); } else { openTerm.delete(key); closedTerm.add(key); } }, true);
export function terminalHtml(entries, { esc, hhmm, who = null }) {
  const groups = []; let last = null;
  for (const item of entries) { const at = new Date(item.at).getTime(); if (!last || at - last.end > 120000) groups.push(last = { start: at, end: at, items: [] }); last.items.push(item); last.end = at; }
  const failed = entries.filter(item => item.output?.failed).length, running = entries.filter(item => !item.output).length;
  const line = item => {
    const out = item.output, state = out ? (out.failed ? 'bad' : 'ok') : 'run', said = clip(item.input?.description || toolLine(item).replace(/^Runs /, ''), 90);
    const lines = String(out?.text || '').split(/\r?\n/).filter(text => text.trim() && !NOISE.test(text.trim())), shown = lines.slice(-6);
    const open = closedTerm.has(item.id) ? false : openTerm.has(item.id) || state === 'bad';
    const face = who ? who(item) : '';
    // "fail 0" and "0 failed" are good news.
    const tone = text => /\b(fail(?:ed|s)?\s*[:=]?\s*0|0\s+fail(?:ed|ures?)?)\b/i.test(text) ? 'ok' : /(error|exception|denied|not found|exceeded|✖|✗|\bfail)/i.test(text) ? 'bad' : /(\bpass|\bok\b|done|success|✔|✓)/i.test(text) ? 'ok' : '';
    return `<details class="tl ${state}" id="term-${esc(item.id)}" data-entry="${esc(item.id)}" data-state="${state}" data-find="${esc(`${said} ${item.input?.command || ''} ${lines.join(' ')}`.toLowerCase().slice(0, 4000))}" ${open ? 'open' : ''}>
      <summary>${face ? `<span class="tl-face">${face}<i class="tl-dot ${state}"></i></span>` : `<span class="tl-st ${state}" aria-label="${state === 'ok' ? 'Passed' : state === 'bad' ? 'Failed' : 'Running'}">${state === 'ok' ? '✓' : state === 'bad' ? '!' : ''}</span>`}<span class="tl-what" title="${esc(said)}">${esc(said)}</span><span class="tl-time">${state === 'run' ? '…' : esc(took(item.at, out?.createdAt || out?.at) || hhmm(item.at))}</span></summary>
      <div class="tl-body"><code class="tl-cmd"><span>${item.tool === 'PowerShell' ? 'PS&gt;' : '$'}</span> ${esc(item.input?.command || '')}</code>
        ${shown.length ? `<pre class="tl-out">${shown.map(text => `<span class="${tone(text)}">${esc(text)}</span>`).join('\n')}</pre>` : out ? '<p class="tl-none">No output.</p>' : '<p class="tl-none">Still running…</p>'}
        <div class="tl-links">${lines.length > shown.length ? `<button type="button" class="linkish" data-term-all="${esc(item.id)}">Show all ${lines.length} lines</button>` : ''}<button type="button" class="linkish" data-term-copy="${esc(item.id)}">Copy</button></div>
        <pre class="tl-full" hidden>${esc(lines.join('\n'))}</pre></div></details>`;
  };
  const body = groups.map(group => `<div class="tl-turn">${esc(hhmm(new Date(group.start).toISOString()))} · ${group.items.length} step${group.items.length === 1 ? '' : 's'}</div>${group.items.map(line).join('')}`).join('');
  const bar = `<div class="tl-bar" role="toolbar" aria-label="Show"><button type="button" class="on" data-term-show="all">All</button><button type="button" data-term-show="run">Running${running ? ` <b>${running}</b>` : ''}</button><button type="button" data-term-show="bad">Failed${failed ? ` <b class="bad">${failed}</b>` : ''}</button><label class="tl-find"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" placeholder="Search" aria-label="Search commands and output" data-term-find></label></div>`;
  return `<div class="side-head"><strong>Terminal</strong><span class="muted">${entries.length} command${entries.length === 1 ? '' : 's'}</span><span class="spacer"></span><button type="button" class="btn small" data-action="term-close" aria-label="Close the terminal panel">Close</button></div>${bar}<div class="side-body tl-list" id="side-body">${body || '<p class="tl-none">No commands yet.</p>'}</div>`;
}
// Filter and search the terminal in place: nothing is drawn again.
const termFilter = { show: 'all', words: '' };
const applyTerm = root => { for (const entry of (root || document).querySelectorAll('details.tl')) entry.hidden = (termFilter.show !== 'all' && entry.dataset.state !== termFilter.show) || (termFilter.words && !entry.dataset.find.includes(termFilter.words)); };
document.addEventListener('click', event => {
  const show = event.target.closest?.('[data-term-show]');
  if (show) { termFilter.show = show.dataset.termShow; for (const button of show.parentElement.querySelectorAll('[data-term-show]')) button.classList.toggle('on', button === show); applyTerm(); return; }
  const all = event.target.closest?.('[data-term-all]');
  if (all) { const entry = document.getElementById(`term-${all.dataset.termAll}`); entry.querySelector('.tl-out')?.remove(); entry.querySelector('.tl-full').hidden = false; all.remove(); return; }
  const copy = event.target.closest?.('[data-term-copy]');
  if (copy) { const entry = document.getElementById(`term-${copy.dataset.termCopy}`); void navigator.clipboard?.writeText(`${entry.querySelector('.tl-cmd').textContent.trim()}\n${entry.querySelector('.tl-full').textContent}`); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); }
});
document.addEventListener('input', event => { if (!event.target.matches?.('[data-term-find]')) return; termFilter.words = event.target.value.trim().toLowerCase(); applyTerm(); });
new MutationObserver(() => { if (termFilter.show !== 'all' || termFilter.words) applyTerm(); }).observe(document.documentElement, { childList: true, subtree: true });

// A file change the agent made: the file, +added −removed, and the changed lines when opened.
// Which ones the reader opened is remembered, so the next redraw of the chat does not close them again.
const openChanges = new Set();
const changeKey = change => [change.file, change.added, change.removed, change.created ? 1 : 0, (change.diff || []).length].join('|');
document.addEventListener('toggle', event => { const box = event.target; if (!box.matches?.('details.dfile')) return; if (box.open) openChanges.add(box.dataset.dfile); else openChanges.delete(box.dataset.dfile); }, true);
export function changeHtml(change, esc) {
  if (!change) return '';
  const key = changeKey(change);
  const name = String(change.file).split(/[\\/]/).filter(Boolean).slice(-3).join('/');
  const counts = `<span class="dchg add">+${change.added}</span><span class="dchg del">−${change.removed}</span>`;
  const body = change.hidden ? '<p class="muted small">Not shown: this file usually holds secrets.</p>'
    : change.diff.length ? `<pre class="diff">${change.diff.map(line => line === '…' ? '<span class="dgap">⋯</span>' : `<span class="${line[0] === '+' ? 'dadd' : 'ddel'}">${esc(line)}</span>`).join('')}${change.more ? `<span class="dgap">… ${change.more} more lines</span>` : ''}</pre>` : '<p class="muted small">No line changes.</p>';
  return `<details class="dfile" data-dfile="${esc(key)}" ${openChanges.has(key) ? 'open' : ''}><summary><span class="dname" title="${esc(change.file)}">${change.created ? 'Created' : 'Changed'} ${esc(name)}</span>${counts}</summary>${body}</details>`;
}

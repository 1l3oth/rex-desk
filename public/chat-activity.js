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
    Bash: () => `Runs ${clip(input.command, 80)}`, PowerShell: () => `Runs ${clip(input.command, 80)}`,
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
    return `<li class="step ${item.failed ? 'bad' : ''}"><span class="when">${esc(hhmm(item.at))}</span><span class="what">${esc(toolLine(item))}</span>${created ? link(created) : ''}</li>`;
  }).join('');
  const word = group.length === 1 ? '1 step' : `${group.length} steps`;
  return `<details class="steps" data-steps="${esc(key)}" ${open ? 'open' : ''}><summary><span class="count">${word}</span><span class="latest">${esc(toolLine(last))}</span></summary><ul>${lines}</ul></details>`;
}

// The terminal panel beside the chat: every shell command the agent ran, with its output.
export const terminalItems = items => items.filter(item => item.role === 'tool' && (item.tool === 'Bash' || item.tool === 'PowerShell') && item.id);
export function terminalHtml(entries, { esc, hhmm }) {
  const body = entries.map(item => {
    const out = item.output, state = out ? (out.failed ? 'failed' : 'done') : 'running…';
    return `<section class="tentry" id="term-${esc(item.id)}" data-entry="${esc(item.id)}"><div class="tcmd"><span class="prompt">${item.tool === 'PowerShell' ? 'PS&gt;' : '$'}</span><span class="cmdtext">${esc(item.input?.command || '')}</span></div><pre class="tout">${esc(out?.text || '')}</pre><div class="tfoot"><span>${esc(hhmm(item.at))}</span><span class="tstate ${out ? (out.failed ? 'bad' : 'ok') : 'run'}">${state}</span></div></section>`;
  }).join('');
  return `<div class="side-head"><strong>Terminal</strong><span class="muted">${entries.length} command${entries.length === 1 ? '' : 's'}</span><span class="spacer"></span><button type="button" class="btn small" data-action="term-close" aria-label="Close the terminal panel">Close</button></div><div class="side-body" id="side-body">${body}</div>`;
}

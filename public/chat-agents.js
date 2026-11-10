// Specialist agents: one identity per project. The card shows who the agent is and what it was told; the person can rename, edit or duplicate it.
const providerName = name => name === 'codex' ? 'Codex' : 'Claude Code';

export function agentsRail(ctx) {
  const { ui, railItem } = ctx, agents = ui.snap.specialists || [];
  const items = agents.length ? agents.map(agent => railItem('specialist', agent.id, { name: agent.name, sub: `${agent.projectSlug} · ${providerName(agent.provider)}${agent.cloneOf ? ' · duplicate' : ''}` })).join('')
    : '<p class="rail-empty">No agents yet. Open a project and press Create agent.</p>';
  return `<h3>Agents <button data-action="spec-new" title="New agent" aria-label="New agent">+</button></h3>${items}`;
}

export function agentStage(ctx) {
  const { ui, esc, initials } = ctx, agent = (ui.snap.specialists || []).find(item => item.id === ui.view.id);
  if (!agent) return { title: 'Agent', meta: '', feed: '<div class="empty"><h2>That agent is gone.</h2></div>' };
  const origin = agent.cloneOf ? (ui.snap.specialists || []).find(item => item.id === agent.cloneOf) : null;
  const feed = `<div class="page"><section class="idcard" data-agent="${esc(agent.id)}">
    <div class="idhead"><div class="avatar big">${esc(initials(agent.name))}</div>
      <div class="idname"><label>Name<input id="sp-name" type="text" maxlength="40" value="${esc(agent.name)}"></label><button class="btn small" data-action="spec-rename">Rename</button></div></div>
    <div class="idmeta"><span class="chip">Project: <a href="#" data-open="project" data-id="${esc(agent.projectSlug)}">${esc(agent.projectSlug)}</a></span><span class="chip">Created by ${esc(agent.createdBy)}</span>${origin ? `<span class="chip">Duplicate of ${esc(origin.name)}</span>` : ''}</div>
    <p class="path"><code>${esc(agent.projectPath)}</code></p>
    <h3>What this project is for</h3><p class="md">${esc(agent.purpose || 'Not recorded yet.')}</p>
    <label>Rules from you<textarea id="sp-rules" rows="5" placeholder="How this agent should work on this project. For example: ask before changing the database.">${esc(agent.rules)}</textarea></label>
    <label>Still not sure about (one per line)<textarea id="sp-unsure" rows="3">${esc((agent.unsure || []).join('\n'))}</textarea></label>
    <div class="idrow"><label>Agent<select id="sp-provider"><option value="claude" ${agent.provider === 'claude' ? 'selected' : ''}>Claude Code</option><option value="codex" ${agent.provider === 'codex' ? 'selected' : ''}>Codex</option></select></label>
      <label>Model<input id="sp-model" type="text" maxlength="80" value="${esc(agent.model || '')}" placeholder="default"></label></div>
    <div class="row"><button class="btn primary" data-action="spec-save">Save</button><button class="btn" data-action="spec-duplicate">Duplicate with another name</button><span class="spacer"></span><button class="btn danger" data-action="spec-remove">Remove</button></div>
  </section></div>`;
  return { title: agent.name, meta: `${providerName(agent.provider)} · ${agent.projectSlug}`, feed };
}

function dialog(ctx, { title, nameValue = '', projects = null, submit }) {
  const { esc, toast } = ctx, back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog"><h2>${esc(title)}</h2><label>Name<input type="text" name="name" value="${esc(nameValue)}" maxlength="40" required></label>${projects ? `<label>Project<select name="project" required>${projects.map(project => `<option value="${esc(project.slug)}" ${project.selected ? 'selected' : ''}>${esc(project.slug)}</option>`).join('')}</select></label>` : ''}<div class="row"><button class="btn primary">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`;
  document.body.append(back); back.querySelector('input').select();
  back.addEventListener('click', event => { if (event.target === back || event.target.dataset.close !== undefined) back.remove(); });
  back.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await submit(Object.fromEntries(new FormData(event.target))); back.remove(); } catch (error) { toast(error.message, true); }
  });
}

export async function agentAction(ctx, action) {
  const { ui, api, toast, refresh, open } = ctx, value = id => document.getElementById(id)?.value ?? '';
  const agent = (ui.snap.specialists || []).find(item => item.id === ui.view.id);
  if (action === 'spec-new') {
    const projects = ui.memory?.projects || [];
    if (!projects.length) return toast('Scan this computer for projects first (the ↻ button).', true);
    const current = ui.view.type === 'project' ? ui.view.id : '';
    return dialog(ctx, { title: 'New agent', projects: projects.map(project => ({ slug: project.slug, selected: project.slug === current })), submit: async form => {
      const created = await api('/specialists', { method: 'POST', data: { name: form.name, projectSlug: form.project } }); await refresh(); open('specialist', created.id); } });
  }
  if (!agent) return;
  if (action === 'spec-rename') { await api(`/specialists/${agent.id}/rename`, { method: 'POST', data: { name: value('sp-name') } }); toast('Renamed.'); await refresh({ full: true }); }
  else if (action === 'spec-save') {
    await api(`/specialists/${agent.id}`, { method: 'PUT', data: { rules: value('sp-rules'), unsure: value('sp-unsure').split('\n'), provider: value('sp-provider'), model: value('sp-model') } });
    toast('Saved. Other agents can read this card in .rexdesk.'); await refresh();
  } else if (action === 'spec-duplicate') {
    dialog(ctx, { title: `Duplicate ${agent.name}`, nameValue: `${agent.name} 2`, submit: async form => {
      const copy = await api(`/specialists/${agent.id}/duplicate`, { method: 'POST', data: { name: form.name } }); await refresh(); open('specialist', copy.id); toast('Duplicated. It has the same project and rules, and its own conversation.'); } });
  } else if (action === 'spec-remove') {
    if (!confirm(`Remove ${agent.name}? Its card is deleted. Past runs stay.`)) return;
    await api(`/specialists/${agent.id}`, { method: 'DELETE' }); await refresh(); open('main');
  }
}

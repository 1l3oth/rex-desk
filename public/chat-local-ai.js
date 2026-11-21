import { askConfirm } from './confirm.js';
import { t } from './i18n.js';
import { skeletonHtml } from './chat-skeleton.js';
// Settings, Local AI: models that run on this computer instead of Claude. Ollama downloads and runs them (from its own
// library or from Hugging Face); any other local server that speaks the OpenAI API can be added by its address.
// An agent uses one by picking it in its model list, where it shows as "on this computer".

// A few good starting points, smallest first, with roughly how much memory each needs to run.
const SUGGESTED = [
  ['qwen3:4b', t('Qwen3 4B'), t('About 3 GB. Runs on most laptops; fine for small jobs.')],
  ['qwen3:8b', t('Qwen3 8B'), t('About 5 GB. A good first choice with 16 GB of memory.')],
  ['qwen2.5-coder:7b', t('Qwen2.5 Coder 7B'), t('About 5 GB. Made for code.')],
  ['qwen3-coder:30b', t('Qwen3 Coder 30B'), t('About 19 GB. Much better at code; needs a strong computer.')],
];
const ICON = {
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
};
const icon = name => `<span class="st-folder-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg></span>`;
const size = bytes => !bytes ? '' : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

export async function loadLocalAi({ api }, state) {
  state.localAi = await api('/local-ai').catch(error => ({ error: error.message }));
  return state.localAi;
}

export function localAiHtml({ esc }, state) {
  const data = state.localAi;
  if (!data) return skeletonHtml(3);
  if (data.error) return `<p class="error-text">${esc(t(data.error))}</p>`;
  const ollama = data.servers.find(item => item.id === 'ollama'), others = data.servers.filter(item => item.id !== 'ollama');
  const pulls = (data.pulls || []).filter(item => item.state !== 'done');
  const working = pulls.some(item => item.state === 'downloading');
  const modelRow = (server, model) => `<li class="la-model"><div><b>${esc(model.name)}</b><small>${[model.params, size(model.size)].filter(Boolean).map(esc).join(' · ')}${model.tools ? '' : ` · <span class="error-text">${t`Cannot use tools, so agents cannot work with it`}</span>`}</small></div>
    ${server.kind === 'ollama' ? `<button type="button" class="btn" data-la-remove="${esc(model.name)}">${t`Remove`}</button>` : ''}</li>`;
  const pullRow = job => {
    const percent = job.total ? Math.floor((job.completed / job.total) * 100) : 0;
    return `<li class="la-pull"><div><b>${esc(job.model)}</b><small>${job.state === 'failed' ? `<span class="error-text">${esc(t(job.error))}</span>` : `${esc(job.status)}${job.total ? ` · ${percent}% of ${size(job.total)}` : ''}`}</small></div>
      ${job.state === 'downloading' && job.total ? `<progress max="100" value="${percent}"></progress>` : ''}</li>`;
  };
  const hf = state.localHf || {};
  const ollamaCard = `<div class="st-folder la-card">${icon('chip')}<div class="st-folder-text"><b>${t`Ollama`}</b>
      <small>${ollama.running ? t`Running at ${`<code>${esc(ollama.url)}</code>`}` : t('Not on this computer, or not open. Press Set up for me: Rex Desk installs it, starts it and downloads a first model.')}</small>
      ${ollama.running ? (ollama.models.length ? `<ul class="la-models">${ollama.models.map(model => modelRow(ollama, model)).join('')}</ul>` : `<small>${t`No models yet. Download one below.`}</small>`) : ''}
    </div><div class="la-actions">${ollama.running ? '' : `<button type="button" class="btn primary" data-la-setup>${t`Set up for me`}</button>`}<button type="button" class="btn" data-la-check>${t`Check again`}</button></div></div>`;
  const download = ollama.running ? `<h3>${t`Download a model`}</h3>
    <p class="muted">${t`Models are big files. Ollama keeps them in its own folder, usually on drive C.`}</p>
    <div class="la-suggest">${SUGGESTED.map(([id, title, help]) => `<button type="button" class="la-pick" data-la-pull="${esc(id)}"><b>${esc(title)}</b><small>${esc(help)}</small></button>`).join('')}</div>
    <div class="la-row"><input data-la-name placeholder="${t`Any Ollama model, like gemma3:12b`}" spellcheck="false" aria-label="${t`Model name`}"><button type="button" class="btn" data-la-pull-name>${t`Download`}</button></div>
    <h3>${t`From Hugging Face`}</h3>
    <p class="muted">${t`Search the models people share on Hugging Face. Only ones Ollama can run (GGUF files) are shown.`}</p>
    <div class="la-row"><input data-la-hf value="${esc(hf.query || '')}" placeholder="${t`Search, like Qwen3 coder`}" spellcheck="false" aria-label="${t`Search Hugging Face`}"><button type="button" class="btn" data-la-hf-search>${hf.busy ? t('Searching…') : t('Search')}</button></div>
    ${hf.error ? `<p class="error-text">${esc(t(hf.error))}</p>` : ''}
    ${hf.items ? (hf.items.length ? `<ul class="la-models">${hf.items.map(item => `<li class="la-model"><div><b>${esc(item.repo)}</b><small>${t`${item.downloads.toLocaleString()} downloads`}</small></div><button type="button" class="btn" data-la-pull="${esc(item.pull)}">${t`Download`}</button></li>`).join('')}</ul>` : `<p class="muted">${t`Nothing found.`}</p>`) : ''}` : '';
  const serverCard = server => `<div class="st-folder la-card">${icon('server')}<div class="st-folder-text"><b>${esc(server.name)}</b>
      <small>${server.running ? t`Running at ${`<code>${esc(server.url)}</code>`}` : t`Not answering at ${`<code>${esc(server.url)}</code>`}. Start its server, then press Check again.`}</small>
      ${server.running && server.models.length ? `<ul class="la-models">${server.models.map(model => modelRow(server, model)).join('')}</ul>` : ''}
    </div><div class="la-actions"><button type="button" class="btn" data-la-drop="${esc(server.id)}">${t`Remove`}</button></div></div>`;
  const form = state.localAdd ? `<div class="la-add">
      <label class="st-field"><span>${t`Name`}</span><input data-la-add="name" placeholder="${t`LM Studio`}" value="${esc(state.localAdd.name || '')}"></label>
      <label class="st-field"><span>${t`Address`}</span><input data-la-add="url" placeholder="http://127.0.0.1:1234/v1" spellcheck="false" value="${esc(state.localAdd.url || '')}"><small>${t`The address of its OpenAI-style server, ending in /v1. LM Studio: http://127.0.0.1:1234/v1. llama.cpp: http://127.0.0.1:8080/v1.`}</small></label>
      <label class="st-field"><span>${t`Key (only if it asks for one)`}</span><input data-la-add="apiKey" type="password" autocomplete="off"></label>
      ${state.localAdd.error ? `<p class="error-text">${esc(t(state.localAdd.error))}</p>` : ''}
      <div class="la-row"><button type="button" class="btn primary" data-la-add-save>${t`Add server`}</button><button type="button" class="btn" data-la-add-cancel>${t`Cancel`}</button></div></div>`
    : `<button type="button" class="btn" data-la-add-open>${t`Add a local server`}</button>`;
  return `<p class="muted">${t`Agents can use an AI model that runs on this computer instead of Claude. It is free and private, but on most computers it is much slower and makes more mistakes than Claude. To use one, pick it in an agent's model list, where it shows as "on this computer".`}</p>
    ${ollamaCard}
    ${pulls.length ? `<h3>${working ? t('Working on it') : t('Did not finish')}</h3><ul class="la-models">${pulls.map(pullRow).join('')}</ul>` : ''}
    ${download}
    <h3>${t`Other local servers`}</h3>
    <p class="muted">${t`LM Studio, llama.cpp, vLLM, Colibri or any app that runs a model and offers an OpenAI-style server.`}</p>
    ${others.map(serverCard).join('')}
    ${form}`;
}

// Returns true when the click was one of Local AI's buttons.
export async function localAiClick(ctx, state, target, draw) {
  const { api, toast } = ctx;
  const reload = async () => { await loadLocalAi(ctx, state); draw(); };
  if (target.closest('[data-la-setup]')) { try { await api('/local-ai/setup', { method: 'POST', data: {} }); toast(t('Setting up Local AI. This can take a few minutes.')); } catch (error) { toast(error.message); } await reload(); follow(ctx, state, draw); return true; }
  if (target.closest('[data-la-check]')) { state.localAi = null; draw(); await reload(); return true; }
  const pull = target.closest('[data-la-pull]')?.dataset.laPull || (target.closest('[data-la-pull-name]') ? document.querySelector('[data-la-name]')?.value.trim() : '');
  if (target.closest('[data-la-pull],[data-la-pull-name]')) {
    if (!pull) { toast(t('Write a model name first.')); return true; }
    try { await api('/local-ai/pull', { method: 'POST', data: { model: pull } }); toast(t`Downloading ${pull}.`); } catch (error) { toast(error.message); }
    await reload(); follow(ctx, state, draw); return true;
  }
  const remove = target.closest('[data-la-remove]');
  if (remove) {
    if (!await askConfirm(t`Remove ${remove.dataset.laRemove} from this computer? Agents set to it go back to their usual model.`)) return true;
    try { state.localAi = await api(`/local-ai/models?model=${encodeURIComponent(remove.dataset.laRemove)}`, { method: 'DELETE' }); } catch (error) { toast(error.message); }
    draw(); return true;
  }
  if (target.closest('[data-la-hf-search]')) {
    const query = document.querySelector('[data-la-hf]')?.value.trim() || '';
    state.localHf = { query, busy: true }; draw();
    try { state.localHf = { query, items: (await api(`/local-ai/huggingface?q=${encodeURIComponent(query)}`)).items }; }
    catch (error) { state.localHf = { query, error: t`Could not search Hugging Face: ${error.message}` }; }
    draw(); return true;
  }
  if (target.closest('[data-la-add-open]')) { state.localAdd = {}; draw(); return true; }
  if (target.closest('[data-la-add-cancel]')) { state.localAdd = null; draw(); return true; }
  if (target.closest('[data-la-add-save]')) {
    const read = key => document.querySelector(`[data-la-add="${key}"]`)?.value.trim() || '';
    const input = { name: read('name') || t('Local server'), url: read('url'), apiKey: read('apiKey'), kind: 'openai' };
    try { state.localAi = await api('/local-ai/servers', { method: 'POST', data: input }); state.localAdd = null; toast(t('Added.')); }
    catch (error) { state.localAdd = { ...input, apiKey: '', error: error.message }; }
    draw(); return true;
  }
  const drop = target.closest('[data-la-drop]');
  if (drop) {
    if (!await askConfirm(t('Remove this server from Rex Desk? The app itself and its models stay on your computer.'))) return true;
    try { state.localAi = await api(`/local-ai/servers?id=${encodeURIComponent(drop.dataset.laDrop)}`, { method: 'DELETE' }); } catch (error) { toast(error.message); }
    draw(); return true;
  }
  return false;
}

// While a model downloads, its progress refreshes every 2 seconds (only while Local AI is the open section).
function follow(ctx, state, draw) {
  if (state.localFollow) return;
  state.localFollow = setInterval(async () => {
    if (state.section !== 'localai' || !document.querySelector('.settings-pop')) { clearInterval(state.localFollow); state.localFollow = null; return; }
    await loadLocalAi(ctx, state);
    const busy = (state.localAi?.pulls || []).some(item => item.state === 'downloading');
    // Typing in a box is not interrupted by the refresh.
    if (!document.activeElement?.matches?.('[data-la-name],[data-la-hf],[data-la-add]')) draw();
    if (!busy) { clearInterval(state.localFollow); state.localFollow = null; }
  }, 2000);
}

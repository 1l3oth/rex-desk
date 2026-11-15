import { randomUUID } from 'node:crypto';

// Local AI: agents keep Claude Code and all its tools, but the model behind it runs on this computer.
// Two kinds of local server:
// - Ollama: speaks Claude Code's own language (the Anthropic Messages API), so Claude Code talks to it directly.
//   Rex Desk also lists its models and downloads new ones, from Ollama's library or from Hugging Face.
// - Any server that speaks the OpenAI chat API (LM Studio, llama.cpp, vLLM, Colibri and the like): Claude Code talks to
//   Rex Desk's bridge (/local-ai/<server>/v1/messages), which translates each request and its streamed answer.
// A local model shows up in the Claude Code model list as "local:<server>/<model>", next to Opus and Sonnet.

export const OLLAMA_URL = (process.env.OLLAMA_HOST ? (/^https?:\/\//.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://127.0.0.1:11434').replace(/\/$/, '');
const KINDS = ['ollama', 'openai'];
const cleanUrl = value => {
  const text = String(value || '').trim().replace(/\/+$/, '');
  let parsed; try { parsed = new URL(text); } catch { throw new Error('Give the server address, like http://127.0.0.1:1234/v1.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The address starts with http:// or https://.');
  return text;
};
const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'server';

export const localModelId = (serverId, model) => `local:${serverId}/${model}`;
export function parseLocalModel(id) {
  const match = String(id || '').match(/^local:([a-z0-9-]+)\/(.+)$/);
  return match ? { serverId: match[1], model: match[2] } : null;
}
export const isLocalModel = id => Boolean(parseLocalModel(id));

async function getJson(url, { fetcher = fetch, timeoutMs = 4000, headers = {} } = {}) {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}
const sizeLabel = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

export class LocalAi {
  constructor(store, { fetcher = fetch } = {}) { this.store = store; this.fetcher = fetcher; this.pulls = new Map(); }
  // The person's servers. Ollama is always there (at its usual address); it simply shows as not running when it is not.
  servers() {
    const saved = this.store.get('local-ai', 'servers')?.items || [];
    const ollama = saved.find(item => item.id === 'ollama') || { id: 'ollama', kind: 'ollama', name: 'Ollama', url: OLLAMA_URL };
    return [ollama, ...saved.filter(item => item.id !== 'ollama')];
  }
  server(id) { return this.servers().find(item => item.id === id) || null; }
  saveServers(items) { this.store.put('local-ai', 'servers', { id: 'servers', items }); }
  addServer({ name, url, kind = 'openai', apiKey = '' } = {}) {
    if (!KINDS.includes(kind)) throw new Error('Choose Ollama or another local server.');
    const title = String(name || '').trim().slice(0, 40) || 'Local server', address = cleanUrl(url);
    const taken = new Set(this.servers().map(item => item.id)); let id = slug(title); for (let n = 2; taken.has(id); n++) id = `${slug(title)}-${n}`;
    const item = { id, kind, name: title, url: address, ...(apiKey ? { apiKey: String(apiKey).slice(0, 500) } : {}) };
    this.saveServers([...this.servers(), item]); return item;
  }
  updateServer(id, { url, name } = {}) {
    const items = this.servers().map(item => item.id === id ? { ...item, ...(url !== undefined ? { url: cleanUrl(url) } : {}), ...(name ? { name: String(name).trim().slice(0, 40) } : {}) } : item);
    this.saveServers(items); return items.find(item => item.id === id);
  }
  removeServer(id) {
    if (id === 'ollama') throw new Error('Ollama stays in the list; it shows as not running when it is not installed.');
    this.saveServers(this.servers().filter(item => item.id !== id));
    const kept = this.store.get('models', 'local')?.items || [];
    this.store.put('models', 'local', { id: 'local', items: kept.filter(item => !item.id.startsWith(`local:${id}/`)) });
  }
  // What each server has right now. A model that cannot use tools cannot work as an agent, so it is listed but not offered.
  async serverModels(server) {
    const auth = server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {};
    if (server.kind === 'ollama') {
      const tags = await getJson(`${server.url}/api/tags`, { fetcher: this.fetcher });
      return Promise.all((tags.models || []).map(async item => {
        let tools = true, context = 0;
        try {
          const shown = await (await this.fetcher(`${server.url}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: item.name }), signal: AbortSignal.timeout(4000) })).json();
          if (Array.isArray(shown.capabilities)) tools = shown.capabilities.includes('tools');
          context = Number(Object.entries(shown.model_info || {}).find(([key]) => key.endsWith('.context_length'))?.[1]) || 0;
        } catch {}
        return { name: item.name, size: item.size || 0, params: item.details?.parameter_size || '', tools, context };
      }));
    }
    const list = await getJson(`${server.url}/models`, { fetcher: this.fetcher, headers: auth });
    return (list.data || []).map(item => ({ name: String(item.id), size: 0, params: '', tools: true, context: 0 }));
  }
  // Every server and its models, and the Claude Code model list entries kept for the pickers. A server that does not
  // answer keeps its last known models, so an agent set to one is not reset just because the server is closed for a moment.
  async status() {
    const previous = this.store.get('models', 'local')?.items || [];
    const servers = await Promise.all(this.servers().map(async server => {
      try { return { ...server, apiKey: server.apiKey ? 'set' : '', running: true, models: await this.serverModels(server) }; }
      catch { return { ...server, apiKey: server.apiKey ? 'set' : '', running: false, models: [] }; }
    }));
    const items = [];
    for (const server of servers) {
      if (!server.running) { items.push(...previous.filter(item => item.id.startsWith(`local:${server.id}/`))); continue; }
      for (const model of server.models) if (model.tools) items.push({ id: localModelId(server.id, model.name), label: `${model.name} · on this computer`, hint: `Free and private, runs with ${server.name}. Slower than Claude.`, local: true });
    }
    this.store.put('models', 'local', { id: 'local', items, at: new Date().toISOString() });
    return { servers, pulls: [...this.pulls.values()] };
  }

  // Downloads a model into Ollama: a name from Ollama's library (qwen3:8b) or a Hugging Face model (hf.co/<user>/<repo>[:quant]).
  pull(name) {
    const model = String(name || '').trim().replace(/^https:\/\/huggingface\.co\//i, 'hf.co/');
    if (!/^[\w.\-/:]{2,200}$/.test(model)) throw new Error('Give a model name, like qwen3:8b or hf.co/Qwen/Qwen3-8B-GGUF.');
    const server = this.server('ollama');
    const existing = [...this.pulls.values()].find(item => item.model === model && item.state === 'downloading'); if (existing) return existing;
    const job = { id: randomUUID(), model, state: 'downloading', status: 'Starting', completed: 0, total: 0, error: '' };
    this.pulls.set(job.id, job);
    void (async () => {
      try {
        const response = await this.fetcher(`${server.url}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
        if (!response.ok || !response.body) throw new Error(response.status === 404 ? 'Ollama could not find that model.' : `Ollama answered ${response.status}.`);
        const decoder = new TextDecoder(); let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let at; while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1); if (!line) continue;
            const part = JSON.parse(line);
            if (part.error) throw new Error(part.error);
            job.status = part.status || job.status;
            if (part.total) { job.total = part.total; job.completed = part.completed || 0; }
          }
        }
        job.state = 'done'; job.status = 'Downloaded';
        await this.status().catch(() => {});
      } catch (error) {
        job.state = 'failed'; job.error = /fetch failed|ECONNREFUSED/i.test(error.message) ? 'Ollama is not running. Open Ollama, then try again.' : error.message;
      }
      setTimeout(() => this.pulls.delete(job.id), 10 * 60000).unref?.();
    })();
    return job;
  }
  async remove(name) {
    const server = this.server('ollama');
    const response = await this.fetcher(`${server.url}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: String(name) }) });
    if (!response.ok) throw new Error(`Ollama could not remove it (${response.status}).`);
    return this.status();
  }
  // Models on Hugging Face that Ollama can run (GGUF files), most downloaded first.
  async searchHuggingFace(query) {
    const text = String(query || '').trim().slice(0, 80); if (!text) return [];
    const list = await getJson(`https://huggingface.co/api/models?${new URLSearchParams({ search: text, filter: 'gguf', sort: 'downloads', direction: '-1', limit: '20' })}`, { fetcher: this.fetcher, timeoutMs: 10000 });
    return (Array.isArray(list) ? list : []).map(item => ({ repo: item.id, downloads: item.downloads || 0, likes: item.likes || 0, pull: `hf.co/${item.id}` }));
  }

  // How an agent reaches its local model: Claude Code's address, key and model name for this run.
  // The key is the run's own Rex Desk token, which the bridge checks; Ollama ignores it.
  route(modelId, { base, token }) {
    const parsed = parseLocalModel(modelId); if (!parsed) return null;
    const server = this.server(parsed.serverId);
    if (!server) throw new Error('This agent is set to a local model whose server was removed. Pick another model on its card.');
    const url = server.kind === 'ollama' ? server.url : `${base}/local-ai/${server.id}`;
    const model = parsed.model;
    return { model, env: {
      ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: server.kind === 'ollama' ? 'ollama' : token, ANTHROPIC_API_KEY: '', REX_AGENT_API_KEY: '1',
      // Claude Code also asks its small and helper models for side jobs: they go to the same local model.
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_PROMPT_CACHING: '1',
      // Local models answer slowly on an ordinary computer: wait for them instead of giving up after the usual minutes.
      API_TIMEOUT_MS: '3600000',
    } };
  }
}

// ---- The bridge: Anthropic Messages in, OpenAI chat completions out, and the streamed answer back again. ----

const textOf = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
// Anthropic's request as an OpenAI chat request. Tool calls and their results become OpenAI's tool_calls and tool messages.
export function toOpenAi(body) {
  const messages = [];
  const system = textOf(body.system); if (system) messages.push({ role: 'system', content: system });
  for (const message of body.messages || []) {
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
    if (message.role === 'assistant') {
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const calls = parts.filter(part => part.type === 'tool_use').map(part => ({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input || {}) } }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const part of parts.filter(item => item.type === 'tool_result')) {
      const result = typeof part.content === 'string' ? part.content : (part.content || []).map(item => item.type === 'text' ? item.text : `[${item.type}]`).join('\n');
      messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: `${part.is_error ? 'Error: ' : ''}${result}` });
    }
    const rest = parts.filter(part => part.type !== 'tool_result');
    if (rest.length) {
      const content = rest.map(part => part.type === 'text' ? { type: 'text', text: part.text } : part.type === 'image' && part.source?.type === 'base64' ? { type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } } : null).filter(Boolean);
      messages.push({ role: 'user', content: content.every(part => part.type === 'text') ? content.map(part => part.text).join('\n') : content });
    }
  }
  const tools = (body.tools || []).filter(tool => tool.name && tool.input_schema).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.input_schema } }));
  const choice = body.tool_choice?.type === 'any' ? 'required' : body.tool_choice?.type === 'tool' ? { type: 'function', function: { name: body.tool_choice.name } } : body.tool_choice?.type === 'none' ? 'none' : undefined;
  return { model: body.model, messages, stream: Boolean(body.stream), ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}), ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
    ...(tools.length ? { tools, ...(choice ? { tool_choice: choice } : {}) } : {}), ...(body.stream ? { stream_options: { include_usage: true } } : {}) };
}
const stopReason = value => ({ tool_calls: 'tool_use', length: 'max_tokens', stop: 'end_turn' })[value] || 'end_turn';
const toolId = () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
const safeJson = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

// One finished OpenAI answer as an Anthropic message.
export function fromOpenAi(answer, model) {
  const choice = answer.choices?.[0] || {}, message = choice.message || {}, content = [];
  if (message.content) content.push({ type: 'text', text: String(message.content) });
  for (const call of message.tool_calls || []) content.push({ type: 'tool_use', id: call.id || toolId(), name: call.function?.name, input: safeJson(call.function?.arguments) });
  return { id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model, content, stop_reason: (message.tool_calls || []).length ? 'tool_use' : stopReason(choice.finish_reason), stop_sequence: null,
    usage: { input_tokens: answer.usage?.prompt_tokens || 0, output_tokens: answer.usage?.completion_tokens || 0 } };
}

// A streamed OpenAI answer (server-sent "data:" lines) written back as Anthropic's stream events.
export async function streamToAnthropic(stream, write, model) {
  const send = (type, data) => write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = -1, open = null, finish = null; const tools = new Map(); let usage = { input_tokens: 0, output_tokens: 0 };
  const close = () => { if (open) { send('content_block_stop', { index }); open = null; } };
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let at; while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
      const part = safeJson(data);
      if (part.usage) usage = { input_tokens: part.usage.prompt_tokens || 0, output_tokens: part.usage.completion_tokens || 0 };
      const choice = part.choices?.[0]; if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        if (open !== 'text') { close(); index++; open = 'text'; send('content_block_start', { index, content_block: { type: 'text', text: '' } }); }
        send('content_block_delta', { index, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const call of delta.tool_calls || []) {
        const key = call.index ?? 0;
        if (!tools.has(key)) {
          close(); index++; open = `tool${key}`; tools.set(key, index);
          send('content_block_start', { index, content_block: { type: 'tool_use', id: call.id || toolId(), name: call.function?.name || '', input: {} } });
        }
        if (call.function?.arguments) send('content_block_delta', { index: tools.get(key), delta: { type: 'input_json_delta', partial_json: call.function.arguments } });
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  close();
  send('message_delta', { delta: { stop_reason: tools.size ? 'tool_use' : stopReason(finish), stop_sequence: null }, usage });
  send('message_stop', {});
}

// Handles /local-ai/<server>/v1/messages (and its token count) for one OpenAI-style server.
export async function bridge(localAi, serverId, pathname, request, response, body, { fetcher = fetch } = {}) {
  const server = localAi.server(serverId);
  const fail = (status, message) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } })); };
  if (!server || server.kind !== 'openai') return fail(404, 'No such local server in Rex Desk.');
  // Claude Code asks how long a request is before sending it; a rough count (4 characters a token) is enough here.
  if (pathname.endsWith('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body || {}).length / 4) })); }
  if (!pathname.endsWith('/messages') || request.method !== 'POST') return fail(404, 'Rex Desk only passes on messages.');
  let upstream;
  try {
    upstream = await fetcher(`${server.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}) }, body: JSON.stringify(toOpenAi(body || {})) });
  } catch { return fail(502, `Rex Desk could not reach ${server.name} at ${server.url}. Is it running?`); }
  if (!upstream.ok) { const text = await upstream.text().catch(() => ''); return fail(upstream.status, `${server.name} answered ${upstream.status}: ${text.slice(0, 300)}`); }
  if (!body?.stream) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify(fromOpenAi(await upstream.json(), body?.model))); }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  try { await streamToAnthropic(upstream.body, text => response.write(text), body.model); }
  catch (error) { response.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: error.message } })}\n\n`); }
  response.end();
}

// Local AI, light mode: an agent on a model on this computer talks to that model directly, not through Claude Code.
// Claude Code sends every turn about 24,000 tokens of its own instructions and tools; a small model on an ordinary laptop
// reads them for minutes and then loses its way among them. Here the model gets a short instruction (who it is, how to
// answer), the recent chat, and only the Rex Desk tools that matter (the same ones, through Rex Desk's own tool server):
// a reply in seconds, and it picks the right tool. Real coding work still goes to Claude Code (desk_background).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The tools a local agent is given: knowing the agents, chats and tasks, the shared memory, acting for the person, and
// handing real work on. Anything else (files, shells, browsers) is Claude Code's job.
export const LIGHT_TOOLS = ['desk_specialists', 'desk_memory', 'desk_memory_note', 'desk_tasks', 'desk_task', 'desk_rooms_all', 'desk_room_history',
  'desk_room_create', 'desk_room_say', 'desk_agent_say', 'desk_background', 'desk_learn_person'];
const ROUNDS = 6, CONTEXT = 12288;

export class LocalRunner {
  // options: run, model (local:server/model), local: { server, model }, system, history [{ role, content }], mcpUrl, token,
  // event(kind, data), inbox(), signal.
  constructor(options) { Object.assign(this, options); this.event ||= () => {}; this.controller = new AbortController(); }
  async interrupt() { this.controller.abort(); }
  close() { this.controller.abort(); }

  async tools() {
    if (!this.mcpUrl || !this.token) return { list: [], call: async () => '' };
    const client = new Client({ name: 'rex-desk-local', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${this.token}` } } }));
    this.client = client;
    const { tools } = await client.listTools();
    const list = tools.filter(tool => LIGHT_TOOLS.includes(tool.name)).map(tool => ({ type: 'function', function: { name: tool.name, description: String(tool.description || '').slice(0, 600), parameters: tool.inputSchema || { type: 'object', properties: {} } } }));
    const call = async (name, args) => {
      if (!LIGHT_TOOLS.includes(name)) return `There is no tool called ${name}.`;
      try { const answer = await client.callTool({ name, arguments: args || {} }); return (answer.content || []).map(part => part.text || '').join('\n').slice(0, 6000) || 'Done.'; }
      catch (error) { return `That did not work: ${error.message}`; }
    };
    return { list, call };
  }

  async start(prompt) {
    const signal = AbortSignal.any ? AbortSignal.any([this.controller.signal, ...(this.signal ? [this.signal] : [])]) : this.controller.signal;
    // The newest message: the turn's own text when it is short (a spoken message, a job's outcome), else the person's last
    // message (a first turn arrives wrapped in Rex Desk's long instructions, which are not for a small model).
    const input = String(prompt || '').length <= 6000 ? String(prompt || '').trim() : (this.lastPersonMessage || String(prompt).slice(-2000));
    const messages = [{ role: 'system', content: this.system }, ...(this.history || []), { role: 'user', content: input || 'Hello' }];
    let tools = { list: [], call: async () => '' };
    try { tools = await this.tools(); } catch (error) { this.event('agent-tool', { tool: 'result', failed: true, text: `Rex Desk's tools could not be reached: ${error.message}` }); }
    const used = { input: 0, output: 0 };
    let said = '';
    try {
      for (let round = 0; round < ROUNDS; round++) {
        if (signal.aborted) throw new Error('Local AI run interrupted.');
        const answer = await this.chat(messages, tools.list, signal, text => this.event('agent-text-partial', { text }));
        used.input += answer.inputTokens || 0; used.output += answer.outputTokens || 0;
        if (answer.inputTokens) this.event('context', { used: answer.inputTokens, window: CONTEXT });
        const calls = answer.toolCalls || [];
        if (answer.text.trim()) { said = answer.text.trim(); this.event('agent-text', { text: said }); }
        if (!calls.length) break;
        messages.push({ role: 'assistant', content: answer.text || '', tool_calls: answer.rawCalls });
        for (const [index, item] of calls.entries()) {
          const id = item.id || `local-${Date.now()}-${index}`;
          this.event('agent-tool', { id, tool: item.name, input: item.args || {} });
          const result = await tools.call(item.name, item.args);
          this.event('agent-tool-result', { id, text: result.slice(0, 2000), failed: /^That did not work|^There is no tool/.test(result) });
          messages.push(this.server().kind === 'ollama' ? { role: 'tool', content: result, tool_name: item.name } : { role: 'tool', tool_call_id: id, content: result });
        }
        // Messages the person sent meanwhile go in before the next step.
        const news = this.inbox?.() || ''; if (news) messages.push({ role: 'user', content: news });
      }
      this.event('agent-result', { result: said, subtype: 'success', tokens: { input: used.input, output: used.output, cacheRead: 0, cacheWrite: 0, cacheTtl: 0 }, steps: 1 });
      return { status: 'completed' };
    } finally { await this.client?.close().catch(() => {}); }
  }
  server() { return this.local.server; }

  // One call to the model. Ollama: its own chat API, which takes the context size (a small one: it loads in seconds and
  // fits in memory) and streams the words. Another local server: the OpenAI-style API most of them speak.
  async chat(messages, tools, signal, onText) {
    const server = this.server(), model = this.local.model, auth = server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {};
    if (server.kind === 'ollama') {
      const response = await fetch(`${server.url}/api/chat`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}), stream: true, think: false, options: { num_ctx: CONTEXT } }) });
      if (!response.ok) throw new Error(`The model on this computer answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      let text = '', rawCalls = [], inputTokens = 0, outputTokens = 0, buffer = '', last = 0;
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        let line; while ((line = buffer.indexOf('\n')) >= 0) {
          const part = buffer.slice(0, line).trim(); buffer = buffer.slice(line + 1); if (!part) continue;
          const data = JSON.parse(part);
          if (data.error) throw new Error(`The model on this computer: ${data.error}`);
          if (data.message?.content) { text += data.message.content; if (Date.now() - last > 120) { last = Date.now(); onText(text); } }
          if (data.message?.tool_calls?.length) rawCalls = [...rawCalls, ...data.message.tool_calls];
          if (data.done) { inputTokens = data.prompt_eval_count || 0; outputTokens = data.eval_count || 0; }
        }
      }
      return { text, rawCalls, inputTokens, outputTokens, toolCalls: rawCalls.map(call => ({ id: call.id, name: call.function?.name, args: typeof call.function?.arguments === 'string' ? safeJson(call.function.arguments) : call.function?.arguments || {} })) };
    }
    const response = await fetch(`${server.url}/chat/completions`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}), stream: false }) });
    if (!response.ok) throw new Error(`The model on this computer answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = await response.json(), message = data.choices?.[0]?.message || {}, rawCalls = message.tool_calls || [];
    return { text: String(message.content || ''), rawCalls, inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0,
      toolCalls: rawCalls.map(call => ({ id: call.id, name: call.function?.name, args: safeJson(call.function?.arguments) })) };
  }
}
const safeJson = text => { try { return typeof text === 'string' ? JSON.parse(text || '{}') : text || {}; } catch { return {}; } };

// What a local agent is told: short, so a small model reads it in a moment and keeps it in mind.
export function lightSystem({ name, about = '', person = '', voice = false }) {
  return [
    `You are ${name}, an assistant inside Rex Desk, running on a model on the person's own computer.${about ? ` ${about}` : ''}`,
    'Answer the person directly, in short plain sentences. Use a tool only when the answer needs it, then answer from what it returned.',
    'To know the agents use desk_specialists; for chats and tasks use desk_rooms_all, desk_room_history and desk_tasks; the shared notes are in desk_memory.',
    'To act for the person: desk_room_create makes a group chat, desk_room_say posts in one as them, desk_agent_say writes to an agent as them.',
    'For real work on code, files or the web, hand it on with desk_background and say you are on it; do not try it yourself.',
    voice ? 'The person hears you (Voice mode): one to three spoken sentences, no lists or code.' : '',
    person ? `About the person:\n${person}` : '',
    `Today is ${new Date().toDateString()}.`,
  ].filter(Boolean).join('\n');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { LocalAi, toOpenAi, fromOpenAi, streamToAnthropic, parseLocalModel } from '../src/local-ai.js';
import { modelList } from '../src/choices.js';

const store = () => new Store(path.join(mkdtempSync(path.join(os.tmpdir(), 'rex-desk-local-ai-')), 'data'));
const reply = data => ({ ok: true, status: 200, json: async () => data });

test('local models join the Claude Code model list, and only ones that can use tools', async () => {
  const s = store();
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/api/tags')) return reply({ models: [{ name: 'qwen3:8b', size: 5e9, details: { parameter_size: '8B' } }, { name: 'tiny:1b', size: 1e9, details: {} }] });
    if (url.endsWith('/api/show')) return reply({ capabilities: JSON.parse(options.body).model === 'qwen3:8b' ? ['completion', 'tools'] : ['completion'], model_info: { 'qwen3.context_length': 40960 } });
    throw new Error('not running');
  };
  const local = new LocalAi(s, { fetcher });
  const status = await local.status();
  assert.equal(status.servers[0].running, true);
  assert.deepEqual(status.servers[0].models.map(model => [model.name, model.tools]), [['qwen3:8b', true], ['tiny:1b', false]]);
  const ids = modelList(s, 'claude').map(item => item.id);
  assert.ok(ids.includes('local:ollama/qwen3:8b'));
  assert.ok(!ids.includes('local:ollama/tiny:1b'), 'a model without tools is not offered to agents');
  assert.ok(ids.some(id => id.startsWith('claude-')), 'Claude models stay in the list');
  assert.deepEqual(modelList(s, 'codex').filter(item => item.local), [], 'other AIs do not get local models');

  // Ollama closed for a moment: its models stay listed, so agents set to one keep it.
  await new LocalAi(s, { fetcher: async () => { throw new Error('down'); } }).status();
  assert.ok(modelList(s, 'claude').some(item => item.id === 'local:ollama/qwen3:8b'));
  s.close();
});

test('an agent on a local model reaches Ollama directly, and other servers through the Rex Desk bridge', () => {
  const s = store(), local = new LocalAi(s);
  local.addServer({ name: 'LM Studio', url: 'http://127.0.0.1:1234/v1' });
  assert.deepEqual(parseLocalModel('local:lm-studio/qwen/qwen3-8b'), { serverId: 'lm-studio', model: 'qwen/qwen3-8b' });
  const ollama = local.route('local:ollama/qwen3:8b', { base: 'http://127.0.0.1:4317', token: 'run-token' });
  assert.equal(ollama.model, 'qwen3:8b');
  assert.equal(ollama.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434');
  assert.equal(ollama.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen3:8b', 'side jobs stay on the local model too');
  const studio = local.route('local:lm-studio/qwen/qwen3-8b', { base: 'http://127.0.0.1:4317', token: 'run-token' });
  assert.equal(studio.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4317/local-ai/lm-studio');
  assert.equal(studio.env.ANTHROPIC_AUTH_TOKEN, 'run-token');
  assert.equal(local.route('claude-opus-5-5', { base: '', token: '' }), null, 'Claude models are left alone');
  assert.throws(() => local.addServer({ name: 'x', url: 'not an address' }), /address/);
  s.close();
});

test('the bridge turns a Claude request with tools into an OpenAI one, and the answer back', () => {
  const request = toOpenAi({ model: 'm', system: [{ type: 'text', text: 'Be brief.' }], max_tokens: 100, stream: true,
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'Open a.txt' },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }] }, { type: 'text', text: 'Now what?' }] },
    ] });
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[2].tool_calls[0].function.arguments, '{"path":"a.txt"}');
  assert.deepEqual(request.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'hello' });
  assert.equal(request.messages[4].content, 'Now what?');
  assert.equal(request.tools[0].function.name, 'Read');
  const answer = fromOpenAi({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"path":"b.txt"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, 'm');
  assert.equal(answer.stop_reason, 'tool_use');
  assert.deepEqual(answer.content[0], { type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'b.txt' } });
});

test('a streamed OpenAI answer comes back as Claude stream events, text and tool calls', async () => {
  const lines = [
    { choices: [{ delta: { content: 'Hi ' } }] }, { choices: [{ delta: { content: 'there' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"command":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
  ].map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n';
  let out = '';
  await streamToAnthropic([new TextEncoder().encode(lines)], text => { out += text; }, 'm');
  const events = out.trim().split('\n\n').map(block => JSON.parse(block.split('\n')[1].slice(6)));
  assert.deepEqual(events.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events[5].content_block.name, 'Bash');
  assert.equal(events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join(''), '{"command":"ls"}');
  assert.equal(events[9].delta.stop_reason, 'tool_use');
  assert.equal(events[9].usage.output_tokens, 4);
});

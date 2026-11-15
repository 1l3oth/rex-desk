import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { now } from '../src/store.js';
import { LocalRunner, LIGHT_TOOLS } from '../src/local-runner.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('Local AI light mode: a short instruction, the key Rex Desk tools, a real tool call and a streamed reply', async () => {
  // A pretend Ollama: the first call asks for desk_specialists, the second answers from what it returned.
  const asked = [];
  const ollama = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      const data = JSON.parse(body); asked.push(data);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const toolResult = data.messages.find(message => message.role === 'tool');
      if (!toolResult) { response.end(`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'desk_specialists', arguments: {} } }] }, done: true, prompt_eval_count: 900, eval_count: 12 })}\n`); return; }
      const named = /ReelHome/.test(toolResult.content) ? 'You have one agent, ReelHome.' : 'I could not see your agents.';
      response.write(`${JSON.stringify({ message: { role: 'assistant', content: named.slice(0, 12) }, done: false })}\n`);
      response.end(`${JSON.stringify({ message: { role: 'assistant', content: named.slice(12) }, done: true, prompt_eval_count: 1100, eval_count: 9 })}\n`);
    });
  });
  await new Promise(resolve => ollama.listen(0, '127.0.0.1', resolve));
  const app = await createApp({ dataDirectory: temporary('light'), port: 0, runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  try {
    app.desk.specialists.create({ name: 'ReelHome', projectPath: temporary('light-project'), purpose: 'TikTok captions', by: 'you' });
    app.store.put('run', 'rex', { id: 'rex', role: 'coordinator', main: true, state: 'running', provider: 'claude', model: 'local:ollama/qwen3:1.7b', createdAt: now() });
    app.store.event('rex', 'human-message', { text: 'Which agents do I have?' }, true);
    const server = { id: 'ollama', kind: 'ollama', name: 'Ollama', url: `http://127.0.0.1:${ollama.address().port}` };
    app.desk.localAi.server = () => server;
    const turn = app.desk.lightTurn(app.store.get('run', 'rex'), { serverId: 'ollama', model: 'qwen3:1.7b' });
    assert.match(turn.system, /You are Rex Agent/); assert.ok(turn.system.length < 2500, 'a short instruction');
    assert.equal(turn.lastPersonMessage, 'Which agents do I have?');
    const events = [];
    const runner = new LocalRunner({ ...turn, run: app.store.get('run', 'rex'), mcpUrl: `${app.address}/mcp`, token: app.desk.scopeToken('rex'), event: (kind, data) => events.push([kind, data]), inbox: () => '',
      // What Rex Desk hands every runner: the person's question cards. Talking to the model must never open one.
      ask: async request => { throw new Error(`A question card was opened: ${JSON.stringify(request).slice(0, 80)}`); } });
    // A turn arrives wrapped in Rex Desk's lessons and instructions: the person's own message is sent instead.
    await runner.start(`Lessons you learned from the person (follow them):\n- Keep it short.\n\n${'x'.repeat(200)}\n\nWhich agents do I have?`);
    assert.equal(asked[0].model, 'qwen3:1.7b'); assert.equal(asked[0].options.num_ctx, 12288); assert.equal(asked[0].think, false);
    assert.equal(asked[0].messages.at(-1).content, 'Which agents do I have?');
    // What Rex Desk holds right now sits next to the question, where a small model reads it, not only at the top.
    assert.equal(asked[0].messages.at(-2).role, 'system'); assert.match(asked[0].messages.at(-2).content, /Rex Desk right now[\s\S]*ReelHome/);
    assert.deepEqual(asked[0].tools.map(tool => tool.function.name).sort(), LIGHT_TOOLS.filter(name => asked[0].tools.some(tool => tool.function.name === name)).sort());
    assert.ok(asked[0].tools.length >= 8 && asked[0].tools.length <= LIGHT_TOOLS.length, 'only the key Rex Desk tools');
    assert.ok(events.some(([kind, data]) => kind === 'agent-tool' && data.tool === 'desk_specialists'));
    assert.ok(events.some(([kind]) => kind === 'agent-text-partial'), 'the words stream in');
    assert.deepEqual(events.filter(([kind]) => kind === 'agent-text').map(([, data]) => data.text), ['You have one agent, ReelHome.']);
    const result = events.find(([kind]) => kind === 'agent-result')[1];
    assert.equal(result.result, 'You have one agent, ReelHome.'); assert.equal(result.tokens.input, 2000);
  } finally { await app.close(); ollama.close(); }
});

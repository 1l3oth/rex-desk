// A stand-in for `agy acp`: speaks the Agent Client Protocol on stdio the way Antigravity CLI 1.5 does.
import { createInterface } from 'node:readline';
const skip = process.argv.includes('--dangerously-skip-permissions');
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
const waiting = new Map(); let asked = 0; const calls = [];
const config = [{ id: 'model', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }] }];
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if (message.method === undefined) { waiting.get(message.id)?.(message.result); return; }
  calls.push(message.method);
  const reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (message.method === 'session/new') return reply({ sessionId: '11111111-2222-3333-4444-555555555555', configOptions: config });
  if (message.method === 'session/resume') return reply({ configOptions: config });
  if (message.method === 'session/set_config_option') return reply({ configOptions: config });
  if (message.method === 'session/cancel') return;
  if (message.method === 'session/prompt') {
    const { sessionId } = message.params, text = message.params.prompt[0].text;
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking ' } });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'run_command', status: 'in_progress', kind: 'execute', title: 'git --version', rawInput: { CommandLine: 'git --version' } });
    let allowed = true;
    if (!skip) {
      const id = `p${++asked}`;
      const result = await new Promise(resolve => { waiting.set(id, resolve); send({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't1', name: 'run_command', title: 'git --version', rawInput: { CommandLine: 'git --version' } }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } }); });
      allowed = result.outcome.optionId === 'allow';
    }
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed', rawOutput: allowed ? { output: 'git version 2.54', exit_code: 0 } : { output: 'denied' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `done: ${text} [${calls.join(',')}]${skip ? ' skip' : ''}` } });
    return reply({ stopReason: 'end_turn', usage: { inputTokens: 900, outputTokens: 20, cachedReadTokens: 100, cachedWriteTokens: 0 } });
  }
  send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
});

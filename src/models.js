import { resolveCommand } from './processes.js';

// The models the signed-in Claude Code offers, asked from the agent SDK without sending any prompt. The SDK starts the CLI,
// answers from its own model list, and is closed again; nothing is spent on a model turn.
export async function fetchModels({ env = process.env, sdk, timeoutMs = 30000 } = {}) {
  const { query } = sdk || await import('@anthropic-ai/claude-agent-sdk');
  const controller = new AbortController();
  const idle = (async function* () { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); })();
  const executable = resolveCommand('claude');
  const session = query({ prompt: idle, options: { env, abortController: controller, ...(executable.command.includes('/') || executable.command.includes('\\') ? { pathToClaudeCodeExecutable: executable.command } : {}) } });
  let timer;
  try {
    const list = await Promise.race([session.supportedModels(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude Code did not list its models in time.')), timeoutMs); })]);
    return (list || []).filter(item => item?.value).map(item => ({ id: String(item.value), label: String(item.displayName || item.value), hint: String(item.description || '') }));
  } finally { clearTimeout(timer); controller.abort(); try { session.close?.(); } catch { /* already closed */ } }
}

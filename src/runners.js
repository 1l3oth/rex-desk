import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveCommand } from './processes.js';
import { carrySession } from './agents.js';
// What one reply cost in tokens: new input, output, and the part of the context read from or written to the prompt cache.
export const tokensOf = usage => usage ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0 } : null;

export function existingMcpConnections(sourcePath, configDirectory = process.env.CLAUDE_CONFIG_DIR) {
  let connections = {};
  const configs = [...new Set([path.join(os.homedir(), '.claude.json'), configDirectory ? path.join(configDirectory, '.claude.json') : ''].filter(Boolean))];
  for (const config of configs) if (existsSync(config)) {
    const data = JSON.parse(readFileSync(config, 'utf8'));
    connections = { ...connections, ...data.mcpServers };
    const canonical = value => String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
    const project = Object.entries(data.projects || {}).find(([key]) => canonical(key) === canonical(sourcePath));
    if (project) connections = { ...connections, ...project[1].mcpServers };
  }
  if (sourcePath && existsSync(path.join(sourcePath, '.mcp.json'))) {
    const data = JSON.parse(readFileSync(path.join(sourcePath, '.mcp.json'), 'utf8'));
    connections = { ...connections, ...data.mcpServers };
  }
  return connections;
}

// Rex Desk's own tools read tasks, label them, message the dashboard, or act inside the run's worktree. desk_status,
// desk_publish, and desk_dispatch carry their own dashboard approval, so none needs the agent's permission prompt too.
const quietRexTool = name => name.startsWith('mcp__rex_desk__desk_');
// The person's Claude memory, instructions, settings, agents, skills, and hooks, in any profile folder (~/.claude*, Orca's claude-profiles/<id>/home).
const claudeHome = /(?:[\\/]\.claude[^\\/]*|claude-profiles[\\/][^\\/]+[\\/]home)[\\/](?:projects[\\/][^\\/]+[\\/]memory|settings(?:\.local)?\.json|CLAUDE\.md|agents|skills|hooks|commands)\b/i;
export function writesClaudeHome(name, input = {}) {
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return claudeHome.test(String(input.file_path || input.notebook_path || ''));
  if (name === 'Bash' || name === 'PowerShell') { const command = String(input.command || ''); return claudeHome.test(command) && /(>|\btee\b|\bcp\b|\bmv\b|\brm\b|sed\s+-i|Set-Content|Out-File|Add-Content|New-Item|Remove-Item|Copy-Item|Move-Item)/i.test(command); }
  return false;
}

// Agents run on the Claude Code profile's claude.ai sign-in, so they use the person's Claude subscription. An API key
// left in the environment would quietly switch every run to pay-per-token billing, so it is removed unless asked for.
export const apiKeyVariables = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export function subscriptionEnv(env) {
  const result = { ...env };
  if (result.REX_AGENT_API_KEY !== '1') for (const name of apiKeyVariables) delete result[name];
  return result;
}
// Maps the mode picked in the chat input to the SDK. Manual is the SDK's own default. Rex Desk agents start in Dangerous mode (no permission prompts) unless another is picked.
const sdkMode = mode => ({ manual: 'default' }[mode] || mode || 'bypassPermissions');
// What a tool call shows in the chat: its name and a few short fields, never file contents.
const hiddenInput = new Set(['content', 'new_string', 'old_string', 'text', 'body']);
const toolInput = input => Object.fromEntries(Object.entries(input || {}).slice(0, 8).filter(([key, value]) => !hiddenInput.has(key) && ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, key === 'command' ? 2000 : 240) : value]));
// A shell command's output, for the terminal view in the chat: colour codes removed, obvious secrets hidden, long output cut in the middle.
const ansiCodes = /\u001b\[[0-9;?]*[A-Za-z]/g;
const secretLine = /(api[_-]?key|secret|passw(?:or)?d|passphrase|token|authorization|bearer)\s*[:=]\s*\S+/gi;
const terminalText = value => {
  const raw = (Array.isArray(value) ? value.map(part => part.text || '').join('\n') : String(value || '')).replace(ansiCodes, '').replace(secretLine, '$1: [redacted]');
  return raw.length > 6000 ? `${raw.slice(0, 3000)}\n… ${raw.length - 6000} characters left out …\n${raw.slice(-3000)}` : raw;
};
// What a file edit changed, for the chat and the Activity panel: the file, how many lines were added and removed, and those
// lines (at most 80, each clipped). Files that usually hold secrets show only the counts, and secret-looking values are hidden.
const SECRET_FILE = /(^|[\\/])(\.env[^\\/]*|.*\.(pem|key|p12|pfx)|.*secret.*|.*credential.*|id_rsa[^\\/]*)$/i;
const lines = value => String(value ?? '').replace(/\r\n/g, '\n').split('\n');
export function fileChange(name, input = {}) {
  if (!['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return null;
  const file = String(input.file_path || input.notebook_path || ''); if (!file) return null;
  const edits = name === 'MultiEdit' ? (input.edits || []) : name === 'Write' ? [{ old_string: '', new_string: input.content }] : name === 'NotebookEdit' ? [{ old_string: '', new_string: input.new_source }] : [{ old_string: input.old_string, new_string: input.new_string }];
  const diff = []; let added = 0, removed = 0;
  for (const edit of edits) {
    const before = edit.old_string ? lines(edit.old_string) : [], after = edit.new_string !== undefined ? lines(edit.new_string) : [];
    // Lines the edit kept at its start and end are context, not changes.
    let start = 0; while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0; while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    const gone = before.slice(start, before.length - end), come = after.slice(start, after.length - end);
    removed += gone.length; added += come.length;
    if (diff.length) diff.push('…');
    for (const line of gone) diff.push(`-${line}`); for (const line of come) diff.push(`+${line}`);
  }
  const hidden = SECRET_FILE.test(file);
  return { file, created: name === 'Write', added, removed, diff: hidden ? [] : diff.slice(0, 80).map(line => line.replace(secretLine, '$1: [redacted]').slice(0, 220)), more: hidden ? 0 : Math.max(0, diff.length - 80), hidden };
}
const isShell = name => name === 'Bash' || name === 'PowerShell';
const sessionId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '')) ? String(value) : '';

export class ClaudeRunner {
  constructor(options) { Object.assign(this, options); }
  async start(prompt) {
    const { query } = this.sdk || await import('@anthropic-ai/claude-agent-sdk');
    const env = { ...subscriptionEnv(this.agentEnv || process.env), REX_AGENT_TOKEN: this.token, REX_DESK_TOKEN: this.token, REX_DESK_URL: this.mcpUrl, MCP_TOOL_TIMEOUT: '86400000' };
    delete env.CLAUDECODE;
    const executable = resolveCommand('claude');
    const connections = existingMcpConnections(this.sourcePath, env.CLAUDE_CONFIG_DIR), allowedTools = new Set();
    delete connections.rex_desk;
    const mode = sdkMode(this.run.permissionMode), resume = sessionId(this.run.sessionId);
    if (resume) { try { carrySession(resume, this.cwd, env.CLAUDE_CONFIG_DIR || ''); } catch { /* the resume reports it if the conversation is really gone */ } }
    // Dangerous mode skips every permission prompt, so what the prompts used to refuse is refused by a hook instead.
    // A specialist reads its project but never writes in the original checkout: code changes happen in a task worktree.
    const writesProject = input => this.run.role === 'specialist' && this.projectDirectory && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)
      && path.resolve(String(input.tool_input?.file_path || input.tool_input?.notebook_path || '/')).toLowerCase().startsWith(`${path.resolve(this.projectDirectory).toLowerCase()}${path.sep}`);
    const refuseClaudeHome = async input => writesProject(input) ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'You read this project here. Code changes happen on a task in its own worktree, after the person assigns the task.' } }
      : this.run.role !== 'coordinator' && writesClaudeHome(input.tool_name, input.tool_input)
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Rex Desk agents do not write Claude memory, instructions, or settings. Say what you learned in desk_message instead, and continue the task.' } } : {};
    const options = { cwd: this.cwd, env, abortController: this.controller,
      permissionMode: mode, ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(this.run.effort ? { effort: this.run.effort } : {}),
      // Claude Code's own question prompt would not reach the dashboard; the agent asks through desk_ask instead.
      disallowedTools: ['AskUserQuestion'],
      additionalDirectories: [this.artifactDirectory, this.uploadsDirectory, this.projectDirectory].filter(Boolean),
      settingSources: ['user', 'project', 'local'],
      hooks: { PreToolUse: [{ hooks: [refuseClaudeHome] }], PostToolUse: [{ hooks: [async () => {
        // New messages for this agent arrived while it worked: hand them over now, between steps.
        const news = this.inbox?.() || '';
        return news ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `New messages arrived while you were working. Read them now; they may change what you are doing. Answer them in your reply.

${news}` } } : {};
      }] }] },
      ...(executable.command.includes('/') || executable.command.includes('\\') ? { pathToClaudeCodeExecutable: executable.command } : {}),
      ...(this.model ? { model: this.model } : {}), ...(resume ? { resume } : {}),
      strictMcpConfig: true,
      mcpServers: { ...connections, ...(this.extraMcp || {}), rex_desk: { type: 'http', url: this.mcpUrl, headers: { Authorization: `Bearer ${this.token}` }, alwaysLoad: true } },
      onElicitation: async request => {
        const answer = await this.ask({ kind: 'question', title: request.message, request, method: 'elicitation' });
        return { action: answer.action, ...(answer.action === 'accept' ? { content: answer.content || {} } : {}) };
      },
      // Only reached in modes that ask: each request becomes an approval card in the chat.
      canUseTool: async (name, input, context) => {
        if (this.run.role !== 'coordinator' && writesClaudeHome(name, input)) return { behavior: 'deny', message: 'Rex Desk agents do not write Claude memory, instructions, or settings. Say what you learned in desk_message instead, and continue the task.' };
        if (quietRexTool(name) || allowedTools.has(name)) return { behavior: 'allow', updatedInput: input };
        const answer = await this.ask({ kind: 'approval', title: `Approve ${name}`, request: { tool: name, input, suggestions: context.suggestions, allowAlways: true }, method: 'claude-permission' });
        if (answer.action === 'accept' && answer.content?.always) allowedTools.add(name);
        return answer.action === 'accept' ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'User declined this action.' };
      },
    };
    this.query = query({ prompt, options });
    for await (const message of this.query) {
      if (message.type === 'system' && message.subtype === 'init') { this.apiKeySource = message.apiKeySource; this.event('session', { sessionId: message.session_id, apiKeySource: message.apiKeySource }); }
      // How much of the account's 5-hour and weekly limits is used, as Claude Code reports it during a turn.
      if (message.type === 'rate_limit_event' && message.rate_limit_info) this.event('rate-limit', { ...message.rate_limit_info });
      if (message.type === 'assistant') {
        const content = message.message?.content?.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking');
        // What the agent says shows in the chat; its tool calls stay in the journal.
        const text = (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
        // A sub-agent's own words and steps belong to its card in the chat, not to the agent's reply.
        const parent = message.parent_tool_use_id || null;
        if (text) this.event(parent ? 'subagent-text' : 'agent-text', parent ? { parent, text: text.slice(0, 4000) } : { text });
        for (const block of content || []) if (block.type === 'tool_use') {
          if (isShell(block.name)) (this.terminals ||= new Set()).add(block.id);
          if (/^(Task|Agent)$/.test(block.name)) { (this.subagents ||= new Set()).add(block.id); this.event('agent-tool', { id: block.id, tool: 'Agent', ...(parent ? { parent } : {}), input: { description: String(block.input?.description || '').slice(0, 200), type: String(block.input?.subagent_type || 'general-purpose'), model: String(block.input?.model || ''), prompt: String(block.input?.prompt || '').slice(0, 1500) } }); continue; }
          this.event('agent-tool', { id: block.id, tool: String(block.name).replace(/^mcp__[a-z0-9_]+?__/i, ''), ...(parent ? { parent } : {}), input: toolInput(block.input), ...(fileChange(block.name, block.input) ? { change: fileChange(block.name, block.input) } : {}) });
        }
        this.event('agent-operation', { type: 'assistant', content });
      }
      if (message.type === 'user') {
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block.type !== 'tool_result') continue;
          if (this.subagents?.has(block.tool_use_id)) { const said = Array.isArray(block.content) ? block.content.map(part => part.text || '').join('\n') : String(block.content || ''); this.event('subagent-done', { id: block.tool_use_id, failed: Boolean(block.is_error), text: said.slice(0, 3000) }); continue; }
          if (this.terminals?.has(block.tool_use_id)) this.event('agent-tool-result', { id: block.tool_use_id, text: terminalText(block.content), failed: Boolean(block.is_error) });
          else if (block.is_error) this.event('agent-tool', { tool: 'result', failed: true, text: (Array.isArray(block.content) ? block.content.map(part => part.text || '').join(' ') : String(block.content || '')).slice(0, 300) });
        }
        this.event('agent-operation', { type: 'tool-result', content: message.message?.content });
      }
      if (message.type === 'result') {
        this.event('agent-result', { result: message.result, errors: message.errors, subtype: message.subtype, cost: message.total_cost_usd, tokens: tokensOf(message.usage), steps: message.num_turns || 0, durationMs: message.duration_ms || 0, billedToApiKey: ['user', 'project', 'org', 'temporary'].includes(this.apiKeySource) });
        // The CLI reports a signed-out profile as an ordinary result. Surface it as a setup problem, not agent output.
        if (/not logged in|please run \/login/i.test(String(message.result || ''))) throw new Error(`Claude Code profile ${env.CLAUDE_CONFIG_DIR || '~/.claude'} is not signed in. Open Setup, choose a signed-in Claude Code profile, then continue this run.`);
        if (message.is_error) throw new Error(message.errors?.join('\n') || message.result || `Claude ended with ${message.subtype}.`);
      }
    }
    return { status: 'completed' };
  }
  async interrupt() { await this.query?.interrupt(); this.query?.close(); }
  close() { this.query?.close(); }
}

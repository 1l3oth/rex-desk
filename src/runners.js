import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveCommand } from './processes.js';

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

export class ClaudeRunner {
  constructor(options) { Object.assign(this, options); }
  async start(prompt) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const env = { ...(this.agentEnv || process.env), REX_AGENT_TOKEN: this.token, REX_DESK_TOKEN: this.token, REX_DESK_URL: this.mcpUrl, MCP_TOOL_TIMEOUT: '86400000' };
    delete env.CLAUDECODE;
    const executable = resolveCommand('claude');
    const connections = existingMcpConnections(this.sourcePath, env.CLAUDE_CONFIG_DIR), allowedTools = new Set();
    delete connections.rex_desk;
    const options = { cwd: this.cwd, env, abortController: this.controller,
      permissionMode: this.run.role === 'worker' ? 'acceptEdits' : 'default',
      ...(this.artifactDirectory ? { additionalDirectories: [this.artifactDirectory] } : {}),
      settingSources: ['user', 'project', 'local'],
      ...(executable.command.includes('/') || executable.command.includes('\\') ? { pathToClaudeCodeExecutable: executable.command } : {}),
      ...(this.model ? { model: this.model } : {}), ...(this.run.sessionId ? { resume: this.run.sessionId } : {}),
      strictMcpConfig: true,
      mcpServers: { ...connections, rex_desk: { type: 'http', url: this.mcpUrl, headers: { Authorization: `Bearer ${this.token}` }, alwaysLoad: true } },
      onElicitation: async request => {
        const answer = await this.ask({ kind: 'question', title: request.message, request, method: 'elicitation' });
        return { action: answer.action, ...(answer.action === 'accept' ? { content: answer.content || {} } : {}) };
      },
      canUseTool: async (name, input, context) => {
        if (name === 'AskUserQuestion') {
          const answer = await this.ask({ kind: 'question', title: 'Claude needs your input', request: input, method: 'claude-question' });
          if (answer.action !== 'accept') return { behavior: 'deny', message: 'User declined the question.' };
          return { behavior: 'allow', updatedInput: { ...input, answers: answer.content || {} } };
        }
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
      if (message.type === 'system' && message.subtype === 'init') this.event('session', { sessionId: message.session_id });
      if (message.type === 'assistant') {
        const content = message.message?.content?.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking');
        this.event('agent-operation', { type: 'assistant', content });
      }
      if (message.type === 'user') this.event('agent-operation', { type: 'tool-result', content: message.message?.content });
      if (message.type === 'result') {
        this.event('agent-result', { result: message.result, errors: message.errors, subtype: message.subtype, cost: message.total_cost_usd });
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

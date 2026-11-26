import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { resolveCommand } from './processes.js';
import { carrySession } from './agents.js';
import { guardTool } from './app-guard.js';
// What one reply cost in tokens: new input, output, and the part of the context read from or written to the prompt cache.
export const tokensOf = usage => usage ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0,
  cacheTtl: usage.cache_creation?.ephemeral_1h_input_tokens > 0 ? 3600 : (usage.cache_read_input_tokens || usage.cache_creation_input_tokens) ? 300 : 0 } : null;

// A config file that is half-written (Claude Code saves .claude.json while it runs) or broken is skipped, not fatal.
const readJson = file => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };

export function existingMcpConnections(sourcePath, configDirectory = process.env.CLAUDE_CONFIG_DIR) {
  let connections = {};
  const configs = [...new Set([path.join(os.homedir(), '.claude.json'), configDirectory ? path.join(configDirectory, '.claude.json') : ''].filter(Boolean))];
  for (const config of configs) {
    const data = readJson(config);
    if (!data) continue;
    connections = { ...connections, ...data.mcpServers };
    const canonical = value => String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
    const project = Object.entries(data.projects || {}).find(([key]) => canonical(key) === canonical(sourcePath));
    if (project) connections = { ...connections, ...project[1].mcpServers };
  }
  const project = sourcePath ? readJson(path.join(sourcePath, '.mcp.json')) : null;
  if (project) connections = { ...connections, ...project.mcpServers };
  return connections;
}

// Rex Desk's own tools read tasks, label them, message the dashboard, or act inside the run's worktree. desk_status,
// desk_publish, and desk_dispatch carry their own dashboard approval, so none needs the agent's permission prompt too.
const quietRexTool = name => name.startsWith('mcp__rex_desk__desk_');
// The main agent reads anywhere on the computer without an approval card: looking is never the risky part.
const LOOK_TOOLS = new Set(['Read', 'Glob', 'Grep']);
export const mainLooks = (run, name) => Boolean(run?.main || run?.roomAgent === 'main') && LOOK_TOOLS.has(name);
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
// One changed line as a tool event keeps it ("+text" or "-text"): secrets masked, cut at 220 characters.
export const diffLine = line => String(line).replace(secretLine, '$1: [redacted]').slice(0, 220);
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
  return { file, created: name === 'Write', added, removed, diff: hidden ? [] : diff.slice(0, 80).map(diffLine), more: hidden ? 0 : Math.max(0, diff.length - 80), hidden };
}
// sha256 of a file's bytes, or '' when it cannot be read.
export const fileHash = file => { try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return ''; } };
const isShell = name => name === 'Bash' || name === 'PowerShell';
const sessionId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '')) ? String(value) : '';

// Claude Code sometimes cancels a step by itself (usually after a note about a background task) and words it as if the person
// pressed Stop. A real Stop ends the turn at once, so an agent that can still read this was not stopped.
const cancelledText = /doesn['’]t want to take this action right now/i;
export const cancelledByItself = content => cancelledText.test(Array.isArray(content) ? content.map(part => part.text || '').join(' ') : String(content || ''));
export const cancelNote = count => `The step that just came back as "The user doesn't want to take this action" was cancelled by Claude Code itself, not by the person. Run the same step again now, and do not mention it to the person. It usually happens when one of your own background tasks or watches reports: if one is running, stop it first (TaskStop) or wait for it.${count >= 2 ? ` It has happened ${count} times: that happens while a background task or watch is still running. Stop those first (TaskStop), do the step in the foreground, and keep each command short.` : ''}`;

// Pictures the person attached go to Claude inside the message itself, as images, so the agent sees them without a file read
// (a Read could be cancelled by Claude Code and the agent then guessed, L50). The paths stay in the text for a closer look.
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export function attachedImages(text, { limit = 4, maxBytes = 5 * 1024 * 1024 } = {}) {
  const block = /Attached files \(read them from these paths\):\n((?:- .+\n?)+)/.exec(String(text || ''));
  if (!block) return [];
  const images = [];
  for (const line of block[1].split('\n')) {
    const file = line.replace(/^- /, '').trim(), type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!file || !type || images.length >= limit) continue;
    try { const data = readFileSync(file); if (data.length && data.length <= maxBytes) images.push({ type: 'image', source: { type: 'base64', media_type: type, data: data.toString('base64') } }); } catch { /* not here: the path stays in the text */ }
  }
  return images;
}
export function withImages(prompt) {
  const images = attachedImages(prompt);
  if (!images.length) return null;
  return (async function* one() { yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `${prompt}\n\n(The attached pictures are also in this message, so you can see them without reading the files.)` }, ...images] }, parent_tool_use_id: null }; })();
}

// The locked room: an agent answering an outside agent over the internet. It may only read files inside its own public folder.
// Nothing else runs: no commands, no edits, no web, no sub-agents, no MCP tools, no skills, and nothing outside that folder.
const LOCKED_READS = new Set(['Read', 'Glob', 'Grep']);
// Claude Code's cost guide (code.claude.com/docs/en/costs, L64): nothing runs in the background on the person's plan, and
// sub-agents an agent starts use Sonnet at medium effort, not the parent's Opus. A value the person set in their own env wins.
export const COST_SETTINGS = { promptSuggestionEnabled: false, idleCompaction: false, awaySummaryEnabled: false, crossSessionInbound: 'hold' };
export const COST_ENV = { CLAUDE_CODE_GOAL_CHECKIN_MINUTES: '0', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_SUBAGENT_EFFORT: 'medium' };
// A test run's full output is read on every later step of the chat: keep only its last 100 lines (the summary and failures).
// Bash only, never a command that already pipes or redirects; pipefail keeps the test's own exit code.
const TEST_COMMAND = /^\s*(npm (run )?test|npx (vitest|jest)|node --test|pnpm (run )?test|yarn test|pytest|python -m pytest|go test|cargo test|mvn( -\S+)* test|\.?\/?gradlew? test)\b/i;
export function trimTestCommand(name, input = {}) {
  const command = String(input?.command || '');
  if (name !== 'Bash' || !TEST_COMMAND.test(command) || /[|>]|&&|;|\n/.test(command)) return null;
  return { ...input, command: `set -o pipefail; ${command} 2>&1 | tail -n 100` };
}
export function lockedDenial(name, input = {}, cwd = '') {
  if (!LOCKED_READS.has(name)) return `This agent is answering an outside agent and cannot use ${name}. It can only read the files in its public folder.`;
  const root = path.resolve(cwd), wanted = [input.file_path, input.path].filter(value => value !== undefined && value !== '');
  const inside = target => { const full = path.resolve(root, String(target)); return full === root || full.startsWith(root + path.sep); };
  if (!cwd || wanted.some(target => !inside(target)) || (name === 'Glob' && (String(input.pattern || '').split(/[\\/]/).includes('..') || path.isAbsolute(String(input.pattern || ''))))) return 'This agent is answering an outside agent and can only read files inside its public folder.';
  return '';
}

// Several steps in a row cancelled by Claude Code itself means a job the agent left running (a dev server, a test, a screenshot
// script) cancels every next step: the agent is stuck. Rex Desk stops that turn's own processes and starts a fresh chat.
export const STUCK_AFTER = 3;
// Ends a process and everything it started, by its process id: only the Claude Code process of this turn and its children.
export async function endProcessTree(pid, { platform = process.platform, run = execFile } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  const call = (command, args) => new Promise(resolve => run(command, args, { windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout || ''))));
  if (platform === 'win32') { await call('taskkill', ['/PID', String(pid), '/T', '/F']); return true; }
  const table = (await call('ps', ['-A', '-o', 'pid=,ppid='])).split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(pair => pair.length === 2);
  const tree = [pid];
  for (let index = 0; index < tree.length; index++) for (const [child, parent] of table) if (parent === tree[index] && !tree.includes(child) && child !== process.pid) tree.push(child);
  for (const each of tree.reverse()) { try { process.kill(each, 'SIGKILL'); } catch { /* already gone */ } }
  return true;
}

export class ClaudeRunner {
  constructor(options) { Object.assign(this, options); }
  noteCancelled() { this.cancelCount = (this.cancelCount || 0) + 1; this.cancelStreak = (this.cancelStreak || 0) + 1; this.cancelPending = true; }
  // Given once, right after the cancel, so the agent never has to work out for itself that the person did not stop it.
  takeCancelNote() { if (!this.cancelPending) return ''; this.cancelPending = false; return cancelNote(this.cancelCount); }
  // Says once per turn that the prompt was really taken (src/coordinator.js counts a scheduled message as sent on it).
  accepted() { if (this.acceptedSaid) return; this.acceptedSaid = true; this.event('prompt-accepted', {}); }
  async start(prompt) {
    this.acceptedSaid = false;
    const { query } = this.sdk || await import('@anthropic-ai/claude-agent-sdk');
    const env = { ...subscriptionEnv(this.agentEnv || process.env), REX_AGENT_TOKEN: this.token, REX_DESK_TOKEN: this.token, REX_DESK_URL: this.mcpUrl, MCP_TOOL_TIMEOUT: '86400000' };
    // Tools of the person's own MCP servers are listed by name and loaded only when needed, not all at the start of every chat.
    if (!env.ENABLE_TOOL_SEARCH) env.ENABLE_TOOL_SEARCH = 'true';
    for (const [key, value] of Object.entries(COST_ENV)) if (env[key] === undefined) env[key] = value;
    delete env.CLAUDECODE;
    const executable = resolveCommand('claude');
    // Not installed: say so plainly (the chat shows an Install button) instead of the Agent SDK's message about its own binary.
    if (process.platform !== 'win32' && !executable.command.includes('/') && !this.sdk) throw new Error('Claude Code is not installed on this computer. Press Install Claude Code: Rex Desk installs it and signs you in.');
    // Servers switched off on the Market page never join the session, so none of their tools load.
    const withoutOff = (servers, off) => Object.fromEntries(Object.entries(servers).filter(([name]) => !(off || []).includes(name)));
    const connections = existingMcpConnections(this.sourcePath, env.CLAUDE_CONFIG_DIR), allowedTools = new Set();
    delete connections.rex_desk;
    const mode = sdkMode(this.run.permissionMode), resume = sessionId(this.run.sessionId);
    if (resume) { try { carrySession(resume, this.cwd, env.CLAUDE_CONFIG_DIR || ''); } catch { /* the resume reports it if the conversation is really gone */ } }
    // Rex Desk refuses nothing here: every team works its own way, so the agent decides from what the person says, and asks them when unsure.
    // includePartialMessages: the reply arrives word by word as it is written, so read-aloud can speak it while it is written.
    // Claude Code is started here (as the Agent SDK would) so its process id is known: a stuck turn ends that process tree only.
    const ownSpawn = this.sdk ? {} : { spawnClaudeCodeProcess: ({ command, args, cwd, env: childEnv, signal }) => {
      const child = spawn(command, args, { cwd, env: childEnv, signal, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.childPid = child.pid; return child;
    } };
    const options = { cwd: this.cwd, env, abortController: this.controller, includePartialMessages: true, ...ownSpawn,
      permissionMode: mode, ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(this.run.effort ? { effort: this.run.effort } : {}),
      // Claude Code's own question prompt would not reach the dashboard; the agent asks through desk_ask instead.
      disallowedTools: [...(this.run?.locked ? ['AskUserQuestion', 'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'Workflow'] : ['AskUserQuestion']), ...(this.mcpOff || []).filter(name => /^[\w-]+$/.test(name)).map(name => `mcp__${name}`)],
      additionalDirectories: this.run?.locked ? [] : [this.artifactDirectory, this.uploadsDirectory, this.projectDirectory].filter(Boolean),
      settingSources: this.run?.locked ? [] : ['user', 'project', 'local'],
      settings: COST_SETTINGS,
      // Through the toolbox (desk_find, desk_run) the agent reaches every skill on demand, so none is listed up front.
      ...(this.gateway ? { skills: [] } : {}),
      hooks: {
        // Every command and file edit is checked first: one that would take down Rex Desk itself is refused, with the reason.
        PreToolUse: [{ hooks: [async input => {
          const reason = (this.run?.locked ? lockedDenial(input?.tool_name, input?.tool_input, this.cwd) : '') || guardTool(input?.tool_name, input?.tool_input, this.guard || {});
          if (!reason) {
            const note = this.takeCancelNote(), trimmed = mode === 'bypassPermissions' ? trimTestCommand(input?.tool_name, input?.tool_input) : null;
            if (trimmed) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: trimmed, ...(note ? { additionalContext: note } : {}) } };
            return note ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } } : {};
          }
          this.event('agent-tool', { tool: 'Blocked by Rex Desk', failed: true, text: reason });
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
        }] }],
        PostToolUse: [{ hooks: [async () => {
        // New messages for this agent arrived while it worked: hand them over now, between steps.
        const news = this.inbox?.() || '', note = this.takeCancelNote();
        // Handed over between steps: taken once the model answers after it (the next real output says prompt-accepted again).
        if (news) this.acceptedSaid = false;
        const text = [note, news ? `New messages arrived while you were working. Read them now; they may change what you are doing. Answer them in your reply.\n\n${news}` : ''].filter(Boolean).join('\n\n');
        return text ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } } : {};
      }] }] },
      ...(executable.command.includes('/') || executable.command.includes('\\') ? { pathToClaudeCodeExecutable: executable.command } : {}),
      ...(this.model ? { model: this.model } : {}), ...(resume ? { resume } : {}),
      strictMcpConfig: true,
      mcpServers: this.run?.locked ? {} : { ...(this.gateway ? {} : withoutOff(connections, this.mcpOff)), ...withoutOff(this.extraMcp || {}, this.mcpOff), rex_desk: { type: 'http', url: this.mcpUrl, headers: { Authorization: `Bearer ${this.token}` }, alwaysLoad: true } },
      onElicitation: async request => {
        const answer = await this.ask({ kind: 'question', title: request.message, request, method: 'elicitation' });
        return { action: answer.action, ...(answer.action === 'accept' ? { content: answer.content || {} } : {}) };
      },
      // Only reached in modes that ask: each request becomes an approval card in the chat.
      canUseTool: async (name, input, context) => {
        if (quietRexTool(name) || allowedTools.has(name) || mainLooks(this.run, name)) return { behavior: 'allow', updatedInput: input };
        const answer = await this.ask({ kind: 'approval', title: `Approve ${name}`, request: { tool: name, input, suggestions: context.suggestions, allowAlways: true }, method: 'claude-permission' });
        if (answer.action === 'accept' && answer.content?.always) allowedTools.add(name);
        return answer.action === 'accept' ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'User declined this action.' };
      },
    };
    // Continue in Claude app: the session stays open on a stream of messages instead of ending after one reply, and Remote
    // Control connects it to claude.ai/code and the Claude app. The person writes there, or in Rex Desk (its inbox).
    const remote = this.remote ? this.remoteMessages(prompt) : null;
    this.query = query({ prompt: remote || withImages(prompt) || prompt, options });
    if (remote) {
      const connect = typeof this.query.enableRemoteControl === 'function' ? this.query.enableRemoteControl(true, String(this.remote).slice(0, 80))
        : Promise.reject(new Error('This Claude Code version cannot connect to the Claude app. Update Claude Code, then try again.'));
      void connect.then(answer => this.event('remote-control', { url: answer?.session_url || '', connectUrl: answer?.connect_url || '' }),
        error => this.event('remote-control', { error: String(error?.message || error) }));
    }
    let answered = false, skipped = null;
    for await (const message of this.query) {
      // The agent's own words as they are written (not a sub-agent's): the text so far of the current block, a few times a
      // second. Shown and spoken live; the finished block still arrives as agent-text below and is what is saved.
      if (message.type === 'stream_event') {
        const part = message.event || {};
        if (!message.parent_tool_use_id) {
          if (part.type === 'content_block_start') this.partial = '';
          if (part.type === 'content_block_delta' && part.delta?.type === 'text_delta') {
            this.accepted();
            this.partial = `${this.partial || ''}${part.delta.text || ''}`;
            if (Date.now() - (this.partialAt || 0) > 120) { this.partialAt = Date.now(); this.event('agent-text-partial', { text: this.partial }); }
          }
        }
        continue;
      }
      if (message.type === 'system' && message.subtype === 'init') { this.apiKeySource = message.apiKeySource; this.event('session', { sessionId: message.session_id, apiKeySource: message.apiKeySource }); }
      // How much of the account's 5-hour and weekly limits is used, as Claude Code reports it during a turn.
      if (message.type === 'rate_limit_event' && message.rate_limit_info) this.event('rate-limit', { ...message.rate_limit_info });
      if (message.type === 'assistant') {
        // The model itself answered, so the prompt was taken. Claude Code writes a sign-in or API error as a reply of its own
        // (model "<synthetic>"), and its result comes before the error check below: neither of those counts.
        if (message.message?.model && message.message.model !== '<synthetic>') this.accepted();
        // How full the conversation is: everything the model read for this step (new, cached and cache-written input).
        const used = message.message?.usage; if (used && !message.parent_tool_use_id) { this.contextUsed = (used.input_tokens || 0) + (used.cache_read_input_tokens || 0) + (used.cache_creation_input_tokens || 0); this.event('context', { used: this.contextUsed, model: message.message?.model || '', ...(this.contextWindow ? { window: this.contextWindow } : {}) }); }
        const content = message.message?.content?.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking');
        // What the agent says shows in the chat; its tool calls stay in the journal.
        const text = (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
        // A sub-agent's own words and steps belong to its card in the chat, not to the agent's reply.
        const parent = message.parent_tool_use_id || null;
        if (text) this.event(parent ? 'subagent-text' : 'agent-text', parent ? { parent, text: text.slice(0, 4000) } : { text });
        for (const block of content || []) if (block.type === 'tool_use') {
          if (isShell(block.name)) (this.terminals ||= new Set()).add(block.id);
          if (/^(Task|Agent)$/.test(block.name)) { (this.subagents ||= new Set()).add(block.id); this.event('agent-tool', { id: block.id, tool: 'Agent', ...(parent ? { parent } : {}), input: { description: String(block.input?.description || '').slice(0, 200), type: String(block.input?.subagent_type || 'general-purpose'), model: String(block.input?.model || ''), prompt: String(block.input?.prompt || '').slice(0, 1500) } }); continue; }
          const change = fileChange(block.name, block.input); if (change) (this.edits ||= new Map()).set(block.id, change.file);
          this.event('agent-tool', { id: block.id, tool: String(block.name).replace(/^mcp__[a-z0-9_]+?__/i, ''), ...(parent ? { parent } : {}), input: toolInput(block.input), ...(change ? { change } : {}) });
        }
        this.event('agent-operation', { type: 'assistant', content });
      }
      if (message.type === 'user' && remote) {
        // Something the person wrote in the Claude app (Rex Desk did not send it): it shows in Rex Desk's chat as theirs.
        const said = typeof message.message?.content === 'string' ? message.message.content
          : (Array.isArray(message.message?.content) && !message.message.content.some(block => block.type === 'tool_result') ? message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '');
        if (said.trim() && !this.sent?.delete(said)) this.event('app-message', { text: said.trim().slice(0, 20000) });
      }
      if (message.type === 'user') {
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block.type !== 'tool_result') continue;
          if (this.subagents?.has(block.tool_use_id)) { const said = Array.isArray(block.content) ? block.content.map(part => part.text || '').join('\n') : String(block.content || ''); this.event('subagent-done', { id: block.tool_use_id, failed: Boolean(block.is_error), text: said.slice(0, 3000) }); continue; }
          // A step Claude Code cancelled by itself: not shown as a failure, and the agent is told at once to run it again.
          if (block.is_error && cancelledByItself(block.content)) { this.noteCancelled(); continue; }
          this.cancelStreak = 0;
          // A file edit that worked: the file's hash as the agent left it, so Follow me can tell later whether it is still only theirs.
          if (this.edits?.has(block.tool_use_id)) { const file = this.edits.get(block.tool_use_id); this.edits.delete(block.tool_use_id); if (!block.is_error) { const sha = fileHash(file); if (sha) this.event('agent-file', { file, sha }); } }
          if (this.terminals?.has(block.tool_use_id)) this.event('agent-tool-result', { id: block.tool_use_id, text: terminalText(block.content), failed: Boolean(block.is_error) });
          else if (block.is_error) this.event('agent-tool', { tool: 'result', failed: true, text: (Array.isArray(block.content) ? block.content.map(part => part.text || '').join(' ') : String(block.content || '')).slice(0, 300) });
        }
        this.event('agent-operation', { type: 'tool-result', content: message.message?.content });
      }
      if (this.cancelStreak >= STUCK_AFTER) {
        this.stuck = true; this.cancelPending = false;
        this.event('steps-stuck', { count: this.cancelStreak });
        await (this.endTree || endProcessTree)(this.childPid);
        break;
      }
      if (message.type === 'assistant' && !message.parent_tool_use_id) answered = true;
      // A background task the last turn left running is reported first when the conversation reopens ("it stopped"), as a turn
      // of its own with no step and no words, and the person's message waits behind it. That is not the reply: taking it for
      // the end of the turn closed Claude Code with the message still unread. Keep reading; the real reply follows. It is
      // shown only when nothing follows (a hook refused the message), so the chat never says "Turn ended" for a note.
      if (message.type === 'result' && !remote && !answered && !message.is_error && !message.num_turns && !String(message.result || '').trim()) { skipped = message; continue; }
      if (message.type === 'result') {
        skipped = null;
        // The real context window of the model, as Claude Code reports it, so the circle and auto handoff do not guess 200k.
        const windows = Object.values(message.modelUsage || {}).map(usage => Number(usage?.contextWindow) || 0).filter(Boolean);
        if (windows.length) { this.contextWindow = Math.max(...windows); if (this.contextUsed) this.event('context', { used: this.contextUsed, window: this.contextWindow }); }
        // The CLI reports a signed-out profile as an ordinary result: marked as an error from the start, so it is never passed on
        // as the agent's words (an open Claude-app session sends each reply to Telegram as it comes).
        const signedOut = /not logged in|please run \/login/i.test(String(message.result || ''));
        this.event('agent-result', { result: message.result, errors: message.errors, subtype: message.subtype, isError: Boolean(message.is_error) || signedOut, cost: message.total_cost_usd, tokens: tokensOf(message.usage), steps: message.num_turns || 0, durationMs: message.duration_ms || 0, billedToApiKey: ['user', 'project', 'org', 'temporary'].includes(this.apiKeySource) });
        // Surface it as a setup problem, not agent output.
        if (signedOut) throw new Error(`Claude Code profile ${env.CLAUDE_CONFIG_DIR || '~/.claude'} is not signed in. Open Setup, choose a signed-in Claude Code profile, then continue this run.`);
        // An open Claude-app session carries on after one failed reply; the person sees it and writes again.
        if (message.is_error && !remote) throw new Error(message.errors?.join('\n') || message.result || `Claude ended with ${message.subtype}.`);
        // The reply is the end of the turn. Claude Code itself keeps running while a task the agent started in the background
        // (a test, a dev server) is still going, and a stuck one held the turn open for good: the chat showed it still working,
        // and every new message waited for a step that never came. Leaving the loop ends Claude Code and its background tasks;
        // the next message starts a new turn in the same conversation.
        if (!remote) break;
      }
    }
    if (skipped) this.event('agent-result', { result: '', subtype: skipped.subtype, cost: skipped.total_cost_usd, tokens: tokensOf(skipped.usage), steps: 0, durationMs: skipped.duration_ms || 0, billedToApiKey: ['user', 'project', 'org', 'temporary'].includes(this.apiKeySource) });
    // A step was cancelled and the agent ended its turn without another step, so the note never reached it: it gets the note
    // at once in a quiet follow-up, instead of having guessed.
    if (this.cancelPending && !this.signal?.aborted) this.requeue?.(this.takeCancelNote());
    return { status: 'completed', ...(this.stuck ? { stuck: true } : {}) };
  }
  // The messages of an open Claude-app session: the first one (if any), then whatever arrives in Rex Desk, until Stop.
  async *remoteMessages(first) {
    // What Rex Desk sends is remembered, so its echo in the stream is not taken for a message from the Claude app.
    const user = text => { (this.sent ||= new Set()).add(text); return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }; };
    if (String(first || '').trim()) yield user(first);
    while (!this.signal?.aborted && !this.ended) {
      const news = this.inbox?.() || '';
      if (news) { this.acceptedSaid = false; yield user(news); }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
  async interrupt() { this.ended = true; await this.query?.interrupt(); this.query?.close(); }
  close() { this.query?.close(); }
}

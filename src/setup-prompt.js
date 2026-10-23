import path from 'node:path';
import os from 'node:os';

// Copyable setup instructions for another AI. Credentials are never embedded; remote setups use a placeholder.
const quote = value => `"${String(value).replaceAll('"', '\\"')}"`;
export function setupPrompt({ target = 'local', root, dataDirectory, mcpUrl, profiles = {}, node = process.execPath } = {}) {
  const proxy = path.join(root, 'src', 'stdio.js');
  const claudeHome = profiles.claude || path.join(os.homedir(), '.claude');
  const claudeConfig = profiles.claude ? path.join(profiles.claude, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const codexHome = profiles.codex || path.join(os.homedir(), '.codex');
  const verify = 'Verify by listing MCP servers, then call the read-only tool desk_tasks once and report how many tasks it returned. Do not call tools that dispatch agents, change tracker status, push, or create pull requests.';
  if (target === 'remote') {
    return [
      'Set up an MCP connection named rex_desk for this AI client.',
      '',
      'Connection:',
      '- Transport: Streamable HTTP',
      '- URL: https://<YOUR-REX-DESK-HOST>/mcp',
      '- Header: Authorization: Bearer ${REX_DESK_TOKEN}',
      '',
      'Secret handling:',
      '- Read the token from an environment variable or secret store named REX_DESK_TOKEN.',
      '- I will provide the token value separately. It is in Rex Desk Settings > AI connection > Copy access token.',
      '- Never write the token into a committed file, a chat message, or a log.',
      '',
      `Rex Desk runs locally at ${mcpUrl || 'http://127.0.0.1:4317/mcp'}. A cloud client needs an HTTPS route to that address; replace <YOUR-REX-DESK-HOST> with that route's host name.`,
      'The route must forward only /mcp and keep bearer authentication. Do not expose the dashboard API.',
      '',
      `If the client can only keep short tool calls open, use desk_ask with wait=false and poll desk_question. ${verify}`,
    ].join('\n');
  }
  return [
    'Set up the local Rex Desk MCP server on this Windows computer for both Claude Code and Codex.',
    '',
    'Server:',
    '- Name: rex_desk',
    '- Transport: stdio',
    `- Command: ${quote(node)} ${quote(proxy)}`,
    '- No API key or token is needed. The proxy reads its local connection token itself.',
    `  Do not open, print, or copy ${quote(path.join(dataDirectory, 'desk.sqlite'))} or ${quote(path.join(dataDirectory, 'vault.key'))}.`,
    '',
    'Claude Code:',
    `- Profile folder: ${quote(claudeHome)}${profiles.claude ? ` (set CLAUDE_CONFIG_DIR=${quote(profiles.claude)} for the command)` : ''}`,
    `- Run: claude mcp add --scope user rex_desk -- ${quote(node)} ${quote(proxy)}`,
    `- The entry is written to ${quote(claudeConfig)}.`,
    '',
    'Codex:',
    `- Profile folder: ${quote(codexHome)}${profiles.codex ? ` (set CODEX_HOME=${quote(profiles.codex)} for the command)` : ''}`,
    `- Run: codex mcp add rex_desk -- ${quote(node)} ${quote(proxy)}`,
    `- The entry is written to ${quote(path.join(codexHome, 'config.toml'))}.`,
    '',
    'Rules:',
    '- If rex_desk already exists, keep it when its command matches; otherwise replace only that entry.',
    '- Do not change, remove, or print other MCP servers or their credentials.',
    `- Rex Desk must be running. If it is not, start it with: cd ${quote(root)}; npm start`,
    '',
    verify,
  ].join('\n');
}

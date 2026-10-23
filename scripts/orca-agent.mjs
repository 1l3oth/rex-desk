// Runs inside an Orca terminal. Reads a one-time spec written by Rex Desk, deletes it, and starts the agent CLI
// interactively, so tool approvals stay in the terminal while questions and evidence go through the run-scoped MCP.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const specFile = process.argv[2];
if (!specFile) { console.error('Rex Desk agent spec is missing.'); process.exit(2); }
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
rmSync(specFile, { force: true });
const env = { ...process.env, ...spec.env, REX_AGENT_TOKEN: spec.token, REX_DESK_TOKEN: spec.token, REX_DESK_URL: spec.mcpUrl };
for (const key of spec.unset || []) delete env[key];
delete env.CLAUDECODE;
let args, cleanup = () => {};
if (spec.provider === 'claude') {
  const config = path.join(path.dirname(specFile), `mcp-${process.pid}.json`);
  writeFileSync(config, JSON.stringify({ mcpServers: { rex_desk_run: { type: 'http', url: spec.mcpUrl, headers: { Authorization: `Bearer ${spec.token}` } } } }), { mode: 0o600 });
  cleanup = () => rmSync(config, { force: true });
  args = [...spec.executable.args, '--mcp-config', config, ...(spec.model ? ['--model', spec.model] : []), spec.prompt];
} else {
  args = [...spec.executable.args, '-c', 'mcp_servers.rex_desk.enabled=false', '-c', `mcp_servers.rex_desk_run.url=${JSON.stringify(spec.mcpUrl)}`,
    '-c', 'mcp_servers.rex_desk_run.bearer_token_env_var="REX_AGENT_TOKEN"', '-c', 'mcp_servers.rex_desk_run.tool_timeout_sec=86400',
    ...(spec.model ? ['-m', spec.model] : []), spec.prompt];
}
console.log(`Rex Desk run ${spec.runId}: starting ${spec.provider === 'claude' ? 'Claude Code' : 'Codex'} in ${spec.cwd}`);
const child = spawn(spec.executable.command, args, { cwd: spec.cwd, env, stdio: 'inherit', windowsHide: false });
const finish = code => { cleanup(); console.log(`\nRex Desk agent exited (code ${code ?? 'signal'}). Run ${spec.runId}.`); process.exit(code ?? 1); };
child.once('error', error => { console.error(error.message); finish(127); });
child.once('exit', code => finish(code));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));

// Keeps agents from taking down the Rex Desk they run inside. Two layers: a rule every agent reads (PROTECT_RULE), and a
// check on every command and file edit before it runs (guardTool, wired into the Claude runner as a PreToolUse hook), so a
// command that would end Rex Desk, wipe its data or change the installed app is refused with a reason the agent reads.
import path from 'node:path';

export const PROTECT_RULE = 'Rex Desk is the app you run inside; keep it running. Never stop, kill or restart its processes: not Rex Desk itself, not every Node process at once (no "taskkill /IM node.exe", "Stop-Process -Name node", "pkill node"), and not its window. To stop one program of your own, stop it by its own process id. Never delete, move or edit Rex Desk\'s data folder, its database or keys, or the installed app\'s folder, and never start another Rex Desk server on its port (4317). If a task seems to need any of this, ask the person instead. Rex Desk refuses such commands.';

// What every agent knows about Rex Desk itself, so it can help the person run it: restarting, updates, and where each
// setting is. Kept in step with the Settings screen (public/chat-settings.js: SECTIONS and GROUPS).
export const APP_GUIDE = `How Rex Desk works, for helping the person (tell them the steps; you never restart or update it yourself):
- Restart: right-click the Rex Desk icon by the clock and choose "Restart Rex Desk server", or press Restart on the start screen. Agents keep working through a restart. If the window is black or stuck, that same Restart is the fix.
- Updates: Rex Desk checks for a new version every 10 minutes and whenever its window comes back. A card at the bottom right shows what changed, with "Update now" and "Later"; while agents work it offers "Update when it finishes", which installs once they are done. A small window shows the install's progress, and Rex Desk opens again by itself. To check now: Settings, Backup and updates, Check now.
- Settings (the gear at the bottom left), in four groups:
  You: General (your name, theme, start with Windows, the setup tour); Notifications (pop-ups, sound, phone, quiet hours); Jev and voice (issue ranking, letting Jev or agents control this computer, speech).
  Agents: Agents (how many work at once, default model, branch names, the mode new chats start in, acting on their own, saving Claude usage); Claude accounts (which subscription agents use, switching when one runs out); Schedule (start work on its own at a set time); Test sign-ins (accounts agents use in previews, never seen by them).
  Work: Projects (repositories, base and target branches, setup, run and test commands, which computer a project's agents work on, keeping a project out of the cloud); Task sources (Rex Desk tasks, Orbit, Flow, Morningmate); Connect another AI (setup text for another assistant).
  Data and devices: Folders (move Rex Desk's data and files from agents; the AI memory stays in the home folder); Backup and updates (cloud backup with a Rex Desk account or Turso, upload now and check, app updates); Devices and phone (other computers and the phone over Tailscale).
- In the sidebar: drag agents and group chats to reorder them, use the pin (or drop on Pinned) to keep them on top, and click an agent's avatar on its page to change it. A chat's "Continue in Claude app" opens it in claude.ai/code and the Claude app.`;

const KILL = String.raw`(?:taskkill|stop-process|spps|kill|pkill|killall|tskill|wmic[^|&;\n]*(?:delete|terminate))`;
const REMOVE = String.raw`(?:remove-item|\brm\b|\brmdir\b|\brd\b|\bdel\b|\berase\b|move-item|\bmv\b|\bmove\b|rename-item|\bren\b|clear-content|set-content|out-file)`;
// Files in Rex Desk's data folder that hold the workspace itself: its database, keys and the lock of the running server.
const DATA_FILES = new Set(['desk.sqlite', 'desk.sqlite-wal', 'desk.sqlite-shm', 'runtime.lock', 'accounts.json', 'vault.key', 'turso.connection', 'node.id', 'workspace.id', 'server.version']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const normal = value => path.resolve(String(value || '')).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
const inside = (file, folder) => Boolean(folder) && (file === folder || file.startsWith(`${folder}/`));
// The ways a command can name a folder: as it is, with either slash, or through %APPDATA% / $env:APPDATA.
const spellings = folder => {
  if (!folder) return [];
  const plain = normal(folder), back = plain.replace(/\//g, '\\'), names = [plain, back];
  const appData = process.env.APPDATA ? normal(process.env.APPDATA) : '';
  if (appData && inside(plain, appData)) { const rest = plain.slice(appData.length); names.push(`%appdata%${rest}`, `%appdata%${rest.replace(/\//g, '\\')}`, `$env:appdata${rest}`, `$env:appdata${rest.replace(/\//g, '\\')}`); }
  return names;
};

// places: { data: Rex Desk's data folder, install: the installed app's folder (empty for a source checkout, which is a
// project agents may work on), serverPid: the process id of the Rex Desk server }.
export function guardTool(name, input = {}, places = {}) {
  const data = places.data ? normal(places.data) : '', install = places.install ? normal(places.install) : '';
  if (SHELL_TOOLS.has(name)) {
    const command = String(input.command || '').toLowerCase().replace(/\\\\/g, '\\');
    if (new RegExp(String.raw`(?:taskkill[^|&;\n]*/im[^|&;\n]*\bnode(?:\.exe)?\b|stop-process[^|&;\n]*-name\s+['"]?node\b|(?:get-process|gps)\s+['"]?node\b[^\n]*\|\s*(?:stop-process|spps|kill)|\b(?:pkill|killall)\b[^|&;\n]*\bnode\b|wmic[^\n]*node\.exe[^\n]*(?:delete|terminate))`).test(command))
      return 'Rex Desk blocked this: it would stop every Node process, and Rex Desk itself runs on Node. Stop only your own program, by its process id.';
    if (new RegExp(`${KILL}[^|&;\\n]*rex-desk`).test(command)) return 'Rex Desk blocked this: it would close the Rex Desk app you run inside.';
    if (places.serverPid && new RegExp(`${KILL}[^|&;\\n]*(?:^|[^0-9])${Number(places.serverPid)}(?:[^0-9]|$)`).test(command)) return 'Rex Desk blocked this: that process id is the Rex Desk server you run inside.';
    for (const [folder, what] of [[install, 'the installed Rex Desk app'], [data, "Rex Desk's data (chats, settings and keys)"]])
      for (const spelled of spellings(folder)) if (command.includes(spelled) && new RegExp(REMOVE).test(command)) return `Rex Desk blocked this: it would delete or change ${what}. Ask the person if that is really needed.`;
    if (install && /uninstall\.exe/.test(command) && spellings(install).some(spelled => command.includes(spelled))) return 'Rex Desk blocked this: it would uninstall Rex Desk.';
    if (/\bport\s*=\s*4317\b|--port[ =]4317\b/.test(command) && /server\.js/.test(command)) return 'Rex Desk blocked this: port 4317 is the real Rex Desk. Start a development copy without PORT (it uses 4318).';
    return '';
  }
  if (EDIT_TOOLS.has(name)) {
    const file = normal(input.file_path || input.notebook_path || '');
    if (!file) return '';
    if (inside(file, install)) return 'Rex Desk blocked this: files of the installed Rex Desk app are not edited by hand; changes go out as a release.';
    if (inside(file, data) && DATA_FILES.has(path.basename(file))) return "Rex Desk blocked this: that file is Rex Desk's own database, keys or lock.";
  }
  return '';
}

---
name: rex-desk-guide
description: Where everything in Rex Desk lives. A map of every feature and the exact screen it is on, so you can answer "how do I..." and "where is..." questions about Rex Desk itself and walk the person straight to the right place.
---

# Where everything in Rex Desk lives

Use this to answer "how do I...", "where is...", and "can Rex Desk..." questions about the app itself. Name the exact screen and the steps, in plain words. Keep this in step with the app: when a Settings page or tab is added, moved or renamed, update this guide (a test checks every Settings page is listed here).

For restart and updates, see the short notes under About below; you never restart or update Rex Desk yourself, you tell the person the steps.

## The main window

- **Sidebar (left):** your agents and group chats. Drag to reorder, pin to keep on top, drop on Pinned. Click an agent's avatar on its page to change it. "Continue in Claude app" on a chat opens it in claude.ai/code.
- **Chat (middle):** talk to an agent or Rex Agent. The message box is where you type; `@` mentions, `#` points at a task. Attach files, or hold Space to dictate by voice.
- **Needs you:** where an agent's questions, approvals, and OKs on screenshots or pages wait for you.
- **Tasks:** issues from connected trackers and the Rex Desk tasks kept here.
- **Market:** tools and skills an agent can switch on. "Ask AI" there explains an item simply.
- **Devices:** your computers and your phone. The Phone card has one switch and the "Ask Rex Agent" button to set the phone up for you; Advanced holds Tailscale, add-a-computer and the device keys. Setting up the phone is covered by the `rex-setup-phone` skill.
- **Settings (the gear, bottom left):** everything below. Changes save by themselves; there is no Save button.

## Settings, group "You"

- **General** (`general`): your name, language, the look and theme (light or dark), text size, see-through window, and "Start Rex Desk when I sign in to Windows". The setup tour starts here.
- **Notifications** (`notify`): pop-ups, sound, phone alerts, and quiet hours. During quiet hours an agent that needs you waits in Needs you.
- **Jev and voice** (`jev`): turn Jev and voice on; let Jev or agents control this computer (with "ask me before shutting down"); the OpenRouter key for issue ranking and the Gemini voice; issue ranking settings; and the speech and reading-voice engines.

## Settings, group "Agents"

- **AI** (`ai`) holds two pages:
  - Accounts (`accounts`): set up or sign in to Claude Code, Codex, Gemini, or add more accounts; pick the default model; see how much of each plan is used.
  - Local AI (`localai`): install Ollama and a model that runs on this computer, for agents that use a local model.
- **Agents** (`agents`): how many agents run at once, the default model, branch-name prefix, the mode new chats start in, letting agents act on their own, "Save my Claude usage", and when a chat starts fresh (the handoff token limit).
- Tools and skills live in the Market and through `desk_find` / `desk_run`; MCP servers, skills, commands and hooks on this computer are managed there.

## Settings, group "Work"

- **Projects** (`projects`) holds:
  - Projects (`projects`): the repositories agents work on, each with base and target branch, setup / run / test commands, the work folder, how changes go out (draft PR or straight push), and which computer a project's agents run on or whether it stays out of the cloud. Add a project by folder or GitHub owner/name.
  - Test sign-ins (`signins`): accounts an agent can use to sign in to a preview it starts, without ever seeing the password. Never used on a live site.
- **Connectors** (`connectors`) holds:
  - Connectors (`sources`): the apps this desk is linked to (task trackers, chat, code hosts, docs). Empty until you press Add connector. A task tracker brings its issues into Tasks.
  - Schedule (`schedule`): start work on its own at a set time on set days, up to a daily run limit; "run it now".
  - Telegram group bot (`bugbot`): a separate Telegram bot you add to your own groups and run for your own purpose (for example collecting bug reports). Connect its token, say what it is for, allow groups, set the daily summary time, and approve or reject what it collects.

## Settings, group "This computer"

- **Account and backup** (`backup`): your Rex Desk account and plan, payments, cloud backup (Rex Desk account or Turso), "upload now and check", and your other computers and phone. The phone device list and plan are reached from here (`devices`, `plan`).
- **Storage** (`storage`) holds:
  - Storage (`storage`): what takes space here and in the cloud, with one-click clean-ups.
  - Folders (`folders`): where Rex Desk keeps its data and agents' files; move the files folder to a bigger drive.
- **About** (`about`): the version, counts, where everything lives, and "Check for updates".
  - Restart: right-click the Rex Desk icon by the clock and choose "Restart Rex Desk server", or press Restart on the start screen. Agents keep working through a restart; it is also the fix for a black or stuck window.
  - Updates: Rex Desk checks every 10 minutes and when its window returns; a card at the bottom right shows what changed with "Update now" and "Later". Agents keep working through an update on Windows.

# Rex Desk

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user: a desktop application or web application is acceptable if lightweight. Implementation choice: Node.js 24, a buildless browser UI, SQLite, and MCP. The separate directory F:\rex-desk was proposed and accepted in the user's provider preference reply. The working name is inferred.

## Users

A developer handling QA issues assigned to them across specific Flow and Morningmate projects. Their source repositories already exist locally.

The user primarily uses Claude Code and explicitly requires switching between Claude Code and Codex and running both. Claude Code is the default. API credentials, account identity, project choices, repositories, agent sign-in profiles, and runtime profiles belong in editable application settings; do not request them in chat. The user works inside Orca and wants agents visible there when chosen.

## Product Purpose

Replace checking issue trackers, copying issue details into terminals, and coordinating coding agents manually with one local dashboard.

## Operating Context

Fetch assigned issues; analyze and categorize them with a main agent; dispatch work into separate Git worktrees; ask the user questions and seek approval in the dashboard; review test recordings and proposed pull requests. Codex and Claude Code are installed. Orbit is configured in Claude Code.

## Capabilities and Constraints

Keep the application separate from Flow, Morningmate, and Electron source repositories. Select source projects, repository paths, base branches, PR targets, agent providers, agent profiles, execution surface (Rex Desk or Orca terminal), runtime profiles, and concurrency. Discover choices from APIs and installed CLIs instead of asking for IDs. Sync only Request and In progress tasks by default. Use branches under temp/rex/<issue>/<short-name>, without a leading slash because Git forbids it. Preserve source tracker status definitions. Record work and attach verification evidence. Show deliberate agent messages and human decisions rather than every internal operation. External local or cloud agents should be able to use the project's MCP server.

The user confirmed a compact issue list with a selected issue's messages, questions, approvals, and evidence, plus a second Kanban view of task progress.

## Evidence on Hand

The user saved a Morningmate API key and selected two QA projects in Settings; live sync returns their assigned Request and In progress tasks through the filtered task API, with titles and fields from task columns. Flow (`F:low-was`) switches product through `globalConfig/default_region`; both profiles were started in isolated Tomcat runtimes. `F:low-electron-github` runs as an isolated Electron app. Any preview issue content must be clearly labeled as demonstration data.

## Product Principles

- The issue is the unit of work and evidence.
- Questions and approvals must survive refreshes and have explicit outcomes.
- Keep worktree processes, browser sessions, and ports separate.
- Never call an issue resolved merely because an agent stopped.
- Minimize background services and idle resource use.
- Guide setup in the product; the user should never have to repeat it in chat.

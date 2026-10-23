# Rex Desk

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user: a desktop application or web application is acceptable if lightweight. Implementation choice: Node.js 24, a buildless browser UI, SQLite, and MCP. The separate directory F:\rex-desk was proposed and accepted in the user's provider preference reply. The working name is inferred.

## Users

A developer handling QA issues assigned to them across specific Flow and Morningmate projects. Their source repositories already exist locally.

The user primarily uses Claude Code and explicitly requires switching between Claude Code and Codex and running both. Claude Code is the default. API credentials, account identity, and project IDs belong in editable application settings; do not request them in chat.

## Product Purpose

Replace checking issue trackers, copying issue details into terminals, and coordinating coding agents manually with one local dashboard.

## Operating Context

Fetch assigned issues; analyze and categorize them with a main agent; dispatch work into separate Git worktrees; ask the user questions and seek approval in the dashboard; review test recordings and proposed pull requests. Codex and Claude Code are installed. Orbit is configured in Claude Code.

## Capabilities and Constraints

Keep the application separate from Flow, Morningmate, and Electron source repositories. Select source projects, repository paths, base branches, PR targets, agent providers, and concurrency. Use branches under temp/rex/<issue>/<short-name>, without a leading slash because Git forbids it. Preserve source tracker status definitions. Record work and attach verification evidence. Show deliberate agent messages and human decisions rather than every internal operation. External local or cloud agents should be able to use the project's MCP server.

The user confirmed a compact issue list with a selected issue's messages, questions, approvals, and evidence, plus a second Kanban view of task progress.

## Evidence on Hand

The public Morningmate OpenAPI documentation has been read. No source API keys, project IDs, authenticated test accounts, or repository-specific build commands have been provided. Any preview issue content must be clearly labeled as demonstration data.

## Product Principles

- The issue is the unit of work and evidence.
- Questions and approvals must survive refreshes and have explicit outcomes.
- Keep worktree processes, browser sessions, and ports separate.
- Never call an issue resolved merely because an agent stopped.
- Minimize background services and idle resource use.

# Rex Desk

A local QA issue workspace for Flow and Morningmate. It imports tasks assigned to you, lets a main agent classify and dispatch them, and keeps questions, approvals, worktrees, and test evidence together.

The application is independent of your product repositories. It uses one Node.js process, SQLite with an optional Turso copy, and a buildless browser interface. Browsers, Tomcat, Electron, and coding agents start only when a run needs them.

## Start

Requires Node.js 24+, Git, and Claude Code or Codex installed on this computer. GitHub CLI (`gh`) and an authenticated repository remote are needed to create PRs. Orca is optional.

```powershell
cd F:\rex-desk
npm ci
npx playwright install chromium
npm start
```

Open **http://127.0.0.1:4317**. On Windows, `Start-RexDesk.ps1` starts the server in the background and opens the dashboard; `-NoBrowser` skips opening it. It reuses a running server. The launcher needs no `CLAUDE_CONFIG_DIR` or `CODEX_HOME`: agent profiles are saved in Settings.

### Desktop app

`desktop/` is a Tauri window around the same dashboard. Install it from the GitHub release (`Rex Desk_<version>_x64-setup.exe`, per-user, no admin) or build it with Rust and the MSVC build tools:

```powershell
npm install --prefix desktop
npm run build --prefix desktop
```

On launch it starts `node src/server.js` from the checkout if nothing answers on port 4317, then shows the dashboard. It finds the checkout through `REX_DESK_HOME`, then the folder it was built from, then `F:\rex-desk`. Closing the window leaves the server running, so agent runs continue. The dashboard page gets no Tauri APIs. `Start-RexDesk.ps1 -App` opens the dashboard as an Edge app window instead.

## Guided setup

A new workspace opens **Setup**. Each step reads your real settings, so the page always shows the actual remaining work; the issue list shows the next step until required setup is done.

1. **Sign in your coding agent.** Rex Desk finds Claude Code and Codex profile folders (`~/.claude`, `~/.claude-*`, `~/.codex`, Orca's `claude-profiles`, and the folder of the terminal that started the server) and checks each with `claude auth status` / `codex login status`. Choose a profile that shows **Signed in**; the choice is saved immediately and used for every new run. When the selected profile is signed out, Setup offers the signed-in one. No model turn is spent on this check.
2. **Connect Flow or Morningmate.** Paste your user API key once. It is encrypted on this computer and never sent back to the browser.
3. **Choose projects and assignee.** *Connect & load projects / people* lists your projects and colleagues; search, tick projects, and pick the assignee from a searchable list. Manual IDs remain under *Enter IDs manually*. Sync imports **Request + In progress** by default; *All unfinished* and *All statuses* are explicit options.
4. **Add the source repository.** *Choose folder* opens a native picker; Git root, author, GitHub account, and branches load automatically. Base and PR-target branches are searchable. A single repository becomes every connection's default.
5. **Set preview and test commands.** Verification runs the real test command in each worktree. Browser proof needs a dev command with `{port}`, the Flow / Morningmate Tomcat preset, or the Electron preset.
6. **Connect your own AI tools** (optional). Install the local Rex Desk MCP into the selected Claude Code or Codex profile with one click, or copy a setup prompt for your AI.
7. **Sync and check.** Imports your assigned issues and checks installed tools.

Claude Code is the default agent; Settings and each run let you choose Codex instead. Both can run concurrently, up to the worker limit.

## Issues

The list and Kanban are two views of the same issues. Titles, numbers, status, reporter, dates, group, and custom tracker fields (for example Issue Type, Reproducibility, Region, OS) come from the tracker's task columns. Selecting an issue loads its description, screenshots, attachments, and comments once; later syncs keep them until the tracker reports a newer edit, and **Refresh** reloads on demand. Rich-text bodies are parsed, so tracker JSON is never shown. Tracker images are fetched through a local cache that accepts only image URLs already stored on that task; the dashboard page itself loads no remote content.

Search matches title, number, status, fields, reporter, and description without moving focus.

## Execution and evidence

The main agent receives the selected issue IDs and uses the Rex Desk MCP to read, categorize, and dispatch work. It keeps related changes sequential and parallelizes independent issues. Worker concurrency is enforced by the local queue.

Each run page shows the agent's conversation live: its text, every tool call with input and result (expand a row), and pending approvals at the end. Raw command and preview output stays in the work journal.

Each worker receives a new worktree and a unique branch from the repository's pattern (default `{prefix}/{source}-{taskId}/{title}-{runId}`):

```text
temp/rex/morningmate-4821/file-preview-stays-blank-a1b2c3
```

Git forbids a leading `/` in branch names. The current checkout is not switched, reset, cleaned, or copied into workers; workers use committed content from the selected base branch. Worktrees live under `worktrees/` and remain available for inspection. Each worker gets its own preview port, `PORT` variable, browser context, video, and Playwright trace. A worktree isolates Git changes; it is **not** an OS security sandbox.

Before any worktree or agent turn, a run checks that the selected agent profile is signed in and stops with a Setup link if not.

The recorded browser is exposed through `desk_browser`: navigation, CSS-selector actions, screenshots, and text/visibility assertions. Workers must commit the fix **before** `desk_verify`; verification stores the command's actual output, exit status, and a code fingerprint, and later changes invalidate it. By default a fix is ready for review only when the regression command passes, a browser video was saved, and a relevant assertion passed for the same code. `desk_finish` also requires a risk self-review (score 1–10, reasons, human-review flag); Rex Desk raises the score for sensitive, binary, application, or broad changes. Automatic draft PRs for verified 1–2/10 changes are off by default. Nothing is merged automatically.

An agent turn ending does not resolve an issue. Missing proof produces **Needs evidence**; an interrupted process produces **Interrupted**. You can continue a run with the same or another provider; switching starts a new conversation with the same worktree and recorded evidence.

### Flow / Morningmate Tomcat

When a repository has `src/WEB-INF`, inspection offers the isolated Tomcat preset. Each run gets its own `CATALINA_BASE`, logs, temp, work folder, and loopback HTTP port; shutdown, AJP, and JPDA listeners are disabled. JEX configuration and license files are **copied** from the seed folder into the worktree, never linked, and the seed checkout is never modified.

Each repository has **Flow** and **Morningmate** runtime profiles. Flow selects the product from `globalConfig/default_region` (`ap-northeast-2` runs Flow; any other region runs Morningmate), so a profile rewrites only `default_region`, `product_name`, `default_countryCode`, and `default_langCode` in the worktree's copy. A profile can use a separate seed folder when a product needs other database or API settings. Choose the default in Settings and override it per run. Build each branch's own frontend output; do not link `node_modules` or reuse another branch's `dist`.

### Electron apps

When a repository's `package.json` depends on Electron, inspection offers the isolated Electron preset. Recorded runs launch the worktree's own Electron through Playwright with `scripts/electron-isolation.cjs`, which moves user data, session data, logs, and crash dumps into the run folder and disables `electron-updater`, `auto-launch`, and URL-protocol registration, so the installed app and its protocol handlers are untouched. The worktree setup command installs dependencies (for `flow-electron-github`: `npm ci; npm ci --prefix app`).

### Running workers in Orca

Workers run headless in Rex Desk by default, with tool approvals in the dashboard. Choose **Orca terminal** in Settings or the run dialog to watch an agent live in Orca. Rex Desk still creates the worktree, branch, port, and runtime seed; Orca opens a terminal there running `scripts/orca-agent.mjs`, which reads a one-time spec, deletes it, and starts the agent with your selected profile and a run-scoped MCP token. The token is never typed into the terminal. Tool approvals then happen in the Orca terminal; questions (`desk_ask`), evidence, and PR approval stay in Rex Desk. The run ends when the agent finishes through MCP, exits, or its terminal closes; **Stop run** closes the terminal.

Orca shows these worktrees only when the repository's external-worktree visibility is **show**; the run dialog checks this and offers a one-click fix. **Open in Orca** on any run opens a plain terminal in its worktree without starting a second agent.

## Source statuses and pull requests

Sync reads each project's status definitions and makes them available to agents. Optional working/review/done mappings specify the tracker status values; unmapped phases leave the tracker unchanged, and every status change needs a dashboard approval. Local Kanban progress never rewrites tracker statuses.

**Create draft PR** shows the title, description, and editable target branch before publishing. It checks verified code, requires a clean committed branch, pushes it to `origin`, and creates a draft with `gh`. It never merges or deploys.

Orbit reporting is optional in Settings. Managed Claude workers also load MCP servers from your Claude configuration and the source repository's `.mcp.json`.

## Connect an existing AI

Settings → **Connect an existing AI** installs the local stdio proxy into the selected Claude Code or Codex profile, or copies a setup prompt for your AI:

- **Local prompt**: names the exact command (`node F:/rex-desk/src/stdio.js`), the profile folder, and the config file to change. It contains no key; the proxy reads the local connection token itself.
- **Cloud prompt**: uses `Authorization: Bearer ${REX_DESK_TOKEN}` and a `<YOUR-REX-DESK-HOST>` placeholder. Give your AI the token separately, only when you choose to; it is under *Manual connection details*.

An already running local or cloud AI can call `desk_connect` to obtain a conversation `runId`, then use `desk_message` and `desk_ask`. It can read tasks and delegate fixes with `desk_dispatch` (optionally `execution: "orca"` and a `runtimeProfile`). For clients with short tool timeouts, `desk_ask` accepts `wait=false` and `desk_question` polls for the answer.

Managed Codex runs use the app-server protocol for native approvals and elicitation; managed Claude runs use Agent SDK `canUseTool` and `onElicitation`. Both route to the dashboard. Rex Desk's own tools that read, label, message, or act inside the run's worktree run without a permission prompt; `desk_dispatch`, shell commands, and edits outside a worker still ask, and each approval offers **Always allow for this run**. Tracker status changes and draft PRs keep their own approval.

## Cloud access boundary

The server binds to **127.0.0.1 only**. To connect a cloud AI, supply your own authenticated HTTPS reverse proxy or tunnel and expose only `/mcp`:

```powershell
$env:REX_PUBLIC_MCP_HOST = 'your-private-gateway.example.com'
npm start
```

Other paths are rejected for the public hostname. Keep HTTPS and bearer authentication. This repository does not create a public tunnel.

## Local data and cloud backup

`.local/` contains the SQLite history, encrypted API credentials, the local encryption key, the connection token, the encrypted Turso connection, image cache, runtimes, and evidence. AES-256-GCM protects credential values; the key lives on the same computer, so protect the folder with your account permissions and keep it out of Git and cloud sharing. Code, task content, and tool results are still sent to the AI provider you choose.

**Settings → Cloud backup** connects a Turso database. Every local change commits together with an entry in a local outbox, which uploads in order; if Turso is offline, entries wait and retry automatically every 30 seconds. A SQLite backup is saved under `.local/backups/` before connecting. **Upload now & verify** compares every record and the event count with Turso. A fresh workspace with the same `workspace.id`, `vault.key`, and `turso.connection` restores its records, history, and token from Turso; restored active runs become **Interrupted** and need an explicit resume.

The dashboard blocks cross-origin requests, requires a custom header for mutations, validates local hosts, serves an explicit file allowlist, and sends a CSP that allows no remote scripts or images. HTTP MCP calls require a token; managed worker tokens are limited to their run. Restart expires unresolved questions and marks active runs interrupted. A per-data-directory lock prevents two servers from sharing one database.

## Verification

```powershell
npm run verify
npm run test:browser
```

`npm run verify` checks syntax and runs every `test/*.test.js`: encryption and key rotation, assignment filtering, cursor pagination, detail caching across syncs, task-column parsing and comments, the image cache allowlist, sign-in preflight and profile persistence, MCP scopes, HTTP protections, restart recovery, worktree isolation, mixed-provider concurrency, native elicitation through HTTP and stdio, Flow/Morningmate profile rewriting, Electron preset validation, Orca launch and the one-time spec, and Turso offline retry, verification, and restore.

The browser acceptance test uses **synthetic agents and tracker responses** shaped like the live API, a real temporary Git repository, real worktrees, the real regression command, and a recorded Playwright browser. It covers the setup tour, searchable branch and employee pickers, a key typed while discovery is in flight, readable issue details with a cached screenshot, search focus, agent dispatch, human replies, evidence gating, mobile layout, and post-verification change rejection. It spends no model credits, calls no live API, pushes nothing, and creates no PRs.

Primary references: [Morningmate OpenAPI](https://api.morningmate.com/docs), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation), and the installed Claude Agent SDK type definitions.

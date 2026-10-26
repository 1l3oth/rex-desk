# Rex Desk

A local QA issue workspace for Flow and Morningmate. It imports tasks assigned to you, has Jev rank them so you know what to run first, and keeps questions, approvals, worktrees, and test evidence together.

**New here?** [docs/ONBOARDING.md](docs/ONBOARDING.md) walks you through using Rex Desk or building on it from a fork or branch. Outside contributions arrive as pull requests; see [CONTRIBUTING.md](CONTRIBUTING.md).

The application is independent of your product repositories. It uses one Node.js process, SQLite with an optional Turso copy, and a buildless browser interface. Browsers, Tomcat, Electron, and coding agents start only when a run needs them.

## Start

Requires Node.js 24+, Git, Orca, and Claude Code or Codex installed on this computer. GitHub CLI (`gh`) and an authenticated repository remote are needed to create PRs. Every agent runs in an Orca terminal, so Orca must be installed; Rex Desk opens it when it is closed.

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

1. **Sign in your coding agent.** Rex Desk finds Claude Code and Codex profile folders (`~/.claude`, `~/.claude-*`, `~/.codex`, Orca's `claude-profiles`, and the folder of the terminal that started the server) and checks each with `claude auth status` / `codex login status`. Choose a profile that shows **Signed in**; the choice is saved immediately and used for every new run. When the selected profile is signed out, Setup offers the signed-in one. No model turn is spent on this check. The optional model setting accepts shorthand: `opus 5.5` is saved as `claude-opus-5-5`; blank uses the CLI default.
2. **Connect Flow or Morningmate.** Paste your user API key once. It is encrypted on this computer and never sent back to the browser.
3. **Choose projects and assignee.** *Connect & load projects / people* lists your projects and colleagues; search, tick projects, and pick the assignee from a searchable list. Manual IDs remain under *Enter IDs manually*. Sync imports **Request + In progress** by default, without statuses named like *Development Completed* or *Resolved*; *All unfinished* and *All statuses* are explicit options, and **Statuses to sync** lists the project's real statuses to tick exactly. The issue list says whose issues these are (the assignee chosen in Settings, or the API key's owner) and how many of them list that account as an assignee; each issue shows its assignees.
4. **Add the source repository.** *Choose folder* opens a native picker; Git root, author, GitHub account, and branches load automatically. Base and PR-target branches are searchable. A single repository becomes every connection's default.
5. **Project commands are automatic.** Rex Desk reads how to install, preview, and test each repository from its own files: `package.json` scripts and lockfile, `pom.xml`, Gradle, Go, Cargo, Python, .NET, the Flow / Morningmate WAR layout with its sibling `flow-was-tomcat` template (isolated Tomcat preview), or an Electron app. Fields left blank stay automatic; a typed command overrides. When no test command is found, the worker proposes one from the repository's docs, you approve it once, and it is saved. On Windows, `.sh` test scripts are not guessed, because they assume Unix paths.
6. **Connect your own AI tools** (optional). Install the local Rex Desk MCP into the selected Claude Code or Codex profile with one click, or copy a setup prompt for your AI.
7. **Sync and check.** Imports your assigned issues and checks installed tools.

Claude Code is the default agent; Settings and each run let you choose Codex instead. Both can run concurrently, up to the worker limit.

## Issues

The list and Kanban are two views of the same issues. Titles, numbers, status, reporter, dates, group, and custom tracker fields (for example Issue Type, Reproducibility, Region, OS) come from the tracker's task columns. Selecting an issue loads its description, screenshots, attachments, and comments once; later syncs keep them until the tracker reports a newer edit, and **Refresh** reloads on demand. Rich-text bodies are parsed, so tracker JSON is never shown. Tracker images are fetched through a local cache that accepts only image URLs already stored on that task; the dashboard page itself loads no remote content.

Search matches title, number, status, fields, reporter, and description without moving focus.

## Priority with Jev

Jev, TypeSafe AI's decision model, rates each assigned issue through your OpenRouter key (Settings → **Jev priority**, stored encrypted; `OPENROUTER_API_KEY` in the environment also works). Rex Desk sends the issue's title, status, fields, description, and recent comments to `POST https://openrouter.ai/api/v1/systemone` (model `~typesafe/jev-latest` unless set) with four typed questions: severity (a 5-level score), next step (fix, verify, wait, or skip), effort (a 3-level score), and whether it can be checked in a desktop Chromium browser (a probability). No generated text is parsed.

Rex Desk ranks from those answers and the due date: severity counts most, then an overdue or near due date and browser-checkability; large effort lowers the rank, and waiting or not-actionable issues go to the end, after running and finished work. The issue list follows this order (switch **Order** to *As in tracker* to turn it off), each row shows its rank, a **Next up** card at the top starts the first issue with one click, and the issue's **Priority** section explains the rank. Only new or changed issues are rated again after each sync; **Prioritize** runs it now, Shift-click re-rates everything, and **Re-check** re-rates one issue. You decide what runs; nothing starts on its own except the schedule.

## Execution and evidence

Each run is one issue you start: **Fix with agent** or **Verify fix**, from Next up or the issue page. Worker concurrency is enforced by the local queue. Nothing starts on an issue you did not choose: when an agent asks to start one (`desk_dispatch`), Rex Desk shows an approval card naming the issue, and the run starts only if you approve it. **Agent runs** shows one run at a time; the layout switch adds side-by-side or grid panes, and that choice is remembered.

Screenshots, image and video attachments, comment images, and evidence recordings open in a viewer inside Rex Desk: arrows (or ←/→) move between the files of the same issue or run, images switch between fit and actual size, and Download and Original are in the header. Tracker attachments are fetched only if they belong to the issue, checked by their real file type, cached under `.local/cache/media`, and streamed so videos can seek; formats the window cannot play say so and offer the download.

The recorded browser saves its clip and closes after a minute without a browser action, keeping the preview server, page, and cookies; the next action continues in a new clip, so idle time is never recorded. Local previews (127.0.0.1) use the sign-in saved for `127.0.0.1` in Settings, because they use the development database. A pull request opened outside Rex Desk, for example from an Orca terminal, is found by the run's branch within two minutes and marks the run as PR created.

Agents get issue screenshots and attachments with `desk_attachment`, which saves the file into the run folder (readable by the agent) instead of downloading tracker links themselves. Workers on a Java WAR repository start with JDK 8 first on PATH and in JAVA_HOME. Without an OpenRouter key, branch names come from the signed-in Claude Code (Haiku, one short turn).

Settings → **QA verification** holds one sign-in per test server: a site such as `morningmate.info` or `127.0.0.1`, an account, and a password. A sign-in saved with a blank site is used wherever no other matches. Agents type `{{test.username}}` and `{{test.password}}` with `desk_browser fill`; Rex Desk substitutes the sign-in whose site matches the page, types the password only into password fields, and masks every saved password in anything returned to the agent or written to the journal. An agent is told which sites have a sign-in, never the account or the password. These accounts belong to the test servers, so Rex Desk refuses to type any of them into a live service such as `morningmate.com` or `flow.team`: there the agent uses the browser session you saved, or asks you.

For a Java WAR repository such as flow-was, the automatic test command compiles the branch's changed Java files with JDK 8 (Amazon Corretto 8 first) against the checked-in classes and libraries, checks for Java 8 bytecode, and syntax-checks changed JavaScript, because the repository has no runnable test suite; this matches how its developers verify. The automatic setup command installs and builds the `src/flow-renewal` frontend, whose gitignored `dist/` bundles the pages need, then restores the tracked files the build rewrote. Commit messages and PR text follow the repository's own convention (for flow-was `<type>(<domain>): <Korean summary>` with a Korean body and the issue's QA link at the end); messages to you stay in English. Rex Desk never opens a pull request into `master` or `real-master`.

Each run page shows the agent's conversation live: its text, every tool call with input and result (expand a row), and pending approvals at the end, followed by a working line with the time of the last activity. A resumed turn is marked, and the timer counts from the current turn. Raw command and preview output stays in the work journal. Every agent writes to you in English, including reports and tracker comment drafts, whatever language the issue uses. Rex Desk enforces it: a message, question, summary, or tracker comment that is mostly Korean, Japanese, or Chinese is sent back to the agent to rewrite (quoted titles are fine). Workers also start with lessons from earlier runs: never cd the session shell (repository hooks use relative paths and stop running), write reports for a non-developer, let desk_browser start the preview, and for flow-was build the frontend once instead of running watchers and compile Java exactly like compile.sh.

On **My issues**, drag the sidebar edge (or focus it and use the arrow keys) to resize the list. Drag the **Issue brief**, **Messages**, or **Evidence** tab onto the issue to open it beside or below the current panel, or use the layout switch at the top right: one panel, side by side, or stacked. Each panel has its own tabs and scrolls on its own; drag the divider to resize. On **Agent runs**, drag the divider between a run's conversation and its proof or QA result column (or use the arrow keys) to resize the column. Sizes and layout are remembered per browser.

Each worker receives a new worktree and a readable branch from the repository's pattern (default `{prefix}/{type}/{title}`). When the run starts, a small model (`~anthropic/claude-haiku-latest` through your OpenRouter key, about $0.0001 a name) reads the QA title and description, even in Korean or Japanese, and names the branch after the feature that breaks and how. Without a key, the tracker issue number is used until the worker renames the branch with `desk_branch`, which it also does if the real cause turns out different. A taken name gets `-2`; a pushed branch keeps its name.

```text
temp/rex/fix/project-view-names-ignore-language
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

### Every run is an Orca terminal

Nothing runs out of sight: every run, whether a coding worker, a QA check, or connection setup, opens its own Orca terminal with tool approvals there. A run without a worktree (a QA check or connection setup) opens in `.local/agent-desk`, a small repository Rex Desk creates and registers with Orca that holds no project code. If Orca is closed, Rex Desk runs `orca open` and waits for it rather than starting an agent you cannot see. Rex Desk still creates the worktree, branch, port, and runtime seed; Orca opens a terminal there running `scripts/orca-agent.mjs`, which reads a one-time spec, deletes it, and starts the agent with your selected profile and a run-scoped MCP token. The token is never typed into the terminal. Tool approvals then happen in the Orca terminal; questions (`desk_ask`), evidence, and PR approval stay in Rex Desk. Claude Code starts with its own question prompt turned off (`--disallowed-tools AskUserQuestion`), because that prompt would appear only in the terminal and its answer would never be recorded. Orca runs survive a Rex Desk restart: their MCP key is kept (as a hash) in the database, and the run is watched again while its terminal is open; a terminal that closed during the restart marks the run interrupted. The run page shows an Orca run as a chat: Rex Desk reads the agent's own session log (Claude Code's `projects/<worktree>/*.jsonl`, or Codex's rollout file for that worktree) and shows its messages, tool calls, and your messages, the same way the dashboard shows any other run. While it works, the box at the bottom types your message into its terminal with `orca terminal send --enter`, so you can chat with the agent from Rex Desk; a busy agent queues it. The raw terminal screen stays available, folded, under **Terminal**. The run ends when the agent finishes through MCP, exits, or its terminal closes; **Stop run** closes the terminal.

Orca shows these worktrees only when the repository's external-worktree visibility is **show**; the run dialog checks this and offers a one-click fix. **Open in Orca** on any run opens a plain terminal in its worktree without starting a second agent.

## QA verification

Issues a developer marked complete (for example **Development Completed**) are QA work. **Verify fix** starts a run that needs no repository and no configured site: the agent works out where the project runs for that issue (the dev, QA, or staging server for its product and region) from the issue, its comments, and the repository docs, opens it in a recorded browser (`desk_browser` open with `url`), follows the issue's steps, asserts the expected behavior, and reports **Fix works**, **Still broken**, or **Could not check**, with a drafted tracker comment to copy. A pass needs a recorded assertion. Sites earlier checks used are offered to later checks as hints, and the agent is told each product’s servers in the order to try them, skipping any that is down; if it still cannot tell, it asks you once. The site has to match where the fix runs: an issue whose status does not say released is still on a develop, staging, release, or hotfix server, so Rex Desk refuses a live production address for it (it follows the product's own environment list: `morningmate.com`, `flow.team`, and customer subdomains such as `seco.flow.team` are production; `develop.`, `staging.`, `release.`, `hotfix.`, `morningmate.info`, and the `flow*.info` hosts are test servers). If production really is right, answer the agent's question naming that address and it is allowed for that run. The recorded browser never loads Rex Desk's own dashboard. **Open sign-in browser** in Settings, or **Sign in to <site>** on a QA result, opens a browser where you log in once; the session is saved in `.local/qa-session.json` on this computer and used only by QA runs. **Mark done in tracker** / **Reopen in tracker** apply the mapped tracker status after you review the evidence. Desktop-app, Safari, macOS, iOS, and Android checks cannot run in the recorded Chromium browser and are reported as blocked.

## Schedule

Settings → **Schedule** starts work while the computer is on: at the set time on the chosen days Rex Desk syncs, Jev rates new issues, and Rex Desk starts the top-ranked ones up to the daily limit: QA checks, code fixes, or both. Without a Jev key, issues a developer marked complete become QA checks and the rest fixes. Issues already settled or worked on in the last 20 hours are skipped. **Run now** does the same immediately. **Start Rex Desk when I sign in to Windows** adds a hidden launcher to the Startup folder so schedules run without opening the app.

Setup marks the test-site sign-in, repository, and commands as optional: QA checks need only the tracker; code fixes need a repository, whose commands are read from its files.

## Source statuses and pull requests

Sync reads each project's status definitions and makes them available to agents. Optional working/review/done mappings specify the tracker status values; unmapped phases leave the tracker unchanged, and every status change needs a dashboard approval. Local Kanban progress never rewrites tracker statuses.

Settings → **GitHub** lists the GitHub CLI accounts on this computer, switches the active one, and signs in more with **Sign in another GitHub account**: Rex Desk runs GitHub's device flow, shows the one-time code, and opens github.com/login/device. Tokens stay in the GitHub CLI's keyring. The start dialog can clone `owner/name` with the active account when no repository is configured.

**Create draft PR** shows the title, description, and editable target branch before publishing. It checks verified code, requires a clean committed branch, pushes it to `origin`, and creates a draft with `gh`. It never merges or deploys.

Orbit reporting is optional in Settings. Managed Claude workers also load MCP servers from your Claude configuration and the source repository's `.mcp.json`.

## Connect an existing AI

Settings → **Connect an existing AI** installs the local stdio proxy into the selected Claude Code or Codex profile, or copies a setup prompt for your AI:

- **Local prompt**: names the exact command (`node F:/rex-desk/src/stdio.js`), the profile folder, and the config file to change. It contains no key; the proxy reads the local connection token itself.
- **Cloud prompt**: uses `Authorization: Bearer ${REX_DESK_TOKEN}` and a `<YOUR-REX-DESK-HOST>` placeholder. Give your AI the token separately, only when you choose to; it is under *Manual connection details*.

An already running local or cloud AI can call `desk_connect` to obtain a conversation `runId`, then use `desk_message` and `desk_ask`. It can read tasks and delegate fixes with `desk_dispatch` (optionally a `runtimeProfile`). For clients with short tool timeouts, `desk_ask` accepts `wait=false` and `desk_question` polls for the answer.

Managed Codex runs use the app-server protocol for native approvals and elicitation; managed Claude runs use Agent SDK `canUseTool` and `onElicitation`. Both route to the dashboard. Rex Desk's own tools that read, label, message, or act inside the run's worktree run without a permission prompt, for Claude and for Codex (whose MCP tool approvals arrive as elicitations); `desk_dispatch`, shell commands, and edits outside a worker still ask, and each approval offers **Always allow for this run**. Tracker status changes and draft PRs keep their own approval.

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

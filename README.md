# Rex Desk

A local QA issue workspace for Flow and Morningmate. It imports tasks assigned to you, lets a main agent classify and dispatch them, and keeps questions, approvals, worktrees, and test evidence together.

The application is independent of your product repositories. It uses one Node.js process, SQLite, and a buildless browser interface. There is no Electron shell, Docker requirement, hosted database, or frontend build service. Browsers and coding agents start only when needed.

## Start

Requires Node.js 24+, Git, and Claude Code or Codex signed in on this computer. GitHub CLI (`gh`) and an authenticated repository remote are needed to create PRs.

```powershell
cd F:\rex-desk
npm ci
npx playwright install chromium
npm start
```

Open **http://127.0.0.1:4317**. On Windows, `Start-RexDesk.ps1` starts the server in the background and opens the dashboard. It reuses a running server.

Claude Code is the default. Settings and each run let you choose Codex instead. Both providers can run concurrently, up to the configured worker limit. Signing in to the provider CLI remains a user action; the application does not request another model API key.

## First configuration

1. In **Settings → Repositories**, add your existing Git repository path. Select the base branch and default PR target, such as `develop`, `release`, `global/develop`, or `global/release`.
2. Set the repository's setup, dev, and test commands. Setup runs once per new worktree. The dev command must contain `{port}`. For example, `npm run dev -- --port {port}`. Use the real build/start commands for a Java or other backend project.
3. In **Settings → Connections**, add Morningmate or Flow, paste the REST API key, and enter your project IDs. Choose the repository for that connection. Enter your account ID only if automatic identity lookup is unavailable.
4. Save settings and choose **Sync tasks**. Project IDs and credentials can be changed later in this screen. Saved keys are never returned to the browser.
5. Select issues, then choose **Analyze & run**. Choose Claude Code or Codex and optionally override base and PR target branches. Alternatively, run one issue directly.
6. Respond in **Needs you**. Review the issue's messages and evidence. The issue list and Kanban are views of the same data.

REST credentials are separate from Morningmate MCP OAuth. The REST API uses `x-flow-api-key`. The two source adapters share the documented user API shape and use different base URLs: `https://api.morningmate.com` and `https://api.flow.team`. Live source access still requires your own key and a compatible account.

## Execution and evidence

The main agent receives the selected issue IDs and uses the Rex Desk MCP to read, categorize, and dispatch work. It is instructed to keep related changes sequential and parallelize independent issues. Worker concurrency is enforced by the local queue.

Each worker receives a new worktree and a unique branch:

```text
temp/rex/morningmate-4821/file-preview-stays-blank-<run-id>
```

Git forbids a leading `/` in branch names. Set your own name in the branch prefix. The current checkout is not switched, reset, cleaned, or copied into workers. Dirty source files remain in the original checkout. Workers use committed content from the selected base branch.

Worktrees are created under `worktrees/`, next to the local data directory, and remain available for inspection. Each worker gets a separate preview port, environment `PORT`, browser context, video, and Playwright trace. A worktree isolates Git changes; it is **not** an OS security sandbox. Development commands must honor `{port}` and must not start shared databases, containers, or machine-wide services. For a project that cannot run independently, the agent must report the blocker rather than alter existing services.

The recorded browser is exposed through `desk_browser`. It supports navigation, CSS-selector actions, screenshots, and real text/visibility assertions. Browser tools used outside `desk_browser` are not automatically recorded. The managed browser starts a worktree's preview and records the context until it is closed or the agent ends.

Workers must commit the fix **before** `desk_verify`. Verification runs the configured command and stores its actual output, exit status, and a code fingerprint. Later code changes or commits invalidate it. By default, a fix becomes ready for review only when:

- The configured regression command passes for the current code.
- A browser video was saved.
- A relevant browser assertion passed for the same code fingerprint.

You can turn off the browser requirement for non-UI work. Passing tests are still required. `desk_finish` writes a portable HTML report alongside recordings, screenshots, test logs, and traces. Download the directory's files together to preserve the report's relative links. Playwright traces can be inspected using `npx playwright show-trace <trace.zip>`.

An agent turn ending does not resolve an issue. Missing proof produces **Needs evidence**, and an interrupted process produces **Interrupted**. You can continue a run with the same provider or switch providers. Switching starts a new provider conversation with the issue and existing worktree; private conversation state is not transferred between providers.

## Source statuses and pull requests

Sync reads each project's status definitions and makes them available to agents. Optional working/review/done mappings in connection settings specify the source API's status values. Unmapped phases leave the tracker unchanged. Status changes require a dashboard approval. Local Kanban progress does not replace or silently rewrite source statuses.

The **Create draft PR** action shows the title, description, and editable target branch before publishing. It checks verified code, requires a clean committed branch, pushes that branch to `origin`, and creates a draft with `gh`. It never merges or deploys. GitHub or git authentication errors remain visible in the dashboard. The local HTML report is not uploaded or represented as a public evidence URL.

Orbit reporting is optional in Settings. The connection from Claude Code was copied into Codex on this computer. Managed Claude workers also load MCP definitions from the source repository's existing Claude configuration. Enabling Orbit reporting lets verified workers use an available Orbit tool for a final report. No report is sent merely by opening this application.

## Connect an existing local AI

The included stdio proxy reads the local encrypted connection credential and connects to the running dashboard. It does not start another database owner.

```powershell
claude mcp add --scope user --transport stdio rex_desk -- node F:/rex-desk/src/stdio.js
codex mcp add rex_desk -- node F:/rex-desk/src/stdio.js
```

Restart existing AI clients after adding the MCP. Keep the dashboard server running. Managed runs receive their own scoped connection automatically; you do not need to paste issue details into a terminal.

An already running local or cloud AI can call `desk_connect` to obtain a conversation `runId`, then use `desk_message` and `desk_ask` to communicate through the dashboard. It can read tasks and delegate fixes to local workers with `desk_dispatch`. `desk_disconnect` finishes the external conversation. This connects conversations; it does not attach to or take over an arbitrary terminal process.

In **Settings → AI connection**, show the HTTP MCP configuration when a client supports Streamable HTTP. It uses a bearer token. For a client with short tool timeouts, `desk_ask` accepts `wait=false`, returns a question ID, and `desk_question` polls for the answer. This also works when native elicitation is unavailable.

Managed Codex runs use the app-server protocol for native approvals and elicitation. Managed Claude runs use Agent SDK `canUseTool` and `onElicitation` callbacks. Both route requests to the same dashboard. MCP elicitation is a request made during an active client call; it does not wake an idle model. The runner starts and resumes those models.

## Cloud access boundary

The server binds to **127.0.0.1 only**. A cloud AI cannot reach your loopback address directly. To connect one, supply your own authenticated HTTPS reverse proxy or tunnel, configure its hostname, and expose only `/mcp`:

```powershell
$env:REX_PUBLIC_MCP_HOST = 'your-private-gateway.example.com'
npm start
```

Configure the proxy to preserve this hostname and to route `/mcp` to port 4317. Other paths are rejected for the public hostname. Require HTTPS, retain bearer authentication, and use the HTTP configuration from Settings with the public URL. Do not expose the dashboard API or disable the token check. This repository does not create a public tunnel automatically and does not ship a separate cloud agent runtime. A cloud conversation can use this MCP to coordinate local workers once you configure its private route.

## Local data and operational limits

`.local/` contains the SQLite history, encrypted API credentials, local encryption key, connection token, and evidence. AES-256-GCM encryption protects credential values; the encryption key lives on the same computer. This is not an OS credential vault. Protect this directory with your user account's filesystem permissions and exclude it from Git and cloud sharing. Code, task content, and tool results are still sent to the AI provider you choose during agent execution.

The dashboard blocks cross-origin browser requests, requires a custom header for mutations, validates local hosts, and serves only an explicit public-file allowlist. HTTP MCP calls require a token. Managed worker tokens are restricted to that run's task and operations. Restart expires unresolved live questions and marks active runs interrupted. The server uses a per-data-directory process lock to avoid two coordinators mutating the same database.

The first release uses a serial source fetch to respect provider limits, cursor pagination, and three retries for 429/5xx. It preserves cached task visibility when sync fails. It fetches task details to determine assignments instead of assuming the issue author is an assignee. Raw API task payloads vary across versions; a live account is still needed to confirm its exact response shape. Add another connection if a different source project uses a different repository.

Jev/OpenRouter and Sandcastle are not required. Sandcastle needs Docker, Podman, Vercel, or another sandbox provider; it can be introduced later for stronger isolation. The current local browser integration uses Playwright and requires no additional browser-agent API key.

## Verification

```powershell
npm run verify
npm run test:browser
```

The core suite covers encryption and key rotation, assignment filtering, cursor pagination, failed-sync cache preservation, question validation, protocol responses, MCP scope boundaries, HTTP protections, restart recovery, dirty-checkout worktree isolation, mixed-provider concurrency, provider switching, and native elicitation through both HTTP and the stdio proxy.

The browser acceptance test uses **synthetic agents and API responses**, a real temporary Git repository, real worktrees, the actual regression command, and a real recorded Playwright browser. It exercises dashboard settings, task sync, agent dispatch, human replies, evidence gating, and post-verification change rejection. Screenshots go to `.impeccable/review/`; the acceptance manifest and dashboard recording go to `.local/qa/`. It does not spend model credits, call your live project APIs, modify your existing repositories, push, or create PRs.

Primary references: [Morningmate OpenAPI](https://api.morningmate.com/docs), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation), and the installed Claude Agent SDK TypeScript definitions. Live model execution and real GitHub publishing are not part of the synthetic acceptance run.

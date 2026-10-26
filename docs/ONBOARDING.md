# Welcome to Rex Desk

Rex Desk is a workspace on your own computer for QA issues from Flow and Morningmate. It brings in the issues assigned to you, ranks them so you know what to do first, and runs a coding agent (Claude Code or Codex) on the issue you choose, in its own copy of your project. You answer the agent's questions, review its recorded browser proof, and decide whether a draft pull request is created.

Pick the path that fits you:

- **[Use Rex Desk](#use-rex-desk)** for your own QA work. About 20 minutes.
- **[Build on Rex Desk](#build-on-rex-desk)** to change it or add your own features through a fork or a branch.

## Before you start

| You need | Why |
|---|---|
| Windows 10 or 11 | Rex Desk is built and tested on Windows. The Flow/Morningmate Tomcat preview and Orca support are Windows only. |
| [Node.js 24 or newer](https://nodejs.org) | Runs Rex Desk. |
| [Git](https://git-scm.com) | Each run works in its own Git worktree. |
| Claude Code or Codex, signed in | The coding agents. Rex Desk uses the sign-in you already have. |
| [GitHub CLI](https://cli.github.com) (`gh`), signed in | Cloning, forking, and draft pull requests. |
| A Flow or Morningmate user API key | To bring in your assigned issues. |

Optional: an [OpenRouter](https://openrouter.ai) key, so Jev ranks your issues; Orca, to watch agents in a terminal; JDK 8 and Tomcat 9, for a Flow/Morningmate (flow-was) preview.

The repository is private. Ask the owner for access before cloning or forking.

## Use Rex Desk

1. **Get the code.**

   ```powershell
   gh repo clone 1l3oth/rex-desk
   cd rex-desk
   ```

2. **Install it.**

   ```powershell
   npm ci
   npx playwright install chromium
   ```

3. **Start it** and open **http://127.0.0.1:4317**.

   ```powershell
   npm start
   ```

   `.\Start-RexDesk.ps1` does the same in the background and opens the dashboard. The desktop app in `desktop/` is the same dashboard in its own window.

4. **Follow Setup.** The first screen is a checklist that reads your real settings:
   1. Choose a Claude Code or Codex profile that shows **Signed in**.
   2. Paste your Flow or Morningmate API key. It is encrypted on this computer.
   3. Pick your projects and yourself as the assignee.
   4. Choose the folder of the project you fix, such as `flow-was`. Branches and commands are detected from the project itself.
   5. Optional: add your OpenRouter key under **Settings → Jev priority**, and a test account under **Settings → QA verification** for agents to sign in with.

### A normal day

1. **Sync tasks** brings in your assigned issues.
2. **Prioritize** has Jev rank them. The list follows the ranking, and **Next up** shows what to run first.
3. **Fix with agent** or **Verify fix** starts an agent on that one issue. Nothing runs on an issue you did not choose.
4. **Needs you** collects the agent's questions and approvals.
5. **Evidence** holds the recorded browser test, screenshots, and test output. Open any of them in the viewer.
6. **Create draft PR** pushes the branch and opens a draft pull request, only when you click it.

Your data stays in the `.local/` folder of your copy: the database, encrypted keys, and evidence. It is never committed. **Settings → Cloud backup** can keep an encrypted copy in your own Turso database.

## Build on Rex Desk

### Fork or branch

- **You are the owner (`1l3oth` or `DaraBoth`):** work on a branch in this repository. These are the only two accounts that can push.
- **Everyone else, or anyone who wants their own version:** fork it, and open pull requests from your fork.

  ```powershell
  gh repo fork 1l3oth/rex-desk --clone
  cd rex-desk
  npm ci
  ```

  Keep your fork current with `git fetch upstream` and `git rebase upstream/master`.

Name branches after the change: `feature/<short-name>`, `fix/<short-name>`, `docs/<short-name>`, or `chore/<short-name>`.

### Develop without touching your real workspace

Use a separate data folder and port, so development never changes your real issues, keys, or runs:

```powershell
$env:REX_DATA_DIR = "$PWD\.local-dev"
$env:PORT = 4318
npm run dev
```

`npm run dev` restarts the server when a file in `src/` changes. Changes to `public/` appear after a browser reload.

### Where things are

| Path | What it does |
|---|---|
| `src/server.js` | HTTP server, dashboard API, and the MCP endpoint |
| `src/coordinator.js` | Runs, the queue, worktrees, and agent instructions |
| `src/mcp.js` | Tools agents use (`desk_task`, `desk_browser`, `desk_verify`, …) |
| `src/runners.js`, `src/orca.js` | Starting Claude Code, Codex, and Orca terminals |
| `src/providers.js` | Flow and Morningmate sync |
| `src/jev.js` | Jev priority ranking |
| `src/project-detect.js` | Reading install, preview, and test commands from a project |
| `src/browser.js` | The recorded browser that produces evidence |
| `src/store.js` | SQLite storage and encryption |
| `public/` | The dashboard: plain HTML, CSS, and JavaScript, no build step |
| `DESIGN.md`, `PRODUCT.md` | The design system and product rules the UI follows |
| `test/`, `scripts/browser-test.js` | Unit tests and the recorded end-to-end test |

### Before you open a pull request

```powershell
npm test
npm run test:browser
```

Then:

1. Push your branch: `git push -u origin HEAD`.
2. Open the pull request: `gh pr create --fill`, and fill in the template.
3. Wait for **CI** to pass. It runs both test suites on Windows.
4. The owner reviews and merges. Only the owner's two accounts push to `master` directly; everyone else's changes arrive as pull requests.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the rules.

## If something goes wrong

| What you see | What to do |
|---|---|
| The page does not open | Check that `npm start` is still running. If port 4317 is taken, another Rex Desk is already running; use it, or set `PORT`. |
| "Not signed in" | **Setup → Sign in your coding agent**, and choose a profile that shows Signed in. |
| "Browser could not start" | Run `npx playwright install chromium`. |
| Orca does not show the run | In the run dialog, choose **Show Rex worktrees in Orca**. |
| A push to `master` is rejected | Only the owner's accounts push to `master`. Push a branch to your fork and open a pull request. |

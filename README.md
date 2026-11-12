# Rex Desk

Rex Desk is a desktop workspace for your AI coding agents. It runs on your own computer and gives each agent its own chat. Agents read your projects, work through your tasks, ask you questions, show proof of what they tested and open pull requests when you approve. You can talk to them from your desk, or from your phone and other computers.

It works with the AI subscriptions you already have: **Claude Code**, **Codex** (ChatGPT) and **Gemini** (through Google's Antigravity CLI). Rex Desk never asks for or stores those sign-ins.

## Download

**Latest build: [Rex Desk 0.2.1 (unsigned build 2)](https://github.com/1l3oth/rex-desk/releases/tag/desktop-v0.2.1-build2)**. All builds are on the [Releases page](https://github.com/1l3oth/rex-desk/releases).

| System | File |
|---|---|
| Windows 10/11 (64-bit) | `Rex.Desk_<version>_x64-setup.exe` (installer) |
| Windows, if `.exe` installers are blocked | `Rex.Desk_<version>_x64_en-US.msi`, or `Rex.Desk_<version>_x64-portable.zip` (unzip it and run `rex-desk.exe`, no install needed) |
| macOS (Apple Silicon) | `Rex.Desk_<version>_aarch64.dmg` |

The installers bundle Node.js and the Rex Desk server, so you don't need to install anything else to open the app.

The installers are **not code-signed yet**, so your computer warns you the first time:

- **Windows:** if SmartScreen says "Windows protected your PC", choose **More info**, then **Run anyway**.
- **macOS:** open the `.dmg` and drag Rex Desk to Applications. The first time, right-click Rex Desk and choose **Open**. If macOS says the app is damaged, run this once in Terminal:

  ```bash
  xattr -cr "/Applications/Rex Desk.app"
  ```

## Set up

1. **Install at least one AI tool and sign in to it:**
   - [Claude Code](https://docs.claude.com/en/docs/claude-code): run `claude` once and sign in.
   - [Codex](https://github.com/openai/codex): run `codex login`.
   - Gemini: install the Antigravity CLI (`winget install Google.AntigravityCLI` on Windows) and sign in with your Google account.
2. **Install Git.** Agents need it to work on your projects. The [GitHub CLI](https://cli.github.com/) (`gh auth login`) is only needed for opening pull requests.
3. **Open Rex Desk and create an account.** Pick an email and a passphrase. The passphrase locks your workspace on this computer, and Rex Desk can't recover it if you forget it.
4. **Follow Setup.** It checks which AI tools are signed in, lets you add your project folders, and installs Rex Desk's tools into your AI so agents can talk to you.
5. **Talk to the main agent, Rex.** Ask it to meet your projects. It reads each one and creates a specialist agent for it, named like `Project_bot`.

## What you can do

- **Chat with agents.** Each project has its own agent and personal chat. Group chats bring several agents together. You can switch an agent between Claude, Codex and Gemini and choose the model, effort and permission mode under the message box.
- **Tasks.** Keep tasks in Rex Desk, or connect a tracker such as Orbit. Hand a task to an agent and it does the work in its own chat or group.
- **Approvals and questions.** Agents ask before risky steps, and their questions appear as cards in the chat. Dangerous mode lets them run without asking.
- **Proof.** Agents share test output, screenshots and screen recordings in the chat, and they explain their changes on picture pages.
- **Worktrees.** Each chat has a Worktrees tab that shows the branches and changed files agents work in.
- **Files.** Agents can open a file beside the chat with the lines they mean highlighted. The file window moves out of the way while you type.
- **Voice.** You can dictate in English, Korean or Khmer with a speech model that runs on your computer, and agent replies can be read aloud.
- **Computer control (Jev).** You can tell your computer what to do by voice or text: open apps, change the volume or Wi-Fi, lock it, and so on. See [docs/COMPUTER-CONTROL.md](docs/COMPUTER-CONTROL.md).
- **Phone and other computers.** Over [Tailscale](https://tailscale.com/), you can open Rex Desk from your phone with a QR code (Settings → Devices and phone).
- **Long chats.** When a chat's context gets nearly full, the agent writes itself a handoff note and continues in a fresh session.

## Your data

- Everything is saved on your own computer: `%APPDATA%\Rex Desk` on Windows and `~/Library/Application Support/Rex Desk` on macOS. Keys and tokens are encrypted.
- Each account on a computer has its own locked workspace, and other accounts can't read it.
- What you send to an agent (code, tasks, messages) goes to the AI service you chose for that agent.
- Rex Desk's server only listens on your own computer (`127.0.0.1:4317`). Your phone reaches it through your private Tailscale network.

### Cloud backup (optional)

Rex Desk works fine without it. Cloud backup copies your workspace to your own free [Turso](https://turso.tech/) database, so it's safe if your computer breaks and you can open the same account on another computer.

- **Turn it on:** Settings → Backup and updates → **Set up cloud backup for me**. Sign in to Turso in the browser, and Rex Desk creates your database and its key by itself.
- **On a new computer:** on the sign-in screen, choose **From another computer** → **Sign in with Turso to find my backup**, then enter your email and passphrase.
- **Already have a database?** Use **I already have a Turso database** and paste its address and key.

## Run from source

You need Node.js 24 or newer and Git.

```bash
git clone https://github.com/1l3oth/rex-desk.git
cd rex-desk
npm ci
npx playwright install chromium
npm start
```

Then open http://127.0.0.1:4317. Use `npm run dev` to restart on every change. A source checkout updates itself: when new commits reach its branch and no agent is working, it pulls them and restarts.

## Build the installers

The **Desktop installers** workflow (`.github/workflows/desktop.yml`) builds the Windows `.exe` and the macOS `.dmg` on GitHub and publishes them as a pre-release. You can start it from the Actions tab, or by pushing a tag like `desktop-v0.2.2`. Raise `version` in `desktop/src-tauri/tauri.conf.json` and `desktop/src-tauri/Cargo.toml` first.

To build on your own computer (you need Rust; on Windows, also the MSVC build tools):

```bash
npm ci
npm ci --prefix desktop
npm run build --prefix desktop
```

## Test

```bash
npm test
npm run test:browser
```

`npm test` runs every `test/*.test.js`. The browser test drives the real interface against fake agents, so it uses no AI credits and pushes nothing.

## Contributing

Read [docs/ONBOARDING.md](docs/ONBOARDING.md) to get started and [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made. Please send outside contributions as pull requests.

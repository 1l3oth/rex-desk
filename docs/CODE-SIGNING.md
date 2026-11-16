# Code signing policy

Rex Desk's Windows installers will be signed with a **Certum Open Source Code Signing** certificate. This page says who signs them, what gets signed, and how you can check a signature.

## Who signs

| | |
|---|---|
| Project | Rex Desk, <https://github.com/1l3oth/rex-desk> |
| Website | <https://rexdesk.app> |
| Author, maintainer and signer | **Vong Pichdaraboth** |
| License | [MIT](../LICENSE) |
| Certificate | Certum Open Source Code Signing, issued to Vong Pichdaraboth |

Vong Pichdaraboth writes and maintains Rex Desk and is the only person who can approve a release and sign it. The GitHub account [`1l3oth`](https://github.com/1l3oth) that owns this repository is his: its profile shows "Rex (다라봇)", names he goes by, and links to his own site, <https://www.vongpichdaraboth.com>. The [LICENSE](../LICENSE), [package.json](../package.json) and the [README](../README.md) carry his full name.

## What gets signed

Only files built from this public repository, by the **Desktop installers** workflow ([`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml)) on GitHub Actions:

- `Rex.Desk_<version>_x64-setup.exe`, the Windows installer
- `Rex.Desk_<version>_x64_en-US.msi`, the Windows MSI installer
- `rex-desk.exe` inside `Rex.Desk_<version>_x64-portable.zip`

Each release on the [Releases page](https://github.com/1l3oth/rex-desk/releases) names the commit it was built from, so anyone can read the exact code behind a signed file. The certificate is never used for other people's software, for files built outside this workflow, or for anything that is not Rex Desk.

Until the certificate is issued, the installers are unsigned, and Windows SmartScreen warns you the first time you run one (see the [README](../README.md#download)).

## How releases are made

1. Every change is a commit in this repository. Outside contributions come in as pull requests, and the maintainer reviews each one before it is merged.
2. The tests run on every pull request and every push to `master` in the CI workflow ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).
3. The maintainer starts the Desktop installers workflow by hand. It builds the installers from that commit, signs the update with the Rex Desk release key, uploads it, then downloads it back and checks that signature. Once the Certum certificate is issued, this step also signs the Windows files with it.
4. Installed apps update only from files signed with the Rex Desk release key, and they check that signature before installing an update.

## Check a signature

On Windows, right-click the `.exe` or `.msi`, choose **Properties**, then **Digital Signatures**. The signer should read **Vong Pichdaraboth** (Certum adds "Open Source Developer" in front). With the Windows SDK you can also run:

```powershell
signtool verify /pa /v "Rex.Desk_<version>_x64-setup.exe"
```

If a file claims to be Rex Desk but is unsigned after the certificate is issued, or is signed by anyone else, don't run it, and report it as described below.

## What Rex Desk does on your computer

Rex Desk is a local app. Its server listens only on `127.0.0.1`. It does not collect analytics and does not send your code anywhere by itself. It connects to:

- **The AI service you pick** for each agent (Claude Code, Codex, Gemini or a local model), through that tool's own sign-in, which Rex Desk never sees.
- **`api.rexdesk.dev`**, the Rex Desk account service, when you sign in to a Rex Desk account and for cloud backup if you turn it on.
- **`downloads.rexdesk.dev`**, to check for and download updates.
- **Services you connect yourself**, such as a task tracker, Turso for backup, Ollama or Hugging Face for local models, or Tailscale for your phone.

## Report a problem

Report a security problem or a suspicious file privately through [GitHub security advisories](https://github.com/1l3oth/rex-desk/security/advisories/new). See [SECURITY.md](../SECURITY.md).

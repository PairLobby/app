# One-command installation

macOS and Linux (x64 or ARM64):

```sh
curl -fsSL https://pairlobby.com/install.sh | sh
```

Windows 10 or later, x64 or ARM64, in PowerShell:

```powershell
irm https://pairlobby.com/install.ps1 | iex
```

No npm or administrator privileges are needed. If a compatible Node.js (22.18+) is available, the installer uses it. Otherwise it downloads the latest Node 22 runtime from nodejs.org, verifies its published SHA-256 checksum, and stores a private runtime beside PairLobby. PairLobby's prebuilt package is downloaded from the website and checksum-verified before extraction; installation does not build the source repository.

The default also installs the bundled Claude Code and Codex skills into their user skill directories. Customized skills are preserved, never overwritten. Skills add instructions; they do not launch an agent, enable MCP tools, or grant runtime permissions. Follow https://pairlobby.com/agent-setup for listener setup.

The website detects the OS and provides a manual selector plus skill choices. Shell installer options:

```sh
curl -fsSL https://pairlobby.com/install.sh | sh -s -- --skills claude
curl -fsSL https://pairlobby.com/install.sh | sh -s -- --skills none
```

The PowerShell script accepts `-Skills all|claude|codex|none`. Download it first or invoke its script block when supplying parameters. `install.mjs` also accepts `--skills-dir` with one selected agent.

On macOS/Linux, app releases go into `~/.local/share/pairlobby`, the launcher into `~/.local/bin`, and the installer adds that directory to shell startup files. Open a new terminal afterward. Windows uses `%LOCALAPPDATA%\PairLobby` and adds its `bin` directory to the user PATH and current PowerShell session. Re-running the command updates the managed launcher and retains earlier releases. An unrelated existing `pairlobby` launcher is never overwritten.

Advanced overrides: `PAIRLOBBY_INSTALL_DIR`, `PAIRLOBBY_BIN_DIR`, and `PAIRLOBBY_SKIP_PATH=1`. `PAIRLOBBY_DOWNLOAD_BASE` selects the package host for isolated tests. These overrides avoid changing HOME or CODEX_HOME. To remove the app, remove its managed launcher and install directory; remove the marked PairLobby PATH line from shell profiles (or the corresponding Windows user PATH entry). Installed skills can be removed separately.

Installer sources live in `scripts/installers/`. Publish copies with `node scripts/build-installers.mjs ../frontend/public`, then deploy the website. The installer currently targets package `0.1.0-demo.2`; update the version only after building and verifying that release and its checksum. Existing versioned archives should remain available.

Validation: `node --test scripts/installers/install.test.mjs`. The test uses isolated install/bin/skill directories, checks command execution and customized-skill preservation, rejects a bad checksum without replacing the launcher, and exercises the Unix bootstrap with a private Node runtime on macOS. Windows and Linux should additionally be exercised on native CI runners before claiming verified support. A Homebrew tap is not published yet.

# Installation

## Current local checkout: 0.3.0

This is the installation path for the new receiver and terminal Seen UI. It replaces the existing managed `pairlobby` command, not a separate prototype command:

```sh
npm install
npm run install:local
pairlobby --version
pairlobby install-skill codex
```

Run these from the `app` checkout. Node.js 22.18+ and npm are required for the build; The selected runtime needs working authentication: Codex CLI for Codex requests, or Claude Code 2.1.248+ for restricted managed Claude requests. The current source installer supports macOS/Linux; only the macOS local installation has been exercised here. Python is needed for optional experiment/PTY tests, not for the installed receiver.

The launcher is `~/.local/bin/pairlobby`, and versioned packages live under `~/.local/share/pairlobby/releases/`. The first previous launcher is preserved as `~/.local/bin/pairlobby.before-async`. Existing room/session data is retained. If this bin directory is not on PATH, add it to the shell configuration; the local source installer does not edit shell profiles. An unrelated launcher is refused rather than overwritten.

`install-skill` preserves a differing installed skill by default; `--force` explicitly saves a backup and replaces it. Skills alone do not create a connection. New Codex or Claude agent joins start the receiver when recognized; use `--runtime codex` or `--runtime claude` explicitly when needed. See [receiver setup](automatic-receiver.md) and [the implementation](async-receiver-implementation.md).

An already-running terminal or receiver continues using its loaded code after an update. Quit/rejoin human room terminals. For an existing managed agent, stop its receiver and start it with the same room/session scope. Its saved project and model override are retained; pass `--model` to change the model while stopped. After a reboot, start existing receivers explicitly—there is no receiver login service. `npm run service:install` is the separate relay service, not receiver supervision.

For rollback, stop affected receivers, restore the saved launcher, and reopen the client. Keep the old release directory referenced by that launcher. This local installation does not publish a package, update public downloads, or deploy a Worker/website.

## Website distribution: staged 0.3.0 release

The generated website installer and bundled archive now target `0.3.0`. Deploy the frontend assets together before expecting public commands to return this release. Until that deployment, the live website may still serve an older build; check `pairlobby --version` after installing.

macOS and Linux (x64 or ARM64):

```sh
curl -fsSL https://pairlobby.com/install.sh | sh
```

Windows 10 or later, x64 or ARM64, in PowerShell:

```powershell
irm https://pairlobby.com/install.ps1 | iex
```

No npm or administrator privileges are needed. If a compatible Node.js (22.18+) is available, the installer uses it. Otherwise it downloads the latest Node 22 runtime from nodejs.org, verifies its published SHA-256 checksum, and stores a private runtime beside PairLobby. PairLobby's prebuilt package is downloaded from the website and checksum-verified before extraction; installation does not build the source repository.

Interactive installation asks whether to install skills, then offers Claude Code, Codex, or both. Pressing Enter at the first prompt skips skills. Piped Unix installers read from the controlling terminal rather than the script pipe; unattended installs skip skills unless --skills is explicit. Selected skills go into their user skill directories. Customized skills are preserved. If a skill exactly matches a bundled skill from an earlier local release, the installer backs it up and updates it. An unrecognized differing skill is preserved with instructions for a manual reviewed update. Skills add instructions; installation alone does not launch an agent, activate a channel or grant runtime permissions. Consult the setup instructions appropriate to the installed CLI version.

The website detects the OS and provides three OS icon buttons; skill choices are made in the terminal. Shell installer options:

```sh
curl -fsSL https://pairlobby.com/install.sh | sh -s -- --skills claude
curl -fsSL https://pairlobby.com/install.sh | sh -s -- --skills none
```

The PowerShell script accepts `-Skills all|claude|codex|none`. Download it first or invoke its script block when supplying parameters. `install.mjs` also accepts `--skills-dir` with one selected agent.

On macOS/Linux, app releases go into `~/.local/share/pairlobby`, the launcher into `~/.local/bin`, and the installer adds that directory to shell startup files. Open a new terminal afterward. Windows uses `%LOCALAPPDATA%\PairLobby` and adds its `bin` directory to the user PATH and current PowerShell session. Re-running the command updates the managed launcher and retains earlier releases. An unrelated existing `pairlobby` launcher is never overwritten.

Advanced overrides: `PAIRLOBBY_INSTALL_DIR`, `PAIRLOBBY_BIN_DIR`, and `PAIRLOBBY_SKIP_PATH=1`. `PAIRLOBBY_DOWNLOAD_BASE` selects the package host for isolated tests. These overrides avoid changing HOME or CODEX_HOME. To remove the app, remove its managed launcher and install directory; remove the marked PairLobby PATH line from shell profiles (or the corresponding Windows user PATH entry). Installed skills can be removed separately.

Installer sources live in `scripts/installers/`. Publish copies with `node scripts/build-installers.mjs ../frontend/public`, then deploy the website. The version lives in `packages/cli/src/release.json`. Build the archive with `node scripts/build-distribution.mjs ../frontend/public/downloads`, then generate the installer copies with `node scripts/build-installers.mjs ../frontend/public`. The source `install.mjs` is a template; run the generated `public/install.mjs`, not the unrendered template. Retain older versioned archives. The installer rejects an archive whose package or CLI version disagrees with its target, even when the archive checksum matches.

Validation: `node --test scripts/installers/install.test.mjs`. The test uses isolated install/bin/skill directories, checks command execution and customized-skill preservation, rejects a bad checksum without replacing the launcher, and exercises the Unix bootstrap with a private Node runtime on macOS. Windows and Linux should additionally be exercised on native CI runners before claiming verified support. A Homebrew tap is not published yet.

Release readiness checks also run both receiver fixtures against the extracted archive and exercise managed joins in a PTY with `node scripts/test-managed-join.mjs` (macOS/Linux, Python required). `PAIRLOBBY_TEST_CLI` can point that test and the receiver fixture suite at an unpacked release instead of the checkout build. Managed joins must return without entering an agent chat observer; only human chat views generate automatic read receipts.

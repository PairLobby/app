# PairLobby

A private room for humans and AI agents: a durable conversation, an explicit handover, and honest control states.

PairLobby carries requests and records acknowledgements. The relay does not host inference. The local CLI can start a managed Codex, Claude or Qwen runtime for addressed work; ordinary Node code waits between requests, with no listening model or subagent. Project commands run through that runtime's sandbox and permissions.

**New here?** [`STATUS.md`](STATUS.md) says what works, what does not, and where this sits on the roadmap.

## Status

Working end to end against a local relay: create a room, join from another agent, send addressed messages, offer and amend a handover, accept an exact revision, pause a participant, and read back what the adapter actually acknowledged.

The current local CLI is **`0.4.0`**. It includes automatic Codex, Claude and Qwen receiving, durable execution/outbox state, inline mention routing, and terminal **Status** badges with per-agent receipt and action details. A real Codex acknowledgement/reply smoke test and the local integration suite passed. Managed Claude receiving also passed a real acknowledgement/file/reply and conversation-resume test. Its native interactive channel remains an optional separate integration. Qwen Code 0.24.4 has passed a real-CLI acknowledgement/reply/resume test using a loopback model fixture; provider-backed inference is not yet verified.

Start with [installation and joining](#try-it), [spawning agents](#spawn-a-new-agent-from-chat), [the agent table](#agent-table-and-cell-copying), [terminal conversation controls](#the-room), and [runtime capabilities](integrations/README.md). The scripted browser demos live in the sibling frontend repository; installing the CLI does not deploy them. The hosted accounts and subscription service is a separate private repository; the CLI talks to it only through `pairlobby login`, `create online`, `find online` and `join online`.

This README and the tracked integration guides document current behavior. Workspace planning notes and `docs/`/`.docs/` directories are local-only and are not required to use a fresh clone.

## Try it

To install the current checkout over the local managed `pairlobby` launcher on macOS/Linux:

```sh
npm install
npm run install:local
pairlobby --version
pairlobby install-skill codex  # or: claude, qwen, all; --force backs up a differing skill
```

Updating the checkout or local launcher does not publish a website download. Compare the actual build/release artifact rather than assuming two builds with version `0.4.0` contain identical changes. Reopen existing chat terminals after installing to load the new commands; already-running receivers keep their installed code until restarted. Installing a skill alone does not start receiving.

To connect a managed agent to an existing room (use `claude`, `codex`, or `qwen`):

```sh
pairlobby join online <KEY> --runtime codex
# Or, for a local relay:
pairlobby join <CODE> --local --runtime codex
```

The receiver starts automatically for a recognized Codex, Claude or Qwen agent member. It uses a **managed conversation**, separate from the agent that issued the join. `--as codex` alone is only a display name; use `--runtime codex` when detection is unavailable. Run `pairlobby receiver status --room <ROOM> --session <SESSION>` to inspect it.

The distribution script bundles the CLI, skills, terminal library and notices and writes a checksum. To stage a versioned archive without publishing: `node scripts/build-distribution.mjs /tmp/pairlobby-dist 0.4.0` after building. The CLI, archive and generated installer all use the version in `packages/cli/package.json`, which ssmver manages. An override must match it.

For development from source:

```sh
npm install && npm run build

npm run serve                                 # leave this running
```

### Updates

A PairLobby installed with the website installer checks this repository's [GitHub releases](https://github.com/PairLobby/app/releases) at most once a day, in the background, so no command waits for it. When a newer release exists, opening the room list or a chat asks once whether to install it, and other commands end with a one-line reminder; agents and `--json` output never see either.

```sh
pairlobby update                     # check now and offer to install
pairlobby update --check             # only report
pairlobby update --yes               # install without asking
pairlobby settings update-check off  # stop checking
pairlobby settings auto-update on    # install new releases in the background
```

An update downloads the release and its checksum, verifies both and the package version, unpacks into its own folder beside the current one, and then switches the `pairlobby` launcher. Running terminals and agent receivers keep the version they started with; restart receivers with `pairlobby receiver stop` and `start`. Agent skills are refreshed only if they still match a skill an earlier release installed. A CLI run from a checkout or `npm link` is not replaced; update it the way you installed it. Set `PAIRLOBBY_NO_UPDATE_CHECK=1` to disable checks for one environment; checks are also skipped when `CI` is set.

Versioning and releases use [ssmver](https://github.com/hjoncour/ssmver): `ssmver.toml` holds the version and keeps every workspace `package.json` in step; the CLI reads its version from `packages/cli/package.json`. Run `ssmver init` once per clone to install its commit hooks. A commit whose message starts with `feature:` bumps the minor version, `fix:` the patch and `release:` the major; within one branch only the highest bump applies, and other prefixes such as `chore:` or `docs:` bump nothing. ssmver stages the bumped files with the commit. On every merge to `master`, the release workflow checks that version; if it has no GitHub release yet, it runs the tests, builds the package with `scripts/build-distribution.mjs`, tags the merged commit `v<version>` and creates the release with the package and its `.sha256`. A version with a suffix, such as `0.5.0-beta.1`, is published as a prerelease and never offered as an update. The workflow can also be started by hand from the Actions tab. `package-lock.json` keeps the old workspace version until the next `npm install`; `npm ci` does not check it, so this never blocks CI.

### Keeping the relay running

This service manages the **relay**, not the per-agent runtime receiver. It does not make an unconnected runtime available.

```sh
npm run service:install     # builds, links `pairlobby`, starts the relay at login
npm run service:status      # is the agent loaded, is the relay answering
npm run service:uninstall   # remove it; rooms and credentials are left alone
```

| Platform | Mechanism | Starts at login | Restarts if it stops |
| --- | --- | --- | --- |
| macOS | LaunchAgent | yes | yes, after 10s |
| Windows | Scheduled task, logon trigger | yes | yes, after 1 min (the shortest Windows allows) |
| Linux | not built — run `pairlobby serve`, or use the shell hook below | — | — |

Neither needs administrator rights. `npm run service -- logs` tails the log and
`npm run service -- restart` kicks it. Set `PAIRLOBBY_PORT` before
`service:install` to use a port other than 8790.

On Windows the task runs node through a small VBScript shim, because Windows has
no windowless node and the task would otherwise flash a console at every logon.
Both platforms bake node's path into a generated launcher, so re-run
`service:install` after changing node version.

If you would rather not install a relay service, a shell hook does most of the same job
— add this to `~/.zshrc`:

```sh
pairlobby_relay() {
  curl -fsS -o /dev/null -m 1 http://127.0.0.1:8790/v1/rooms 2>/dev/null
  [ $? -ne 7 ] || nohup pairlobby serve >>"$HOME/Library/Logs/PairLobby/relay.log" 2>&1 &
}
pairlobby_relay
```

It starts the relay the first time you open a terminal and leaves it alone
after. What it cannot do is start before you open one, or restart it if it
crashes — which is the whole reason the LaunchAgent exists.

### Running it by hand

```sh
npm run install:cli                            # puts `pairlobby` on your PATH

pairlobby create --name my-project --as host --human --local
pairlobby invite                               # give this code to the other agent
pairlobby join <CODE> --as codex --runtime codex --local
pairlobby send "can you take the recovery tests?" --to codex --room <ROOM> --session <HUMAN_SESSION>
pairlobby read --room <ROOM> --session <HUMAN_SESSION>  # explicit inspection, not an idle loop
pairlobby watch --room <ROOM> --session <HUMAN_SESSION> # follow the room live
pairlobby                                      # what this device is in
```

### Other devices on your network

No account is needed. On the device that holds the rooms:

```sh
pairlobby serve --lan                          # prints the address other devices use
pairlobby create --name my-project --as host --human
```

`create`, `invite` and chat `/invite` then print a join command that uses this machine's network address rather than loopback. On the other device:

```sh
pairlobby join <CODE> --server http://10.0.0.5:8790            # a human terminal
pairlobby join <CODE> --server http://10.0.0.5:8790 --runtime codex   # a managed agent
pairlobby join http://10.0.0.5:8790#<CODE>                     # the same, as one link
```

`--lan` listens on every interface and accepts requests addressed to this machine's own addresses and hostname; other names are still refused. Traffic is plain HTTP, including credentials, so use it only on networks you trust. Behind Tailscale or another proxy, `pairlobby serve --public-url https://laptop.tailnet.ts.net` advertises that address instead. For the background relay, install the service with `PAIRLOBBY_HOST=0.0.0.0`. Rooms remember the address they were joined through, so a changed IP address means joining again.

### A self-hosted relay on Durable Objects (Celld)

`packages/durable-runtime` is the same accountless relay as `pairlobby serve`, written as a Worker with one Durable Object per room. It runs on [Celld](https://github.com/denoland/celld), Deno's self-hosted Durable Object runtime, and unchanged on Cloudflare. Its `wrangler.jsonc` uses only keys Celld accepts. From a built checkout:

```sh
cd packages/durable-runtime
CELLD_ESBUILD=../../node_modules/.bin/esbuild celld dev --port 9876   # state stays in .celld/dev across restarts
pairlobby create --name my-project --server http://127.0.0.1:9876
pairlobby join <CODE> --server http://127.0.0.1:9876 --runtime codex
```

Celld bundles with esbuild and looks for it on `PATH`; `CELLD_ESBUILD` points it at the copy Wrangler installed. The CLI needs nothing Celld-specific. It polls the relay over HTTP, as it does a LAN relay. Each room's SQLite state and its auto-close alarm live in that room's object, and an invite code is claimed in a small directory object named by the code's digest, so two rooms can never hold one code. The relay refuses any request that carries a browser `Origin`, as the local relay does; `PAIRLOBBY_ALLOWED_HOSTS` (comma-separated) pins the `Host` values your ingress forwards. Traffic is whatever your ingress serves, so put TLS in front of anything beyond loopback. Multi-node Celld fleets are not yet qualified; see [the deployment plan](../docs/celld-deployment-architecture.md).

### Your rooms on your other devices

With a hosted account, log in on each device with `pairlobby login`. It shows a short code and opens the website, where you sign in and approve that terminal; on a remote shell, `--no-browser` prints the address to open on any device. Each approved terminal gets its own token, listed on the account page, where it can be revoked; `pairlobby logout` revokes it too. `pairlobby login --token` still accepts a pasted token, and `PAIRLOBBY_ACCOUNT_TOKEN` still works for unattended use. A room created on one device with `pairlobby create online --name my-project` is then available on the others without copying an invite:

```sh
pairlobby find online                                    # rooms your account owns or is allowed into
pairlobby join online my-project --human                 # your terminal, as a room admin
pairlobby join online my-project --runtime codex         # a managed agent on this device
```

`join online` takes a room name or `rm_` id; a dash-grouped key such as `ABCD-EFGH-JKMN` is still treated as an invite. Each join creates its own participant, so the terminal and every agent keep separate identities. Your own terminals on several devices count as one person toward the plan's limit; agents count per session. The room owner's terminals join as admins on every device, other allowed accounts and agents join as members, and a locked room refuses these joins like any other. Listing covers the account's current team.

## The room

Joining a room puts you **in** it — a live chat with the agents, not a transcript
printed behind you:

```sh
pairlobby profile --as hugo --human       # once per device
pairlobby join <CODE>                     # from then on, this is the whole command
pairlobby chat --room <ROOM>              # re-enter with your saved human membership
```

Managing rooms:

```sh
pairlobby list                            # interactive room/session table in a terminal
pairlobby list --json                     # JSON snapshot, including saved sessions and live state
pairlobby list --sort agents --desc       # start with the largest agent count first
pairlobby list --no-follow                # print a plain summary instead
pairlobby find --json                     # ping known rooms: members, creation date, latest message
pairlobby find --active --json            # open rooms with joined members (not verified live presence)
pairlobby name <room> "new name"          # rename (controller only)
pairlobby delete <room>                   # delete (controller only, asks first)
pairlobby expiry <room> in 10 hours       # or: at 2026-09-20 18:00, or: never
pairlobby expiry <room>                   # read it back
pairlobby expire <room>                   # pick it from a menu instead
```

In the list, use **↑/↓** to select a row and **←/→/Tab** to select a column.
Press **S** or click a column heading to sort, **Enter** to open a room's saved
sessions or a human chat, **I** for session details and managed receiver controls,
**Y** to copy the selected cell, and **R** to refresh. **Esc** goes back; **Q** quits.
Leaving a chat returns to the session table.

**C** asks for confirmation before closing a room for everyone (owner/admin only)
or leaving the selected local session and stopping its managed receiver. Saved
identities remain available for rejoining. Session details also let you stop a
receiver without leaving, or start it again; starting can process pending work.
The session table shows identities saved on this device; `/agents` inside a room
shows remote agents too. Counts reflect membership, not verified live presence.

`--json` always emits JSON, including in a terminal. Piped output defaults to a
plain summary. Sort keys are `name`, `state`, `agents`, `people`, `sessions`,
`created`, `expires`, `id`, and `relay`; add `--desc` for descending order.
Unknown counts stay last. Listing only reads snapshots; it does not join rooms
or acknowledge their messages.

`expire` opens a picker: never, a duration, or a date and time you adjust with the
arrow keys — left and right move between year, month, day, hour and minute, up and
down change the one under the cursor. `/expiry` does the same from inside a room.

**Rooms do not expire by default.** Set a lifetime per room with `expiry`, or a
default for every room you create:

```sh
pairlobby settings default-expiry 24h     # or: never
```

```sh
pairlobby forget <room>                   # drop the local record, leave the server alone
pairlobby settings                        # interactive menu in a terminal; a list when piped
pairlobby settings confirm-delete false   # stop asking before delete
```

In a terminal, `pairlobby settings` opens the same kind of menu as `/settings` inside a room, for this device: your default name; defaults for rooms you create (reply mode, what `/invite` admits, guest access for local rooms, private online rooms, room and invite expiry); terminal preferences; and update checks. Arrows select, Enter edits and saves immediately, Escape closes. Each setting can also be set from the shell, for example `pairlobby settings default-reply-mode parallel`, `pairlobby settings default-invites observer` or `pairlobby settings default-private-online on`; `--json` prints them all. New-room defaults are applied right after `create`; if a relay is too old for one, the room is still created and the CLI says which default was not applied. `create online --public` overrides a private-by-default setting.

`pairlobby settings auto-close idle:2h` (or `age:7d`, `agents-and-guests-left`, `off`) makes rooms you create close themselves; the policy is stored in each room, so it applies while your terminal is off. It does not change existing rooms by itself: use **Apply auto-close to my rooms** in the menu, or add `--apply-existing` in the shell, to set it on every saved room this device owns or administers. Each room is reported as updated, unchanged, skipped (no owner/admin access, not open, or an older relay), unreachable or rejected.

Auto-close uses the ordinary graceful close: the room stops accepting new work and members, history stays readable and exportable for the export window, and nothing is deleted. It does not stop agent processes or undo work already started, and unanswered requests stay unresolved but inactive, exactly as after a manual close. The relay enforces the deadline itself: the local relay keeps one timer for the earliest deadline and also checks at startup and on every request, and the hosted service uses its workspace alarm, so a room closes on time even when nobody is connected.

An invite code is a **seat**: it admits one participant at a time and frees up when
that participant leaves, so closing your session and rejoining with the same code
works. `pairlobby invite --once` mints a code spent on first use instead.

Codes do not expire by default. Give one a deadline with
`pairlobby invite --expires-in 10m`, or set a default for this device with
`pairlobby settings default-invite-expiry 10m`. A deadline only gates the first
use — once a code has been claimed, its seat keeps working. A revoked
participant's seat stays shut — removal is deliberate and reusing their code must not
undo it.

`forget` is the escape hatch for a room whose relay is gone: `delete` needs the
server to answer, dropping this device's record does not.

### Guests

A room is invite-only until its owner says otherwise:

```sh
pairlobby open <room>              # anyone with the room id can join, read-only
pairlobby join rm_3FEMR1TQ...      # a guest joins with the id, no code
pairlobby open <room> --off        # invite only again
```

Guests read the whole transcript and nothing else — no messages, handovers,
acknowledgements, invites, or control. They count against the participant cap and
can be removed like anyone else.

**Opening a room turns its id into a credential.** Room ids are printed by `list`,
by errors, and in logs, so treat an open room's id the way you would a password.
Closing the room again stops new guests; it does not eject the ones already in.

`list` says which each room is.


```text
spike  rm_...
session se_...  as hugo
registered in this room: 2  (1 person, 1 agent)  codex, hugo
/help for commands, /quit to leave

16:41  hugo → codex  Hey @codex, hello                      Status
16:41  codex → hugo  Hello!                                  Status

>
Hover/click Status · F2 or /seen for message status · PgUp/PgDn scroll
```

An untagged chat message addresses all eligible agents, exactly like `@all`. Mention `@name` anywhere (for example `Hey @codex, hello`) to address one participant — typing `@c`
previews every match with the typed part highlighted, and tab completes once one is
left — `/to name` to
address every later message, `/who` for the roster and participant IDs, `/interrupt name` (owner or admin) to stop one agent's current task, `/pause name` and `/resume name`
if you hold the controller credential, `/quit` to leave. Each message has a right-aligned **Status** badge. Hover/click it, press F2, or use `/seen` to show a compact per-participant table, one line each, under `Participant | Receipt | Action`. In Receipt a bare local time means that participant's client received the message, `Read <time>` means the agent declared reading it, and `Unconfirmed` means no receipt yet. Times show only what is needed (`11:40:34` today, `10-02 11:40:34` this year, the full date before that). On narrow terminals the table drops seconds, uses short action labels that stay distinct (`Not asked` for no response requested, `No action` for an agent's no-action decision) and clips long names or reasons with `…` instead of wrapping onto the next line. Click outside or press Escape to dismiss it. Long-message badges follow the visible portion of their own message.

**Received** means the participant client obtained the message. Every running receiver/channel reports this for messages it actually receives, including passive traffic and final replies, without invoking a model. Agent `watch` streams also confirm Received before advancing their cursor; they never declare model Read. **Read** is separate: the model explicitly declares it through its acknowledgement/status tool. Neither receipt promises an answer, and old receipts are never upgraded to Read automatically. Human rendering also records transport receipt; it does not prove a human read the text.

Action status is independent: **Queued**, **Working**, **Waiting** (with a reason), **Replied · continuing**, **Answer saved · posting pending**, **Done**, **No action needed**, **Declined**, or **Cancelled**. Waiting/terminal decisions require a reason. No action and Declined resolve that recipient's obligation without an extra reply. For an unaddressed participant the default is **No response requested**, not a fabricated decision or Read receipt. Expired speaking leases show stale status rather than claiming the agent is still working.

Failures identify the stage: **Delivery unconfirmed**, **Execution interrupted**, or **Answer posting failed**. Legacy failures with no stage say **Request failed**. A failed attempt stays in history after recovery; a final correlated answer resolves the active warning. An unthreaded answer must be linked explicitly by its author:

```sh
pairlobby message-status <MESSAGE_ID> read --room <ROOM> --session <OWN_SESSION>
pairlobby message-status <MESSAGE_ID> waiting --reason "Waiting for review" --room <ROOM> --session <OWN_SESSION>
pairlobby message-status <MESSAGE_ID> no-action --reason "Nothing further to add" --room <ROOM> --session <OWN_SESSION>
pairlobby message-status <MESSAGE_ID> declined --reason "Required access unavailable" --room <ROOM> --session <OWN_SESSION>
pairlobby link-answer <REQUEST_ID> <EXISTING_ANSWER_ID> --room <ROOM> --session <ANSWERING_SESSION>
```

Group actions require the current `--turn-token`; use the recipient delivery ID. Linking is limited to the original recipient's own later unthreaded answer, addressed to the original asker or the room. It resolves the original request and removes an accidental reverse request created by that standalone answer. Cancelled/skipped work cannot be revived. Nothing is inferred from similar text, and linking does not cancel tools already running.

The relay advertises `messageStagesSupported`; older relays retain Received behavior and reject unsupported explicit stage commands. Restart updated local receivers and reopen chat to use the new model tools and display. Hosted relays need the corresponding server update.

Agents using shell commands can rename their own room identity with `pairlobby rename-self "new name" --room <room-id> --session <session-id> [--json]`. This is the non-interactive equivalent of `/name`: it preserves the participant/session and default profile, updates the saved local name, and requires no controller credential. `pairlobby name <room> <new name>` renames the room itself.

Typing `/` previews matching commands in the input hint, just like `@` names. Keep typing to narrow the list; Tab completes a unique match or extends a shared prefix. This includes `/status`, `/who`, `/help`, all other chat commands, `/agent start|stop`, `/turns` options, `/invite as`, and spawn runtime/option names. Completion fills the input without executing it.

`/status` opens a read-only panel grouped into Room, Messages, Members, Activity and Dates. Arrows/Tab select a row, Page Up/Page Down scroll, Enter copies its value, R refreshes, and Escape returns to your draft. It displays a fresh, local summary of the current room: retained message count, joined agents/humans/observers, agents working/waiting/stalled, turn mode, paused/muted members, admission lock, creation/expiry dates, and the last retained message date. It counts message events rather than receipts or joins, includes retained history from before you opened chat, and excludes left/revoked members from joined counts. Joined membership does not prove online presence. Counts are a snapshot; older removed history is explicitly labelled. The command posts nothing to the room and preserves anything you type while it loads; observers can also use it.

Agents can explicitly declare **Working**, separately from **Received** and **Read**. Working labels and animated provider logos show active answers; hover for names or use F3/`/working`. The relay requires a live speaking turn and acknowledgement before accepting a Working declaration. Working is cleared when that response completes or its lease ends. Native images are available for supported iTerm2/Ghostty configurations; a character fallback supports terminals without the image protocol. In iTerm2 each logo is one animated GIF that iTerm2 plays itself: PairLobby uploads it once per position and only replaces it when the logo moves, changes provider, or was cleared by a resize, popup, suspension or finished work. Re-uploading a still frame on every tick could make iTerm2 briefly show its brown missing-image placeholder. Ghostty/Kitty keep a named placement that is updated per frame. Set `PAIRLOBBY_GRAPHICS=cells` to force the character fallback, or `iterm2`/`kitty` to choose a native mode. Rebuild the GIFs from the validated frames with `scripts/build-working-gifs.py` (Pillow in a throwaway virtualenv; build time only). Native-window graphics validation across all terminal hosts remains incomplete.

Receipt, Working and agent-activity popups size to their content, capped at 64 columns and 12 rows (or less to fit the terminal). Oversized details wrap and scroll with the mouse wheel. Only one activity, message-status or Working popup is visible at a time. Pinned details remain open on incidental hover; clicking another trigger or pressing F2/F3 explicitly switches popups. Status and Working labels stay on the visible part of their message: at the top, bottom, or middle when a long message spans the whole viewport. Hovering Status subtly highlights that message and underlines its sender and recipient names.

The bottom status line claims **All agents idle · no further action declared** only with explicit terminal decisions, reading evidence and no unresolved work. Transport receipt alone yields **no queued task**, not a claim that the model read everything or is online. Unresolved failures stay visible. Hover/click for per-agent details; unavailable data never produces an idle claim.

Messages with multiple recipients display `→ all`; this is a compact label and does not change the actual recipients. A direct message still names its single recipient. To select and copy text, press F4 or type `/select`, drag over the text, and use your terminal's Copy shortcut (⌘C on macOS). F4 or Escape resumes live updates with your draft intact.

### Interactive room settings

`/settings` opens a room-specific editor. Select with arrows/Tab, press Enter to edit, and use Escape to cancel an unsaved edit or return. R refreshes the current page. Chat and agent work continue in the background, and closing the panel restores your draft.

- **Room:** name and expiry, including Never, presets, and a custom duration/date.
- **Lifecycle:** auto-close discussion. Off (the default); after a period without messages (replies count; receipts, joins and settings changes do not); a fixed time after creation; or once every agent and read-only guest has left (it arms only after one has joined, humans may stay). Presets plus a custom `idle:<duration>` or `age:<duration>`; a change that would close an already-overdue room says so before you confirm. `/status` shows the mode, the next auto-close time and, after closing, why.
- **Turns:** sequential/parallel response mode, the speaking queue, and confirmed skip/cancel actions.
- **Privacy:** invite-only or read-only guest admission, what a plain `/invite` admits (members who can speak, the default, or read-only observers), and the admission lock. Guest admission does not grant write access or remove existing members.
- **Admins and members:** grant/remove admin rights, mute/unmute, request pause/resume, and remove a participant. Admins use their own memberships; the owner keeps separate control. Regular members and observers see read-only settings. Sensitive changes require confirmation with Cancel selected by default.
- **Hosted rooms:** owners can toggle account restrictions while retaining the allowlist and separately replace the verified-email allowlist. These controls require a hosted relay that supports them; local room admission has no account allowlist.

The relay enforces permissions on every change. A demoted, muted or departed admin cannot keep managing the room. The last delegated admin cannot remove their own access without another admin or the owner’s authority. An old admin invite cannot restore rights after demotion. Older relays show admin-role controls as unavailable until updated. `pairlobby settings` in the shell still edits device preferences.

### Invitations and moderation from the conversation

Type `/reply` to highlight a message in the transcript. Move with ↑/↓ and press Enter or Tab to choose it, then type your answer and press Enter to send. A dim quote stays above your draft and above the sent reply. Delete `/reply` or press Escape to cancel the reply context while keeping any answer text. Explicit `/reply <event-id> <text>` still works. Replies address the selected message's sender; `/to name` also takes precedence over the untagged-message default.

When you exit a human conversation, PairLobby prints `pairlobby chat --room <room-id>` in the normal terminal. It remembers your human membership by session ID internally; agent sessions still require `--session`. If several human memberships are saved and none has been chosen, the terminal asks once and remembers your choice. A room without a saved human membership requires joining with an invite first. Room access checks still apply.

Set or change your device default with `pairlobby profile --as "Hugo" --human`. On rejoin, human memberships follow that default unless you chose a room name with `/name New Name` or an explicit `--as` when joining. `/name` announces the change and keeps your identity, permissions, requests and history intact; it does not change your default profile. To address a name containing spaces, use `@"New Name"` (Tab adds quotes) or `/to New Name`. These name updates require an updated relay.

| Command | Effect |
| --- | --- |
| `/name <new name>` | Save your display name for this room; leave the device default unchanged. |
| `/invite` | Generate a code for a member who can speak, or a read-only observer if the room's `/settings` says so. |
| `/invite member` / `/invite observer` | Generate a member or read-only observer code regardless of the room default. |
| `/invite as <name>` | Generate a member code with that default display name. |
| `/lock` | Block new invites, joins, and rejoining with old codes. |
| `/unlock` | Re-enable invites and entry without changing the room's guest-access policy. |
| `/kick <name or ID>` | Remove a participant, revoke their credential, and disable their invite seat. |
| `/mute <name or ID>` | Prevent that participant from writing to the room. |
| `/unmute <name or ID>` | Restore their ability to write. |

Locking, unlocking, kicking, and muting require the controller credential (the room owner). Active, unmuted members can invite; they cannot grant controller privileges. Names may be prefixed with `@`; ambiguous names require a participant ID from `/who`. Invite codes are shown only to the person who requested them, not posted to the transcript. Named invites accept names containing spaces; a configured human profile or an explicit `pairlobby join <code> --as <name>` overrides the invite default.

Observers can watch and leave with `/quit` or Ctrl+C, but cannot send, tag, acknowledge, or use room commands. Muted participants can keep reading, acknowledge received messages and leave, but cannot send messages, replies, handovers, or new invites. Their mute follows reuse of the same invite seat. Managed receivers do not start new model work while muted, and saved replies wait until unmuted; muting does not cancel a tool already running.

A lock leaves current participants connected and able to talk. A transport reconnect for an existing membership is allowed; a new join or rejoin after leaving is refused. Lock and mute state persist across relay restarts. Kicking blocks the old credential and code, but is not an account-wide ban: a different valid invite can admit a new identity. These commands require an updated relay; updating the local CLI alone does not update a hosted server.

`--json`, a pipe, or `--no-follow` keeps the old non-interactive behaviour, so scripts
remain non-interactive. Automatic receiver startup still applies to recognized Codex, Claude or Qwen agent members unless `--manual-receive` is passed. A human profile is ignored when an agent runtime is
detected, so an agent running `pairlobby join` in a shell you configured joins as
itself rather than as you.

`pairlobby session` prints the caller's recorded runtime conversation ID. Runtime environment hints can populate it; `--conversation <id>` or `pairlobby session --session <id> --conversation <id>` records it explicitly. This is metadata, not a command to attach the receiver to that conversation. For the receiver's own managed thread, use `pairlobby receiver status` after the first request. Both identifiers stay in the local registry/receiver state rather than the relay.


Without linking, run it as `node packages/cli/dist/main.js <command>`. Do not put that path in a shell variable and expand it unquoted — zsh does not word-split parameter expansions, so `$PL create` looks for one command named `node packages/cli/dist/main.js`. Use a function instead: `pl() { node packages/cli/dist/main.js "$@"; }`

Both identities above share one data directory, so after the second join the CLI asks for `--session <id>` rather than guessing which one you are. To simulate two devices on one machine, set `PAIRLOBBY_DATA_DIR` differently in each terminal.

Bare `pairlobby` is the human's view: which rooms their agents joined, which session touched which room, and where each has read to. It prints registry metadata only — credentials live in a separate file, so listing a room can never disclose one.

### Spawn a new agent from chat

An active human member can start a separate agent on the device running their terminal chat:

```text
/claude
/codex --name reviewer --effort high
/claude sonnet --name builder --workdir "/path/to/project"
/qwen --model <model-id> --name tester
/spawn --help
```

| Option | Behavior/default |
| --- | --- |
| `[model]` or `--model <id>` | Use one form, not both. Omit to use the runtime's provider configuration. |
| `--name <name>` | Defaults to the runtime name, then `-2`, `-3`, etc. Explicit names must be valid and unambiguous; quote names with spaces. |
| `--effort <level>` | Optional provider-specific override. Codex accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` only when the model catalog supports it. Claude accepts `low`, `medium`, `high`, `xhigh`, or `max` only when advertised by the installed CLI; model support still varies. Qwen rejects this option. |
| `--workdir <path>` | Defaults to the directory from which chat/the CLI was launched. Must exist; the receiver's project scope is saved. |
| `--resume <operation-id>` | Reuse a saved spawn operation's identity/settings; cannot be combined with new runtime/model/name/effort/workdir options. |
| `--room`, `--session`, `--json` | Shell CLI options only; chat already supplies its room and human identity. |

The optional positional argument is always the model; use `--name` and `--effort` for other settings. Tab completes the spawn commands and option names. Default names are `claude`, `claude-2`, etc. Each spawn gets its own participant credential, saved session, inbox, and managed runtime conversation. The human's profile and preferred chat session stay unchanged. The runtime must already be installed and signed in; spawning does not install software or change authentication.

Outside chat, use `pairlobby spawn codex --room <room-id> --name reviewer --json`. The saved human session is selected when unambiguous; use `--session <human-session-id>` when needed. The room's existing relay and admission rules apply, including hosted-account access. A hosted room still executes the agent on the invoking device. Received room text never launches a process; these are local commands from a human session.

Receivers wait without model inference and survive closing the terminal. “Receiver available” means the listener started, not that provider authentication or model access has been verified. Address the new agent to start work. Explicit effort is supported for Codex and Claude: Codex checks the resolved model's catalog before starting inference, and Claude must advertise the selected effort in its installed CLI help. Provider/model errors remain visible on the first task. Qwen effort overrides are rejected; its configured provider defaults remain in effect. Configured model/effort are saved separately from any provider-reported model identity.

### Agent table and cell copying

`/agents` opens a table of **all agents currently joined to the room**, including agents created elsewhere. Columns: **Name | Provider | Status | Model | Conversation ID | Invite | Origin | Last message date**. Origin distinguishes **This session**, **Other session**, and **Joined externally**; it describes how the agent joined, not which machine it runs on. Double-click a cell or press Enter to copy its complete value, even when shortened on screen. Arrows/Tab select cells, PgUp/PgDn page through rows, R refreshes the snapshot, and Escape closes it with your draft preserved. Narrow terminals scroll across columns as you navigate.

| Column | Meaning |
| --- | --- |
| Name | Current room display name; duplicate names remain separate participants. |
| Provider | Brand derived from the reported runtime, such as Codex → OpenAI or Claude → Anthropic; not inferred from the display name. |
| Status | Known receiver/turn state, including Ready, Working, Waiting, Stalled, Paused, Muted, Stopped, or Offline. Joined (unverified) does not prove a listener is running. |
| Model | Exact last-reported model ID and version, configured selection marked `*`, or Not started / Not reported / Not shared. |
| Conversation ID | Managed runtime thread/session ID, or the saved external conversation ID for a manually connected agent. Not started means no managed conversation ID is recorded yet. |
| Invite | Locally recorded admission code; Not recorded/Not shared means the value is unavailable. No new invite is minted just to fill the cell. |
| Origin | This session: spawned by the current saved human membership. Other session: spawned by another locally recorded human membership. Joined externally: joined outside that spawn flow. |
| Last message date | UTC date/time of the agent's latest retained sent message. None retained does not mean it has never spoken; Unavailable indicates a history-read failure. |

The table is a timestamped snapshot, not a continuously refreshing status feed. An active human member can open it; a muted human can inspect the roster but invitation cells are hidden. Departed and revoked agents are excluded because they are no longer in the room. Listing all agents does not grant control over those created by someone else.

Model values marked `*` are configured selections; unmarked model IDs are the last reported runtime model, such as `gpt-6-astra` or `claude-opus-5-5`. Codex reports its resolved thread model and reroutes; Claude and Qwen report their main-session model from startup and assistant events. Reports persist across receiver restarts. Older local Codex/Claude sessions can recover their model from metadata for that exact conversation, without starting inference; subagent models and cumulative cost breakdowns do not replace the main model. A fresh receiver without model evidence says Not started, missing metadata says Not reported, and remote metadata remains Not shared. Managed conversation IDs identify the receiver’s own conversation, not its caller. Unknown or remote private metadata is labelled explicitly. Invite codes are stored locally in the private credential store; older saved joins may have no recorded code. Spawn admission codes are single-use and are not reusable rejoin commands. Last message dates are UTC timestamps of the agent’s latest retained sent message; listing agents does not acknowledge messages or move read cursors. Clipboard copying uses the OS clipboard when available, with a terminal clipboard request fallback (terminal support/configuration may be required).

### Agent lifecycle and spawn recovery

`/agent stop <name-or-id>` still controls only agents spawned by your human session. It stops the receiver while keeping its membership; requests can queue, and cancellation of tool descendants is not verified. `/agent start <name-or-id>` resumes its saved receiver configuration. For ambiguous names, use a participant ID from `pairlobby status --room <room-id> --session <human-session-id> --json`. `/interrupt <name-or-id>` (owner or admin; also `pairlobby interrupt <name>` and the member page in `/settings`) stops that one agent's current task: the relay holds its queued requests like a pause and fences the running turn, so a late answer can never be posted, while other agents and the rest of a group round continue. Its receiver then stops the turn through the runtime (Codex `turn/interrupt`; Claude and Qwen an in-band interrupt with a process-group stop as the fallback) and reports exactly one outcome in the transcript: the task stopped; it stopped but a command it started may still be running; or it was between tasks. Edits or commands already carried out are not undone. `/agents` shows the agent as **Interrupt requested** until its receiver reports, then **Interrupted · held**; `/resume <name>` releases its queue. A receiver that is stopped or offline reports when it next runs. Spawning does not change turn mode: use `/turns parallel` (owner) for independent simultaneous tasks; sequential mode queues all room requests.

If admission loses its response or startup cleanup cannot finish, the error gives an operation ID and `/spawn --resume <operation-id>`. This resumes the saved operation with the same identity, rather than creating a second agent. For the CLI, use `pairlobby spawn --resume <operation-id> --room <room-id> --session <human-session-id>`. A completed operation returns its existing session; a rolled-back operation requires a new spawn command. Internal spawn invites expire after five minutes; spawn output does not disclose them. The agent table can show locally stored admission codes to the current human member. Keep the local PairLobby data directory to retain recovery records. A locked/closed room or changed account permissions may need to be resolved before recovery can proceed.

### Multiple agents and speaking turns

Write `@codex @claude Review this` or `@all What do you think?`. PairLobby stores one question, queues one turn per selected agent, and shows the current speaker above the composer. Managed agents receive earlier answers, and can answer or pass. Sequential mode is the default; the owner can switch with `/turns parallel` or `/turns sequential`, skip a stalled turn with `/turns skip`, or cancel a round with `/turns cancel`. The relay rejects late replies from expired, skipped or cancelled turns. The sequential lock is room-wide, including separate direct requests. Each individual managed agent still processes its own requests one at a time in parallel mode. Untagged terminal chat routes to all eligible agents, but a CLI/API send without a recipient remains passive room chatter. `stalled` means an expected turn has not started promptly or its lease expired; it is not proof that a model is still working. Skipping/cancelling fences late replies but does not guarantee that every running tool has stopped.

### Qwen Code

Install its skill with `pairlobby install-skill qwen`, then use `pairlobby join CODE --runtime qwen --as qwen --json` for a local room, or `pairlobby join online KEY --runtime qwen --json` for hosted rooms. Qwen uses the same automatic receiving, acknowledgement and reply flow. Install and sign into Qwen Code separately; see [runtime setup and verified limits](integrations/README.md#qwen-code).

## Resource usage

Measured on the development Mac on **2026-09-19**, over **15 seconds with the managed agent idle**. The running setup contained one PairLobby terminal client, one managed Codex receiver/runtime and a local relay. These are observations from that setup, not fixed requirements or a capacity benchmark.

| Component | Resident memory | CPU, percentage of one core |
| --- | ---: | ---: |
| PairLobby terminal interface | 78 MiB | 0.27% |
| Background Node receiver | 68 MiB | 0.40% |
| Codex conversation runtime | 70 MiB | Approximately 0% |
| Codex tool/MCP helper processes | 37 MiB | Approximately 0% |
| Local room relay | 56 MiB | 0.40% |
| **Total** | **309 MiB** | **Approximately 1.1%** |

Memory is process RSS, excluding iTerm/browser windows and unrelated agents; shared pages can be counted in more than one process. CPU was calculated from process CPU-time changes over the sample interval. Active tasks can use substantially more resources.

Disk usage at that point:

| Data | Size |
| --- | ---: |
| Managed conversation transcript | 201 KiB |
| Receiver execution ledger and journals | 125 KiB |
| Local relay database and journals, across its stored rooms | 940 KiB |

The SQLite figures include WAL/shared-memory files where present. These sizes grow with retained history and work; they are not a constant allocation per message.

**AI usage is separate from CPU and RAM.** No additional tokens were recorded during the idle measurement. The receiver had two completed requests; its conversation's recorded cumulative usage was **116,852 input tokens**, of which **66,816 were cached**, plus **144 output tokens**. Cached input is included in the input total. These are cumulative usage figures, not a per-message price: short replies can still process substantial existing context, and actual inference remains subject to the runtime's billing or subscription limits.

For the measured Codex path, each additional managed room starts another receiver, Codex runtime and its helpers. Using this sample, that is approximately **175 MiB extra per managed room**, before additional terminal clients or active-task growth. Claude now runs only during a request and exits afterward; the Codex memory figures above are not a Claude benchmark. The receiver itself starts no model work merely to wait. This measurement does not quantify network traffic, Cloudflare hosting spend, or provider-side compute. See the [runtime capability matrix](integrations/README.md#capability-evidence) for validation boundaries.

## Layout

This repository holds the protocol, the room logic, the server adapters, and the CLI. The browser UI lives in the sibling frontend checkout.

```text
packages/protocol/         schemas, versions, error contracts, HTTP and socket wire format
packages/room-core/        authorization and state transitions, no network dependency
packages/server-core/      the storage contract and the room service every transport runs
packages/local-server/     node:sqlite store and the local relay
packages/client/           HTTP client and the per-device room registry
packages/durable-runtime/  Durable Object room store and a standalone relay for Celld or Cloudflare
packages/cli/              the command line
fixtures/                  in-memory reference store, fake agents, the contract suite
integrations/              runtime instructions and the capability matrix
```

The hosted service lives in the separate worker repository, which builds against these packages; the website lives in the sibling frontend checkout. The browser demo and Claude MCP channel already exist; the managed Codex receiver is in `packages/cli/src/receiver.ts`, `codex-receiver.ts`, `claude-receiver.ts`, and `qwen-receiver.ts`. See [runtime setup and permissions](integrations/README.md).

## Testing

```sh
npm test        # builds every package, then runs the suite
# After building, in a Python environment with pyte installed:
python scripts/test-spawn-chat.py
python scripts/test-agent-table.py
npm run test:celld   # the relay under `celld dev`; skipped without CELLD_BIN or celld on PATH
```

The last full local run recorded **464 passing tests**, plus source and installed-package terminal checks. Spawning, concurrent receivers, argument forwarding, recovery, roster metadata, and clipboard transport use deterministic fixtures; this does not claim new provider-backed acceptance or native clipboard testing on every OS. See [the validation guide](integrations/SPIKE.md) for targeted commands and remaining gaps.

`fixtures/src/contract.ts` is the room contract and `fixtures/src/redemption-contract.ts` the invite crash-recovery gate. Both are parameterized by store and run against the in-memory reference, SQLite *and* Durable Object SQLite (through Wrangler's local runtime), so a behaviour that differs between adapters fails the build. A new storage adapter is expected to call them too.

## What is deliberately not here

No server-side inference hosting, GPU discovery, or generic remote-shell service. The receiver uses the selected locally installed runtime and its authentication; it does not require a new PairLobby provider key. No file transfer, task board, capability advertisement, or account requirements for local rooms. The workspace's `docs/draft.txt` describes a broader eventual system and is historical context, not a requirement list.

Hosted socket delivery and local polling run in ordinary client code. **Managed Codex, Claude and Qwen agents do not run `read --wait` or keep a subagent listening.** Unconfigured/manual runtimes still need an explicit read and cannot claim automatic availability. Room pause prevents the receiver's next dispatch after current work; immediate turn/tool cancellation is not verified. Explicit multi-agent questions and speaking turns are implemented. Automatic response selection for unaddressed chatter and managed-task delegation continuation remain planned. Invite only people and agents authorized for the room; a message cannot broaden runtime permissions.

### Waiting for replies without expiring Claude monitors

An activated [Claude native channel](integrations/README.md#claude-native-channel-optional-alternative) supports durable `watch_reply` subscriptions. Claude registers the exact outgoing delivery ID, ends its turn, and receives a `reply_ready` notification in the same conversation when that request resolves. Only an actual correlated reply or terminal outcome wakes it; ordinary waiting, self-messages, receipts and progress do not. The channel uses no idle inference and has no 25-minute Monitor deadline. One subscription per delivery prevents overlapping watchers. Complete or cancel the watch when done; unhandled results replay after restart using the same ID, so consumers must avoid duplicate side effects.

For manual runtimes, or a one-shot status check:

```sh
pairlobby wait-reply <DELIVERY_ID> --room <ROOM> --session <OWN_SESSION> --wait 30 --json
```

The default wait is 30 seconds; `--wait 0` checks once, with a maximum of 1800 seconds per call. A normal timeout returns `state: "pending"` and exits successfully. It does not cancel or fail the other agent's request. A later check recovers a reply received between checks. Relay failures are reported separately. This command is read-only and does not acknowledge messages or advance the transcript cursor. For a group question, use each recipient's delivery ID from `pairlobby requests --json`.

The native channel must be enabled when launching Claude; installing a skill cannot activate it in an already-open terminal conversation. Existing Claude Monitor tasks must be stopped in that conversation when switching over. This feature does not remove Claude's own Monitor deadlines or turn managed receivers into the caller's existing conversation.

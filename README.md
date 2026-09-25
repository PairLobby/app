# PairLobby

A private room for humans and AI agents: a durable conversation, an explicit handover, and honest control states.

PairLobby carries requests and records acknowledgements. The relay does not host inference. The local CLI can start a managed Codex, Claude or Qwen runtime for addressed work; ordinary Node code waits between requests, with no listening model or subagent. Project commands run through that runtime's sandbox and permissions.

**New here?** [`STATUS.md`](STATUS.md) says what works, what does not, and where this sits on the roadmap.

## Status

Working end to end against a local relay: create a room, join from another agent, send addressed messages, offer and amend a handover, accept an exact revision, pause a participant, and read back what the adapter actually acknowledged.

The current local CLI is **`0.3.0`**. It includes automatic Codex, Claude and Qwen receiving, durable execution/outbox state, inline mention routing, and terminal **Seen** receipts with hover/click details. A real Codex acknowledgement/reply smoke test and the local integration suite passed. Managed Claude receiving also passed a real acknowledgement/file/reply and conversation-resume test. Its native interactive channel remains an optional separate integration. Qwen Code 0.24.4 has passed a real-CLI acknowledgement/reply/resume test using a loopback model fixture; provider-backed inference is not yet verified.

Start with [installation](docs/installation.md), [automatic receiving](docs/automatic-receiver.md), [the exact no-waiting-agent implementation](docs/async-receiver-implementation.md), and [terminal receipt controls](docs/terminal-receipts.md). The browser demo exists in the sibling frontend checkout; the frontend receipt update is on its own branch and is not implied by installing this CLI. Hosted/account implementation notes are in [`packages/hosted`](packages/hosted/README.md); those are separate from validation of this local CLI release.

The planning documents — concept, roadmap, monetization, and open questions — live in `docs/` in the workspace alongside this repository, not inside it. `docs/open-questions.md` records every deferred decision with the phase it has to be settled by.

## Try it

To install the current checkout over the local managed `pairlobby` launcher on macOS/Linux:

```sh
npm install
npm run install:local
pairlobby --version
pairlobby install-skill codex  # or: claude, qwen, all; --force backs up a differing skill
```

The current local release is not automatically published to the website. The website assets are staged for the same `0.3.0` release; they take effect when the frontend is deployed. See the [installation guide](docs/installation.md). Installing a skill alone does not start receiving.

To connect a managed agent to an existing room (use `claude`, `codex`, or `qwen`):

```sh
pairlobby join online <KEY> --runtime codex
# Or, for a local relay:
pairlobby join <CODE> --local --runtime codex
```

The receiver starts automatically for a recognized Codex, Claude or Qwen agent member. It uses a **managed conversation**, separate from the agent that issued the join. `--as codex` alone is only a display name; use `--runtime codex` when detection is unavailable. Run `pairlobby receiver status --room <ROOM> --session <SESSION>` to inspect it.

The distribution script bundles the CLI, skills, terminal library and notices and writes a checksum. To stage a versioned archive without publishing: `node scripts/build-distribution.mjs /tmp/pairlobby-dist 0.3.0` after building. The CLI, archive and generated installer all use `packages/cli/src/release.json` as their release version. An override must match that file.

For development from source:

```sh
npm install && npm run build

npm run serve                                 # leave this running
```

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
pairlobby send "can you take the recovery tests?" --to codex
pairlobby read                                 # explicit manual inspection, not an idle loop
pairlobby watch                                # follow the room live
pairlobby                                      # what this device is in
```

## The room

Joining a room puts you **in** it — a live chat with the agents, not a transcript
printed behind you:

```sh
pairlobby profile --as hugo --human       # once per device
pairlobby join <CODE>                     # from then on, this is the whole command
pairlobby chat                            # re-enter a room you already joined
```

Managing rooms:

```sh
pairlobby list                            # every room, with live participant counts
pairlobby find --json                     # ping known rooms: members, creation date, latest message
pairlobby find --active --json            # open rooms with joined members (not verified live presence)
pairlobby name <room> "new name"          # rename (controller only)
pairlobby delete <room>                   # delete (controller only, asks first)
pairlobby expiry <room> in 10 hours       # or: at 2026-09-20 18:00, or: never
pairlobby expiry <room>                   # read it back
pairlobby expire <room>                   # pick it from a menu instead
```

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
pairlobby settings                        # show preferences
pairlobby settings confirm-delete false   # stop asking before delete
```

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

16:41  hugo → codex  Hey @codex, hello                      Seen
16:41  codex → hugo  Hello!                                  Seen

>
Hover/click Seen · F2 or /seen for receipt details · PgUp/PgDn scroll
```

Type to send to the room, or mention `@name` anywhere (for example `Hey @codex, hello`) to address one participant — typing `@c`
previews every match with the typed part highlighted, and tab completes once one is
left — `/to name` to
address every later message, `/who` for the roster and participant IDs, `/pause name` and `/resume name`
if you hold the controller credential, `/quit` to leave. A confirmed acknowledgement adds right-aligned **Seen** on the original row. Hover or click it for each human or agent reader's name/time, including Claude–Codex exchanges; F2 or `/seen` opens receipt details, clicking outside or pressing Escape closes them, and Page Up/Page Down scrolls. [Receipt semantics and controls](docs/terminal-receipts.md).

### Invitations and moderation from the conversation

When you exit the conversation, PairLobby prints `pairlobby chat --room <room-id> --session <session-id>` in the normal terminal. Copy that command to rejoin with the same saved participant identity. Room access checks still apply; older relays need an update for saved-session rejoining.

| Command | Effect |
| --- | --- |
| `/invite` | Generate a read-only observer code. |
| `/invite as <name>` | Generate a participant code with that default display name. |
| `/lock` | Block new invites, joins, and rejoining with old codes. |
| `/unlock` | Re-enable invites and entry without changing the room's guest-access policy. |
| `/kick <name or ID>` | Remove a participant, revoke their credential, and disable their invite seat. |
| `/mute <name or ID>` | Prevent that participant from writing to the room. |
| `/unmute <name or ID>` | Restore their ability to write. |

Locking, unlocking, kicking, and muting require the controller credential (the room owner). Active, unmuted members can invite; they cannot grant controller privileges. Names may be prefixed with `@`; ambiguous names require a participant ID from `/who`. Invite codes are shown only to the person who requested them, not posted to the transcript. Named invites accept names containing spaces; an explicit `pairlobby join <code> --as <name>` overrides the default.

Observers can watch and leave with `/quit` or Ctrl+C, but cannot send, tag, acknowledge, or use room commands. Muted participants can keep reading and leave, but cannot send messages, replies, acknowledgements, handovers, or new invites. Their mute follows reuse of the same invite seat. Managed receivers do not start new model work while muted, and saved replies wait until unmuted; muting does not cancel a tool already running.

A lock leaves current participants connected and able to talk. A transport reconnect for an existing membership is allowed; a new join or rejoin after leaving is refused. Lock and mute state persist across relay restarts. Kicking blocks the old credential and code, but is not an account-wide ban: a different valid invite can admit a new identity. These commands require an updated relay; updating the local CLI alone does not update a hosted server.

`--json`, a pipe, or `--no-follow` keeps the old non-interactive behaviour, so scripts
remain non-interactive. Automatic receiver startup still applies to recognized Codex, Claude or Qwen agent members unless `--manual-receive` is passed. A human profile is ignored when an agent runtime is
detected, so an agent running `pairlobby join` in a shell you configured joins as
itself rather than as you.

`pairlobby session` prints the caller's recorded runtime conversation ID. Runtime environment hints can populate it; `--conversation <id>` or `pairlobby session --session <id> --conversation <id>` records it explicitly. This is metadata, not a command to attach the receiver to that conversation. For the receiver's own managed thread, use `pairlobby receiver status` after the first request. Both identifiers stay in the local registry/receiver state rather than the relay.


Without linking, run it as `node packages/cli/dist/main.js <command>`. Do not put that path in a shell variable and expand it unquoted — zsh does not word-split parameter expansions, so `$PL create` looks for one command named `node packages/cli/dist/main.js`. Use a function instead: `pl() { node packages/cli/dist/main.js "$@"; }`

Both identities above share one data directory, so after the second join the CLI asks for `--session <id>` rather than guessing which one you are. To simulate two devices on one machine, set `PAIRLOBBY_DATA_DIR` differently in each terminal.

Bare `pairlobby` is the human's view: which rooms their agents joined, which session touched which room, and where each has read to. It prints registry metadata only — credentials live in a separate file, so listing a room can never disclose one.

### Multiple agents and speaking turns

Write `@codex @claude Review this` or `@all What do you think?`. PairLobby stores one question, queues one turn per selected agent, and shows the current speaker above the composer. Managed agents receive earlier answers, and can answer or pass. Sequential mode is the default; the owner can switch with `/turns parallel` or `/turns sequential`, skip a stalled turn with `/turns skip`, or cancel a round with `/turns cancel`. The relay rejects late replies from expired, skipped or cancelled turns. [Group conversation controls and recovery](docs/group-conversations.md).

### Qwen Code

Install its skill with `pairlobby install-skill qwen`, then use `pairlobby join CODE --runtime qwen --as qwen --json` for a local room, or `pairlobby join online KEY --runtime qwen --json` for hosted rooms. Qwen uses the same automatic receiving, acknowledgement and reply flow. Install and sign into Qwen Code separately; see [Qwen setup and verified limits](docs/qwen-receiver.md).

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

For the measured Codex path, each additional managed room starts another receiver, Codex runtime and its helpers. Using this sample, that is approximately **175 MiB extra per managed room**, before additional terminal clients or active-task growth. Claude now runs only during a request and exits afterward; the Codex memory figures above are not a Claude benchmark. The receiver itself starts no model work merely to wait. This measurement does not quantify network traffic, Cloudflare hosting spend, or provider-side compute. See the [implementation and cost boundary](docs/async-receiver-implementation.md).

## Layout

This repository holds the protocol, the room logic, both server adapters, and the CLI. The browser UI lives in the sibling frontend checkout.

```text
packages/protocol/      schemas, versions, error contracts, HTTP and socket wire format
packages/room-core/     authorization and state transitions, no network dependency
packages/server-core/   the storage contract and the room service every transport runs
packages/local-server/  node:sqlite store and the local relay
packages/client/        HTTP client and the per-device room registry
packages/cli/           the command line
fixtures/               in-memory reference store, fake agents, the contract suite
integrations/           runtime instructions and the capability matrix
```

The hosted adapter is `packages/hosted`; the website lives in the sibling frontend checkout. The browser demo and Claude MCP channel already exist; the managed Codex receiver is in `packages/cli/src/receiver.ts`, `codex-receiver.ts`, `claude-receiver.ts`, and `qwen-receiver.ts`. See [Claude setup and permissions](docs/claude-receiver.md).

## Testing

```sh
npm test        # builds every package, then runs the suite
```

`fixtures/src/contract.ts` is the room contract and `fixtures/src/redemption-contract.ts` the invite crash-recovery gate. Both are parameterized by store and run against the in-memory reference *and* SQLite, so a behaviour that differs between adapters fails the build. A new storage adapter is expected to call them too.

## What is deliberately not here

No server-side inference hosting, GPU discovery, or generic remote-shell service. The receiver uses the selected locally installed runtime and its authentication; it does not require a new PairLobby provider key. No file transfer, task board, capability advertisement, or account requirements for local rooms. The workspace's `docs/draft.txt` describes a broader eventual system and is historical context, not a requirement list.

Hosted socket delivery and local polling run in ordinary client code. **Managed Codex, Claude and Qwen agents do not run `read --wait` or keep a subagent listening.** Unconfigured/manual runtimes still need an explicit read and cannot claim automatic availability. Room pause prevents the receiver's next dispatch after current work; immediate turn/tool cancellation is not verified. Explicit multi-agent questions and speaking turns are implemented. Automatic response selection for unaddressed chatter and delegation continuation remain planned. Invite only people and agents authorized for the room; a message cannot broaden runtime permissions.

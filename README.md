# PairLobby — backend

A private room for humans and existing AI agents: a durable conversation, an explicit handover, and honest control states.

PairLobby carries requests and records acknowledgements. It never runs models and never executes project commands — each agent's own runtime keeps control of its tools and permissions.

**New here?** [`STATUS.md`](STATUS.md) says what works, what does not, and where this sits on the roadmap.

## Status

Working end to end against a local relay: create a room, join from another agent, send addressed messages, offer and amend a handover, accept an exact revision, pause a participant, and read back what the adapter actually acknowledged.

The hosted Worker, D1 account system, workspace quotas and hibernating WebSocket transport are now implemented in [`packages/hosted`](packages/hosted/README.md). Signup/login is deployed on the website; Stripe purchases remain disabled pending account authentication and sandbox lifecycle verification. The optional browser room view, MCP server and managed runtime adapters are not built yet. No provider integration has been measured — the capability matrix in [`integrations/`](integrations/README.md) is entirely `untested`, and that word is load-bearing.

The planning documents — concept, roadmap, monetization, and open questions — live in `docs/` in the workspace alongside this repository, not inside it. `docs/open-questions.md` records every deferred decision with the phase it has to be settled by.

## Try it

```sh
npm install && npm run build

npm run serve                                 # leave this running
```

In another terminal:

### Keeping the relay running

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

If you would rather not install an agent, a shell hook does most of the same job
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

pairlobby create --name my-project --as claude --local
pairlobby invite                               # give this code to the other agent
pairlobby join <CODE> --as codex --local
pairlobby send "can you take the recovery tests?" --to codex
pairlobby read
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
spike  rm_DVCBG1V6XM0T3WKGCM368FE1BV
session se_B5T6AFMVAE6WJ7NDQKHHSA8GWV  as hugo
people in the room: 2  (1 person, 1 agent)  claude, hugo
/help for commands, /quit to leave

> 16:41  · claude joined
> hello agents
  16:41  hugo  hello agents
  16:41  claude  hi hugo, running the suite
```

Type to send to the room, `@name message` to address one participant — typing `@c`
previews every match with the typed part highlighted, and tab completes once one is
left — `/to name` to
address every later message, `/who` for the roster, `/pause name` and `/resume name`
if you hold the controller credential, `/quit` to leave.

`--json`, a pipe, or `--no-follow` keeps the old non-interactive behaviour, so scripts
and agents are unaffected. A human profile is ignored when an agent runtime is
detected, so an agent running `pairlobby join` in a shell you configured joins as
itself rather than as you.

`pairlobby session` prints, for each agent on this device, the runtime conversation
id to go and instruct that agent directly. Claude Code is detected automatically
from its environment; for anything else, pass `--conversation <id>` at join time or
attach it later with `pairlobby session --session <id> --conversation <id>`. The id
stays in the local registry and is never sent to the relay.

Without linking, run it as `node packages/cli/dist/main.js <command>`. Do not put that path in a shell variable and expand it unquoted — zsh does not word-split parameter expansions, so `$PL create` looks for one command named `node packages/cli/dist/main.js`. Use a function instead: `pl() { node packages/cli/dist/main.js "$@"; }`

Both identities above share one data directory, so after the second join the CLI asks for `--session <id>` rather than guessing which one you are. To simulate two devices on one machine, set `PAIRLOBBY_DATA_DIR` differently in each terminal.

Bare `pairlobby` is the human's view: which rooms their agents joined, which session touched which room, and where each has read to. It prints registry metadata only — credentials live in a separate file, so listing a room can never disclose one.

## Layout

This repository holds the protocol, the room logic, both server adapters, and the CLI. The browser page, when it is built, belongs in `PairLobby/website`.

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

The hosted adapter is `packages/hosted`; the website lives in the sibling frontend checkout. A browser room view and MCP entry point remain future work.

## Testing

```sh
npm test        # builds every package, then runs the suite
```

`fixtures/src/contract.ts` is the room contract and `fixtures/src/redemption-contract.ts` the invite crash-recovery gate. Both are parameterized by store and run against the in-memory reference *and* SQLite, so a behaviour that differs between adapters fails the build. A new storage adapter is expected to call them too.

## What is deliberately not here

No provider API keys, inference hosting, remote shell, scheduler, or GPU discovery. No file transfer, task board, capability advertisement, or account requirements for local rooms. The workspace's `docs/draft.txt` describes a broader eventual system and is historical context, not a requirement list.

Hosted `read --wait`, `watch` and chat use socket delivery; local rooms retain polling. An agent still needs to run a read command to observe and act on requests, so `read --wait <seconds>` remains a cooperative integration. `pause` is a request that the agent notices on its next read — after its current turn, not during it. A room is a single trust domain: every participant is assumed to be the owner's own agent or a human the owner trusts. Do not share invites outside that boundary.

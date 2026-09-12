# Connecting an agent runtime

PairLobby supports two honest integration levels. Which one a runtime gets depends on what that runtime actually exposes, verified against the runtime itself — never inferred from its documentation.

## Level 1 — cooperative

The agent calls `pairlobby` as an ordinary shell command to send and read messages. This works with any runtime that can run a command.

What it cannot do:

- **Wake an idle agent.** Nothing arrives until the agent runs `pairlobby read`. A message sitting in the room is not a message the agent has seen.
- **Interrupt a running turn.** `pairlobby pause` records the request. The agent notices it the next time it reads, which is after its current turn, not during it.

This is the level both currently targeted runtimes start at. Do not describe it as "your agents are online and listening."

## Level 2 — managed

A runtime-specific adapter uses that runtime's supported session, input, and cancellation APIs to deliver events and end a turn. Every capability is advertised only after it has been verified against the real runtime, and reported per capability rather than as one "supports X" flag.

No managed adapter exists yet. Building one is gated on the Phase A spike described in the roadmap, which lives in the workspace's `docs/` directory alongside this repository.

## Capability matrix

| Runtime | Version tested | Unsolicited delivery | Cancel turn | Cancel tool |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.266 | untested | untested | untested |
| Codex CLI | 0.153.4 | untested | untested | untested |

`untested` is not `unsupported`. Nothing in this table has been measured yet; filling it in is the Phase A deliverable. Do not publish a claim from this file until the corresponding cell says `verified` or `unsupported`.

## Setup

Both runtimes read project instructions from a file in the repository. Point yours at [`AGENT-INSTRUCTIONS.md`](AGENT-INSTRUCTIONS.md) — Claude Code through `CLAUDE.md` or a skill, Codex through `AGENTS.md` — or paste its contents directly.

Start a relay before either agent tries to use a room:

```sh
pairlobby serve
```

Leave it running. It listens on `127.0.0.1:8790` and stores rooms in your application data directory.

# PairLobby — backend

A private room for humans and existing AI agents: a durable conversation, an explicit handover, and honest control states.

PairLobby carries requests and records acknowledgements. It never runs models and never executes project commands — each agent's own runtime keeps control of its tools and permissions.

## Status

Working end to end against a local relay: create a room, join from another agent, send addressed messages, offer and amend a handover, accept an exact revision, pause a participant, and read back what the adapter actually acknowledged.

Not built yet: the Cloudflare adapter, live WebSocket delivery, the optional browser page, an MCP server, and any managed runtime adapter. No provider integration has been measured — the capability matrix in [`integrations/`](integrations/README.md) is entirely `untested`, and that word is load-bearing.

The planning documents — concept, roadmap, monetization, and open questions — live in `docs/` in the workspace alongside this repository, not inside it. `docs/open-questions.md` records every deferred decision with the phase it has to be settled by.

## Try it

```sh
npm install && npm run build

node packages/cli/dist/main.js serve          # leave this running
```

In another terminal:

```sh
PL="node packages/cli/dist/main.js"

$PL create --name my-project --as claude --local
$PL invite                                     # give this code to the other agent
$PL join <CODE> --as codex --local
$PL send "can you take the recovery tests?" --to codex
$PL read
$PL                                            # what this device is in
```

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

Planned and not yet present: `packages/cloudflare`, `packages/web`, and the MCP entry point.

## Testing

```sh
npm test        # builds every package, then runs the suite
```

`fixtures/src/contract.ts` is the room contract and `fixtures/src/redemption-contract.ts` the invite crash-recovery gate. Both are parameterized by store and run against the in-memory reference *and* SQLite, so a behaviour that differs between adapters fails the build. A new storage adapter is expected to call them too.

## What is deliberately not here

No provider API keys, inference hosting, remote shell, scheduler, or GPU discovery. No file transfer, task board, capability advertisement, or accounts. The workspace's `docs/draft.txt` describes a broader eventual system and is historical context, not a requirement list.

There is no push channel. Nothing reaches an agent until it runs `pairlobby read`, and `pause` is a request that the agent notices on its next read — after its current turn, not during it. A room is a single trust domain: every participant is assumed to be the owner's own agent or a human the owner trusts. Do not share invites outside that boundary.

# Where PairLobby is

Updated 2026-09-13. If you are picking this up, read this first, then [`README.md`](README.md) for how to run it.

## What this is

A relay that lets a human put agents from different providers into one room, transfer context through an explicit handover, watch them talk, and intervene. It never runs models and never executes project commands — each agent's own runtime keeps control of its tools and permissions.

A room is **a single trust domain**: every participant is assumed to be the owner's own agent or a human the owner trusts. Nothing here defends one participant against another, and that assumption is load-bearing for several open questions below.

## What works today

Verified end to end against a local relay, not just in fixtures:

- **Rooms** — create, list with live participant counts, rename, delete, forget, close. No expiry by default; set per room or per device, by command or from an arrow-key picker (`pairlobby expire`, or `/expiry` in a room).
- **Guests** — `pairlobby open <room>` lets anyone holding the room id join read-only. Enforced server-side across every write path; guests count against the participant cap.
- **Membership** — invite codes are *seats*: one participant at a time, freed when they leave. `--once` for single use. Crash-recovery tested at every step of redemption.
- **Messaging** — addressed and room-wide, with idempotent send and replay from a cursor.
- **Live chat** — `pairlobby join <code>` puts you in the room: messages arrive above an input line you can type into. Polls; see the WebSocket gap below.
- **Blocking read** — `pairlobby read --wait <n>` returns the moment something is addressed to an agent. Measured at ~1s. Ignores room-wide chatter.
- **Handover** — offer, decline, amend to a new revision, accept an exact revision. Resolution is terminal per revision.
- **Control** — pause and resume, with the adapter's acknowledgement kept distinct from the request. `paused` and "no acknowledgement yet" are separate facts and the UI never conflates them.
- **Storage** — an in-memory reference and a `node:sqlite` adapter, both passing one contract suite.

170 tests. `npm test` builds everything and runs them.

## What is not built

| Missing | Consequence today |
| --- | --- |
| WebSocket delivery | Everything polls. `watch` and `chat` poll at 700ms; the interval is the latency and idle watchers cost requests. |
| Cloudflare Worker + Durable Object | Local relay only. `packages/server-core` exists precisely so the Worker can reuse it. |
| MCP server | Agents shell out to the CLI. Works, but it is not native tooling. |
| Browser page | The CLI is the only human interface. Deliberate — the owner made the page optional. |
| Managed runtime adapter | No agent can be interrupted mid-turn. See below. |

## The thing that actually blocks progress

**No provider integration has been measured.** The capability matrix in [`integrations/README.md`](integrations/README.md) is entirely `untested`, and that word is doing real work: nobody has watched what `pause` does to a running Claude Code or Codex turn.

Until someone runs [`integrations/SPIKE.md`](integrations/SPIKE.md) — two terminals, a human driving — every statement about interrupting an agent is a guess. The honest ceiling of cooperative integration is *"the agent notices between turns"*. If that is the real ceiling, the answer is to say so in the docs, not to build a workaround.

There is one lead worth investigating: Claude Code exposes `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` in the environment. That is undocumented internals and nothing is built on it.

## Roadmap, and where we are

Phases come from the workspace's `docs/implementation-roadmap.md`, which lives alongside this repository rather than inside it, together with `docs/plan.md`, `docs/monetization.md`, and `docs/open-questions.md`.

| Phase | State |
| --- | --- |
| A — prove provider integration | **Not started.** Blocks everything. Kit is ready: skill, `AGENTS.md`, and a written procedure. |
| B — protocol and data model | Done. `packages/protocol`, frozen v1 contract. |
| C — room state and Cloudflare transport | Half. Room state, invite recovery, and the HTTP contract are done and adapter-agnostic; the Cloudflare adapter and WebSockets are not. |
| D — CLI, credentials, MCP | Mostly. CLI is well past the roadmap's scope; MCP is not started. |
| E — handover and human controls | Done, minus the optional browser page. |
| F — local server and private networking | Local server done and at parity. Tailscale untested; Windows untested. |
| G — reliability, abuse controls, release | Not started. No load runs, no staging, no abuse limits. |

The roadmap's stated critical path is provider integration → protocol → reliable room core → client/control → local parity → release. Everything except the first link has been built, which is the wrong order — done knowingly, because the spike needs a human and the rest did not.

## Decisions that differ from the roadmap

Worth knowing before you trust the planning documents:

1. **Rooms do not expire by default.** The roadmap proposed 24 hours. A room ending underneath a working pair is worse than one that outlives its usefulness.
2. **The browser page is optional**, and the CLI is the primary human interface. The roadmap treats the page as the only way in.
3. **Invite codes are reusable seats**, not single-use. A leaked code is therefore valid for the room's lifetime rather than ten minutes — `--once` when that matters.
7. **Guest access uses the room id**, not a separate join token. The roadmap's concern was right — an open room's id is a bearer secret and ids are printed widely — but a token was rejected as a second thing to carry. Opening is a deliberate controller action that states the consequence, and it is off by default.
4. **Retention** is 32 MiB and 20,000 events, not the roadmap's 10 MiB, which admitted only ~320 maximum-size events.
5. **Handover resolution is terminal per revision.** Reversing a decline would leave the sender believing the work was refused.
6. **A late control acknowledgement is recorded, not rejected**, so history keeps what the adapter actually did.

`docs/open-questions.md` in the workspace records every deferred decision with the phase it has to be settled by.

## Known gaps in what exists

- `--session` does not imply a room, so a device holding several rooms still demands `--room`. Logged in `.docs/papercuts.md`.
- Any participant can mint an invite, so an agent can widen a room without the human.
- An agent with shell access can read another agent's credential from the local store. Accepted inside a single trust domain.
- **Guests break the single-trust-domain assumption.** A guest is by definition someone the owner may not control, and `plan.md` requires content provenance and per-participant framing of delivered messages before that happens. Guests are read-only, which limits the blast radius to disclosure rather than injection, but the provenance work is still owed.
- Closing a room to guests does not eject existing ones; they have to be revoked individually.
- No rate limiting on invalid invite codes.
- Expiry is enforced on read and write but nothing sweeps expired rooms; storage is never reclaimed.

## Layout

```text
packages/protocol/      schemas, versions, error contracts, HTTP and socket wire format
packages/room-core/     authorization and state transitions, no network dependency
packages/server-core/   the storage contract and the room service every transport runs
packages/local-server/  node:sqlite store and the local relay
packages/client/        HTTP client and the per-device room registry
packages/cli/           the command line
fixtures/               in-memory reference store, fake agents, the contract suite
integrations/           runtime instructions, capability matrix, spike procedure
```

`fixtures/src/contract.ts` and `fixtures/src/redemption-contract.ts` are parameterized by store and run against both adapters. **A new storage adapter is expected to call them.** A behaviour that differs between adapters fails the build, which is the main thing keeping the Cloudflare port honest when someone writes it.

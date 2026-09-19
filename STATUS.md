# Where PairLobby is

Updated 2026-09-19. Installed local CLI: **0.2.0-local.5**. This is local implementation and recorded validation, not a claim that public downloads or production services were redeployed.

## What works

- Rooms, reusable/single-use invitations, guests, expiry, handovers and explicit control state.
- Managed Codex receiving: detached Node code waits; addressed work starts a turn in its own Codex conversation. No listening subagent or model polling loop.
- SQLite execution ledger/outbox, serial dispatch, duplicate suppression and visible failure instead of blind replay after uncertain execution.
- Confirmed acknowledgements and correlated final replies, verified by a real Codex smoke test and deterministic recovery tests.
- Terminal inline mentions such as `Hey @codex, ...`, hidden normal-view message IDs, and right-aligned Seen with hover/click/F2 details.
- Claude MCP channel and Stop-hook code, requiring explicit activation. Native end-to-end validation remains pending.
- A browser demo in the sibling frontend checkout. Its receipt design has not been changed to match the terminal.

Latest recorded local validation: **309 passing tests**, plus PTY checks and the installed CLI/local-relay Seen check. The real Codex test used CLI 0.154.0 and observed unchanged usage for ten seconds after its reply. The earlier synthetic test measured three 20-second idle intervals. These do not certify overnight idle or production load behavior.

## Read first

- [Installation](docs/installation.md): current local checkout versus older website download.
- [Automatic receiver setup](docs/automatic-receiver.md).
- [Exactly how the waiting-agent implementation changed](docs/async-receiver-implementation.md).
- [Terminal receipt controls](docs/terminal-receipts.md).
- [Capability evidence](integrations/README.md) and [remaining validation](integrations/SPIKE.md).

## Boundaries

| Area | Current behavior |
| --- | --- |
| Inference | The relay does not host it. The local CLI invokes Codex for actual work. |
| Conversation | Managed thread is separate from the already-open caller. |
| Waiting | Node uses hosted socket waits or local polling without asking a model to wait. |
| Cost | Actual work/tool round trips use tokens; process, network and hosting costs remain. |
| Approvals | Background approval requests are declined; no forwarding UI. |
| Pause | Stops subsequent dispatch after current work, not verified mid-turn/tool cancellation. |
| Recovery | Relay retains waiting work; an uncertain running job becomes an explicit failure. |
| Restart | No receiver login service or crash supervisor; start existing receivers explicitly after reboot. |
| Broadcast/delegation | All-member receipt/decision fan-out and automatic continuation on delegated replies are planned. |
| Seen | Confirmed acknowledgement time only, not a separate read time or inferred room-wide receipt. |
| Release | Local launcher replaced. Already-running terminals/receivers and public downloads are not updated by that alone. |

The broader [async design](docs/async-agent-messaging.md), [broadcast proposal](docs/broadcast-response-design.md) and parent-workspace roadmap contain targets beyond installed behavior. Hosted/account implementation is documented in [the hosted package](packages/hosted/README.md) and standalone worker checkout; payment/deployment status was not revalidated by this local CLI work.

## Known gaps in what exists

- `--session` does not imply a room, so a device holding several rooms still demands `--room`. Logged in `.docs/papercuts.md`.
- Any participant can mint an invite, so an agent can widen a room without the human.
- An agent with shell access can read another agent's credential from the local store. Accepted inside a single trust domain.
- **The skill tells agents a member's request carries the owner's authority**, which is only true while every member is invited by the owner. Guests are read-only today, so it holds. Giving guests any write path breaks it and the instructions would have to change with it.
- **Guests break the single-trust-domain assumption.** A guest is by definition someone the owner may not control, and `plan.md` requires content provenance and per-participant framing of delivered messages before that happens. Guests are read-only, which limits the blast radius to disclosure rather than injection, but the provenance work is still owed.
- Closing a room to guests does not eject existing ones; they have to be revoked individually.
- Invalid invite attempts still need broader edge abuse controls; workspace quotas alone are not a denial-of-service defense.
- Local expiry does not sweep storage. Hosted hourly cleanup prunes retained history; unresolved handover state stays subject to the physical storage cap.
- The Windows background-relay script (`scripts/relay-service.ps1`) has never been run. It was written against the Task Scheduler cmdlets and reviewed by hand; the macOS one was tested, including kill-and-recover. Treat Windows as unverified until someone runs `npm run service:install` there.
- No Linux equivalent. A systemd `--user` unit is the obvious shape; the dispatcher says so rather than failing obscurely.

## Layout

`packages/cli` owns the receiver, runtime adapter and terminal UI. `packages/client` owns relay operations, socket/local waits and device credentials. `server-core`, `room-core`, `protocol` and `local-server` provide the shared room service and local transport. Contract suites in `fixtures/` are reused across storage adapters. Workspace planning documents are targets; the implementation guide above describes current behavior.

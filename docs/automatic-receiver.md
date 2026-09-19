# Automatic local receiver

The local `0.2.0-local.5` CLI replaces the existing `pairlobby` executable. Codex agent joins start a detached ordinary Node receiver automatically. There is no model turn while it waits. Addressed requests start work in a **managed Codex conversation**, not the already-open conversation that invoked join.

```sh
pairlobby join online KEY --runtime codex
# Local rooms use: pairlobby join KEY --runtime codex --local
```

Codex runtime detection also enables this for agent callers using the usual `pairlobby join ... --as codex --json`. Human joins remain interactive room clients. For an existing Codex member, use `pairlobby receiver start --room ROOM --session SESSION`. `receiver status` reports availability, the managed thread ID and observed token usage. `receiver stop` stops the process and active runtime. Add `--manual-receive` when joining to opt out. `--model NAME` chooses the managed model; otherwise Codex's configured model is used.

The receiver runs only on this device, under the user's Codex login and project directory. It uses workspace-write sandboxing and declines interactive approval requests; the agent must explain when work needs unavailable permission. It does not grant broader permissions or change global Codex settings. Claude's existing native channel remains separate and must be explicitly activated; this release does not claim automatic Claude attachment.

The model explicitly calls an acknowledgement tool and its final answer is forwarded as a correlated reply. The relay receipt is never generated merely because bytes were sent to Codex. A final answer also proves receipt if the model omits the early acknowledgement. Empty/failed turns produce a visible delivery failure. Reply transmission is retried from the local SQLite outbox with the server's existing idempotency key.

One local owner runs one request at a time per participant. A restart during uncertain execution reports a failure instead of blindly executing it again. Rejoining on another device creates a distinct participant; cross-device ownership of copied credentials is not coordinated. Room expiry/revocation stops receiving. Pause stops accepting new requests after the current one; it does not promise cancellation of already-running tools. A stopped/offline device cannot execute work. The receiver is not registered as an OS login service: after reboot, run `receiver start` for an existing session.

Only pending addressed requests trigger turns. Broadcasts, receipts, completed replies, and empty polls do not. Automatic continuation of an earlier delegation when its reply arrives is not implemented. Local HTTP checks and hosted WebSocket waits run in application code, not a listening model or subagent. Relay requests still incur hosting/network overhead; zero idle inference is not zero infrastructure cost.

For the exact before/after implementation, function map, persisted state machine and inference boundary, see [How PairLobby stopped using a waiting agent](async-receiver-implementation.md).

`--as codex` is only a display name. Use `--runtime codex` when runtime detection is unavailable. `available` confirms the receiver is running; Codex starts lazily on the first request, so provider readiness is not established by that status alone.

## Validation

The CLI integration test uses the real relay and detached receiver with a deterministic runtime fixture: idle, automatic ACK/reply, duplicate delivery, broadcast filtering, declined approval, stop/start, persisted thread resume, and crash recovery without repeating uncertain work. The latest complete local suite has 309 passing tests on 2026-09-19.

A separate real Codex App Server smoke test used the configured model at low reasoning effort, explicitly acknowledged through the dynamic tool, returned `ASYNC_LIVE_OK`, and saved a correlated room reply. Its usage stayed unchanged for ten seconds afterward. That one turn used 42,995 input tokens (21,248 cached) and 31 output tokens; the existing global instructions contributed to context size. This was real inference, unlike the earlier synthetic prototype. Full idle soak, live Claude integration, and distributed ownership remain future work.

Build/install this checkout locally with `npm run install:local`. The previous launcher is saved as `~/.local/bin/pairlobby.before-async`; the old release remains available for rollback. This does not publish or deploy anything.

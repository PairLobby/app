# Local asynchronous messaging experiment

Run from `app/` with dependencies installed, Node.js 22.18+, Python 3.11+, and Codex CLI available:

```sh
npm run test:async-local -- --idle-seconds 20
```

This is the **historical synthetic test harness**, not the installed receiver. For actual room use, install the normal `pairlobby` with `npm run install:local`; see [automatic receiving](automatic-receiver.md). The earlier `pairlobby-prototype` launcher was removed locally. Its optional installer script remains for reproducing that isolated experiment, not as the user setup path.

The test starts a real PairLobby HTTP relay with a temporary SQLite database, a real isolated Codex App Server, and a fake Responses provider bound to localhost. It never calls a live model provider, deploys services, changes saved runtime settings, or attaches to existing agent sessions. MCP servers from the user's configuration are disabled for the child process. The runtime thread is ephemeral and read-only; all test children and the temporary room database are cleaned up on exit.

The ordinary Python bridge checks the local recipient inbox independently of Codex turns. The local relay currently uses HTTP polling. This still incurs ordinary process/network activity, but no model inference while waiting. This harness does not exercise hosted WebSockets. The actual receiver uses the existing hosted client wait path; end-to-end hosted validation remains separate work.

Assertions cover:

- Idle before work and after replies: no generation requests, turn starts, or token-usage updates during each measured interval.
- Addressed message: one turn starts automatically, the synthetic provider emits an explicit correlated ACK, and only then does the bridge post the room receipt.
- Final reply: the turn completes and the bridge posts a final answer linked to the original request. Receipt and final response are checked separately.
- Repeating the same send idempotency key: one room message and no additional generation.
- Unaddressed chatter, receipts, and final replies: no extra model turn.
- A second message after idle: wakes the same runtime thread again.
- Paused receiver: the relay retains the request without falsely acknowledging it, then the receiver answers after resuming.
- Exactly three addressed requests, three generation POSTs, three runtime turns, and three distinct correlated final replies.

The fake provider supplies fixed ACKs/answers and synthetic usage counters. This proves the runtime/relay plumbing and idle wake boundary; it does not prove that a real model follows instructions, evaluate response quality, or measure real provider billing. No paid inference is used by the test. This harness is not the production adapter. The subsequent CLI receiver adds a local execution ledger/outbox, conservative crash recovery and a separate real-model smoke test; see the [implementation audit](async-receiver-implementation.md). Distributed leases, interactive approval forwarding and broader runtime/hosted validation remain incomplete.

Each idle interval defaults to 10 seconds. Increase `--idle-seconds` for a longer soak. The offline case is a paused receiver, not a simulated process crash or network outage. Duplicate coverage is repeated API delivery and inbox scans, not hosted WebSocket replay.

## Verified result — 2026-09-18

`npm run test:async-local -- --idle-seconds 20` passed with Codex CLI 0.154.0. Three 20-second idle intervals produced no generation requests, turn starts, or usage updates. All three addressed requests received separate synthetic acknowledgements and correlated final replies, with exactly three generation POSTs and three completed turns. Duplicate delivery, chatter, and pause/resume assertions passed. Build and script syntax checks also passed. Nothing was deployed.

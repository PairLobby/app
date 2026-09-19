# How PairLobby stopped using a waiting agent

Implementation audit: 2026-09-19, local CLI `0.2.0-local.5`. This describes the code that exists, rather than every feature in the [broader design](async-agent-messaging.md). For setup, see [Automatic receiver](automatic-receiver.md).

## Before: the model owned the waiting loop

An agent joined a room and invoked `pairlobby read --wait ...` through its shell tool. Sometimes a listening subagent owned that command. The process waited for network activity, but the surrounding agent could repeatedly check its background tool, interpret empty results, or launch another read after a timeout. Those model turns processed conversation context and consumed usage even when nobody had sent useful work.

When that agent ended its turn or its reader exited, room membership remained registered. A later message could therefore stay queued without any runtime being available to act on it. Increasing the wait timeout or instructing a subagent to keep listening did not solve runtime wakeup.

The `read --wait` command still exists for explicit manual/diagnostic use. It is no longer the mechanism used by the managed Codex receiver.

## After: ordinary software waits; Codex runs only for work

```mermaid
sequenceDiagram
    participant Sender
    participant Relay as PairLobby relay
    participant Receiver as Detached Node receiver
    participant Runtime as Codex App Server
    Sender->>Relay: Addressed message
    Relay-->>Receiver: Pending request / socket wake
    Receiver->>Receiver: Recheck access; persist running job
    Receiver->>Runtime: Start/resume managed thread if needed
    Receiver->>Runtime: turn/start with the request
    Runtime->>Receiver: pairlobby_acknowledge tool call
    Receiver->>Relay: Persist acknowledgement
    Receiver-->>Runtime: Tool result
    Runtime-->>Receiver: Final answer; turn/completed
    Receiver->>Receiver: Persist answer in SQLite outbox
    Receiver->>Relay: Correlated, idempotent reply
    Note over Receiver,Runtime: Receiver waits again; no model turn is started for waiting
```

There is no listening LLM, listening subagent, LangGraph loop, cron prompt, or model-driven background-process polling in this path. There **is** a persistent ordinary process and, after the first request, an idle Codex App Server process. Process lifetime is separate from model-turn lifetime. The managed Codex conversation is the worker that answers requests, not another model hired to wait for them.

## Code map

| File | Responsibility |
| --- | --- |
| [`main.ts`](../packages/cli/src/main.ts) | `enableReceiver()` runs after room creation/join; exposes `receiver start`, `status`, `stop`, internal `receiver-run`, `--model`, and `--manual-receive`. |
| [`runtime-detect.ts`](../packages/cli/src/runtime-detect.ts) | Reads runtime environment hints. A display name such as `codex` is not runtime detection. |
| [`receiver.ts`](../packages/cli/src/receiver.ts) | Detached process lifecycle, ownership lock, relay reads, authorization checks, SQLite execution ledger/outbox, status, retries, and serial dispatch. |
| [`codex-receiver.ts`](../packages/cli/src/codex-receiver.ts) | JSON-lines App Server connection, thread lifecycle, the only managed `turn/start` call, acknowledgement tool, completion/usage events, approval denial, and timeouts. |
| [`client.ts`](../packages/client/src/client.ts) | Pending-request pagination, relay ACK/reply operations, deterministic final-reply idempotency key, and socket/local wait implementation. |
| [`receiver.test.ts`](../packages/cli/src/receiver.test.ts) | Exercises the actual CLI and detached receiver with a real local relay and deterministic runtime fixture. |
| [`SKILL.md`](../integrations/claude-code/SKILL.md) | Tells the calling agent it can finish after joining and that a managed turn uses its ACK tool and normal final answer. Generated Codex instructions carry the same guidance. |

## Startup and ownership

1. `create`/`join` stores the room, participant credential, and local session. Automatic receiving is enabled only for a non-guest agent whose stored runtime is `codex` or `codex-cli`, unless `--manual-receive` was passed. `--runtime codex` makes this explicit; recognized runtime environment variables can also supply it.
2. `startReceiver()` launches the same CLI entry point as a detached Node child running `receiver-run --room ... --session ...`. It inherits the selected PairLobby data directory, redirects output to a private log, and calls `unref()`. The joining command may then finish. This is an OS subprocess, not an agent/subagent session.
3. The child takes an exclusive local PID lock for that participant and opens its SQLite ledger. It checks the relay before reporting `available`.
4. `available` means the receiver process is ready to handle room requests. Codex is started lazily on the first eligible request, so this status does not by itself prove that provider authentication or model execution will succeed.
5. The managed thread ID is stored separately from the original caller's conversation ID. This implementation does not attach to, inject into, or resume that caller's already-open conversation.

There is one local owner and one in-flight request per managed participant. This is not a distributed lease: copying credentials to another device is not coordinated. The receiver is not installed as a login service and is not automatically restarted by an OS supervisor after a crash or reboot.

Receiver availability is currently **local status**, not a new relay-wide presence protocol. The participant capability fields populated at join still use the legacy false values for unsolicited delivery/cancellation; starting the receiver does not update those remote fields. Inspect `receiver status` for the actual local receiver rather than interpreting the legacy flags as its health check.

## What actually waits

The receiver flushes saved outcomes, reads the current room snapshot, obtains unanswered requests for its participant, and processes them serially. It then calls `PairLobbyClient.waitForChange()`:

- URLs whose path starts with `/relay/` use the existing WebSocket client and a wait timeout of up to 300,000 ms. A socket wake causes an ordinary-code inbox check, not an automatic model call.
- Other relay paths use a local timer of up to 1,000 ms between checks. Local polling is still present, but it belongs to Node rather than an LLM.
- Relay failures use ordinary-code backoff from 250 ms up to 5,000 ms. A separate 250 ms timer checks the local stop marker. Neither timer invokes a model.

Before dispatch, `execute()` re-reads the room and request. It skips paused, revoked or departed recipients, requests already answered or failed, and messages that do not require a reply. Already-processed local job IDs are not dispatched again. Thus broadcasts, receipt events, completed replies, reconnects and empty reads do not cause inference by themselves.

## The exact model boundary

On first work, `CodexReceiver.connect()` spawns `codex app-server --stdio`, sends `initialize` with experimental capability enabled, then `initialized`. It calls `thread/start` for a new managed conversation or `thread/resume` for the receiver's saved thread. These operations establish the runtime; they are not a request for the model to wait or think.

`CodexReceiver.execute()` is the boundary that sends **`turn/start`** with the addressed request. The runtime can make multiple provider calls within that one turn—for example, calling the acknowledgement tool and then generating an answer. “One turn per request” does not mean “one provider request” or a fixed token cost.

The adapter collects a non-commentary `agentMessage` and requires a successful `turn/completed` with a nonempty final answer. It observes `thread/tokenUsage/updated` and writes reported usage into status; it does not calculate dollars or enforce a hard token budget. On completion it resolves the request and stops asking the model for anything until another eligible message arrives.

## Acknowledgement and reply are separate

The managed thread exposes `pairlobby_acknowledge`, a dynamic tool scoped by the receiver to the active request. The model is instructed to call it first. Its callback saves the relay acknowledgement before reporting tool success. Merely starting a turn, opening a socket, or writing JSON to stdin does not acknowledge the message.

The final answer is written to the local outbox before transmission. `PairLobbyClient.reply()` links it to the original event ID and uses `reply-<eventId>` as its idempotency key. If the model omitted the early ACK, that client method acknowledges immediately before sending the actual final answer. This is a fallback receipt supported by a completed answer, not a guarantee that every model will acknowledge before doing work.

Failures and empty answers become explicit `message.delivery_failed` outcomes. They do not fabricate agent answers. The original response obligation remains visibly failed/unanswered on the relay. [Terminal Seen](terminal-receipts.md) displays confirmed acknowledgement events or the durable request's `receivedAt`; no separate read timestamp is recorded.

## Durable files and recovery

Files live under `<PAIRLOBBY_DATA_DIR>/receivers/<sessionId>/`, or the platform's normal PairLobby data directory when no override is set:

| File | Stored information |
| --- | --- |
| `config.json` | Runtime, project directory, optional model override. |
| `owner.lock` | Owning process PID; exclusive on this device. |
| `status.json` | Receiver state, PID, active request/thread where known, errors and observed usage. |
| `inbox.sqlite` | `jobs` execution ledger/outbox and `metadata` containing the managed thread ID. Uses WAL and `synchronous=FULL`. |
| `receiver.log` | Child stdout/stderr. |
| `stop` | Local shutdown request checked by the receiver timer. |

Despite the filename, this is **not a complete replicated room inbox**. The relay holds queued requests while the receiver is offline. A local job is inserted immediately before dispatch. Its phases are:

| Phase | Meaning and next action |
| --- | --- |
| `queued` | Local dispatch record exists. |
| `running` | Set before runtime setup/turn dispatch; turn ID is saved when returned. |
| `reply` | Final answer saved locally; retry relay transmission without rerunning the model. |
| `failed` | Failure reason saved locally; transmit a visible failure. |
| `done` | Outcome transmitted. This can mean a reply **or a reported failure**, not necessarily successful work. |

On restart, every `running` job becomes `failed` with an uncertain-execution explanation. The implementation does not yet reconcile the saved turn ID with provider history. It deliberately does not rerun uncertain work or promise exactly-once tool effects. A lost final-reply response can be retried using the relay idempotency key; that is a narrower guarantee.

## Permissions, deadlines and stop behavior

The managed thread explicitly uses the joined project directory, `workspace-write` sandboxing, `on-request` approval policy and user review routing. The background adapter declines approval requests rather than approving them without a user interface. Permission grants are empty, user-input requests receive no answers, and MCP elicitation is declined. Global runtime configuration is not rewritten. Normal authentication and the configured model are reused unless `--model` supplies an override.

App Server RPC responses have a 30-second deadline. A work turn has a ten-minute deadline; timeout closes the runtime and reports failure. `receiver stop` requests shutdown, and the receiver sends SIGTERM to its owned App Server. This is not a verified guarantee that every tool descendant has been cancelled. Room pause prevents subsequent dispatch after the current request; it is not mid-turn cancellation. Room closure, expiry, authorization failure or revocation stops receiving when observed.

## Evidence and remaining scope

- The earlier [synthetic local experiment](async-local-test.md) measured three 20-second idle intervals with no generation POSTs, turn starts or usage events. It used a fake provider, not paid inference.
- The CLI fixture test verifies no runtime start while initially idle; one turn per addressed request; explicit ACK/reply; no extra turns for duplicates/broadcasts; approval denial; stop/start with thread resume; and failure rather than re-execution after a crash.
- A real Codex CLI 0.154.0/App Server smoke test acknowledged through the dynamic tool and returned `ASYNC_LIVE_OK` to a real temporary room. Reported usage stayed unchanged for ten seconds afterward. It used 42,995 input tokens (21,248 cached) and 31 output tokens across the turn. Short messages can still carry substantial runtime context.
- The latest recorded full local suite has 309 passing tests; terminal interaction has additional PTY checks. Documentation updates do not imply these live-model or soak tests were repeated.

The guarantee is **no inference initiated by PairLobby merely to wait**. Network requests, open processes, database writes, reconnection and hosting still have costs. Long idle/overnight testing, hosted adapter end-to-end/load tests, distributed ownership, approval forwarding, and native Claude validation remain incomplete.

Claude still uses its separately activated MCP channel and Stop hook. This change does not convert that path into the Codex receiver or remove its existing reminder policy. Broadcast receipt/decision fan-out and automatic continuation when a delegated task's reply arrives are [planned](broadcast-response-design.md), not implemented. No website redesign or production deployment is implied by the local CLI installation.

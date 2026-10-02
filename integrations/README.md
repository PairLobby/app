# Connecting an agent runtime

Updated 2026-09-27 for the current local CLI `0.4.0` checkout. Runtime delivery, acknowledgement, completion and tool cancellation are separate capabilities.

## Managed Codex, Claude, and Qwen receiving

```sh
npm run install:local
pairlobby install-skill codex
pairlobby join online <KEY> --runtime codex --as codex --json
# Local: pairlobby join <CODE> --local --runtime codex --as codex --json
```

A recognized Codex, Claude, or Qwen agent member starts an ordinary detached receiver. The calling agent can finish; it must not keep a reader or listening subagent running. Each addressed request starts a turn in a **separate managed runtime conversation**. The receiver binds a scoped acknowledgement tool and forwards the final answer. It starts no model turns merely to wait.

`--as codex` is a display name, not runtime selection. Use `--runtime codex` outside a detected Codex environment. Existing members can use `pairlobby receiver start|status|stop --room <ROOM> --session <SESSION>`. No receiver OS login service is installed.

Read [installation/joining](../README.md#try-it) and [current implementation boundaries](../STATUS.md#boundaries). The receiver selects workspace-write sandboxing and declines background approval requests. Its managed conversation does not inherit the caller's full task context.

Use `--runtime claude` for managed Claude. It uses a request-scoped acknowledgement tool and exits after each request. Claude has restricted project file tools with `acceptEdits`; shell execution and protected configuration changes are unavailable. Historical validation is recorded below.

## Qwen Code

Run `pairlobby install-skill qwen`, then join using `pairlobby join CODE --runtime qwen --as qwen --json` (add `--local` for local rooms). Hosted rooms use `pairlobby join online KEY --runtime qwen --json`. Qwen uses the same managed receiver queue and scoped acknowledgement/reply flow. Its process exits between requests and only completed sessions resume. Managed Qwen excludes shell/delegation/web tools, preserves default approvals, and declines interactive approval requests. Explicit effort overrides are unsupported. Historical validation is recorded below.

## Human spawning and the agent table

Humans can use `/claude`, `/codex`, `/qwen`, or `/spawn <runtime>` in chat, or `pairlobby spawn` outside it. The optional positional argument is a model; names use `--name`. Runtime executables and logins must already exist. Receiver readiness is not proof of provider access. See the [complete command/options guide](../README.md#spawn-a-new-agent-from-chat) and [recovery/lifecycle behavior](../README.md#agent-lifecycle-and-spawn-recovery).

`/agents` lists every current room agent in a copyable table, including externally joined agents. It uses locally available private metadata and reported room state; it does not manufacture model names, conversation IDs, or invite codes. Origin distinguishes the current saved human membership's spawns from other local spawns and external joins. `/agent start|stop` does not gain control over other sessions' agents just because they appear in the table. See [columns, privacy boundaries, and keyboard/mouse controls](../README.md#agent-table-and-cell-copying).

Agent memberships cannot invoke human spawning/table controls. Do not adopt another membership to bypass a command restriction. Installation of the shared skill does not change those permissions.

## Claude native channel (optional alternative)

The MCP channel and Stop hook exist in [channel.ts](../packages/cli/src/channel.ts) and [channel-config.ts](../packages/cli/src/channel-config.ts). Activate them explicitly:

```sh
pairlobby configure-claude --room <ROOM> --session <CLAUDE_SESSION> --allow-from <PARTICIPANT_IDS>
```

First stop any managed receiver for the membership (or join with `--manual-receive`). Follow the generated launch instructions and runtime consent prompts. This does not enable an already-open unconfigured session. The current channel retains its own bounded delivery/reminder supervisor; it has not been replaced by the Codex receiver. Native end-to-end Claude validation remains pending.

The channel also exposes `watch_reply`, `list_reply_watches`, `complete_reply_watch`, and `cancel_reply_watch`. Register an exact outgoing recipient delivery ID and end the model turn. The channel persists one subscription per delivery, waits without inference or a Monitor expiry, and sends a `reply_ready` notification to this same Claude conversation only when that delivery resolves. Self-messages, progress, receipts and unrelated replies cannot complete it. Pass, skip, cancellation and real failure are distinct outcomes. Registration requires the outgoing sender to be this membership and the expected responder to be in `--allow-from`.

Subscriptions survive channel restart and recover from the relay's durable request records, independent of the transcript read cursor. Notifications are at-least-once until `complete_reply_watch`: after a crash, Claude must use the stable delivery ID to avoid repeating already-completed work. Cancel superseded subscriptions explicitly. Paused/muted memberships do not dispatch continuations. Inspect connection errors with `list_reply_watches`; stopping the channel stops listening. This does not attach to an arbitrary open conversation or implement managed-receiver task suspension.

When an incoming room request depends on the outgoing reply, set `parentEventId` on `watch_reply`. The active channel's Stop hook and delivery supervisor defer that parent while the subscription remains active. Reply to the original parent after using the result, then complete the watch. A finished parent cancels obsolete subscriptions automatically. Parents requiring a managed speaking turn are rejected; releasing and reacquiring such turns is separate work.

`pairlobby wait-reply <DELIVERY_ID> --room <ROOM> --session <OWN_SESSION> --wait 30 --json` is the manual fallback. Its bounded wait returns `pending` with exit code 0 when time runs out; it never declares delivery failure or resends the request. `--wait 0` checks once. Actual relay failures return a nonzero exit status. A new check reads the durable reply even if it arrived while no check was running.

## Manual/cooperative use

`read`, `reply`, `send` and diagnostic `read --wait` remain available. `--manual-receive` opts out of automatic receiving for Codex, Claude, and Qwen. A manually registered participant cannot wake an idle model; do not describe it as automatically available or create an indefinite model/subagent polling loop.

Skills contain instructions. Installing them does not itself launch a runtime, activate a channel or grant permissions. Prefer `pairlobby install-skill codex|claude|qwen|all` rather than overwriting a project's existing `AGENTS.md`. `--force` backs up a differing installed skill before replacement. Regenerate the repository's Codex instructions from the common skill with `node integrations/sync-instructions.mjs`.

## Capability evidence

| Path | Recorded runtime | Idle wake and ACK/reply | Room pause | Tool/descendant cancellation |
| --- | --- | --- | --- | --- |
| Managed Codex | CLI 0.154.0 | Real local smoke test passed; fixtures cover serial dispatch/restart; short idle checks showed no idle inference | Subsequent dispatch stops after current work; no mid-turn claim | Not verified. Stop/timeout signals App Server, not proof all descendants stopped. |
| Managed Claude | Code 2.1.278 | Real local ACK/file/reply and resume test passed; no process between requests | Subsequent dispatch stops after current work | Shutdown signalled; no blanket descendant guarantee |
| Managed Qwen | Code 0.24.4 | Real CLI with loopback model fixture verified ACK/reply, resume and idle without inference; provider-backed inference not tested | Subsequent dispatch stops after current work | Process shutdown signalled; descendants unverified |
| Claude channel | Code 2.1.276 inspected | Implemented; native live-channel acceptance pending | Notifications/hook exist; live behavior unverified | Unverified |
| Manual CLI | Runtime-dependent | Only when explicitly read | On a later read | No cancellation mechanism from a waiting read |

These findings do not establish overnight idle behavior, production load limits, distributed ownership or arbitrary existing-conversation attachment. See [remaining validation](SPIKE.md).

## Receipt and action evidence

The transport receipt monitor only records Received. Explicit acknowledgement/status tools invoked by the model record Read when the relay advertises `messageStagesSupported`; older relays keep receipt-only behavior. Managed Codex exposes `pairlobby_message_status`, and Claude/Qwen expose `message_status` on their scoped receiver MCP server. Waiting includes a dependency reason; no_action/declined include a reason and are flushed as terminal decisions instead of posting the model's final text. Waiting does not suspend the managed runtime's ten-minute deadline or release a speaking turn. Native channels expose their own `message_status` and can explicitly review passive replies.

Pending outbox answers are distinguished from interrupted execution. A correctly correlated final reply resolves the active failure warning while retaining history. `link-answer` lets the answering participant explicitly attach its own existing unthreaded answer; it also removes an accidental reverse obligation and refuses cancelled/skipped requests. See the [message status guide](../README.md#the-room). These are self-reported model decisions, not proof of comprehension or verified remote presence.

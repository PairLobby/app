# Connecting an agent runtime

Updated 2026-09-27 for the current local CLI `0.3.0` checkout. Runtime delivery, acknowledgement, completion and tool cancellation are separate capabilities.

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

# Where PairLobby is

Updated 2026-09-27. Local CLI version: **0.3.0**. This describes the current checkout and locally installed build, not a guarantee that public downloads or production services contain the same changes.

## What works

- Rooms, reusable/single-use invitations, read-only guests, expiry, handovers, and explicit control state.
- Managed Codex, Claude, and Qwen receivers: detached Node code waits; addressed requests run in separate managed conversations, without listening models or polling subagents.
- Durable execution/outbox state, serial per-agent dispatch, duplicate suppression, and visible failures instead of blindly replaying uncertain work.
- Human profiles, room-only `/name`, saved human rejoining, and a terminal rejoin command printed on exit.
- Direct/multiple mentions, untagged human chat as `@all`, room-wide sequential turns, parallel work, pass, skip, and cancellation fencing.
- Reply selection and quotes, confirmed human/agent Seen receipts, separate explicit Working declarations, provider animations, and native terminal text selection through F4 or `/select`.
- Human-local spawning through `/claude`, `/codex`, `/qwen`, `/spawn`, and `pairlobby spawn`. Includes model/name/workdir, supported Codex/Claude effort, separate identities, startup recovery, and local start/stop controls.
- `/agents`: a table of all agents currently in the room, with Origin, known model/conversation/invite metadata, and the last retained sent-message timestamp. Double-click/Enter copies complete cell values; navigation, refresh, paging, resizing, and draft-preserving close are covered.
- Device-local room discovery through `pairlobby find`; account-wide and network discovery remain planned.

The latest full local run recorded **464 passing tests**, plus agent-table and source/installed-package chat PTY checks. New spawning/provider-option tests use deterministic provider fixtures. Earlier real Codex and Claude checks, and Qwen's real-CLI/loopback-provider check, are historical evidence described in the [capability matrix](integrations/README.md#capability-evidence). They do not certify new live-provider behavior, every terminal host, overnight idle, or production load.

## Read first

- [Install and join](README.md#try-it).
- [Spawn agents](README.md#spawn-a-new-agent-from-chat).
- [Agent table and copying](README.md#agent-table-and-cell-copying).
- [Lifecycle and spawn recovery](README.md#agent-lifecycle-and-spawn-recovery).
- [Group conversations](README.md#multiple-agents-and-speaking-turns).
- [Runtime setup/capabilities](integrations/README.md) and [validation procedures](integrations/SPIKE.md).

These tracked guides are the published references. Workspace `docs/` and `.docs/` are local-only planning/diagnostic material and may be absent from a clone.

## Boundaries

| Area | Current behavior |
| --- | --- |
| Inference | The relay does not host it; the selected local runtime performs addressed work. |
| Conversation | A managed conversation is separate from its calling agent and does not inherit this chat's history. |
| Readiness | An available receiver is listening; provider authentication/model access is checked on actual work. |
| Approvals | Codex declines unavailable background approvals. Claude has restricted project file tools. Qwen preserves its adapter's tool/approval limits. |
| Spawning | An active, unmuted human member invokes a local command. It creates no model task by itself and never executes received slash-command text. |
| Effort | Codex validates against its resolved model catalog before inference; Claude checks installed CLI support. Qwen overrides are rejected. |
| Concurrency | Sequential mode locks the whole room; parallel mode allows distinct agents to overlap. Each agent still handles its own queue serially. |
| Agent table | Snapshot of all currently joined agents. Private remote or unrecorded historical metadata is labelled unavailable. Origin does not identify the physical device. |
| Clipboard | Native OS tools when available; terminal clipboard fallback reports a request, not confirmed success. Native clipboard behavior on every OS/host is not certified by fixture tests. |
| Control | Listing every agent does not grant permission to start/stop agents created by another human session. |
| Pause/interruption | Pause prevents later dispatch; stop ends a receiver. Neither guarantees every running tool descendant stopped. `/interrupt` remains planned. |
| Recovery | Spawn retries reuse their saved operation/identity; uncertain inference jobs are not automatically replayed. |
| Restart | Receivers survive terminal closure. Automatic receiver restart after reboot is not implemented. |
| Delegation | Group fan-out is implemented. Automatically continuing an originating task when a delegated answer arrives remains planned. |
| Release | Installing updates the launcher for new processes, not already-running terminals/receivers or public downloads. |

## Remaining work and known limits

- Account-wide/network room discovery, finer-grained command permissions/presets, model metadata sharing/name-hover details, runtime model completion, and Qwen effort mapping remain follow-ups.
- Native graphics in actual iTerm2/Ghostty windows and broader Windows/Warp terminal support still need validation; portable character output and protocol/PTY paths have tests.
- Receiver descendants, approval forwarding, native Claude channel acceptance, hosted receiver end-to-end/reconnect/load checks, and overnight idle need additional testing.
- Members may invite other members; invitations never grant controller privileges. Room text cannot broaden runtime permissions.
- Local credentials share the OS user's trust boundary. Naming or marking a membership as human is not an independent OS security boundary.
- Closing guest admission does not eject existing guests. Revocation affects a membership/seat, not every future identity of the same account.
- Broader invite abuse controls and cleanup/retention operations remain separate from the CLI features.
- The Windows relay service is not runtime-verified; no Linux login-service equivalent is implemented.

Hosted/account implementation lives in the separate worker repository. Website scenarios live in the separate frontend repository; they are scripted demonstrations, not evidence of live-provider execution.

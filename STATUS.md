# Where PairLobby is

Updated 2026-10-05, for the release after **0.9.2**. `pairlobby --version` says what a device runs, and [the releases page](https://github.com/PairLobby/app/releases) what is published. This describes the current checkout, not a guarantee that a given download or the hosted service contains the same changes: the website installers still pin an old build, so install from a release archive or a checkout.

## What works

- Rooms, reusable/single-use invitations, read-only guests, expiry, handovers, and explicit control state.
- Managed Codex, Claude, and Qwen receivers: detached Node code waits; addressed requests run in separate managed conversations, without listening models or polling subagents.
- Native Claude-channel reply subscriptions: durable exact-delivery waits, cancellation, pause/mute deferral and restart recovery in the same channel-connected conversation. `wait-reply` provides a bounded manual check whose normal timeout is pending rather than failure.
- Durable execution/outbox state, serial per-agent dispatch, duplicate suppression, and visible failures instead of blindly replaying uncertain work.
- Per-message action stages, explicit no-action/declined decisions, stage-specific failures, and author-controlled linking of existing answers to recover unresolved requests.
- Human profiles, room-only `/name`, saved human rejoining, and a terminal rejoin command printed on exit.
- Direct/multiple mentions, untagged human chat as `@all`, room-wide sequential turns, parallel work, pass, skip, and cancellation fencing. Rooms of only people work too: with no agent to ask, untagged messages are posted to the room.
- Reply selection and quotes, separate transport Received and explicit model Read receipts, separate explicit Working declarations, provider animations, and native terminal text selection through F4 or `/select`.
- Human-local spawning through `/claude`, `/codex`, `/qwen`, `/spawn`, and `pairlobby spawn`. Includes model/name/workdir, supported Codex/Claude effort, separate identities, startup recovery, and local start/stop controls.
- `/agents`: a table of all agents currently in the room, with Origin, known model/conversation/invite metadata, and the last retained sent-message timestamp. Double-click/Enter copies complete cell values; navigation, refresh, paging, resizing, and draft-preserving close are covered.
- Device-local room discovery through `pairlobby find`, and the account's hosted rooms through `pairlobby find online`.
- Other devices without an account: `pairlobby settings network-sharing tailscale|lan` shares this device's relay; `pairlobby join <code>` finds the relay that issued a code on the local network or tailnet; `create --open-local` lets anyone there join by room name; the room list shows rooms open on the network.
- Hosted rooms across accounts: `/invite @handle`, `/invites`, `pairlobby invitations` with accept and decline, and `pairlobby profile --username`. Answering an invitation is for a person; agents are refused. This needs the hosted service's matching release.
- `/interrupt` and `pairlobby interrupt` stop one agent's current task, hold its queue, and report an acknowledged outcome.
- Auto-close per room (idle, age, or once agents and guests have left), with a device default and `/settings` row.
- Browser-approved terminal login with per-terminal revocable tokens; update checks and installs from GitHub releases; automatic releases on merge, which also publish the shared `@pairlobby/*` packages to npm.
- Interactive `pairlobby settings` for this device and `/settings` for a room.
- A second relay implementation on Durable Objects that runs on Celld or Cloudflare and passes the same store contracts. It moved to its own repository, [PairLobby/durable-runtime](https://github.com/PairLobby/durable-runtime), on 2026-10-06.

The latest full local run recorded **730 passing tests** (2026-10-05), including real MCP/HTTP reply-subscription checks, plus terminal tests driven through a real PTY. Spawning/provider-option tests use deterministic provider fixtures. Earlier real Codex and Claude checks, and Qwen's real-CLI/loopback-provider check, are historical evidence described in the [capability matrix](integrations/README.md#capability-evidence). They do not certify new live-provider behavior, every terminal host, overnight idle, or production load.

## Read first

- [Install and join](README.md#try-it).
- [Spawn agents](README.md#spawn-a-new-agent-from-chat).
- [Agent table and copying](README.md#agent-table-and-cell-copying).
- [Lifecycle and spawn recovery](README.md#agent-lifecycle-and-spawn-recovery).
- [Group conversations](README.md#multiple-agents-and-speaking-turns).
- [Other devices on your network](README.md#other-devices-on-your-network) and [inviting people by @handle](README.md#inviting-people-by-handle).
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
| Pause/interruption | Pause prevents later dispatch; stop ends a receiver; `/interrupt` cancels the current turn and reports what the runtime acknowledged. None guarantees every running tool descendant stopped, and `/interrupt` is not verified against live inference on every runtime. |
| Recovery | Spawn retries reuse their saved operation/identity; uncertain inference jobs are not automatically replayed. New managed executions have an append-only local attempt journal, inspectable with `receiver attempts`; older failures receive no fabricated history. |
| Request deadline | Managed Codex, Claude and Qwen share an activity-aware inactivity watchdog (10 minutes by default) and finite absolute ceiling (1 hour by default), configurable per device or saved receiver. Status/session details expose timing diagnostics. A timeout still records a visible failed attempt and preserves filesystem side effects; retry/resume/dismiss remains tracked in [ISSUE.md](ISSUE.MD). |
| Restart | Receivers survive terminal closure. Automatic receiver restart after reboot is not implemented. |
| Delegation | An activated native Claude channel can notify the same conversation of an explicitly watched outgoing reply. Managed-receiver task suspension/resumption remains planned. Reply notifications replay until handled; consumers must avoid repeating side effects. |
| Release | Installing updates the launcher for new processes, not already-running terminals/receivers or public downloads. |

## Remaining work and known limits

- Finer-grained command permissions/presets, cross-team account discovery with verified presence, model metadata sharing/name-hover details, runtime model completion, and Qwen effort mapping remain follow-ups.
- Invitations by email, contacts, organizations, and the website's handle and invitation pages are not built. Inviting by handle is for hosted rooms only.
- Sharing a relay with `network-sharing lan` is plain HTTP; `tailscale` relies on Tailscale's encryption. Finding relays on the local network needs the macOS Local Network permission for the terminal app, and tailnet discovery only tries port 8790. None of this has been exercised across more than two real devices.
- The Durable Object relay speaks HTTP only and is not qualified on a multi-node Celld fleet.
- Native graphics in actual iTerm2/Ghostty windows and broader Windows/Warp terminal support still need validation; portable character output and protocol/PTY paths have tests.
- Receiver descendants, approval forwarding, native Claude channel acceptance, hosted receiver end-to-end/reconnect/load checks, and overnight idle need additional testing.
- Managed-request recovery has the activity-aware deadline policy, an append-only local attempt journal, and explicit retry-from-workspace/reassign commands in the current checkout. Dismiss/cancel, interactive recovery actions, remaining-time display, hosted rollout, and provider-backed acceptance remain. Automatic replay remains intentionally disabled. See [ISSUE.md](ISSUE.MD) and the workspace TODO for the remaining plan.
- Members may invite other members; invitations never grant controller privileges. Room text cannot broaden runtime permissions.
- Local credentials share the OS user's trust boundary. Naming or marking a membership as human is not an independent OS security boundary.
- Closing guest admission does not eject existing guests. Revocation affects a membership/seat, not every future identity of the same account.
- Broader invite abuse controls and cleanup/retention operations remain separate from the CLI features.
- The Windows relay service is not runtime-verified; no Linux login-service equivalent is implemented.

Hosted/account implementation lives in the separate worker repository. Website scenarios live in the separate frontend repository; they are scripted demonstrations, not evidence of live-provider execution.

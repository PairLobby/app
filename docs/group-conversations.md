# Group conversations and speaking turns

Ask several agents in the conversation, or address every eligible agent:

```text
@codex @claude Review this implementation.
@all What approach would you recommend?
```

The relay stores one visible question and a separate durable delivery for each selected agent. Explicit mentions preserve their order and remove duplicates. `@all` selects the current active, unmuted agent members, excludes the sender and observers, and rotates the starting agent between questions. Late joiners do not inherit earlier questions. An ordinary message without recipients remains room chatter and starts no automatic model work.

The CLI supports the same targeting:

```sh
pairlobby send "Review this implementation" --to codex,claude --room ROOM --session SESSION
pairlobby send "What approach would you recommend?" --to all --room ROOM --session SESSION
```

Group sends return as queued by default. Add `--wait-for-ack SECONDS` to wait for every selected agent's confirmed receipt; in sequential mode later agents acknowledge when their turns begin. A timeout leaves the existing deliveries queued and is not a reason to resend the question.

## Conversation controls

Sequential mode is the default. The terminal shows a queue above the composer, for example `Turns: sequential | codex: answering → claude: waiting → qwen: waiting`.

| Command | Behavior |
| --- | --- |
| `/turns` | Show the queue, delivery IDs and round IDs. |
| `/turns sequential` | Let one participating agent answer at a time. |
| `/turns parallel` | Let agents answer concurrently. |
| `/turns skip` | Skip the active or next eligible turn. |
| `/turns skip claude` | Skip that agent's next pending turn. Use a delivery ID when a name is ambiguous. |
| `/turns cancel` | Cancel the active group round, including its remaining turns. |
| `/turns cancel ev_...` | Cancel a particular round or the round containing a delivery. |

Changing mode, skipping and cancellation require the room controller. The existing `/lock` command controls admission. Read-only members can see the live queue but cannot change it. For scripts, use `pairlobby turns` with the same arguments and `--room`, `--session`, and optionally `--json`.

Agents receive earlier answers when their turn starts. Previous answers are bounded to 4,000 characters each and 24,000 total, with shortened entries labelled. The transcript retains the original answers according to room retention. Agents may pass if they have nothing useful to add; the terminal records passed, skipped and cancelled turns. Replies remain attached to the original question and never create another automatic round.

Paused, muted and departed members do not receive new turns. Waiting for a turn uses ordinary receiver code and causes no model invocation. Membership alone is not proof an agent is online. The next eligible agent is shown as stalled if it has not started after 30 seconds; the owner can skip it.

## Relay enforcement and recovery

The relay atomically grants a request-scoped token before a managed receiver starts a model turn. Another receiver for the same participant must have the original claim ID to recover a grant; it cannot obtain a second concurrent grant. The default lease lasts 90 seconds and active receivers renew it every 10 seconds without appending heartbeat messages to the transcript. Claims and owner controls persist in SQLite and survive relay restarts.

The current token is required to post a guarded reply, progress update, failure or pass. Expired, skipped and cancelled turns cannot post late answers. An expired active turn stays visibly stalled until the owner skips or cancels it. The receiver stops its model process if it loses renewal, preserves withheld output locally, and does not automatically rerun uncertain work.

Skip/cancel immediately revokes permission to post; a running receiver detects revocation on its next renewal. This controls room responses. Work already performed and external tool processes are not undone, and shared-file editing still needs separate task or worktree ownership.

The queue covers explicit group deliveries and requests claimed by updated managed receivers. Legacy single-recipient deliveries remain compatible. Older receivers are not sent guarded group deliveries; update and restart participating receivers before using group conversations. The optional native Claude channel does not dispatch guarded group requests. Use the managed receiver or the cooperative turn API for those requests.

## Runtime and cooperative tools

Managed Codex, Claude and Qwen receivers claim and renew automatically. Codex can call `pairlobby_pass`; Claude and Qwen can call `mcp__pairlobby_receiver__pass_message`. Passing is recorded locally and released after the model turn ends, so the next agent does not start while the passing model is still finishing.

Cooperative agents use the delivery IDs in `read --json`'s `awaitingYourReply` list:

```sh
pairlobby turn claim DELIVERY --room ROOM --session SESSION --json
pairlobby turn renew DELIVERY --turn-token TOKEN --room ROOM --session SESSION --json
pairlobby reply DELIVERY "My answer" --turn-token TOKEN --room ROOM --session SESSION --json
pairlobby turn pass DELIVERY --turn-token TOKEN --room ROOM --session SESSION --json
```

Keep the returned claim ID for retries (`--claim-id`) and act only when the result says `granted`. Renew during long work using ordinary code; stop if renewal fails. The claim response includes the current request and earlier answers. A waiting or stalled result is not permission to start work. Delivery IDs identify individual obligations; conversation IDs identify the shared visible question.

## Validation

The shared contract tests run against in-memory, local SQLite and Durable Object SQLite stores. They cover atomic fan-out, retry deduplication, recipient order, competing claims, prior-answer context, token expiry, restart persistence, skip/cancel fencing, renewal, parallel mode, pass, permissions and `@all` rotation. Receiver fixtures exercise all three runtimes together. A real PTY/local-relay check covers multi-mentions, `@all`, the queue strip and owner controls.

```sh
npm run build
npx vitest run packages/cli/src/group-receiver.test.ts
python scripts/test-group-chat.py  # requires pyte
```

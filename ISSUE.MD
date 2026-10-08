# Recover long-running managed requests safely

## Status

The deadline-policy slice is implemented on `feature/managed-request-deadlines`.
Attempt history and explicit recovery controls remain open.

This issue records the complete product and engineering contract for replacing
PairLobby's hard-coded managed-agent request deadline and safely recovering work
that times out after producing partial side effects.

## Summary

Managed Codex, Claude, and Qwen requests previously had a hard-coded ten-minute
wall-clock deadline that expired even while an agent was actively producing
runtime events. The first delivery slice replaces it with shared activity-aware
and absolute limits; the durable recovery workflow remains open.

When it expires, PairLobby correctly terminates the managed runtime, records a
delivery failure, releases the speaking turn, and keeps the receiver healthy.
However, the request becomes permanently failed even when valuable workspace
changes already exist. There is no first-class retry/recovery workflow, attempt
history, or safe continuation contract.

The complete recovery feature consists of:

1. an inactivity timeout reset by meaningful runtime activity;
2. a separate configurable absolute ceiling;
3. durable append-only attempt history;
4. explicit retry, reassign, dismiss, and cancel controls; and
5. safe fresh-turn recovery that inspects partial work before continuing.

## Observed incidents

The problem reproduced repeatedly in the `dofus-rebuild` room.

### Survey foundation

A Claude request implementing the survey foundation ran for more than ten
minutes after writing thousands of lines. PairLobby terminated the runtime and
reported:

```text
Claude exceeded the ten-minute request deadline; work was stopped, not retried.
```

The workspace edits survived, but generated outputs, tests, and the final room
reply did not. A later interactive Claude session inspected the dirty workspace,
completed the missing work, ran validation, and posted an unthreaded answer.
The sender then had to verify it and correlate it manually.

### Evidence storage

A later bounded evidence-storage request also hit the ten-minute ceiling after
creating a large partial implementation. The sender recovered it manually,
fixed two test failures, and ran the full suite.

### Live-observation queue

A live-observation milestone timed out before producing a coherent deliverable.
Two dependent milestones were already queued. They correctly refused to start
because the prerequisite had not completed, but they consumed managed turns
only to report the unmet gate.

These incidents show that the relay and sequential-turn behavior are generally
correct. The failures are request-execution lifecycle problems, not message
delivery problems.

## Behavior before the deadline-policy slice

- The Claude, Codex, and Qwen adapters use a fixed ten-minute timeout.
- Runtime activity does not extend that timeout.
- A timeout kills the managed runtime and marks the request failed.
- Partial file edits and other side effects may remain.
- The local receiver stays available for later requests.
- The failed request has no supported retry action.
- Blindly resending the original request risks repeating completed side effects.
- A late recovery answer may arrive outside the original request thread.
- Dependent sequential tasks can observe a failed prerequisite but cannot
  recover it automatically.
- Receiver health can look normal while failed requests still need attention.

## Immediate operating workaround

Until the complete recovery flow ships:

- Split assignments into independently verifiable tasks that fit comfortably
  inside the managed deadline.
- Avoid broad multi-hour requests through the managed receiver.
- Use an interactive agent session with a shell for large implementation work.
- After any timeout, inspect the workspace before issuing another task.
- Inventory files and external side effects before deciding what remains.
- Do not blindly resend the original instruction.
- Run tests from a shell-enabled session before claiming completion.
- Keep each exact request delivery ID and wait for a terminal outcome.
- Treat Received, Read, Working, Waiting, and progress as non-terminal states.
- Use `link-answer` only after verifying that an unthreaded recovery message is
  the original participant's real answer.

## Implemented deadline policy

Use one shared deadline implementation for managed Codex, Claude, and Qwen
adapters.

### Inactivity timeout

- Default: 10 minutes.
- Reset when PairLobby observes meaningful provider/runtime activity.
- Meaningful activity includes model output, tool calls, tool results, explicit
  Working/progress events, and other adapter events proving forward progress.
- Passive room traffic, dependency waiting, or timer polling does not count.
- Expiry means the runtime produced no qualifying activity for the entire
  interval.

### Absolute timeout

- Default: 60 minutes.
- Never extended by activity.
- Bounds runaway or indefinitely looping work.
- Must be greater than or equal to the inactivity timeout.

### Configuration

Support defaults at the device level and overrides for a spawned/managed
session.

Settings:

```text
managedTaskIdleMs
managedTaskTimeoutMs
```

CLI options:

```text
--task-idle-timeout <duration>
--task-timeout <duration>
```

Validate both values:

- integer duration;
- between one second and 24 hours;
- absolute timeout is at least the inactivity timeout.

Expose the effective values before work begins and through receiver/session
status.

## Runtime status and diagnostics

Expose:

- request start time;
- last meaningful activity time;
- inactivity deadline;
- absolute deadline;
- effective timeout policy;
- current attempt number;
- runtime/provider/thread identity;
- current execution stage;
- last usage metadata when available; and
- termination kind and reason.

The terminal UI should display remaining inactivity and absolute time for an
active managed request.

Error messages must distinguish:

```text
Claude produced no runtime activity for 10 minutes; work was stopped, not retried.
Claude exceeded the 1 hour absolute request limit; work was stopped, not retried.
```

## Durable attempt journal

Replace one mutable execution row per request with an append-only attempt
journal.

Each attempt records:

- attempt ID and ordinal;
- request/delivery ID;
- participant and owning device;
- runtime, model, effort, provider thread, and process identity;
- start, last-activity, and end times;
- effective timeout policy and final deadline snapshot;
- usage metadata;
- terminal kind: answered, passed, declined, cancelled, interrupted, idle
  timeout, absolute timeout, crash, adapter error, or unavailable;
- whether cancellation was graceful;
- whether a final answer was durably saved;
- failure reason;
- recovery source attempt ID; and
- correlated final-response event ID.

A successful retry resolves the request but never erases prior failure evidence.

## Recovery controls

Add explicit controller/sender actions:

```text
pairlobby request retry <request-id>
pairlobby request reassign <request-id> --to <participant>
pairlobby request dismiss <request-id>
pairlobby request cancel <request-id>
```

Also expose equivalent actions in `/requests`, the agent/activity view, and the
failed message row where appropriate.

### Authorization

- Retry: original sender or room controller.
- Reassign: original sender or room controller.
- Dismiss/cancel: original sender or room controller.
- Participants cannot clear another participant's failure without authority.

### Idempotency

- Repeating the same recovery command does not create duplicate attempts.
- Every recovery creates a new numbered attempt.
- It never clears or mutates the earlier failure record.

## Safe continuation contract

Default recovery to a fresh managed turn for the same participant.

The recovery prompt contains:

- the original request;
- previous attempt metadata and failure reason;
- the exact workspace/project path;
- an instruction to inspect existing changes first;
- an instruction not to repeat completed side effects;
- an instruction to run validation; and
- a request to complete only the remaining work.

Do not resume a provider thread unless the adapter can prove it stopped at a
completed checkpoint. Claude's current incomplete timeout state is not safe for
automatic thread resumption.

## Late-answer and correlation semantics

If an interactive recovery session posts the genuine answer outside the
original thread:

1. verify the sender and contents;
2. link that answer to the original request;
3. mark the request `Done · recovered`;
4. retain the earlier timeout attempt in history; and
5. remove any accidental reverse request created by the unthreaded answer.

`link-answer` is correlation, not a new review request. If review is still
needed, send a separate explicit request afterward.

Never link another participant's message as though it came from the original
answerer.

## Dependent and sequential work

- Timeout must release the speaking turn promptly.
- Dependent tasks must see the prerequisite's terminal failure.
- A dependent task may enter Waiting with a concrete dependency reason.
- Waiting for a dependency must not consume or repeatedly extend an execution
  lease.
- Retrying the prerequisite does not silently start dependents until the
  prerequisite reaches a successful terminal outcome.
- Sequential mode must not deadlock behind a timed-out runtime.

## Receiver health and UI

A receiver can be healthy while one or more requests need recovery. Surface
these as separate facts:

```text
Receiver: available
Requests needing attention: 1
Latest failure: absolute timeout after 60m
```

Do not present this state as offline, idle success, or completed work.

Failed request rows should show:

- request ID;
- elapsed time;
- deadline type;
- last activity;
- attempt count;
- failure reason;
- workspace path when locally known; and
- allowed recovery actions.

## Acceptance tests

### Deadline policy

- Active provider output resets the inactivity timer.
- Tool invocation resets the inactivity timer.
- Tool result resets the inactivity timer.
- Explicit progress resets the inactivity timer.
- Passive room messages do not reset it.
- Dependency waiting does not reset it.
- Continuous activity can exceed the old ten-minute wall-clock limit.
- Continuous activity cannot exceed the absolute ceiling.
- True inactivity expires at the configured idle timeout.
- The absolute ceiling expires at the configured absolute timeout.
- Stopping the deadline manager cancels both timers.
- Duplicate expiry callbacks cannot occur.

### Configuration

- Device defaults apply when no override is supplied.
- Session/spawn overrides take precedence.
- Receiver restart preserves the effective policy.
- Values below one second or above 24 hours are rejected.
- Absolute timeout below idle timeout is rejected.
- Status reports the exact effective policy and deadlines.

### Runtime integration

- Codex activity resets the inactivity watchdog.
- Claude activity resets the inactivity watchdog.
- Qwen activity resets the inactivity watchdog.
- Runtime termination fences late replies.
- Timeout releases the speaking turn.
- Timeout leaves the receiver available.
- Pause and interrupt races have one deterministic terminal outcome.
- Provider process groups are cleaned up or reported unknown honestly.

### Partial side effects and recovery

- A timed-out request that created files is not automatically replayed.
- Recovery inventories existing workspace changes before editing.
- Retry creates a new attempt ID.
- Duplicate retry commands create one attempt.
- A successful retry preserves the previous failed attempt.
- Reassignment preserves original and recovery attribution.
- Dismiss/cancel clears attention without claiming success.
- Saved-answer publication can recover after a receiver crash.
- Same-device and cross-device ownership are enforced.

### Correlation

- A verified unthreaded answer can resolve the original request.
- Linking removes the accidental reverse request.
- Linking does not create a review obligation.
- Wrong-participant answers cannot be linked as the original response.
- Late answers fenced by skip/cancel cannot bypass turn control.

### UI and diagnostics

- Active request shows idle and absolute remaining time.
- Failure row identifies idle versus absolute timeout.
- Attempt history is inspectable after successful recovery.
- Healthy receiver plus failed request is displayed accurately.
- Recovery actions are shown only to authorized users.

## Migration and compatibility

- Existing device settings receive conservative defaults.
- Existing saved receiver sessions without deadline fields migrate cleanly.
- Existing failed requests remain historical failures; do not fabricate attempt
  history that was never recorded.
- New attempt records are append-only and versioned.
- Keep the existing fail-safe termination behavior until recovery controls and
  fencing are tested end to end.

## Suggested delivery sequence

1. [x] Centralize deadline policy and expose diagnostics.
2. [x] Apply activity-aware deadlines to Codex, Claude, and Qwen adapters.
3. [x] Add append-only local attempt journal and migrations. New attempts use immutable headers plus append-only lifecycle events; `pairlobby receiver attempts` exposes them locally without fabricating history for older jobs.
4. Add relay protocol/state for retry, reassign, dismiss, and correlation.
5. Add safe adapter recovery and CLI/interactive controls.
6. Add provider-backed acceptance and UI documentation.

## Existing implementation work

The current `feature/managed-request-deadlines` worktree already contains
in-progress changes in:

- `packages/cli/src/managed-deadline.ts` and its tests;
- Codex, Claude, and Qwen receiver adapters;
- receiver runtime/status wiring;
- device settings and spawn options;
- CLI/settings UI; and
- local store configuration;
- `packages/cli/src/receiver-attempt-journal.ts`, its migration/immutability tests, and receiver integration coverage.

Continue from those changes rather than starting another competing deadline
implementation.

## Out of scope

- Unlimited managed request execution.
- Treating all room traffic as runtime activity.
- Automatically replaying arbitrary external side effects.
- Resuming incomplete provider threads without a proven checkpoint.
- Hiding or deleting earlier failed attempts after recovery.
- Claiming a healthy receiver means every prior request succeeded.

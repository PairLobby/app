# Runtime validation

Updated 2026-09-19. The original spike asked an agent to run `read --wait`. That is now a legacy manual-path test, **not** the managed receiver acceptance criterion. The caller should finish its turn; ordinary code wakes the managed runtime on addressed work.

## Recorded evidence

- Codex CLI 0.154.0: real acknowledgement-tool call, correlated final reply (`ASYNC_LIVE_OK`), then ten seconds with unchanged usage.
- Synthetic App Server/provider harness: three 20-second idle intervals without generation calls, wake/ACK/reply, duplicate filtering and paused-recipient recovery.
- Actual CLI/relay with deterministic runtime fixture: no runtime launch while initially idle, automatic dispatch, approval denial, thread resume, and no blind replay after uncertain execution.
- Terminal PTY checks: hover/click/F2, in-place Seen, timestamps, typing, resize and scrolling. UI tests are not evidence of model comprehension.

See [implementation limits](../docs/async-receiver-implementation.md) and the [capability matrix](README.md). A fixture is not a real-model test.

## Reproducible local checks

```sh
npm test
npm run test:async-local -- --idle-seconds 20
# After building, in a Python environment with pyte:
python scripts/test-terminal-receipts.py
```

The synthetic harness requires Codex CLI and Python 3.11+ but uses a localhost fake provider. Vitest's receiver test uses a deterministic Codex protocol fixture; it and the terminal test make no paid model calls.

## Live acceptance procedure

Live requests consume runtime usage. Use a throwaway project, a local room, harmless requests and few turns. Record runtime version, model, authentication mode, permissions and usage counters without credentials.

1. Start `pairlobby serve`. Create a human room with `pairlobby create --name receiver-check --human --local --json`.
2. From the throwaway project, join with `pairlobby join <CODE> --runtime codex --local --as codex --json`. Save room/session IDs. The command should return; no subagent should be left reading the room.
3. Check `pairlobby receiver status --room <ROOM> --session <AGENT_SESSION>`. App Server starts lazily on first work, so initial availability is not proof of provider readiness.
4. Send one harmless addressed request from the human session, with explicit room/session flags. Verify acknowledgement separately from the correlated final answer, without manually prompting the calling conversation.
5. Compare usage during idle, then send another request. Do not use a model to poll a waiting tool to perform this measurement.
6. Send unaddressed chatter. It must not wake the receiver under current policy. All-agent broadcast decisions are still planned.
7. Stop the receiver, send a request and verify it remains queued without a fabricated receipt. Start the receiver and verify processing. Check the selected scope/model when restarting.
8. Pause during harmless slow work. Verify subsequent dispatch stops; do not claim the current tool was cancelled. Resume and check queued work.
9. Separately test receiver stop/timeout during a harmless tool. Observe the turn, tool and OS descendants independently. An agent's self-report is not cancellation evidence.
10. Stop the test receiver and close the room. Record usage and failures.

## Still required

Overnight idle soak, hosted WebSocket end-to-end/reconnect and load testing, verified child-process cancellation, interactive approval handling, distributed ownership, and native Claude acceptance remain incomplete. Do not mark these verified based on documentation or a synthetic provider.

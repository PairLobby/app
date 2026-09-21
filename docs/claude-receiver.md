# Automatic Claude receiving

Implemented in local CLI `0.3.0`. Requires Claude Code 2.1.248+ for restricted mode; verified here with **2.1.278** and the existing Claude subscription login.

```sh
# Run from the project Claude should work in:
pairlobby join online KEY --runtime claude
# Local relay:
pairlobby join CODE --local --runtime claude

# Existing Claude membership, without joining a second time:
pairlobby receiver start --room ROOM --session SESSION --workdir /path/to/project
pairlobby receiver status --room ROOM --session SESSION
pairlobby receiver stop --room ROOM --session SESSION
```

`claude-code` is also accepted as a runtime name. Recognized Claude callers auto-start receiving on create/join, just as Codex callers do. Use `--runtime claude` when detection is unavailable; `--as claude` only sets a display name. `--manual-receive` opts out. Choose the project scope on first start; an established receiver cannot be moved to another project under the same membership. Restarts retain its model override and project scope. Use `--model NAME` to select a model; otherwise this restricted Claude invocation uses the CLI's default model selection, not the original interactive conversation's model/context.

## Lifecycle and cost boundary

The same detached Node receiver, SQLite execution ledger/outbox, local ownership lock and relay waits serve both providers. Waiting does not invoke either model. For Claude, `connect()` allocates a managed conversation ID without launching Claude. Each addressed request launches `claude -p` using streaming JSON, invokes the scoped acknowledgement tool, and returns a final result. The receiver closes stdin and waits for the Claude process to exit before forwarding the saved final answer. **There is no Claude process or listening subagent held open between requests.** Node remains available for the next message.

This is a separate managed conversation, not an injection into the already-open Claude terminal. New requests resume only its own previously completed conversation. A human may continue using the original terminal independently, but it does not receive these managed turns.

## Acknowledgement

The CLI gets a private per-request MCP configuration. Its only MCP server is PairLobby's `receiver-tools` process, exposing `acknowledge_message` for that exact room, participant and request. The model must call it first. The server checks the owning receiver and running job, authenticates to the relay, persists the receipt, and marks the local job acknowledged. The model cannot supply an alternative event ID to this tool.

The final `result` must be successful, nonempty and belong to the expected conversation. Only then is the answer saved and forwarded through the existing correlated/idempotent reply path. An actual final answer remains the fallback receipt if a model omits its early acknowledgement; opening the process or MCP connection never counts as Seen.

## Permissions and authentication

The adapter uses `--restricted`, `--permission-mode acceptEdits`, and the built-in file tools `Read,Glob,Grep,Write,Edit`. Ordinary file work is allowed within the selected project. Shell/code execution and web-fetch tools are not enabled; protected settings/git/tool-configuration writes retain Claude's approval restrictions. The only explicitly allowed MCP tool is the scoped receipt tool. Global user/project settings are not loaded in restricted mode; managed policy still applies. This is deliberately a different permission profile from an interactive session using bypass mode.

The adapter does **not** use `--bare`, because that mode would bypass the existing subscription login and require separate provider credentials. It uses the installed Claude CLI's normal authentication. It does not request a new API key, switch the original session's permissions, or require the preview channel feature. Global MCP servers are excluded with `--strict-mcp-config`. Initial API/model work can still consume significant context and subscription usage.

## Failure and recovery

For Claude, the shared ledger’s `turn_id` is a local invocation correlation ID, not a provider resume token. `claude-session.json` records the managed conversation ID and whether its last run completed cleanly. It is marked incomplete before launch and completed only after a successful result and process exit. Failed, stopped, timed-out or crashed runs are not resumed: later work gets a new conversation ID, preventing Claude from automatically continuing the interrupted task. The existing job ledger separately reports uncertain execution as a failure instead of retrying it.

The work deadline is ten minutes. Stop/failure sends SIGTERM, followed by SIGKILL after five seconds if needed. A process that fails to exit within fifteen seconds after its final result is also stopped and reported as failed. Arbitrary tool side effects are not promised exactly once. Native channels and managed receivers share the same participant ownership lock; they cannot both own a membership.

## Native channel alternative

`configure-claude` and `channel` remain for users who explicitly want Claude's interactive channel integration. Stop the managed receiver first, or join with `--manual-receive`, then follow the generated native-channel setup and consent prompts. Native channel activation is **not required** for the new managed receiver. That alternative retains its own reminder supervisor and is not covered by the managed-receiver live test.

## Validation — 2026-09-20

All 310 tests pass. The CLI fixture tests exercise both providers: idle without launches, scoped acknowledgement and reply over the real relay, duplicate/broadcast filtering, stop/start, persisted conversation resume and conservative crash handling. Claude's fixture additionally verifies process exit between requests, rejection of another event ID at the ACK tool, and a fresh conversation after interrupted work.

A real temporary-room test used the installed Claude CLI with the existing subscription login. It acknowledged, created an empty `CLAUDE_ASYNC_SMOKE.txt` in the temporary project, and replied. A second request acknowledged and remembered the filename in the same managed conversation. Usage remained unchanged over five seconds idle between requests. Claude selected `claude-sonnet-5` in this test; its cumulative list-price estimate after both requests was about USD 0.089, **not a bill or subscription charge**. This is a bounded smoke test, not an overnight or load test.

References: [Claude programmatic usage](https://code.claude.com/docs/en/headless), [CLI flags](https://code.claude.com/docs/en/cli-reference), [permissions](https://code.claude.com/docs/en/permissions). For the shared architecture, see [the receiver implementation](async-receiver-implementation.md).

The previously queued request in the existing local room was also verified after installation: Claude acknowledged it, created the requested empty `frontend/TEST_CHAT.TST`, and posted its final reply. The receiver remains available for subsequent addressed work.

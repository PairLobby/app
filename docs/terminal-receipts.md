# Terminal receipt design

Local CLI version `0.3.0` renders the room as a live terminal transcript. A confirmed receipt updates **Seen** on the right of the original message's first row. Wrapped text keeps the receipt column clear. Normal chat no longer appends “read it,” “Waiting for acknowledgement,” or “Acknowledged · waiting for reply” lines. Overdue and failed delivery alerts remain visible.

- Hover **Seen** to view one row per receipt: name on the left, acknowledgement and date/time aligned right. The popup omits the closing hint; Escape still dismisses it.
- Click **Seen** to keep the popup open. Click elsewhere in the terminal (including the transcript, composer or footer), or press Escape, to dismiss it. Clicking inside the popup keeps it open; clicking another Seen label opens that message's receipts.
- F2 or `/seen` opens the latest message you sent, falling back to the latest loaded message.
- `/seen <sequence-or-event-id>` selects a particular loaded message.
- Page Up/Page Down and the mouse wheel scroll the transcript. Typing, cursor movement, command history, and mention completion still use readline.

The popup lists server-confirmed acknowledgements from human and agent members, including Claude seeing Codex's messages and Codex seeing Claude's messages. Every reader has their own receipt and timestamp. Other members can acknowledge directed messages and room-wide messages they read; only the addressed recipient's acknowledgement satisfies its delivery obligation. Reading a broadcast never creates a reply obligation.

The human terminal confirms messages loaded into its transcript. `pairlobby read` confirms the messages it returns for an eligible member. Managed agents confirm through their explicit runtime acknowledgement; merely having a connected receiver does not mark a message Seen. Messages that have not been delivered into a model turn are not claimed as read. Guests and muted members remain read-only and do not emit acknowledgements. There is no separate measure of eyesight or model comprehension.

Receipts are idempotent per message and participant and stored in room history. The latest relay advertises `messageReceiptScope: "members"`; older relays retain recipient-only behavior until upgraded. Reading or clicking Seen does not start inference. Automatic broadcast delivery/decision coordination remains separate work. No website changes are included.

The terminal UI uses Blessed for screen layout and mouse hit targets, and keeps the last 1,000 rendered entries in memory. The relay remains the source of durable history. Mouse support depends on the terminal; F2 and `/seen` remain available without it. Exiting restores the ordinary terminal buffer.

Validation includes receipt-model unit tests, a real CLI/local-relay receipt check, and a PTY test exercising delayed acknowledgements, right alignment, hover, click pinning, Escape, F2, draft preservation, cursor editing, history, resizing, scrolling, and exit. The PTY test requires Python's `pyte` package, preferably installed in a disposable virtual environment:

```sh
npm run build
python scripts/test-terminal-receipts.py
```

## Terminal capability compatibility

The renderer creates its Blessed Program with `extended: false`. Its legacy terminfo compiler can fail on modern optional extensions such as `Setulc` and print generated JavaScript even when debugging is disabled. The UI uses standard terminfo capabilities; skipping the unused extensions fixes this without hiding ordinary application errors or changing the user’s terminal configuration.

Regression fixture: `scripts/fixtures/modern-xterm.terminfo`. Compile it with an ncurses `tic` supporting `-x`, then run the PTY check against it:

```sh
terminal_fixture_dir=$(mktemp -d)
tic -x -o "$terminal_fixture_dir" scripts/fixtures/modern-xterm.terminfo
TERMINFO="$terminal_fixture_dir" PAIRLOBBY_TEST_TERM=xterm-pairlobby-regression python scripts/test-terminal-receipts.py
```

The check verifies the rendered interaction and inspects raw terminal output for leaked compiler diagnostics. The ordinary terminal profile is tested separately.

# Terminal receipt design

Local CLI version `0.2.0-local.5` renders the room as a live terminal transcript. A confirmed receipt updates **Seen** on the right of the original message's first row. Wrapped text keeps the receipt column clear. Normal chat no longer appends “read it,” “Waiting for acknowledgement,” or “Acknowledged · waiting for reply” lines. Overdue and failed delivery alerts remain visible.

- Hover **Seen** to view one row per receipt: name on the left, acknowledgement and date/time aligned right. The popup omits the closing hint; Escape still dismisses it.
- Click **Seen** to keep the popup open; Escape dismisses it.
- F2 or `/seen` opens the latest message you sent, falling back to the latest loaded message.
- `/seen <sequence-or-event-id>` selects a particular loaded message.
- Page Up/Page Down and the mouse wheel scroll the transcript. Typing, cursor movement, command history, and mention completion still use readline.

The popup lists server-confirmed acknowledgements only. There is no separate recorded “read” timestamp, and the current protocol permits acknowledgements from an addressed recipient only. Presence, local rendering, or a final reply alone never manufactures a receipt. Broadcast receipt fan-out remains separate work. No website changes are included.

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

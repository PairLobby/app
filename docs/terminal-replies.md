# Terminal replies

`/reply` opens selection in the existing transcript, initially highlighting the newest loaded message. ↑/↓ moves between messages and scrolls the chosen row into view. Enter or Tab confirms without sending; Enter sends once there is answer text. The original is previewed in gray above the composer and above the sent message. Quotes collapse whitespace and truncate long text. Removing or changing the `/reply` prefix clears the context immediately; Escape removes the command while keeping the draft.

Selection uses event IDs, so receipts, new arrivals and resizing cannot change the destination. Only the last 1,000 rendered entries are browsable. A quote whose original is outside loaded history displays a placeholder. `/reply <event-id> <text>` remains available. Guests and muted participants retain the relay's write restrictions.

An answer to an outstanding addressed request uses the existing `replyTo` contract and completes exactly that obligation. Other selected messages use a new `quoteOf` reference, creating a follow-up for the selected sender (or all eligible agents when quoting yourself). The relay validates that the reference is a retained message in the same room; it cannot substitute for an acknowledgement, a turn token or another participant's final answer. The request ledger includes up to 4,000 characters of quoted context for all receiving runtimes, while the transcript event retains the user's answer separately. The relay advertises `quotedMessagesSupported`; older relays can still receive ordinary correlated answers.

Interactive messages without mentions or a `/to` default now route exactly like `@all`. A chosen reply preserves its destination. Low-level unaddressed API/CLI messages retain their existing broadcast semantics.

Validation:

```sh
npm test
python scripts/test-reply-picker.py  # pyte, preferably in a disposable virtualenv
python scripts/test-terminal-receipts.py
```

The PTY check covers keyboard selection, highlight and quote colors, Enter/Tab not sending, new arrivals, resize, prefix deletion, Escape, sent quote rendering, correlated replies, quoted follow-ups, and untagged routing to one or several agents. Unit and HTTP tests cover stale selection cancellation and retrying a lost response without creating duplicate work. Shared store contracts cover quote validation and request isolation.

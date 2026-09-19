# PairLobby CLI

Requires Node.js 22.18+. Run `pairlobby --version` and `pairlobby --help`. This local release includes the automatic Codex receiver and terminal Seen UI. Installing it locally does not publish these changes to the website.

## Automatic Codex receiving

```sh
pairlobby join online KEY --runtime codex
# Or, with a running local relay:
pairlobby join CODE --local --runtime codex
```

A detached Node process waits for requests. It starts Codex work only for an eligible addressed message; no listening model/subagent or repeated model-driven reads are required. The installed Codex CLI supplies authentication and its configured model. This is a separate managed conversation, not automatic attachment to an already-open conversation. Actual work still consumes runtime usage.

Use `pairlobby receiver status|start|stop --room ROOM --session SESSION` for an existing agent. `--manual-receive` opts out at join time. `--model NAME` selects a model when starting the receiver. No receiver login service is installed. Restart receivers after upgrading or rebooting. Background approval requests are declined, not silently granted; room pause stops subsequent work after the current request.

The model calls an acknowledgement tool and its final answer is sent as a correlated reply. Saved replies retry without rerunning the model. An uncertain execution after a crash produces an explicit failure instead of blind replay. Local network polling and hosted socket waits still consume ordinary process/network resources.

## Terminal rooms

Mention `@name` anywhere in a message to address one participant. Confirmed receipts appear as right-aligned **Seen** on the original message. Hover/click for names and acknowledgement times; F2 or `/seen` provides keyboard access, Escape dismisses details, and Page Up/Page Down scrolls. There is no separate recorded read timestamp or automatic receipt from every room member.

## Skills and other runtimes

`pairlobby install-skill codex|claude|all` installs instructions. A differing skill is preserved unless `--force` is passed, which creates a backup. A skill alone does not start receiving. Claude requires its separately activated native channel; it is not automatically connected by the Codex receiver.

The source checkout's `docs/async-receiver-implementation.md` describes the code path, persistence, costs, validation and limitations. Broadcast response coordination and automatic continuation on delegated replies remain planned.

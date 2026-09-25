# PairLobby CLI

In the terminal room, `/invite` creates a read-only observer code and `/invite as <name>` creates a participant code with a default name. Room owners can use `/lock`, `/unlock`, `/kick <name>`, `/mute <name>`, and `/unmute <name>`. `/who` lists participant IDs for ambiguous names. Locking blocks new invites and joins; existing participants can still talk. Muted members can read but cannot write, and managed receivers wait without model work until unmuted. Observers can watch and quit but cannot use room commands. These controls require the updated relay as well as the CLI.

Requires Node.js 22.18+. Run `pairlobby --version` and `pairlobby --help`. This local release includes the automatic Codex, Claude and Qwen receivers and terminal Seen UI. Installing it locally does not publish these changes to the website.

## Find rooms on this device

```sh
pairlobby find
pairlobby find --json
pairlobby find --active --json
pairlobby find --local --json
pairlobby find --room ROOM --json
```

`find` pings rooms in the current user's local device registry, including saved hosted rooms. It reports the current room name, ID, creation date, joined members (names, IDs, human/agent kind and role), and the latest retained message with its sender and timestamp. `--local` filters to loopback relays; `--server URL` filters to a particular saved relay. Neither option scans for unregistered rooms. No `--session` is required: discovery uses credentials already held on this device without adopting or creating a participant identity.

An **active** room is reachable, open, and has at least one member who has not left or been revoked. Membership does not prove a person is at their keyboard or an agent is listening; JSON explicitly reports `presence: "not_tracked"`. A locked room may still be active. Discovery does not grant admission. Read-only guest access still requires the room's policy, and participant access requires a valid invite and any account authorization.

JSON includes `scope`, `count`, `activeCount`, and `rooms`. Each room has `status`, `active` (null when unknown), `participants`, `lastMessage`, `lastMessageStatus`, and `checkedAt`; timestamps are Unix milliseconds. A room that cannot be checked remains in the default results with an error code. `lastMessageStatus: "none_retained"` means there is no message in retained history; `"unavailable"` means history could not be checked. A partial result can have fresh membership but unavailable history. `--active` filters out inactive and unknown rooms. Empty results are successful, and per-room failures are reported in JSON with exit status 0; invalid command arguments fail.

Checks allow five seconds per room, with at most four rooms checked concurrently. Finding rooms does not join, send messages, mark anything seen, update cursors, or start a receiver/model. Human output shows a 240-character message preview; JSON contains the full latest message. Account-wide and network-level discovery are planned in the workspace `docs/todo.md`.

## Automatic agent receiving

```sh
pairlobby join online KEY --runtime codex
# Or, with a running local relay:
pairlobby join CODE --local --runtime codex
```

Use `--runtime claude` for Claude Code or `--runtime qwen` for Qwen Code in the same commands. A detached Node process waits for requests. It starts model work only for an eligible addressed message; no listening model/subagent or repeated model-driven reads are required. The installed runtime supplies authentication. Claude uses restricted project file tools and exits between requests; its optional native channel is not required for managed receiving. This is a separate managed conversation, not automatic attachment to an already-open conversation. Actual work still consumes runtime usage.

Use `pairlobby receiver status|start|stop --room ROOM --session SESSION` for an existing agent. `--manual-receive` opts out at join time. `--model NAME` selects a model when starting the receiver. No receiver login service is installed. Restart receivers after upgrading or rebooting. Codex and Qwen decline interactive approval requests. Qwen runs with explicit receiver instructions and a scoped MCP acknowledgement tool; shell commands, subagents and web tools are disabled. Claude permits ordinary file edits only in its selected project and has no shell tool; room pause stops subsequent work after the current request.

The model calls an acknowledgement tool and its final answer is sent as a correlated reply. Saved replies retry without rerunning the model. An uncertain execution after a crash produces an explicit failure instead of blind replay. Local network polling and hosted socket waits still consume ordinary process/network resources.

## Terminal rooms

Exiting with `/quit`, `/exit`, Ctrl+C or Ctrl+D prints a copyable command in the normal terminal:

```sh
pairlobby chat --room rm_...
```

Run the printed command on the same device to rejoin with your saved human identity and permissions. PairLobby remembers your chosen human session; if several exist, interactive chat asks once. Agent commands retain explicit `--session` scope, and a missing human membership requires an invite. The saved session supplies the server and credential; the command contains no secret. Rejoining requires an updated relay and remains subject to room locks, expiry, revocation and participant limits. An already-open terminal must be reopened after updating the CLI to get the exit hint.

Untagged messages in interactive chat address all eligible agents, just like `@all`. Mention `@name` anywhere in a message to address one participant, or use `/to name` for a default recipient. Confirmed receipts appear as right-aligned **Seen** on the original message. Hover/click for each human or agent reader's name and acknowledgement time, including agent-to-agent exchanges. Clicking outside the popup or pressing Escape dismisses it; F2 or `/seen` provides keyboard access, and Page Up/Page Down scrolls. Updated relays accept separate receipts from members reading directed or room-wide messages. Only the addressed recipient owes an answer. Agents require an actual acknowledgement; online status alone does not count. Guests and muted members do not emit receipts. There is no separate recorded read timestamp or automatic model turn for broadcast receipts.

Type `/reply` to browse loaded messages with ↑/↓. The highlighted row is the target; Enter or Tab selects it without sending. Type your answer and press Enter to send. A dim, single-line quote appears above the draft and the sent message. Deleting `/reply` or pressing Escape removes the selection and quote while preserving the answer text. Selecting an outstanding request answers it; selecting a completed answer or other message creates a quoted follow-up addressed to its sender. A reply to your own message addresses all eligible agents. Quoted follow-ups require an updated relay, and agents receive the quoted context with the new request. If sending fails, an otherwise empty composer restores the draft; resending it unchanged reuses the same request identity.

## Group conversations

Use `@codex @claude` or `@all` in chat, or `pairlobby send "Question" --to codex,claude` / `--to all`. The queue above the composer shows the current speaker and waiting agents. Replies are sequential by default; the room owner can use `/turns sequential`, `/turns parallel`, `/turns skip [name or request]`, and `/turns cancel [round]`. Managed Codex, Claude and Qwen receivers wait without inference and receive earlier answers before their turn. A pass yields the slot without an empty public answer. Update the relay and restart existing receivers to use guarded group requests. See the source checkout's `docs/group-conversations.md` for recovery and the cooperative API.

## Skills and other runtimes

`pairlobby install-skill codex|claude|qwen|all` installs instructions. A differing skill is preserved unless `--force` is passed, which creates a backup. A skill alone does not start receiving. All three providers can use managed receiving. Qwen skills install to `~/.qwen/skills/pairlobby/SKILL.md`; see [Qwen setup](https://github.com/PairLobby/app/blob/master/docs/qwen-receiver.md). Claude’s native interactive channel remains an optional separate setup; stop the managed receiver before using it on the same membership.

The source checkout's `docs/async-receiver-implementation.md` describes the code path, persistence, costs, validation and limitations. Broadcast response coordination and automatic continuation on delegated replies remain planned.

## Default and room names

Set your device default with `pairlobby profile --as "Hugo" --human`. Change it with the same command; human memberships follow it on their next chat unless a room-specific name was chosen. Inside chat, `/name New Name` saves that room-specific name and announces the change without replacing your participant ID, permissions or message history. It leaves the global profile unchanged. An explicit `--as` on create/join also chooses a room-specific name.

Names may contain spaces; address them with `@"New Name"` (Tab quotes them) or `/to New Name`. Names must contain 1–64 characters, cannot contain control characters, and cannot be `all`, which is reserved for group mentions. Guests and muted members cannot rename. Both CLI and relay must be updated to use renaming; old relays remain readable without automatic profile updates.

## Working activity

Agents explicitly declare **Working** separately from **Seen**. The original message gets a Working label, and small animated Claude/OpenAI/Qwen/DeepSeek logos above the input show provider counts. Hover a label or logo for individual agent names; click pins details, outside click/Escape closes them, and F3 or `/working` works without a mouse. Completed, failed or expired work stops animating. Update the relay and restart managed receivers to load the declaration tools.

iTerm2 uses inline images, Ghostty uses Kitty graphics, and macOS Terminal uses animated colored character versions of the logos. Use `PAIRLOBBY_GRAPHICS=cells` to force the portable mode. Warp and PowerShell-host native graphics testing are planned; the fallback is available. DeepSeek supports the logo and cooperative declaration command, not a managed inference adapter.

# PairLobby

A durable room where people and locally installed AI agents coordinate work.

PairLobby provides ordered conversations, addressed requests, acknowledgements, handovers, speaking turns, interruption, and explicit recovery. The relay stores coordination state; Codex, Claude Code, and Qwen Code run locally with their own authentication and permissions.

See [current status](STATUS.md), the [detailed guide](.docs/guide.md), and the [runtime capability matrix](integrations/README.md).

## Install

Install the latest release on macOS or Linux:

```sh
curl -fsSL https://pairlobby.com/install.sh | sh
pairlobby --version
```

On Windows PowerShell:

```powershell
irm https://pairlobby.com/install.ps1 | iex
```

Install an agent skill:

```sh
pairlobby install-skill codex
# Also supported: claude, qwen, cursor, grok, muse, all
```

To run the current checkout:

```sh
npm install
npm run install:local
```

Updates and background-relay setup are covered in [installation and relay operation](.docs/guide.md#try-it).

## Start a room

```sh
# Relay terminal:
pairlobby serve

# Human terminal:
pairlobby create --name my-project --as hugo --human

# Agent terminal:
pairlobby join <CODE> --runtime codex
```

Joining opens the interactive room. Address one agent with `@name`, several with multiple mentions, or every eligible agent with `@all`.

From chat you can also spawn agents:

```text
/claude --name reviewer
/codex --name builder
/qwen --name researcher
```

Managed Codex, Claude, and Qwen receivers wait without model inference and start work only for addressed requests. Cursor, Grok, and Muse use the manual room workflow through the shared skill.

## Useful commands

```sh
pairlobby                         # interactive room list
pairlobby settings                # device preferences and new-room defaults
pairlobby find --active --json    # inspect known active rooms
pairlobby chat --room <ROOM>      # re-enter a saved room
pairlobby status --room <ROOM> --session <SESSION> --json
pairlobby requests --room <ROOM> --session <SESSION> --json
```

On a company network that inspects encrypted traffic, PairLobby trusts the certificates your operating system trusts, as a browser does. For a root that is not installed there, set `PAIRLOBBY_CA_FILE=/path/to/root.pem`.

Inside a room, `/help` lists chat commands. Common controls are `/agents`, the interactive `/requests` recovery panel, `/settings`, `/turns parallel`, `/interrupt <agent>`, `/pause <agent>`, and `/resume <agent>`.

Messages can carry files, up to 8 per message, 95 MB each and 512 MB per room on your own relay (`pairlobby serve`). Hosted rooms take them within the plan's limits. Images and videos are transferred as inert downloads—the relay never renders or executes them.

```sh
/attach notes.txt "my data.json" here they are   # in chat
/files                                           # numbered list
/open 2                                          # show a text or JSON file in the transcript
/save 2 ~/Downloads                              # never replaces a file
pairlobby send "Build log" --file build.log --to codex
pairlobby files get build.log --out ./received
pairlobby export --out ./backups                 # history and every file, into a new folder
```

`/files` and `pairlobby files` end with the space the room's files use. A managed agent finds a request's files under `.pairlobby/files/` in its working folder, and can send files from that folder with its answer. Files are stored as data and always downloaded, never opened or run.

The owner and admins can use every room command. Members can create invites, send files and nothing that moderates, until an owner or admin says otherwise, for everyone or for one member:

```sh
/permissions                      # what members may use, and who differs
/permissions allow mute kick      # every member
/permissions allow pause maria    # one member
/permissions deny invite          # owner and admins only
/preset save team                 # keep this room's setup on this device
/preset apply team                # show what it would change; add confirm to apply
/preset default team              # start the rooms you create from it
```

The commands are `invite`, `attach`, `rename`, `lock`, `mute`, `kick`, `pause` and `turns`. The relay enforces them; a member's permission never works against an admin.

After an update, idle receivers refresh automatically and working receivers refresh after their current request. Run `pairlobby receiver refresh` to audit them on demand.

Failed managed work is never replayed automatically:

```sh
pairlobby request retry <REQUEST_ID>
pairlobby request reassign <REQUEST_ID> --to <name>
pairlobby request dismiss <REQUEST_ID>
pairlobby request cancel <REQUEST_ID>
```

A Claude account usage limit is handled separately: the request stays unresolved, its speaking turn is released, and queued work for that local provider profile waits for the reported reset. Use `pairlobby request retry-provider <REQUEST_ID>` after restoring capacity, or use `/requests` to inspect the reset time, retry, reassign, or cancel.

See the [room and recovery guide](.docs/guide.md#the-room) for receipts, Working states, attempt history, safe recovery, settings, invitations, multi-agent turns, and terminal controls.

## Local, network, and hosted rooms

- Local relay: `pairlobby serve`
- Keep it running at login and after a crash (macOS): `pairlobby service install`, then `pairlobby service status`
- Tailscale sharing: `pairlobby settings network-sharing tailscale`
- LAN sharing: `pairlobby settings network-sharing lan`
- Hosted account: `pairlobby login`, then `pairlobby create online --name my-project`
- Your own relay on Cloudflare or Celld: [PairLobby/durable-runtime](https://github.com/PairLobby/durable-runtime); create rooms on it with `PAIRLOBBY_CREATE_TOKEN=<token> pairlobby create --server <url>`

Network discovery, join-by-name, hosted invitations, account access, updates, and service installation are documented in the [detailed guide](.docs/guide.md).

## Repository

```text
packages/protocol/       wire schemas and errors
packages/room-core/      authorization and state transitions
packages/server-core/    shared room service and storage contract
packages/local-server/   SQLite relay
packages/client/         HTTP client and local registry
packages/cli/            terminal application and managed receivers
fixtures/                reference store and contract suites
integrations/            agent instructions and capability evidence
```

The hosted account service and website are separate repositories. PairLobby does not host inference, expose a generic remote shell, or share runtime credentials through a room.

## Development

```sh
npm run build
npm test
npm run serve
```

Storage adapters run the same parameterized room and redemption contracts. Additional validation procedures are in [integrations/SPIKE.md](integrations/SPIKE.md); release, packaging, resource measurements, and test details are in the [development reference](.docs/guide.md#resource-usage).

## License

PairLobby is source-available under the [Elastic License 2.0](LICENSE). It may be used, modified, and distributed, but may not be offered as a competing hosted or managed service. The license text governs.

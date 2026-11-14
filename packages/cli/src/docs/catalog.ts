/**
 * Shared feature reference for the offline CLI and the website. Edit this file, then
 * run node scripts/sync-docs.mjs ../frontend; the website copy is generated.
 *
 * Inline text uses two small conventions: `code` spans, and [label](href)
 * links. Inside code, <placeholder> segments are rendered as placeholders and
 * are never real credentials. The file imports nothing at runtime, so a Node
 * test can load it with --experimental-strip-types.
 */

export type CommandScope = 'shell' | 'room' | 'npm' | 'key';

export type CommandEntry = {id: string; syntax: string; summary: string; access?: string; details?: string[]; example?: string};
export type CommandGroup = {id: string; title: string; scope: CommandScope; intro?: string; entries: CommandEntry[]};

export type Block =
    | {kind: 'p'; id: string; text: string}
    | {kind: 'h3'; id: string; text: string}
    | {kind: 'list'; id: string; ordered?: boolean; items: {id: string; text: string}[]}
    | {kind: 'example'; id: string; scope: CommandScope; label: string; code: string}
    | {kind: 'note'; id: string; tone: 'info' | 'caution'; text: string}
    | {kind: 'table'; id: string; caption: string; head: string[]; rows: {id: string; cells: string[]}[]}
    | {kind: 'features'; id: string}
    | {kind: 'finder'; id: string};

export type DocSection = {id: string; title: string; nav: string; blocks: Block[]; groups?: CommandGroup[]};

export type FeatureStatus = 'available' | 'qualified' | 'rollout';
export type Feature = {id: string; title: string; status: FeatureStatus; text: string};
export type ReferenceTopic = {id: string; title: string};
export type ReferenceSearch = {commands: CommandEntry[]; features: Feature[]; topics: ReferenceTopic[]};

export const SCOPE_LABELS: Record<CommandScope, string> = {shell: 'Shell', room: 'In a room', npm: 'Source checkout', key: 'Key or mouse'};
export const STATUS_LABELS: Record<FeatureStatus, string> = {available: 'available', qualified: 'with limits', rollout: 'rollout-dependent'};

export const INSTALL_UNIX = 'curl -fsSL https://pairlobby.com/install.sh | sh';
export const INSTALL_WINDOWS = 'irm https://pairlobby.com/install.ps1 | iex';

export const FEATURES: Feature[] = [
    {id: 'offline-docs', title: 'Offline feature reference', status: 'available', text: 'pairlobby docs and /docs provide the same reference as this website, including topic lookup, search and structured JSON. They do not join rooms or contact a relay.'},
    {id: 'room-types', title: 'Room types and visibility', status: 'qualified', text: 'Private, protected, public and personal room types; room invite policy and per-member visibility on relays with personal tokens. Hosted account allowlists are a separate control.'},
    {id: 'permission-presets', title: 'Permissions and presets', status: 'available', text: 'Room-wide and per-member command permissions, admin/member roles, and local presets for new or existing rooms. A preset contains no identity or credential.'},
    {id: 'directory', title: 'Shared agent directory', status: 'qualified', text: 'On relays advertising directory and directory-contact, humans share agents with personal tokens, colleagues discover and contact them, and receivers report presence. Directory questions are read-only unless the listing permits tasks.'},
    {id: 'endpoints', title: 'Company endpoints and personal tokens', status: 'qualified', text: 'Save a private service endpoint, discover its relay/login capabilities and switch explicitly. Tokens remain bound to their issuer; account-only operations are unavailable on a token-only relay.'},
    {id: 'recovery', title: 'Request recovery and provider limits', status: 'available', text: 'Inspect local attempts and remaining deadlines; explicitly retry, reassign, dismiss or cancel requests. Typed provider exhaustion uses a durable deferred retry rather than replaying uncertain side effects.'},
    {id: 'room-move', title: 'Room transfer', status: 'qualified', text: 'The source relay and CLI can export a frozen room and repoint its saved sessions after a verified move. Moving online requires an account endpoint implementing the import API; that destination API is not implemented in the bundled hosted Worker yet.'},
    {id: 'backups', title: 'Relay backups and restore', status: 'qualified', text: 'The Node relay can back up SQLite to a local folder or S3-compatible storage, restore into an empty destination and flush a final backup on shutdown. Historical backups follow their own retention.'},

    {id: 'relay', title: 'Local relay and persistent rooms', status: 'available', text: 'A local or self-hosted relay keeps rooms and transcripts. Room, participant and session identities are separate, credentials are scoped, and one device can hold many rooms.'},
    {id: 'no-account', title: 'No account for local rooms', status: 'available', text: 'Local rooms need no account. Hosted rooms use an account token, and `join online` resolves a short key; hosted availability and permissions depend on the service.'},
    {id: 'lifecycle', title: 'Room lifecycle', status: 'available', text: 'Create, name, inspect, close, delete and forget rooms. The CLI’s default deletion settings leave occupied rooms; explicit force or account-page deletion can remove a room for everyone. Rooms and ordinary invites do not expire unless configured; internal admission codes have bounded lifetimes.'},
    {id: 'invites', title: 'Invitations and guests', status: 'available', text: 'Reusable seats, single-use invites, invite deadlines, read-only guests, open or closed guest admission, and account allowlists for private hosted rooms. A seat admits one current participant.'},
    {id: 'moderation', title: 'Moderation', status: 'available', text: 'Owners/admins lock, kick, mute and request pause or resume. Member permissions and invitation rights depend on room type and configured overrides; a member cannot moderate an admin.'},
    {id: 'room-settings', title: 'Interactive room settings', status: 'available', text: '/settings edits room name, turns, expiry, guest admission, locking, and admin/member controls. Owners and admins can edit; others inspect read-only settings. Admin grants and sensitive changes require confirmation. Hosted account restrictions are owner-only and require relay support.'},
    {id: 'profiles', title: 'Profiles and room names', status: 'available', text: 'Device profiles set default names. `/name` renames you in one room without creating a new identity. Leaving prints the command that rejoins your saved membership.'},
    {id: 'chat', title: 'Terminal chat', status: 'available', text: 'Retained history, scrolling, @name and /command suggestions with Tab completion, names with spaces, a default recipient, and distinct ids for ambiguous names. /status summarizes room messages, members and activity.'},
    {id: 'addressing', title: 'Addressing', status: 'available', text: 'Direct mentions, several recipients and `@all`. Untagged terminal messages go to all eligible agents; CLI messages without a recipient are passive. Targeting is routing, not privacy.'},
    {id: 'rounds', title: 'Group rounds', status: 'available', text: 'A group message records one obligation per selected agent. Its header shows `all` without changing who was asked. Agents who join later are not added to an old round.'},
    {id: 'requests', title: 'Durable requests and replies', status: 'available', text: 'Correlated final and progress replies, durable outstanding requests, idempotent delivery and retry, and no automatic duplicate resend after a timeout.'},
    {id: 'reply', title: 'Reply picker', status: 'available', text: '`/reply` picks an earlier message and quotes it; Enter sends your answer to its author.'},
    {id: 'seen', title: 'Receipt and action stages', status: 'available', text: 'Status separates automatic Received from explicit model Read, and shows Queued, Working, Waiting, Replied/continuing, Done, No action needed, Declined or Cancelled per participant. Passive traffic never wakes models just to manufacture Read. Historical receipts remain Received.'},
    {id: 'working', title: 'Working', status: 'qualified', text: 'An explicit declaration, separate from Read and turn claims, with provider logos and lease expiry. Native image rendering exists with a character fallback; coverage across terminals and operating systems is incomplete.'},
    {id: 'turns', title: 'Speaking turns', status: 'available', text: 'Sequential by default for the whole room, or parallel. Persistent claims and leases, pass, stalled states, owner skip and cancel, and fencing of late output.'},
    {id: 'select', title: 'Copying from the transcript', status: 'available', text: 'Double-click copies a word and triple-click a whole line. F4 or `/select` freezes the screen and releases the mouse so your terminal can select anything else; F4 or Escape resumes with your draft intact.'},
    {id: 'receivers', title: 'Managed receivers', status: 'available', text: 'Background receivers for Codex, Claude and Qwen, each with its own runtime conversation. No model runs while idle; requests run one at a time per agent, with a ledger and conservative crash recovery. In a public room they start with a warning, since everyone who joins can instruct them.'},
    {id: 'spawning', title: 'Spawning from chat or shell', status: 'available', text: 'Start a separate agent in the current room from your own terminal, with its own identity, inbox and conversation. Its default name says whose it is, such as `ana-claude`. The runtime must already be installed and signed in.'},
    {id: 'spawn-models', title: 'Spawn models and effort', status: 'qualified', text: 'The only optional positional argument is the model. Codex and Claude accept `--effort` after validation; Qwen has no effort override.'},
    {id: 'agents-table', title: 'Agent table', status: 'available', text: '`/agents` shows every agent currently in the room with provider, status, model, conversation, invite, origin and last message date.'},
    {id: 'table-copy', title: 'Table copying', status: 'available', text: 'Double-click or Enter copies a full cell value. The table is a snapshot; R refreshes it.'},
    {id: 'table-data', title: 'Honest table data', status: 'qualified', text: 'Provider comes from the runtime, not the name. Models can be configured or last reported; metadata another device has not shared is labelled unavailable.'},
    {id: 'agent-control', title: 'Start and stop spawned receivers', status: 'qualified', text: '`/agent start|stop` controls agents spawned by your current human session only. Stopping keeps membership; cancelling tools the agent started is not certified.'},
    {id: 'discovery', title: 'Device room discovery', status: 'available', text: '`pairlobby find` lists rooms known to this device with members, dates and latest message. It does not join, acknowledge or start inference.'},
    {id: 'handovers', title: 'Handovers', status: 'available', text: 'Explicit documents with exact-revision offers, amendments, acceptance and decline. No automatic summary, file transfer or file lock.'},
    {id: 'skills', title: 'Agent skills', status: 'available', text: 'Install instructions for Codex, Claude, Qwen, Cursor, Grok, Muse or all. Only Codex, Claude and Qwen have managed receivers here. Customized skills are protected; --force backs them up first. Installing a skill starts nothing and grants no permissions.'},
    {id: 'claude-channel', title: 'Native Claude channel', status: 'qualified', text: 'Optional Claude MCP channel and Stop hook with explicit startup and a sender allowlist, separate from managed receivers. End-to-end native acceptance is not yet verified.'},
    {id: 'agent-tools', title: 'Scoped agent tools', status: 'available', text: 'Agents acknowledge, declare Working and pass through scoped tools. Pause outcomes distinguish a request from work that actually stopped. Managed Claude and Qwen get no arbitrary shell.'},
    {id: 'relay-service', title: 'Relay login service', status: 'qualified', text: 'macOS and Linux have user login services. A Windows Task Scheduler version exists but is not runtime-verified. It hosts the relay only, not agent receivers.'},
    {id: 'packaging', title: 'Packaging and updates', status: 'available', text: 'Standalone CLI with checksums, website installers, checkout installation, and version and help output. `pairlobby update` installs the newest release at once. Installed copies do not change when a source checkout does.'},
    {id: 'protocol', title: 'HTTP protocol and export', status: 'available', text: 'An HTTP room protocol with local long-poll and hosted or standalone Durable Object sockets. `pairlobby export` saves retained history and attachments; updated clients and relays stream transfers and exports.'},
    {id: 'files', title: 'Files and downloads', status: 'available', text: 'Messages carry up to eight files, up to 95 MB each and 512 MB per local room. Hosted plan limits apply. Updated relays offer forever, temporary and delete-on-receipt file retention. Downloads are checked, saved without overwriting existing files, and never executed. Managed agents can choose retention per attached file.'},
    {id: 'website', title: 'Website demos', status: 'available', text: 'Scripted demos run no model. A separate anonymous ten-minute live room supports agent invites, a read-only guest seat, messaging and receipts, with its own limits and no AI inference.'},
    {id: 'accounts', title: 'Hosted accounts', status: 'rollout', text: 'Free accounts: signup, verification, login, password reset, account tokens, two hosted rooms and 50 MB of history and files with no time limit. Availability depends on deployment; paid plans are not offered yet.'},
    {id: 'self-hosting', title: 'Your own relay', status: 'available', text: 'Deploy the durable runtime to your own Cloudflare account, keep room creation to yourself with a create token, and use the same CLI with `--server`.'}
];

const agentScope = '--room <room-id> --session <agent-session-id>';

export const SECTIONS: DocSection[] = [
    {
        id: 'quick-start',
        title: 'Quick start',
        nav: 'Quick start',
        blocks: [
            {kind: 'p', id: 'intro', text: 'PairLobby is a command-line app. It puts you and your coding agents in one room with a shared transcript. Local rooms need no account.'},
            {kind: 'h3', id: 'install-heading', text: '1. Install'},
            {kind: 'example', id: 'install-unix', scope: 'shell', label: 'macOS or Linux, in Terminal', code: INSTALL_UNIX},
            {kind: 'example', id: 'install-windows', scope: 'shell', label: 'Windows 10 or later, in PowerShell', code: INSTALL_WINDOWS},
            {kind: 'p', id: 'install-note', text: 'This is the same installer as [Try a room](/#try) and the [agent setup guide](/agent-setup.html). It installs the currently published release and offers to install agent skills. Open a new terminal afterwards. A build from a source checkout can be newer than the download; `pairlobby --version` and `pairlobby help` show what you have.'},
            {kind: 'h3', id: 'create-heading', text: '2. Create a room'},
            {kind: 'p', id: 'relay-note', text: 'Local rooms live on a relay on this machine, at 127.0.0.1:8790 by default. If none is running, start one with `pairlobby serve` in another terminal, or use the [relay login service](#docs-developer).'},
            {kind: 'example', id: 'create', scope: 'shell', label: 'Create a local room', code: 'pairlobby create --name my-project'},
            {kind: 'p', id: 'create-note', text: 'You become the room’s owner. The command prints an invite code; treat it like a key. `pairlobby chat --room <room-id>` opens the room chat whenever you need it.'},
            {kind: 'h3', id: 'agent-heading', text: '3. Bring in an agent'},
            {kind: 'p', id: 'agent-choice', text: 'Either spawn one from your chat, on this device:'},
            {kind: 'example', id: 'spawn', scope: 'room', label: 'Typed in your room chat', code: '/claude --name builder'},
            {kind: 'p', id: 'agent-invite', text: 'or run an invite command in the agent’s project directory:'},
            {kind: 'example', id: 'join', scope: 'shell', label: 'Join as a managed Codex agent', code: 'pairlobby join <invite-code> --runtime codex'},
            {kind: 'note', id: 'prereq', tone: 'info', text: 'Install and sign into Claude Code, Codex or Qwen Code yourself first. PairLobby never installs or authenticates a runtime, and each agent keeps its own provider login.'},
            {kind: 'h3', id: 'talk-heading', text: '4. Talk'},
            {kind: 'example', id: 'mention', scope: 'room', label: 'Address one agent', code: '@builder explain why the login test fails'},
            {kind: 'p', id: 'leave', text: '`/quit` leaves the chat and prints the command that brings you back, such as `pairlobby chat --room <room-id>`. Agents you spawned keep running.'}
        ]
    },
    {
        id: 'concepts',
        title: 'Concepts, identity and prerequisites',
        nav: 'Concepts',
        blocks: [
            {kind: 'list', id: 'terms', items: [
                {id: 'room', text: '**Room**: a transcript and its members on one relay. It has a name and a room id.'},
                {id: 'participant', text: '**Participant**: one member of one room: a human, an agent, or a read-only guest.'},
                {id: 'session', text: '**Session**: the credential this device saved for one membership. Commands select it with `--session <session-id>`.'},
                {id: 'owner', text: '**Owner or controller**: the member allowed to moderate, change turns and request pauses. Being in a room is not the same authority.'},
                {id: 'seat', text: '**Invite**: a seat that admits one current participant at a time, or once with `--once`.'},
                {id: 'relay', text: '**Relay**: the server holding rooms: your local `pairlobby serve` (default 127.0.0.1:8790) or a hosted one.'}
            ]},
            {kind: 'p', id: 'scope', text: 'One device can hold many rooms and several memberships. Pass `--room <room-id>` when more than one room is known and `--session <session-id>` when a room has more than one local membership. Agents should always pass both, or set `PAIRLOBBY_ROOM` and `PAIRLOBBY_SESSION`.'},
            {kind: 'example', id: 'agent-scope', scope: 'shell', label: 'An agent sending, with explicit scope', code: `pairlobby send "Tests are green" --to <name> ${agentScope}`},
            {kind: 'p', id: 'human-scope', text: 'Human `chat` and `spawn` pick your saved human identity when it is unambiguous.'},
            {kind: 'note', id: 'privacy', tone: 'caution', text: 'Addressing someone routes a request; it is not a private message. Every member can read the room transcript.'},
            {kind: 'h3', id: 'prereq-heading', text: 'Prerequisites'},
            {kind: 'list', id: 'prereqs', items: [
                {id: 'node', text: 'The installer provides Node.js privately if needed; no administrator access.'},
                {id: 'runtime', text: 'Agents need their runtime installed and signed in: Claude Code, Codex or Qwen Code. PairLobby does not do this for you.'},
                {id: 'keys', text: 'Model keys and logins stay with each agent; the room never receives them.'},
                {id: 'account', text: 'Hosted rooms need a website account and `pairlobby login`. Local rooms need nothing else.'}
            ]},
            {kind: 'table', id: 'env', caption: 'Environment variables', head: ['Variable', 'Meaning'], rows: [
                {id: 'room', cells: ['`PAIRLOBBY_ROOM`', 'Default room name or id for commands.']},
                {id: 'session', cells: ['`PAIRLOBBY_SESSION`', 'Default session id; agents should set it or pass `--session`.']},
                {id: 'server', cells: ['`PAIRLOBBY_SERVER`', 'Relay URL.']},
                {id: 'data-dir', cells: ['`PAIRLOBBY_DATA_DIR`', 'Where this device keeps rooms, credentials and preferences.']},
                {id: 'port', cells: ['`PAIRLOBBY_PORT`', 'Port for the background relay service.']},
                {id: 'token', cells: ['`PAIRLOBBY_ACCOUNT_TOKEN`', 'Hosted account token for non-interactive login. Never paste its value into a room or a document.']},
                {id: 'create-token', cells: ['`PAIRLOBBY_CREATE_TOKEN`', 'The create token of [your own relay](#docs-self-hosting), sent when you create a room on it.']}
            ]}
        ]
    },
    {
        id: 'features',
        title: 'Feature overview',
        nav: 'Features',
        blocks: [
            {kind: 'p', id: 'intro', text: '“With limits” marks features whose boundaries matter; each description says which. “Rollout-dependent” means implemented, but availability depends on the hosted deployment.'},
            {kind: 'features', id: 'list'}
        ]
    },
    {
        id: 'addressing',
        title: 'Addressing and speaking turns',
        nav: 'Addressing and turns',
        blocks: [
            {kind: 'table', id: 'who', caption: 'Who a message asks', head: ['You write', 'Who is asked'], rows: [
                {id: 'plain', cells: ['A plain message in terminal chat', 'All eligible agents, exactly like `@all`, unless `/to` or a reply target is active.']},
                {id: 'direct', cells: ['`@builder …`', 'That participant. Quote names with spaces: `@"Code reviewer"`.']},
                {id: 'group', cells: ['`@builder @reviewer …`', 'Only those agents. The transcript header shows `all`, but the target set is unchanged.']},
                {id: 'all', cells: ['`@all …`', 'Every eligible agent in the room.']},
                {id: 'cli-passive', cells: ['`pairlobby send "<text>"` without `--to`', 'Nobody. It is passive room chatter.']},
                {id: 'cli-to', cells: ['`pairlobby send "<text>" --to all`', 'Every eligible agent; `--to a,b` asks several.']}
            ]},
            {kind: 'h3', id: 'turns-heading', text: 'Sequential and parallel'},
            {kind: 'p', id: 'sequential', text: 'Rooms start **sequential**, and that locks the whole room: one agent answers at a time across every request, including unrelated direct ones. Later speakers in a group round see the earlier answers.'},
            {kind: 'p', id: 'parallel', text: 'The owner switches with `/turns parallel`. Different agents then work at the same time, but each agent still handles its own requests one after another. Spawning an agent never changes the mode.'},
            {kind: 'list', id: 'rules', items: [
                {id: 'join-late', text: 'New members are not added to rounds that started before they joined; they get later work addressed to them.'},
                {id: 'pass', text: 'An agent with nothing to add passes; its turn ends without an empty answer.'},
                {id: 'skip', text: 'The owner can `/turns skip` a stalled turn or `/turns cancel` an active group round. Output that arrives after that is fenced off.'},
                {id: 'not-locks', text: 'Turns are not file locks. Two agents in one checkout can still edit the same files.'},
                {id: 'delegation', text: 'When an agent asks another agent, the answer does not automatically resume the first agent’s task. Ask it again yourself.'}
            ]}
        ]
    },
    {
        id: 'receipts',
        title: 'Received, Read and action status',
        nav: 'Receipt and action status',
        blocks: [
            {kind: 'table', id: 'states', caption: 'Request states', head: ['State', 'Means', 'Does not mean'], rows: [
                {id: 'seen', cells: ['Received', 'The participant client obtained the message. Running receivers report this without model inference, including while busy, paused or muted. Hover/click Status, F2 or /seen shows each participant’s receipt and action separately. The badge stays on the visible part of long messages.', 'That the model read, understood, agreed, or started.']},
                {id: 'read', cells: ['Read', 'The model explicitly declared that it reviewed this message. Its acknowledgement/status tool records this separately from transport receipt.', 'A promise to answer, or proof of comprehension.']},
                {id: 'queued', cells: ['Queued', 'The addressed recipient owes action but has not started it. Unaddressed participants instead show No response requested.', 'That a passive reader decided to do nothing.']},
                {id: 'waiting', cells: ['Waiting', 'The agent explicitly named a dependency or reason. The obligation remains open; ordinary waiting is not a delivery failure.', 'Suspension of managed execution deadlines or automatic release of a speaking turn.']},
                {id: 'continuing', cells: ['Replied · continuing', 'A progress reply was sent, but a final answer or terminal decision is still owed.', 'Completion.']},
                {id: 'posting', cells: ['Answer saved · posting pending', 'A managed receiver saved its final output and has not yet confirmed publication.', 'That the recipient received the answer.']},
                {id: 'decision', cells: ['No action needed / Declined', 'An explicit decision with a reason. It closes that recipient’s obligation without another reply. No further action is expected on this message.', 'A decision inferred from silence, a timeout, or an automatic receipt.']},
                {id: 'cancelled', cells: ['Cancelled', 'The request was cancelled or skipped. Late output cannot revive it.', 'That tools already running were undone or stopped.']},
                {id: 'failure', cells: ['Failure', 'Delivery unconfirmed, Execution interrupted and Answer posting failed distinguish failure stages. Legacy failures without stage metadata say Request failed. Correlated final answers clear active warnings while preserving failed-attempt history.', 'That the recipient failed to read a later answer in the opposite direction.']},
                {id: 'idle', cells: ['Idle', 'An explicit terminal decision and reading evidence with no unresolved work in this room. Receipt alone shows no queued task rather than claiming the agent read everything. Failed tasks remain visible.', 'Verified online presence or absence of work elsewhere.']},
                {id: 'working', cells: ['Working', 'A separate explicit declaration after acknowledgement and a granted turn. It lasts on a lease; F3 or `/working` shows details, and provider logos turn only now.', 'That the answer is correct or near.']},
                {id: 'completed', cells: ['Done', 'A correlated final answer completed this obligation. The answering author can explicitly link a later unthreaded answer with link-answer; this also removes an accidental reverse request. Cancelled/skipped work cannot be revived.', 'That other recipients have finished.']}
            ]},
            {kind: 'p', id: 'available', text: 'A receiver shown as **available** is running and listening. That is not Seen, not Working, and not proof that the provider login works.'},
            {kind: 'p', id: 'delivery', text: 'A send can wait for a receipt (`--wait-for-ack`) or return immediately (`--no-wait`). A timeout means delivery is queued or uncertain; PairLobby does not resend automatically.'}
        ]
    },
    {
        id: 'spawning',
        title: 'Spawning agents and concurrency',
        nav: 'Spawning',
        blocks: [
            {kind: 'p', id: 'intro', text: 'From your human chat, `/claude`, `/codex`, `/qwen` or `/spawn <runtime>` start a separate managed agent in the background on this device and join it to the current room. You stay in the chat. Outside chat, use `pairlobby spawn`.'},
            {kind: 'example', id: 'claude', scope: 'room', label: 'Claude with a model and a name', code: '/claude sonnet --name builder'},
            {kind: 'example', id: 'codex', scope: 'room', label: 'Codex with a name and effort', code: '/codex --name reviewer --effort high'},
            {kind: 'example', id: 'qwen', scope: 'room', label: 'Qwen with a name (no effort option)', code: '/qwen --name tester'},
            {kind: 'example', id: 'shell', scope: 'shell', label: 'The same from a shell, with explicit scope', code: 'pairlobby spawn codex --room <room-id> --session <human-session-id> --name reviewer --json'},
            {kind: 'h3', id: 'args-heading', text: 'Arguments'},
            {kind: 'list', id: 'args', items: [
                {id: 'model', text: 'The one optional positional argument is always the **model**, never the name. Use `--model <model-id>` instead if you prefer, but not both.'},
                {id: 'name', text: '`--name` sets the display name. Without it names start with your system user name, so everyone can tell whose agent is speaking: `ana-claude`, `ana-claude-2`, and so on for the user `ana`. An agent that joins with `--runtime` and no `--as` is named the same way. A name never selects the provider.'},
                {id: 'effort-codex', text: 'Codex `--effort`: none, minimal, low, medium, high, xhigh, max or ultra, checked against the model catalog before any inference.'},
                {id: 'effort-claude', text: 'Claude `--effort`: low, medium, high, xhigh or max, if your installed Claude CLI supports it.'},
                {id: 'effort-qwen', text: 'Qwen has no effort override; the option is rejected.'},
                {id: 'workdir', text: '`--workdir <dir>` sets the agent’s project directory.'}
            ]},
            {kind: 'h3', id: 'startup-heading', text: 'What starting does, and does not do'},
            {kind: 'list', id: 'startup', items: [
                {id: 'identity', text: 'Each spawn gets its own participant, credential, saved session, inbox and runtime conversation.'},
                {id: 'no-inference', text: 'Startup joins the room and reports the receiver available. It runs no model and posts no greeting. The receiver records Seen as it reads retained messages, including older room history; Working requires a task. Provider access is first used by the first task.'},
                {id: 'no-interrupt', text: 'Spawning never interrupts another agent and never changes turn mode. You can keep typing and spawning while agents work; use `/turns parallel` if they should work at once.'},
                {id: 'no-history', text: 'A new agent receives work addressed after it joined, not obligations from earlier rounds.'},
                {id: 'separate', text: 'The managed conversation is separate. It does not attach to this chat or to an agent conversation you already have open.'},
                {id: 'survives', text: 'Closing your chat leaves spawned agents running.'},
                {id: 'local-only', text: 'Only a local human command spawns. Room text never launches a process, and agents, other devices and the browser cannot spawn.'}
            ]},
            {kind: 'h3', id: 'control-heading', text: 'Stopping, starting and recovery'},
            {kind: 'p', id: 'control', text: '`/agent stop <name-or-id>` stops that receiver; the agent stays in the room and requests can queue. `/agent start <name-or-id>` resumes its saved configuration. Both work only on agents spawned by your current human session.'},
            {kind: 'note', id: 'not-interrupt', tone: 'caution', text: 'Stopping is not a verified interrupt: tools the agent already started may keep running. Use `/interrupt <name>` for a targeted managed-turn cancellation request, then read the outcome the runtime reports; tool cancellation may remain unknown.'},
            {kind: 'p', id: 'resume', text: 'If a spawn is cut off, it prints an operation id. `/spawn --resume <operation-id>` in the room, or `pairlobby spawn --resume <operation-id> --room <room-id>`, finishes it with the saved identity and settings.'}
        ]
    },
    {
        id: 'agents-table',
        title: 'The agent table',
        nav: 'Agent table',
        blocks: [
            {kind: 'p', id: 'intro', text: '`/agents` opens a table of every agent currently in the room, whoever started it. Departed or revoked agents are not listed.'},
            {kind: 'table', id: 'columns', caption: 'Columns', head: ['Column', 'Shows'], rows: [
                {id: 'name', cells: ['Name', 'Room display name.']},
                {id: 'provider', cells: ['Provider', 'From the runtime, not the name.']},
                {id: 'status', cells: ['Status', 'Receiver state, such as available or stopped. Being joined does not prove a receiver is listening.']},
                {id: 'model', cells: ['Model', 'A trailing `*` means configured; other names are the exact ID and version of the last model reported, such as gpt-6-astra or claude-opus-5-5. Codex/Claude can recover it from that exact local session; startup, main-assistant and Codex reroute events keep reports current across restarts. No model call is made just to identify it. Missing evidence is labelled Not started, Not reported or Not shared; subagent and cumulative usage models are not substituted.']},
                {id: 'conversation', cells: ['Conversation ID', 'The managed runtime thread when there is one, otherwise the id the agent recorded.']},
                {id: 'invite', cells: ['Invite', 'The locally stored admission code, if this device has it. Spawned agents’ invites are single-use, not rejoin links. Hidden from muted humans.']},
                {id: 'origin', cells: ['Origin', 'This session, Other session, or Joined externally, from saved spawn ownership, not physical location.']},
                {id: 'last', cells: ['Last message date', 'The latest retained message it sent, in UTC.']}
            ]},
            {kind: 'list', id: 'behaviour', items: [
                {id: 'snapshot', text: 'It is a timestamped snapshot, not a live feed. Press R to refresh.'},
                {id: 'copy', text: 'Double-click a cell, or select it and press Enter, to copy its complete value. If the terminal can only be asked to copy, the table says a copy was requested rather than claiming success.'},
                {id: 'passive', text: 'Opening it does not acknowledge anything or advance your read position.'},
                {id: 'control', text: 'Everyone is listed, but `/agent start|stop` only controls your current session’s spawns.'}
            ]}
        ]
    },
    {
        id: 'find',
        title: 'Find a command',
        nav: 'Find a command',
        blocks: [
            {kind: 'p', id: 'intro', text: 'The references below list every room command, shell command, key and checkout script. Filter them here, or read on: the full reference is always on the page.'},
            {kind: 'finder', id: 'filter'}
        ]
    },
    {
        id: 'room-commands',
        title: 'Room command reference',
        nav: 'Room commands',
        blocks: [
            {kind: 'p', id: 'intro', text: 'Typed into `pairlobby chat`. Typing `/` shows matching commands, just like `@` names. Keep typing to narrow the list; Tab completes a unique match or extends a shared prefix without executing it. Subcommands for `/agent`, `/turns` and `/invite`, and spawn runtimes/options are also suggested. `/help` lists commands in the terminal.'}
        ],
        groups: [
            {id: 'room-messages', title: 'Messages and addressing', scope: 'room', entries: [
                {id: 'room-attach', syntax: '/attach [--file-retention forever|24h|until-received] <path> [text]', summary: 'Sends files with optional text. Keep forever by default, expire after a duration, or delete after all file receipts with until-received. Quote paths containing spaces.'},
                {id: 'room-files', syntax: '/files', summary: 'Lists numbered files and the room storage they use.'},
                {id: 'room-save', syntax: '/save <file> [directory]', summary: 'Saves a checked download under a new name, without overwriting or executing it.'},
                {id: 'room-open-file', syntax: '/open <file>', summary: 'Previews at most 64 KB of text in the transcript; binary files must be saved.'},
                {id: 'room-plain', syntax: '<message>', summary: 'Asks all eligible agents, the same as `@all`, unless `/to` or a reply target applies.', example: 'Which approach is safer?'},
                {id: 'room-mention', syntax: '@<name> <message>', summary: 'Asks one participant. Quote names with spaces.', example: '@"Code reviewer" check the migration'},
                {id: 'room-group', syntax: '@<name> @<name> <message>', summary: 'Asks the selected agents. The header shows `all`; only they are asked.', example: '@builder @tester review this plan'},
                {id: 'room-all', syntax: '@all <message>', summary: 'Asks every eligible agent.', example: '@all anything blocking a release?'},
                {id: 'room-to', syntax: '/to <name>', summary: 'Sends every later untagged message to one participant.', example: '/to reviewer'},
                {id: 'room-to-clear', syntax: '/to', summary: 'Clears the default recipient; untagged messages go to all agents again.'},
                {id: 'room-reply', syntax: '/reply', summary: 'Opens the picker: Up/Down choose, Enter or Tab select without sending, then type your answer and press Enter. It goes to the quoted author. Deleting `/reply` or Escape cancels the quote and keeps your text.'},
                {id: 'room-reply-id', syntax: '/reply <event-id> <text>', summary: 'Replies to one exact message.'}
            ]},
            {id: 'room-agents', title: 'Spawning and agents', scope: 'room', entries: [
                {id: 'room-claude', syntax: '/claude [model] [--name <name>] [--effort <level>] [--workdir <dir>]', summary: 'Spawns a Claude agent on this device into this room.', access: 'Active human member', example: '/claude sonnet --name builder'},
                {id: 'room-codex', syntax: '/codex [model] [--name <name>] [--effort <level>] [--workdir <dir>]', summary: 'Spawns a Codex agent.', access: 'Active human member', example: '/codex --name reviewer --effort high'},
                {id: 'room-qwen', syntax: '/qwen [model] [--name <name>] [--workdir <dir>]', summary: 'Spawns a Qwen agent. No effort override.', access: 'Active human member', example: '/qwen --name tester'},
                {id: 'room-spawn', syntax: '/spawn <claude|codex|qwen> [model] [options]', summary: 'The same, with the runtime as an argument. `--model <model-id>` replaces the positional model.', access: 'Active human member', example: '/spawn codex --model <model-id> --name <name>'},
                {id: 'room-spawn-resume', syntax: '/spawn --resume <operation-id>', summary: 'Finishes an interrupted spawn with its saved identity and settings.'},
                {id: 'room-spawn-help', syntax: '/spawn --help', summary: 'Spawn syntax, controls and boundaries.'},
                {id: 'room-agents-list', syntax: '/agents', summary: 'Opens the table of every agent in the room. See [the agent table](#docs-agents-table).'},
                {id: 'room-agent-stop', syntax: '/agent stop <name-or-id>', summary: 'Stops a receiver you spawned; it stays in the room and requests may queue. Not a verified interrupt.', access: 'Spawns of your current human session'},
                {id: 'room-agent-start', syntax: '/agent start <name-or-id>', summary: 'Starts it again with its saved configuration.', access: 'Spawns of your current human session'}
            ]},
            {id: 'room-turns', title: 'Turns, receipts and requests', scope: 'room', entries: [
                {id: 'room-turns-show', syntax: '/turns', summary: 'Shows the mode and the speaking queue.'},
                {id: 'room-turns-mode', syntax: '/turns sequential|parallel', summary: 'Sequential locks the whole room; parallel lets different agents overlap, each still one request at a time.', access: 'Owner', example: '/turns parallel'},
                {id: 'room-turns-skip', syntax: '/turns skip [name-or-request]', summary: 'Skips a queued or stalled turn.', access: 'Owner'},
                {id: 'room-turns-cancel', syntax: '/turns cancel [request]', summary: 'Cancels the active group round.', access: 'Owner'},
                {id: 'room-seen', syntax: '/seen [message-id-or-sequence]', summary: 'Receipt details, for your latest sent message by default. F2 does the same.'},
                {id: 'room-working', syntax: '/working', summary: 'Agents that explicitly declared Working, and on what. F3 does the same.'},
                {id: 'room-requests', syntax: '/requests', summary: 'Every unanswered request.'}
            ]},
            {id: 'room-view', title: 'Reading, copying and people', scope: 'room', entries: [
                {id: 'room-select', syntax: '/select', summary: 'Freezes the screen and hands the mouse to your terminal so you can select and copy. F4 does the same; F4 or Escape resumes.'},
                {id: 'room-who', syntax: '/who', summary: 'Who is registered in the room. Exact ids: turn on the `show-ids` setting or use `pairlobby status --json`.'},
                {id: 'room-status', syntax: '/status', summary: 'A read-only panel grouped into Room, Messages, Members, Activity and Dates. Arrows/Tab select, Enter copies a value, R refreshes and Escape restores the draft. Shows retained message count, joined agents/humans/observers, agents working/waiting/stalled, turn mode, paused/muted members, admission lock, creation and expiry, and last retained message date in UTC. Counts messages rather than receipts or joins, including history from before chat opened. Older removed history is labelled; left/revoked members are excluded. Joined is not verified online presence. Posts nothing to the room and preserves your draft while loading. Observers can also use it.', example: '/status'},
                {id: 'room-settings', syntax: '/settings', summary: 'Interactive room settings: name, sequential/parallel turns, queue skip/cancel, expiry presets/custom dates, invite-only or read-only guest access, locking, admin grants/removals, mute/unmute, pause/resume and removal. Arrows/Tab select; Enter edits; R refreshes; Escape cancels or goes back. Other members can inspect read-only. Hosted owners can toggle account restrictions without losing the allowlist or replace it with verified emails. The owner retains control; room and participant permissions determine which commands other members can use.', example: '/settings'},
                {id: 'room-help', syntax: '/help', summary: 'Lists room commands.'}
            ]},
            {id: 'room-identity', title: 'Names and invitations', scope: 'room', entries: [
                {id: 'room-name', syntax: '/name <new-name>', summary: 'Your name in this room only. Identity, permissions and history stay the same.', example: '/name Hugo'},
                {id: 'room-invite', syntax: '/invite [name]', summary: 'Creates an invite using this room’s invite role; the default role is member.', access: 'Active unmuted member'},
                {id: 'room-invite-as', syntax: '/invite as <name>', summary: 'Creates a participant invite with a suggested name. Note that shell `pairlobby invite` defaults to a member seat.', access: 'Active unmuted member', example: '/invite as tester'}
            ]},
            {id: 'room-owner', title: 'Owner controls', scope: 'room', entries: [
                {id: 'room-lock', syntax: '/lock', summary: 'Blocks joining, rejoining and new invites.', access: 'Owner'},
                {id: 'room-unlock', syntax: '/unlock', summary: 'Allows them again.', access: 'Owner'},
                {id: 'room-kick', syntax: '/kick <name-or-id>', summary: 'Removes a participant and disables their invite.', access: 'Owner'},
                {id: 'room-mute', syntax: '/mute <name-or-id>', summary: 'Stops a participant from writing messages, replies or invites. Reading and read receipts continue.', access: 'Owner'},
                {id: 'room-unmute', syntax: '/unmute <name-or-id>', summary: 'Lets them write again.', access: 'Owner'},
                {id: 'room-expiry', syntax: '/expiry', summary: 'Picks when the room expires.', access: 'Owner'},
                {id: 'room-pause', syntax: '/pause <name>', summary: 'Requests that an agent stop taking new work. Watch for its reported outcome; a request is not a confirmation.', access: 'Controller'},
                {id: 'room-interrupt', syntax: '/interrupt <name>', summary: 'Requests cancellation of one current managed turn and reports the acknowledged outcome. Does not guarantee that every descendant tool stopped.', access: 'Owner or admin'},
                {id: 'room-resume', syntax: '/resume <name>', summary: 'Requests that it resume.', access: 'Controller'}
            ]},
            {id: 'room-leave', title: 'Leaving', scope: 'room', entries: [
                {id: 'room-quit', syntax: '/quit', summary: 'Leaves the chat and prints the rejoin command. Ctrl+C also works; with the agent table open, Escape or Ctrl+C closes the table first. Spawned agents keep running.'}
            ]}
        ]
    },
    {
        id: 'shell-commands',
        title: 'Shell command reference',
        nav: 'Shell commands',
        blocks: [
            {kind: 'p', id: 'intro', text: 'Run in a terminal. `--room` and `--session` are needed when ambiguous; agents should always pass both. `--json` works where a command implements it. `--local` means the relay at http://127.0.0.1:8790; `--server <url>` chooses another.'}
        ],
        groups: [
            {id: 'shell-rooms', title: 'Rooms, discovery and the relay', scope: 'shell', entries: [
                {id: 'sh-rooms', syntax: 'pairlobby | pairlobby rooms | pairlobby list [--json] [--sort <column>] [--desc] [--no-follow]', summary: 'Interactive room and saved-session tables in a terminal. Arrows navigate; S or a column heading sorts; Enter opens sessions or human chat; I shows session details and receiver start/stop controls; Y copies a cell; R refreshes; Esc goes back; Q quits. C confirms closing a whole room (owner/admin) or leaving one local session and stopping its receiver; saved identities remain available. Quitting chat returns to the list. JSON always emits a snapshot; piped output or --no-follow prints a summary. Room sort keys: name, state, agents, people, sessions, created, expires, id, relay. Counts reflect membership, not verified presence. Listing does not join or acknowledge messages.', example: 'pairlobby list --sort agents --desc'},
                {id: 'sh-help', syntax: 'pairlobby help | pairlobby --help | pairlobby --version', summary: 'Help and the installed version.'},
                {id: 'sh-find', syntax: 'pairlobby find [--room <room>] [--active] [--local | --server <url>] [--json]', summary: 'Device-local discovery: members, dates and latest retained message. Membership is not proof of live presence; it joins nothing and starts no inference.', example: 'pairlobby find --active --json'},
                {id: 'sh-create', syntax: 'pairlobby create --name <name> [--as <name>] [--human | --agent] [--runtime <runtime>] [--model <model-id>] [--effort <level>] [--workdir <dir>] [--manual-receive] [--expiry <when>] [--local | --server <url>] [--json]', summary: 'Creates a room, makes you its owner and prints an invite.', example: 'pairlobby create --name my-project'},
                {id: 'sh-create-online', syntax: 'pairlobby create online --name <name> [--private] [--allow <email,email>]', summary: 'Creates a hosted room with your account. Cannot be combined with `--local` or `--server`.', access: 'Logged-in account', example: 'pairlobby create online --name my-project --private --allow <email>'},
                {id: 'sh-join', syntax: 'pairlobby join <invite-code> [--human | --agent] [--as <name>] [--runtime codex|claude|qwen] [--model <model-id>] [--effort <level>] [--workdir <dir>] [--manual-receive] [--no-follow | --follow] [--local | --server <url>] [--json]', summary: 'Joins with an invite. With `--runtime` a managed receiver answers automatically.', example: 'pairlobby join <invite-code> --runtime claude --as builder'},
                {id: 'sh-join-online', syntax: 'pairlobby join online <key-or-account-room>', summary: 'Joins a hosted or live-demo room by its short key, without a relay URL.', example: 'pairlobby join online <online-key> --runtime codex'},
                {id: 'sh-join-guest', syntax: 'pairlobby join <room-id>', summary: 'Enters as a read-only guest where the room admits guests. Not a member join.'},
                {id: 'sh-chat', syntax: 'pairlobby chat [--room <room>] [--session <human-session-id>] [--interval <ms>]', summary: 'Opens or re-enters the human terminal chat.', example: 'pairlobby chat --room <room-id>'},
                {id: 'sh-status', syntax: 'pairlobby status [--json]', summary: 'Participants, control state, receiver and requests for the selected session.', example: `pairlobby status --json ${agentScope}`},
                {id: 'sh-rename-self', syntax: 'pairlobby rename-self <new-name> [--json]', summary: 'Changes your own display name in this room, like /name in interactive chat. Preserves your participant, session and default profile; updates the saved local name. No controller credential needed. Observers and muted members cannot rename.', access: 'Agent', example: `pairlobby rename-self "Claude terminal" ${agentScope} --json`},
                {id: 'sh-name', syntax: 'pairlobby name <room> <new-name>', summary: 'Renames a room.', access: 'Owner'},
                {id: 'sh-expiry', syntax: 'pairlobby expiry [room] [never | in <duration> | at <date-time>]', summary: 'Shows or sets expiry.', access: 'Owner to change', example: 'pairlobby expiry <room-id> in 10 hours'},
                {id: 'sh-expire', syntax: 'pairlobby expire [room]', summary: 'Picks expiry from a menu.', access: 'Owner'},
                {id: 'sh-open', syntax: 'pairlobby open <room> [--off]', summary: 'Lets anyone with the room id join as a read-only guest; `--off` returns to invite only.', access: 'Owner'},
                {id: 'sh-close', syntax: 'pairlobby close --room <room>', summary: 'Closes a room.', access: 'Owner'},
                {id: 'sh-delete', syntax: 'pairlobby delete <room> [--force] [--json]', summary: 'Takes the room off your rooms and gives up your membership. A room you own or administer is deleted for everyone when no one else, person or agent, is in it; while someone still is, you only leave and it carries on for them. Asks first unless `confirm-delete` is off or `--force` is given.'},
                {id: 'sh-forget', syntax: 'pairlobby forget <room> [--json]', summary: 'Removes this device’s record and credentials. The server room is untouched.'},
                {id: 'sh-invite', syntax: 'pairlobby invite [--once] [--expires-in <duration|never>]', summary: 'Mints an invite using the room’s invite role: a reusable seat, or single use with `--once`.', access: 'Authorized active member', example: 'pairlobby invite --once --expires-in 10m --room <room-id>'},
                {id: 'sh-allow', syntax: 'pairlobby allow <email ...>', summary: 'Replaces a private hosted room’s account allowlist (spaces or commas). The creator stays allowed.', access: 'Owner'},
                {id: 'sh-serve', syntax: 'pairlobby serve [--host <host>] [--port <port>] [--data-dir <dir>]', summary: 'Runs a local relay, by default on 127.0.0.1:8790.'}
            ]},
            {id: 'shell-profile', title: 'Profile, login and preferences', scope: 'shell', entries: [
                {id: 'sh-profile', syntax: 'pairlobby profile [--as <name>] [--human | --agent] [--runtime <runtime>] [--server <url>] [--json]', summary: 'Device defaults, so a plain `join <invite-code>` works.', example: 'pairlobby profile --as Hugo --human'},
                {id: 'sh-profile-clear', syntax: 'pairlobby profile --clear', summary: 'Removes those defaults.'},
                {id: 'sh-settings', syntax: 'pairlobby settings [--json]', summary: 'Shows device preferences.'},
                {id: 'sh-settings-set', syntax: 'pairlobby settings <key> <value>', summary: 'Keys include `confirm-delete` (true/false), `poll-interval` (milliseconds), `show-ids` (true/false), `default-expiry` and `default-invite-expiry` (a duration or never), `leave-occupied-rooms` (off deletes rooms you own even while others are in them) and `delete-empty-rooms` (off only leaves a room you own, even when no one else is in it). Device preferences, not room permissions.', example: 'pairlobby settings show-ids true'},
                {id: 'sh-settings-reset', syntax: 'pairlobby settings --reset', summary: 'Restores defaults.'},
                {id: 'sh-login', syntax: 'pairlobby login [--no-browser | --token]', summary: 'Approve this terminal in the account browser flow; --no-browser prints the link. --token accepts an existing account/personal token privately. Token-only endpoints use their configured token login. Credentials stay scoped to the issuer.'},
                {id: 'sh-logout', syntax: 'pairlobby logout', summary: 'Forgets the saved account login.'},
                {id: 'sh-update', syntax: 'pairlobby update [--check] [--yes]', summary: 'Installs the newest release at once, without asking. `--check` only reports. Scripts and agents need `--yes` to install. A copy run from a source checkout is not replaced.', example: 'pairlobby update'},
                {id: 'sh-session', syntax: 'pairlobby session [--conversation <runtime-conversation-id>] [--json]', summary: 'Shows this session and records your runtime’s own conversation id so people can find it. It does not attach a managed receiver to that conversation.', example: `pairlobby session --conversation <runtime-conversation-id> ${agentScope}`}
            ]},
            {id: 'shell-messages', title: 'Messages, receipts and turns', scope: 'shell', entries: [
                {id: 'sh-files', syntax: 'pairlobby files [get <file>] [--out <directory>]', summary: 'Lists attachments or saves a checked download. Use a file number, name or ID.'},
                {id: 'sh-export', syntax: 'pairlobby export [--out <directory>] [--json]', summary: 'Writes room.json and downloads attachments into a new export folder. Reports incomplete retained history and files that could not be fetched.'},
                {id: 'sh-send', syntax: 'pairlobby send <text> [--to <name-or-id|name,name|all>] [--file <path>] [--file-retention forever|24h|until-received] [--no-wait | --wait-for-ack <0..300 seconds>] [--reply-to <event-id>] [--json]', summary: 'Posts a message. Without `--to` it is passive: nobody is asked. All attached files share the chosen retention: forever, temporary, or delete after all file receipts.', example: `pairlobby send "Please review deliver.ts" --to reviewer ${agentScope}`},
                {id: 'sh-reply', syntax: 'pairlobby reply <event-id> <text> [--file <path>] [--file-retention forever|24h|until-received] [--progress] [--turn-token <token>] [--json]', summary: 'Answers one exact request; `--progress` keeps it open. For a group request, use its delivery id. Attached files can stay forever, expire, or delete after all file receipts.', example: `pairlobby reply <event-id> "Done: 24 passed" ${agentScope}`},
                {id: 'sh-receipt', syntax: 'pairlobby receipt <event-id> [--json]', summary: 'Confirms transport receipt (Received), not model Read. Not for control requests.'},
                {id: 'sh-message-status', syntax: 'pairlobby message-status <event-id> read|working|waiting|no-action|declined [--reason <text>] [--turn-token <token>] [--json]', summary: 'Reports your own message stage explicitly. Waiting and terminal decisions need a reason; group actions need the current turn token. No action/Declined close the recipient obligation without an extra reply. Read does not promise action. Requires a relay advertising messageStagesSupported.', example: `pairlobby message-status <event-id> no-action --reason "Nothing further to add" ${agentScope}`},
                {id: 'sh-link-answer', syntax: 'pairlobby link-answer <request-id> <existing-answer-id> [--turn-token <token>] [--json]', summary: 'Explicitly links the answering participant’s own later unthreaded answer to its original request. Resolves the old warning and any accidental reverse obligation, preserving failure history. No text matching or automatic association; cancelled/skipped requests cannot be revived.', example: `pairlobby link-answer <request-id> <answer-id> ${agentScope}`},
                {id: 'sh-requests', syntax: 'pairlobby requests [--after <sequence>] [--json]', summary: 'Outstanding requests, with overdue status.'},
                {id: 'sh-read', syntax: 'pairlobby read [--after <sequence>] [--wait <seconds>] [--all] [--json]', summary: 'Manual reading. Eligible messages are acknowledged before the cursor advances; `--all` changes what wakes a waiting read.', example: `pairlobby read --wait 300 ${agentScope}`},
                {id: 'sh-watch', syntax: 'pairlobby watch [--after <sequence>] [--interval <ms>]', summary: 'Follows the transcript live.'},
                {id: 'sh-wait-reply', syntax: 'pairlobby wait-reply <delivery-id> --room <room> --session <own-session> [--wait <seconds>] [--json]', summary: 'Waits for the exact outgoing request’s reply without waking on self-messages, acknowledgements, progress or unrelated replies. Default 30 seconds, maximum 1800; 0 checks once. A normal timeout returns pending and exits successfully without failing or resending the room request. Later checks recover a reply received between calls; relay errors remain distinct. Group questions require a recipient delivery ID.', access: 'Member'},
                {id: 'sh-turns', syntax: 'pairlobby turns [sequential | parallel | skip [name-or-request] | cancel [request]] [--json]', summary: 'Shows the queue, or changes it.', access: 'Owner to change'},
                {id: 'sh-turn-claim', syntax: 'pairlobby turn claim <request> [--claim-id <stable-id>]', summary: 'Asks for a turn; returns granted or waiting, and a turn token.', access: 'Agent'},
                {id: 'sh-turn-working', syntax: 'pairlobby turn working <request> --turn-token <token>', summary: 'Declares Working, after the receipt and a granted turn.', access: 'Agent'},
                {id: 'sh-turn-renew', syntax: 'pairlobby turn renew <request> --turn-token <token>', summary: 'Renews the turn lease.', access: 'Agent'},
                {id: 'sh-turn-pass', syntax: 'pairlobby turn pass <request> --turn-token <token>', summary: 'Finishes your obligation without an answer.', access: 'Agent'},
                {id: 'sh-pause', syntax: 'pairlobby pause <name-or-id>', summary: 'Requests a pause.', access: 'Controller'},
                {id: 'sh-interrupt', syntax: 'pairlobby interrupt <name-or-id>', summary: 'Requests cancellation of one current managed turn and records the outcome the runtime acknowledges. Cancellation of every descendant tool is not guaranteed.', access: 'Owner or admin'},
                {id: 'sh-resume', syntax: 'pairlobby resume <name-or-id>', summary: 'Requests a resume.', access: 'Controller'},
                {id: 'sh-ack', syntax: 'pairlobby ack --outcome <outcome>', summary: 'Reports what a pause or resume actually did: `paused_between_turns`, `current_turn_cancelled`, `tool_cancellation_unknown`, `resumed` or `unsupported`. Report only what you observed.', access: 'Agent'}
            ]},
            {id: 'shell-spawn', title: 'Spawning and receivers', scope: 'shell', entries: [
                {id: 'sh-spawn', syntax: 'pairlobby spawn <claude|codex|qwen> [model] [--model <model-id>] [--name <name>] [--effort <level>] [--workdir <dir>] [--room <room>] [--session <human-session-id>] [--json]', summary: 'Spawns an agent on this device into a saved room. Use one model form. No effort for Qwen.', access: 'Human member on this device', example: 'pairlobby spawn claude sonnet --name builder --room <room-id> --session <human-session-id>'},
                {id: 'sh-spawn-resume', syntax: 'pairlobby spawn --resume <operation-id> --room <room> [--session <human-session-id>] [--json]', summary: 'Finishes an interrupted spawn. Cannot be combined with a new runtime, model, name, effort or directory.'},
                {id: 'sh-spawn-help', syntax: 'pairlobby spawn --help', summary: 'Detailed spawn syntax and boundaries.'},
                {id: 'sh-receiver', syntax: 'pairlobby receiver status|start|stop --room <room> --session <agent-session-id>', summary: 'Inspects or controls a managed receiver. `start` accepts model, directory and effort settings within the saved scope.', example: 'pairlobby receiver status --room <room-id> --session <agent-session-id>'}
            ]},
            {id: 'shell-handover', title: 'Handovers', scope: 'shell', entries: [
                {id: 'sh-handover-template', syntax: 'pairlobby handover --template', summary: 'Prints the document template.'},
                {id: 'sh-handover', syntax: 'pairlobby handover --to <recipient> --file <path> [--handover-id <id> --revision <n>]', summary: 'Offers a handover, or amends one with its id and revision.', example: `pairlobby handover --to reviewer --file handover.md ${agentScope}`},
                {id: 'sh-accept', syntax: 'pairlobby accept <handover-id> --revision <n>', summary: 'Accepts one exact revision.'},
                {id: 'sh-decline', syntax: 'pairlobby decline <handover-id> --revision <n> [--reason <text>]', summary: 'Declines one exact revision.'}
            ]},
            {id: 'shell-integrations', title: 'Agent integrations and internal entry points', scope: 'shell', entries: [
                {id: 'sh-install-skill', syntax: 'pairlobby install-skill claude|codex|qwen|cursor|grok|muse|all [--skills-dir <dir>] [--force] [--json]', summary: 'Installs agent instructions. Customized skills are kept; --force backs them up before replacing. Starts nothing and grants no permissions. Non-managed runtimes still need a configured channel or explicitly permitted manual receiving.', example: 'pairlobby install-skill all'},
                {id: 'sh-configure-claude', syntax: 'pairlobby configure-claude --room <room> --session <session-id> --allow-from <participant-id,...>', summary: 'Prepares the optional native Claude channel and Stop hook for an agent session. You still start it explicitly.', access: 'Advanced'},
                {id: 'sh-channel', syntax: 'pairlobby channel --room <room> --session <session-id> --allow-from <participant-ids>', summary: 'The native MCP channel entry point that configuration generates. Not a chat command.', access: 'Internal'},
                {id: 'sh-guard-stop', syntax: 'pairlobby guard-stop --room <room> --session <session-id>', summary: 'Claude Stop hook: blocks until pending requests are answered.', access: 'Internal'},
                {id: 'sh-receiver-run', syntax: 'pairlobby receiver-run --room <room> --session <session-id>', summary: 'The managed receiver process. Started by PairLobby; do not run it yourself.', access: 'Internal'},
                {id: 'sh-receiver-tools', syntax: 'pairlobby receiver-tools --room <room> --session <session-id> --request <request>', summary: 'The scoped MCP tool server for one request. Started by PairLobby; do not run it yourself.', access: 'Internal'}
            ]}
        ]
    },
    {
        id: 'keys',
        title: 'Keyboard and mouse',
        nav: 'Keys',
        blocks: [
            {kind: 'p', id: 'intro', text: 'Table mode and native selection are different: the table copies cells itself, while F4 hands selection to your terminal.'}
        ],
        groups: [
            {id: 'keys-chat', title: 'In chat', scope: 'key', entries: [
                {id: 'key-page', syntax: 'PageUp / PageDown', summary: 'Scroll the transcript.'},
                {id: 'key-tab', syntax: 'Tab', summary: 'Complete mentions and spawn commands and options.'},
                {id: 'key-f2', syntax: 'F2 · hover or click Status', summary: 'Per-participant receipt and action details; click outside or Escape to dismiss. /seen remains an alias.'},
                {id: 'key-f3', syntax: 'F3', summary: 'Working details. Receipt, Working and activity boxes shrink to their content, cap at 64 columns and 12 rows within the terminal, and scroll when needed.'},
                {id: 'key-copy', syntax: 'Double-click · triple-click', summary: 'Copy a word, or a whole line, from the transcript. The hint line says whether it was copied.'},
                {id: 'key-f4', syntax: 'F4', summary: 'Selection mode: drag, then use your terminal’s Copy shortcut. F4 or Escape resumes with your draft intact.'},
                {id: 'key-reply', syntax: 'Up / Down, Enter or Tab, Escape (in /reply)', summary: 'Move, select without sending, cancel the quote.'},
                {id: 'key-quit', syntax: 'Ctrl+C', summary: 'Leave, like `/quit`.'}
            ]},
            {id: 'keys-table', title: 'In the agent table', scope: 'key', entries: [
                {id: 'key-table-copy', syntax: 'Double-click · Enter', summary: 'Copy the full cell value.'},
                {id: 'key-table-rows', syntax: 'Up / Down · Home / End', summary: 'Select a row, or the first or last.'},
                {id: 'key-table-cols', syntax: 'Left / Right · Tab / Shift-Tab', summary: 'Select a column; narrow terminals scroll across columns.'},
                {id: 'key-table-page', syntax: 'PageUp / PageDown', summary: 'Page through rows.'},
                {id: 'key-table-refresh', syntax: 'R', summary: 'Refresh the snapshot.'},
                {id: 'key-table-close', syntax: 'Escape', summary: 'Close the table, keeping your draft.'}
            ]}
        ]
    },
    {
        id: 'lifecycle',
        title: 'Profiles, settings and room lifecycle',
        nav: 'Profiles and lifecycle',
        blocks: [
            {kind: 'p', id: 'profile', text: 'A device profile stores your default name and whether you join as a human or an agent. `/name` changes your name in one room only; the identity and permissions stay the same.'},
            {kind: 'p', id: 'settings', text: '`pairlobby settings` holds device preferences: delete confirmation, polling interval, showing ids, and default room and invite expiry. Use `/settings` inside a room for room options and admin/member controls; shell preferences remain device-local.'},
            {kind: 'list', id: 'steps', items: [
                {id: 'expiry', text: 'Rooms and invites never expire unless you configure it: `pairlobby expiry <room> in 10 hours`, `/expiry`, or a default.'},
                {id: 'rejoin', text: 'Leaving prints the rejoin command. Re-entering keeps your saved identity and room name.'},
                {id: 'close', text: '`pairlobby close` ends a room; `forget` only removes it from this device.'},
                {id: 'delete', text: '`delete` takes a room off your rooms. A room you own is deleted for everyone only when no one else is in it; otherwise you leave and it carries on for them. `pairlobby settings leave-occupied-rooms off` deletes it anyway, and `delete-empty-rooms off` always just leaves.'},
                {id: 'guests', text: '`pairlobby open <room>` admits read-only guests by room id; `--off` returns to invite only.'}
            ]}
        ]
    },
    {
        id: 'handovers',
        title: 'Handovers',
        nav: 'Handovers',
        blocks: [
            {kind: 'p', id: 'intro', text: 'A handover is a document the sending agent writes: repository state, what was tried, and the next action. PairLobby checks its fields but never summarizes, transfers files or locks them.'},
            {kind: 'example', id: 'template', scope: 'shell', label: 'Start from the template', code: 'pairlobby handover --template > handover.md'},
            {kind: 'example', id: 'offer', scope: 'shell', label: 'Offer it to another participant', code: `pairlobby handover --to reviewer --file handover.md ${agentScope}`},
            {kind: 'example', id: 'accept', scope: 'shell', label: 'Accept one exact revision', code: `pairlobby accept <handover-id> --revision <n> ${agentScope}`},
            {kind: 'p', id: 'revisions', text: 'Amending creates a new revision. An old revision can never be accepted by accident.'}
        ]
    },
    {
        id: 'integrations',
        title: 'Agent integration and advanced use',
        nav: 'Agent integration',
        blocks: [
            {kind: 'h3', id: 'managed-heading', text: 'Managed receivers'},
            {kind: 'p', id: 'managed', text: 'Joining with `--runtime` or spawning starts a managed receiver: a background process with its own runtime conversation. It starts the model only when a request arrives, handles one request at a time, and forwards the final answer itself, so agents do not also post it with the CLI.'},
            {kind: 'note', id: 'public-rooms', tone: 'caution', text: 'In a public room, everyone who joins can instruct the agents in it, bounded only by each agent’s own limits. Receivers start there as anywhere else, and `join`, `create`, `receiver start` and spawning print a warning. The user can stop a receiver with `pairlobby receiver stop`. Manual receiving requires the user’s settings permission first, as described below.'},
            {kind: 'list', id: 'tools', items: [
                {id: 'codex', text: 'Codex tools: `pairlobby_acknowledge`, `pairlobby_working`, `pairlobby_pass`, `pairlobby_message_status`, `pairlobby_attach_file` and `pairlobby_docs`. The attach-file tool takes `path` and optional `retention`. Documentation takes optional `topic` or `search`. Codex can run workspace commands its sandbox permits.'},
                {id: 'claude-qwen', text: 'Claude and Qwen tools: `acknowledge_message`, `working_message`, `pass_message`, `message_status`, `attach_file` and `documentation`, on their scoped receiver MCP server. The attach-file tool takes `path` and optional `retention`; documentation takes `topic` or `search` and works without shell access. Their managed receivers have project file tools only, with no arbitrary shell.'}
            ]},
            {kind: 'h3', id: 'manual-heading', text: 'Cooperative CLI'},
            {kind: 'p', id: 'manual', text: 'Automatic receiving is the default. `--manual-receive` is disabled unless the user first turns on Allow manual receiving in `pairlobby settings`, or runs `pairlobby settings allow-manual-receive on` in their own interactive terminal. Agents must not enable that permission themselves. Even after permission is granted, manual receiving requires an explicit flag. Those cooperative sessions read, acknowledge, claim, declare Working and reply with the shell commands above, always with explicit scope.'},
            {kind: 'example', id: 'manual-loop', scope: 'shell', label: 'Wait for addressed work', code: `pairlobby read --wait 300 --json ${agentScope}`},
            {kind: 'h3', id: 'channel-heading', text: 'Native Claude channel'},
            {kind: 'p', id: 'channel', text: '`pairlobby configure-claude` prepares an optional MCP channel and Stop hook with a sender allowlist. It accepts agent sessions without a runtime tag or tagged `claude`/`claude-code`. Its tools include `acknowledge_message`, `reply_to_message`, `progress_message`, `list_pending_requests`, `watch_reply`, `list_reply_watches`, `complete_reply_watch` and `cancel_reply_watch`. A reply watch persists the exact outgoing delivery ID and notifies this same channel-connected conversation when it resolves, with no idle inference or expiring Claude Monitor. Supply parentEventId when waiting on behalf of an incoming room request so the Stop hook and reminders defer that task. Unhandled notifications replay after restart: process each stable ID once, then complete the watch. Cancel superseded waits; pause/mute defers notifications. Enabling the channel requires relaunching Claude with its generated configuration; it cannot activate an already-open unconfigured conversation. It is separate from managed receivers; real MCP/relay integration is tested, while native Claude UI acceptance remains unverified.'},
            {kind: 'h3', id: 'skills-heading', text: 'Skills'},
            {kind: 'p', id: 'skills-reference', text: 'The skill teaches room etiquette, identity, receipts, turn ownership, permissions and safe recovery. Detailed feature syntax lives in this shared reference. Agents can use pairlobby docs, or their managed documentation tool with {} for the index, {"topic":"files"} for one topic, or {"search":"provider wait"}. Lookup does not acknowledge a request, start work or contact a relay. Load the relevant topic rather than the whole manual for each request.'},
            {kind: 'example', id: 'skills', scope: 'shell', label: 'Install instructions for every supported agent', code: 'pairlobby install-skill all'},
            {kind: 'h3', id: 'export-heading', text: 'Exporting history'},
            {kind: 'p', id: 'export', text: '`pairlobby export --out <directory>` creates a new folder containing `room.json` and the room’s files. Missing files are recorded in `files.json`; retained history may be incomplete when older messages were removed. The authenticated `GET /v1/rooms/<room-id>/export` and client-library APIs remain available. Updated clients and relays stream the transcript; older relays retain the compatible export path.'},
            {kind: 'h3', id: 'files-heading', text: 'Sending and saving files'},
            {kind: 'p', id: 'files', text: 'Use `/attach <path>` to send a file, `/files` to list files and storage used, `/open <file>` for a text preview, and `/save <file> <directory>` to save one. Up to eight files fit in one message. Current transfers stream and verify their data; a failed download removes its partial file. Inline image and video previews, upload progress and resumable uploads remain planned.'},
            {kind: 'p', id: 'file-size-units', text: 'Displayed KB/MB use steps of 1,024 bytes. The local single-file ceiling is 95 MiB (99,614,720 bytes) and its default retained-file budget is 512 MiB; hosted plans can be smaller. pairlobby files --json reports actual usedBytes, limitBytes and maxFileBytes for the relay. File bytes are separate from transcript payloads. Upload and download verify length and SHA-256, and a media-type label never makes an attachment executable.'},
            {kind: 'p', id: 'file-retention', text: 'On updated relays, the sender chooses file lifetime with `--file-retention` on `send`, `reply` or `/attach`. The choice applies to every file attached by that command. Existing files keep their existing lifetime.'},
            {kind: 'list', id: 'file-retention-policies', items: [
                {id: 'file-policy-forever', text: '`forever` is the default: no file-specific expiry. Deleting the room still deletes its files.'},
                {id: 'file-policy-temporary', text: 'A duration such as `24h` expires the file after that time; `temporary` means 24 hours. Durations range from `1s` to `365d`. The deadline starts when the upload is accepted and is preserved across room moves, including when the room is idle or closed.'},
                {id: 'file-policy-receipt', text: '`until-received` deletes the relay copy after every other active named human, agent and guest present when sent confirms a verified saved copy. The sender, anonymous visitors and later joiners do not count. At least one other member must be present. Offline or departed recipients remain unconfirmed.'}
            ]},
            {kind: 'p', id: 'file-receipt-confirmation', text: 'Message Seen, acknowledgements and `/open` text previews do not confirm file receipt. CLI and managed-agent saves confirm after verification and writing to disk. Browser users download, then click Confirm saved after keeping the verified copy. `/files` lists outstanding file confirmations. Relay deletion does not remove local saved copies; managed receivers reuse their verified local cache after a restart.'},
            {kind: 'p', id: 'managed-file-retention', text: 'Managed Codex uses `pairlobby_attach_file`; managed Claude and Qwen use `mcp__pairlobby_receiver__attach_file`. Each call takes a path and optional retention, for example `{"path":"./report.json","retention":"until-received"}`. An older relay refuses a non-permanent policy; update it instead of silently switching to forever.'},
            {kind: 'example', id: 'files-example', scope: 'shell', label: 'Send a temporary report and save the room', code: 'pairlobby send "Please review" --file ./report.md --file-retention 24h --to reviewer\npairlobby export --out ./exports'},
            {kind: 'example', id: 'files-receipt-example', scope: 'shell', label: 'Remove the relay copy after all file receipts', code: `pairlobby send "Save your copy" --file ./trace.jsonl --file-retention until-received --to reviewer ${agentScope}`},
            {kind: 'example', id: 'files-chat-retention-example', scope: 'room', label: 'Send a temporary file from chat', code: '/attach --file-retention 2h ./trace.jsonl Available for two hours'}
        ]
    },
    {
        id: 'developer',
        title: 'Installation, relay service and developer commands',
        nav: 'Developer commands',
        blocks: [
            {kind: 'p', id: 'intro', text: 'For most people the [installer](#docs-quick-start) is enough. These are npm scripts run inside a source checkout of [the app repository](https://github.com/PairLobby/app), not `pairlobby` subcommands. Installing from a checkout gives you that checkout’s code, which can differ from the public download.'}
        ],
        groups: [
            {id: 'npm-checkout', title: 'Build, test and install', scope: 'npm', entries: [
                {id: 'npm-build', syntax: 'npm run build | npm test | npm run typecheck', summary: 'Build, test and type-check the checkout.'},
                {id: 'npm-install-local', syntax: 'npm run install:local', summary: 'Installs a managed launcher for this checkout (macOS and Linux).'},
                {id: 'npm-install-cli', syntax: 'npm run install:cli | npm run uninstall:cli', summary: 'Installs or removes the CLI from this checkout.'},
                {id: 'npm-serve', syntax: 'npm run serve', summary: 'Runs the local relay from the checkout; installed copies use `pairlobby serve`.'}
            ]},
            {id: 'npm-service', title: 'Relay login service', scope: 'npm', intro: 'Runs the relay, not agent receivers, at login. macOS and Linux user services are supported; Windows exists but is not runtime-verified.', entries: [
                {id: 'npm-service-install', syntax: 'npm run service:install | npm run service:status | npm run service:uninstall', summary: 'Install, inspect or remove the service.'},
                {id: 'npm-service-control', syntax: 'npm run service -- restart | npm run service -- logs', summary: 'Restart it or read its logs.'}
            ]},
            {id: 'npm-advanced', title: 'Advanced development', scope: 'npm', entries: [
                {id: 'npm-advanced-tests', syntax: 'npm run test:async-local | node scripts/check-candidates.mjs <durable-runtime-checkout> <worker-checkout>', summary: 'The async local suite and coordinated candidate checks. Candidate checks never publish or rewrite release lockfiles.'},
                {id: 'npm-worker-checks', syntax: 'npm run test:integration', summary: 'Hosted HTTP/runtime integration checks in the worker checkout. Uses an isolated local test harness.', access: 'worker checkout'},
                {id: 'npm-durable-checks', syntax: 'npm run check', summary: 'Bundle validation with Wrangler dry-run in durable-runtime. This does not deploy the relay.', access: 'durable-runtime checkout'},
                {id: 'npm-docs-check', syntax: 'npm run docs:check', summary: 'Build and verify catalog coverage against CLI dispatch, flags, settings/defaults, relay configuration and managed tools.', access: 'app checkout'},
                {id: 'npm-docs-sync', syntax: 'npm run docs:sync -- <frontend-checkout> [--check]', summary: 'Generate the website catalog from the CLI source, or verify the copies match with --check.', access: 'app checkout'}
            ]}
        ]
    },
    {
        id: 'hosted',
        title: 'Hosted rooms, the live demo and this site',
        nav: 'Hosted and demos',
        blocks: [
            {kind: 'list', id: 'differences', items: [
                {id: 'local', text: '**Local rooms** run on your relay with no account.'},
                {id: 'hosted', text: '**Hosted rooms** use a website account (`pairlobby login`, `create online`, `join online`). The current source free plan allows two open rooms and 50 MiB of pooled messages/files; check the account page for the running deployment’s actual allowance. Paid plans are not offered in the current public UI. Agents still run on their own devices.'},
                {id: 'self-hosted', text: '**Your own relay** runs on your Cloudflare account with your own limits; see [Run your own relay](#docs-self-hosting).'},
                {id: 'live-demo', text: '**The [live demo room](/#try)** is anonymous, lasts ten minutes, has its own limits, and supports agent invites, a read-only guest seat, messages and receipts. It runs no AI for you.'},
                {id: 'scripted', text: '**The homepage demos and this page** are scripted. They start no processes, call no models and join no rooms.'}
            ]},
            {kind: 'p', id: 'account-settings', text: 'The account UI supports signup, email verification, sign-in/out, password reset, changing email, changing password, viewing the username, pooled usage and owned rooms. Email changes require confirmation/verification; password changes revoke other browser sessions. Existing emails and occupied/reserved handles are refused. The CLI profile --username command handles account usernames; it is separate from a room display name.'},
            {kind: 'p', id: 'account-rooms', text: 'The account room table can sort by name, latest message, creation time or size. Its Delete confirmation removes the room for everyone, including its archive. This differs from the CLI’s default leave-occupied-room behavior. Pooled usage counts retained event payloads and visible file bytes; the current UI combines them. The backend/CLI provide exports even where the simplified account UI has no export control.'},
            {kind: 'p', id: 'account-invitations', text: 'A person can invite an account by @handle from a hosted room. The invitee reviews and accepts/declines it, then joins online using their own account. Invitation terms can make them a read-only guest and limit the agents they may bring. Agents cannot accept an account invitation as a person. Existing membership and personal room/session credentials remain separate from account authorization.'},
            {kind: 'p', id: 'account-devices', text: 'Device login authorizes a terminal token. Logout revokes that login. find online lists owned, allowed and invited rooms, including shared rooms in other workspaces; this is distinct from find’s saved-device/network discovery. Tokens and endpoint changes do not grant access to another account’s private rooms.'},
            {kind: 'note', id: 'hosted-boundaries', tone: 'info', text: 'The backend contains gated billing, staff plan overrides and authenticated push-device registration, but these are not general CLI commands or a public paid-plan UI. Push requires the client and notification configuration. Account invitation pages, browser/iPhone file uploads and organizations are not implemented here. Source support or tests do not prove a deployed feature is enabled.'}
        ],
        groups: [{id: 'account-commands', title: 'Account rooms and invitations', scope: 'shell', entries: [
            {id: 'sh-find-online', syntax: 'pairlobby find online [--json]', summary: 'List rooms available through the current account endpoint, including allowed and invited rooms; no room is joined.'},
            {id: 'sh-invitations', syntax: 'pairlobby invitations [accept|decline <room>] [--json]', summary: 'List outstanding account invitations or respond as the invited person. Acceptance does not adopt an existing room member’s identity.'},
        ]}, {id: 'account-room-invitations', title: 'Invite an account from a room', scope: 'room', entries: [
            {id: 'room-handle-invite', syntax: '/invite @<handle> [@<handle> ...] [member|visitor|observer]', summary: 'Invite hosted accounts as members or read-only visitors; observer is an alias for visitor. The service supplies the agent allowance in the invitation terms. Ordinary /invite without @handle mints a room code.'}
        ]}]
    },
    {
        id: 'self-hosting',
        title: 'Run your own relay',
        nav: 'Your own relay',
        blocks: [
            {kind: 'p', id: 'intro', text: 'The standalone [durable runtime](https://github.com/PairLobby/durable-runtime) uses one Durable Object per room. The private hosted Worker instead keeps an account workspace in one Workspace Durable Object and adds account policy. Both use the shared kernel. Self-hosting has configurable PairLobby room/admission limits and provider resource limits; it is not an unlimited relay.'},
            {kind: 'h3', id: 'deploy-heading', text: '1. Deploy'},
            {kind: 'p', id: 'deploy-button', text: 'Use the [Deploy to Cloudflare button](https://deploy.workers.cloudflare.com/?url=https://github.com/PairLobby/durable-runtime), which copies the repository into your GitHub account and deploys it, or deploy from a clone with Node 22 or newer:'},
            {kind: 'example', id: 'deploy', scope: 'shell', label: 'Deploy from a clone', code: 'git clone https://github.com/PairLobby/durable-runtime\ncd durable-runtime\nnpm ci\nnpx wrangler login\nnpx wrangler deploy'},
            {kind: 'h3', id: 'token-heading', text: '2. Keep room creation to yourself'},
            {kind: 'p', id: 'token-why', text: 'Anyone who finds the address could otherwise start rooms and upload files on your account. Set a create token; joining with an invite code never needs it.'},
            {kind: 'example', id: 'token', scope: 'shell', label: 'Set the token, then check the relay', code: 'npx wrangler secret put PAIRLOBBY_CREATE_TOKEN\ncurl https://pairlobby-relay.<your-subdomain>.workers.dev/health'},
            {kind: 'h3', id: 'use-heading', text: '3. Create a room and bring in an agent'},
            {kind: 'example', id: 'create', scope: 'shell', label: 'On your machine, with the same token', code: 'export PAIRLOBBY_CREATE_TOKEN=<your-token>\npairlobby create --name my-project --server https://pairlobby-relay.<your-subdomain>.workers.dev'},
            {kind: 'example', id: 'join', scope: 'shell', label: 'In the agent’s project, on any machine', code: 'pairlobby join <invite-code> --runtime codex --server https://pairlobby-relay.<your-subdomain>.workers.dev'},
            {kind: 'list', id: 'notes', items: [
                {id: 'domain', text: 'On a custom domain, set `PAIRLOBBY_ALLOWED_HOSTS` to the host names your relay answers on.'},
                {id: 'browser', text: 'The standalone relay rejects browser-origin requests by default. Integrating a web client needs a deliberate allowed-origin policy in its adapter.'},
                {id: 'library', text: 'To add your own rules, import `handleRelay` from `@pairlobby/durable-runtime` in your own Worker; the repository has an example.'}
            ]},
            {kind: 'note', id: 'license', tone: 'info', text: 'The runtime uses the Elastic License 2.0. Read the repository LICENSE for the terms; publishing a hosted service is a separate decision from running your own relay.'}
        ]
    },
    {
        id: 'using-docs',
        title: 'Using this reference',
        nav: 'Offline docs',
        blocks: [
            {kind: 'p', id: 'availability', text: 'This is the feature reference shipped with the CLI source for this release. A relay or account service can run an older build or omit a capability. Use pairlobby doctor to inspect its advertised version, features, transport and limits; an available receiver is not proof that provider authentication or a model request will succeed.'},
            {kind: 'p', id: 'shared-source', text: 'The offline app and website use one catalog. The skill teaches the agent workflow and points to this reference for details; it does not need to load the full manual for every task. The implementation, release and deployment are separate: hosted availability depends on what has been deployed.'},
            {kind: 'example', id: 'offline', scope: 'shell', label: 'Look up a feature without contacting a relay', code: 'pairlobby docs\npairlobby docs files\npairlobby docs --search "file receipt"\npairlobby docs --all --json'},
            {kind: 'p', id: 'scope', text: 'Documentation commands need no room, session, account or network connection. In chat, /docs shows the index, /docs files reads a topic and /docs --search <words> searches. Output stays on your device; it is not a room message. PageUp/PageDown scrolls the conversation. Use pairlobby docs --all in a shell for a full export of the manual.'}
        ],
        groups: [
            {
                id: 'docs-reference',
                title: 'Reference lookup',
                scope: 'shell',
                entries: [
                    {id: 'sh-docs', syntax: 'pairlobby docs [topic] [--search <words> | --all] [--json]', summary: 'Read the complete offline reference, or retrieve a topic or search results. --json returns structured data. --help explains usage.'},
                ],
            }, {
                id: 'docs-chat',
                title: 'Reference inside chat',
                scope: 'room',
                entries: [
                    {id: 'room-docs', syntax: '/docs [topic] | /docs --search <words> | /docs --all', summary: 'Read local documentation inside chat; nothing is sent to the room.'}
                ],
            }
        ],
    },
    {
        id: 'room-types',
        title: 'Room types, admission and moves',
        nav: 'Room types',
        blocks: [
            {kind: 'p', id: 'types-intro', text: 'Room type controls discovery and joining on your own relay. --type is for local/self-hosted creation; create online uses --private/--public account restrictions instead. Visibility controls which logged-in relay members can find a room; it does not retroactively remove existing memberships.'},
            {
                kind: 'table',
                id: 'types-table',
                caption: 'Room types',
                head: ['Type', 'Admission', 'Inviting'],
                rows: [
                    {id: 'private', cells: ['private (default)', 'An invite code is required.', 'Owner/admins, unless invite-policy members is enabled.']},
                    {id: 'protected', cells: ['protected', 'Visitors can read with the room ID; members need admission.', 'Owner/admins, unless invite-policy members is enabled.']},
                    {id: 'public', cells: ['public', 'Anyone the relay admits can join as a member; name-based joining requires a supported local/authenticated route.', 'Members may invite.']},
                    {id: 'personal', cells: ['personal', 'You and your own agents, using codes issued by you or admins.', 'Owner/admins only; codes from before the change no longer admit new members.']}
                ],
            },
            {kind: 'p', id: 'existing', text: 'Changing type does not kick people already in a room. Public-room participants can address its agents. Membership names or a human label are not an independent operating-system security boundary. Visitors and revoked members have distinct permissions; closing visitor admission does not eject a saved visitor seat.'},
            {kind: 'p', id: 'visibility', text: 'With personal-token relays, visible-to accepts everyone, default or a comma-separated set of @handles. The owner default starts as everyone. Owner/admin invites can admit people outside visibility; member-issued invites cannot bypass it. A room without a personal owner is visible to everyone on that relay. Visibility is distinct from hosted --allow account email allowlists.'},
            {kind: 'p', id: 'move', text: 'pairlobby move <room> online and the Location setting implement a source-side write freeze, streamed transfer, matching-copy verification, source close and local receiver/session repointing. Other devices follow the saved moved-to address when they next observe it, only when that address belongs to their logged-in service. Unused old invites do not transfer. Only a device holding the owner credential may initiate a move.'},
            {kind: 'note', id: 'move-availability', tone: 'caution', text: 'The account endpoint must implement /api/online/rooms/import/preflight and the import workflow. That destination API is not implemented in the current hosted Worker source. Source-side and CLI transfer tests do not establish that a move to pairlobby.com is available. Existing source rooms remain open if preflight/import fails.'},
            {kind: 'p', id: 'move-files', text: 'A supported destination preserves member IDs, credentials, history, files, request state and file deadlines. Completed moves remove ephemeral source-file copies. File-retention transfer records make older importers refuse the move instead of losing the policy.'}
        ],
        groups: [
            {
                id: 'types-shell',
                title: 'Type and visibility commands',
                scope: 'shell',
                entries: [
                    {id: 'sh-room', syntax: 'pairlobby room <room> type [private|protected|public|personal]', summary: 'Read or change a room type; changing it requires owner/admin authority.'},
                    {id: 'sh-room-invite-policy', syntax: 'pairlobby room <room> invite-policy [owner|members]', summary: 'Read or change who can mint ordinary member invites. Personal rooms remain owner/admin-only.'},
                    {id: 'sh-room-role', syntax: 'pairlobby room <room> member|admin <name-or-id>', summary: 'Change a membership role using the required moderation authority. Existing IDs and history stay intact.'},
                    {id: 'sh-visibility', syntax: 'pairlobby visibility [room] [everyone|default|@handle,@handle] [--default] [--json]', summary: 'Inspect or change room visibility, or your relay-side default with --default. Requires room-visibility and a personal login.'},
                    {id: 'sh-open-local', syntax: 'pairlobby open-local <room> [--off]', summary: 'Compatibility alias for pairlobby open. Typed rooms switch public/private; it does not publish a private cloud allowlist.'},
                    {id: 'sh-move', syntax: 'pairlobby move <room> online [--yes] [--json]', summary: 'Move to an account endpoint that supports imports. Shows the plan and confirms unless --yes is explicit; target support is required.'},
                    {id: 'sh-create-types', syntax: 'pairlobby create --name <name> [--type <type>] [--visible-to <visibility>] [--open-local] [--preset <preset|none>]', summary: 'Create with supported type, visibility and preset controls. --open-local implies public and conflicts with another explicit type.'}
                ],
            }
        ],
    },
    {
        id: 'permissions-presets',
        title: 'Permissions and saved presets',
        nav: 'Permissions',
        blocks: [
            {kind: 'p', id: 'authority', text: 'Owners/admins can manage the room. Members can attach files and may invite according to the room type/policy; moderation permissions are opt-in. Room-wide defaults can be overridden for an individual member. Member authority never works against an admin. The permission names are invite, attach, rename, lock, mute, kick, pause and turns.'},
            {kind: 'p', id: 'presets', text: 'A preset saves command permissions, turn mode, ordinary invite role and auto-close on this device. It contains no participant or credential. Apply previews the differences; applying requires confirmation. Choosing a default affects later rooms only. Deleting a preset leaves rooms already configured from it unchanged.'},
            {kind: 'example', id: 'preset-workflow', scope: 'shell', label: 'Save a setup, preview it elsewhere, then apply', code: 'pairlobby presets save team --room <ROOM>\npairlobby presets apply team --room <OTHER_ROOM>\npairlobby presets apply team --room <OTHER_ROOM> --yes\npairlobby presets default team'}
        ],
        groups: [
            {
                id: 'permissions-shell',
                title: 'Permissions and presets',
                scope: 'shell',
                entries: [
                    {id: 'sh-permissions', syntax: 'pairlobby permissions [allow|deny|reset <command ...|all> [member]]', summary: 'Inspect permission defaults and overrides, or change them as an authorized moderator.'},
                    {id: 'sh-presets', syntax: 'pairlobby presets [list|save|show|apply|delete|default <name|none>] [--room <room>] [--yes]', summary: 'Manage device-local presets; pairlobby preset is an alias.'},
                    {id: 'sh-preset', syntax: 'pairlobby preset [list|save|show|apply|delete|default <name|none>]', summary: 'Alias for pairlobby presets; use --preset on create to override the default for one new room.'}
                ],
            },
            {
                id: 'permissions-chat',
                title: 'Inside a room',
                scope: 'room',
                entries: [
                    {id: 'room-permissions', syntax: '/permissions [allow|deny|reset <command ...|all> [member]] | /perms', summary: 'Inspect or change room/member permissions. /perms is an alias.'},
                    {id: 'room-preset', syntax: '/preset [list|save|show|apply|delete|default <name|none>] | /presets', summary: 'Inspect/save presets. /preset apply <name> previews differences; append confirm to apply.'}
                ],
            }
        ],
    },
    {
        id: 'request-recovery',
        title: 'Request deadlines, failures and recovery',
        nav: 'Request recovery',
        blocks: [
            {kind: 'p', id: 'states', text: 'Requests distinguish Received, model Read, Working, waiting, reply_pending, done, no_action, declined and failed attempts. A final correlated reply resolves the obligation; a progress reply keeps it open. The transport can record Received without a model turn. A working lease is a self-report, not proof of correct work or comprehension.'},
            {kind: 'p', id: 'deadlines', text: 'Managed Codex, Claude and Qwen use a 10-minute inactivity limit and 1-hour absolute limit by default. Runtime output extends only inactivity. Device settings or per-receiver --task-idle-timeout and --task-timeout can change them from 1s to 24h; the absolute limit must be at least the idle limit. Timeout or interruption does not roll back files or other completed side effects.'},
            {kind: 'p', id: 'attempts', text: '/requests opens details, local execution attempts, failures and actions. receiver attempts lists the append-only local journal; --request filters it. Older failures have no invented attempt history. Generic uncertain failures are not automatically rerun. A recovery request names its original workspace and asks the agent to inspect partial effects first.'},
            {kind: 'p', id: 'actions', text: 'The sender or an authorized room moderator can retry or reassign a failed request. A new answer resolves the recovery chain. Dismiss archives failure without claiming success. Cancel fences unresolved work so a late answer cannot revive it. link-answer explicitly correlates an existing answer from the answering participant; cancellation/skipped turns still reject it.'},
            {kind: 'p', id: 'provider', text: 'Typed provider usage exhaustion is recorded as provider_wait. The receiver releases its speaking turn and defers work using the same provider profile until a reported reset or an explicit Retry provider now. Other providers/profiles can continue. This differs from a PairLobby quota, an inactivity timeout or an ambiguous execution failure. Retry is bounded and rechecks room authority.'},
            {kind: 'p', id: 'wait-reply', text: 'wait-reply observes one exact outgoing delivery, with a finite --wait. It does not invent a reply or turn a passive response into a new request. Native Claude watch_reply can notify the same channel conversation; managed task suspension/resumption on delegation remains unimplemented.'},
            {kind: 'example', id: 'recover', scope: 'shell', label: 'Inspect before deciding whether to retry', code: 'pairlobby requests --room <ROOM> --session <SESSION> --json\npairlobby receiver attempts --room <ROOM> --session <SESSION> --request <REQUEST>\npairlobby request retry <REQUEST> --room <ROOM> --session <SESSION>'}
        ],
        groups: [
            {
                id: 'recovery-shell',
                title: 'Request and receiver recovery',
                scope: 'shell',
                entries: [
                    {id: 'sh-request', syntax: 'pairlobby request retry|reassign|dismiss|cancel|retry-provider <request-id> [--to <name>] [--reason <text>]', summary: 'Explicit recovery/control of an addressed request. Reassign selects a target; dismissal is not completion.'},
                    {id: 'sh-receiver-attempts', syntax: 'pairlobby receiver attempts [--request <request-id>] [--room <room>] [--session <session>]', summary: 'Inspect the local receiver execution journal and exact request attempts.'},
                    {id: 'sh-receiver-provider', syntax: 'pairlobby receiver retry-provider [--room <room>] [--session <session>]', summary: 'Try a deferred provider-limited request once now, after checking its room state.'},
                    {id: 'sh-receiver-refresh', syntax: 'pairlobby receiver refresh', summary: 'Refresh stale managed receivers; idle receivers can restart now, busy ones wait for the current request, intentionally stopped ones stay stopped.'},
                    {id: 'sh-internal-refresh', syntax: 'pairlobby receiver-refresh | pairlobby receiver-refresh-one --room <room> --session <session>', summary: 'Internal update helpers. Prefer receiver refresh; these are not listening loops for an agent to launch.', access: 'Internal'}
                ],
            },
            {
                id: 'recovery-chat',
                title: 'Recovery from chat',
                scope: 'room',
                entries: [
                    {id: 'room-request-actions', syntax: '/requests retry|reassign|dismiss|cancel|retry-provider <request-id> [target-or-reason]', summary: 'Perform an allowed request action, or use the interactive /requests panel.'},
                    {id: 'room-collapse', syntax: '/collapse [message|all]', summary: 'Fold messages locally. This changes display only, not transcript retention.'},
                    {id: 'room-expand', syntax: '/expand [message|all]', summary: 'Expand a previously folded local message.'}
                ],
            }
        ],
    },
    {
        id: 'device-settings',
        title: 'Every device setting',
        nav: 'Device settings',
        blocks: [
            {kind: 'p', id: 'usage', text: 'pairlobby settings opens the device menu in a human terminal. pairlobby settings <name> reads one value; add a value to change it. --json provides script output. /settings edits the current room instead. Booleans accept on/off, true/false, yes/no and 1/0. Duration examples are 10m and 2h; expiry settings also accept never.'},
            {
                kind: 'table',
                id: 'device-settings-table',
                caption: 'Built-in defaults for this release',
                head: ['Setting', 'Default', 'Meaning'],
                rows: [
                    {id: 'default-reply-mode', cells: ['`default-reply-mode`', 'sequential', 'how agents answer in rooms you create: sequential or parallel']},
                    {id: 'default-invites', cells: ['`default-invites`', 'member', 'what a plain /invite admits in rooms you create: member or visitor']},
                    {id: 'default-guest-access', cells: ['`default-guest-access`', 'invite_only', 'whether anyone with a local room id may read it: invite-only or open']},
                    {id: 'default-private-online', cells: ['`default-private-online`', 'off', 'restrict online rooms you create to allowed accounts (create online --public overrides)']},
                    {id: 'auto-close', cells: ['`auto-close`', 'off', 'when rooms you create close themselves: off, idle:<duration>, age:<duration> or agents-and-visitors-left (for example idle:2h)']},
                    {id: 'default-expiry', cells: ['`default-expiry`', 'never', 'how long a new room lives: never, or a duration like 24h']},
                    {id: 'default-invite-expiry', cells: ['`default-invite-expiry`', 'never', 'how long a new invite code lasts: never, or a duration like 10m']},
                    {id: 'confirm-delete', cells: ['`confirm-delete`', 'on', 'ask before deleting a room, or removing one from this device']},
                    {id: 'leave-occupied-rooms', cells: ['`leave-occupied-rooms`', 'on', 'deleting a room you own while anyone else is still in it only removes it from your rooms; it carries on for them']},
                    {id: 'delete-empty-rooms', cells: ['`delete-empty-rooms`', 'on', 'deleting a room you own when no one else, person or agent, is in it deletes it for everyone with its history; off, it only leaves your rooms']},
                    {id: 'show-ids', cells: ['`show-ids`', 'off', 'print ids next to names in the live room']},
                    {id: 'icons', cells: ['`icons`', 'auto', 'how the room list marks online, network and this-device rooms: auto, nerd, emoji or symbols']},
                    {id: 'poll-interval', cells: ['`poll-interval`', '700', 'milliseconds between live-room polls']},
                    {id: 'update-check', cells: ['`update-check`', 'on', 'check GitHub whenever an interactive room or chat opens; other commands check daily in the background']},
                    {id: 'auto-update', cells: ['`auto-update`', 'off', 'install new releases without asking at interactive startup or in the background (needs update-check)']},
                    {id: 'managed-task-idle-timeout', cells: ['`managed-task-idle-timeout`', '10m', 'stop a managed agent request after no runtime output for this duration (1s–24h)']},
                    {id: 'managed-task-timeout', cells: ['`managed-task-timeout`', '1h', 'stop a managed agent request after this total elapsed time even while active (1s–24h; at least the inactivity limit)']},
                    {id: 'allow-manual-receive', cells: ['`allow-manual-receive`', 'off', 'user permission to use --manual-receive on this device; off by default. Automatic receiving stays the default even when allowed']},
                    {id: 'network-sharing', cells: ['`network-sharing`', 'off', 'which other devices may join rooms on this device\'s relay: off, tailscale or lan; restart the relay to apply']},
                    {id: 'network-rooms', cells: ['`network-rooms`', 'on', 'list rooms open to the local network or tailnet beside your own; searches the network when the room list refreshes']}
                ],
            },
            {kind: 'p', id: 'manual-policy', text: 'Allow manual receiving is a user-only interactive setting. It is off by default; users and agents cannot use --manual-receive until the user allows it. Granting permission does not change the automatic-receiving default. Reset turns the permission off again. Agents must not edit settings or disguise their identity to bypass this rule.'},
            {kind: 'p', id: 'network-apply', text: 'Changing network-sharing requires restarting the relay. Off restricts access to this device; LAN uses plain HTTP; Tailscale relies on the configured tailnet. network-rooms controls discovery, not whether your own relay is reachable. Do not confuse room visibility with network reachability.'},
            {kind: 'p', id: 'other-controls', text: 'The settings menu also offers profile name, saved service endpoints, applying auto-close to existing rooms and reset. Apply-existing previews/confirms room changes; unreachable or unauthorized rooms are reported separately. Reset preserves the profile name and saved endpoints. Profiles, room presets and relay environment variables have their own commands/sections.'},
            {kind: 'p', id: 'data-location', text: 'CLI state defaults to ~/Library/Application Support/PairLobby on macOS, %APPDATA%/PairLobby on Windows, and $XDG_DATA_HOME/pairlobby (or ~/.local/share/pairlobby) on Linux. PAIRLOBBY_DATA_DIR overrides it. Device registry, credentials.json, profile.json, settings.json and receiver inboxes are local state; rooms.sqlite is the relay database. A serve --data-dir override selects the relay database location. Keep credentials out of messages and use the supported settings commands rather than bypassing permission checks by editing files.'},
            {kind: 'example', id: 'set-timeouts', scope: 'shell', label: 'Set finite managed-request limits', code: 'pairlobby settings managed-task-idle-timeout 15m\npairlobby settings managed-task-timeout 2h\npairlobby settings --json'}
        ],
        groups: [
            {
                id: 'settings-commands',
                title: 'Reading and changing defaults',
                scope: 'shell',
                entries: [
                    {id: 'sh-settings-one', syntax: 'pairlobby settings [name] [value] [--json] [--reset] [--apply-existing] [--yes]', summary: 'Inspect device defaults or open the menu. --apply-existing applies the selected auto-close policy to rooms you administer after confirmation. --reset restores built-ins.'},
                    {id: 'sh-profile-username', syntax: 'pairlobby profile --username <handle>', summary: 'Choose the account handle used by hosted invitations. It is separate from per-room display names.'}
                ],
            }
        ],
    },
    {
        id: 'directory',
        title: 'Agent directory and contacts',
        nav: 'Agent directory',
        blocks: [
            {kind: 'p', id: 'requirements', text: 'Directory sharing requires a relay advertising member-tokens, directory and directory-contact, plus a personal login. The shared team token is not a personal identity. A human shares an agent from an open room after reviewing the public listing; agents cannot enable sharing themselves.'},
            {kind: 'p', id: 'listing', text: 'A listing exposes its owner, agent name, topic, accepted contact mode and reported presence, not room IDs or credentials. The receiver or native channel sends a heartbeat each minute and on state changes. Three minutes without one reads as offline. Presence is not proof that provider authentication or a future task will succeed.'},
            {kind: 'p', id: 'contact', text: 'pairlobby @handle or directory shows visible listings. Contacting one obtains a single-use short-lived room admission, reuses an existing seat when possible, and opens chat addressed to that agent. Visibility hides unavailable listings with the same response as an unknown listing. Contacts remain visible to other room members; they are not a private channel.'},
            {kind: 'p', id: 'questions', text: 'Directory-origin requests include their origin. Listings default to questions: managed runtimes receive them with read-only capabilities. --contact tasks explicitly allows authorized work. A room message cannot expand runtime permissions or obtain unavailable interactive approvals.'},
            {kind: 'example', id: 'share', scope: 'shell', label: 'Review and share an agent, then discover it', code: 'pairlobby share --room <ROOM> --session <AGENT_SESSION> --topic "Payment reconciliation"\npairlobby shared --json\npairlobby directory --owner <handle> --json\npairlobby contact <LISTING_ID> --json'}
        ],
        groups: [
            {
                id: 'directory-commands',
                title: 'Sharing and reaching agents',
                scope: 'shell',
                entries: [
                    {id: 'sh-share', syntax: 'pairlobby share [--topic <text>] [--contact questions|tasks] [--yes] [--off] [--room <room>] [--session <agent-session>]', summary: 'A human reviews/shares a saved agent or stops sharing it. --yes explicitly accepts the displayed listing plan.'},
                    {id: 'sh-shared', syntax: 'pairlobby shared [--json]', summary: 'List this device’s shared agents and last reported heartbeat.'},
                    {id: 'sh-directory', syntax: 'pairlobby directory [--owner <handle>] [--json] | pairlobby @<handle>', summary: 'Browse agents visible to your personal relay identity. Enter on a listing contacts it.'},
                    {id: 'sh-contact', syntax: 'pairlobby contact <listing-id> [--json]', summary: 'Contact a visible listing. JSON mode returns admission/session information without opening interactive chat.'}
                ],
            }
        ],
    },
    {
        id: 'team-relays',
        title: 'Private endpoints and personal tokens',
        nav: 'Team relays',
        blocks: [
            {kind: 'p', id: 'setup', text: 'pairlobby setup <url> reads service discovery, shows the endpoint and asks a human before saving it. It does not create an account or run a relay. Agents are refused interactive setup; a room task does not authorize changing the device’s account endpoint. Named endpoints keep separate logins; credentials go only to their issuing origin.'},
            {kind: 'p', id: 'capabilities', text: 'A browser account endpoint may provide signup, device login, online rooms and invitations. A token-only relay offers token login and room APIs, not hosted account pages or invitation-by-handle APIs. setup --show and doctor distinguish these. Explicit --relay/--login overrides are for an operator-provided address that lacks discovery; inspect the result before accepting it.'},
            {kind: 'p', id: 'tokens', text: 'Operators run pairlobby-relay member-token <handle> --name <name> to generate a token and its JSONL digest record. The members file stores handle, name and tokenSha256. Revoking/removing a valid row is noticed within a minute or on SIGHUP. An unreadable/malformed file keeps the previous valid members and logs the problem. Personal-token login needs PAIRLOBBY_LOGIN_MODE=token and PAIRLOBBY_MEMBERS_FILE; PAIRLOBBY_TEAM_TOKEN_LOGIN=off disables login with the shared create token.'},
            {kind: 'p', id: 'visibility', text: 'Personal tokens enable owner visibility defaults and the agent directory on the Node team relay. The standalone Durable Object adapter supports create-token authorization but does not provide the Node token-login/member-file directory endpoints. Use its explicit --server address and configured PAIRLOBBY_CREATE_TOKEN for creation. A valid room invite and personal account permissions remain distinct.'},
            {kind: 'example', id: 'endpoints', scope: 'shell', label: 'Inspect and select a company endpoint', code: 'pairlobby setup https://relay.example.com\npairlobby setup --show --json\npairlobby setup --use <name>\npairlobby doctor --server https://relay.example.com --json'}
        ],
        groups: [
            {
                id: 'endpoint-commands',
                title: 'Service selection',
                scope: 'shell',
                entries: [
                    {id: 'sh-setup', syntax: 'pairlobby setup [url] [--show | --use <name> | --remove <name> | --reset] [--relay <url>] [--login token|browser|none] [--yes] [--json]', summary: 'Discover or manage saved service endpoints. --endpoint <name-or-url> overrides one command without changing the default.'},
                    {id: 'sh-doctor', syntax: 'pairlobby doctor [--server <url>] [--endpoint <name-or-url>] [--json]', summary: 'Read the selected relay’s version, protocol, features, transport and limits. It does not verify model access or execute a task.'}
                ],
            }
        ],
    },
    {
        id: 'relays',
        title: 'Local relays, networks, containers and backups',
        nav: 'Relay operation',
        blocks: [
            {kind: 'p', id: 'node', text: 'pairlobby serve runs the Node/SQLite relay on loopback port 8790 by default. Store its data directory on persistent storage. Use one active Node relay per data directory: a multi-replica notification/timer/rate-limit/backup system does not ship here. The relay coordinates local agents; it does not run inference.'},
            {kind: 'p', id: 'sharing', text: 'For another device, select network-sharing tailscale or lan and restart the relay, or explicitly use serve --tailscale/--lan. Peers must reach the advertised address. Tailscale requires an installed, connected tailnet; LAN traffic is plain HTTP. Tailnet discovery checks the standard port. A macOS terminal may need Local Network permission. A typed public room allows name-based joining only where the relay can establish local/authenticated access.'},
            {kind: 'p', id: 'proxy', text: 'Behind a proxy, set the public URL and accepted Host values. Set --trusted-proxy-header only when all traffic goes through the trusted proxy; the relay uses the right-most forwarded address. --proxy-is-access-gate explicitly says that the proxy admits only permitted callers and enables authenticated/name-based discovery there. Binding 0.0.0.0 alone is not access control.'},
            {kind: 'p', id: 'service', text: 'pairlobby service install|status|restart|refresh|logs|uninstall manages the background relay. macOS uses a LaunchAgent and Linux a user systemd service. A Windows scheduled-task path exists but is not runtime-qualified. The container entry point is pairlobby-relay from @pairlobby/local-server; it requires PAIRLOBBY_DATA_DIR, honors the same settings, logs metadata and makes a final backup on graceful shutdown.'},
            {
                kind: 'table',
                id: 'relay-variables',
                caption: 'Node relay environment settings; an explicit matching flag wins',
                head: ['Variable', 'Flag', 'Meaning'],
                rows: [
                    {id: 'pairlobby-host', cells: ['`PAIRLOBBY_HOST`', '`--host`', 'address to listen on; `0.0.0.0` in a container']},
                    {id: 'pairlobby-port', cells: ['`PAIRLOBBY_PORT`', '`--port`', 'default 8790']},
                    {id: 'pairlobby-data-dir', cells: ['`PAIRLOBBY_DATA_DIR`', '`--data-dir`', 'where `rooms.sqlite` lives; put it on a volume']},
                    {id: 'pairlobby-public-url', cells: ['`PAIRLOBBY_PUBLIC_URL`', '`--public-url`', 'the address invites show, such as `https://pairlobby.example.com`; its host is accepted']},
                    {id: 'pairlobby-trusted-proxy-header', cells: ['`PAIRLOBBY_TRUSTED_PROXY_HEADER`', '`--trusted-proxy-header`', 'header with the caller\'s address, such as `x-forwarded-for`']},
                    {id: 'pairlobby-proxy-is-access-gate', cells: ['`PAIRLOBBY_PROXY_IS_ACCESS_GATE`', '`--proxy-is-access-gate`', '`1` when only people allowed to use the relay can reach the proxy in front of it, so everyone it lets through may find and join rooms by name (see [Joining by name](#joining-by-name-without-an-invite)); needs a public URL or trusted proxy header']},
                    {id: 'pairlobby-allowed-hosts', cells: ['`PAIRLOBBY_ALLOWED_HOSTS`', '', 'more exact `Host` values to accept, comma separated, such as `relay.internal`']},
                    {id: 'pairlobby-create-token', cells: ['`PAIRLOBBY_CREATE_TOKEN`', '', 'token needed to create rooms (environment only)']},
                    {id: 'pairlobby-create-token-file', cells: ['`PAIRLOBBY_CREATE_TOKEN_FILE`', '', 'the same token read from a file only its owner can read (`chmod 600`); not with the variable']},
                    {id: 'pairlobby-request-log', cells: ['`PAIRLOBBY_REQUEST_LOG`', '`--request-log`', '`all`, `writes` (skips successful reads, which waiting clients repeat) or `off` (default)']},
                    {id: 'pairlobby-receipt-mode', cells: ['`PAIRLOBBY_RECEIPT_MODE`', '', '`both` (default), `watermark` or `events`: how plain Received receipts are kept (see Message receipts)']},
                    {id: 'pairlobby-backup', cells: ['`PAIRLOBBY_BACKUP`', '`--backup`', 'where to copy the rooms: `s3://bucket/prefix` or an absolute folder']},
                    {id: 'pairlobby-backup-interval', cells: ['`PAIRLOBBY_BACKUP_INTERVAL`', '', 'seconds between checks for changes (60)']},
                    {id: 'pairlobby-backup-keep', cells: ['`PAIRLOBBY_BACKUP_KEEP`', '', 'copies to keep (48)']},
                    {id: 'pairlobby-backup-s3-endpoint', cells: ['`PAIRLOBBY_BACKUP_S3_ENDPOINT`', '', 'an S3-compatible endpoint such as Cloudflare R2 or MinIO; absent means AWS']},
                    {id: 'pairlobby-no-restore', cells: ['`PAIRLOBBY_NO_RESTORE`', '`--no-restore`', '`1` starts empty on an empty disk instead of from the newest copy']},
                    {id: 'pairlobby-limit-create-per-min-ip', cells: ['`PAIRLOBBY_LIMIT_CREATE_PER_MIN_IP`', '', 'rooms one caller may create a minute (10)']},
                    {id: 'pairlobby-limit-redeem-per-min-ip', cells: ['`PAIRLOBBY_LIMIT_REDEEM_PER_MIN_IP`', '', 'invite codes one caller may try a minute (20)']},
                    {id: 'pairlobby-limit-redeem-per-min-global', cells: ['`PAIRLOBBY_LIMIT_REDEEM_PER_MIN_GLOBAL`', '', 'invite codes the whole relay accepts a minute (300)']},
                    {id: 'pairlobby-limit-account-check-per-min-ip', cells: ['`PAIRLOBBY_LIMIT_ACCOUNT_CHECK_PER_MIN_IP`', '', 'team token checks one caller may make a minute, counted apart from creating rooms (30)']},
                    {id: 'pairlobby-limit-directory-per-min-member', cells: ['`PAIRLOBBY_LIMIT_DIRECTORY_PER_MIN_MEMBER`', '', 'directory reads one member may make a minute (60)']},
                    {id: 'pairlobby-limit-contact-per-min-member', cells: ['`PAIRLOBBY_LIMIT_CONTACT_PER_MIN_MEMBER`', '', 'shared agents one member may contact a minute (10)']},
                    {id: 'pairlobby-limit-contact-per-hour-listing', cells: ['`PAIRLOBBY_LIMIT_CONTACT_PER_HOUR_LISTING`', '', 'contacts one shared agent may receive an hour (30)']},
                    {id: 'pairlobby-login-mode', cells: ['`PAIRLOBBY_LOGIN_MODE`', '', '`token` lets people log in with the create token as a team token, or with their own token; `none` (default) offers no login']},
                    {id: 'pairlobby-members-file', cells: ['`PAIRLOBBY_MEMBERS_FILE`', '', 'personal tokens: one JSON line per person (`pairlobby-relay member-token` prints it); reread within a minute of a change and on `SIGHUP`; needs `PAIRLOBBY_LOGIN_MODE=token`']},
                    {id: 'pairlobby-team-token-login', cells: ['`PAIRLOBBY_TEAM_TOKEN_LOGIN`', '', '`on` (default) or `off`: whether the create token still logs people in beside personal tokens']},
                    {id: 'pairlobby-discovery-name', cells: ['`PAIRLOBBY_DISCOVERY_NAME`', '', 'the name `pairlobby setup` shows, up to 64 characters']},
                    {id: 'pairlobby-login-help', cells: ['`PAIRLOBBY_LOGIN_HELP`', '', 'one or two sentences shown above the token prompt, up to 300 characters']},
                    {id: 'pairlobby-support-url', cells: ['`PAIRLOBBY_SUPPORT_URL`', '', 'an https page for help, shown by `pairlobby setup --show`']},
                    {id: 'pairlobby-room-max-participants', cells: ['`PAIRLOBBY_ROOM_MAX_PARTICIPANTS`', '', 'people, visitors and agents in one room (32)']},
                    {id: 'pairlobby-room-max-events', cells: ['`PAIRLOBBY_ROOM_MAX_EVENTS`', '', 'events a room keeps before it refuses new messages (40000)']},
                    {id: 'pairlobby-room-max-history-mb', cells: ['`PAIRLOBBY_ROOM_MAX_HISTORY_MB`', '', 'MiB of history a room keeps (32)']},
                    {id: 'pairlobby-room-max-message-kb', cells: ['`PAIRLOBBY_ROOM_MAX_MESSAGE_KB`', '', 'KiB in one message (32)']},
                    {id: 'pairlobby-room-max-file-mb', cells: ['`PAIRLOBBY_ROOM_MAX_FILE_MB`', '', 'MiB in one file, at most 95; `0` turns attachments off (95)']},
                    {id: 'pairlobby-room-max-files-mb', cells: ['`PAIRLOBBY_ROOM_MAX_FILES_MB`', '', 'MiB of files a room keeps (512)']}
                ],
            },
            {kind: 'p', id: 'backups', text: '--backup accepts an absolute folder (or file:// path) or s3://bucket/prefix. Backups default to every 60 seconds with 48 retained snapshots; PAIRLOBBY_BACKUP_INTERVAL is 10–86400 seconds and PAIRLOBBY_BACKUP_KEEP is 1–10000. The S3 client uses AWS credentials/roles and AWS_REGION or AWS_DEFAULT_REGION (default us-east-1); an S3-compatible origin uses PAIRLOBBY_BACKUP_S3_ENDPOINT. A missing local database can restore from backup; --no-restore or PAIRLOBBY_NO_RESTORE disables that. An existing database is not overwritten.'},
            {kind: 'p', id: 'backup-boundary', text: 'A backup is a historical database snapshot. Room or file deletion removes active relay data, while older backups follow backup retention; do not treat a file lifetime as a guarantee that historical backups are erased. Keep old writers stopped before opening an upgraded database. Schema 3 rejects older binaries on open; rollback requires a suitable pre-upgrade backup.'},
            {kind: 'p', id: 'transport', text: 'Node uses long-poll with a maximum 25-second wait and HTTP replay. Standalone and hosted Durable Objects use hibernating WebSockets plus HTTP replay; read cursors and revisions recover missed updates. Receipts can use legacy events, watermarks or both. Portability contracts cover protocol behavior; no native Lambda, Azure Functions, GCP serverless or Postgres adapter ships in this codebase.'},
            {kind: 'example', id: 'container', scope: 'shell', label: 'Run the relay with persistent data', code: 'PAIRLOBBY_DATA_DIR=/data PAIRLOBBY_HOST=0.0.0.0 pairlobby-relay'},
            {kind: 'example', id: 'backup-example', scope: 'shell', label: 'Keep local backups', code: 'pairlobby serve --data-dir /path/to/relay-data --backup /path/to/relay-backups'}
        ],
        groups: [
            {
                id: 'relay-shell',
                title: 'Relay administration',
                scope: 'shell',
                entries: [
                    {id: 'sh-service', syntax: 'pairlobby service install|status|restart|refresh|logs|uninstall', summary: 'Manage the background Node relay on supported operating systems. These commands affect processes; documentation lookup does not.'},
                    {id: 'sh-serve-complete', syntax: 'pairlobby serve [--host <address>] [--port <port>] [--data-dir <directory>] [--lan | --tailscale] [--public-url <url>] [--trusted-proxy-header <header>] [--proxy-is-access-gate] [--request-log all|writes|off] [--backup <folder-or-s3-url>] [--no-restore]', summary: 'Start a relay using explicit flags and PAIRLOBBY_* settings. Room creation tokens are environment/file inputs, never command-line secret arguments.'},
                    {id: 'sh-relay-binary', syntax: 'pairlobby-relay [check <url> | member-token <handle> --name <name>]', summary: 'Standalone entry point from @pairlobby/local-server. check performs a create/join/send/read/delete probe, so use an authorized test deployment; member-token generates a personal token and digest record.'}
                ],
            }
        ],
    },
    {
        id: 'command-scope',
        title: 'Command scope, aliases and internal tools',
        nav: 'Command scope',
        blocks: [
            {kind: 'p', id: 'scope', text: 'Most room commands accept --room and --session; agent callers should supply both to avoid adopting another saved identity. --json returns structured output. --server selects a relay; --endpoint selects a saved service. --local explicitly chooses the local relay. These choices do not grant permissions. --help and --version describe the installed CLI. docs is offline and takes no room/session/endpoint options.'},
            {kind: 'p', id: 'identities', text: '--as sets a display name; it does not choose a runtime or grant human authority. --human/--agent select membership intent; --runtime selects codex, claude or qwen when detection is unavailable. --model, --effort and --workdir apply to managed execution where supported. --conversation records a known runtime conversation ID; it does not attach an arbitrary running conversation.'},
            {kind: 'p', id: 'cursors', text: 'read can use --after <seq>, --all, --wait <seconds> and --interval <ms>; normal delivery updates local cursors and transport receipts. read/wait is not a replacement for a configured managed receiver. find is a one-shot discovery/metadata check and sends no message acknowledgements. Use exact event or delivery IDs for --reply-to, request actions and --turn-token; preserve a --claim-id when retrying a cooperative claim.'},
            {kind: 'p', id: 'flags', text: '--once and --expires-in apply to invites; --expiry configures a room deadline. --name, --type, --visible-to, --open-local and --preset configure creation. --private/--public and --allow apply to hosted account restrictions. --yes accepts an operation’s explicit confirmation; --force can override delete safeguards or back up/replace an installed skill. --clear clears profile fields. Review the command-specific behavior before using them.'},
            {kind: 'p', id: 'hooks', text: '--allow-from scopes a native Claude channel to named senders; --request scopes the receiver tool bridge. --out chooses a save/export directory; --file supplies attachments or a handover document according to the command. --template prints a handover starter, --handover-id and --revision target an exact revision. Pause ack reports an explicit --outcome rather than claiming cancellation it did not observe.'},
            {kind: 'p', id: 'updates', text: 'update --check checks availability; --yes accepts installation. --background is used by update scheduling. Installation changes new processes and can refresh idle receivers; a busy receiver waits for its current request. Intentionally stopped receivers stay stopped and open human terminals keep their current process. --sort and --desc affect room-list order. --active affects discovery; --default affects visibility defaults; --owner filters the directory; --contact and --topic describe sharing.'}
        ],
        groups: [
            {
                id: 'compatibility-aliases',
                title: 'Aliases and local display',
                scope: 'shell',
                entries: [
                    {id: 'sh-file-alias', syntax: 'pairlobby file [get <file>] [--out <directory>]', summary: 'Alias for pairlobby files.'},
                ],
            }, {
                id: 'compatibility-room-aliases',
                title: 'Room aliases and invitation management',
                scope: 'room',
                entries: [
                    {id: 'room-exit', syntax: '/exit', summary: 'Alias for /quit. Leaves the terminal view; it does not prove a managed receiver stopped.'},
                    {id: 'room-invites', syntax: '/invites [revoke @<handle>]', summary: 'Inspect hosted account invitations or withdraw an unanswered invitation. An accepted membership is removed with /kick instead.'}
                ],
            }
        ],
    },
    {
        id: 'protocol',
        title: 'HTTP API, ordering and compatibility',
        nav: 'API and compatibility',
        blocks: [
            {kind: 'p', id: 'authority', text: 'The relay assigns event IDs, ordered sequence numbers and sender identity. Room credentials, controller credentials, personal login tokens and account tokens have different scopes. API calls use the protocol-version header and the credential appropriate to the operation; a display name or a supplied participant ID does not authenticate a caller.'},
            {kind: 'table', id: 'api-surfaces', caption: 'Main API surfaces; optional features must be advertised', head: ['Surface', 'Purpose'], rows: [
                {id: 'health', cells: ['GET /health; GET /v1/server', 'Health and relay version, limits, features, receipt mode and transport.']},
                {id: 'room', cells: ['GET /v1/rooms/<room-id>', 'Authorized room snapshot, memberships, state/revision and retention bounds.']},
                {id: 'events', cells: ['GET/POST /v1/rooms/<room-id>/events', 'Paged ordered reads and idempotent event submission. after is a transcript cursor; hasMore and cursor_gap must be handled.']},
                {id: 'requests', cells: ['/v1/rooms/<room-id>/requests; /turns', 'Recipient obligations, correlated replies, action stages and speaking leases.']},
                {id: 'receipts', cells: ['POST /v1/rooms/<room-id>/receipts', 'Transport watermarks. They do not imply model Read, completed work or saved-file confirmation.']},
                {id: 'files', cells: ['/v1/rooms/<room-id>/files; /files/<file-id>/receipt', 'Staged authenticated uploads, verified downloads and explicit file receipts when file-retention is supported.']},
                {id: 'connect', cells: ['/v1/rooms/<room-id>/connect-ticket; /connect', 'Short-lived single-use WebSocket admission; durable HTTP replay repairs gaps.']},
                {id: 'export', cells: ['GET /v1/rooms/<room-id>/export', 'Authorized JSON or streamed NDJSON history export, with completeness and file metadata.']},
                {id: 'directory', cells: ['/v1/directory; /v1/directory/defaults', 'Personal-member discovery and visibility on adapters that implement those features.']},
                {id: 'discovery', cells: ['GET /.well-known/pairlobby.json; /api/online/account', 'Configured endpoint discovery and token login on the Node team relay. Not every adapter supplies these account/discovery paths.']}
            ]},
            {kind: 'p', id: 'compatibility', text: 'Use pairlobby doctor and the snapshot’s capability fields rather than inferring support from a URL or version alone. The shared packages define wire schemas and typed errors; @pairlobby/client/http is the portable HTTP entry, while device registry APIs belong on the local machine. Unsupported features fail explicitly instead of silently changing behavior.'},
            {kind: 'p', id: 'replay', text: 'Event pages have both record and byte bounds. Persist the cursor after handling delivery, continue while hasMore is true, and recover from cursor_gap using the reported earliest available sequence. State-only updates can advance revisions without appending a transcript event. Socket notifications and long-poll wakeups are hints to replay authoritative state, not proof that an agent received or understood a request.'},
            {kind: 'p', id: 'idempotency', text: 'Keep an idempotency key stable when retrying the same event operation after a lost response. Reusing it for different content is an error. HTTP idempotency does not undo or deduplicate a model’s external filesystem/tool effects; uncertain execution requires explicit recovery and inspection.'},
            {kind: 'p', id: 'storage', text: 'Live files are stored as bounded chunks separately from event metadata. Old history may be hidden or archived by the hosted policy, so exports report whether retained history is complete and record missing files. Deadline enforcement can change room lifecycle during an ordinary request. Backups and downloaded copies have their own lifetimes.'},
            {kind: 'p', id: 'source', text: 'The precise request/response schemas, error codes and capability strings are maintained in the protocol package; every adapter is checked against the shared room/file/invite contracts and HTTP conformance suite. Passing those fixtures is distinct from testing a live provider, every terminal host or a multi-node deployment.'}
        ]
    },
    {
        id: 'troubleshooting',
        title: 'Troubleshooting',
        nav: 'Troubleshooting',
        blocks: [
            {kind: 'list', id: 'faq', items: [
                {id: 'ambiguous', text: '**“More than one room” or “more than one session”:** pass `--room <room-id>` and `--session <session-id>`; `pairlobby list` and `pairlobby status --json` show them.'},
                {id: 'available-no-answer', text: '**An agent is available but never answers:** available only means the receiver runs. Check that its runtime is signed in, that the message addressed it, and whether a sequential turn is held by someone else (`/turns`).'},
                {id: 'waiting', text: '**Everything waits for one agent:** the room is sequential. The owner can run `/turns parallel`; each agent still works one request at a time.'},
                {id: 'no-seen', text: '**Received but not Read:** transport delivery is confirmed, but the model has not explicitly declared reading. This is expected for passive traffic; do not wake every model just to change the badge. Historical receipts stay Received. Reopen chat and restart updated receivers to use the new stages; old relays need a server update. A standalone answer does not resolve an earlier failed request until its author explicitly links it.'},
                {id: 'passive-send', text: '**`pairlobby send` asked nobody:** add `--to <name>` or `--to all`.'},
                {id: 'spawn-fails', text: '**A spawn fails:** install and sign into the runtime first. For Qwen, remove `--effort`. If it printed an operation id, finish it with `--resume <operation-id>`.'},
                {id: 'stop-running', text: '**Something kept running after a stop or pause:** stopping, pausing, skipping and cancelling are not verified interruptions of tools already running. Check the agent’s own processes.'},
                {id: 'copy', text: '**Copying text in chat:** double-click a word or triple-click a line. For anything else press F4, select, copy with your terminal, then F4 again. In the agent table, double-click a cell.'},
                {id: 'stale-cli', text: '**A command here is missing:** your installed version may be older. `pairlobby update` installs the newest release.'}
            ]}
        ]
    },
    {
        id: 'planned',
        title: 'Planned and unverified',
        nav: 'Planned',
        blocks: [
            {kind: 'p', id: 'intro', text: 'None of the following is available as a working command today.'},
            {kind: 'list', id: 'items', items: [
                {id: 'interrupt', text: 'Verified cancellation of every tool an agent started. Current managed-turn interruption reports the runtime outcome, including when tool cancellation remains unknown.'},
                {id: 'continuation', text: 'Suspending and automatically resuming a managed receiver task when another agent answers, including releasing its speaking turn. Explicit reply subscriptions for an activated native Claude channel are available.'},
                {id: 'spawn-more', text: 'Agent-initiated, remote-device, extra-window or browser-triggered spawning.'},
                {id: 'models', text: 'Complete provider model and effort catalogs, saved runtime presets, shared model metadata, and Qwen effort overrides.'},
                {id: 'deepseek', text: 'A managed DeepSeek runtime.'},
                {id: 'discovery', text: 'Account-wide or network discovery, a mobile app, and QR joining.'},
                {id: 'files', text: 'File transfer, a task board, and inference hosting.'},
                {id: 'service', text: 'Receiver auto-start after reboot, a Linux relay service, and broad Windows, Warp and native graphics acceptance.'},
                {id: 'evidence', text: 'Overnight idle soak, hosted receiver stress and reconnection, native Claude channel acceptance, and live billing all still need separate evidence.'}
            ]}
        ]
    }
];

export const COMMAND_GROUPS: CommandGroup[] = SECTIONS.flatMap((section) => section.groups ?? []);
export const COMMANDS: CommandEntry[] = COMMAND_GROUPS.flatMap((group) => group.entries);

function referenceBlockText(block: Block): string {
    if ('text' in block) {
        return block.text;
    }
    if (block.kind === 'example') {
        return `${block.label} ${block.code}`;
    }
    if (block.kind === 'table') {
        return `${block.caption} ${block.head.join(' ')} ${block.rows.flatMap((row) => row.cells).join(' ')}`;
    }
    if (block.kind === 'list') {
        return block.items.map((item) => item.text).join(' ');
    }
    return block.kind === 'features' ? FEATURES.map((feature) => `${feature.title} ${feature.text}`).join(' ') : '';
}

/** One search definition for offline reference lookup, managed tools and the website. */
export function searchDocumentation(query: string): ReferenceSearch {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    return {
        commands: COMMANDS.filter((entry) => matchesCommand(entry, query)),
        features: words.length ? FEATURES.filter((feature) => matches(`${feature.title} ${feature.text}`)) : [],
        topics: words.length ? SECTIONS.filter((section) => matches(`${section.title} ${section.blocks.map(referenceBlockText).join(' ')}`)).map(({id, title}) => ({id, title})) : []
    };
}

/** Every term must appear in the entry, so narrowing a search never widens it. */
export function matchesCommand(entry: CommandEntry, query: string): boolean {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
        return true;
    }
    const haystack = [entry.syntax, entry.summary, entry.access ?? '', entry.example ?? '', ...(entry.details ?? [])].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
}

export type InlinePart = {kind: 'text' | 'code' | 'strong'; text: string} | {kind: 'link'; text: string; href: string};

/** Splits `code`, **strong** and [label](href) out of a sentence. */
export function parseInline(text: string): InlinePart[] {
    const parts: InlinePart[] = [];
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (index > last) {
            parts.push({kind: 'text', text: text.slice(last, index)});
        }
        if (match[1] !== undefined) {
            parts.push({kind: 'code', text: match[1]});
        } else if (match[2] !== undefined) {
            parts.push({kind: 'strong', text: match[2]});
        } else {
            parts.push({kind: 'link', text: match[3] ?? '', href: match[4] ?? ''});
        }
        last = index + match[0].length;
    }
    if (last < text.length) {
        parts.push({kind: 'text', text: text.slice(last)});
    }
    return parts;
}

/** Splits <placeholder> segments out of a command, so they render as placeholders. */
export type PlaceholderPart = {text: string; placeholder: boolean};

export function splitPlaceholders(code: string): PlaceholderPart[] {
    return code.split(/(<[^<>\s]+(?: [^<>]+)?>)/).filter(Boolean).map((text) => ({text, placeholder: /^<[^<>]+>$/.test(text)}));
}

/** Every element id the page derives from this catalog, for a uniqueness test. */
export function catalogIds(): string[] {
    const ids: string[] = [];
    for (const section of SECTIONS) {
        ids.push(`docs-${section.id}`);
        for (const block of section.blocks) {
            ids.push(`docs-${section.id}-${block.id}`);
            if (block.kind === 'list') {
                ids.push(...block.items.map((item) => `docs-${section.id}-${block.id}-${item.id}`));
            }
            if (block.kind === 'table') {
                ids.push(...block.rows.map((row) => `docs-${section.id}-${block.id}-${row.id}`));
            }
        }
        for (const group of section.groups ?? []) {
            ids.push(`docs-${group.id}`);
            ids.push(...group.entries.map((entry) => `docs-cmd-${entry.id}`));
        }
    }
    ids.push(...FEATURES.map((feature) => `docs-feature-${feature.id}`));
    return ids;
}

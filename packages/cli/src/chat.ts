//! The interactive room: live messages above, your input below.
//!
//! This is where a human actually sits. Joining a room puts you here, not back
//! at a shell prompt with a transcript printed behind you.

import type {Interface} from 'node:readline';
import {ChatTerminal} from './chat-terminal.js';

import {ProtocolError, requestState, newId, messageActionLabel, failureLabel} from '@pairlobby/protocol';
import type {Attachment, MessageRequest, RoomEvent, RoomSnapshot, TurnQueue} from '@pairlobby/protocol';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';

import {pickExpiry} from './picker.js';
import {isRoomCommand, runRoomCommand} from './chat-commands.js';
import {attachmentLabel, attachmentText, expandPath, filesReport, findRoomFile, previewFile, saveFile, splitAttachCommand, uploadFiles} from './files.js';
import {isPresetCommand, runPresetCommand} from './presets.js';
import {authorityFor, describeParticipantPermissionChange, describeRoomPermissionChange, notPermitted} from './permissions.js';
import {applyMention, commonPrefix, currentMention, hasAgentsToAsk, matchNames, renderSuggestions, routeChatMessage, routeForRoom} from './mentions.js';
import type {RoutedChatMessage} from './mentions.js';
import {formatTurnQueue} from './turn-commands.js';
import {sendChatReply} from './chat-reply.js';
import {runAgentCommand} from './spawn-agent.js';
import {isAgentCommand} from './spawn-options.js';
import {commandHint, completeChatCommand} from './chat-completion.js';
import {settingsPage, statusPage} from './room-settings.js';
import {describeAutoClose, describeCloseReason} from './auto-close.js';
import {loadAgentRoster} from './agent-roster.js';
import {offlineReceivers, wakeOfflineReceivers} from './receiver.js';
import {invitationTerms} from './render.js';
import {closeRequest, recoverRequest} from './request-recovery.js';
import {requestsPage} from './request-panel.js';
import {collapseMessage, formatMessageText} from './message-format.js';

type ParticipantMatch = {id: string; name: string} | null;

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

export interface ChatOptions {
    /** Guests may watch and leave; the composer is disabled for them. */
    readOnly?: boolean;
    requireHuman?: boolean;
    useHumanProfile?: boolean;
    store: LocalStore;
    client: PairLobbyClient;
    roomId: string;
    credential: string;
    sessionId: string;
    participantId: string;
    /** Present when this device holds the controller credential, enabling /pause and /resume. */
    controllerCredential?: string | undefined;
    intervalMs?: number;
    /** Print participant ids beside names, which matters when two agents share one. */
    showIds?: boolean;
    /** Start from the beginning of retained history rather than from the live edge. */
    fromStart?: boolean;
}

const HELP = `  <message>          address all eligible agents (same as @all)
  /claude [model]    spawn a Claude agent (--name, --effort, --workdir)
  /codex [model]     spawn a Codex agent (--name, --effort, --workdir)
  /qwen [model]      spawn a Qwen agent (--name, --workdir)
  /spawn --help      spawn options and recovery commands
  /agents           table of all room agents; double-click a cell to copy
  /status           room message count, members, activity and dates
  /settings         interactively edit room settings and manage members
  /agent start|stop <name or id>  manage a spawned receiver
  @name anywhere    send to that participant (e.g. Hey @codex, hello)
  @codex @claude    ask multiple agents; @all asks all eligible agents
  /turns            show the speaking queue
  /turns sequential|parallel  set response mode (owner/admin)
  /turns skip [name or request]  skip a queued or stalled turn (owner/admin, or members the room allows)
  /turns cancel [request]  cancel the active group round (owner/admin, or members the room allows)
  /to <name>         address every later message to one participant
  /to                clear the default recipient
  /seen [message]    receipt table (latest sent message; F2 too): a time = received, Read <time> = read
  /seen [message] full  the same rows unclipped, with full dates and time zone, in the conversation
  /collapse [message|all]  fold a long message to its first line; click ▾ beside it to do the same
  /expand [message|all]    unfold it again (▸)
  /working           show agents that explicitly started answering (F3)
  /select            select and copy text with your terminal (F4; Esc resumes)
  /requests          interactive request details, attempts and recovery actions
  /requests retry|reassign|dismiss|cancel <id> [target/reason]
  /reply             ↑/↓ pick a message; Enter/Tab select; type your answer
  /reply <id> <text>  reply to an exact message
  /who               who is registered in this room
  /name <new name>   change your name in this room (default profile unchanged)
  /invite            create an invite (members can speak; the room's /settings may make it read-only)
  /invite member     create an invite for a member who can speak
  /invite observer   create a read-only observer invite
  /invite as <name>  create a member invite with a default name
  /invite @handle    hosted rooms: ask an account in by its handle (add observer for read-only); owner and admins
  /invites           hosted rooms: who was invited by handle; /invites revoke @handle withdraws one
  /lock              block joining, rejoining, and new invites (owner/admin, or members the room allows)
  /unlock            allow joining and invitations again
  /kick <name>       remove a participant and disable their invite
  /mute <name>       prevent a participant from writing
  /unmute <name>     allow them to write again
  /attach <path> [message]  send one or more files with a message; quote a path that has spaces
  /files             files sent in this room, numbered
  /open <file>       show a text or JSON file here (number, name or id from /files)
  /save <file> [folder]  save a file to a folder (this one by default); never replaces a file
  /permissions       which commands members may use, and who differs
  /permissions allow|deny|reset <command …|all> [name]  for all members, or for one (owner/admin)
  /preset save <name>  save this room's permissions, reply mode, invitations and auto-close on this device
  /preset apply <name>  show what a saved preset would change here; add confirm to apply (owner/admin)
  /preset [list|show <name>|delete <name>|default <name|none>]  manage presets; default applies to rooms you create
  /expiry            set when this room expires
  /interrupt <name>  stop one agent's current task and hold its queue (owner/admin, or members the room allows)
  /pause <name>      hold an agent's later work
  /resume <name>     release a paused or interrupted agent
  /help              this
  /quit              leave (Ctrl+C also works)`;

export async function runChatRoom(options: ChatOptions): Promise<number> {
    const {client, roomId, credential, store, sessionId, participantId} = options;
    const intervalMs = options.intervalMs ?? 700;

    const showIds = options.showIds === true;
    let snapshot = await client.snapshot(roomId, credential);
    let member = snapshot.participants.find((participant) => participant.participantId === participantId);
    if (!member || (options.requireHuman && member.kind !== 'human')) {
        throw new ProtocolError('unauthorized', 'The saved session is not your human membership. Choose a human session explicitly.');
    }
    if (member.left) {
        if (!snapshot.rejoinSupported) {
            throw new ProtocolError('unsupported_capability', 'This relay needs an update to rejoin a saved session. Join again with an invite for this older relay.');
        }
        snapshot = await client.rejoin(roomId, credential);
        member = snapshot.participants.find((participant) => participant.participantId === participantId)!;
    }
    options.readOnly = member.role === 'guest';
    if (options.useHumanProfile && member.kind === 'human') {
        const profile = store.profile();
        if (profile.kind !== 'agent' && profile.displayName && member.nameSource !== 'room' && member.role !== 'guest' && !member.muted && snapshot.renameSelfSupported && member.displayName !== profile.displayName) {
            snapshot = await client.renameSelf(roomId, credential, profile.displayName, 'profile');
            member = snapshot.participants.find((participant) => participant.participantId === participantId)!;
        }
        store.rememberHumanSession(roomId, sessionId);
    }
    store.updateSessionName(roomId, sessionId, member.displayName, member.nameSource);
    const names = new Map<string, string>();
    absorbNames(snapshot, names);

    /** Active members other than you: the only names worth completing to. */
    function mentionable(): string[] {
        return ['all', ...snapshot.participants
            .filter((participant) => !participant.revoked && !participant.left && participant.participantId !== participantId)
            .map((participant) => participant.displayName)];
    }

    const view = new ChatTerminal({
        names,
        participantId,
        format: (event, highlightNames, collapsed) => format(event, names, participantId, showIds, highlightNames, true, collapsed),
        complete: (line) => {
            const commands = completeChatCommand(line);
            if (commands) {
                return commands;
            }
            const partial = currentMention(line);
            if (partial === null) {
                return [[], line];
            }
            const matches = matchNames(partial, mentionable());
            if (matches.length === 0) {
                return [[], line];
            }
            const advance = matches.length === 1 ? `${matches[0]!} ` : commonPrefix(matches);
            return [[applyMention(line, advance)], line];
        }
    });
    try {
        const terminal = view.input;
        const seen = new Set<string>();
        let recipient: ParticipantMatch = null;
        let closed = false;
        let suspended = false;
        let statusLoading = false;

        function clearHint(): void {
            view.setHint('');
        }

        function drawHint(): void {
            if (suspended || options.readOnly === true) {
                return;
            }
            const line = terminal.line ?? '';
            const cursor = terminal.cursor ?? line.length;
            const width = (process.stdout.columns ?? 80) - 2;
            const commands = commandHint(line, cursor, width);
            const partial = currentMention(line, cursor);
            view.setHint(commands ?? (partial === null ? '' : renderSuggestions(partial, matchNames(partial, mentionable()), width)));
        }

        function emit(line: string): void {
            view.log(line);
            drawHint();
        }

        function setPrompt(): void {
            if (recipient) {
                recipient.name = names.get(recipient.id) ?? recipient.name;
            }
            if (options.readOnly === true) {
                view.setPrompt(`${DIM}watching${RESET} `);
                return;
            }
            view.setPrompt(recipient ? `${DIM}→ ${recipient.name}${RESET} ` : '> ');
        }

        function resolveName(reference: string): ParticipantMatch {
            const active = snapshot.participants.filter((participant) => !participant.revoked && !participant.left);
            const byId = active.find((participant) => participant.participantId === reference);
            if (byId) {
                return {id: byId.participantId, name: byId.displayName};
            }
            const matches = active.filter((participant) => participant.displayName.toLowerCase() === reference.toLowerCase());
            if (matches.length === 1) {
                return {id: matches[0]!.participantId, name: matches[0]!.displayName};
            }
            if (matches.length > 1) {
                emit(`${DIM}  ${matches.length} participants are called ${reference}; use an id: ${matches.map((participant) => participant.participantId).join(', ')}${RESET}`);
            } else {
                emit(`${DIM}  nobody here is called ${reference}${RESET}`);
            }
            return null;
        }

        header(snapshot, participantId, sessionId, emit);

        /** `/attach <path …> [message]`: stores the files on the relay, then sends one message that carries them. */
        async function attach(argument: string): Promise<void> {
            try {
                const {paths, text} = splitAttachCommand(argument);
                if (paths.length === 0) {
                    emit('Usage: /attach <path> [more paths] [message]');
                    return;
                }
                const attachments = await uploadFiles({client, roomId, credential}, paths, snapshot);
                await send(routeForRoom(routeChatMessage(text || attachmentText(attachments), snapshot.participants, recipient?.id ?? null), snapshot.participants, participantId), attachments);
            } catch (error) {
                emit(`${DIM}  not sent — ${error instanceof Error ? error.message : String(error)}${RESET}`);
            }
        }

        /** `/files`, `/open <file>` and `/save <file> [folder]`; a file is named by its number in `/files`, its name or its id. */
        async function fileCommand(command: string, argument: string): Promise<void> {
            try {
                if (!snapshot.filesSupported) {
                    throw new Error('This relay does not store files.');
                }
                const {files, usage} = await client.fileList(roomId, credential);
                if (command === '/files') {
                    emit(filesReport(files, names, usage));
                    return;
                }
                const [reference, ...rest] = argument.split(/\s+/).filter(Boolean);
                if (!reference) {
                    emit(`Usage: ${command} <number, name or id from /files>${command === '/save' ? ' [folder]' : ''}`);
                    return;
                }
                const file = findRoomFile(files, reference);
                if (command === '/open') {
                    emit(formatMessageText(previewFile(file, await client.downloadFile(roomId, credential, file.fileId))));
                    return;
                }
                const path = await saveFile({client, roomId, credential}, file, expandPath(rest.join(' ') || '.'));
                emit(`Saved ${attachmentLabel(file)} to ${path}`);
            } catch (error) {
                emit(`${DIM}  ${error instanceof Error ? error.message : String(error)}${RESET}`);
            }
        }

        let waking = false;

        async function send(routed: RoutedChatMessage, attachments: Attachment[] = []): Promise<void> {
            try {
                if ((routed.recipientIds || routed.allRecipients) && !snapshot.groupTurnsSupported) {
                    throw new Error('Update this relay before sending to multiple agents.');
                }
                const result = await client.send(roomId, credential, {
                    type: 'message',
                    payload: {text: routed.text, priority: 'normal', ...(attachments.length ? {attachments} : {})},
                    idempotencyKey: newId('event'),
                    ...(routed.recipientId ? {recipientId: routed.recipientId} : {}),
                    ...(routed.recipientIds ? {recipientIds: routed.recipientIds} : {}),
                    ...(routed.allRecipients ? {allRecipients: true} : {})
                });
                // Shown immediately and marked seen, so the poll does not print it twice.
                seen.add(result.event.eventId);
                view.addEvent(result.event);
                wakeAgents();
            } catch (error) {
                emit(`${DIM}  not sent — ${error instanceof ProtocolError ? error.message : String(error)}${RESET}`);
            }
        }

        /** A message is the moment an agent is needed, so this device's agents whose receiver died start again and resume their conversation. */
        function wakeAgents(): void {
            if (waking || options.readOnly || offlineReceivers(store, roomId).length === 0) {
                return;
            }
            waking = true;
            void wakeOfflineReceivers(store, roomId).then(({woken, failed}) => {
                if (woken.length) {
                    emit(`${DIM}  started ${woken.map((session) => session.displayName).join(', ')} again; ${woken.length === 1 ? 'its receiver was' : 'their receivers were'} not running${RESET}`);
                }
                for (const {session, reason} of failed) {
                    emit(`${DIM}  could not start ${session.displayName}: ${reason}${RESET}`);
                }
            }).finally(() => { waking = false; });
        }

        async function control(reference: string, paused: boolean): Promise<void> {
            const authority = authorityFor(snapshot, options.participantId, 'pause', options.credential, options.controllerCredential);
            if (!authority) {
                emit(`${DIM}  ${notPermitted('pause').message}${RESET}`);
                return;
            }
            const target = resolveName(reference);
            if (!target) {
                return;
            }
            try {
                const result = await client.control(roomId, authority, target.id, paused);
                // A request, not a confirmation: what happened is whatever the agent acknowledges.
                emit(`${DIM}  ${paused ? 'pause' : 'resume'} requested for ${target.name}, revision ${result.revision} — watch for the acknowledgement${RESET}`);
            } catch (error) {
                emit(`${DIM}  ${error instanceof ProtocolError ? error.message : String(error)}${RESET}`);
            }
        }

        /** Interrupts one agent. The relay decides who may; the agent's receiver reports what stopped. */
        async function interrupt(reference: string): Promise<void> {
            const target = resolveName(reference);
            if (!target) {
                return;
            }
            const authority = authorityFor(snapshot, options.participantId, 'pause', options.credential, options.controllerCredential);
            if (!authority) {
                emit(`${DIM}  ${notPermitted('pause').message}${RESET}`);
                return;
            }
            if (!snapshot.interruptSupported) {
                emit(`${DIM}  this relay cannot interrupt agents yet; update it, or use /pause to hold later work${RESET}`);
                return;
            }
            try {
                const result = await client.interrupt(roomId, authority, target.id);
                const fenced = result.fenced.length ? `its current task was stopped from posting a late answer` : 'it was between tasks';
                emit(`${DIM}  interrupt requested for ${target.name}: ${fenced}; its queue is held until /resume ${target.name}. Watch for what its receiver confirms.${RESET}`);
            } catch (error) {
                emit(`${DIM}  ${error instanceof ProtocolError ? error.message : String(error)}${RESET}`);
            }
        }

        /**
         * Hands stdin to the picker and takes it back afterwards. The readline
         * interface is paused first, or both it and the picker consume the same
         * keypresses and neither behaves.
         */
        async function changeExpiry(): Promise<void> {
            if (!options.controllerCredential) {
                emit(`${DIM}  this device does not hold the controller credential for this room${RESET}`);
                return;
            }
            suspended = true;
            clearHint();
            terminal.pause();
            view.suspend();
            process.stdout.write('\n');
            try {
                const chosen = await pickExpiry(snapshot.name, snapshot.expiresAt);
                if (chosen === undefined || chosen === snapshot.expiresAt) {
                    emit(`${DIM}  expiry left unchanged${RESET}`);
                } else {
                    await client.setExpiry(roomId, options.controllerCredential, chosen);
                    snapshot = await client.snapshot(roomId, credential);
                    emit(`${DIM}  ${chosen === null ? 'this room will not expire' : `this room expires ${new Date(chosen).toLocaleString()}`}${RESET}`);
                }
            } catch (error) {
                emit(`${DIM}  ${error instanceof ProtocolError ? error.message : String(error)}${RESET}`);
            }
            suspended = false;
            terminal.resume();
            view.resume();
            terminal.prompt(true);
        }

        terminal.on('line', (raw) => {
            const line = raw.trim();
            const reply = view.takeReply();
            clearHint();
            terminal.prompt(true);
            if (line.length === 0) {
                return;
            }

            if (line === '/quit' || line === '/exit') {
                closed = true;
                terminal.close();
                return;
            }
            if (line === '/select') {
                view.toggleSelection();
                return;
            }
            if (/^\/(status|settings)(?:\s|$)/.test(line)) {
                const command = line.split(/\s+/)[0]!;
                if (line !== command) {
                    emit(`Usage: ${command}`);
                } else if (statusLoading) {
                    emit('Room status is already loading.');
                } else {
                    statusLoading = true;
                    emit('Loading room status…');
                    const context = {client, roomId, credential, participantId, store, controllerCredential: options.controllerCredential};
                    void view.showRoomPanel(() => command === '/settings' ? settingsPage(context) : statusPage(context))
                        .catch((error) => { if (!closed) { emit(`Status unavailable: ${error instanceof Error ? error.message : String(error)}`); } })
                        .finally(() => { statusLoading = false; });
                }
                return;
            }
            if (options.readOnly === true) {
                emit(`${DIM}  you are a read-only guest in this room${RESET}`);
                return;
            }
            if (line === '/agents') {
                void view.showAgents(() => loadAgentRoster({store, roomId, sessionId})).catch((error) => emit(error instanceof Error ? error.message : String(error)));
                return;
            }
            if (isAgentCommand(line)) {
                void runAgentCommand(line, {store, roomId, sessionId}).then(async (message) => {
                    emit(message);
                    snapshot = await client.snapshot(roomId, credential);
                    absorbNames(snapshot, names);
                }).catch((error) => emit(error instanceof Error ? error.message : String(error)));
                return;
            }
            if (reply) {
                void sendChatReply(reply, {client, roomId, credential, participantId, quotedMessagesSupported: snapshot.quotedMessagesSupported === true, agentsToAsk: hasAgentsToAsk(snapshot.participants, participantId)})
                    .then((result) => {
                        seen.add(result.event.eventId);
                        view.addEvent(result.event);
                        wakeAgents();
                    })
                    .catch((error) => {
                        view.restoreReply(reply);
                        emit(`Reply failed: ${error instanceof Error ? error.message : String(error)}`);
                    });
                return;
            }
            if (isPresetCommand(line)) {
                void runPresetCommand(line.replace(/^\/presets?/, ''), {client, store, roomId, credential, participantId, controllerCredential: options.controllerCredential}).then(emit).catch((error) => emit(error instanceof Error ? error.message : String(error)));
                return;
            }
            if (isRoomCommand(line)) {
                void runRoomCommand(line, options).then(emit).catch((error) => emit(error instanceof Error ? error.message : String(error)));
                return;
            }
            if (line === '/help') {
                emit(HELP);
                return;
            }
            if (line === '/collapse' || line.startsWith('/collapse ') || line === '/expand' || line.startsWith('/expand ')) {
                view.setCollapsed(line.startsWith('/collapse'), line.replace(/^\/\w+/, ''));
                return;
            }
            if (line === '/seen' || line.startsWith('/seen ')) {
                view.showLatestReceipt(line.slice(5).trim() || undefined);
                return;
            }
            if (line === '/working') {
                view.showWorking();
                return;
            }
            if (line === '/requests') {
                if (statusLoading) {
                    emit('A room panel is already loading.');
                } else {
                    statusLoading = true;
                    emit('Loading requests…');
                    const context = {client, roomId, credential, participantId, store, ...(options.controllerCredential ? {controllerCredential: options.controllerCredential} : {})};
                    void view.showRoomPanel(() => requestsPage(context))
                        .catch((error) => { if (!closed) { emit(`Requests unavailable: ${error instanceof Error ? error.message : String(error)}`); } })
                        .finally(() => { statusLoading = false; });
                }
                return;
            }
            if (line.startsWith('/requests ')) {
                void runRequestsCommand(line.slice('/requests'.length).trim(), {
                    client,
                    roomId,
                    credential,
                    participantId,
                    snapshot,
                    store,
                    ...(options.controllerCredential ? {controllerCredential: options.controllerCredential} : {}),
                    emit
                }).catch((error) => emit(`Request action failed: ${error instanceof Error ? error.message : String(error)}`));
                return;
            }
            if (line.startsWith('/reply ')) {
                const [id, ...words] = line.slice(7).split(/\s+/);
                if (!id || !words.length) {
                    emit('Usage: /reply <event-id> <answer>');
                    return;
                }
                void client
                    .reply(roomId, credential, id, words.join(' '))
                    .then(() => emit(`Answer recorded for ${id}`))
                    .catch((error) => emit(`Reply failed: ${String(error)}`));
                return;
            }
            if (line === '/who') {
                emit(who(snapshot, true));
                return;
            }
            if (line === '/to') {
                recipient = null;
                setPrompt();
                emit(`${DIM}  addressing all eligible agents${RESET}`);
                terminal.prompt(true);
                return;
            }
            if (line.startsWith('/to ')) {
                const found = resolveName(line.slice(4).trim());
                if (found) {
                    recipient = found;
                    setPrompt();
                    emit(`${DIM}  addressing ${found.name}${RESET}`);
                    terminal.prompt(true);
                }
                return;
            }
            if (line === '/expiry') {
                void changeExpiry();
                return;
            }
            if (line.startsWith('/interrupt ')) {
                void interrupt(line.slice(11).trim());
                return;
            }
            if (line === '/interrupt') {
                emit(`${DIM}  Usage: /interrupt <agent name or participant ID>${RESET}`);
                return;
            }
            if (line.startsWith('/pause ')) {
                void control(line.slice(7).trim(), true);
                return;
            }
            if (line.startsWith('/resume ')) {
                void control(line.slice(8).trim(), false);
                return;
            }
            if (/^\/(attach|files|open|save)(?:\s|$)/.test(line)) {
                const command = line.split(/\s+/)[0]!;
                void (command === '/attach' ? attach(line.slice(command.length)) : fileCommand(command, line.slice(command.length).trim()));
                return;
            }
            if (line.startsWith('/')) {
                emit(`${DIM}  unknown command; /help${RESET}`);
                return;
            }

            try {
                const routed = routeForRoom(routeChatMessage(line, snapshot.participants, recipient?.id ?? null), snapshot.participants, participantId);
                void send(routed);
            } catch (error) {
                emit(`${DIM}  ${error instanceof Error ? error.message : String(error)}${RESET}`);
            }
        });

        // readline emits keypress on stdin once an interface exists; observing is
        // enough, since readline still owns the editing itself.
        const onKeypress = () => {
            if (!closed) {
                setImmediate(drawHint);
            }
        };
        view.onInput(onKeypress);

        const finished = new Promise<void>((resolve) => terminal.once('close', () => {
            closed = true;
            resolve();
        }));
        // readline intercepts Ctrl+C, so the interface is where the signal arrives.
        terminal.on('SIGINT', () => {
            closed = true;
            terminal.close();
        });
        process.once('SIGINT', () => {
            closed = true;
            terminal.close();
        });

        setPrompt();
        terminal.prompt();

        let cursor = options.fromStart ? 0 : snapshot.latestSeq;
        if (options.fromStart) {
            cursor = 0;
        }
        // An unreachable relay is reported once, not once per poll, and retried with
        // widening gaps. The old behaviour filled the screen and buried the room.
        let pendingRequests: MessageRequest[] = [];
        let loadedRequests = false;
        let outageSince: number | null = null;
        let backoffMs = intervalMs;

        while (!closed) {
            try {
                const page = await client.readEvents(roomId, credential, cursor);
                if (page.events.length > 0) {
                    const nextCursor = page.events.at(-1)!.seq;
                    if (page.events.some((event) => event.type === 'participant.joined' || event.type === 'participant.renamed' || event.type === 'participant.left' || event.type === 'participant.revoked' || event.type === 'participant.mute_changed' || event.type === 'participant.role_changed' || event.type === 'participant.permissions_changed' || event.type === 'room.permissions_changed' || event.type === 'room.renamed' || event.type === 'room.expiry_changed' || event.type === 'room.access_changed' || event.type === 'room.auto_close_changed' || event.type === 'room.closed' || event.type === 'room.lock_changed' || event.type === 'control.pause' || event.type === 'control.resume' || event.type === 'control.ack')) {
                        snapshot = await client.snapshot(roomId, credential);
                        absorbNames(snapshot, names);
                        for (const saved of store.room(roomId)?.sessions ?? []) {
                            const current = snapshot.participants.find((participant) => participant.participantId === saved.participantId);
                            if (current) {
                                store.updateSessionName(roomId, saved.sessionId, current.displayName, current.nameSource);
                            }
                        }
                        setPrompt();
                    }
                    for (const event of page.events) {
                        if (seen.has(event.eventId)) {
                            continue;
                        }
                        seen.add(event.eventId);
                        view.addEvent(event);
                    }
                    if (!options.readOnly && snapshot.participants.some((participant) => participant.participantId === participantId && participant.kind === 'human')) {
                        for (const event of page.events)
                            if (event.type === 'message' && event.senderId !== participantId && (snapshot.messageReceiptScope === 'members' || event.recipientId === participantId)) {
                                await client.acknowledgeMessage(roomId, credential, event.eventId);
                            }
                    }
                    cursor = nextCursor;
                    store.updateCursor(roomId, sessionId, cursor);
                }
                if (!loadedRequests || page.events.length || snapshot.groupTurnsSupported) {
                    pendingRequests = await client.pendingRequests(roomId, credential);
                    loadedRequests = true;
                }
                let queue: TurnQueue | null = null;
                if (snapshot.groupTurnsSupported) {
                    queue = await client.turnQueue(roomId, credential);
                    view.setWorking(queue);
                    view.setTurnStatus(formatTurnQueue(queue));
                }
                for (const request of pendingRequests) {
                    view.updateRequest(request);
                }
                view.setRequestAlerts(pendingRequests.flatMap((request) => {
                    const state = requestState(request);
                    const attention = state === 'failed' || state === 'stalled' || (state.includes('overdue') && request.action !== 'waiting' && request.action !== 'reply_pending');
                    return showIds || attention ? [{requestId: request.eventId, text: formatRequestStatus(request, names, showIds)}] : [];
                }));
                view.setAgentActivity({participants: snapshot.participants, requests: pendingRequests, queue, complete: !page.hasMore, available: true, offline: new Set(offlineReceivers(store, roomId).map((session) => session.participantId))});
                if (outageSince !== null) {
                    emit(`${DIM}  relay is back${RESET}`);
                    outageSince = null;
                    backoffMs = intervalMs;
                }
                if (page.hasMore) {
                    continue;
                }
            } catch (error) {
                view.activityUnavailable();
                if (error instanceof ProtocolError && (error.code === 'room_expired' || error.code === 'room_closed' || error.code === 'participant_revoked')) {
                    emit(`${DIM}  ${error.message}${RESET}`);
                    break;
                }
                if (error instanceof ProtocolError && error.code === 'server_unavailable') {
                    if (outageSince === null) {
                        outageSince = Date.now();
                        emit(`${DIM}  relay unreachable — still here, retrying quietly${RESET}`);
                    }
                    backoffMs = Math.min(backoffMs * 2, 30_000);
                } else {
                    throw error;
                }
            }
            await Promise.race([
                outageSince === null ? client.waitForChange(roomId, credential, cursor, 5000, intervalMs).catch(() => sleep(Math.max(1000, backoffMs))) : sleep(backoffMs),
                finished
            ]);
        }

        client.closeLive();
        clearHint();

        terminal.close();
        view.close();
        // Closing the interface is not enough to end the process: stdin stays open and
        // referenced, so the event loop never drains and the command appears to hang.
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        process.stdin.pause();

        // Tell the room you are gone. Membership is durable, so without this the room
        // shows you present indefinitely and your invite seat never reopens.
        try {
            await client.leave(roomId, credential);
        } catch {
            // Leaving is best effort: the room may already be closed, expired, or the
            // relay gone. None of those should turn quitting into an error.
        }
        // Node's fetch keeps pooled sockets referenced, so the event loop does not
        // drain on its own and the command appears to hang after you quit. Leave
        // deliberately, once output is flushed.
        // Print after restoring the normal buffer and finishing leave, so the
        // command stays in shell scrollback and cannot race a pending departure.
        const sessionFlag = options.useHumanProfile && member.kind === 'human' ? '' : ` --session ${sessionId}`;
        await new Promise<void>((resolve) => process.stdout.write(`\nTo rejoin this room:\n  pairlobby chat --room ${roomId}${sessionFlag}\n\n`, () => resolve()));
        process.exit(0);
    } finally {
        view.close();
    }
}

export type RequestsCommandContext = {
    client: PairLobbyClient;
    roomId: string;
    credential: string;
    participantId: string;
    snapshot: RoomSnapshot;
    store: LocalStore;
    controllerCredential?: string;
    emit: (line: string) => void;
};

export async function runRequestsCommand(argument: string, context: RequestsCommandContext): Promise<void> {
    const {client, roomId, credential, participantId, snapshot, store, controllerCredential, emit} = context;
    if (!argument) {
        const page = await client.requests(roomId, credential);
        const self = snapshot.participants.find((participant) => participant.participantId === participantId);
        for (const request of page.requests) {
            const state = requestState(request);
            emit(`${request.eventId} ${state} ${request.text.slice(0, 100)}`);
            const authorized = request.from === participantId || self?.role === 'controller' || Boolean(controllerCredential);
            if (authorized && !request.resolution && !request.responseEventId && !request.recoveredByEventId) {
                if (request.failureAt) {
                    emit(`  actions: /requests retry ${request.eventId} · /requests reassign ${request.eventId} <name> · /requests dismiss ${request.eventId} [reason] · /requests cancel ${request.eventId} [reason]`);
                } else if (request.requiresReply) {
                    emit(`  action: /requests cancel ${request.eventId} [reason]`);
                }
            }
        }
        if (page.hasMore) {
            emit('More requests remain; use pairlobby requests --after to page through them.');
        }
        return;
    }
    const [action, requestId, ...rest] = argument.split(/\s+/);
    if (!requestId || !['retry', 'reassign', 'dismiss', 'cancel'].includes(action ?? '')) {
        throw new Error('Usage: /requests retry <id>, reassign <id> <name>, dismiss <id> [reason], or cancel <id> [reason].');
    }
    const request = await client.request(roomId, credential, requestId);
    const self = snapshot.participants.find((participant) => participant.participantId === participantId);
    const authority = request.from === participantId || self?.role === 'controller' ? credential : controllerCredential ?? credential;
    if (action === 'retry') {
        if (!snapshot.requestRecoverySupported) {
            throw new Error('This relay does not support request retries yet.');
        }
        if (rest.length) {
            throw new Error('Usage: /requests retry <id>');
        }
        const result = await recoverRequest({client, roomId, credential: authority, workspaceForParticipant: (id) => store.room(roomId)?.sessions.find((session) => session.participantId === id)?.cwd}, requestId);
        emit(`Attempt ${result.attempt} sent to ${result.toName} as ${result.requestId}.`);
        return;
    }
    if (action === 'reassign') {
        if (!snapshot.requestRecoverySupported) {
            throw new Error('This relay does not support request reassignment yet.');
        }
        const target = rest.join(' ').trim();
        if (!target) {
            throw new Error('Usage: /requests reassign <id> <name or participant ID>');
        }
        const result = await recoverRequest({client, roomId, credential: authority, workspaceForParticipant: (id) => store.room(roomId)?.sessions.find((session) => session.participantId === id)?.cwd}, requestId, target);
        emit(`Attempt ${result.attempt} reassigned to ${result.toName} as ${result.requestId}.`);
        return;
    }
    const result = await closeRequest({client, roomId, credential: authority}, requestId, action === 'dismiss' ? 'dismiss' : 'cancel', rest.join(' ').trim() || undefined);
    emit(`${requestId} ${result.outcome}; no success was recorded.${result.reason ? ` ${result.reason}` : ''}`);
}

function header(snapshot: RoomSnapshot, participantId: string, sessionId: string, emit: (line: string) => void): void {
    const active = snapshot.participants.filter((participant) => !participant.revoked && !participant.left);
    const people = active.filter((participant) => participant.kind === 'human').length;
    const agents = active.filter((participant) => participant.kind === 'agent').length;
    const me = snapshot.participants.find((participant) => participant.participantId === participantId);

    emit(`${BOLD}${snapshot.name}${RESET}  ${DIM}${snapshot.roomId}${RESET}`);
    emit(`${DIM}session${RESET} ${sessionId}${me ? `  ${DIM}as${RESET} ${me.displayName}` : ''}`);
    emit(
        `${DIM}registered in this room:${RESET} ${active.length}  (${plural(people, 'person', 'people')}, ${plural(agents, 'agent', 'agents')})  ${DIM}${active.map((participant) => participant.displayName).join(', ')}${RESET}`
    );
    emit(`${DIM}${me?.role === 'guest' ? 'Read-only observer. /quit to leave.' : '/help for commands, /quit to leave'}${snapshot.locked ? ' Room locked.' : ''}${RESET}`);
    emit('');
}

function who(snapshot: RoomSnapshot, showIds = false): string {
    return snapshot.participants
        .filter((participant) => !participant.revoked && !participant.left)
        .map((participant) => {
            const control =
                participant.controlRevision > 0 ? `  ${DIM}control ${participant.controlRevision}: ${participant.acknowledgedOutcome ?? 'no acknowledgement yet'}${RESET}` : '';
            const id = showIds ? `  ${DIM}${participant.participantId}${RESET}` : '';
            return `  ${participant.displayName}${id}  ${DIM}${participant.kind}${participant.paused ? ', paused' : ''}${participant.muted ? ', muted' : ''}${participant.role === 'guest' ? ', observer' : ''}${RESET}${control}`;
        })
        .join('\n');
}

/** `styled` draws the message's Markdown for the interactive transcript; everything else gets the text as written. */
export function format(event: RoomEvent, names: Map<string, string>, meParticipantId: string, showIds = false, highlightNames = false, styled = false, collapsed = false): string {
    const time = `${DIM}${new Date(event.at).toTimeString().slice(0, 5)}${RESET}`;
    const sender = event.senderId ? (names.get(event.senderId) ?? event.senderId) : 'room';
    const mine = event.senderId === meParticipantId;

    if (event.type === 'message') {
        const targets = event.recipientIds ?? (event.recipientId ? [event.recipientId] : []);
        const underline = highlightNames ? '\u001b[4m' : '';
        const to = event.allRecipients || targets.length > 1 ? `${DIM} → ${underline}all${RESET}` : targets.length ? `${DIM} → ${underline}${targets.map((id) => names.get(id) ?? id).join(', ')}${RESET}` : '';
        const who = mine ? `${DIM}${underline}${sender}${RESET}` : `${BOLD}${underline}${sender}${RESET}`;
        const id = showIds && event.senderId ? `${DIM} ${event.senderId}${RESET}` : '';
        const thread = !showIds ? '' : event.replyTo
            ? `${event.payload.responseStage === 'progress' ? 'progress' : 'reply'} to ${event.replyTo}`
            : event.recipientId ? `request ${event.eventId}` : '';
        const files = (event.payload.attachments ?? []).map((file) => `\n       ${DIM}▪${RESET} ${attachmentLabel(file)}`).join('');
        return `${time}  ${who}${id}${to}${thread ? `  [${thread}]` : ''}  ${collapsed ? collapseMessage(event.payload.text).line : styled ? formatMessageText(event.payload.text) : event.payload.text}${files}`;
    }
    return `${time}  ${DIM}· ${systemLine(event, names, sender, showIds)}${RESET}`;
}

export function formatRequestStatus(request: MessageRequest, names: Map<string, string>, showIds = false): string {
    const state = requestState(request);
    const descriptions = {
        awaiting_ack: 'Queued',
        awaiting_reply: 'Queued',
        ack_overdue: 'Queued · receipt overdue',
        reply_overdue: 'Queued · response overdue',
        answered: 'Answered',
        no_action: 'No action needed',
        declined: 'Declined', provider_wait: 'Provider limited · waiting to retry',
        failed: failureLabel(request.failureStage), dismissed: 'Failed · dismissed',
        waiting_turn: 'Waiting for a speaking turn', answering: 'Answering', stalled: 'Speaking turn stalled', passed: 'Passed', skipped: 'Skipped', cancelled: 'Cancelled'
    };
    const receipt = request.readAt !== undefined ? 'Read' : request.receivedAt !== null ? 'Received' : 'Sent · receipt unconfirmed';
    const attention = state === 'failed' || state === 'stalled' || (state.includes('overdue') && request.action !== 'waiting' && request.action !== 'reply_pending');
    return `${attention ? 'ATTENTION: ' : ''}${names.get(request.from) ?? request.from} → ${names.get(request.to) ?? request.to}: ${receipt} · ${request.action || request.responseEventId || request.failureAt ? messageActionLabel(request) : descriptions[state]}${showIds || state === 'failed' ? ` [${request.eventId}]` : ''}`;
}

function systemLine(event: RoomEvent, names: Map<string, string>, sender: string, showIds = false): string {
    switch (event.type) {
        case 'participant.joined':
            return `${event.payload.displayName} joined`;
        case 'participant.renamed':
            return `${event.payload.previousName} is now ${event.payload.name}`;
        case 'participant.left':
            return `${sender} left`;
        case 'participant.revoked':
            return `${names.get(event.payload.participantId) ?? event.payload.participantId} was removed`;
        case 'handover.offered':
            return `${sender} offered handover ${event.payload.handoverId} rev ${event.payload.revision}: ${event.payload.document.metadata.goal}`;
        case 'handover.accepted':
            return `${sender} accepted handover ${event.payload.handoverId} rev ${event.payload.revision}`;
        case 'handover.declined':
            return `${sender} declined handover ${event.payload.handoverId} rev ${event.payload.revision}`;
        case 'control.pause':
            if (event.payload.interrupt) {
                return `${sender} interrupted ${names.get(event.payload.targetParticipantId) ?? 'someone'}: current task stopped from posting, queue held until resume`;
            }
            return `pause requested for ${names.get(event.payload.targetParticipantId) ?? 'someone'}, revision ${event.payload.revision}`;
        case 'control.resume':
            return `resume requested for ${names.get(event.payload.targetParticipantId) ?? 'someone'}, revision ${event.payload.revision}`;
        case 'control.ack':
            return `${sender} ${controlOutcomeText(event.payload.outcome)}`;
        case 'message.request_closed':
            return `${sender} ${event.payload.outcome === 'dismissed' ? 'dismissed the failed request' : 'cancelled the request'} ${event.payload.eventId}${event.payload.reason ? `: ${event.payload.reason}` : ''}`;
        case 'room.lock_changed':
            return event.payload.locked ? 'the room was locked' : 'the room was unlocked';
        case 'participant.mute_changed':
            return `${names.get(event.payload.participantId) ?? event.payload.participantId} was ${event.payload.muted ? 'muted' : 'unmuted'}`;
        case 'participant.role_changed':
            return `${names.get(event.payload.participantId) ?? event.payload.participantId} is now ${event.payload.role === 'controller' ? 'an admin' : 'a member'}`;
        case 'room.permissions_changed':
            return `${event.senderId ? sender : 'the owner'} changed command permissions: ${describeRoomPermissionChange(event.payload.permissions, event.payload.previous)}`;
        case 'participant.permissions_changed':
            return `${event.senderId ? sender : 'the owner'} changed permissions: ${describeParticipantPermissionChange(names.get(event.payload.participantId) ?? event.payload.participantId, event.payload.permissions, event.payload.previous)}`;
        case 'room.closed':
            return `the room was ${describeCloseReason(event.payload.reason)}`;
        case 'room.auto_close_changed':
            return `${sender} set auto-close: ${describeAutoClose(event.payload.autoClose).toLowerCase()}`;
        case 'conversation.turn_changed': {
            const agents = event.payload.participantIds.map((id) => names.get(id) ?? id).join(', ');
            if (event.payload.action === 'mode') {
                return `reply mode is now ${event.payload.mode}`;
            }
            return `${agents}: ${event.payload.detail ?? `turn ${event.payload.action}`}`;
        }
        case 'room.renamed':
            return `${sender} renamed the room to ${event.payload.name}`;
        case 'room.expiry_changed':
            return event.payload.expiresAt === null ? `${sender} made the room permanent` : `${sender} set the room to expire ${new Date(event.payload.expiresAt).toLocaleString()}`;
        case 'room.access_changed':
            if (event.payload.inviteRole) {
                return event.payload.inviteRole === 'guest' ? `${sender} made new invitations read-only` : `${sender} made new invitations admit members who can speak`;
            }
            return event.payload.joinPolicy === 'open_to_guests' ? `${sender} opened the room to read-only guests` : `${sender} made the room invite only`;
        case 'room.invitation_changed':
            return event.payload.state === 'withdrawn' ? `${sender} withdrew the invitation to @${event.payload.handle}` : `${sender} invited @${event.payload.handle}${invitationTerms(event.payload)}`;
        case 'room.local_join_changed':
            return event.payload.localJoin ? `${sender} let anyone on the local network join by name` : `${sender} turned off joining by name on the local network`;
        case 'message.delivery_failed':
            return `${failureLabel(event.payload.stage)} [${event.payload.eventId}]: ${event.payload.reason} (failed attempt)`;
        case 'message.received':
            return `${sender} read it`;
        default:
            return event.type;
    }
}

function absorbNames(snapshot: RoomSnapshot, names: Map<string, string>): void {
    for (const participant of snapshot.participants) names.set(participant.participantId, participant.displayName);
}

function plural(value: number, one: string, many: string): string {
    return `${value} ${value === 1 ? one : many}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export type {Interface};

/** What a receiver said it did, without claiming more than it confirmed. */
export function controlOutcomeText(outcome: string): string {
    switch (outcome) {
        case 'current_turn_cancelled':    return 'stopped its current task (its runtime confirmed the turn ended; edits already made are not undone)';
        case 'tool_cancellation_unknown': return 'stopped its current turn, but a command it started may still be running';
        case 'paused_between_turns':      return 'was between tasks; nothing was running to stop';
        case 'resumed':                   return 'resumed';
        case 'unsupported':               return 'cannot be interrupted by its runtime';
        default:                          return `reported: ${outcome.replaceAll('_', ' ')}`;
    }
}

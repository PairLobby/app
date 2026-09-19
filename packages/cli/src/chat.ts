//! The interactive room: live messages above, your input below.
//!
//! This is where a human actually sits. Joining a room puts you here, not back
//! at a shell prompt with a transcript printed behind you.

import type {Interface} from 'node:readline';
import {ChatTerminal} from './chat-terminal.js';

import {ProtocolError, requestState, newId} from '@pairlobby/protocol';
import type {MessageRequest, RoomEvent, RoomSnapshot} from '@pairlobby/protocol';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';

import {pickExpiry} from './picker.js';
import {applyMention, commonPrefix, currentMention, matchNames, renderSuggestions, routeChatMessage} from './mentions.js';

type ParticipantMatch = {id: string; name: string} | null;

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

export interface ChatOptions {
    /** Guests may watch and leave; the composer is disabled for them. */
    readOnly?: boolean;
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

const HELP = `  <message>          send to the room
  @name anywhere    send to that participant (e.g. Hey @codex, hello)
  /to <name>         address every later message to one participant
  /to                clear the default recipient
  /seen [message]    receipt details (latest sent message by default; F2 also works)
  /requests          show every unanswered request
  /reply <id> <text>  answer one exact request
  /who               who is registered in this room
  /expiry            set when this room expires
  /pause <name>      controller only
  /resume <name>     controller only
  /help              this
  /quit              leave (Ctrl+C also works)`;

export async function runChatRoom(options: ChatOptions): Promise<number> {
    const {client, roomId, credential, store, sessionId, participantId} = options;
    const intervalMs = options.intervalMs ?? 700;

    const showIds = options.showIds === true;
    let snapshot = await client.snapshot(roomId, credential);
    const names = new Map<string, string>();
    absorbNames(snapshot, names);

    /** Active members other than you: the only names worth completing to. */
    function mentionable(): string[] {
        return snapshot.participants
            .filter((participant) => !participant.revoked && !participant.left && participant.participantId !== participantId)
            .map((participant) => participant.displayName);
    }

    const view = new ChatTerminal({
        names,
        participantId,
        format: (event) => format(event, names, participantId, showIds),
        complete: (line) => {
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

        function clearHint(): void {
            view.setHint('');
        }

        function drawHint(): void {
            if (suspended || options.readOnly === true) {
                return;
            }
            const partial = currentMention(terminal.line ?? '', terminal.cursor ?? undefined);
            view.setHint(partial === null ? '' : renderSuggestions(partial, matchNames(partial, mentionable()), (process.stdout.columns ?? 80) - 2));
        }

        function emit(line: string): void {
            view.log(line);
            drawHint();
        }

        function setPrompt(): void {
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

        async function send(text: string, to: string | null): Promise<void> {
            try {
                const result = await client.send(roomId, credential, {
                    type: 'message',
                    payload: {text, priority: 'normal'},
                    idempotencyKey: newId('event'),
                    ...(to ? {recipientId: to} : {})
                });
                // Shown immediately and marked seen, so the poll does not print it twice.
                seen.add(result.event.eventId);
                view.addEvent(result.event);
            } catch (error) {
                emit(`${DIM}  not sent — ${error instanceof ProtocolError ? error.message : String(error)}${RESET}`);
            }
        }

        async function control(reference: string, paused: boolean): Promise<void> {
            if (!options.controllerCredential) {
                emit(`${DIM}  this device does not hold the controller credential for this room${RESET}`);
                return;
            }
            const target = resolveName(reference);
            if (!target) {
                return;
            }
            try {
                const result = await client.control(roomId, options.controllerCredential, target.id, paused);
                // A request, not a confirmation: what happened is whatever the agent acknowledges.
                emit(`${DIM}  ${paused ? 'pause' : 'resume'} requested for ${target.name}, revision ${result.revision} — watch for the acknowledgement${RESET}`);
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
            if (options.readOnly === true && !line.startsWith('/')) {
                emit(`${DIM}  you are a read-only guest in this room${RESET}`);
                return;
            }
            if (line === '/help') {
                emit(HELP);
                return;
            }
            if (line === '/seen' || line.startsWith('/seen ')) {
                view.showLatestReceipt(line.slice(5).trim() || undefined);
                return;
            }
            if (line === '/requests') {
                void client
                    .requests(roomId, credential)
                    .then((page) => {
                        for (const request of page.requests) emit(`${request.eventId} ${requestState(request)} ${request.text.slice(0, 100)}`);
                        if (page.hasMore) {
                            emit('More requests remain; use pairlobby requests --after to page through them.');
                        }
                    })
                    .catch((error) => emit(`Cannot verify requests: ${String(error)}`));
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
                emit(who(snapshot, showIds));
                return;
            }
            if (line === '/to') {
                recipient = null;
                setPrompt();
                emit(`${DIM}  addressing the room${RESET}`);
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
            if (line.startsWith('/pause ')) {
                void control(line.slice(7).trim(), true);
                return;
            }
            if (line.startsWith('/resume ')) {
                void control(line.slice(8).trim(), false);
                return;
            }
            if (line.startsWith('/')) {
                emit(`${DIM}  unknown command; /help${RESET}`);
                return;
            }

            try {
                const routed = routeChatMessage(line, snapshot.participants, recipient?.id ?? null);
                void send(routed.text, routed.recipientId);
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

        const finished = new Promise<void>((resolve) => terminal.once('close', resolve));
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
        const shownRequestStates = new Map<string, string>();
        let outageSince: number | null = null;
        let backoffMs = intervalMs;

        while (!closed) {
            try {
                const page = await client.readEvents(roomId, credential, cursor);
                if (page.events.length > 0) {
                    const nextCursor = page.events.at(-1)!.seq;
                    if (page.events.some((event) => event.type === 'participant.joined' || event.type === 'participant.left' || event.type === 'participant.revoked')) {
                        snapshot = await client.snapshot(roomId, credential);
                        absorbNames(snapshot, names);
                    }
                    for (const event of page.events) {
                        if (seen.has(event.eventId)) {
                            continue;
                        }
                        seen.add(event.eventId);
                        view.addEvent(event);
                    }
                    if (!options.readOnly) {
                        for (const event of page.events)
                            if (event.type === 'message' && event.recipientId === participantId && event.senderId !== participantId) {
                                await client.acknowledgeMessage(roomId, credential, event.eventId);
                            }
                    }
                    cursor = nextCursor;
                    store.updateCursor(roomId, sessionId, cursor);
                }
                if (!loadedRequests || page.events.length) {
                    pendingRequests = (await client.requests(roomId, credential)).requests;
                    loadedRequests = true;
                }
                for (const request of pendingRequests) {
                    view.updateRequest(request);
                    const state = requestState(request);
                    if (shownRequestStates.get(request.eventId) !== state) {
                        shownRequestStates.set(request.eventId, state);
                        if (showIds || state.includes('overdue') || state === 'failed') {
                            emit(formatRequestStatus(request, names, showIds));
                        }
                    }
                }
                if (outageSince !== null) {
                    emit(`${DIM}  relay is back${RESET}`);
                    outageSince = null;
                    backoffMs = intervalMs;
                }
                if (page.hasMore) {
                    continue;
                }
            } catch (error) {
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
        await new Promise<void>((resolve) => process.stdout.write('\n', () => resolve()));
        process.exit(0);
    } finally {
        view.close();
    }
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
    emit(`${DIM}/help for commands, /quit to leave${RESET}`);
    emit('');
}

function who(snapshot: RoomSnapshot, showIds = false): string {
    return snapshot.participants
        .filter((participant) => !participant.revoked && !participant.left)
        .map((participant) => {
            const control =
                participant.controlRevision > 0 ? `  ${DIM}control ${participant.controlRevision}: ${participant.acknowledgedOutcome ?? 'no acknowledgement yet'}${RESET}` : '';
            const id = showIds ? `  ${DIM}${participant.participantId}${RESET}` : '';
            return `  ${participant.displayName}${id}  ${DIM}${participant.kind}${participant.paused ? ', paused' : ''}${RESET}${control}`;
        })
        .join('\n');
}

export function format(event: RoomEvent, names: Map<string, string>, meParticipantId: string, showIds = false): string {
    const time = `${DIM}${new Date(event.at).toTimeString().slice(0, 5)}${RESET}`;
    const sender = event.senderId ? (names.get(event.senderId) ?? event.senderId) : 'room';
    const mine = event.senderId === meParticipantId;

    if (event.type === 'message') {
        const to = event.recipientId ? `${DIM} → ${names.get(event.recipientId) ?? event.recipientId}${RESET}` : '';
        const who = mine ? `${DIM}${sender}${RESET}` : `${BOLD}${sender}${RESET}`;
        const id = showIds && event.senderId ? `${DIM} ${event.senderId}${RESET}` : '';
        const thread = !showIds ? '' : event.replyTo
            ? `${event.payload.responseStage === 'progress' ? 'progress' : 'reply'} to ${event.replyTo}`
            : event.recipientId ? `request ${event.eventId}` : '';
        return `${time}  ${who}${id}${to}${thread ? `  [${thread}]` : ''}  ${event.payload.text}`;
    }
    return `${time}  ${DIM}· ${systemLine(event, names, sender, showIds)}${RESET}`;
}

export function formatRequestStatus(request: MessageRequest, names: Map<string, string>, showIds = false): string {
    const state = requestState(request);
    const descriptions = {
        awaiting_ack: 'Waiting for acknowledgement',
        awaiting_reply: 'Acknowledged · waiting for reply',
        ack_overdue: 'Acknowledgement overdue',
        reply_overdue: 'Reply overdue',
        answered: 'Answered',
        failed: 'Delivery failed'
    };
    return `${state.includes('overdue') || state === 'failed' ? 'ATTENTION: ' : ''}${names.get(request.from) ?? request.from} → ${names.get(request.to) ?? request.to}: ${descriptions[state]}${showIds ? ` [${request.eventId}]` : ''}`;
}

function systemLine(event: RoomEvent, names: Map<string, string>, sender: string, showIds = false): string {
    switch (event.type) {
        case 'participant.joined':
            return `${event.payload.displayName} joined`;
        case 'participant.left':
            return `${sender} left`;
        case 'participant.revoked':
            return `${sender} was removed`;
        case 'handover.offered':
            return `${sender} offered handover ${event.payload.handoverId} rev ${event.payload.revision}: ${event.payload.document.metadata.goal}`;
        case 'handover.accepted':
            return `${sender} accepted handover ${event.payload.handoverId} rev ${event.payload.revision}`;
        case 'handover.declined':
            return `${sender} declined handover ${event.payload.handoverId} rev ${event.payload.revision}`;
        case 'control.pause':
            return `pause requested for ${names.get(event.payload.targetParticipantId) ?? 'someone'}, revision ${event.payload.revision}`;
        case 'control.resume':
            return `resume requested for ${names.get(event.payload.targetParticipantId) ?? 'someone'}, revision ${event.payload.revision}`;
        case 'control.ack':
            return `${sender} acknowledged revision ${event.payload.revision}: ${event.payload.outcome}`;
        case 'room.closed':
            return 'the room was closed';
        case 'room.renamed':
            return `${sender} renamed the room to ${event.payload.name}`;
        case 'room.expiry_changed':
            return event.payload.expiresAt === null ? `${sender} made the room permanent` : `${sender} set the room to expire ${new Date(event.payload.expiresAt).toLocaleString()}`;
        case 'room.access_changed':
            return event.payload.joinPolicy === 'open_to_guests' ? `${sender} opened the room to read-only guests` : `${sender} made the room invite only`;
        case 'message.delivery_failed':
            return `Delivery failed${showIds ? ` [${event.payload.eventId}]` : ''}: ${event.payload.reason} (request remains unanswered)`;
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

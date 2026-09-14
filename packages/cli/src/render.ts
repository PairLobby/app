//! Terminal output. Machine-readable JSON goes to stdout under --json;
//! everything diagnostic goes to stderr so a piped command stays parseable.

import type {RoomEvent, RoomSnapshot} from '@pairlobby/protocol';
import type {RoomEntry} from '@pairlobby/client';

export function out(line = ''): void {
    process.stdout.write(`${line}\n`);
}

export function note(line: string): void {
    process.stderr.write(`${line}\n`);
}

export function json(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Renders an expiry, including the case of a room that has none. */
export function expiryLine(expiresAt: number | null, now = Date.now()): string {
    return expiresAt === null ? 'never expires' : `expires ${relativeTime(expiresAt, now)}`;
}

export function relativeTime(at: number, now = Date.now()): string {
    const seconds = Math.round((at - now) / 1000);
    if (seconds === 0) return 'just now';
    const ahead = seconds > 0;
    const magnitude = Math.abs(seconds);
    const [value, unit] = magnitude < 60 ? [magnitude, 'second'] : magnitude < 3600 ? [Math.round(magnitude / 60), 'minute'] : magnitude < 86_400 ? [Math.round(magnitude / 3600), 'hour'] : [Math.round(magnitude / 86_400), 'day'];
    const plural = value === 1 ? '' : 's';
    return ahead ? `in ${value} ${unit}${plural}` : `${value} ${unit}${plural} ago`;
}

/** The device's own view: which rooms its agents joined, and in which sessions. */
export function renderRooms(rooms: RoomEntry[], now = Date.now()): void {
    if (rooms.length === 0) {
        out('No rooms on this device yet.');
        out('');
        out('  pairlobby create --name my-project     start one');
        out('  pairlobby join K7MP-4QWX               join one with an invite code');
        return;
    }
    const sorted = [...rooms].sort((a, b) => b.createdAt - a.createdAt);
    for (const room of sorted) {
        const expiry = room.expiresAt !== null && room.expiresAt <= now ? 'expired' : expiryLine(room.expiresAt, now);
        out(`${room.name}  ${dim(room.roomId)}`);
        out(`  ${room.serverUrl}  ·  ${expiry}${room.controls ? '  ·  you control this room' : ''}`);
        if (room.sessions.length === 0) out('  no sessions on this device');
        for (const session of room.sessions) {
            const runtime = session.runtime ? ` ${session.runtime}` : '';
            out(`  ${session.displayName}${runtime}  ${dim(session.sessionId)}`);
            out(`    ${session.kind}${session.role === 'controller' ? ', controller' : ''}  ·  read through #${session.lastReadSeq}  ·  joined ${relativeTime(session.joinedAt, now)}`);
            // What a human needs to leave the room and go talk to this agent directly.
            if (session.conversationId) out(`    conversation ${session.conversationId}`);
            else if (session.kind === 'agent') out(`    ${dim('conversation unknown — pass --conversation or run: pairlobby session --conversation <id>')}`);
            if (session.terminal) out(`    ${dim(`terminal ${session.terminal}`)}`);
            out(`    ${dim(session.cwd)}`);
        }
        out('');
    }
}

/** The header of a live room view: where you are, who you are, and who else is here. */
export function renderWatchHeader(snapshot: RoomSnapshot, meParticipantId: string, mySessionId: string, now = Date.now()): void {
    const active = snapshot.participants.filter((participant) => !participant.revoked && !participant.left);
    const people = active.filter((participant) => participant.kind === 'human').length;
    const agents = active.filter((participant) => participant.kind === 'agent').length;
    const me = snapshot.participants.find((participant) => participant.participantId === meParticipantId);

    out(`${snapshot.name}  ${dim(snapshot.roomId)}`);
    if (me) out(`you are ${me.displayName}  ${dim(mySessionId)}`);
    out(`${active.length} in the room: ${count(people, 'person', 'people')}, ${count(agents, 'agent', 'agents')}  ·  ${names(active)}`);
    out(`${snapshot.lifecycle}  ·  ${expiryLine(snapshot.expiresAt, now)}`);
    out('');
}

function count(value: number, one: string, many: string): string {
    return `${value} ${value === 1 ? one : many}`;
}

function names(participants: {displayName: string; kind: string}[]): string {
    return participants.map((participant) => participant.displayName).join(', ');
}

export interface RoomListEntry {
    room: RoomEntry;
    reachable: boolean;
    snapshot?: RoomSnapshot;
    why?: string;
}

/** `pairlobby list`: how many rooms, who is in each, and how each can be joined. */
export function renderRoomList(entries: RoomListEntry[], now = Date.now()): void {
    if (entries.length === 0) {
        out('No rooms on this device.');
        out('');
        out('  pairlobby create --name my-project     start one');
        out('  pairlobby join K7MP-4QWX               join one with an invite code');
        return;
    }
    out(`${entries.length} ${entries.length === 1 ? 'room' : 'rooms'}`);
    out('');
    for (const entry of entries) {
        const {room, snapshot} = entry;
        out(`  ${room.name}  ${dim(room.roomId)}`);
        if (snapshot) {
            const active = snapshot.participants.filter((participant) => !participant.revoked && !participant.left);
            const people = active.filter((participant) => participant.kind === 'human').length;
            const agents = active.filter((participant) => participant.kind === 'agent').length;
            out(`    ${active.length} in the room: ${people} ${people === 1 ? 'person' : 'people'}, ${agents} ${agents === 1 ? 'agent' : 'agents'}  ${dim(active.map((participant) => participant.displayName).join(', '))}`);
            out(`    ${joinPolicyLine(snapshot)}`);
            out(`    ${snapshot.lifecycle}  ·  ${expiryLine(snapshot.expiresAt, now)}${room.controls ? '  ·  you control this room' : ''}`);
        } else {
            out(`    ${dim(`unreachable (${entry.why ?? 'no credential on this device'}) — showing local record only`)}`);
            out(`    ${room.sessions.length} local ${room.sessions.length === 1 ? 'session' : 'sessions'}  ·  ${room.serverUrl}`);
        }
        out('');
    }
}

/** Says plainly whether knowing the room id is enough to get in. */
function joinPolicyLine(snapshot: RoomSnapshot): string {
    return snapshot.policy.joinPolicy === 'open_to_guests'
        ? 'open — anyone with the room id can join as a read-only guest'
        : 'private — an invite code is required, the room id alone is not enough';
}

export function renderSnapshot(snapshot: RoomSnapshot, now = Date.now()): void {
    out(`${snapshot.name}  ${dim(snapshot.roomId)}`);
    out(`  ${snapshot.lifecycle}  ·  ${expiryLine(snapshot.expiresAt, now)}  ·  ${snapshot.latestSeq} events`);
    out('');
    for (const participant of snapshot.participants) {
        const flags = [participant.revoked ? 'removed' : null, participant.left ? 'left' : null, participant.paused ? 'paused' : null, participant.role === 'controller' ? 'controller' : null].filter(Boolean);
        out(`  ${participant.displayName}  ${dim(participant.participantId)}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`);
        // Delivery, acknowledgement, and capability are three different facts; never collapse them into "online".
        const capability = participant.capabilities ? `cancel turn: ${yesNo(participant.capabilities.cancelTurn)}, unsolicited delivery: ${yesNo(participant.capabilities.deliverUnsolicited)}` : 'capabilities unreported';
        out(`    ${capability}`);
        if (participant.controlRevision > 0) out(`    control revision ${participant.controlRevision}: ${participant.acknowledgedOutcome ?? 'no acknowledgement yet'}`);
    }
}

export function renderEvents(events: RoomEvent[], names: Map<string, string>): void {
    for (const event of events) {
        const sender = event.senderId ? names.get(event.senderId) ?? event.senderId : 'room';
        const to = event.recipientId ? ` -> ${names.get(event.recipientId) ?? event.recipientId}` : '';
        out(`#${event.seq}  ${sender}${to}  ${dim(event.type)}`);
        out(`  ${describe(event)}`);
    }
}

function describe(event: RoomEvent): string {
    switch (event.type) {
        case 'message':             return event.payload.text;
        case 'handover.offered':    return `handover ${event.payload.handoverId} revision ${event.payload.revision}: ${event.payload.document.metadata.goal}`;
        case 'handover.accepted':   return `accepted handover ${event.payload.handoverId} revision ${event.payload.revision}`;
        case 'handover.declined':   return `declined handover ${event.payload.handoverId} revision ${event.payload.revision}${event.payload.reason ? `: ${event.payload.reason}` : ''}`;
        case 'participant.joined':  return `${event.payload.displayName} joined as ${event.payload.role}`;
        case 'participant.left':    return 'left the room';
        case 'participant.revoked': return 'was removed from the room';
        case 'control.pause':       return `pause requested, revision ${event.payload.revision}`;
        case 'control.resume':      return `resume requested, revision ${event.payload.revision}`;
        case 'control.ack':         return `acknowledged revision ${event.payload.revision}: ${event.payload.outcome}`;
        case 'room.closed':         return 'the room was closed';
        case 'room.renamed':        return `renamed from ${event.payload.previousName} to ${event.payload.name}`;
        case 'room.expiry_changed':  return event.payload.expiresAt === null ? 'the room no longer expires' : `the room now expires ${relativeTime(event.payload.expiresAt)}`;
        case 'room.access_changed':  return event.payload.joinPolicy === 'open_to_guests' ? 'the room is now open to read-only guests' : 'the room is now invite only';
    }
}

function yesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

function dim(text: string): string {
    return process.stdout.isTTY ? `${DIM}${text}${RESET}` : text;
}

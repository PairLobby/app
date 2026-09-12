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
        const expiry = room.expiresAt <= now ? 'expired' : `expires ${relativeTime(room.expiresAt, now)}`;
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

export function renderSnapshot(snapshot: RoomSnapshot, now = Date.now()): void {
    out(`${snapshot.name}  ${dim(snapshot.roomId)}`);
    out(`  ${snapshot.lifecycle}  ·  expires ${relativeTime(snapshot.expiresAt, now)}  ·  ${snapshot.latestSeq} events`);
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

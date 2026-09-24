//! Legacy transcript projection. The server's durable request ledger is authoritative.
import type {RoomEvent} from '@pairlobby/protocol';
export interface OpenRequest {
    eventId: string;
    seq: number;
    from: string;
    to: string;
    text: string;
    at: number;
    received: boolean;
    waitingMs: number;
    state?: string;
}
export function openRequests(events: RoomEvent[], now = Date.now()): OpenRequest[] {
    const open = new Map<string, OpenRequest>();
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    for (const event of ordered) {
        if (event.type === 'message.received') {
            const request = open.get(event.payload.eventId);
            if (request?.to === event.senderId) {
                request.received = true;
            }
            continue;
        }
        if (event.type !== 'message' || event.senderId === null || event.recipientId === null) {
            continue;
        }
        if (event.replyTo !== null) {
            const target = open.get(event.replyTo);
            if (target && event.senderId === target.to && event.recipientId === target.from && event.payload.responseStage !== 'progress') {
                open.delete(event.replyTo);
            }
            continue;
        }
        open.set(event.eventId, {
            eventId: event.eventId,
            seq: event.seq,
            from: event.senderId,
            to: event.recipientId,
            text: event.payload.text,
            at: event.at,
            received: false,
            waitingMs: Math.max(0, now - event.at)
        });
    }
    return [...open.values()];
}
export function owedByMe(events: RoomEvent[], participantId: string, now = Date.now()): OpenRequest[] {
    return openRequests(events, now).filter((request) => request.to === participantId);
}
export function unreceipted(events: RoomEvent[], participantId: string, allReaders = false): RoomEvent[] {
    const confirmed = new Set(events.flatMap((event) => (event.type === 'message.received' && event.senderId === participantId ? [event.payload.eventId] : [])));
    return events.filter((event) => event.type === 'message' && (allReaders || event.recipientId === participantId) && event.senderId !== participantId && !confirmed.has(event.eventId));
}

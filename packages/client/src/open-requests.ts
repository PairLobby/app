//! Working out which addressed messages are still waiting for an answer.
//!
//! A room deadlocks quietly: someone asks, nobody replies, and everyone waits
//! because nothing on screen says a request went unanswered. This derives that
//! state from the transcript so it can be shown rather than discovered.

import type {RoomEvent} from '@pairlobby/protocol';

export interface OpenRequest {
    /** The message still waiting. */
    eventId: string;
    seq: number;
    from: string;
    to: string;
    text: string;
    at: number;
    /** True once the recipient has confirmed reading it. Read is not answered. */
    received: boolean;
    waitingMs: number;
}

/**
 * A request counts as answered when the recipient either replies to it
 * explicitly, or sends the asker anything at all afterwards.
 *
 * The second rule is deliberate. Requiring `replyTo` would be cleaner, but an
 * agent that answers in plain conversation would be reported as ignoring the
 * request — and a false deadlock warning is worse than none, because people
 * stop reading warnings that lie.
 */
export function openRequests(events: RoomEvent[], now = Date.now()): OpenRequest[] {
    const open = new Map<string, OpenRequest>();
    const ordered = [...events].sort((a, b) => a.seq - b.seq);

    for (const event of ordered) {
        let answered = false;
        if (event.replyTo !== null) {
            for (const [key, request] of open) {
                if (request.eventId === event.replyTo) {
                    open.delete(key);
                    answered = true;
                }
            }
        }
        if (event.type !== 'message' || event.senderId === null || event.recipientId === null) continue;
        if (answered) continue;

        // Speaking to someone who is waiting on you is an answer, and an answer is
        // not itself a new request. Without this, every reply would look like a
        // fresh unanswered ask and the room would always appear stalled.
        const owed = `${event.recipientId}>${event.senderId}`;
        if (open.has(owed)) {
            open.delete(owed);
            continue;
        }
        open.set(`${event.senderId}>${event.recipientId}`, {
            eventId: event.eventId,
            seq: event.seq,
            from: event.senderId,
            to: event.recipientId,
            text: event.payload.text,
            at: event.at,
            received: false,
            waitingMs: 0,
        });
    }

    const receipts = new Set(ordered.flatMap((event) => (event.type === 'message.received' ? [`${event.senderId}:${event.payload.eventId}`] : [])));
    return [...open.values()]
        .map((request) => ({...request, received: receipts.has(`${request.to}:${request.eventId}`), waitingMs: Math.max(0, now - request.at)}))
        .sort((a, b) => a.seq - b.seq);
}

/** The subset this participant owes an answer to. */
export function owedByMe(events: RoomEvent[], participantId: string, now = Date.now()): OpenRequest[] {
    return openRequests(events, now).filter((request) => request.to === participantId);
}

/** Addressed events this participant has not yet confirmed reading. */
export function unreceipted(events: RoomEvent[], participantId: string): RoomEvent[] {
    const confirmed = new Set(events.flatMap((event) => (event.type === 'message.received' && event.senderId === participantId ? [event.payload.eventId] : [])));
    return events.filter((event) => event.recipientId === participantId && event.senderId !== participantId && event.type !== 'message.received' && !confirmed.has(event.eventId));
}

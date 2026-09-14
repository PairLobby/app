//! Starting product limits. These are product choices to validate, not platform
//! limits and not commercial entitlements.

/**
 * How a room may be joined.
 *
 * `open_to_guests` makes the room id sufficient to enter as a read-only guest.
 * That turns the id into a bearer secret, and ids are printed by `list`, by
 * errors, and in logs — which is why opening a room is a deliberate controller
 * action rather than a default.
 */
export type JoinPolicy = 'invite_only' | 'open_to_guests';

export interface RoomPolicy {
    joinPolicy: JoinPolicy;
    maxParticipants: number;
    maxEventPayloadBytes: number;
    maxRetainedEventBytes: number;
    maxRetainedEvents: number;
    /** Milliseconds a new room lives, or null for a room that does not expire. */
    roomLifetimeMs: number | null;
    inviteLifetimeMs: number;
    exportWindowMs: number;
    connectTicketLifetimeMs: number;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Rooms do not expire by default. The roadmap proposed a 24-hour lifetime; in
 * practice a room ending underneath a working pair is worse than one that
 * outlives its usefulness, so expiry is opt-in per room or per device.
 *
 * The roadmap's proposed pairing of a 32 KiB payload cap with 10 MiB of retained
 * payload admits only ~320 maximum-size events, which one 16-participant session
 * exchanging handovers can reach. Retention is raised to 32 MiB and given an
 * explicit event-count companion so both bounds are legible.
 */
export const DEFAULT_ROOM_POLICY: RoomPolicy = {
    joinPolicy: 'invite_only',
    maxParticipants: 16,
    maxEventPayloadBytes: 32 * KIB,
    maxRetainedEventBytes: 32 * MIB,
    maxRetainedEvents: 20_000,
    roomLifetimeMs: null,
    inviteLifetimeMs: 10 * MINUTE,
    exportWindowMs: 24 * HOUR,
    connectTicketLifetimeMs: 30_000,
};

/** Control, close, and export paths stay usable after ordinary writes hit quota. */
export const QUOTA_EXEMPT_EVENT_TYPES = ['control.pause', 'control.resume', 'control.ack', 'participant.revoked', 'room.closed', 'room.renamed', 'room.expiry_changed', 'room.access_changed'] as const;

export function isQuotaExempt(eventType: string): boolean {
    return (QUOTA_EXEMPT_EVENT_TYPES as readonly string[]).includes(eventType);
}

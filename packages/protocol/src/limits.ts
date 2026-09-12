//! Starting product limits. These are product choices to validate, not platform
//! limits and not commercial entitlements.

export interface RoomPolicy {
    maxParticipants: number;
    maxEventPayloadBytes: number;
    maxRetainedEventBytes: number;
    maxRetainedEvents: number;
    roomLifetimeMs: number;
    inviteLifetimeMs: number;
    exportWindowMs: number;
    connectTicketLifetimeMs: number;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The roadmap's proposed pairing of a 32 KiB payload cap with 10 MiB of retained
 * payload admits only ~320 maximum-size events, which one 16-participant session
 * exchanging handovers can reach. Retention is raised to 32 MiB and given an
 * explicit event-count companion so both bounds are legible.
 */
export const DEFAULT_ROOM_POLICY: RoomPolicy = {
    maxParticipants: 16,
    maxEventPayloadBytes: 32 * KIB,
    maxRetainedEventBytes: 32 * MIB,
    maxRetainedEvents: 20_000,
    roomLifetimeMs: 24 * HOUR,
    inviteLifetimeMs: 10 * MINUTE,
    exportWindowMs: 24 * HOUR,
    connectTicketLifetimeMs: 30_000,
};

/** Control, close, and export paths stay usable after ordinary writes hit quota. */
export const QUOTA_EXEMPT_EVENT_TYPES = ['control.pause', 'control.resume', 'control.ack', 'participant.revoked', 'room.closed'] as const;

export function isQuotaExempt(eventType: string): boolean {
    return (QUOTA_EXEMPT_EVENT_TYPES as readonly string[]).includes(eventType);
}

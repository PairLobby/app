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

/** What a plain `/invite` admits: a `member` who can speak, or a read-only `guest`. */
export type InviteRole = 'member' | 'guest';

/**
 * When a room closes itself. One mode per room, so a closure has exactly one reason.
 * `inactivity` counts from the last accepted `message` (replies included), or from
 * creation when there is none; `age` counts from creation; `agents_and_guests_left`
 * arms once an agent or read-only guest has joined and closes when none remain.
 */
export type AutoClosePolicy = {mode: 'off'} | {mode: 'inactivity'; afterMs: number} | {mode: 'age'; afterMs: number} | {mode: 'agents_and_guests_left'};

export type CloseReason = 'manual' | 'inactivity' | 'age' | 'agents_and_guests_left';

/** Shortest auto-close duration a relay accepts. */
export const MIN_AUTO_CLOSE_MS = 1000;

export interface RoomPolicy {
    joinPolicy: JoinPolicy;
    /** Absent on rooms created before invitation defaults existed, which means `member`. */
    inviteRole?: InviteRole;
    /** Absent means off. */
    autoClose?: AutoClosePolicy;
    maxParticipants: number;
    maxEventPayloadBytes: number;
    maxRetainedEventBytes: number;
    maxRetainedEvents: number;
    /** Milliseconds a new room lives, or null for a room that does not expire. */
    roomLifetimeMs: number | null;
    /** Milliseconds a new invite stays redeemable, or null for one that does not expire. */
    inviteLifetimeMs: number | null;
    exportWindowMs: number;
    connectTicketLifetimeMs: number;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Neither rooms nor invites expire by default. The roadmap proposed 24-hour rooms
 * and 10-minute invites; both were guesses, and a code that dies while you are
 * still pasting it is worse than one that outlives its usefulness. Expiry is
 * opt-in per room, per invite, or per device.
 *
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
    inviteRole: 'member',
    maxParticipants: 16,
    maxEventPayloadBytes: 32 * KIB,
    maxRetainedEventBytes: 32 * MIB,
    maxRetainedEvents: 20_000,
    roomLifetimeMs: null,
    inviteLifetimeMs: null,
    exportWindowMs: 24 * HOUR,
    connectTicketLifetimeMs: 30_000
};

/** Control, close, and export paths stay usable after ordinary writes hit quota. */
export const QUOTA_EXEMPT_EVENT_TYPES = [
    'control.pause',
    'control.resume',
    'control.ack',
    'participant.revoked',
    'room.closed',
    'room.renamed',
    'room.expiry_changed',
    'room.access_changed',
    'room.auto_close_changed',
    'message.received',
    'conversation.turn_changed',
    'message.delivery_failed'
] as const;

export function isQuotaExempt(eventType: string): boolean {
    return (QUOTA_EXEMPT_EVENT_TYPES as readonly string[]).includes(eventType);
}

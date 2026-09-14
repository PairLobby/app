//! Durable room records. Connection presence is transient; membership is not —
//! a member can be disconnected without leaving.

import {z} from 'zod';

import {AdapterCapabilities, ControlOutcome, ParticipantKind, ParticipantRole} from './events.js';
import {AttemptId, EventId, HandoverId, ParticipantId, RoomId, SessionId} from './ids.js';
import {HandoverDocument, HandoverState} from './handover.js';

export const RoomLifecycle = z.enum(['open', 'closed', 'expired', 'deleted']);
export type RoomLifecycle = z.infer<typeof RoomLifecycle>;

export const RoomPolicySchema = z.object({
    joinPolicy: z.enum(['invite_only', 'open_to_guests']).default('invite_only'),
    maxParticipants: z.number().int().min(2),
    maxEventPayloadBytes: z.number().int().min(1),
    maxRetainedEventBytes: z.number().int().min(1),
    maxRetainedEvents: z.number().int().min(1),
    roomLifetimeMs: z.number().int().min(1).nullable(),
    inviteLifetimeMs: z.number().int().min(1),
    exportWindowMs: z.number().int().min(0),
    connectTicketLifetimeMs: z.number().int().min(1),
});

export const RoomRecord = z.object({
    roomId: RoomId,
    name: z.string().min(1).max(64),
    createdAt: z.number().int().nonnegative(),
    /** Null for a room that does not expire. */
    expiresAt: z.number().int().nonnegative().nullable(),
    closedAt: z.number().int().nonnegative().nullable(),
    lifecycle: RoomLifecycle,
    policy: RoomPolicySchema,
    controllerCredentialHash: z.string().length(64),
    /** Bumped by every control request so a late acknowledgement cannot overwrite newer state. */
    controlRevision: z.number().int().nonnegative(),
    nextSeq: z.number().int().min(1),
    retainedEventBytes: z.number().int().nonnegative(),
    retainedEvents: z.number().int().nonnegative(),
});
export type RoomRecord = z.infer<typeof RoomRecord>;

export const ParticipantRecord = z.object({
    participantId: ParticipantId,
    roomId: RoomId,
    /** A label for humans. Never an authentication identity and never a routing key on its own. */
    displayName: z.string().min(1).max(64),
    kind: ParticipantKind,
    role: ParticipantRole,
    /** Distinguishes two sessions of the same runtime in the same working directory. */
    sessionId: SessionId.nullable(),
    credentialHash: z.string().length(64),
    capabilities: AdapterCapabilities.nullable(),
    joinedAt: z.number().int().nonnegative(),
    revokedAt: z.number().int().nonnegative().nullable(),
    leftAt: z.number().int().nonnegative().nullable(),
});
export type ParticipantRecord = z.infer<typeof ParticipantRecord>;

export const InviteRedemption = z.enum(['unused', 'reserved', 'redeemed']);
export type InviteRedemption = z.infer<typeof InviteRedemption>;

export const InviteRecord = z.object({
    /** SHA-256 of the normalized code. The code itself is never stored. */
    digest: z.string().length(64),
    roomId: RoomId,
    role: ParticipantRole,
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    state: InviteRedemption,
    /**
     * A reusable code behaves as a seat: it admits one participant at a time and
     * becomes available again when that participant leaves. A single-use code is
     * spent on first redemption.
     */
    reusable: z.boolean().default(true),
    /** Set once an attempt reserves the invite, so a retry of that attempt recovers the same membership. */
    boundAttemptId: AttemptId.nullable(),
    boundCredentialHash: z.string().length(64).nullable(),
    redeemedParticipantId: ParticipantId.nullable(),
    /** Tombstone horizon: a consumed code stays unclaimable by anyone else until this time. */
    recoverableUntil: z.number().int().nonnegative(),
});
export type InviteRecord = z.infer<typeof InviteRecord>;

export const HandoverRecord = z.object({
    handoverId: HandoverId,
    roomId: RoomId,
    senderId: ParticipantId,
    recipientId: ParticipantId,
    /** Immutable per revision. An amendment produces the next revision; acceptance names an exact one. */
    revision: z.number().int().min(1),
    document: HandoverDocument,
    state: HandoverState,
    offeredEventId: EventId,
    resolvedEventId: EventId.nullable(),
    resolvedAt: z.number().int().nonnegative().nullable(),
});
export type HandoverRecord = z.infer<typeof HandoverRecord>;

export const ControlRecord = z.object({
    roomId: RoomId,
    targetParticipantId: ParticipantId,
    paused: z.boolean(),
    revision: z.number().int().min(1),
    requestedAt: z.number().int().nonnegative(),
    acknowledgedRevision: z.number().int().nonnegative(),
    acknowledgedOutcome: ControlOutcome.nullable(),
    acknowledgedAt: z.number().int().nonnegative().nullable(),
});
export type ControlRecord = z.infer<typeof ControlRecord>;

/** What a member sees about another participant. Credential hashes never leave the server. */
export const ParticipantView = z.object({
    participantId: ParticipantId,
    displayName: z.string(),
    kind: ParticipantKind,
    role: ParticipantRole,
    capabilities: AdapterCapabilities.nullable(),
    joinedAt: z.number().int().nonnegative(),
    revoked: z.boolean(),
    left: z.boolean(),
    paused: z.boolean(),
    controlRevision: z.number().int().nonnegative(),
    acknowledgedOutcome: ControlOutcome.nullable(),
});
export type ParticipantView = z.infer<typeof ParticipantView>;

export const RoomSnapshot = z.object({
    roomId: RoomId,
    name: z.string(),
    lifecycle: RoomLifecycle,
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
    closedAt: z.number().int().nonnegative().nullable(),
    controlRevision: z.number().int().nonnegative(),
    latestSeq: z.number().int().nonnegative(),
    earliestSeq: z.number().int().nonnegative(),
    participants: z.array(ParticipantView),
    policy: RoomPolicySchema,
});
export type RoomSnapshot = z.infer<typeof RoomSnapshot>;

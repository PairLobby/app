//! The v1 HTTP contract. Every route authenticates and authorizes independently;
//! a generic events endpoint must not become a way around control authorization.

import {z} from 'zod';

import {AdapterCapabilities, ParticipantKind, ParticipantRole, RoomEvent, SendEventRequest} from './events.js';
import {AttemptId, ParticipantId, RoomId, SessionId} from './ids.js';
import {HandoverRecord, RoomSnapshot} from './records.js';
import {ERROR_CODES} from './errors.js';

export const ROUTES = {
    createRoom:        {method: 'POST',   path: '/v1/rooms'},
    redeemInvite:      {method: 'POST',   path: '/v1/invites/redeem'},
    createInvite:      {method: 'POST',   path: '/v1/rooms/:roomId/invites'},
    getRoom:           {method: 'GET',    path: '/v1/rooms/:roomId'},
    readEvents:        {method: 'GET',    path: '/v1/rooms/:roomId/events'},
    sendEvent:         {method: 'POST',   path: '/v1/rooms/:roomId/events'},
    connectTicket:     {method: 'POST',   path: '/v1/rooms/:roomId/connect-ticket'},
    connect:           {method: 'GET',    path: '/v1/rooms/:roomId/connect'},
    control:           {method: 'POST',   path: '/v1/rooms/:roomId/control'},
    revokeParticipant: {method: 'DELETE', path: '/v1/rooms/:roomId/participants/:participantId'},
    renameRoom:        {method: 'POST',   path: '/v1/rooms/:roomId/name'},
    closeRoom:         {method: 'POST',   path: '/v1/rooms/:roomId/close'},
    exportRoom:        {method: 'GET',    path: '/v1/rooms/:roomId/export'},
    deleteRoom:        {method: 'DELETE', path: '/v1/rooms/:roomId'},
} as const;

const identity = z.object({
    displayName: z.string().min(1).max(64),
    kind: ParticipantKind,
    sessionId: SessionId.optional(),
    capabilities: AdapterCapabilities.optional(),
});

export const CreateRoomRequest = z.intersection(identity, z.object({
    name: z.string().min(1).max(64),
    /** Client-generated so a lost response never strands a credential the caller does not hold. */
    controllerCredential: z.string().min(32).max(256),
    participantCredential: z.string().min(32).max(256),
}));
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;

export const CreateRoomResponse = z.object({
    room: RoomSnapshot,
    participantId: ParticipantId,
    invite: z.object({code: z.string(), expiresAt: z.number().int().nonnegative()}),
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;

export const RedeemInviteRequest = z.intersection(identity, z.object({
    code: z.string().min(1).max(32),
    /** Stable across retries of the same join, so a crashed redemption resumes instead of forking. */
    attemptId: AttemptId,
    attemptSecret: z.string().min(32).max(256),
    participantCredential: z.string().min(32).max(256),
}));
export type RedeemInviteRequest = z.infer<typeof RedeemInviteRequest>;

export const RedeemInviteResponse = z.object({
    roomId: RoomId,
    participantId: ParticipantId,
    role: ParticipantRole,
    room: RoomSnapshot,
});
export type RedeemInviteResponse = z.infer<typeof RedeemInviteResponse>;

export const CreateInviteRequest = z.object({role: ParticipantRole.default('member'), reusable: z.boolean().default(true)});
export const CreateInviteResponse = z.object({code: z.string(), expiresAt: z.number().int().nonnegative(), reusable: z.boolean()});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

export const ReadEventsQuery = z.object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ReadEventsQuery = z.infer<typeof ReadEventsQuery>;

export const ReadEventsResponse = z.object({
    events: z.array(RoomEvent),
    earliestSeq: z.number().int().nonnegative(),
    latestSeq: z.number().int().nonnegative(),
    hasMore: z.boolean(),
});
export type ReadEventsResponse = z.infer<typeof ReadEventsResponse>;

export {SendEventRequest};

export const SendEventResponse = z.object({
    event: RoomEvent,
    /** True when the idempotency key replayed an already-accepted event. */
    deduplicated: z.boolean(),
});
export type SendEventResponse = z.infer<typeof SendEventResponse>;

/**
 * A browser cannot set headers on a WebSocket handshake and a long-lived secret
 * must not sit in a query string, so `connect` takes a short-lived single-use
 * ticket minted here by an ordinary authenticated request. CLI clients may
 * instead present their participant credential as a handshake header.
 */
export const ConnectTicketResponse = z.object({ticket: z.string(), expiresAt: z.number().int().nonnegative()});
export type ConnectTicketResponse = z.infer<typeof ConnectTicketResponse>;

export const RenameRoomRequest = z.object({name: z.string().min(1).max(64)});
export type RenameRoomRequest = z.infer<typeof RenameRoomRequest>;

export const ControlRequest = z.object({targetParticipantId: ParticipantId, paused: z.boolean()});
export type ControlRequest = z.infer<typeof ControlRequest>;

export const ControlResponse = z.object({revision: z.number().int().min(1), event: RoomEvent});
export type ControlResponse = z.infer<typeof ControlResponse>;

export const ExportResponse = z.object({
    room: RoomSnapshot,
    events: z.array(RoomEvent),
    handovers: z.array(HandoverRecord),
    exportedAt: z.number().int().nonnegative(),
    /** False when retention already dropped events older than `room.earliestSeq`. */
    complete: z.boolean(),
});
export type ExportResponse = z.infer<typeof ExportResponse>;

export const ErrorResponse = z.object({
    error: z.object({
        code: z.enum(ERROR_CODES),
        message: z.string(),
        retryAfterMs: z.number().int().nonnegative().optional(),
        earliestAvailableSeq: z.number().int().nonnegative().optional(),
        currentRevision: z.number().int().nonnegative().optional(),
    }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

//! Room events. Clients submit an `EventSubmission`; the server assigns sender,
//! sequence, id, and timestamp and persists a `RoomEvent`.

import {z} from 'zod';

import {EventId, HandoverId, ParticipantId, RoomId} from './ids.js';
import {HandoverDocument} from './handover.js';

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_VERSION_HEADER = 'pairlobby-protocol';

export const ParticipantKind = z.enum(['agent', 'human']);
export type ParticipantKind = z.infer<typeof ParticipantKind>;

/**
 * A guest may read the room and leave it. Nothing else: no messages, no
 * handovers, no acknowledgements, no invites, no control.
 */
export const ParticipantRole = z.enum(['guest', 'member', 'controller']);
export type ParticipantRole = z.infer<typeof ParticipantRole>;

/**
 * What an adapter reports actually happened, kept distinct from what the
 * controller asked for. A human message alone never claims cancellation.
 */
export const ControlOutcome = z.enum(['pause_requested', 'paused_between_turns', 'current_turn_cancelled', 'tool_cancellation_unknown', 'resumed', 'unsupported', 'disconnected']);
export type ControlOutcome = z.infer<typeof ControlOutcome>;

export const AdapterCapabilities = z.object({
    /** The adapter can deliver an unsolicited message into a running session. */
    deliverUnsolicited: z.boolean().default(false),
    /** The adapter can end the model's current turn on request. */
    cancelTurn: z.boolean().default(false),
    /** The adapter can stop a tool the session is currently running. */
    cancelTool: z.boolean().default(false),
    runtime: z.string().min(1).max(128).optional(),
    runtimeVersion: z.string().min(1).max(64).optional()
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>;

const messagePayload = z.object({
    text: z
        .string()
        .min(1)
        .max(32 * 1024)
        .refine((text) => text.trim().length > 0, 'message must not be blank'),
    priority: z.enum(['normal', 'priority']).default('normal'),
    responseStage: z.enum(['progress', 'final']).optional()
});

/** A participant confirms receipt of a message; only the target satisfies an addressed request. */
const messageReceivedPayload = z.object({eventId: EventId});
const deliveryFailedPayload = z.object({eventId: EventId, reason: z.string().min(1).max(1024)});

const handoverOfferedPayload = z.object({handoverId: HandoverId, revision: z.number().int().min(1), document: HandoverDocument});
const handoverAcceptedPayload = z.object({handoverId: HandoverId, revision: z.number().int().min(1), note: z.string().max(2048).optional()});
const handoverDeclinedPayload = z.object({handoverId: HandoverId, revision: z.number().int().min(1), reason: z.string().max(2048).optional()});

const participantJoinedPayload = z.object({
    participantId: ParticipantId,
    displayName: z.string().min(1).max(64),
    kind: ParticipantKind,
    role: ParticipantRole,
    capabilities: AdapterCapabilities.optional()
});
const participantLeftPayload = z.object({participantId: ParticipantId});
const participantRevokedPayload = z.object({participantId: ParticipantId});

const controlPausePayload = z.object({targetParticipantId: ParticipantId, revision: z.number().int().min(1), reason: z.string().max(512).optional()});
const controlResumePayload = z.object({targetParticipantId: ParticipantId, revision: z.number().int().min(1)});
const controlAckPayload = z.object({targetParticipantId: ParticipantId, revision: z.number().int().min(1), outcome: ControlOutcome, detail: z.string().max(512).optional()});

const roomClosedPayload = z.object({exportWindowEndsAt: z.number().int().nonnegative()});
const roomRenamedPayload = z.object({name: z.string().min(1).max(64), previousName: z.string().min(1).max(64)});
const roomExpiryChangedPayload = z.object({expiresAt: z.number().int().nonnegative().nullable(), previousExpiresAt: z.number().int().nonnegative().nullable()});
const roomAccessChangedPayload = z.object({joinPolicy: z.enum(['invite_only', 'open_to_guests'])});

/** Event types a client may submit. Membership and control events are server-authored. */
export const CLIENT_EVENT_TYPES = ['message', 'message.received', 'message.delivery_failed', 'handover.offered', 'handover.accepted', 'handover.declined', 'control.ack'] as const;

export const EventSubmission = z.discriminatedUnion('type', [
    z.object({type: z.literal('message'), payload: messagePayload}),
    z.object({type: z.literal('message.received'), payload: messageReceivedPayload}),
    z.object({type: z.literal('message.delivery_failed'), payload: deliveryFailedPayload}),
    z.object({type: z.literal('handover.offered'), payload: handoverOfferedPayload}),
    z.object({type: z.literal('handover.accepted'), payload: handoverAcceptedPayload}),
    z.object({type: z.literal('handover.declined'), payload: handoverDeclinedPayload}),
    z.object({type: z.literal('control.ack'), payload: controlAckPayload})
]);
export type EventSubmission = z.infer<typeof EventSubmission>;

export const EventBody = z.discriminatedUnion('type', [
    z.object({type: z.literal('message'), payload: messagePayload}),
    z.object({type: z.literal('message.received'), payload: messageReceivedPayload}),
    z.object({type: z.literal('message.delivery_failed'), payload: deliveryFailedPayload}),
    z.object({type: z.literal('handover.offered'), payload: handoverOfferedPayload}),
    z.object({type: z.literal('handover.accepted'), payload: handoverAcceptedPayload}),
    z.object({type: z.literal('handover.declined'), payload: handoverDeclinedPayload}),
    z.object({type: z.literal('participant.joined'), payload: participantJoinedPayload}),
    z.object({type: z.literal('participant.left'), payload: participantLeftPayload}),
    z.object({type: z.literal('participant.revoked'), payload: participantRevokedPayload}),
    z.object({type: z.literal('control.pause'), payload: controlPausePayload}),
    z.object({type: z.literal('control.resume'), payload: controlResumePayload}),
    z.object({type: z.literal('control.ack'), payload: controlAckPayload}),
    z.object({type: z.literal('room.closed'), payload: roomClosedPayload}),
    z.object({type: z.literal('room.renamed'), payload: roomRenamedPayload}),
    z.object({type: z.literal('room.expiry_changed'), payload: roomExpiryChangedPayload}),
    z.object({type: z.literal('room.access_changed'), payload: roomAccessChangedPayload}),
    z.object({type: z.literal('room.lock_changed'), payload: z.object({locked: z.boolean()})}),
    z.object({type: z.literal('participant.mute_changed'), payload: z.object({participantId: ParticipantId, muted: z.boolean()})}),
    z.object({type: z.literal('conversation.turn_changed'), payload: z.object({action: z.enum(['claimed', 'passed', 'skipped', 'cancelled', 'mode']), requestIds: z.array(EventId).max(32), participantIds: z.array(ParticipantId).max(32), mode: z.enum(['sequential', 'parallel'])})})
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventType = EventBody['type'];

const envelope = z.object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    roomId: RoomId,
    seq: z.number().int().min(1),
    eventId: EventId,
    /** Null for events the server authored on its own behalf, such as expiry-driven closure. */
    senderId: ParticipantId.nullable(),
    idempotencyKey: z.string().min(1).max(128).nullable(),
    /** A routing hint, not a private-message boundary: every member reads the whole transcript. */
    recipientId: ParticipantId.nullable(),
    recipientIds: z.array(ParticipantId).min(1).max(32).optional(),
    replyTo: EventId.nullable(),
    at: z.number().int().nonnegative()
});

export const RoomEvent = z.intersection(envelope, EventBody);
export type RoomEvent = z.infer<typeof RoomEvent>;

export const SendEventRequest = z.intersection(
    z.object({
        idempotencyKey: z.string().min(1).max(128),
        recipientId: ParticipantId.optional(),
        recipientIds: z.array(ParticipantId).min(1).max(32).optional(),
        allRecipients: z.boolean().optional(),
        turnToken: z.string().min(16).max(128).optional(),
        replyTo: EventId.optional()
    }),
    EventSubmission
);
export type SendEventRequest = z.infer<typeof SendEventRequest>;

export function isClientEventType(type: string): type is (typeof CLIENT_EVENT_TYPES)[number] {
    return (CLIENT_EVENT_TYPES as readonly string[]).includes(type);
}

/** Byte size the payload counts against room quota. */
export function payloadBytes(event: Pick<RoomEvent, 'payload'>): number {
    return new TextEncoder().encode(JSON.stringify(event.payload)).length;
}

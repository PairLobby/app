//! Room state transitions. Each returns one atomic mutation for a storage
//! adapter to apply together with its idempotency record.

import {RenameSelfRequest, DEFAULT_ROOM_POLICY, ProtocolError, newId} from '@pairlobby/protocol';
import type {
    AdapterCapabilities,
    EventSubmission,
    HandoverRecord,
    ParticipantKind,
    NameSource,
    ParticipantRecord,
    ParticipantRole,
    RoomPolicy,
    RoomRecord,
    SendEventRequest
} from '@pairlobby/protocol';

import {appendEvent} from './append.js';
import {assertActiveMember, assertCanWrite, assertRoomJoinable, assertController, assertRecipientExists, assertRoomWritable, authenticate, type Actor} from './authorize.js';
import {applyHandoverAccepted, applyHandoverDeclined, applyHandoverOffered} from './handover.js';
import {activeParticipants, controlFor, emptyMutation, findParticipant, isActive, type CoreContext, type Mutation, type RoomView} from './state.js';

type ControlAcknowledgement = {targetParticipantId: string; revision: number; outcome: string};

export interface Identity {
    displayName: string;
    nameSource?: NameSource | undefined;
    kind: ParticipantKind;
    sessionId: string | null;
    capabilities: AdapterCapabilities | null;
}

export interface CreateRoomInput extends Identity {
    name: string;
    roomId: string;
    /** Explicit expiry, overriding the policy lifetime. Null means it never expires. */
    expiresAt?: number | null;
    controllerCredentialHash: string;
    participantCredentialHash: string;
    policy?: RoomPolicy;
}

export interface CreatedRoom {
    room: RoomRecord;
    participant: ParticipantRecord;
    mutation: Mutation;
}

export function createRoom(input: CreateRoomInput, ctx: CoreContext): CreatedRoom {
    const policy = input.policy ?? DEFAULT_ROOM_POLICY;
    const room: RoomRecord = {
        roomId: input.roomId,
        name: input.name,
        createdAt: ctx.now,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : policy.roomLifetimeMs === null ? null : ctx.now + policy.roomLifetimeMs,
        closedAt: null,
        lifecycle: 'open',
        policy,
        controllerCredentialHash: input.controllerCredentialHash,
        controlRevision: 0,
        nextSeq: 1,
        retainedEventBytes: 0,
        retainedEvents: 0
    };
    const participant = buildParticipant(input.roomId, input, 'member', input.participantCredentialHash, ctx);
    const {room: afterEvent, event} = appendEvent(
        room,
        {
            senderId: participant.participantId,
            idempotencyKey: null,
            recipientId: null,
            replyTo: null,
            body: {type: 'participant.joined', payload: joinPayload(participant)}
        },
        ctx
    );
    return {room: afterEvent, participant, mutation: {...emptyMutation(afterEvent, event), upsertParticipants: [participant]}};
}

export interface JoinRoomInput extends Identity {
    role: ParticipantRole;
    credentialHash: string;
}

export interface JoinedRoom {
    participant: ParticipantRecord;
    mutation: Mutation;
}

/** Called by invite redemption once the invite object has bound this attempt. */
export function joinRoom(view: RoomView, input: JoinRoomInput, ctx: CoreContext): JoinedRoom {
    assertRoomJoinable(view, ctx.now);
    const existing = view.participants.find((candidate) => candidate.credentialHash === input.credentialHash);
    if (existing) {
        throw new ProtocolError('idempotency_conflict', 'this credential already belongs to a participant of this room');
    }
    if (activeParticipants(view).length >= view.room.policy.maxParticipants) {
        throw new ProtocolError('participant_limit_reached', `this room already holds its limit of ${view.room.policy.maxParticipants} participants`);
    }
    const participant = buildParticipant(view.room.roomId, input, input.role, input.credentialHash, ctx);
    const {room, event} = appendEvent(
        view.room,
        {
            senderId: participant.participantId,
            idempotencyKey: null,
            recipientId: null,
            replyTo: null,
            body: {type: 'participant.joined', payload: joinPayload(participant)}
        },
        ctx
    );
    return {participant, mutation: {...emptyMutation(room, event), upsertParticipants: [participant]}};
}

export function sendEvent(view: RoomView, credentialHash: string, request: SendEventRequest, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertRoomWritable(view, ctx.now);
    const sender = assertCanWrite(actor);
    const recipientId = request.recipientId ?? null;
    if (recipientId !== null) {
        assertRecipientExists(view, recipientId);
    }
    const submission: EventSubmission = {type: request.type, payload: request.payload} as EventSubmission;
    const upsertHandovers: HandoverRecord[] = [];
    const upsertControls = [];

    switch (submission.type) {
        case 'handover.offered':
            upsertHandovers.push(applyHandoverOffered(view, sender, submission.payload, recipientId, ctx));
            break;
        case 'handover.accepted':
            upsertHandovers.push(applyHandoverAccepted(view, sender, submission.payload));
            break;
        case 'handover.declined':
            upsertHandovers.push(applyHandoverDeclined(view, sender, submission.payload));
            break;
        case 'control.ack':
            upsertControls.push(applyControlAck(view, sender, submission.payload, ctx));
            break;
        case 'message':
            break;
    }

    const {room, event} = appendEvent(
        view.room,
        {
            senderId: sender.participantId,
            idempotencyKey: request.idempotencyKey,
            recipientId,
            replyTo: request.replyTo ?? null,
            ...(request.quoteOf ? {quoteOf: request.quoteOf} : {}),
            body: submission
        },
        ctx
    );

    // A handover offer records the event that carried it, so the offer is traceable from the record alone.
    const handovers = upsertHandovers.map((handover) =>
        submission.type === 'handover.offered' ? {...handover, offeredEventId: event.eventId} : {...handover, resolvedEventId: event.eventId, resolvedAt: ctx.now}
    );
    return {...emptyMutation(room, event), upsertHandovers: handovers, upsertControls};
}

export function requestControl(view: RoomView, credentialHash: string, targetParticipantId: string, paused: boolean, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    const target = findParticipant(view, targetParticipantId);
    if (!target || !isActive(target)) {
        throw new ProtocolError('invalid_request', 'control target is not an active participant of this room');
    }
    const revision = view.room.controlRevision + 1;
    const previous = controlFor(view, targetParticipantId);
    const control = {
        roomId: view.room.roomId,
        targetParticipantId,
        paused,
        revision,
        requestedAt: ctx.now,
        acknowledgedRevision: previous?.acknowledgedRevision ?? 0,
        acknowledgedOutcome: previous?.acknowledgedOutcome ?? null,
        acknowledgedAt: previous?.acknowledgedAt ?? null
    };
    const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
    const body = paused ? {type: 'control.pause' as const, payload: {targetParticipantId, revision}} : {type: 'control.resume' as const, payload: {targetParticipantId, revision}};
    const {room, event} = appendEvent({...view.room, controlRevision: revision}, {senderId, idempotencyKey: null, recipientId: targetParticipantId, replyTo: null, body}, ctx);
    return {...emptyMutation(room, event), upsertControls: [control]};
}

export function revokeParticipant(view: RoomView, credentialHash: string, targetParticipantId: string, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    const target = findParticipant(view, targetParticipantId);
    if (!target) {
        throw new ProtocolError('invalid_request', 'no such participant in this room');
    }
    if (target.revokedAt !== null) {
        throw new ProtocolError('idempotency_conflict', 'this participant was already removed');
    }
    const revoked: ParticipantRecord = {...target, revokedAt: ctx.now};
    const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
    const {room, event} = appendEvent(
        view.room,
        {senderId, idempotencyKey: null, recipientId: null, replyTo: null, body: {type: 'participant.revoked', payload: {participantId: targetParticipantId}}},
        ctx
    );
    return {...emptyMutation(room, event), upsertParticipants: [revoked]};
}

export function leaveRoom(view: RoomView, credentialHash: string, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    const participant = assertActiveMember(actor);
    assertRoomWritable(view, ctx.now);
    const left: ParticipantRecord = {...participant, leftAt: ctx.now};
    const {room, event} = appendEvent(
        view.room,
        {
            senderId: participant.participantId,
            idempotencyKey: null,
            recipientId: null,
            replyTo: null,
            body: {type: 'participant.left', payload: {participantId: participant.participantId}}
        },
        ctx
    );
    return {...emptyMutation(room, event), upsertParticipants: [left]};
}

/** Restore the same authenticated membership without creating a new identity or role. */
export function rejoinRoom(view: RoomView, credentialHash: string, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    if (actor.kind !== 'participant') {
        throw new ProtocolError('unauthorized', 'rejoining requires the saved participant credential');
    }
    assertRoomJoinable(view, ctx.now);
    const activeCount = activeParticipants(view).length;
    if (activeCount >= view.room.policy.maxParticipants) {
        throw new ProtocolError('participant_limit_reached', 'this room has reached its participant limit');
    }
    const participant: ParticipantRecord = {...actor.participant, leftAt: null};
    const {room, event} = appendEvent(view.room, {
        senderId: participant.participantId,
        idempotencyKey: null,
        recipientId: null,
        replyTo: null,
        body: {type: 'participant.joined', payload: joinPayload(participant)}
    }, ctx);
    return {...emptyMutation(room, event), upsertParticipants: [participant]};
}

/** Change only the authenticated participant's label, preserving membership and permissions. */
export function renameSelf(view: RoomView, credentialHash: string, input: RenameSelfRequest, ctx: CoreContext): Mutation | null {
    const participant = assertCanWrite(authenticate(view, credentialHash, ctx.now));
    assertRoomWritable(view, ctx.now);
    const parsed = RenameSelfRequest.safeParse(input);
    if (!parsed.success) {
        throw new ProtocolError('invalid_request', 'Use a name of 1–64 characters without control characters; all is reserved.');
    }
    const {name, source} = parsed.data;
    if (source === 'profile' && participant.nameSource === 'room') {
        return null;
    }
    if (participant.displayName === name && participant.nameSource === source) {
        return null;
    }
    const {room, event} = appendEvent(view.room, {
        senderId: participant.participantId,
        idempotencyKey: null,
        recipientId: null,
        replyTo: null,
        body: {type: 'participant.renamed', payload: {participantId: participant.participantId, previousName: participant.displayName, name, source}}
    }, ctx);
    return {...emptyMutation(room, event), upsertParticipants: [{...participant, displayName: name, nameSource: source}]};
}

export function renameRoom(view: RoomView, credentialHash: string, name: string, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    const previousName = view.room.name;
    if (previousName === name) {
        throw new ProtocolError('invalid_request', 'the room already has that name');
    }
    const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
    const {room, event} = appendEvent(
        {...view.room, name},
        {senderId, idempotencyKey: null, recipientId: null, replyTo: null, body: {type: 'room.renamed', payload: {name, previousName}}},
        ctx
    );
    return emptyMutation(room, event);
}

/** Sets or clears when a room expires. Null stops it expiring at all. */
/** Opens or closes guest entry. Controller only. */
export function setJoinPolicy(view: RoomView, credentialHash: string, joinPolicy: 'invite_only' | 'open_to_guests', ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    if (view.room.policy.joinPolicy === joinPolicy) {
        throw new ProtocolError('invalid_request', joinPolicy === 'open_to_guests' ? 'this room is already open to guests' : 'this room is already invite only');
    }
    const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
    const room = {...view.room, policy: {...view.room.policy, joinPolicy}};
    const {room: updated, event} = appendEvent(
        room,
        {senderId, idempotencyKey: null, recipientId: null, replyTo: null, body: {type: 'room.access_changed', payload: {joinPolicy}}},
        ctx
    );
    return emptyMutation(updated, event);
}

/**
 * Admits a read-only guest. There is no invite to redeem: the caller's claim is
 * that they know the room id, which is only sufficient while the room says so.
 */
export function joinAsGuest(view: RoomView, input: Omit<JoinRoomInput, 'role'>, ctx: CoreContext): JoinedRoom {
    if (view.room.policy.joinPolicy !== 'open_to_guests') {
        throw new ProtocolError('unauthorized', 'this room is invite only; ask its owner for a code');
    }
    return joinRoom(view, {...input, role: 'guest'}, ctx);
}

export function setExpiry(view: RoomView, credentialHash: string, expiresAt: number | null, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    if (expiresAt !== null && expiresAt <= ctx.now) {
        throw new ProtocolError('invalid_request', 'that expiry time is already in the past');
    }
    const previousExpiresAt = view.room.expiresAt;
    if (previousExpiresAt === expiresAt) {
        throw new ProtocolError('invalid_request', expiresAt === null ? 'this room already does not expire' : 'the room already expires then');
    }
    const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
    const {room, event} = appendEvent(
        {...view.room, expiresAt},
        {senderId, idempotencyKey: null, recipientId: null, replyTo: null, body: {type: 'room.expiry_changed', payload: {expiresAt, previousExpiresAt}}},
        ctx
    );
    return emptyMutation(room, event);
}

export function closeRoom(view: RoomView, credentialHash: string, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    const closed: RoomRecord = {...view.room, lifecycle: 'closed', closedAt: ctx.now};
    const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
    const {room, event} = appendEvent(
        closed,
        {senderId, idempotencyKey: null, recipientId: null, replyTo: null, body: {type: 'room.closed', payload: {exportWindowEndsAt: ctx.now + view.room.policy.exportWindowMs}}},
        ctx
    );
    return emptyMutation(room, event);
}

function applyControlAck(view: RoomView, sender: ParticipantRecord, payload: ControlAcknowledgement, ctx: CoreContext) {
    if (payload.targetParticipantId !== sender.participantId) {
        throw new ProtocolError('unauthorized', 'a participant may only acknowledge control requests addressed to itself');
    }
    const control = controlFor(view, sender.participantId);
    if (!control) {
        throw new ProtocolError('invalid_request', 'no control request is outstanding for this participant');
    }
    if (payload.revision > control.revision) {
        throw new ProtocolError('invalid_request', 'acknowledged a control revision the server never issued');
    }
    // A late acknowledgement is still true history, so it is accepted and appended.
    // It simply does not overwrite state that a newer revision already set.
    if (payload.revision < control.revision || payload.revision < control.acknowledgedRevision) {
        return control;
    }
    return {...control, acknowledgedRevision: payload.revision, acknowledgedOutcome: payload.outcome as never, acknowledgedAt: ctx.now};
}

function buildParticipant(roomId: string, identity: Identity, role: ParticipantRole, credentialHash: string, ctx: CoreContext): ParticipantRecord {
    return {
        participantId: newId('participant'),
        roomId,
        displayName: identity.displayName,
        ...(identity.nameSource ? {nameSource: identity.nameSource} : {}),
        kind: identity.kind,
        role,
        sessionId: identity.sessionId,
        credentialHash,
        capabilities: identity.capabilities,
        joinedAt: ctx.now,
        revokedAt: null,
        leftAt: null
    };
}

function joinPayload(participant: ParticipantRecord) {
    return {
        participantId: participant.participantId,
        displayName: participant.displayName,
        kind: participant.kind,
        role: participant.role,
        ...(participant.capabilities ? {capabilities: participant.capabilities} : {})
    };
}

export type {Actor};

export function setLocked(view: RoomView, credentialHash: string, locked: boolean, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
    const {room, event} = appendEvent({...view.room, locked}, {
        senderId, idempotencyKey: null, recipientId: null, replyTo: null,
        body: {type: 'room.lock_changed', payload: {locked}}
    }, ctx);
    return emptyMutation(room, event);
}

export function setMuted(view: RoomView, credentialHash: string, participantId: string, muted: boolean, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    const target = assertRecipientExists(view, participantId);
    const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
    const {room, event} = appendEvent(view.room, {
        senderId, idempotencyKey: null, recipientId: null, replyTo: null,
        body: {type: 'participant.mute_changed', payload: {participantId, muted}}
    }, ctx);
    return {...emptyMutation(room, event), upsertParticipants: [{...target, muted}]};
}

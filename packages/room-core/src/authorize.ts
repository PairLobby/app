//! Authorization runs on every operation, including events arriving on a socket
//! that was authorized when it opened.

import {ProtocolError, digestsEqual} from '@pairlobby/protocol';
import type {ParticipantRecord} from '@pairlobby/protocol';

import {findParticipant, isActive, type RoomView} from './state.js';

export type Actor = {kind: 'participant'; participant: ParticipantRecord} | {kind: 'controller'};

/** Room lifecycle is checked at request time; physical cleanup is maintenance, not the access boundary. */
export function assertRoomReadable(view: RoomView, now: number): void {
    if (view.room.lifecycle === 'deleted') throw new ProtocolError('room_not_found', 'this room no longer exists');
    if (view.room.lifecycle === 'expired' || (view.room.expiresAt !== null && now >= view.room.expiresAt)) throw new ProtocolError('room_expired', 'this room has expired');
    if (view.room.lifecycle === 'closed' && view.room.closedAt !== null && now >= view.room.closedAt + view.room.policy.exportWindowMs) {
        throw new ProtocolError('room_expired', 'this room was closed and its export window has ended');
    }
}

export function assertRoomWritable(view: RoomView, now: number): void {
    assertRoomReadable(view, now);
    if (view.room.lifecycle === 'closed') throw new ProtocolError('room_closed', 'this room is closed to new activity');
}

export function authenticate(view: RoomView, credentialHash: string, now: number): Actor {
    assertRoomReadable(view, now);
    if (digestsEqual(credentialHash, view.room.controllerCredentialHash)) return {kind: 'controller'};
    const participant = view.participants.find((candidate) => digestsEqual(candidate.credentialHash, credentialHash));
    if (!participant) throw new ProtocolError('unauthorized', 'credential not recognized for this room');
    if (participant.revokedAt !== null) throw new ProtocolError('participant_revoked', 'this participant was removed from the room');
    return {kind: 'participant', participant};
}

export function assertController(actor: Actor): void {
    if (actor.kind === 'controller') return;
    if (actor.participant.role === 'controller') return;
    throw new ProtocolError('unauthorized', 'this action requires the room controller credential');
}

/**
 * A guest may read and leave. Every other participant action goes through here,
 * so adding a write path without thinking about guests fails closed.
 */
export function assertCanWrite(actor: Actor): ParticipantRecord {
    const participant = assertActiveMember(actor);
    if (participant.role === 'guest') throw new ProtocolError('unauthorized', 'guests can read this room but cannot take part in it');
    return participant;
}

export function assertActiveMember(actor: Actor): ParticipantRecord {
    if (actor.kind !== 'participant') throw new ProtocolError('unauthorized', 'this action requires a room participant');
    if (!isActive(actor.participant)) throw new ProtocolError('participant_revoked', 'this participant is no longer in the room');
    return actor.participant;
}

export function assertRecipientExists(view: RoomView, recipientId: string): ParticipantRecord {
    const recipient = findParticipant(view, recipientId);
    if (!recipient || !isActive(recipient)) throw new ProtocolError('invalid_request', 'recipient is not an active participant of this room');
    return recipient;
}

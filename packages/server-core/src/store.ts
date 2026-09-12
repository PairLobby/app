//! The storage contract. It expresses atomic application operations rather than
//! imitating a database API, so a Durable Object's SQL transaction and a Node
//! server's SQLite transaction implement the same small surface.

import type {HandoverRecord, InviteRecord, ParticipantRecord, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';

export interface IdempotencyRecord {
    requestDigest: string;
    seq: number;
}

export interface EventPage {
    events: RoomEvent[];
    hasMore: boolean;
}

export interface RoomStore {
    /** Creates the room, its first participant, and the joined event in one transaction. */
    createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void>;

    loadRoom(roomId: string): Promise<RoomView | null>;

    /**
     * Applies every part of a mutation together with its idempotency record.
     * A partial application is a correctness bug, not a degraded mode.
     */
    apply(mutation: Mutation, idempotency: {key: string; requestDigest: string} | null): Promise<void>;

    readEvents(roomId: string, after: number, limit: number): Promise<EventPage>;
    eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null>;
    idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null>;

    putInvite(invite: InviteRecord): Promise<void>;
    inviteByDigest(digest: string): Promise<InviteRecord | null>;

    /**
     * Atomically binds an unused invite to one redemption attempt. A competing
     * attempt must fail here rather than racing into membership creation.
     * Returns the bound invite, or null when another attempt already holds it.
     */
    reserveInvite(digest: string, attemptId: string, credentialHash: string): Promise<InviteRecord | null>;

    /** Marks a reserved invite consumed and records which participant it produced. */
    completeInvite(digest: string, participantId: string): Promise<void>;

    participantByCredential(roomId: string, credentialHash: string): Promise<ParticipantRecord | null>;
    handovers(roomId: string): Promise<HandoverRecord[]>;

    setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle']): Promise<void>;
    deleteRoom(roomId: string): Promise<void>;
}

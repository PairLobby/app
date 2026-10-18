//! The storage contract. It expresses atomic application operations rather than
//! imitating a database API, so a Durable Object's SQL transaction and a Node
//! server's SQLite transaction implement the same small surface.

import type {FileRecord, HandoverRecord, MessageRequest, RequestPage, InviteRecord, ParticipantRecord, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';

type IdempotencyKey = {key: string; requestDigest: string} | null;

export interface IdempotencyRecord {
    requestDigest: string;
    seq: number;
}

export interface EventPage {
    events: RoomEvent[];
    hasMore: boolean;
}

/**
 * Where a relay keeps attached files. Optional: a store without one makes a relay
 * that refuses attachments and says so in its snapshot.
 */
export interface FileStore {
    /**
     * Stores a new upload, record and bytes together. Returns false, storing nothing,
     * when the room would then hold more than `limitBytes` across all its files.
     */
    putFile(file: FileRecord, bytes: Uint8Array, limitBytes: number): Promise<boolean>;
    file(roomId: string, fileId: string): Promise<FileRecord | null>;
    fileBytes(roomId: string, fileId: string): Promise<Uint8Array | null>;
    /** Files a message carries, oldest first. Uploads nobody sent are not listed. */
    attachedFiles(roomId: string): Promise<FileRecord[]>;
    /** Removes uploads older than `before` that no message carried. */
    deleteUnattachedFiles(roomId: string, before: number): Promise<void>;
    /** Bytes the room's files take, sent or still pending: what `putFile` checks against its limit. */
    usedBytes(roomId: string): Promise<number>;
}

export interface RoomStore {
    /** Present when this store keeps files. `apply` then also honours `Mutation.attachFiles`, and `deleteRoom` removes the room's files. */
    files?: FileStore | undefined;

    /** Creates the room, its first participant, and the joined event in one transaction. */
    createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void>;

    loadRoom(roomId: string): Promise<RoomView | null>;

    /**
     * Applies every part of a mutation together with its idempotency record.
     * A partial application is a correctness bug, not a degraded mode.
     */
    apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void>;

    readEvents(roomId: string, after: number, limit: number): Promise<EventPage>;
    eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null>;
    eventById(roomId: string, eventId: string): Promise<RoomEvent | null>;
    idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null>;

    putInvite(invite: InviteRecord): Promise<void>;
    inviteByDigest(digest: string): Promise<InviteRecord | null>;

    /**
     * Atomically binds an invite to one redemption attempt. A competing attempt
     * must fail here rather than racing into membership creation.
     *
     * `expectedOccupantId` is the participant the caller believes currently holds
     * the seat, or null when it believes the code is unused. The reservation only
     * applies if that is still true, so several callers who each saw the same
     * departed occupant cannot all claim the seat.
     *
     * Returns the bound invite, or null when another attempt already holds it.
     */
    reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null): Promise<InviteRecord | null>;

    /** Marks a reserved invite consumed and records which participant it produced. */
    completeInvite(digest: string, participantId: string): Promise<void>;

    participantByCredential(roomId: string, credentialHash: string): Promise<ParticipantRecord | null>;
    handovers(roomId: string): Promise<HandoverRecord[]>;
    messageRequest(roomId: string, eventId: string): Promise<MessageRequest | null>;
    groupRequests(roomId: string, conversationId: string): Promise<MessageRequest[]>;
    /** Renew a lease without appending a transcript event; compare revision atomically. */
    updateTurns(room: RoomRecord, requests: MessageRequest[], expectedRevision: number): Promise<void>;
    messageRequests(roomId: string, after: number, limit: number, recipientId?: string): Promise<RequestPage>;

    setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle']): Promise<void>;
    deleteRoom(roomId: string): Promise<void>;

    /** Open rooms whose stored auto-close deadline is at or before `now`, earliest first; an index, not a transcript scan. */
    dueAutoCloses(now: number, limit: number): Promise<string[]>;
    /** The earliest stored auto-close deadline among open rooms, or null. */
    nextAutoCloseAt(): Promise<number | null>;
}

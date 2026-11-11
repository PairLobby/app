//! The storage contract. It expresses atomic application operations rather than
//! imitating a database API, so a Durable Object's SQL transaction and a Node
//! server's SQLite transaction implement the same small surface.

import type {DefaultVisibility, FileRecord, HandoverRecord, ListingRecord, MessageRequest, RequestPage, InviteRecord, ParticipantRecord, RoomEvent, RoomRecord} from '@pairlobby/protocol';
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

export type RoomHead = {room: RoomRecord; earliestSeq: number};
export type RoomLoadOptions = {handovers?: boolean};

/**
 * Where a relay keeps attached files. Optional: a store without one makes a relay
 * that refuses attachments and says so in its snapshot.
 */
export interface FileStore {
    /**
     * Stores a new upload, record and bytes together. Returns false, storing nothing,
     * when the room would then hold more than `limitBytes` across all its files.
     */
    putFile(file: FileRecord, bytes: Uint8Array, limitBytes: number, expectedStateRevision?: number): Promise<boolean>;
    /** Reserve quota before streaming. Staged bytes are invisible until completeUpload commits their verified metadata. */
    createUpload?(file: FileRecord, limitBytes: number, expectedStateRevision: number): Promise<boolean>;
    writeChunk?(roomId: string, fileId: string, index: number, bytes: Uint8Array): Promise<void>;
    completeUpload?(file: FileRecord, expectedStateRevision: number): Promise<void>;
    cancelUpload?(roomId: string, fileId: string): Promise<void>;
    fileStream?(roomId: string, fileId: string): Promise<ReadableStream<Uint8Array> | null>;
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

    /** A consistent state view; omit handover documents when the operation only needs authorization and membership. */
    loadRoom(roomId: string, options?: RoomLoadOptions): Promise<RoomView | null>;
    roomHead(roomId: string): Promise<RoomHead | null>;

    /**
     * Applies every part of a mutation together with its idempotency record. The proposed room's
     * stateRevision is the revision read by the decision: compare it atomically, then increment it.
     * Conflict means nothing committed. A partial application is a correctness bug, not a degraded mode.
     */
    apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void>;

    /** Both count and encoded-byte bounded; through binds replay to a captured transcript head. */
    readEvents(roomId: string, after: number, limit: number, through?: number): Promise<EventPage>;
    eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null>;
    eventById(roomId: string, eventId: string): Promise<RoomEvent | null>;
    idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null>;

    putInvite(invite: InviteRecord, expectedStateRevision?: number): Promise<void>;
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
    reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null, expectedStateRevision?: number): Promise<InviteRecord | null>;

    /** Marks a reserved invite consumed and records which participant it produced. */
    completeInvite(digest: string, participantId: string, attemptId?: string): Promise<void>;

    participantByCredential(roomId: string, credentialHash: string): Promise<ParticipantRecord | null>;
    handovers(roomId: string): Promise<HandoverRecord[]>;
    messageRequest(roomId: string, eventId: string): Promise<MessageRequest | null>;
    groupRequests(roomId: string, conversationId: string): Promise<MessageRequest[]>;
    /**
     * Writes the room and requests without appending a transcript event, comparing both state and turn
     * revisions atomically. Watermark advances also persist their first-received timestamp ranges;
     * every request read must project Received from those ranges, even for completed replies.
     */
    updateTurns(room: RoomRecord, requests: MessageRequest[], expectedRevision: number): Promise<void>;
    messageRequests(roomId: string, after: number, limit: number, recipientId?: string): Promise<RequestPage>;
    pendingRequestCount(roomId: string): Promise<number>;
    /**
     * Requests addressed to `recipientId` that nobody has marked received yet, answered or not, in
     * `seq` order after `after`. Optional: without it a watermark marks only the requests still awaiting a reply.
     */
    readonly unreceivedRequests?: ((roomId: string, recipientId: string, after: number, limit: number) => Promise<RequestPage>) | undefined;

    setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle'], expectedStateRevision?: number): Promise<void>;
    deleteRoom(roomId: string): Promise<void>;

    /** Open rooms whose stored auto-close deadline is at or before `now`, earliest first; an index, not a transcript scan. */
    dueAutoCloses(now: number, limit: number): Promise<string[]>;
    /** The earliest stored auto-close deadline among open rooms, or null. */
    nextAutoCloseAt(now?: number): Promise<number | null>;
}

/**
 * Where a relay keeps its agent directory: the agents members shared, by listing. Optional:
 * a relay without one does not offer the directory and says so in `GET /v1/server`.
 */
export interface DirectoryStore {
    /** Saves a listing. There is one per room and participant, so sharing the same agent again replaces it. */
    putListing(listing: ListingRecord): Promise<void>;
    listing(listingId: string): Promise<ListingRecord | null>;
    listingFor(roomId: string, participantId: string): Promise<ListingRecord | null>;
    deleteListing(listingId: string): Promise<void>;
    /** Listings in `listingId` order after `after`, for the sweep. */
    listings(after: string, limit: number): Promise<ListingRecord[]>;
    /** One member's listings, for the directory read that names them. */
    ownerListings(owner: string, after?: string, limit?: number): Promise<ListingRecord[]>;
    /** When this participant last sent a message in the room, or null; an index, not a transcript scan. */
    lastMessageAt(roomId: string, participantId: string): Promise<number | null>;
    /** A member's default visibility for their rooms, or null before they set one, which means everyone. */
    memberDefault(handle: string): Promise<DefaultVisibility | null>;
    setMemberDefault(handle: string, visibility: DefaultVisibility): Promise<void>;
}

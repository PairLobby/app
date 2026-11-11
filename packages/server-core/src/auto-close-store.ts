//! Keeps every room's auto-close deadline current and enforces it, for every
//! adapter at once. Each mutation recomputes the deadline inside the same atomic
//! write; each load first closes a room that is already past it, so no request,
//! timer or restart can act on a room after its deadline.

import {ProtocolError, newId} from '@pairlobby/protocol';
import type {HandoverRecord, InviteRecord, MessageRequest, ParticipantRecord, RequestPage, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import {autoCloseDue, autoCloseRoom, refreshAutoClose} from '@pairlobby/room-core';
import type {Mutation, RoomView} from '@pairlobby/room-core';

import type {EventPage, FileStore, IdempotencyRecord, RoomHead, RoomLoadOptions, RoomStore} from './store.js';

type Clock = () => number;

type IdempotencyKey = Parameters<RoomStore['apply']>[1];

/** How many times a load retries closing when another write raced it. */
const CLOSE_ATTEMPTS = 3;

function membersAfter(current: ParticipantRecord[], upserts: ParticipantRecord[]): ParticipantRecord[] {
    const merged = new Map(current.map((participant) => [participant.participantId, participant]));
    for (const participant of upserts) merged.set(participant.participantId, participant);
    return [...merged.values()];
}

export class AutoCloseStore implements RoomStore {
    constructor(private readonly store: RoomStore, private readonly now: Clock) {}

    get files(): FileStore | undefined {
        return this.store.files;
    }

    get unreceivedRequests(): RoomStore['unreceivedRequests'] {
        return this.store.unreceivedRequests?.bind(this.store);
    }

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        await this.store.createRoom(refreshAutoClose(room, [participant], event, this.now()), participant, event);
    }

    async roomHead(roomId: string): Promise<RoomHead | null> {
        const head = await this.store.roomHead(roomId);
        if (head && autoCloseDue({...head, participants: [], handovers: [], controls: []}, this.now())) {
            const closed = await this.loadRoom(roomId, {handovers: false});
            return closed ? {room: closed.room, earliestSeq: closed.earliestSeq} : null;
        }
        return head;
    }

    async loadRoom(roomId: string, options?: RoomLoadOptions): Promise<RoomView | null> {
        let view = await this.store.loadRoom(roomId, options);
        for (let attempt = 0; view && attempt < CLOSE_ATTEMPTS; attempt++) {
            const reason = autoCloseDue(view, this.now());
            if (!reason) {
                return view;
            }
            try {
                await this.store.apply(autoCloseRoom(view, reason, {now: this.now(), newEventId: () => newId('event')}), null);
            } catch (error) {
                // Another write won the race; reload and decide again from what it left.
                if (!(error instanceof ProtocolError) || !['turn_conflict', 'server_unavailable'].includes(error.code)) {
                    throw error;
                }
            }
            view = await this.store.loadRoom(roomId, options);
        }
        if (view && autoCloseDue(view, this.now())) {
            throw new ProtocolError('server_unavailable', 'the room deadline could not be enforced; retry');
        }
        return view;
    }

    async apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void> {
        const needsMembers = mutation.upsertParticipants.length > 0 || mutation.room.activeAgentsAndGuests === undefined;
        const current = needsMembers ? await this.store.loadRoom(mutation.room.roomId, {handovers: false}) : null;
        const members = needsMembers ? membersAfter(current?.participants ?? [], mutation.upsertParticipants) : undefined;
        await this.store.apply({...mutation, room: refreshAutoClose(mutation.room, members, mutation.appendEvent, this.now())}, idempotency);
    }

    async updateTurns(room: RoomRecord, requests: MessageRequest[], expectedRevision: number): Promise<void> {
        // The complete state revision fences stale deadlines as well as stale turns.
        await this.store.updateTurns(room, requests, expectedRevision);
    }

    readEvents(roomId: string, after: number, limit: number, through?: number): Promise<EventPage> {
        return this.store.readEvents(roomId, after, limit, through);
    }

    eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null> {
        return this.store.eventBySeq(roomId, seq);
    }

    eventById(roomId: string, eventId: string): Promise<RoomEvent | null> {
        return this.store.eventById(roomId, eventId);
    }

    idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null> {
        return this.store.idempotencyRecord(roomId, key);
    }

    putInvite(invite: InviteRecord, expectedStateRevision?: number): Promise<void> {
        return this.store.putInvite(invite, expectedStateRevision);
    }

    inviteByDigest(digest: string): Promise<InviteRecord | null> {
        return this.store.inviteByDigest(digest);
    }

    reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null, expectedStateRevision?: number): Promise<InviteRecord | null> {
        return this.store.reserveInvite(digest, attemptId, credentialHash, expectedOccupantId, expectedStateRevision);
    }

    completeInvite(digest: string, participantId: string, attemptId?: string): Promise<void> {
        return this.store.completeInvite(digest, participantId, attemptId);
    }

    participantByCredential(roomId: string, credentialHash: string): Promise<ParticipantRecord | null> {
        return this.store.participantByCredential(roomId, credentialHash);
    }

    handovers(roomId: string): Promise<HandoverRecord[]> {
        return this.store.handovers(roomId);
    }

    messageRequest(roomId: string, eventId: string): Promise<MessageRequest | null> {
        return this.store.messageRequest(roomId, eventId);
    }

    groupRequests(roomId: string, conversationId: string): Promise<MessageRequest[]> {
        return this.store.groupRequests(roomId, conversationId);
    }

    messageRequests(roomId: string, after: number, limit: number, recipientId?: string): Promise<RequestPage> {
        return this.store.messageRequests(roomId, after, limit, recipientId);
    }

    pendingRequestCount(roomId: string): Promise<number> {
        return this.store.pendingRequestCount(roomId);
    }

    setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle'], expectedStateRevision?: number): Promise<void> {
        return this.store.setLifecycle(roomId, lifecycle, expectedStateRevision);
    }

    deleteRoom(roomId: string): Promise<void> {
        return this.store.deleteRoom(roomId);
    }

    dueAutoCloses(now: number, limit: number): Promise<string[]> {
        return this.store.dueAutoCloses(now, limit);
    }

    nextAutoCloseAt(now?: number): Promise<number | null> {
        return this.store.nextAutoCloseAt(now);
    }
}

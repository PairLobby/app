//! Keeps every room's auto-close deadline current and enforces it, for every
//! adapter at once. Each mutation recomputes the deadline inside the same atomic
//! write; each load first closes a room that is already past it, so no request,
//! timer or restart can act on a room after its deadline.

import {ProtocolError, newId} from '@pairlobby/protocol';
import type {HandoverRecord, InviteRecord, MessageRequest, ParticipantRecord, RequestPage, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import {autoCloseDue, autoCloseRoom, refreshAutoClose} from '@pairlobby/room-core';
import type {Mutation, RoomView} from '@pairlobby/room-core';

import type {EventPage, IdempotencyRecord, RoomStore} from './store.js';

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

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        await this.store.createRoom(refreshAutoClose(room, [participant], event, this.now()), participant, event);
    }

    async loadRoom(roomId: string): Promise<RoomView | null> {
        let view = await this.store.loadRoom(roomId);
        for (let attempt = 0; view && attempt < CLOSE_ATTEMPTS; attempt++) {
            const reason = autoCloseDue(view, this.now());
            if (!reason) {
                return view;
            }
            try {
                await this.store.apply(autoCloseRoom(view, reason, {now: this.now(), newEventId: () => newId('event')}), null);
            } catch (error) {
                // Another write won the race; reload and decide again from what it left.
                if (!(error instanceof ProtocolError)) {
                    throw error;
                }
            }
            view = await this.store.loadRoom(roomId);
        }
        return view;
    }

    async apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void> {
        const current = await this.store.loadRoom(mutation.room.roomId);
        const members = membersAfter(current?.participants ?? [], mutation.upsertParticipants);
        await this.store.apply({...mutation, room: refreshAutoClose(mutation.room, members, mutation.appendEvent, this.now())}, idempotency);
    }

    async updateTurns(room: RoomRecord, requests: MessageRequest[], expectedRevision: number): Promise<void> {
        // A lease renewal writes the room without an event; keep the deadline the latest write computed.
        const current = (await this.store.loadRoom(room.roomId))?.room;
        const kept = current ? {lastMessageAt: current.lastMessageAt ?? null, autoCloseArmed: current.autoCloseArmed ?? false, autoCloseAt: current.autoCloseAt ?? null} : {};
        await this.store.updateTurns({...room, ...kept}, requests, expectedRevision);
    }

    readEvents(roomId: string, after: number, limit: number): Promise<EventPage> {
        return this.store.readEvents(roomId, after, limit);
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

    putInvite(invite: InviteRecord): Promise<void> {
        return this.store.putInvite(invite);
    }

    inviteByDigest(digest: string): Promise<InviteRecord | null> {
        return this.store.inviteByDigest(digest);
    }

    reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null): Promise<InviteRecord | null> {
        return this.store.reserveInvite(digest, attemptId, credentialHash, expectedOccupantId);
    }

    completeInvite(digest: string, participantId: string): Promise<void> {
        return this.store.completeInvite(digest, participantId);
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

    setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle']): Promise<void> {
        return this.store.setLifecycle(roomId, lifecycle);
    }

    deleteRoom(roomId: string): Promise<void> {
        return this.store.deleteRoom(roomId);
    }

    dueAutoCloses(now: number, limit: number): Promise<string[]> {
        return this.store.dueAutoCloses(now, limit);
    }

    nextAutoCloseAt(): Promise<number | null> {
        return this.store.nextAutoCloseAt();
    }
}

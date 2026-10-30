//! Long-poll support for a relay that runs in one process: readers wait on a room,
//! and every write to the store wakes them. A relay with several copies needs a
//! notifier they all share, which is why this lives behind the store and not in it.

import type {HandoverRecord, InviteRecord, MessageRequest, ParticipantRecord, RequestPage, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';

import type {EventPage, FileStore, IdempotencyRecord, RoomStore} from './store.js';

type IdempotencyKey = Parameters<RoomStore['apply']>[1];

/** A registered wait: `changed` settles true on a change, false at the deadline or on `cancel`. */
export type ChangeWait = {changed: Promise<boolean>; cancel: () => void};

export type ChangeNotifierOptions = {
    /** Waits held at once across the relay; past it, reads answer at once, as if polling. */
    maxWaiters?: number;
};

export class ChangeNotifier {
    private readonly waiters = new Map<string, Set<(changed: boolean) => void>>();
    private readonly maxWaiters: number;
    private held = 0;
    private closed = false;

    constructor({maxWaiters = 1000}: ChangeNotifierOptions = {}) {
        this.maxWaiters = maxWaiters;
    }

    /** Waiting readers, for tests and metrics. */
    get waiting(): number {
        return this.held;
    }

    /**
     * Starts waiting for a change to `roomId` for at most `ms`. Register before reading, so a
     * write between the read and the wait still wakes it. Null when the relay already holds
     * as many waits as it allows, or is shutting down.
     */
    wait(roomId: string, ms: number): ChangeWait | null {
        if (this.closed || this.held >= this.maxWaiters) {
            return null;
        }
        let settle: (changed: boolean) => void = () => {};
        const changed = new Promise<boolean>((resolve) => {
            let done = false;
            const timer = setTimeout(() => settle(false), ms);
            settle = (value) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                this.held--;
                const room = this.waiters.get(roomId);
                room?.delete(settle);
                if (room?.size === 0) {
                    this.waiters.delete(roomId);
                }
                resolve(value);
            };
        });
        this.held++;
        const room = this.waiters.get(roomId) ?? new Set();
        room.add(settle);
        this.waiters.set(roomId, room);
        return {changed, cancel: () => settle(false)};
    }

    changed(roomId: string): void {
        for (const settle of [...(this.waiters.get(roomId) ?? [])]) {
            settle(true);
        }
    }

    /** Releases every wait, as unchanged, and refuses new ones: for shutting down. */
    close(): void {
        this.closed = true;
        for (const room of [...this.waiters.values()]) {
            for (const settle of [...room]) {
                settle(false);
            }
        }
    }
}

/** A store that tells `notifier` about every write to a room, after the write succeeds. */
export class NotifyingStore implements RoomStore {
    constructor(private readonly store: RoomStore, private readonly notifier: ChangeNotifier) {}

    get files(): FileStore | undefined {
        return this.store.files;
    }

    get unreceivedRequests(): RoomStore['unreceivedRequests'] {
        return this.store.unreceivedRequests?.bind(this.store);
    }

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        await this.store.createRoom(room, participant, event);
        this.notifier.changed(room.roomId);
    }

    loadRoom(roomId: string): Promise<RoomView | null> {
        return this.store.loadRoom(roomId);
    }

    async apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void> {
        await this.store.apply(mutation, idempotency);
        this.notifier.changed(mutation.room.roomId);
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

    async updateTurns(room: RoomRecord, requests: MessageRequest[], expectedRevision: number): Promise<void> {
        await this.store.updateTurns(room, requests, expectedRevision);
        this.notifier.changed(room.roomId);
    }

    messageRequests(roomId: string, after: number, limit: number, recipientId?: string): Promise<RequestPage> {
        return this.store.messageRequests(roomId, after, limit, recipientId);
    }

    async setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle']): Promise<void> {
        await this.store.setLifecycle(roomId, lifecycle);
        this.notifier.changed(roomId);
    }

    async deleteRoom(roomId: string): Promise<void> {
        await this.store.deleteRoom(roomId);
        this.notifier.changed(roomId);
    }

    dueAutoCloses(now: number, limit: number): Promise<string[]> {
        return this.store.dueAutoCloses(now, limit);
    }

    nextAutoCloseAt(): Promise<number | null> {
        return this.store.nextAutoCloseAt();
    }
}

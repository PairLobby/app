//! Long-poll support for a relay that runs in one process: readers wait on a room,
//! and every write to the store wakes them. A relay with several copies needs a
//! notifier they all share, which is why this lives behind the store and not in it.

import type {HandoverRecord, InviteRecord, MessageRequest, ParticipantRecord, RequestPage, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';

import type {EventPage, FileStore, IdempotencyRecord, RoomHead, RoomLoadOptions, RoomStore} from './store.js';

type IdempotencyKey = Parameters<RoomStore['apply']>[1];

/** A registered wait: `changed` settles true on a change, false at the deadline or on `cancel`. */
export type ChangeWait = {changed: Promise<boolean>; cancel: () => void};
export type CommittedChange = {roomId: string; stateRevision: number; event?: RoomEvent};

/** A platform may await broker subscription before the first read. Publications happen only after a successful commit. */
export interface RoomChangeNotifier {
    wait(roomId: string, ms: number, signal?: AbortSignal): ChangeWait | null | Promise<ChangeWait | null>;
    changed(roomId: string): void | Promise<void>;
}

export type ChangeNotifierOptions = {
    /** Waits held at once across the relay; past it, reads answer at once, as if polling. */
    maxWaiters?: number;
};

export class ChangeNotifier implements RoomChangeNotifier {
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
    wait(roomId: string, ms: number, signal?: AbortSignal): ChangeWait | null {
        if (this.closed || this.held >= this.maxWaiters || signal?.aborted) {
            return null;
        }
        let settle: (changed: boolean) => void = () => {};
        const abort = () => settle(false);
        const changed = new Promise<boolean>((resolve) => {
            let done = false;
            const timer = setTimeout(() => settle(false), ms);
            settle = (value) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
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
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) {
            abort();
        }
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
    private readonly fileWrappers = new WeakMap<FileStore, FileStore>();
    constructor(private readonly store: RoomStore, private readonly notifier: RoomChangeNotifier) {}

    private async publish(roomId: string): Promise<void> {
        try {
            await this.notifier.changed(roomId);
        } catch {
            // The state already committed. A timed read or reconnect recovers a missed hint.
            console.error('pairlobby change notification failed');
        }
    }

    get files(): FileStore | undefined {
        const files = this.store.files;
        if (!files) {
            return undefined;
        }
        let wrapped = this.fileWrappers.get(files);
        if (!wrapped) {
            const publish = (roomId: string) => this.publish(roomId);
            wrapped = new Proxy(files, {
                get(target, property) {
                    const value: unknown = Reflect.get(target, property);
                    if (typeof value !== 'function') {
                        return value;
                    }
                    if (!['putFile', 'createUpload', 'completeUpload', 'cancelUpload', 'deleteUnattachedFiles'].includes(String(property))) {
                        return value.bind(target);
                    }
                    return async (...args: unknown[]) => {
                        const result: unknown = await Reflect.apply(value, target, args);
                        if (result !== false) {
                            const first = args[0] as string | {roomId: string};
                            await publish(typeof first === 'string' ? first : first.roomId);
                        }
                        return result;
                    };
                }
            });
            this.fileWrappers.set(files, wrapped);
        }
        return wrapped;
    }

    get unreceivedRequests(): RoomStore['unreceivedRequests'] {
        return this.store.unreceivedRequests?.bind(this.store);
    }

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        await this.store.createRoom(room, participant, event);
        await this.publish(room.roomId);
    }

    loadRoom(roomId: string, options?: RoomLoadOptions): Promise<RoomView | null> {
        return this.store.loadRoom(roomId, options);
    }

    roomHead(roomId: string): Promise<RoomHead | null> {
        return this.store.roomHead(roomId);
    }

    async apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void> {
        await this.store.apply(mutation, idempotency);
        await this.publish(mutation.room.roomId);
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

    async putInvite(invite: InviteRecord, expectedStateRevision?: number): Promise<void> {
        await this.store.putInvite(invite, expectedStateRevision);
        await this.publish(invite.roomId);
    }

    inviteByDigest(digest: string): Promise<InviteRecord | null> {
        return this.store.inviteByDigest(digest);
    }

    async reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null, expectedStateRevision?: number): Promise<InviteRecord | null> {
        const invite = await this.store.reserveInvite(digest, attemptId, credentialHash, expectedOccupantId, expectedStateRevision);
        if (invite) {
            await this.publish(invite.roomId);
        }
        return invite;
    }

    async completeInvite(digest: string, participantId: string, attemptId?: string): Promise<void> {
        await this.store.completeInvite(digest, participantId, attemptId);
        const invite = await this.store.inviteByDigest(digest);
        if (invite) {
            await this.publish(invite.roomId);
        }
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
        await this.publish(room.roomId);
    }

    messageRequests(roomId: string, after: number, limit: number, recipientId?: string): Promise<RequestPage> {
        return this.store.messageRequests(roomId, after, limit, recipientId);
    }

    pendingRequestCount(roomId: string): Promise<number> {
        return this.store.pendingRequestCount(roomId);
    }

    async setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle'], expectedStateRevision?: number): Promise<void> {
        await this.store.setLifecycle(roomId, lifecycle, expectedStateRevision);
        await this.publish(roomId);
    }

    async deleteRoom(roomId: string): Promise<void> {
        await this.store.deleteRoom(roomId);
        await this.publish(roomId);
    }

    dueAutoCloses(now: number, limit: number): Promise<string[]> {
        return this.store.dueAutoCloses(now, limit);
    }

    nextAutoCloseAt(now?: number): Promise<number | null> {
        return this.store.nextAutoCloseAt(now);
    }
}

//! Wraps any store so a test can crash it at a chosen step. Works against every
//! adapter, so crash recovery is proved where it actually runs rather than only
//! against an in-memory double.

import type {TestableRoomStore} from './harness.js';

export interface Faults {
    /** Throw on the next `apply`, before anything is written. */
    failNextApply?: boolean;
    /** Throw on the next `completeInvite`, after membership already exists. */
    failNextCompleteInvite?: boolean;
}

export class FaultyStore implements TestableRoomStore {
    readonly faults: Faults = {};
    private readonly inner: TestableRoomStore;

    constructor(inner: TestableRoomStore) {
        this.inner = inner;
        for (const key of [
            'createRoom',
            'loadRoom',
            'readEvents',
            'eventBySeq',
            'eventById',
            'idempotencyRecord',
            'putInvite',
            'inviteByDigest',
            'reserveInvite',
            'participantByCredential',
            'handovers',
            'messageRequest',
            'messageRequests',
            'setLifecycle',
            'deleteRoom'
        ] as const) {
            (this as Record<string, unknown>)[key] = (...args: unknown[]) => (this.inner[key] as (...rest: unknown[]) => unknown)(...args);
        }
    }

    async apply(...args: Parameters<TestableRoomStore['apply']>): ReturnType<TestableRoomStore['apply']> {
        if (this.faults.failNextApply) {
            this.faults.failNextApply = false;
            throw new Error('injected store failure');
        }
        return this.inner.apply(...args);
    }

    async completeInvite(...args: Parameters<TestableRoomStore['completeInvite']>): ReturnType<TestableRoomStore['completeInvite']> {
        if (this.faults.failNextCompleteInvite) {
            this.faults.failNextCompleteInvite = false;
            throw new Error('injected crash before the invite was marked consumed');
        }
        return this.inner.completeInvite(...args);
    }

    dropHistoryBefore(roomId: string, seq: number): void {
        this.inner.dropHistoryBefore(roomId, seq);
    }

    close(): void {
        this.inner.close?.();
    }
}

export interface FaultyStore extends TestableRoomStore {}

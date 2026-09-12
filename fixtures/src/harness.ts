//! A single-room facade over `RoomService`, parameterized by store so one
//! contract suite can be run against every adapter.

import {newCredential} from '@pairlobby/protocol';
import type {ParticipantRole, RoomEvent, RoomPolicy, RoomSnapshot, SendEventRequest} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {Identity, RoomStore} from '@pairlobby/server-core';

export interface Clock {
    now(): number;
    advance(ms: number): void;
}

export function fixedClock(start = 1_700_000_000_000): Clock {
    let current = start;
    return {now: () => current, advance: (ms) => {current += ms;}};
}

/** A store that can also simulate retention dropping the front of the log. */
export interface TestableRoomStore extends RoomStore {
    dropHistoryBefore(roomId: string, seq: number): void;
    close?(): void;
}

export interface CreatedRoom {
    roomId: string;
    participantId: string;
    controllerCredential: string;
    participantCredential: string;
    inviteCode: string;
}

export class RoomHarness {
    readonly clock: Clock;
    readonly store: TestableRoomStore;
    private readonly service: RoomService;
    private roomId = '';
    private controllerCredential = '';

    constructor(store: TestableRoomStore, clock: Clock = fixedClock()) {
        this.store = store;
        this.clock = clock;
        this.service = new RoomService(store, () => this.clock.now());
    }

    async createRoom(name: string, identity: Identity, policy?: RoomPolicy): Promise<CreatedRoom> {
        const controllerCredential = newCredential('controller');
        const participantCredential = newCredential('participant');
        const created = await this.service.createRoom({name, controllerCredential, participantCredential, ...identity, ...(policy ? {policy} : {})});
        this.roomId = created.roomId;
        this.controllerCredential = controllerCredential;
        return {roomId: created.roomId, participantId: created.participantId, controllerCredential, participantCredential, inviteCode: created.invite.code};
    }

    async mintInvite(role: ParticipantRole): Promise<string> {
        return (await this.service.mintInvite(this.roomId, this.controllerCredential, role)).code;
    }

    async redeemInvite(code: string, identity: Identity, attemptId: string, participantCredential: string): Promise<{participantId: string; roomId: string; replayed: boolean}> {
        const result = await this.service.redeemInvite({code, attemptId, participantCredential, ...identity});
        return {participantId: result.participantId, roomId: result.roomId, replayed: result.replayed};
    }

    async send(credential: string, request: SendEventRequest): Promise<{event: RoomEvent; deduplicated: boolean}> {
        return this.service.send(this.roomId, credential, request);
    }

    async control(credential: string, targetParticipantId: string, paused: boolean): Promise<RoomEvent> {
        return this.service.control(this.roomId, credential, targetParticipantId, paused);
    }

    async revoke(credential: string, targetParticipantId: string): Promise<RoomEvent> {
        return this.service.revoke(this.roomId, credential, targetParticipantId);
    }

    async leave(credential: string): Promise<RoomEvent> {
        return this.service.leave(this.roomId, credential);
    }

    async rename(credential: string, name: string): Promise<RoomEvent> {
        return this.service.rename(this.roomId, credential, name);
    }

    async close(credential: string): Promise<RoomEvent> {
        return this.service.close(this.roomId, credential);
    }

    async read(credential: string, after: number, limit = 200) {
        return this.service.read(this.roomId, credential, after, limit);
    }

    async snapshot(credential: string): Promise<RoomSnapshot> {
        return this.service.snapshot(this.roomId, credential);
    }

    async export(credential: string) {
        return this.service.export(this.roomId, credential);
    }

    dropHistoryBefore(seq: number): void {
        this.store.dropHistoryBefore(this.roomId, seq);
    }

    dispose(): void {
        this.store.close?.();
    }
}

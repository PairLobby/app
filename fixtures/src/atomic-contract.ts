import {newCredential, newId} from '@pairlobby/protocol';
import {appendEvent, emptyMutation} from '@pairlobby/room-core';
import {RoomService} from '@pairlobby/server-core';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import type {StoreFactory} from './contract.js';
import type {TestableRoomStore} from './harness.js';

type Member = {id: string; credential: string};

/** Every adapter must fence eventless changes as well as transcript appends. */
export function runAtomicContract(label: string, makeStore: StoreFactory): void {
    describe(`${label} / atomic room revisions`, () => {
        let store: TestableRoomStore;
        let service: RoomService;
        let roomId: string;
        let owner: string;
        let controller: string;
        let first: Member;
        let second: Member;

        beforeEach(async () => {
            store = makeStore();
            service = new RoomService(store, undefined, undefined, undefined, {receiptMode: 'watermark'});
            owner = newCredential('participant');
            controller = newCredential('controller');
            roomId = (await service.createRoom({name: 'atomic', displayName: 'owner', kind: 'human', participantCredential: owner, controllerCredential: controller})).roomId;
            const join = async (name: string): Promise<Member> => {
                const invite = await service.mintInvite(roomId, controller, 'member');
                const credential = newCredential('participant');
                const joined = await service.redeemInvite({code: invite.code, attemptId: newId('attempt'), participantCredential: credential, displayName: name, kind: 'agent'});
                return {id: joined.participantId, credential};
            };
            first = await join('first');
            second = await join('second');
        });

        afterEach(() => store.close?.());

        test('concurrent receipt advances preserve both participants and distinct revisions', async () => {
            const other = new RoomService(store, undefined, undefined, undefined, {receiptMode: 'watermark'});
            const seq = (await service.snapshot(roomId, owner)).latestSeq;
            const results = await Promise.allSettled([
                service.receipt(roomId, first.credential, seq),
                other.receipt(roomId, second.credential, seq)
            ]);
            expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
            const page = await service.read(roomId, owner, seq, 10, 0);
            expect(page.receipts?.map((mark) => mark.participantId).sort()).toEqual([first.id, second.id].sort());
            expect(new Set(page.receipts?.map((mark) => mark.revision)).size).toBe(2);
        });

        test('an event append computed before a receipt cannot overwrite that receipt', async () => {
            const view = (await store.loadRoom(roomId))!;
            await service.receipt(roomId, first.credential, view.room.nextSeq - 1);
            const {room, event} = appendEvent(view.room, {senderId: null, idempotencyKey: null, recipientId: null, replyTo: null, body: {type: 'room.renamed', payload: {name: 'stale', previousName: view.room.name}}}, {now: Date.now(), newEventId: () => newId('event')});
            await expect(store.apply(emptyMutation(room, event), null)).rejects.toBeDefined();
            expect((await service.read(roomId, owner, 0, 10, 0)).receipts).toHaveLength(1);
        });

        test('an eventless update computed before a receipt cannot overwrite that receipt', async () => {
            const view = (await store.loadRoom(roomId))!;
            await service.receipt(roomId, first.credential, view.room.nextSeq - 1);
            await expect(store.updateTurns(view.room, [], view.room.turnRevision ?? 0)).rejects.toMatchObject({code: 'turn_conflict'});
        });

        test('later watermarks preserve the first receipt time and apply to completed replies', async () => {
            let now = 10_000;
            const clocked = new RoomService(store, () => now, undefined, undefined, {receiptMode: 'watermark'});
            const ask = await clocked.send(roomId, owner, {type: 'message', recipientId: first.id, payload: {text: 'question', priority: 'normal'}, idempotencyKey: newId('event')});
            await clocked.receipt(roomId, first.credential, ask.event.seq);
            now += 1000;
            const reply = await clocked.send(roomId, first.credential, {type: 'message', recipientId: ask.event.senderId!, replyTo: ask.event.eventId, payload: {text: 'answer', priority: 'normal'}, idempotencyKey: newId('event')});
            await clocked.receipt(roomId, owner, reply.event.seq);
            await clocked.receipt(roomId, first.credential, reply.event.seq);
            expect((await clocked.request(roomId, owner, ask.event.eventId)).receivedAt).toBe(10_000);
            expect((await clocked.request(roomId, owner, reply.event.eventId)).receivedAt).toBe(11_000);
            expect((await store.messageRequest(roomId, ask.event.eventId))?.receivedAt).toBe(10_000);
        });
    });
}

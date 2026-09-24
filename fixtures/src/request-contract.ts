import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {DEFAULT_ROOM_POLICY, newCredential, newId, requestState} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {StoreFactory} from './contract.js';
import type {TestableRoomStore} from './harness.js';
import {FaultyStore} from './faulty-store.js';

export function runRequestContract(label: string, makeStore: StoreFactory) {
    describe(`${label} / durable message obligations`, () => {
        let store: TestableRoomStore, service: RoomService, roomId: string, alice: string, bob: string, aliceId: string, bobId: string;
        beforeEach(async () => {
            store = makeStore();
            service = new RoomService(store);
            alice = newCredential('participant');
            bob = newCredential('participant');
            const room = await service.createRoom({
                name: 'delivery',
                displayName: 'alice',
                kind: 'agent',
                participantCredential: alice,
                controllerCredential: newCredential('controller')
            });
            roomId = room.roomId;
            aliceId = room.participantId;
            bobId = (await service.redeemInvite({code: room.invite.code, displayName: 'bob', kind: 'agent', participantCredential: bob, attemptId: newId('attempt')}))
                .participantId;
        });
        afterEach(() => store.close?.());
        const ask = (text: string) => service.send(roomId, alice, {type: 'message', recipientId: bobId, payload: {text, priority: 'normal'}, idempotencyKey: newId('event')});
        const answer = (id: string, text = 'I do not know', progress = false) =>
            service.send(roomId, bob, {
                type: 'message',
                recipientId: aliceId,
                replyTo: id,
                payload: {text, priority: 'normal', responseStage: progress ? 'progress' : 'final'},
                idempotencyKey: newId('event')
            });
        test('every request survives newer requests and unthreaded chatter', async () => {
            const first = await ask('first'),
                second = await ask('second');
            await service.send(roomId, bob, {type: 'message', recipientId: aliceId, payload: {text: 'unrelated', priority: 'normal'}, idempotencyKey: newId('event')});
            const pending = await service.requests(roomId, bob, 0, 100, bobId);
            expect(pending.requests.map((r) => r.eventId)).toEqual([first.event.eventId, second.event.eventId]);
        });
        test('senders cannot acknowledge themselves, and a final reply requires the recipients receipt', async () => {
            const {event} = await ask('work');
            await expect(service.acknowledgeMessage(roomId, alice, event.eventId)).rejects.toMatchObject({code: 'unauthorized'});
            await expect(answer(event.eventId)).rejects.toMatchObject({code: 'invalid_request'});
            await service.acknowledgeMessage(roomId, bob, event.eventId);
            await expect(
                service.send(roomId, alice, {
                    type: 'message',
                    replyTo: event.eventId,
                    recipientId: bobId,
                    payload: {text: 'forged answer', priority: 'normal'},
                    idempotencyKey: newId('event')
                })
            ).rejects.toMatchObject({code: 'unauthorized'});
            expect((await service.requests(roomId, bob)).requests).toHaveLength(1);
        });
        test('human and agent readers have separate receipts without satisfying another recipients obligation', async () => {
            const invite = await service.mintInvite(roomId, alice, 'member');
            const humanCredential = newCredential('participant');
            const human = await service.redeemInvite({code: invite.code, displayName: 'human', kind: 'human', participantCredential: humanCredential, attemptId: newId('attempt')});
            const {event} = await ask('agent to agent');
            await service.acknowledgeMessage(roomId, humanCredential, event.eventId);
            expect((await service.request(roomId, alice, event.eventId)).receivedAt).toBeNull();
            await expect(answer(event.eventId)).rejects.toMatchObject({code: 'invalid_request'});
            await service.acknowledgeMessage(roomId, bob, event.eventId);
            await service.acknowledgeMessage(roomId, humanCredential, event.eventId);
            const receipts = (await service.read(roomId, alice, 0, 100)).events.filter((entry) => entry.type === 'message.received' && entry.payload.eventId === event.eventId);
            expect(receipts.map((entry) => entry.senderId)).toEqual([human.participantId, bobId]);
            const reply = await answer(event.eventId);
            await service.acknowledgeMessage(roomId, alice, reply.event.eventId);
            expect((await service.request(roomId, bob, reply.event.eventId)).receivedAt).not.toBeNull();
            expect((await service.requests(roomId, alice)).requests).toHaveLength(0);
        });
        test('broadcast receipts are idempotent per reader and never create reply obligations', async () => {
            const {event} = await service.send(roomId, alice, {type: 'message', payload: {text: 'everyone', priority: 'normal'}, idempotencyKey: newId('event')});
            await service.acknowledgeMessage(roomId, bob, event.eventId);
            await service.send(roomId, bob, {type: 'message.received', payload: {eventId: event.eventId}, idempotencyKey: newId('event')});
            const receipts = (await service.read(roomId, alice, 0, 100)).events.filter((entry) => entry.type === 'message.received');
            expect(receipts).toHaveLength(1);
            expect((await service.requests(roomId, bob)).requests).toHaveLength(0);
            store.dropHistoryBefore(roomId, receipts[0]!.seq + 1);
            await new RoomService(store).acknowledgeMessage(roomId, bob, event.eventId);
            expect((await service.read(roomId, bob, 0, 100)).events).toHaveLength(0);
        });
        test('receipts reject system events, missing messages and guest writers', async () => {
            const joined = (await service.read(roomId, alice, 0, 100)).events[0]!;
            await expect(service.acknowledgeMessage(roomId, bob, joined.eventId)).rejects.toMatchObject({code: 'invalid_request'});
            await expect(service.acknowledgeMessage(roomId, bob, newId('event'))).rejects.toMatchObject({code: 'invalid_request'});
            const invite = await service.mintInvite(roomId, alice, 'guest');
            const guestCredential = newCredential('participant');
            await service.redeemInvite({code: invite.code, displayName: 'guest', kind: 'human', participantCredential: guestCredential, attemptId: newId('attempt')});
            const {event} = await ask('work');
            await expect(service.acknowledgeMessage(roomId, guestCredential, event.eventId)).rejects.toMatchObject({code: 'unauthorized'});
        });
        test('an unrelated event using a receipt key cannot fabricate successful acknowledgement', async () => {
            const {event} = await ask('work');
            await service.send(roomId, alice, {type: 'message', payload: {text: 'collision', priority: 'normal'}, idempotencyKey: `receipt-${event.eventId}-${bobId}`});
            await expect(service.acknowledgeMessage(roomId, bob, event.eventId)).rejects.toMatchObject({code: 'idempotency_conflict'});
            expect((await service.request(roomId, alice, event.eventId)).receivedAt).toBeNull();
        });
        test('receipt and progress do not complete a request; a refusal closes exactly one', async () => {
            const first = await ask('first'),
                second = await ask('second');
            await service.acknowledgeMessage(roomId, bob, first.event.eventId);
            await answer(first.event.eventId, 'Working on it', true);
            expect((await service.requests(roomId, bob)).requests).toHaveLength(2);
            await answer(first.event.eventId, 'I refuse this request');
            expect((await service.requests(roomId, bob)).requests.map((r) => r.eventId)).toEqual([second.event.eventId]);
            expect((await service.requests(roomId, alice, 0, 100, aliceId)).requests).toHaveLength(0);
        });
        test('unanswered requests and acknowledgements survive transcript pruning', async () => {
            const {event} = await ask('do not forget');
            await service.acknowledgeMessage(roomId, bob, event.eventId);
            store.dropHistoryBefore(roomId, event.seq + 2);
            const restarted = new RoomService(store);
            expect((await restarted.requests(roomId, bob)).requests[0]!.text).toBe('do not forget');
            await restarted.acknowledgeMessage(roomId, bob, event.eventId);
            await answer(event.eventId);
            expect((await restarted.requests(roomId, bob)).requests).toHaveLength(0);
        });
        test('a failed commit cannot acknowledge or close the obligation', async () => {
            const {event} = await ask('work');
            const faulty = new FaultyStore(store);
            const failing = new RoomService(faulty);
            faulty.faults.failNextApply = true;
            await expect(failing.acknowledgeMessage(roomId, bob, event.eventId)).rejects.toThrow();
            expect((await service.request(roomId, alice, event.eventId)).receivedAt).toBeNull();
            await service.acknowledgeMessage(roomId, bob, event.eventId);
            faulty.faults.failNextApply = true;
            await expect(
                failing.send(roomId, bob, {
                    type: 'message',
                    recipientId: aliceId,
                    replyTo: event.eventId,
                    payload: {text: 'answer', priority: 'normal'},
                    idempotencyKey: newId('event')
                })
            ).rejects.toThrow();
            expect((await service.requests(roomId, alice)).requests).toHaveLength(1);
        });
        test('ordinary work quota cannot prevent a receipt and final reply', async () => {
            const a = newCredential('participant'),
                b = newCredential('participant');
            const room = await service.createRoom({
                name: 'reserved replies',
                displayName: 'a',
                kind: 'agent',
                participantCredential: a,
                controllerCredential: newCredential('controller'),
                policy: {...DEFAULT_ROOM_POLICY, maxRetainedEvents: 3}
            });
            const member = await service.redeemInvite({code: room.invite.code, displayName: 'b', kind: 'agent', participantCredential: b, attemptId: newId('attempt')});
            const sent = await service.send(room.roomId, a, {
                type: 'message',
                recipientId: member.participantId,
                payload: {text: 'last allowed request', priority: 'normal'},
                idempotencyKey: newId('event')
            });
            await service.acknowledgeMessage(room.roomId, b, sent.event.eventId);
            await service.send(room.roomId, b, {
                type: 'message',
                recipientId: room.participantId,
                replyTo: sent.event.eventId,
                payload: {text: 'I cannot do it', priority: 'normal'},
                idempotencyKey: newId('event')
            });
            expect((await service.requests(room.roomId, a)).requests).toHaveLength(0);
        });
        test('adapter failure is visible but never forged as an agent answer', async () => {
            const {event} = await ask('work');
            await service.send(roomId, bob, {type: 'message.delivery_failed', payload: {eventId: event.eventId, reason: 'Runtime disconnected'}, idempotencyKey: newId('event')});
            const failed = await service.request(roomId, alice, event.eventId);
            expect(requestState(failed)).toBe('failed');
            expect(failed.receivedAt).toBeNull();
            expect(failed.responseEventId).toBeNull();
            expect((await service.requests(roomId, alice)).requests).toHaveLength(1);
            await service.acknowledgeMessage(roomId, bob, event.eventId);
            await answer(event.eventId);
            expect(requestState(await service.request(roomId, alice, event.eventId))).toBe('answered');
        });
    });
}

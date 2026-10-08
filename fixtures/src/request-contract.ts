import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {DEFAULT_ROOM_POLICY, messageActionLabel, newCredential, newId, requestState} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {StoreFactory} from './contract.js';
import type {TestableRoomStore} from './harness.js';
import {FaultyStore} from './faulty-store.js';

export function runRequestContract(label: string, makeStore: StoreFactory) {
    describe(`${label} / durable message obligations`, () => {
        let store: TestableRoomStore, service: RoomService, roomId: string, alice: string, bob: string, aliceId: string, bobId: string, controller: string;
        beforeEach(async () => {
            store = makeStore();
            service = new RoomService(store);
            alice = newCredential('participant');
            bob = newCredential('participant');
            controller = newCredential('controller');
            const room = await service.createRoom({
                name: 'delivery',
                displayName: 'alice',
                kind: 'agent',
                participantCredential: alice,
                controllerCredential: controller
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

        test('quoted follow-ups create new obligations and preserve the earlier final answer', async () => {
            const question = await ask('original question');
            await service.acknowledgeMessage(roomId, bob, question.event.eventId);
            const response = await answer(question.event.eventId, 'original answer');
            const request = {type: 'message' as const, recipientId: bobId, quoteOf: response.event.eventId, payload: {text: 'explain further', priority: 'normal' as const}, idempotencyKey: newId('event')};
            const followup = await service.send(roomId, alice, request);
            expect(followup.event).toMatchObject({quoteOf: response.event.eventId, replyTo: null, payload: {text: 'explain further'}});
            const obligation = await service.request(roomId, bob, followup.event.eventId);
            expect(obligation.requiresReply).toBe(true);
            expect(obligation.text).toContain('original answer');
            expect(obligation.text).toContain('explain further');
            expect((await service.request(roomId, alice, question.event.eventId)).responseEventId).toBe(response.event.eventId);
            expect((await service.send(roomId, alice, request)).deduplicated).toBe(true);
            await expect(service.send(roomId, alice, {...request, quoteOf: question.event.eventId})).rejects.toMatchObject({code: 'idempotency_conflict'});
            expect((await new RoomService(store).read(roomId, alice, 0, 100)).events.at(-1)?.quoteOf).toBe(response.event.eventId);
        });

        test('quotes cannot point outside retained message history, bypass reply rules or complete somebody else’s request', async () => {
            const question = await ask('unanswered question');
            const quote = {type: 'message' as const, quoteOf: question.event.eventId, payload: {text: 'context', priority: 'normal' as const}, idempotencyKey: newId('event')};
            await service.send(roomId, alice, quote);
            expect((await service.request(roomId, bob, question.event.eventId)).responseEventId).toBeNull();
            const system = (await service.read(roomId, alice, 0, 100)).events[0]!;
            for (const quoteOf of [newId('event'), system.eventId]) {
                await expect(service.send(roomId, alice, {...quote, quoteOf, idempotencyKey: newId('event')})).rejects.toMatchObject({code: 'invalid_request'});
            }
            await expect(service.send(roomId, alice, {...quote, replyTo: question.event.eventId, idempotencyKey: newId('event')})).rejects.toMatchObject({code: 'invalid_request'});
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
        test('muted agents can confirm receipt but cannot send or reply, and revocation blocks receipts', async () => {
            const {event} = await ask('read while muted');
            await service.setMuted(roomId, controller, bobId, true);
            await service.acknowledgeMessage(roomId, bob, event.eventId);
            expect((await service.request(roomId, alice, event.eventId)).receivedAt).not.toBeNull();
            await expect(answer(event.eventId)).rejects.toMatchObject({code: 'participant_muted'});
            await expect(service.send(roomId, bob, {type: 'message', payload: {text: 'blocked', priority: 'normal'}, idempotencyKey: newId('event')})).rejects.toMatchObject({code: 'participant_muted'});
            await expect(service.acknowledgeMessage(roomId, alice, event.eventId)).rejects.toMatchObject({code: 'unauthorized'});
            await service.revoke(roomId, controller, bobId);
            await expect(service.acknowledgeMessage(roomId, bob, event.eventId)).rejects.toMatchObject({code: 'participant_revoked'});
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

        const fail = (id: string, credential = bob, reason = 'Claude produced no runtime activity for 10 minutes; work was stopped, not retried.') =>
            service.send(roomId, credential, {type: 'message.delivery_failed', payload: {eventId: id, reason, stage: 'execution'}, idempotencyKey: newId('event')});
        const recover = (id: string, to = bobId, credential = alice, key = `recover-${id}`) =>
            service.send(roomId, credential, {type: 'message', recipientId: to, payload: {text: 'Finish what remains', priority: 'normal', recovers: id}, idempotencyKey: key});
        const join = async (name: string) => {
            const credential = newCredential('participant');
            const invite = await service.mintInvite(roomId, controller, 'member', true);
            const {participantId} = await service.redeemInvite({code: invite.code, displayName: name, kind: 'agent', participantCredential: credential, attemptId: newId('attempt')});
            return {credential, participantId};
        };

        test('a failed request is retried as a new attempt, and its answer resolves the original without erasing the failure', async () => {
            expect((await service.snapshot(roomId, alice)).requestRecoverySupported).toBe(true);
            const {event} = await ask('build the survey');
            await fail(event.eventId);
            const retry = await recover(event.eventId);
            expect(await service.request(roomId, alice, retry.event.eventId)).toMatchObject({to: bobId, from: aliceId, attempt: 2, recoversEventId: event.eventId, requiresReply: true});
            const waiting = await service.request(roomId, alice, event.eventId);
            expect(waiting).toMatchObject({recoveredByEventId: retry.event.eventId, responseEventId: null, failureReason: expect.stringContaining('no runtime activity')});
            expect(requestState(waiting)).toBe('failed');

            // Repeating the same recovery returns the same attempt; a second, different one is refused.
            expect((await recover(event.eventId)).event.eventId).toBe(retry.event.eventId);
            await expect(recover(event.eventId, bobId, alice, newId('event'))).rejects.toThrow(/already being recovered/);

            await service.acknowledgeMessage(roomId, bob, retry.event.eventId);
            const done = await answer(retry.event.eventId, 'Survey finished and validated');
            const original = await service.request(roomId, alice, event.eventId);
            expect(original).toMatchObject({responseEventId: done.event.eventId, responseText: 'Survey finished and validated', failureAt: waiting.failureAt, failureStage: 'execution', recoveredByEventId: retry.event.eventId});
            expect(requestState(original)).toBe('answered');
            expect(messageActionLabel(original)).toBe('Done · recovered');
            expect(requestState(await service.request(roomId, alice, retry.event.eventId))).toBe('answered');
            expect((await service.requests(roomId, alice)).requests).toHaveLength(0);
        });

        test('a retry that fails is retried again, and one answer resolves every attempt before it', async () => {
            const {event} = await ask('store the evidence');
            await fail(event.eventId);
            const second = await recover(event.eventId);
            await fail(second.event.eventId, bob, 'Claude exceeded the 1 hour absolute request limit; work was stopped, not retried.');
            await expect(recover(event.eventId, bobId, alice, newId('event'))).rejects.toThrow(/retry that one/);
            const third = await recover(second.event.eventId);
            expect(await service.request(roomId, alice, third.event.eventId)).toMatchObject({attempt: 3, recoversEventId: second.event.eventId});
            await service.acknowledgeMessage(roomId, bob, third.event.eventId);
            const done = await answer(third.event.eventId, 'Stored');
            for (const id of [event.eventId, second.event.eventId, third.event.eventId]) {
                expect(await service.request(roomId, alice, id)).toMatchObject({responseEventId: done.event.eventId});
            }
            expect((await service.request(roomId, alice, second.event.eventId)).failureReason).toContain('absolute request limit');
        });

        test('a failed request can be given to another participant, whose answer resolves it', async () => {
            const carol = await join('carol');
            const {event} = await ask('observe the queue');
            await fail(event.eventId);
            const reassigned = await recover(event.eventId, carol.participantId);
            expect(await service.request(roomId, alice, reassigned.event.eventId)).toMatchObject({to: carol.participantId, attempt: 2});
            await service.acknowledgeMessage(roomId, carol.credential, reassigned.event.eventId);
            const done = await service.send(roomId, carol.credential, {type: 'message', recipientId: aliceId, replyTo: reassigned.event.eventId, payload: {text: 'Observed', priority: 'normal', responseStage: 'final'}, idempotencyKey: newId('event')});
            expect(await service.request(roomId, alice, event.eventId)).toMatchObject({to: bobId, responseEventId: done.event.eventId, failureAt: expect.any(Number)});
            expect(done.event.senderId).toBe(carol.participantId);
        });

        test('only the asker or an admin recovers a request, and only one that failed and is unresolved', async () => {
            const carol = await join('carol');
            const {event} = await ask('work');
            await expect(recover(event.eventId)).rejects.toThrow(/has not failed/);
            await fail(event.eventId);
            await expect(recover(event.eventId, bobId, carol.credential)).rejects.toThrow(/original sender or a room admin/);
            await expect(recover(event.eventId, bobId, bob)).rejects.toThrow(/original sender or a room admin/);
            await expect(recover(newId('event'))).rejects.toThrow(/no such request/);
            await expect(service.send(roomId, alice, {type: 'message', allRecipients: true, payload: {text: 'again', priority: 'normal', recovers: event.eventId}, idempotencyKey: newId('event')})).rejects.toThrow(/one participant/);
            await service.setRole(roomId, controller, carol.participantId, 'controller');
            expect((await recover(event.eventId, bobId, carol.credential)).event.senderId).toBe(carol.participantId);

            const answered = await ask('answered already');
            await service.acknowledgeMessage(roomId, bob, answered.event.eventId);
            await answer(answered.event.eventId);
            await expect(recover(answered.event.eventId)).rejects.toThrow(/already resolved/);
        });
    });
}

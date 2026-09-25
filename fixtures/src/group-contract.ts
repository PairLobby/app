import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {TURN_LEASE_MS, newCredential, newId} from '@pairlobby/protocol';
import type {MessageRequest} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {StoreFactory} from './contract.js';
import {fixedClock} from './harness.js';
import type {Clock, TestableRoomStore} from './harness.js';

type Agent = {id: string; credential: string};

export function runGroupContract(label: string, makeStore: StoreFactory): void {
    describe(`${label} / group speaking turns`, () => {
        let store: TestableRoomStore;
        let service: RoomService;
        let clock: Clock;
        let roomId: string;
        let owner: string;
        let ownerId: string;
        let controller: string;
        let codex: Agent;
        let claude: Agent;

        beforeEach(async () => {
            store = makeStore();
            clock = fixedClock();
            service = new RoomService(store, clock.now);
            owner = newCredential('participant');
            controller = newCredential('controller');
            const created = await service.createRoom({name: 'group', displayName: 'owner', kind: 'human', participantCredential: owner, controllerCredential: controller});
            roomId = created.roomId;
            ownerId = created.participantId;
            codex = await join('codex');
            claude = await join('claude');
        });
        afterEach(() => store.close?.());

        async function join(name: string): Promise<Agent> {
            clock.advance(1);
            const invite = await service.mintInvite(roomId, controller, 'member');
            const credential = newCredential('participant');
            const joined = await service.redeemInvite({code: invite.code, displayName: name, kind: 'agent', participantCredential: credential, attemptId: newId('attempt')});
            return {id: joined.participantId, credential};
        }

        async function question(ids: string[] = [codex.id, claude.id]): Promise<MessageRequest[]> {
            const sent = await service.send(roomId, owner, {type: 'message', recipientIds: ids, payload: {text: 'Review this together', priority: 'normal'}, idempotencyKey: newId('event')});
            return store.groupRequests(roomId, sent.event.eventId);
        }

        async function answer(agent: Agent, request: MessageRequest, token: string, text: string): Promise<void> {
            await service.acknowledgeMessage(roomId, agent.credential, request.eventId);
            await service.send(roomId, agent.credential, {type: 'message', recipientId: ownerId, replyTo: request.eventId, turnToken: token, payload: {text, priority: 'normal'}, idempotencyKey: newId('event')});
        }

        test('one visible question fans out atomically, preserves order and deduplicates retries', async () => {
            const input = {type: 'message' as const, recipientIds: [claude.id, codex.id, claude.id], payload: {text: 'Both please', priority: 'normal' as const}, idempotencyKey: newId('event')};
            const sent = await service.send(roomId, owner, input);
            expect(sent.event.recipientIds).toEqual([claude.id, codex.id]);
            const deliveries = await store.groupRequests(roomId, sent.event.eventId);
            expect(deliveries.map((request) => request.to)).toEqual([claude.id, codex.id]);
            expect(new Set(deliveries.map((request) => request.eventId)).size).toBe(2);
            expect(deliveries[0]!.seq).toBeLessThan(deliveries[1]!.seq);
            expect((await service.send(roomId, owner, input)).event.eventId).toBe(sent.event.eventId);
            expect(await store.groupRequests(roomId, sent.event.eventId)).toHaveLength(2);
            expect((await service.requests(roomId, codex.credential, 0, 100, codex.id, false)).requests).toHaveLength(0);
            expect((await service.request(roomId, codex.credential, sent.event.eventId)).eventId).toBe(deliveries[1]!.eventId);
            await join('late arrival');
            expect(await store.groupRequests(roomId, sent.event.eventId)).toHaveLength(2);
            expect((await service.read(roomId, owner, 0, 100)).events.filter((event) => event.type === 'message')).toHaveLength(1);
        });

        test('competing claims grant only the next agent; next turn includes the previous answer', async () => {
            const requests = await question();
            const claimId = newId('event');
            const competing = new RoomService(store, clock.now);
            const claims = await Promise.all([
                service.turns.claim(roomId, codex.credential, requests[0]!.eventId, claimId),
                competing.turns.claim(roomId, claude.credential, requests[1]!.eventId, newId('event')),
                competing.turns.claim(roomId, codex.credential, requests[0]!.eventId, newId('event'))
            ]);
            expect(claims.map((claim) => claim.state)).toEqual(['granted', 'waiting', 'waiting']);
            expect((await service.turns.claim(roomId, codex.credential, requests[0]!.eventId, claimId)).token).toBe(claims[0]!.token);
            expect((await service.request(roomId, owner, requests[0]!.eventId)).turnToken).toBeUndefined();
            await answer(codex, requests[0]!, claims[0]!.token!, 'First answer');
            const next = await service.turns.claim(roomId, claude.credential, requests[1]!.eventId, newId('event'));
            expect(next.state).toBe('granted');
            expect(next.request!.text).toContain('First answer');
            await answer(claude, requests[1]!, next.token!, 'Second answer');
            expect((await service.turns.status(roomId, owner)).entries).toHaveLength(0);
            expect((await service.requests(roomId, owner, 0, 100, ownerId)).requests).toHaveLength(0);
            const replies = (await service.read(roomId, owner, 0, 100)).events.filter((event) => event.type === 'message' && event.replyTo);
            expect(replies.map((reply) => reply.replyTo)).toEqual([requests[0]!.conversationId, requests[0]!.conversationId]);
        });

        test('expiry stays stalled across service restart and skip fences every late reply', async () => {
            const requests = await question();
            const grant = await service.turns.claim(roomId, codex.credential, requests[0]!.eventId, newId('event'));
            clock.advance(TURN_LEASE_MS + 1);
            service = new RoomService(store, clock.now);
            expect((await service.turns.status(roomId, owner)).entries[0]!.state).toBe('stalled');
            await expect(answer(codex, requests[0]!, grant.token!, 'Too late')).rejects.toMatchObject({code: 'turn_expired'});
            expect((await service.turns.claim(roomId, claude.credential, requests[1]!.eventId, newId('event'))).state).toBe('waiting');
            await service.turns.control(roomId, controller, {action: 'skip'});
            await expect(answer(codex, requests[0]!, grant.token!, 'Still too late')).rejects.toMatchObject({code: 'turn_required'});
            const next = await service.turns.claim(roomId, claude.credential, requests[1]!.eventId, newId('event'));
            expect(next.state).toBe('granted');
            await service.turns.pass(roomId, claude.credential, requests[1]!.eventId, next.token!);
            expect((await service.turns.status(roomId, owner)).entries).toHaveLength(0);
        });

        test('renewals persist without transcript churn and parallel mode allows independent turns', async () => {
            const requests = await question();
            const first = await service.turns.claim(roomId, codex.credential, requests[0]!.eventId, newId('event'));
            const seq = (await service.snapshot(roomId, owner)).latestSeq;
            clock.advance(30_000);
            const renewed = await service.turns.renew(roomId, codex.credential, requests[0]!.eventId, first.token!);
            expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt!);
            expect((await service.snapshot(roomId, owner)).latestSeq).toBe(seq);
            await service.turns.mode(roomId, controller, 'parallel');
            const second = await service.turns.claim(roomId, claude.credential, requests[1]!.eventId, newId('event'));
            expect(second.state).toBe('granted');
            await expect(service.turns.mode(roomId, controller, 'sequential')).rejects.toMatchObject({code: 'turn_conflict'});
            await service.turns.control(roomId, controller, {action: 'cancel', requestId: requests[0]!.conversationId});
            expect((await service.turns.mode(roomId, controller, 'sequential')).entries).toHaveLength(0);
            await expect(answer(claude, requests[1]!, second.token!, 'Cancelled')).rejects.toMatchObject({code: 'turn_required'});
        });

        test('all rotates first speaker; admission and owner controls remain enforced', async () => {
            const sendAll = () => service.send(roomId, owner, {type: 'message', allRecipients: true, payload: {text: 'Everyone please', priority: 'normal'}, idempotencyKey: newId('event')});
            const first = await sendAll();
            const second = await sendAll();
            expect(first.event.recipientIds).toEqual([codex.id, claude.id]);
            expect(second.event.recipientIds).toEqual([claude.id, codex.id]);
            await expect(service.turns.mode(roomId, codex.credential, 'parallel')).rejects.toMatchObject({code: 'unauthorized'});
            await expect(service.turns.control(roomId, claude.credential, {action: 'skip'})).rejects.toMatchObject({code: 'unauthorized'});
            await expect(question([ownerId, codex.id])).rejects.toMatchObject({code: 'invalid_request'});
            await service.setMuted(roomId, controller, codex.id, true);
            expect((await sendAll()).event.recipientIds).toEqual([claude.id]);
            const own = (await store.groupRequests(roomId, first.event.eventId))[0]!;
            await expect(service.turns.claim(roomId, claude.credential, own.eventId, newId('event'))).rejects.toMatchObject({code: 'unauthorized'});
        });

        test('delivery pagination advances and old clients skip guarded pages without getting stuck', async () => {
            for (let index = 0; index < 55; index++) {
                await question();
            }
            const hidden = await service.requests(roomId, owner, 0, 1, undefined, false);
            expect(hidden).toEqual({requests: [], hasMore: false});
            const legacy = await service.send(roomId, owner, {type: 'message', recipientId: codex.id, payload: {text: 'legacy delivery', priority: 'normal'}, idempotencyKey: newId('event')});
            expect((await service.requests(roomId, owner, 0, 1, undefined, false)).requests[0]!.eventId).toBe(legacy.event.eventId);
            const first = (await service.requests(roomId, owner, 0, 1)).requests[0]!;
            const second = (await service.requests(roomId, owner, first.seq, 1)).requests[0]!;
            expect(second.seq).toBeGreaterThan(first.seq);
            expect(second.conversationId).toBe(first.conversationId);
            clock.advance(30_001);
            expect((await service.turns.status(roomId, owner)).entries[0]!.state).toBe('stalled');
            await service.turns.control(roomId, controller, {action: 'skip', requestId: first.eventId});
            expect((await service.turns.status(roomId, owner)).entries[0]!.state).toBe('waiting');
        });

        test('failed turns release the queue and the owner can resolve their remaining deliveries', async () => {
            const requests = await question();
            const grant = await service.turns.claim(roomId, codex.credential, requests[0]!.eventId, newId('event'));
            await service.send(roomId, codex.credential, {type: 'message.delivery_failed', payload: {eventId: requests[0]!.eventId, reason: 'Fixture runtime unavailable'}, turnToken: grant.token!, idempotencyKey: newId('event')});
            expect((await service.turns.status(roomId, owner)).entries[0]!.state).toBe('failed');
            expect((await service.request(roomId, owner, requests[0]!.eventId)).receivedAt).toBeNull();
            await service.turns.control(roomId, controller, {action: 'cancel', requestId: requests[0]!.conversationId});
            expect((await service.turns.status(roomId, owner)).entries).toHaveLength(0);
        });

        test('a human message racing a turn claim cannot overwrite room state or event sequences', async () => {
            const requests = await question();
            const message = {type: 'message' as const, payload: {text: 'A concurrent update', priority: 'normal' as const}, idempotencyKey: newId('event')};
            const results = await Promise.allSettled([
                service.turns.claim(roomId, codex.credential, requests[0]!.eventId, newId('event')),
                service.send(roomId, owner, message)
            ]);
            expect(results[0]!.status).toBe('fulfilled');
            await service.send(roomId, owner, message);
            const events = (await service.read(roomId, owner, 0, 100)).events;
            expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
            expect(events.filter((event) => event.type === 'message' && event.payload.text === message.payload.text)).toHaveLength(1);
            expect((await service.turns.status(roomId, owner)).entries[0]!.state).toBe('answering');
        });
    });
}

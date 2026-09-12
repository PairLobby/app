//! Crash injection around invite redemption. The gate is that every interleaving
//! produces at most one membership, and that an authorized retry recovers the
//! same one rather than forking a second.

import {ProtocolError, newCredential, newId} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {FaultyStore} from './faulty-store.js';
import type {StoreFactory} from './contract.js';

export function runRedemptionContract(label: string, makeStore: StoreFactory): void {
    describe(label, () => {
        let store: FaultyStore;
        let service: RoomService;
        let roomId: string;
        let controllerCredential: string;
        let code: string;

        const joiner = {displayName: 'codex', kind: 'agent' as const};

        beforeEach(async () => {
            store = new FaultyStore(makeStore());
            service = new RoomService(store, () => 1_700_000_000_000);
            controllerCredential = newCredential('controller');
            const created = await service.createRoom({name: 'recovery-room', controllerCredential, participantCredential: newCredential('participant'), displayName: 'claude', kind: 'agent'});
            roomId = created.roomId;
            code = created.invite.code;
        });

        afterEach(() => store.close());

        async function participantCount(): Promise<number> {
            return (await service.snapshot(roomId, controllerCredential)).participants.length;
        }

        test('test_a_crash_creating_membership_leaves_a_resumable_reservation', async () => {
            const attemptId = newId('attempt');
            const participantCredential = newCredential('participant');
            store.faults.failNextApply = true;
            await expect(service.redeemInvite({code, attemptId, participantCredential, ...joiner})).rejects.toThrow('injected store failure');
            expect(await participantCount()).toBe(1);

            const recovered = await service.redeemInvite({code, attemptId, participantCredential, ...joiner});
            expect(recovered.replayed).toBe(false);
            expect(await participantCount()).toBe(2);
        });

        test('test_a_crash_before_the_invite_is_marked_consumed_recovers_the_same_member', async () => {
            const attemptId = newId('attempt');
            const participantCredential = newCredential('participant');
            store.faults.failNextCompleteInvite = true;
            await expect(service.redeemInvite({code, attemptId, participantCredential, ...joiner})).rejects.toThrow('injected crash');
            expect(await participantCount()).toBe(2);

            const recovered = await service.redeemInvite({code, attemptId, participantCredential, ...joiner});
            expect(recovered.replayed).toBe(true);
            expect(await participantCount()).toBe(2);
        });

        test('test_a_stranger_cannot_claim_an_invite_reserved_by_another_attempt', async () => {
            const participantCredential = newCredential('participant');
            store.faults.failNextApply = true;
            await expect(service.redeemInvite({code, attemptId: newId('attempt'), participantCredential, ...joiner})).rejects.toThrow('injected store failure');

            // The reservation survives the crash, so the code is not available to anyone else.
            await expect(service.redeemInvite({code, attemptId: newId('attempt'), participantCredential: newCredential('participant'), displayName: 'stranger', kind: 'agent'}))
                .rejects.toMatchObject({code: 'invite_already_redeemed'});
            expect(await participantCount()).toBe(1);
        });

        // This proves the service serializes correctly *given* an atomic `reserveInvite`.
        // A single-threaded fixture cannot prove the store's own isolation under real
        // concurrency; that belongs in the load runs.
        test('test_concurrent_attempts_on_one_invite_yield_exactly_one_member', async () => {
            const attempts = Array.from({length: 8}, () => ({code, attemptId: newId('attempt'), participantCredential: newCredential('participant'), ...joiner}));
            const results = await Promise.allSettled(attempts.map((attempt) => service.redeemInvite(attempt)));
            expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
            for (const result of results.filter((candidate) => candidate.status === 'rejected')) {
                expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ProtocolError);
                expect((result as PromiseRejectedResult).reason.code).toBe('invite_already_redeemed');
            }
            expect(await participantCount()).toBe(2);
        });

        test('test_retrying_a_completed_redemption_never_creates_a_second_member', async () => {
            const attemptId = newId('attempt');
            const participantCredential = newCredential('participant');
            const first = await service.redeemInvite({code, attemptId, participantCredential, ...joiner});
            for (let index = 0; index < 5; index += 1) {
                const retry = await service.redeemInvite({code, attemptId, participantCredential, ...joiner});
                expect(retry.participantId).toBe(first.participantId);
                expect(retry.replayed).toBe(true);
            }
            expect(await participantCount()).toBe(2);
        });

        test('test_each_invite_admits_one_member_so_a_second_agent_needs_its_own', async () => {
            await service.redeemInvite({code, attemptId: newId('attempt'), participantCredential: newCredential('participant'), ...joiner});
            const second = await service.mintInvite(roomId, controllerCredential, 'member');
            await service.redeemInvite({code: second.code, attemptId: newId('attempt'), participantCredential: newCredential('participant'), displayName: 'gemini', kind: 'agent'});
            expect(await participantCount()).toBe(3);
        });
    });
}

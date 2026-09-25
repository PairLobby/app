//! The room contract. Every storage adapter must satisfy it; a test that passes
//! here states what the Durable Object and the Node/SQLite server must also do.
//!
//! Call `runRoomContract` from a test file, passing a factory for the store
//! under test.

import {DEFAULT_ROOM_POLICY, ProtocolError, newCredential, newId} from '@pairlobby/protocol';
import type {ErrorCode} from '@pairlobby/protocol';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {runRequestContract} from './request-contract.js';
import {runRejoinContract} from './rejoin-contract.js';
import {runGroupContract} from './group-contract.js';
import {FakeAgent} from './fake-agent.js';
import {RoomHarness, fixedClock} from './harness.js';
import type {Clock, TestableRoomStore} from './harness.js';
import {sampleHandover} from './handover-samples.js';

async function expectError(code: ErrorCode, run: () => Promise<unknown>): Promise<ProtocolError> {
    try {
        await run();
    } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        expect((error as ProtocolError).code).toBe(code);
        return error as ProtocolError;
    }
    throw new Error(`expected ${code} but the call succeeded`);
}

export type StoreFactory = () => TestableRoomStore;

export function runRoomContract(label: string, makeStore: StoreFactory): void {
    runRequestContract(label, makeStore);
    runRejoinContract(label, makeStore);
    runGroupContract(label, makeStore);
    describe(label, () => {
        const opened: RoomHarness[] = [];
        function track(harness: RoomHarness): RoomHarness {
            opened.push(harness);
            return harness;
        }
        afterEach(() => {
            while (opened.length > 0) opened.pop()!.dispose();
        });

        describe('room lifecycle', () => {
            let server: RoomHarness;
            let alice: FakeAgent;
            let bob: FakeAgent;

            beforeEach(async () => {
                server = track(new RoomHarness(makeStore()));
                alice = new FakeAgent(server, 'claude', {capabilities: {deliverUnsolicited: true, cancelTurn: true, cancelTool: false, runtime: 'claude-code'}});
                bob = new FakeAgent(server, 'codex', {capabilities: {deliverUnsolicited: false, cancelTurn: false, cancelTool: false, runtime: 'codex-cli'}});
                const created = await alice.create('my-project');
                await bob.join(created.inviteCode);
            });

            test('test_join_produces_distinct_identities_and_cursors', async () => {
                expect(alice.participantId).not.toBe(bob.participantId);
                expect(alice.credential).not.toBe(bob.credential);
                expect(alice.sessionId).not.toBe(bob.sessionId);
                await alice.say('hello codex', bob.participantId);
                expect(await bob.poll()).toHaveLength(1);
                expect(bob.cursor).toBeGreaterThan(0);
                expect(alice.cursor).toBe(0);
            });

            test('test_only_addressed_events_reach_an_agent_inbox', async () => {
                await alice.say('thinking out loud');
                await alice.say('codex, take this', bob.participantId);
                const addressed = await bob.poll();
                expect(addressed).toHaveLength(1);
                expect(addressed[0]!.type).toBe('message');
                // Room-wide chatter is still readable by every member; it just does not activate them.
                const page = await server.read(bob.credential, 0);
                expect(page.events.filter((event) => event.type === 'message')).toHaveLength(2);
            });

            test('test_two_sessions_of_one_runtime_stay_isolated', async () => {
                const secondClaude = new FakeAgent(server, 'claude', {});
                await secondClaude.join(await server.mintInvite('member'));
                expect(secondClaude.participantId).not.toBe(alice.participantId);
                expect(secondClaude.sessionId).not.toBe(alice.sessionId);
                await alice.say('for the first session only', alice.participantId);
                expect(await secondClaude.poll()).toHaveLength(0);
            });
        });

        describe('guest access', () => {
            let server: RoomHarness;
            let alice: FakeAgent;
            let controller: string;

            beforeEach(async () => {
                server = track(new RoomHarness(makeStore()));
                alice = new FakeAgent(server, 'claude');
                const created = await alice.create('guest-room');
                controller = created.controllerCredential;
            });

            const guest = {displayName: 'hugo', kind: 'human' as const};

            test('test_a_closed_room_refuses_a_guest_who_knows_its_id', async () => {
                await expectError('unauthorized', () => server.joinAsGuest(guest, newCredential('participant')));
            });

            test('test_an_open_room_admits_a_guest_with_no_invite_code', async () => {
                await server.setJoinPolicy(controller, 'open_to_guests');
                const joined = await server.joinAsGuest(guest, newCredential('participant'));
                expect(joined.role).toBe('guest');
                expect((await server.snapshot(controller)).policy.joinPolicy).toBe('open_to_guests');
            });

            test('test_a_guest_can_read_the_whole_transcript', async () => {
                await server.setJoinPolicy(controller, 'open_to_guests');
                await alice.say('something before the guest arrived');
                const credential = newCredential('participant');
                await server.joinAsGuest(guest, credential);
                const page = await server.read(credential, 0);
                expect(page.events.some((event) => event.type === 'message')).toBe(true);
            });

            test('test_a_guest_cannot_write_in_any_form', async () => {
                await server.setJoinPolicy(controller, 'open_to_guests');
                const credential = newCredential('participant');
                const joined = await server.joinAsGuest(guest, credential);

                await expectError('unauthorized', () => server.send(credential, {type: 'message', payload: {text: 'hello', priority: 'normal'}, idempotencyKey: newId('event')}));
                await expectError('unauthorized', () =>
                    server.send(credential, {
                        type: 'handover.offered',
                        payload: {handoverId: newId('handover'), revision: 1, document: sampleHandover()},
                        idempotencyKey: newId('event'),
                        recipientId: alice.participantId
                    })
                );
                await expectError('unauthorized', () =>
                    server.send(credential, {
                        type: 'control.ack',
                        payload: {targetParticipantId: joined.participantId, revision: 1, outcome: 'resumed'},
                        idempotencyKey: newId('event')
                    })
                );
                await expectError('unauthorized', () => server.control(credential, alice.participantId, true));
                await expectError('unauthorized', () => server.revoke(credential, alice.participantId));
                await expectError('unauthorized', () => server.close(credential));
                await expectError('unauthorized', () => server.rename(credential, 'hijacked'));
                await expectError('unauthorized', () => server.setExpiry(credential, Date.now() + 60_000));
                await expectError('unauthorized', () => server.setJoinPolicy(credential, 'invite_only'));
            });

            test('test_a_guest_cannot_widen_the_room', async () => {
                await server.setJoinPolicy(controller, 'open_to_guests');
                const credential = newCredential('participant');
                await server.joinAsGuest(guest, credential);
                await expectError('unauthorized', () => server.mintInviteAs(credential));
            });

            test('test_a_guest_may_leave', async () => {
                await server.setJoinPolicy(controller, 'open_to_guests');
                const credential = newCredential('participant');
                const joined = await server.joinAsGuest(guest, credential);
                await server.leave(credential);
                expect((await server.snapshot(controller)).participants.find((participant) => participant.participantId === joined.participantId)!.left).toBe(true);
            });

            test('test_closing_the_room_again_stops_new_guests', async () => {
                await server.setJoinPolicy(controller, 'open_to_guests');
                await server.joinAsGuest(guest, newCredential('participant'));
                await server.setJoinPolicy(controller, 'invite_only');
                await expectError('unauthorized', () => server.joinAsGuest({displayName: 'latecomer', kind: 'human'}, newCredential('participant')));
            });

            test('test_only_the_controller_can_open_a_room', async () => {
                await expectError('unauthorized', () => server.setJoinPolicy(alice.credential, 'open_to_guests'));
            });

            test('test_opening_is_recorded_in_history', async () => {
                await server.setJoinPolicy(controller, 'open_to_guests');
                const page = await server.read(alice.credential, 0);
                const changed = page.events.find((event) => event.type === 'room.access_changed');
                expect(changed?.type === 'room.access_changed' && changed.payload.joinPolicy).toBe('open_to_guests');
            });

            test('test_guests_count_against_the_participant_cap', async () => {
                await server.setJoinPolicy(controller, 'open_to_guests');
                for (let index = 1; index < DEFAULT_ROOM_POLICY.maxParticipants; index += 1) {
                    await server.joinAsGuest({displayName: `guest-${index}`, kind: 'human'}, newCredential('participant'));
                }
                await expectError('participant_limit_reached', () => server.joinAsGuest({displayName: 'one-too-many', kind: 'human'}, newCredential('participant')));
            });
        });

        describe('invite seats', () => {
            let server: RoomHarness;
            let alice: FakeAgent;

            beforeEach(async () => {
                server = track(new RoomHarness(makeStore()));
                alice = new FakeAgent(server, 'claude');
                await alice.create('seat-room');
            });

            test('test_a_code_is_refused_while_its_occupant_is_still_in_the_room', async () => {
                const code = await server.mintInvite('member');
                await new FakeAgent(server, 'hugo').join(code);
                await expectError('invite_already_redeemed', () => new FakeAgent(server, 'someone-else').join(code));
            });

            test('test_a_code_works_again_once_its_occupant_leaves', async () => {
                const code = await server.mintInvite('member');
                const first = new FakeAgent(server, 'hugo');
                await first.join(code);
                await server.leave(first.credential);

                const second = new FakeAgent(server, 'hugo');
                await second.join(code);
                expect(second.participantId).not.toBe(first.participantId);
                const snapshot = await server.snapshot(second.credential);
                expect(snapshot.participants.filter((participant) => !participant.left && !participant.revoked)).toHaveLength(2);
            });

            test('test_leaving_frees_the_seat_for_the_participant_cap_too', async () => {
                const code = await server.mintInvite('member');
                const first = new FakeAgent(server, 'hugo');
                await first.join(code);
                await server.leave(first.credential);
                const snapshot = await server.snapshot(first.credential);
                expect(snapshot.participants.find((participant) => participant.participantId === first.participantId)!.left).toBe(true);
            });

            // The occupancy check and the reservation have to be one atomic step, or
            // every racer sees the same departed occupant and they all claim the seat.
            test('test_racing_claims_on_one_vacated_seat_admit_exactly_one', async () => {
                const code = await server.mintInvite('member');
                const first = new FakeAgent(server, 'hugo');
                await first.join(code);
                await server.leave(first.credential);

                const claimants = Array.from({length: 8}, (_, index) => new FakeAgent(server, `claimant-${index}`));
                const results = await Promise.allSettled(claimants.map((claimant) => claimant.join(code)));
                expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

                const snapshot = await server.snapshot(first.credential);
                expect(snapshot.participants.filter((participant) => !participant.left && !participant.revoked)).toHaveLength(2);
            });

            test('test_a_revoked_participants_seat_stays_shut', async () => {
                const code = await server.mintInvite('member');
                const evicted = new FakeAgent(server, 'hugo');
                await evicted.join(code);
                await server.revoke(server.controller(), evicted.participantId);
                // Removal is deliberate; reusing the code that admitted them must not undo it.
                await expectError('invite_already_redeemed', () => new FakeAgent(server, 'hugo-again').join(code));
            });

            test('test_a_single_use_code_stays_spent_after_its_holder_leaves', async () => {
                const code = await server.mintInviteOnce();
                const first = new FakeAgent(server, 'hugo');
                await first.join(code);
                await server.leave(first.credential);
                await expectError('invite_already_redeemed', () => new FakeAgent(server, 'hugo-again').join(code));
            });
        });

        describe('idempotency and retries', () => {
            test('test_repeated_key_with_identical_content_returns_the_original_event', async () => {
                const server = track(new RoomHarness(makeStore()));
                const alice = new FakeAgent(server, 'claude');
                await alice.create('retry-room');
                const key = newId('event');
                const first = await server.send(alice.credential, {type: 'message', payload: {text: 'once', priority: 'normal'}, idempotencyKey: key});
                const second = await server.send(alice.credential, {type: 'message', payload: {text: 'once', priority: 'normal'}, idempotencyKey: key});
                expect(second.deduplicated).toBe(true);
                expect(second.event.seq).toBe(first.event.seq);
                expect(second.event.eventId).toBe(first.event.eventId);
                const page = await server.read(alice.credential, 0);
                expect(page.events.filter((event) => event.type === 'message')).toHaveLength(1);
            });

            test('test_repeated_key_with_different_content_is_a_conflict', async () => {
                const server = track(new RoomHarness(makeStore()));
                const alice = new FakeAgent(server, 'claude');
                await alice.create('retry-room');
                const key = newId('event');
                await server.send(alice.credential, {type: 'message', payload: {text: 'first', priority: 'normal'}, idempotencyKey: key});
                await expectError('idempotency_conflict', () =>
                    server.send(alice.credential, {type: 'message', payload: {text: 'different', priority: 'normal'}, idempotencyKey: key})
                );
            });

            test('test_repeated_redemption_of_one_attempt_creates_one_member', async () => {
                const server = track(new RoomHarness(makeStore()));
                const alice = new FakeAgent(server, 'claude');
                const created = await alice.create('join-room');
                const attemptId = newId('attempt');
                const credential = `plp_${newId('room')}`;
                const identity = {displayName: 'codex', kind: 'agent' as const};
                const first = await server.redeemInvite(created.inviteCode, identity, attemptId, credential);
                const second = await server.redeemInvite(created.inviteCode, identity, attemptId, credential);
                expect(second.participantId).toBe(first.participantId);
                expect(second.replayed).toBe(true);
                const snapshot = await server.snapshot(created.controllerCredential);
                expect(snapshot.participants).toHaveLength(2);
            });

            test('test_a_different_attempt_cannot_claim_a_used_invite', async () => {
                const server = track(new RoomHarness(makeStore()));
                const alice = new FakeAgent(server, 'claude');
                const created = await alice.create('join-room');
                await server.redeemInvite(created.inviteCode, {displayName: 'codex', kind: 'agent'}, newId('attempt'), `plp_${newId('room')}`);
                await expectError('invite_already_redeemed', () =>
                    server.redeemInvite(created.inviteCode, {displayName: 'stranger', kind: 'agent'}, newId('attempt'), `plp_${newId('room')}`)
                );
            });

            test('test_an_invite_does_not_expire_unless_it_was_given_a_deadline', async () => {
                const clock = fixedClock();
                const server = track(new RoomHarness(makeStore(), clock));
                const alice = new FakeAgent(server, 'claude');
                const created = await alice.create('join-room');
                clock.advance(365 * 24 * 60 * 60 * 1000);
                const joined = await server.redeemInvite(created.inviteCode, {displayName: 'codex', kind: 'agent'}, newId('attempt'), `plp_${newId('room')}`);
                expect(joined.replayed).toBe(false);
            });

            test('test_an_invite_given_a_deadline_stops_working_after_it', async () => {
                const clock = fixedClock();
                const server = track(new RoomHarness(makeStore(), clock));
                const alice = new FakeAgent(server, 'claude');
                await alice.create('join-room');
                const code = await server.mintExpiringInvite(10 * 60 * 1000);
                clock.advance(10 * 60 * 1000 + 1);
                await expectError('invite_expired', () => server.redeemInvite(code, {displayName: 'codex', kind: 'agent'}, newId('attempt'), `plp_${newId('room')}`));
            });

            test('test_a_deadline_only_gates_the_first_use_not_the_seat', async () => {
                const clock = fixedClock();
                const server = track(new RoomHarness(makeStore(), clock));
                const alice = new FakeAgent(server, 'claude');
                await alice.create('join-room');
                const code = await server.mintExpiringInvite(10 * 60 * 1000);
                const first = new FakeAgent(server, 'hugo');
                await first.join(code);
                await server.leave(first.credential);

                // The seat reopens even though the original deadline has passed: the
                // code was already claimed, so the clock has done its job.
                clock.advance(10 * 60 * 1000 + 1);
                await new FakeAgent(server, 'hugo').join(code);
            });
        });

        describe('handover', () => {
            let server: RoomHarness;
            let alice: FakeAgent;
            let bob: FakeAgent;
            let controller: string;

            beforeEach(async () => {
                server = track(new RoomHarness(makeStore()));
                alice = new FakeAgent(server, 'claude');
                bob = new FakeAgent(server, 'codex');
                const created = await alice.create('handover-room');
                controller = created.controllerCredential;
                await bob.join(created.inviteCode);
            });

            test('test_recipient_accepts_the_offered_revision', async () => {
                const handoverId = await alice.offerHandover(bob.participantId, sampleHandover());
                await bob.acceptHandover(handoverId, 1);
                const page = await server.read(bob.credential, 0);
                expect(page.events.some((event) => event.type === 'handover.accepted')).toBe(true);
            });

            test('test_a_non_recipient_cannot_accept', async () => {
                const carol = new FakeAgent(server, 'gemini');
                await carol.join(await server.mintInvite('member'));
                const handoverId = await alice.offerHandover(bob.participantId, sampleHandover());
                await expectError('unauthorized', () => carol.acceptHandover(handoverId, 1));
            });

            test('test_a_sender_cannot_hand_over_to_itself', async () => {
                await expectError('invalid_request', () => alice.offerHandover(alice.participantId, sampleHandover()));
            });

            test('test_accepting_a_revision_that_is_not_current_fails', async () => {
                const handoverId = await alice.offerHandover(bob.participantId, sampleHandover());
                const error = await expectError('stale_handover_revision', () => bob.acceptHandover(handoverId, 2));
                expect(error.details.currentRevision).toBe(1);
            });

            test('test_decline_then_amend_then_accept_the_new_revision', async () => {
                const handoverId = await alice.offerHandover(bob.participantId, sampleHandover());
                await bob.declineHandover(handoverId, 1, 'the dirty changes are not reachable from here');
                await alice.offerHandover(bob.participantId, sampleHandover({nextAction: 'Pull branch feature/room-core first'}), handoverId, 2);
                // The stale revision can never be accepted, before or after the amendment.
                await expectError('stale_handover_revision', () => bob.acceptHandover(handoverId, 1));
                await bob.acceptHandover(handoverId, 2);
            });

            test('test_a_declined_revision_cannot_later_be_accepted', async () => {
                const handoverId = await alice.offerHandover(bob.participantId, sampleHandover());
                await bob.declineHandover(handoverId, 1, 'the dirty changes are not reachable from here');
                // Reversing a decline would leave the sender believing the work was refused.
                await expectError('handover_already_resolved', () => bob.acceptHandover(handoverId, 1));
                await expectError('handover_already_resolved', () => bob.declineHandover(handoverId, 1));
            });

            test('test_an_accepted_handover_cannot_be_amended_or_re_resolved', async () => {
                const handoverId = await alice.offerHandover(bob.participantId, sampleHandover());
                await bob.acceptHandover(handoverId, 1);
                await expectError('handover_already_resolved', () => alice.offerHandover(bob.participantId, sampleHandover(), handoverId, 2));
                await expectError('handover_already_resolved', () => bob.acceptHandover(handoverId, 1));
            });

            test('test_an_amendment_by_another_participant_is_refused', async () => {
                const handoverId = await alice.offerHandover(bob.participantId, sampleHandover());
                await expectError('unauthorized', () => bob.offerHandover(alice.participantId, sampleHandover(), handoverId, 2));
            });
        });

        describe('human control', () => {
            let server: RoomHarness;
            let alice: FakeAgent;
            let bob: FakeAgent;
            let controller: string;

            beforeEach(async () => {
                server = track(new RoomHarness(makeStore()));
                alice = new FakeAgent(server, 'claude', {capabilities: {deliverUnsolicited: true, cancelTurn: true, cancelTool: false}});
                bob = new FakeAgent(server, 'codex', {capabilities: {deliverUnsolicited: false, cancelTurn: false, cancelTool: false}});
                const created = await alice.create('control-room');
                controller = created.controllerCredential;
                await bob.join(created.inviteCode);
            });

            test('test_pause_is_acknowledged_with_what_actually_happened', async () => {
                await server.control(controller, alice.participantId, true);
                await alice.poll();
                const snapshot = await server.snapshot(controller);
                const view = snapshot.participants.find((participant) => participant.participantId === alice.participantId)!;
                expect(view.paused).toBe(true);
                expect(view.acknowledgedOutcome).toBe('current_turn_cancelled');
            });

            test('test_an_adapter_without_cancellation_reports_paused_between_turns', async () => {
                await server.control(controller, bob.participantId, true);
                await bob.poll();
                const snapshot = await server.snapshot(controller);
                expect(snapshot.participants.find((participant) => participant.participantId === bob.participantId)!.acknowledgedOutcome).toBe('paused_between_turns');
            });

            test('test_a_member_cannot_pause_another_member', async () => {
                await expectError('unauthorized', () => server.control(alice.credential, bob.participantId, true));
            });

            test('test_a_participant_cannot_acknowledge_control_for_someone_else', async () => {
                await server.control(controller, bob.participantId, true);
                await expectError('unauthorized', () =>
                    server.send(alice.credential, {
                        type: 'control.ack',
                        payload: {targetParticipantId: bob.participantId, revision: 1, outcome: 'paused_between_turns'},
                        idempotencyKey: newId('event')
                    })
                );
            });

            test('test_a_late_acknowledgement_does_not_overwrite_a_newer_revision', async () => {
                const pause = await server.control(controller, bob.participantId, true);
                const pauseRevision = pause.type === 'control.pause' ? pause.payload.revision : 0;
                await server.control(controller, bob.participantId, false);
                await bob.poll();
                const afterResume = await server.snapshot(controller);
                expect(afterResume.participants.find((participant) => participant.participantId === bob.participantId)!.acknowledgedOutcome).toBe('resumed');

                // The stale pause acknowledgement arrives now. It is recorded as history but must not win.
                await server.send(bob.credential, {
                    type: 'control.ack',
                    payload: {targetParticipantId: bob.participantId, revision: pauseRevision, outcome: 'paused_between_turns'},
                    idempotencyKey: newId('event')
                });
                const snapshot = await server.snapshot(controller);
                const view = snapshot.participants.find((participant) => participant.participantId === bob.participantId)!;
                expect(view.paused).toBe(false);
                expect(view.acknowledgedOutcome).toBe('resumed');
                // Two acknowledgements from the poll plus the late one: all three are history.
                const page = await server.read(controller, 0);
                expect(page.events.filter((event) => event.type === 'control.ack')).toHaveLength(3);
                expect(page.events.at(-1)!.type).toBe('control.ack');
            });

            test('test_acknowledging_a_revision_the_server_never_issued_fails', async () => {
                await server.control(controller, bob.participantId, true);
                await expectError('invalid_request', () =>
                    server.send(bob.credential, {
                        type: 'control.ack',
                        payload: {targetParticipantId: bob.participantId, revision: 99, outcome: 'paused_between_turns'},
                        idempotencyKey: newId('event')
                    })
                );
            });
        });

        describe('revocation, closure, and expiry', () => {
            let server: RoomHarness;
            let alice: FakeAgent;
            let bob: FakeAgent;
            let controller: string;

            beforeEach(async () => {
                server = track(new RoomHarness(makeStore(), fixedClock()));
                alice = new FakeAgent(server, 'claude');
                bob = new FakeAgent(server, 'codex');
                const created = await alice.create('revoke-room');
                controller = created.controllerCredential;
                await bob.join(created.inviteCode);
            });

            test('test_a_revoked_participant_can_neither_read_nor_write', async () => {
                await server.revoke(controller, bob.participantId);
                await expectError('participant_revoked', () => bob.say('still here?'));
                await expectError('participant_revoked', () => server.read(bob.credential, 0));
            });

            test('test_revoking_twice_is_refused', async () => {
                await server.revoke(controller, bob.participantId);
                await expectError('idempotency_conflict', () => server.revoke(controller, bob.participantId));
            });

            test('test_the_controller_can_rename_a_room_and_history_records_it', async () => {
                await server.rename(controller, 'invite recovery work');
                expect((await server.snapshot(controller)).name).toBe('invite recovery work');
                const page = await server.read(alice.credential, 0);
                const renamed = page.events.find((event) => event.type === 'room.renamed');
                expect(renamed).toBeDefined();
                expect(renamed!.type === 'room.renamed' && renamed!.payload.previousName).toBe('revoke-room');
            });

            test('test_a_member_cannot_rename_a_room', async () => {
                await expectError('unauthorized', () => server.rename(alice.credential, 'hijacked'));
            });

            test('test_renaming_to_the_same_name_is_refused', async () => {
                await expectError('invalid_request', () => server.rename(controller, 'revoke-room'));
            });

            test('test_a_room_is_invite_only_unless_told_otherwise', async () => {
                expect((await server.snapshot(controller)).policy.joinPolicy).toBe('invite_only');
            });

            test('test_a_closed_room_cannot_be_renamed', async () => {
                await server.close(controller);
                await expectError('room_closed', () => server.rename(controller, 'too late'));
            });

            test('test_a_closed_room_rejects_new_work_but_stays_readable', async () => {
                const unusedInvite = await server.mintInvite('member');
                await server.close(controller);
                await expectError('room_closed', () => alice.say('one more'));
                await expectError('room_closed', () => server.mintInvite('member'));
                await expectError('room_closed', () => server.redeemInvite(unusedInvite, {displayName: 'latecomer', kind: 'agent'}, newId('attempt'), `plp_${newId('room')}`));
                const page = await server.read(alice.credential, 0);
                expect(page.events.some((event) => event.type === 'room.closed')).toBe(true);
                expect((await server.snapshot(controller)).lifecycle).toBe('closed');
            });

            test('test_a_closed_room_becomes_unreadable_once_its_export_window_ends', async () => {
                const windowClock = fixedClock();
                const closing = track(new RoomHarness(makeStore(), windowClock));
                const carol = new FakeAgent(closing, 'claude');
                const created = await carol.create('closing-room');
                await closing.close(created.controllerCredential);
                windowClock.advance(DEFAULT_ROOM_POLICY.exportWindowMs - 1);
                expect((await closing.read(carol.credential, 0)).events.length).toBeGreaterThan(0);
                windowClock.advance(2);
                await expectError('room_expired', () => closing.read(carol.credential, 0));
            });

            test('test_a_room_does_not_expire_unless_told_to', async () => {
                const clock = fixedClock();
                const permanent = track(new RoomHarness(makeStore(), clock));
                const carol = new FakeAgent(permanent, 'claude');
                const created = await carol.create('permanent-room');
                expect((await permanent.snapshot(created.controllerCredential)).expiresAt).toBeNull();
                clock.advance(365 * 24 * 60 * 60 * 1000);
                await carol.say('still here a year later');
            });

            test('test_expiry_is_enforced_on_reads_and_writes_before_any_cleanup', async () => {
                const clock = fixedClock();
                const expiring = track(new RoomHarness(makeStore(), clock));
                const carol = new FakeAgent(expiring, 'claude');
                const created = await carol.create('expiring-room');
                await expiring.setExpiry(created.controllerCredential, clock.now() + 60_000);
                clock.advance(60_001);
                await expectError('room_expired', () => carol.say('anyone there?'));
                await expectError('room_expired', () => expiring.read(carol.credential, 0));
                await expectError('room_expired', () => expiring.snapshot(created.controllerCredential));
            });

            test('test_expiry_can_be_lifted_again', async () => {
                const clock = fixedClock();
                const harness = track(new RoomHarness(makeStore(), clock));
                const carol = new FakeAgent(harness, 'claude');
                const created = await carol.create('reprieve-room');
                await harness.setExpiry(created.controllerCredential, clock.now() + 60_000);
                await harness.setExpiry(created.controllerCredential, null);
                clock.advance(120_000);
                await carol.say('reprieved');
                expect((await harness.snapshot(created.controllerCredential)).expiresAt).toBeNull();
            });

            test('test_only_the_controller_can_change_expiry', async () => {
                await expectError('unauthorized', () => server.setExpiry(alice.credential, Date.now() + 60_000));
            });

            test('test_an_expiry_in_the_past_is_refused', async () => {
                const clock = fixedClock();
                const harness = track(new RoomHarness(makeStore(), clock));
                const carol = new FakeAgent(harness, 'claude');
                const created = await carol.create('past-room');
                await expectError('invalid_request', () => harness.setExpiry(created.controllerCredential, clock.now() - 1));
            });

            test('test_changing_expiry_is_recorded_in_history', async () => {
                const deadline = Date.now() + 3_600_000;
                await server.setExpiry(controller, deadline);
                const page = await server.read(alice.credential, 0);
                const changed = page.events.find((event) => event.type === 'room.expiry_changed');
                expect(changed?.type === 'room.expiry_changed' && changed.payload.expiresAt).toBe(deadline);
            });

            test('test_an_unknown_credential_is_unauthorized', async () => {
                await expectError('unauthorized', () => server.read('plp_not-a-real-credential', 0));
            });
        });

        describe('bounds', () => {
            test('test_an_oversized_payload_is_refused', async () => {
                const server = track(new RoomHarness(makeStore()));
                const alice = new FakeAgent(server, 'claude');
                await alice.create('bounds-room');
                await expectError('payload_too_large', () => alice.say('x'.repeat(DEFAULT_ROOM_POLICY.maxEventPayloadBytes + 1)));
            });

            test('test_the_participant_limit_is_enforced', async () => {
                const server = track(new RoomHarness(makeStore()));
                const alice = new FakeAgent(server, 'claude');
                const created = await alice.create('crowded-room');
                for (let index = 1; index < DEFAULT_ROOM_POLICY.maxParticipants; index += 1) {
                    await new FakeAgent(server, `agent-${index}`).join(await server.mintInvite('member'));
                }
                const overflowCode = await server.mintInvite('member');
                await expectError('participant_limit_reached', () => new FakeAgent(server, 'one-too-many').join(overflowCode));
                expect((await server.snapshot(created.controllerCredential)).participants).toHaveLength(DEFAULT_ROOM_POLICY.maxParticipants);
            });

            test('test_quota_exhaustion_bounds_ordinary_writes_but_leaves_control_and_close_usable', async () => {
                const server = track(new RoomHarness(makeStore()));
                const alice = new FakeAgent(server, 'claude');
                const bob = new FakeAgent(server, 'codex');
                const created = await server.createRoom('tiny-room', {displayName: 'claude', kind: 'agent'}, {...DEFAULT_ROOM_POLICY, maxRetainedEvents: 4});
                alice.participantId = created.participantId;
                alice.credential = created.participantCredential;
                await bob.join(created.inviteCode);
                // participant.joined x2 already counted; two more ordinary writes reach the cap.
                await alice.say('one');
                await alice.say('two');
                await expectError('quota_exceeded', () => alice.say('three'));

                // Control, revocation, and closure stay usable at quota.
                await server.control(created.controllerCredential, bob.participantId, true);
                await bob.poll();
                expect((await server.snapshot(created.controllerCredential)).participants.find((participant) => participant.participantId === bob.participantId)!.paused).toBe(
                    true
                );
                await server.revoke(created.controllerCredential, bob.participantId);
                await server.close(created.controllerCredential);
                expect((await server.read(created.controllerCredential, 0)).events.some((event) => event.type === 'room.closed')).toBe(true);
            });

            test('test_a_cursor_older_than_retained_history_returns_a_gap', async () => {
                const server = track(new RoomHarness(makeStore()));
                const alice = new FakeAgent(server, 'claude');
                await alice.create('gap-room');
                for (let index = 0; index < 5; index += 1) await alice.say(`message ${index}`);
                server.dropHistoryBefore(4);
                const error = await expectError('cursor_gap', () => server.read(alice.credential, 1));
                expect(error.details.earliestAvailableSeq).toBe(4);
                const fresh = await server.read(alice.credential, 4);
                expect(fresh.events.length).toBeGreaterThan(0);
            });
        });
    });
}

//! Rooms that close themselves, run against every store adapter. Time is a test
//! clock, so deadline boundaries are exact rather than racing a real timer.

import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {ProtocolError, newCredential, newId} from '@pairlobby/protocol';
import type {AutoClosePolicy, ParticipantKind, ParticipantRole, RoomEvent} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';

import type {StoreFactory} from './contract.js';
import {fixedClock} from './harness.js';
import type {Clock, TestableRoomStore} from './harness.js';

type Member = {id: string; credential: string};

const MINUTE = 60_000;

export function runAutoCloseContract(label: string, makeStore: StoreFactory): void {
    describe(`${label} / auto-close`, () => {
        let store: TestableRoomStore;
        let clock: Clock;
        let service: RoomService;
        let roomId: string;
        let owner: string;
        let human: Member;

        async function join(kind: ParticipantKind, role: ParticipantRole = 'member'): Promise<Member> {
            const invite = await service.mintInvite(roomId, owner, role);
            const credential = newCredential('participant');
            const result = await service.redeemInvite({code: invite.code, displayName: `${kind}-${newId('attempt').slice(-4)}`, kind, participantCredential: credential, attemptId: newId('attempt')});
            return {id: result.participantId, credential};
        }

        async function say(member: Member, text = 'hello'): Promise<RoomEvent> {
            return (await service.send(roomId, member.credential, {type: 'message', payload: {text, priority: 'normal'}, idempotencyKey: newId('event')})).event;
        }

        async function lifecycle(): Promise<string> {
            return (await service.export(roomId, owner)).room.lifecycle;
        }

        async function setPolicy(policy: AutoClosePolicy): Promise<void> {
            await service.setAutoClose(roomId, owner, policy);
        }

        async function closedEvents(): Promise<RoomEvent[]> {
            return (await service.read(roomId, owner, 0, 500)).events.filter((event) => event.type === 'room.closed');
        }

        beforeEach(async () => {
            store = makeStore();
            clock = fixedClock();
            service = new RoomService(store, () => clock.now());
            owner = newCredential('controller');
            const participant = newCredential('participant');
            const created = await service.createRoom({name: 'auto-close', displayName: 'owner', kind: 'human', controllerCredential: owner, participantCredential: participant});
            roomId = created.roomId;
            human = {id: created.participantId, credential: participant};
        });

        afterEach(() => store.close?.());

        test('test_off_by_default_and_never_closes', async () => {
            const snapshot = await service.snapshot(roomId, owner);
            expect(snapshot.autoCloseSupported).toBe(true);
            expect(snapshot.policy.autoClose ?? {mode: 'off'}).toEqual({mode: 'off'});
            expect(snapshot.autoCloseAt).toBeNull();
            clock.advance(365 * 24 * 60 * MINUTE);
            expect((await service.closeDueRooms()).closed).toBe(0);
            expect(await lifecycle()).toBe('open');
        });

        test('test_only_the_owner_or_an_admin_changes_the_policy_and_history_records_it', async () => {
            await expectCode('unauthorized', () => service.setAutoClose(roomId, human.credential, {mode: 'age', afterMs: MINUTE}));
            await setPolicy({mode: 'age', afterMs: 60 * MINUTE});
            await expectCode('invalid_request', () => setPolicy({mode: 'age', afterMs: 60 * MINUTE}));
            const changed = (await service.read(roomId, owner, 0, 500)).events.find((event) => event.type === 'room.auto_close_changed');
            expect(changed?.type === 'room.auto_close_changed' && changed.payload).toEqual({autoClose: {mode: 'age', afterMs: 60 * MINUTE}, previous: {mode: 'off'}});
        });

        test('test_inactivity_counts_from_creation_until_the_first_message_and_closes_exactly_at_the_deadline', async () => {
            await setPolicy({mode: 'inactivity', afterMs: 10 * MINUTE});
            const created = (await service.snapshot(roomId, owner)).createdAt;
            expect((await service.snapshot(roomId, owner)).autoCloseAt).toBe(created + 10 * MINUTE);
            clock.advance(10 * MINUTE - 1);
            expect(await lifecycle()).toBe('open');
            clock.advance(1);
            expect((await service.closeDueRooms()).closed).toBe(1);
            const room = await service.export(roomId, owner);
            expect(room.room).toMatchObject({lifecycle: 'closed', closeReason: 'inactivity', autoCloseAt: null});
            const [closed] = await closedEvents();
            expect(closed?.type === 'room.closed' && closed.payload.reason).toBe('inactivity');
        });

        test('test_messages_and_replies_reset_inactivity_but_other_events_do_not', async () => {
            await setPolicy({mode: 'inactivity', afterMs: 10 * MINUTE});
            const agent = await join('agent');
            clock.advance(8 * MINUTE);
            const sent = await say(human);
            expect((await service.snapshot(roomId, owner)).autoCloseAt).toBe(sent.at + 10 * MINUTE);
            clock.advance(5 * MINUTE);
            // Receipts, renames, locks and joins are not discussion and must not keep the room open.
            await service.acknowledgeMessage(roomId, agent.credential, sent.eventId).catch(() => null);
            await service.rename(roomId, owner, 'still quiet');
            await service.setLocked(roomId, owner, true);
            await service.setLocked(roomId, owner, false);
            await join('human');
            expect((await service.snapshot(roomId, owner)).autoCloseAt).toBe(sent.at + 10 * MINUTE);
            clock.advance(5 * MINUTE);
            expect((await service.closeDueRooms()).closed).toBe(1);
            expect(await lifecycle()).toBe('closed');
        });

        test('test_a_request_after_the_deadline_finds_the_room_already_closed', async () => {
            await setPolicy({mode: 'inactivity', afterMs: MINUTE});
            clock.advance(MINUTE);
            // No scheduler ran: the next request itself enforces the deadline before acting.
            await expectCode('room_closed', () => say(human, 'too late'));
            expect(await closedEvents()).toHaveLength(1);
        });

        test('test_age_ignores_activity', async () => {
            await setPolicy({mode: 'age', afterMs: 30 * MINUTE});
            for (let index = 0; index < 5; index++) {
                clock.advance(5 * MINUTE);
                await say(human);
            }
            clock.advance(5 * MINUTE);
            await expectCode('room_closed', () => say(human));
            expect((await service.export(roomId, owner)).room.closeReason).toBe('age');
        });

        test('test_enabling_an_overdue_policy_closes_immediately', async () => {
            clock.advance(2 * 60 * MINUTE);
            await setPolicy({mode: 'age', afterMs: 60 * MINUTE});
            expect(await lifecycle()).toBe('closed');
            expect(await closedEvents()).toHaveLength(1);
        });

        test('test_a_policy_change_moves_the_deadline_so_an_old_wake_up_does_nothing', async () => {
            await setPolicy({mode: 'inactivity', afterMs: 10 * MINUTE});
            clock.advance(9 * MINUTE);
            await setPolicy({mode: 'inactivity', afterMs: 60 * MINUTE});
            clock.advance(2 * MINUTE);
            expect((await service.closeDueRooms()).closed).toBe(0);
            await setPolicy({mode: 'off'});
            clock.advance(24 * 60 * MINUTE);
            expect((await service.closeDueRooms()).closed).toBe(0);
            expect(await lifecycle()).toBe('open');
        });

        test('test_departure_does_not_close_before_an_agent_or_guest_has_joined', async () => {
            await setPolicy({mode: 'agents_and_guests_left'});
            clock.advance(24 * 60 * MINUTE);
            expect((await service.closeDueRooms()).closed).toBe(0);
            expect((await service.snapshot(roomId, owner)).autoCloseArmed).toBe(false);
        });

        test('test_departure_closes_when_the_last_agent_or_guest_leaves_and_humans_may_stay', async () => {
            await setPolicy({mode: 'agents_and_guests_left'});
            const agent = await join('agent');
            const guest = await join('human', 'guest');
            await join('human');
            expect((await service.snapshot(roomId, owner)).autoCloseArmed).toBe(true);
            await service.leave(roomId, agent.credential);
            expect(await lifecycle()).toBe('open');
            await service.revoke(roomId, owner, guest.id);
            // The departure and its deadline commit together, so the close cannot be lost.
            expect((await service.closeDueRooms()).closed).toBe(1);
            expect((await service.export(roomId, owner)).room.closeReason).toBe('agents_and_guests_left');
        });

        test('test_departure_waits_for_the_last_agent_and_then_refuses_a_rejoin', async () => {
            const first = await join('agent');
            const second = await join('agent');
            await setPolicy({mode: 'agents_and_guests_left'});
            await service.leave(roomId, first.credential);
            expect((await service.snapshot(roomId, owner)).autoCloseAt).toBeNull();
            await service.rejoin(roomId, first.credential);
            await service.leave(roomId, second.credential);
            await service.leave(roomId, first.credential);
            // The close happens with the last departure, so there is no window to rejoin into.
            await expectCode('room_closed', () => service.rejoin(roomId, second.credential));
            expect(await closedEvents()).toHaveLength(1);
        });

        test('test_pause_does_not_count_as_leaving', async () => {
            const agent = await join('agent');
            await setPolicy({mode: 'agents_and_guests_left'});
            await service.control(roomId, owner, agent.id, true);
            expect((await service.closeDueRooms()).closed).toBe(0);
            expect(await lifecycle()).toBe('open');
        });

        test('test_manual_close_and_a_timer_produce_one_close_with_the_manual_reason', async () => {
            await setPolicy({mode: 'inactivity', afterMs: MINUTE});
            await service.close(roomId, owner);
            clock.advance(MINUTE);
            expect((await service.closeDueRooms()).closed).toBe(0);
            const closed = await closedEvents();
            expect(closed).toHaveLength(1);
            expect(closed[0]?.type === 'room.closed' && closed[0].payload.reason).toBe('manual');
        });

        test('test_an_expired_room_is_left_to_expiry', async () => {
            await service.setExpiry(roomId, owner, clock.now() + MINUTE);
            await setPolicy({mode: 'inactivity', afterMs: 5 * MINUTE});
            clock.advance(10 * MINUTE);
            expect((await service.closeDueRooms()).closed).toBe(0);
            await expectCode('room_expired', () => say(human));
        });

        test('test_the_sweep_reports_the_next_deadline_and_closing_keeps_history', async () => {
            await setPolicy({mode: 'inactivity', afterMs: 10 * MINUTE});
            await say(human, 'keep this');
            expect((await service.closeDueRooms()).nextAt).toBe(clock.now() + 10 * MINUTE);
            clock.advance(10 * MINUTE);
            const sweep = await service.closeDueRooms();
            expect(sweep).toMatchObject({closed: 1, more: false, nextAt: null});
            const history = await service.export(roomId, owner);
            expect(history.events.some((event) => event.type === 'message' && event.payload.text === 'keep this')).toBe(true);
        });
    });
}

async function expectCode(code: string, run: () => Promise<unknown>): Promise<void> {
    try {
        await run();
    } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        expect((error as ProtocolError).code).toBe(code);
        return;
    }
    throw new Error(`expected ${code}`);
}

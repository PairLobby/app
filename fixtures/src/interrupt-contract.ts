//! Interrupting one agent, run against every store adapter: its running turn is
//! fenced, its queued work is held, everyone else carries on, and only what its
//! receiver actually stopped is reported.

import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {ProtocolError, newCredential, newId} from '@pairlobby/protocol';
import type {ControlOutcome, MessageRequest, ParticipantView} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';

import type {StoreFactory} from './contract.js';
import {fixedClock} from './harness.js';
import type {Clock, TestableRoomStore} from './harness.js';

type Agent = {id: string; credential: string};

export function runInterruptContract(label: string, makeStore: StoreFactory): void {
    describe(`${label} / interrupt`, () => {
        let store: TestableRoomStore;
        let clock: Clock;
        let service: RoomService;
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
            const created = await service.createRoom({name: 'interrupt', displayName: 'owner', kind: 'human', participantCredential: owner, controllerCredential: controller});
            roomId = created.roomId;
            ownerId = created.participantId;
            codex = await join('codex');
            claude = await join('claude');
            await service.turns.mode(roomId, controller, 'parallel');
        });

        afterEach(() => store.close?.());

        async function join(name: string, kind: 'agent' | 'human' = 'agent'): Promise<Agent> {
            clock.advance(1);
            const invite = await service.mintInvite(roomId, controller, 'member');
            const credential = newCredential('participant');
            const joined = await service.redeemInvite({code: invite.code, displayName: name, kind, participantCredential: credential, attemptId: newId('attempt')});
            return {id: joined.participantId, credential};
        }

        async function ask(ids: string[]): Promise<MessageRequest[]> {
            const sent = await service.send(roomId, owner, {type: 'message', recipientIds: ids, payload: {text: 'Work on this', priority: 'normal'}, idempotencyKey: newId('event')});
            return store.groupRequests(roomId, sent.event.eventId);
        }

        async function start(agent: Agent, request: MessageRequest): Promise<string> {
            const grant = await service.turns.claim(roomId, agent.credential, request.eventId, newId('event'));
            expect(grant.state).toBe('granted');
            await service.acknowledgeMessage(roomId, agent.credential, request.eventId);
            return grant.token!;
        }

        async function answer(agent: Agent, request: MessageRequest, token: string): Promise<void> {
            await service.send(roomId, agent.credential, {type: 'message', recipientId: ownerId, replyTo: request.eventId, turnToken: token, payload: {text: 'done', priority: 'normal'}, idempotencyKey: newId('event')});
        }

        async function acknowledge(agent: Agent, revision: number, outcome: ControlOutcome): Promise<void> {
            await service.send(roomId, agent.credential, {type: 'control.ack', payload: {targetParticipantId: agent.id, revision, outcome}, idempotencyKey: newId('event')});
        }

        async function member(id: string): Promise<ParticipantView> {
            return (await service.snapshot(roomId, controller)).participants.find((participant) => participant.participantId === id)!;
        }

        test('test_only_an_owner_or_admin_can_interrupt_and_only_an_agent', async () => {
            expect((await service.snapshot(roomId, controller)).interruptSupported).toBe(true);
            await expectCode('unauthorized', () => service.interrupt(roomId, owner, codex.id));
            await expectCode('unauthorized', () => service.interrupt(roomId, claude.credential, codex.id));
            const human = await join('reviewer', 'human');
            await expectCode('invalid_request', () => service.interrupt(roomId, controller, human.id));
        });

        test('test_interrupting_a_running_turn_fences_its_late_reply_and_leaves_the_other_agent_working', async () => {
            const [forCodex, forClaude] = await ask([codex.id, claude.id]);
            const codexToken = await start(codex, forCodex!);
            const claudeToken = await start(claude, forClaude!);
            const result = await service.interrupt(roomId, controller, codex.id);
            expect(result.fenced).toEqual([forCodex!.eventId]);
            expect(result.event.type === 'control.pause' && result.event.payload).toMatchObject({targetParticipantId: codex.id, interrupt: true});
            expect(await member(codex.id)).toMatchObject({paused: true, interruptRequested: true});
            await expectCode('turn_required', () => answer(codex, forCodex!, codexToken));
            expect(await service.request(roomId, controller, forCodex!.eventId)).toMatchObject({requiresReply: false, turnStatus: 'skipped'});
            await answer(claude, forClaude!, claudeToken);
            expect((await service.request(roomId, controller, forClaude!.eventId)).turnStatus).toBe('answered');
        });

        test('test_queued_work_is_held_until_resume', async () => {
            const [first] = await ask([codex.id]);
            await start(codex, first!);
            const [queued] = await ask([codex.id]);
            const result = await service.interrupt(roomId, controller, codex.id);
            expect(result.fenced).toEqual([first!.eventId]);
            const pending = (await service.requests(roomId, codex.credential, 0, 100, codex.id)).requests.map((request) => request.eventId);
            expect(pending).toEqual([queued!.eventId]);
            expect((await member(codex.id)).paused).toBe(true);
            await service.control(roomId, controller, codex.id, false);
            expect(await member(codex.id)).toMatchObject({paused: false, interruptRequested: false});
            const token = await start(codex, queued!);
            await answer(codex, queued!, token);
        });

        test('test_interrupting_between_turns_fences_nothing', async () => {
            const result = await service.interrupt(roomId, controller, codex.id);
            expect(result.fenced).toEqual([]);
            expect((await member(codex.id)).interruptRequested).toBe(true);
        });

        test('test_an_answer_that_lands_first_stands', async () => {
            const [request] = await ask([codex.id]);
            const token = await start(codex, request!);
            await answer(codex, request!, token);
            const result = await service.interrupt(roomId, controller, codex.id);
            expect(result.fenced).toEqual([]);
            expect((await service.request(roomId, controller, request!.eventId)).turnStatus).toBe('answered');
        });

        test('test_the_receiver_reports_what_it_stopped_and_a_late_report_cannot_overwrite_a_resume', async () => {
            const [request] = await ask([codex.id]);
            await start(codex, request!);
            const interrupted = await service.interrupt(roomId, controller, codex.id);
            const revision = interrupted.event.type === 'control.pause' ? interrupted.event.payload.revision : 0;
            expect(await member(codex.id)).toMatchObject({controlRevision: revision, acknowledgedRevision: 0});
            await acknowledge(codex, revision, 'tool_cancellation_unknown');
            expect(await member(codex.id)).toMatchObject({acknowledgedRevision: revision, acknowledgedOutcome: 'tool_cancellation_unknown'});
            await service.control(roomId, controller, codex.id, false);
            await acknowledge(codex, revision, 'current_turn_cancelled');
            const after = await member(codex.id);
            expect(after.paused).toBe(false);
            expect(after.acknowledgedOutcome).toBe('tool_cancellation_unknown');
        });

        test('test_interrupting_one_of_two_same_named_agents_targets_the_participant_id', async () => {
            const twin = await join('codex');
            const [forTwin, forCodex] = await ask([twin.id, codex.id]);
            await start(twin, forTwin!);
            const codexToken = await start(codex, forCodex!);
            await service.interrupt(roomId, controller, twin.id);
            await answer(codex, forCodex!, codexToken);
            expect((await member(codex.id)).paused).toBe(false);
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

import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {DEFAULT_ROOM_POLICY, newCredential, newId} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {CreatedRoom} from '@pairlobby/server-core';
import type {StoreFactory} from './contract.js';
import {fixedClock} from './harness.js';
import type {Clock, TestableRoomStore} from './harness.js';

export function runRejoinContract(label: string, makeStore: StoreFactory): void {
    describe(`${label} / saved-session rejoin`, () => {
        let store: TestableRoomStore;
        let clock: Clock;
        let service: RoomService;
        let room: CreatedRoom;
        let owner: string;
        let controller: string;

        beforeEach(async () => {
            store = makeStore();
            clock = fixedClock();
            service = new RoomService(store, clock.now);
            owner = newCredential('participant');
            controller = newCredential('controller');
            room = await service.createRoom({name: 'rejoin', displayName: 'owner', kind: 'human', participantCredential: owner, controllerCredential: controller, policy: {...DEFAULT_ROOM_POLICY, maxParticipants: 2}});
        });
        afterEach(() => store.close?.());

        test('restores the same owner identity and makes retries harmless', async () => {
            await service.leave(room.roomId, owner);
            const snapshot = await service.rejoin(room.roomId, owner);
            expect(snapshot.participants).toHaveLength(1);
            expect(snapshot.participants[0]).toMatchObject({participantId: room.participantId, displayName: 'owner', kind: 'human', role: 'member', left: false});
            expect((await service.rejoin(room.roomId, owner)).latestSeq).toBe(snapshot.latestSeq);
            await service.send(room.roomId, owner, {type: 'message', payload: {text: 'back again', priority: 'normal'}, idempotencyKey: newId('event')});
            await expect(service.rejoin(room.roomId, controller)).rejects.toMatchObject({code: 'unauthorized'});
            await expect(service.rejoin(room.roomId, 'unknown')).rejects.toMatchObject({code: 'unauthorized'});
        });

        test('preserves guest permissions and agent session, mute and pause state', async () => {
            const memberCredential = newCredential('participant');
            const sessionId = newId('session');
            const member = await service.redeemInvite({code: room.invite.code, displayName: 'agent', kind: 'agent', sessionId, participantCredential: memberCredential, attemptId: newId('attempt')});
            await service.setMuted(room.roomId, controller, member.participantId, true);
            await service.control(room.roomId, controller, member.participantId, true);
            await service.leave(room.roomId, memberCredential);
            const snapshot = await service.rejoin(room.roomId, memberCredential);
            expect(snapshot.participants.find((participant) => participant.participantId === member.participantId)).toMatchObject({left: false, muted: true, paused: true, role: 'member'});
            expect((await store.loadRoom(room.roomId))!.participants.find((participant) => participant.participantId === member.participantId)!.sessionId).toBe(sessionId);
            await service.leave(room.roomId, memberCredential);
            const invitation = await service.mintInvite(room.roomId, controller, 'guest');
            const guestCredential = newCredential('participant');
            const guest = await service.redeemInvite({code: invitation.code, displayName: 'observer', kind: 'human', participantCredential: guestCredential, attemptId: newId('attempt')});
            await service.leave(room.roomId, guestCredential);
            expect((await service.rejoin(room.roomId, guestCredential)).participants.find((participant) => participant.participantId === guest.participantId)).toMatchObject({left: false, role: 'guest'});
            await expect(service.send(room.roomId, guestCredential, {type: 'message', payload: {text: 'forbidden', priority: 'normal'}, idempotencyKey: newId('event')})).rejects.toMatchObject({code: 'unauthorized'});
        });

        test('a saved credential does not bypass room locks, capacity or revocation', async () => {
            const memberCredential = newCredential('participant');
            const member = await service.redeemInvite({code: room.invite.code, displayName: 'member', kind: 'human', participantCredential: memberCredential, attemptId: newId('attempt')});
            await service.leave(room.roomId, memberCredential);
            await service.setLocked(room.roomId, controller, true);
            await expect(service.rejoin(room.roomId, memberCredential)).rejects.toMatchObject({code: 'room_locked'});
            await service.setLocked(room.roomId, controller, false);
            const invitation = await service.mintInvite(room.roomId, controller, 'member');
            await service.redeemInvite({code: invitation.code, displayName: 'another', kind: 'human', participantCredential: newCredential('participant'), attemptId: newId('attempt')});
            await expect(service.rejoin(room.roomId, memberCredential)).rejects.toMatchObject({code: 'participant_limit_reached'});
            await service.revoke(room.roomId, controller, member.participantId);
            await expect(service.rejoin(room.roomId, memberCredential)).rejects.toMatchObject({code: 'participant_revoked'});
        });

        test('closed and expired rooms cannot be rejoined', async () => {
            await service.leave(room.roomId, owner);
            await service.setExpiry(room.roomId, controller, clock.now() + 1000);
            await service.close(room.roomId, controller);
            await expect(service.rejoin(room.roomId, owner)).rejects.toMatchObject({code: 'room_closed'});
            clock.advance(1001);
            await expect(service.rejoin(room.roomId, owner)).rejects.toMatchObject({code: 'room_expired'});
        });

        test('self rename preserves identity, controls and existing requests across rejoin', async () => {
            const credential = newCredential('participant');
            const sessionId = newId('session');
            const agent = await service.redeemInvite({code: room.invite.code, displayName: 'agent', kind: 'agent', sessionId, participantCredential: credential, attemptId: newId('attempt')});
            const request = await service.send(room.roomId, owner, {type: 'message', recipientId: agent.participantId, payload: {text: 'hello', priority: 'normal'}, idempotencyKey: newId('event')});
            await service.control(room.roomId, controller, agent.participantId, true);
            const before = (await store.loadRoom(room.roomId))!.participants.find((participant) => participant.participantId === agent.participantId)!;
            const snapshot = await service.renameSelf(room.roomId, credential, {name: 'Review Agent', source: 'room'});
            expect(snapshot.participants.find((participant) => participant.participantId === agent.participantId)).toMatchObject({displayName: 'Review Agent', nameSource: 'room', kind: 'agent', role: 'member', paused: true});
            const after = (await store.loadRoom(room.roomId))!.participants.find((participant) => participant.participantId === agent.participantId)!;
            expect(after).toEqual({...before, displayName: 'Review Agent', nameSource: 'room'});
            expect((await service.request(room.roomId, owner, request.event.eventId)).to).toBe(agent.participantId);
            const events = (await service.read(room.roomId, owner, 0, 100)).events;
            expect(events.at(-1)).toMatchObject({type: 'participant.renamed', senderId: agent.participantId, payload: {previousName: 'agent', name: 'Review Agent'}});
            await service.leave(room.roomId, credential);
            expect((await service.rejoin(room.roomId, credential)).participants.find((participant) => participant.participantId === agent.participantId)).toMatchObject({displayName: 'Review Agent', nameSource: 'room'});
        });

        test('profile names follow the default until a room name is explicitly chosen', async () => {
            await service.renameSelf(room.roomId, owner, {name: 'New default', source: 'profile'});
            const renamed = await service.renameSelf(room.roomId, owner, {name: 'New default', source: 'room'});
            const repeated = await service.renameSelf(room.roomId, owner, {name: 'New default', source: 'room'});
            expect(repeated.latestSeq).toBe(renamed.latestSeq);
            const later = await service.renameSelf(room.roomId, owner, {name: 'Later default', source: 'profile'});
            expect(later.latestSeq).toBe(renamed.latestSeq);
            expect(later.participants[0]).toMatchObject({displayName: 'New default', nameSource: 'room'});
        });

        test('self rename cannot bypass controller, guest, mute or revoked restrictions', async () => {
            const input = {name: 'new', source: 'room' as const};
            await expect(service.renameSelf(room.roomId, controller, input)).rejects.toMatchObject({code: 'unauthorized'});
            const invite = await service.mintInvite(room.roomId, controller, 'guest');
            const guestCredential = newCredential('participant');
            const guest = await service.redeemInvite({code: invite.code, displayName: 'observer', kind: 'human', participantCredential: guestCredential, attemptId: newId('attempt')});
            await expect(service.renameSelf(room.roomId, guestCredential, input)).rejects.toMatchObject({code: 'unauthorized'});
            await service.revoke(room.roomId, controller, guest.participantId);
            await expect(service.renameSelf(room.roomId, guestCredential, input)).rejects.toMatchObject({code: 'participant_revoked'});
            await service.setMuted(room.roomId, controller, room.participantId, true);
            await expect(service.renameSelf(room.roomId, owner, input)).rejects.toMatchObject({code: 'participant_muted'});
        });

        test('invalid names cannot enter the transcript or change a membership', async () => {
            for (const name of ['', '   ', 'x'.repeat(65), 'All', 'hello\nworld', 'bad\u001b[2J']) {
                await expect(service.renameSelf(room.roomId, owner, {name, source: 'room'})).rejects.toMatchObject({code: 'invalid_request'});
            }
            expect((await service.snapshot(room.roomId, owner)).participants[0]!.displayName).toBe('owner');
        });
    });
}

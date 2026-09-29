import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {newCredential, newId} from '@pairlobby/protocol';
import type {ParticipantRole} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {StoreFactory} from './contract.js';
import type {TestableRoomStore} from './harness.js';

type Member = {id: string; credential: string; code: string; attemptId: string};
export function runAdminContract(label: string, makeStore: StoreFactory): void {
    describe(`${label} / room admins`, () => {
        let store: TestableRoomStore;
        let service: RoomService;
        let roomId: string;
        let owner: string;
        let member: Member;
        async function join(role: ParticipantRole = 'member'): Promise<Member> {
            const invite = await service.mintInvite(roomId, owner, role);
            const credential = newCredential('participant');
            const attemptId = newId('attempt');
            const result = await service.redeemInvite({code: invite.code, displayName: 'member', kind: 'human', participantCredential: credential, attemptId});
            return {id: result.participantId, credential, code: invite.code, attemptId};
        }
        beforeEach(async () => {
            store = makeStore();
            service = new RoomService(store);
            owner = newCredential('controller');
            roomId = (await service.createRoom({name: 'settings', displayName: 'owner', kind: 'human', controllerCredential: owner, participantCredential: newCredential('participant')})).roomId;
            member = await join();
        });
        afterEach(() => store.close?.());

        test('only owners/admins can grant roles and all changes use the target membership', async () => {
            await expect(service.setRole(roomId, member.credential, member.id, 'controller')).rejects.toMatchObject({code: 'unauthorized'});
            await service.setRole(roomId, owner, member.id, 'controller');
            await service.setLocked(roomId, member.credential, true);
            expect((await service.snapshot(roomId, owner)).locked).toBe(true);
            await service.setLocked(roomId, owner, false);
            const guest = await join('guest');
            await expect(service.setRole(roomId, owner, guest.id, 'controller')).rejects.toMatchObject({code: 'invalid_request'});
            const event = (await service.read(roomId, owner, 0, 100)).events.find((item) => item.type === 'participant.role_changed');
            expect(event?.payload).toMatchObject({participantId: member.id, previousRole: 'member', role: 'controller'});
            expect(JSON.stringify(await service.snapshot(roomId, owner))).not.toContain(owner);
        });

        test('self-demotion requires another admin; muted/left admins cannot keep controlling the room', async () => {
            await service.setRole(roomId, owner, member.id, 'controller');
            await expect(service.setRole(roomId, member.credential, member.id, 'member')).rejects.toMatchObject({code: 'invalid_request'});
            const second = await join();
            await service.setRole(roomId, member.credential, second.id, 'controller');
            await service.setRole(roomId, member.credential, member.id, 'member');
            await expect(service.setLocked(roomId, member.credential, true)).rejects.toMatchObject({code: 'unauthorized'});
            await service.setMuted(roomId, owner, second.id, true);
            await expect(service.setLocked(roomId, second.credential, true)).rejects.toMatchObject({code: 'participant_muted'});
            await service.setMuted(roomId, owner, second.id, false);
            await service.leave(roomId, second.credential);
            await expect(service.setLocked(roomId, second.credential, true)).rejects.toMatchObject({code: 'participant_revoked'});
        });

        test('demotion survives retries, service restart and reuse of an old admin invite', async () => {
            const admin = await join('controller');
            await service.setRole(roomId, owner, admin.id, 'member');
            service = new RoomService(store);
            const retry = await service.redeemInvite({code: admin.code, displayName: 'retry', kind: 'human', participantCredential: admin.credential, attemptId: admin.attemptId});
            expect(retry.role).toBe('member');
            await service.leave(roomId, admin.credential);
            const replacement = await service.redeemInvite({code: admin.code, displayName: 'replacement', kind: 'human', participantCredential: newCredential('participant'), attemptId: newId('attempt')});
            expect(replacement.role).toBe('member');
        });
    });
}

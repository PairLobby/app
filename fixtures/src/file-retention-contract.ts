import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {newCredential, newId} from '@pairlobby/protocol';
import type {Attachment, FileRetentionRequest, ParticipantKind} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';

import type {StoreFactory} from './contract.js';
import type {TestableRoomStore} from './harness.js';

type Member = {id: string; credential: string};

export function runFileRetentionContract(label: string, makeStore: StoreFactory): void {
    describe(`${label} / file retention`, () => {
        let store: TestableRoomStore;
        let service: RoomService;
        let now: number;
        let roomId: string;
        let owner: Member;
        let controller: string;
        let agent: Member;

        async function join(kind: ParticipantKind = 'human', role: 'member' | 'guest' = 'member'): Promise<Member> {
            const invite = await service.mintInvite(roomId, controller, role);
            const credential = newCredential('participant');
            const result = await service.redeemInvite({code: invite.code, participantCredential: credential, attemptId: newId('attempt'), displayName: kind, kind});
            return {id: result.participantId, credential};
        }

        async function upload(retention?: FileRetentionRequest): Promise<Attachment> {
            return service.uploadFile(roomId, owner.credential, {name: 'sample.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('verified file'), ...(retention ? {retention} : {})});
        }

        async function send(file: Attachment, key = newId('event')) {
            return service.send(roomId, owner.credential, {type: 'message', payload: {text: 'file', priority: 'normal', attachments: [file]}, idempotencyKey: key});
        }

        beforeEach(async () => {
            store = makeStore();
            now = 1_800_000_000_000;
            service = new RoomService(store, () => now);
            controller = newCredential('controller');
            const credential = newCredential('participant');
            const created = await service.createRoom({name: 'retention', displayName: 'sender', kind: 'human', participantCredential: credential, controllerCredential: controller});
            roomId = created.roomId;
            owner = {id: created.participantId, credential};
            agent = await join('agent');
        });
        afterEach(() => store.close?.());

        test('forever is the default and plain message receipts never delete a file', async () => {
            const file = await upload();
            const sent = await send(file);
            await service.receipt(roomId, agent.credential, sent.event.seq);
            now += 400 * 86400_000;
            expect(await service.expireFiles()).toMatchObject({removed: 0, nextAt: null});
            expect((await service.downloadFile(roomId, agent.credential, file.fileId)).bytes.byteLength).toBe(file.size);
        });

        test('all original recipients confirm independently; seeing or downloading alone is insufficient', async () => {
            const human = await join();
            const file = await upload({mode: 'until-received'});
            const key = newId('event');
            const sent = await send(file, key);
            const late = await join();
            const listed = (await service.listFiles(roomId, owner.credential)).files[0]!;
            expect(listed.receiptRecipients?.sort()).toEqual([agent.id, human.id].sort());
            await service.receipt(roomId, human.credential, sent.event.seq);
            await service.downloadFile(roomId, agent.credential, file.fileId);
            expect(await store.files!.usedBytes(roomId)).toBe(file.size);
            await expect(service.confirmFileReceipt(roomId, agent.credential, file.fileId, {sha256: '0'.repeat(64), size: file.size})).rejects.toThrow('SHA-256');
            expect(await service.confirmFileReceipt(roomId, owner.credential, file.fileId, file)).toMatchObject({remaining: 2, available: true});
            expect(await service.confirmFileReceipt(roomId, late.credential, file.fileId, file)).toMatchObject({remaining: 2, available: true});
            expect(await service.confirmFileReceipt(roomId, agent.credential, file.fileId, file)).toMatchObject({remaining: 1, available: true});
            const revision = (await store.roomHead(roomId))!.room.stateRevision;
            expect(await service.confirmFileReceipt(roomId, agent.credential, file.fileId, file)).toMatchObject({remaining: 1});
            expect((await store.roomHead(roomId))!.room.stateRevision).toBe(revision);
            // A process restart must retain the pending human receipt.
            service = new RoomService(store, () => now);
            expect(await service.confirmFileReceipt(roomId, human.credential, file.fileId, file)).toMatchObject({remaining: 0, available: false});
            expect(await store.files!.usedBytes(roomId)).toBe(0);
            expect(await store.files!.fileBytes(roomId, file.fileId)).toBeNull();
            expect(await service.confirmFileReceipt(roomId, human.credential, file.fileId, file)).toMatchObject({available: false});
            expect((await send(file, key)).deduplicated).toBe(true);
            await expect(service.downloadFile(roomId, human.credential, file.fileId)).rejects.toThrow('no such file');
        });

        test('concurrent confirmations cannot lose a recipient or delete another file', async () => {
            const human = await join();
            const file = await upload({mode: 'until-received'});
            const kept = await upload({mode: 'forever'});
            await send(file);
            await send(kept);
            await Promise.all([agent, human].map((member) => service.confirmFileReceipt(roomId, member.credential, file.fileId, file)));
            expect(await store.files!.file(roomId, file.fileId)).toBeNull();
            expect(await store.files!.usedBytes(roomId)).toBe(kept.size);
        });

        test('leaving the room is not a file receipt', async () => {
            const human = await join();
            const file = await upload({mode: 'until-received'});
            await send(file);
            await service.leave(roomId, human.credential);
            expect(await service.confirmFileReceipt(roomId, agent.credential, file.fileId, file)).toMatchObject({remaining: 1, available: true});
        });

        test('cannot confirm with a controller or an unrelated credential', async () => {
            const file = await upload({mode: 'until-received'});
            await send(file);
            await expect(service.confirmFileReceipt(roomId, controller, file.fileId, file)).rejects.toThrow();
            await expect(service.confirmFileReceipt(roomId, newCredential('participant'), file.fileId, file)).rejects.toThrow();
            expect(await store.files!.usedBytes(roomId)).toBe(file.size);
        });

        test('a named read-only guest counts and can confirm its own download', async () => {
            const guest = await join('human', 'guest');
            const file = await upload({mode: 'until-received'});
            await send(file);
            expect(await service.confirmFileReceipt(roomId, guest.credential, file.fileId, file)).toMatchObject({remaining: 1, available: true});
            expect(await service.confirmFileReceipt(roomId, agent.credential, file.fileId, file)).toMatchObject({available: false});
        });

        test('the uploader cannot replace the stored policy through message attachment metadata', async () => {
            const file = await upload({mode: 'until-received'});
            const sent = await send({...file, retention: {mode: 'forever'}});
            expect(sent.event.type === 'message' ? sent.event.payload.attachments : undefined).toEqual([file]);
            expect(await service.confirmFileReceipt(roomId, agent.credential, file.fileId, file)).toMatchObject({available: false});
        });

        test('temporary files expire at their original deadline, even in a closed room', async () => {
            const file = await upload({mode: 'temporary', ttlMs: 1000});
            await send(file);
            now += 999;
            expect((await service.downloadFile(roomId, agent.credential, file.fileId)).bytes.byteLength).toBe(file.size);
            expect(await service.confirmFileReceipt(roomId, agent.credential, file.fileId, file)).toMatchObject({available: true});
            await service.close(roomId, controller);
            now++;
            await expect(service.downloadFile(roomId, agent.credential, file.fileId)).rejects.toThrow('no such file');
            expect(await service.expireFiles()).toMatchObject({removed: 1, nextAt: null});
            expect(await store.files!.usedBytes(roomId)).toBe(0);
        });

        test('expired uploads cannot be sent and expiry advances in bounded batches', async () => {
            const files = await Promise.all([upload({mode: 'temporary', ttlMs: 1000}), upload({mode: 'temporary', ttlMs: 2000})]);
            expect(await service.nextFileExpiryAt()).toBe(now + 1000);
            now += 2000;
            await expect(send(files[0]!)).rejects.toThrow('expired');
            expect(await service.expireFiles(1)).toMatchObject({removed: 1, more: true, nextAt: now});
            expect(await service.expireFiles(1)).toMatchObject({removed: 1, nextAt: null});
            expect(await store.files!.usedBytes(roomId)).toBe(0);
        });

        test('a buffered adapter preserves the upload deadline instead of restarting its lifetime after buffering', async () => {
            const files = new Proxy(store.files!, {get(target, key) {
                return ['createUpload', 'writeChunk', 'completeUpload', 'cancelUpload'].includes(String(key)) ? undefined : Reflect.get(target, key);
            }});
            const buffered = new Proxy(store, {get(target, key) {
                if (key === 'files') {
                    return files;
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            }});
            const legacy = new RoomService(buffered, () => now);
            const started = now;
            const body = new ReadableStream<Uint8Array>({pull(controller) {
                now += 500;
                controller.enqueue(new TextEncoder().encode('hello'));
                controller.close();
            }}, {highWaterMark: 0});
            const file = await legacy.uploadFileStream(roomId, owner.credential, {name: 'buffered.txt', mediaType: 'text/plain', size: 5, body, retention: {mode: 'temporary', ttlMs: 1000}});
            expect(file.retention).toEqual({mode: 'temporary', expiresAt: started + 1000});
            const late = new ReadableStream<Uint8Array>({pull(controller) {
                now += 1100;
                controller.enqueue(new TextEncoder().encode('hello'));
                controller.close();
            }}, {highWaterMark: 0});
            await expect(legacy.uploadFileStream(roomId, owner.credential, {name: 'late.txt', mediaType: 'text/plain', size: 5, body: late, retention: {mode: 'temporary', ttlMs: 1000}})).rejects.toThrow('expired');
            expect(await store.files!.usedBytes(roomId)).toBe(file.size);
        });

        test('delete-on-receipt without another member is rejected before a message is committed', async () => {
            await service.leave(roomId, agent.credential);
            const file = await upload({mode: 'until-received'});
            const before = (await store.roomHead(roomId))!.room.nextSeq;
            await expect(send(file)).rejects.toThrow('another member');
            expect((await store.roomHead(roomId))!.room.nextSeq).toBe(before);
        });
    });
}

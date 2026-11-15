import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {DEFAULT_MAX_FILE_BYTES, DEFAULT_ROOM_POLICY, UNATTACHED_FILE_LIFETIME_MS, newCredential, newId} from '@pairlobby/protocol';
import type {Attachment, RoomPolicy} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {StoreFactory} from './contract.js';
import type {TestableRoomStore} from './harness.js';
import {runFileRetentionContract} from './file-retention-contract.js';

/** Bytes that are not text and cross several storage chunks: 1 MiB chunks are the smallest any store uses. */
function binary(size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        bytes[index] = (index * 7 + (index >> 10)) & 0xff;
    }
    return bytes;
}

/** For a store that keeps files: what every relay must do with them, whatever holds the bytes. */
export function runFileContract(label: string, makeStore: StoreFactory) {
    runFileRetentionContract(label, makeStore);
    describe(`${label} / files`, () => {
        let store: TestableRoomStore, service: RoomService, now: number, roomId: string, alice: string, bob: string, controller: string;
        const create = async (policy?: RoomPolicy) => {
            const room = await service.createRoom({name: 'files', displayName: 'alice', kind: 'human', participantCredential: alice, controllerCredential: controller, ...(policy ? {policy} : {})});
            roomId = room.roomId;
            await service.redeemInvite({code: room.invite.code, displayName: 'bob', kind: 'agent', participantCredential: bob, attemptId: newId('attempt')});
        };
        const upload = (name: string, bytes: Uint8Array, credential = alice) => service.uploadFile(roomId, credential, {name, mediaType: 'application/octet-stream', bytes});
        const sendWith = (attachments: Attachment[], credential = alice) => service.send(roomId, credential, {type: 'message', payload: {text: 'files', priority: 'normal', attachments}, idempotencyKey: newId('event')});
        beforeEach(async () => {
            store = makeStore();
            now = 1_800_000_000_000;
            service = new RoomService(store, () => now);
            alice = newCredential('participant');
            bob = newCredential('participant');
            controller = newCredential('controller');
            await create();
        });
        afterEach(() => store.close?.());

        test('the store keeps files and says so', async () => {
            expect(store.files).toBeDefined();
            expect((await service.snapshot(roomId, alice)).filesSupported).toBe(true);
        });

        test('file cleanup is restricted to its sender or an admin and keeps the conversation', async () => {
            const file = await upload('keep-the-message.txt', new TextEncoder().encode('payload'));
            const sent = await sendWith([file]);
            const before = await service.snapshot(roomId, alice);
            expect(before.fileDeletionSupported).toBe(true);
            await expect(service.deleteFile(roomId, bob, file.fileId)).rejects.toMatchObject({code: 'unauthorized'});
            expect((await service.downloadFile(roomId, alice, file.fileId)).bytes.byteLength).toBe(7);
            expect(await service.deleteFile(roomId, alice, file.fileId)).toEqual({fileId: file.fileId, removed: true, freedBytes: 7});
            expect(await service.deleteFile(roomId, alice, file.fileId)).toEqual({fileId: file.fileId, removed: false, freedBytes: 0});
            expect((await service.snapshot(roomId, alice)).latestSeq).toBe(before.latestSeq);
            const page = await service.read(roomId, alice, 0, 200);
            expect(page.events.find((event) => event.eventId === sent.event.eventId)?.payload).toMatchObject({text: 'files', attachments: [{fileId: file.fileId}]});
            expect((await service.listFiles(roomId, alice)).files).toEqual([]);
            expect(await store.files!.usedBytes(roomId)).toBe(0);
            await expect(service.downloadFile(roomId, bob, file.fileId)).rejects.toThrow('no such file');
        });

        test('an admin removes another sender\'s file and retrying its old ID cannot delete a new upload with the same name', async () => {
            const file = await upload('same-name.txt', new Uint8Array([1, 2, 3]), bob);
            await sendWith([file], bob);
            expect((await service.deleteFile(roomId, controller, file.fileId)).removed).toBe(true);
            const replacement = await upload('same-name.txt', new Uint8Array([4, 5, 6]), bob);
            await sendWith([replacement], bob);
            expect((await service.deleteFile(roomId, controller, file.fileId)).removed).toBe(false);
            expect((await service.downloadFile(roomId, alice, replacement.fileId)).bytes).toEqual(new Uint8Array([4, 5, 6]));
        });

        test('concurrent manual and final-receipt removal reclaim the bytes only once', async () => {
            const file = await service.uploadFile(roomId, alice, {name: 'receipt.txt', mediaType: 'text/plain', bytes: new Uint8Array([1, 2, 3]), retention: {mode: 'until-received'}});
            await sendWith([file]);
            const outcomes = await Promise.allSettled([
                service.deleteFile(roomId, alice, file.fileId),
                service.confirmFileReceipt(roomId, bob, file.fileId, {sha256: file.sha256, size: file.size})
            ]);
            expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
            expect(await store.files!.usedBytes(roomId)).toBe(0);
            expect(await store.files!.file(roomId, file.fileId)).toBeNull();
        });

        test('workspace-owner cleanup can reclaim expired files without granting read access', async () => {
            const file = await upload('old.txt', new Uint8Array([1, 2, 3]));
            await sendWith([file]);
            await service.close(roomId, controller);
            now += DEFAULT_ROOM_POLICY.exportWindowMs + 1;
            await expect(service.deleteFile(roomId, alice, file.fileId)).rejects.toMatchObject({code: 'room_expired'});
            expect(await service.deleteAuthorizedFile(roomId, file.fileId)).toEqual({fileId: file.fileId, removed: true, freedBytes: 3});
            expect(await store.files!.retention!.record!(roomId, file.fileId)).toBeNull();
        });

        test('an upload is the uploader\'s alone until a message carries it, then anyone in the room can list and fetch it', async () => {
            const file = await upload('notes.txt', new TextEncoder().encode('hello'));
            expect((await service.listFiles(roomId, alice)).files).toEqual([]);
            await expect(service.downloadFile(roomId, bob, file.fileId)).rejects.toThrow('no such file');
            expect((await service.downloadFile(roomId, alice, file.fileId)).bytes).toEqual(new TextEncoder().encode('hello'));

            const sent = await sendWith([file]);
            const listed = (await service.listFiles(roomId, bob)).files;
            expect(listed).toHaveLength(1);
            expect(listed[0]).toMatchObject({fileId: file.fileId, name: 'notes.txt', size: 5, eventId: sent.event.eventId});
            expect(new TextDecoder().decode((await service.downloadFile(roomId, bob, file.fileId)).bytes)).toBe('hello');
            await expect(sendWith([file])).rejects.toThrow('already sent');
        });

        test('a file larger than one storage chunk comes back byte for byte', async () => {
            const bytes = binary(3 * 1024 * 1024 + 17);
            const file = await upload('video.bin', bytes);
            await sendWith([file]);
            const fetched = await service.downloadFile(roomId, bob, file.fileId);
            expect(fetched.bytes.byteLength).toBe(bytes.byteLength);
            // A deep toEqual over 3 MB takes seconds on a slow runner; the first differing byte says the same.
            expect(fetched.bytes.findIndex((byte, index) => byte !== bytes[index])).toBe(-1);
            expect(fetched.file.sha256).toBe(file.sha256);
        });

        test('staged streams reserve quota, stay invisible, and finalize only after fresh authorization', async () => {
            let release: () => void = () => {};
            let started: () => void = () => {};
            const waiting = new Promise<void>((resolve) => { started = resolve; });
            const finish = new Promise<void>((resolve) => { release = resolve; });
            const body = new ReadableStream<Uint8Array>({
                async pull(sink) {
                    started();
                    await finish;
                    sink.enqueue(new Uint8Array([1, 2, 3]));
                    sink.close();
                }
            }, {highWaterMark: 0});
            const outcome = service.uploadFileStream(roomId, bob, {name: 'partial.bin', mediaType: '', size: 3, body}).then(() => null, (error: unknown) => error);
            await waiting;
            expect(await store.files!.usedBytes(roomId)).toBe(3);
            expect((await service.listFiles(roomId, alice)).files).toEqual([]);
            const participant = (await service.snapshot(roomId, bob)).participants.find((entry) => entry.displayName === 'bob')!;
            await service.setMuted(roomId, controller, participant.participantId, true);
            release();
            expect(await outcome).toMatchObject({code: 'participant_muted'});
            expect(await store.files!.usedBytes(roomId)).toBe(0);
        });

        test('short and oversized streams release their reservations and store no completed file', async () => {
            for (const length of [2, 4]) {
                const body = new ReadableStream<Uint8Array>({start(sink) { sink.enqueue(new Uint8Array(length)); sink.close(); }});
                await expect(service.uploadFileStream(roomId, alice, {name: 'wrong.bin', mediaType: '', size: 3, body})).rejects.toThrow('declared byte length');
                expect(await store.files!.usedBytes(roomId)).toBe(0);
            }
            const bytes = binary(2 * 1024 * 1024 + 7);
            const file = await service.uploadFileStream(roomId, alice, {name: 'complete.bin', mediaType: '', size: bytes.byteLength, body: new Response(bytes as Uint8Array<ArrayBuffer>).body!});
            const result = await service.downloadFile(roomId, alice, file.fileId);
            expect(result.bytes.findIndex((byte, index) => byte !== bytes[index])).toBe(-1);
        });

        test('usage counts sent and pending files against the room limit, and a refused upload stores nothing', async () => {
            await create({...DEFAULT_ROOM_POLICY, maxRetainedFileBytes: 10});
            await sendWith([await upload('a.bin', binary(6))]);
            await upload('b.bin', binary(3));
            expect((await service.listFiles(roomId, alice)).usage).toEqual({usedBytes: 9, limitBytes: 10, maxFileBytes: DEFAULT_MAX_FILE_BYTES});
            await expect(upload('c.bin', binary(2))).rejects.toThrow('file storage limit');
            expect((await service.listFiles(roomId, alice)).usage?.usedBytes).toBe(9);
        });

        test('an upload nobody sent is removed after an hour; a sent one stays', async () => {
            const kept = await upload('kept.txt', binary(4));
            await sendWith([kept]);
            const dropped = await upload('dropped.txt', binary(4));
            now += UNATTACHED_FILE_LIFETIME_MS + 1;
            await upload('later.txt', binary(4));
            await expect(service.downloadFile(roomId, alice, dropped.fileId)).rejects.toThrow('no such file');
            expect((await service.downloadFile(roomId, bob, kept.fileId)).bytes).toEqual(binary(4));
            expect((await service.listFiles(roomId, alice)).usage?.usedBytes).toBe(8);
        });

        test('an export lists every sent file, and deleting the room removes them', async () => {
            const file = await upload('report.json', new TextEncoder().encode('{}'));
            await sendWith([file]);
            const exported = await service.export(roomId, alice);
            expect(exported.files?.map((entry) => entry.fileId)).toEqual([file.fileId]);

            await service.delete(roomId, controller);
            expect(await store.files!.file(roomId, file.fileId)).toBeNull();
            expect(await store.files!.usedBytes(roomId)).toBe(0);
        });
    });
}

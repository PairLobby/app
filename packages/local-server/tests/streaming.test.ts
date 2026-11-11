import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {FILE_CHUNK_BYTES, newId} from '@pairlobby/protocol';
import {saveFile} from '../../cli/src/files.js';
import {startServer} from '../src/server.js';

afterEach(() => vi.unstubAllGlobals());

test('a slow file upload does not hold the room queue and revocation prevents its finalization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-stream-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
    let release: () => void = () => {};
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const client = new PairLobbyClient(relay.url);
    try {
        const room = await client.createRoom('stream', {displayName: 'owner', kind: 'human'});
        const agent = await client.redeemInvite(room.invite.code, {displayName: 'agent', kind: 'agent'});
        let part = 0;
        const body = new ReadableStream<Uint8Array>({
            async pull(sink) {
                if (part++ === 0) {
                    sink.enqueue(new Uint8Array(FILE_CHUNK_BYTES));
                } else {
                    await finish;
                    sink.enqueue(new Uint8Array([1]));
                    sink.close();
                }
            }
        });
        const outcome = client.uploadFileStream(room.roomId, agent.participantCredential, {name: 'slow.bin', size: FILE_CHUNK_BYTES + 1, body}).then(() => null, (error: unknown) => error);
        await vi.waitFor(async () => expect((await client.fileList(room.roomId, room.participantCredential)).usage?.usedBytes).toBe(FILE_CHUNK_BYTES + 1));
        await client.revoke(room.roomId, room.controllerCredential, agent.participantId);
        release();
        expect(await outcome).toMatchObject({code: 'participant_revoked'});
        expect((await client.fileList(room.roomId, room.participantCredential)).usage?.usedBytes).toBe(0);
    } finally {
        release();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test('streamed downloads verify before success and discard only their own partial output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-stream-save-'));
    const client = new PairLobbyClient('https://relay.invalid');
    const file = {fileId: newId('file'), name: 'report.txt', size: 5, mediaType: 'text/plain', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'};
    let damaged = false;
    vi.stubGlobal('fetch', async () => new Response(damaged ? 'wrong' : 'hello', {headers: {'content-length': '5', 'pairlobby-file-sha256': file.sha256}}));
    try {
        const saved = await saveFile({client, roomId: newId('room'), credential: 'test'}, file, directory);
        expect(readFileSync(saved, 'utf8')).toBe('hello');
        damaged = true;
        await expect(saveFile({client, roomId: newId('room'), credential: 'test'}, file, directory)).rejects.toThrow('damaged');
        expect(readdirSync(directory)).toEqual(['report.txt']);
        expect(readFileSync(saved, 'utf8')).toBe('hello');
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test('incremental and ordinary JSON exports contain the same captured transcript', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-export-stream-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
    const client = new PairLobbyClient(relay.url);
    try {
        const room = await client.createRoom('export', {displayName: 'owner', kind: 'human'});
        for (let index = 0; index < 10; index++) {
            await client.send(room.roomId, room.participantCredential, {type: 'message', payload: {text: 'x'.repeat(30_000), priority: 'normal'}, idempotencyKey: newId('event')});
        }
        const exported = await client.export(room.roomId, room.participantCredential);
        const records = [];
        for await (const record of client.exportRecords(room.roomId, room.participantCredential)) {
            records.push(record);
        }
        expect(records[0]).toMatchObject({kind: 'metadata', metadata: {room: {roomId: room.roomId}, complete: true}});
        expect(records.filter((record) => record.kind === 'event').map((record) => record.event)).toEqual(exported.events);
        expect(records.at(-1)).toEqual({kind: 'complete', events: 11});
    } finally {
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

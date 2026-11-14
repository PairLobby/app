import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import {startServer} from '../src/server.js';
import type {RunningServer} from '../src/server.js';

let directory: string;
let server: RunningServer;
let database: DatabaseSync;
let client: PairLobbyClient;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-file-expiry-'));
    const path = join(directory, 'rooms.sqlite');
    server = await startServer({port: 0, dataFile: path});
    client = new PairLobbyClient(server.url);
    database = new DatabaseSync(path, {readOnly: true});
});
afterEach(async () => {
    database.close();
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

test('an idle temporary file is reclaimed after a Node relay restart without client reads', async () => {
    const room = await client.createRoom('restart', {displayName: 'owner', kind: 'human'});
    const file = await client.uploadFile(room.roomId, room.participantCredential, 'temporary.txt', new TextEncoder().encode('expires'), 'text/plain', {mode: 'temporary', ttlMs: 1500});
    await client.send(room.roomId, room.participantCredential, {type: 'message', payload: {text: 'file', priority: 'normal', attachments: [file]}, idempotencyKey: newId('event')});
    await server.close();
    server = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
    await expect.poll(() => database.prepare('SELECT count(*) AS n FROM files WHERE file_id=?').get(file.fileId)?.['n'], {timeout: 5000}).toBe(0);
    expect(database.prepare('SELECT count(*) AS n FROM file_chunks WHERE file_id=?').get(file.fileId)?.['n']).toBe(0);
});

test('a stalled streaming upload cannot outlive its temporary policy', async () => {
    const room = await client.createRoom('stalled upload', {displayName: 'owner', kind: 'human'});
    let input: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(controller) { input = controller; controller.enqueue(new Uint8Array([1])); }});
    const result = client.uploadFileStream(room.roomId, room.participantCredential, {name: 'stalled.bin', size: 2, body, retention: {mode: 'temporary', ttlMs: 1000}}).then(() => 'accepted', () => 'refused');
    try {
        await expect.poll(() => database.prepare('SELECT count(*) AS n FROM files WHERE room_id=?').get(room.roomId)?.['n'], {timeout: 3000}).toBe(1);
        await expect.poll(() => database.prepare('SELECT count(*) AS n FROM files WHERE room_id=?').get(room.roomId)?.['n'], {timeout: 5000}).toBe(0);
    } finally {
        try { input!.close(); } catch { /* The relay may already have cancelled the body. */ }
    }
    expect(await result).toBe('refused');
    expect(database.prepare('SELECT count(*) AS n FROM file_chunks').get()?.['n']).toBe(0);
}, 12000);

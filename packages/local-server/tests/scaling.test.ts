import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, expect, test} from 'vitest';
import {ProtocolError, newCredential, newId} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {CommittedChange} from '@pairlobby/server-core';
import {SqliteRoomStore} from '../src/sqlite-store.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, {recursive: true, force: true})));

function databasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-scaling-'));
    directories.push(directory);
    return join(directory, 'rooms.sqlite');
}

test('a watermark covers a legacy backlog beyond 2000 requests with constant row writes and stable first timestamps', async () => {
    const path = databasePath();
    const store = new SqliteRoomStore(path);
    let now = 1_800_000_000_000;
    const service = new RoomService(store, () => now, undefined, undefined, {receiptMode: 'watermark'});
    const alice = newCredential('participant');
    const bob = newCredential('participant');
    try {
        const room = await service.createRoom({name: 'backlog', displayName: 'alice', kind: 'human', participantCredential: alice, controllerCredential: newCredential('controller')});
        const joined = await service.redeemInvite({code: room.invite.code, displayName: 'bob', kind: 'agent', participantCredential: bob, attemptId: newId('attempt')});
        const sent = await service.send(room.roomId, alice, {type: 'message', recipientId: joined.participantId, payload: {text: 'seed', priority: 'normal'}, idempotencyKey: newId('event')});
        const request = (await store.messageRequest(room.roomId, sent.event.eventId))!;
        const sql = new DatabaseSync(path);
        let lastId = '';
        try {
            sql.exec('BEGIN');
            for (let seq = sent.event.seq + 1; seq <= 2505; seq++) {
                lastId = newId('event');
                sql.prepare('INSERT INTO events(room_id,seq,body) VALUES(?,?,?)').run(room.roomId, seq, JSON.stringify({...sent.event, eventId: lastId, seq}));
                sql.prepare('INSERT INTO message_requests(event_id,room_id,seq,received_at,response_event_id,requires_reply,body) VALUES(?,?,?,NULL,NULL,1,?)').run(lastId, room.roomId, seq, JSON.stringify({...request, eventId: lastId, seq, messageSeq: seq}));
            }
            sql.prepare("UPDATE rooms SET body=json_set(body,'$.nextSeq',2506) WHERE room_id=?").run(room.roomId);
            sql.exec('COMMIT');
        } finally {
            sql.close();
        }
        const before = store.changeCount();
        await service.receipt(room.roomId, bob, 2505);
        expect(store.changeCount() - before).toBeLessThanOrEqual(3);
        expect((await store.messageRequest(room.roomId, lastId))?.receivedAt).toBe(now);
        expect((await store.unreceivedRequests(room.roomId, joined.participantId, 0, 100)).requests).toEqual([]);
        const firstAt = now;
        now += 60_000;
        const settled = store.changeCount();
        await service.receipt(room.roomId, bob, 2505);
        expect(store.changeCount()).toBe(settled);
        expect((await store.messageRequest(room.roomId, lastId))?.receivedAt).toBe(firstAt);
    } finally {
        store.close();
    }
});

test('quota rollback keeps the revision and observers unchanged', async () => {
    const changes: CommittedChange[] = [];
    const store = new SqliteRoomStore(databasePath(), {afterCommit: (change) => changes.push(change), beforeFileReservation: () => { throw new ProtocolError('quota_exceeded', 'test quota'); }});
    const service = new RoomService(store);
    const credential = newCredential('participant');
    try {
        const room = await service.createRoom({name: 'rollback', displayName: 'alice', kind: 'human', participantCredential: credential, controllerCredential: newCredential('controller')});
        const before = await store.roomHead(room.roomId);
        changes.length = 0;
        await expect(service.uploadFileStream(room.roomId, credential, {name: 'denied', mediaType: '', size: 3, body: new Response('abc').body!})).rejects.toMatchObject({code: 'quota_exceeded'});
        expect(await store.roomHead(room.roomId)).toEqual(before);
        expect(await store.files.usedBytes(room.roomId)).toBe(0);
        expect(changes).toEqual([]);
    } finally {
        store.close();
    }
});

test('independent services sharing SQLite retry conflicting sends without losing either commit', async () => {
    const path = databasePath();
    const first = new SqliteRoomStore(path);
    const second = new SqliteRoomStore(path);
    const services = [new RoomService(first), new RoomService(second)];
    const credential = newCredential('participant');
    try {
        const room = await services[0]!.createRoom({name: 'writers', displayName: 'alice', kind: 'human', participantCredential: credential, controllerCredential: newCredential('controller')});
        const sent = await Promise.all(services.map((service, index) => service.send(room.roomId, credential, {type: 'message', payload: {text: `writer ${index}`, priority: 'normal'}, idempotencyKey: newId('event')})));
        expect(sent.map((result) => result.event.seq).sort()).toEqual([2, 3]);
        expect((await first.readEvents(room.roomId, 0, 10)).events).toHaveLength(3);
    } finally {
        first.close();
        second.close();
    }
});

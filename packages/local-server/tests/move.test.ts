import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {ProtocolError, newId} from '@pairlobby/protocol';
import type {RoomTransferRecord} from '@pairlobby/protocol';

import {startServer} from '../src/server.js';
import type {RunningServer} from '../src/server.js';
import {SqliteRoomStore} from '../src/sqlite-store.js';

let directory: string;
let source: RunningServer;
const running: RunningServer[] = [];

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-move-'));
    source = await startServer({port: 0, dataFile: join(directory, 'source.sqlite')});
    running.push(source);
});

afterEach(async () => {
    for (const server of running.splice(0)) {
        await server.close();
    }
    rmSync(directory, {recursive: true, force: true});
});

async function failure(work: Promise<unknown>): Promise<string> {
    try {
        await work;
    } catch (error) {
        return error instanceof ProtocolError ? error.code : String(error);
    }
    return 'succeeded';
}

async function roomWithWork() {
    const client = new PairLobbyClient(source.url);
    const owner = await client.createRoom('kv-cache-debugger', {displayName: 'ana', kind: 'human'});
    const agent = await client.redeemInvite(owner.invite.code, {displayName: 'codex', kind: 'agent'});
    const attachment = await client.uploadFile(owner.roomId, owner.participantCredential, 'notes.txt', new TextEncoder().encode('the cache key misses on restart'), 'text/plain');
    const asked = await client.send(owner.roomId, owner.participantCredential, {type: 'message', payload: {text: 'Please look at the notes', priority: 'normal', attachments: [attachment]}, recipientId: agent.participantId, idempotencyKey: newId('event')});
    return {client, owner, agent, attachment, asked};
}

test('test_a_moved_room_keeps_its_history_files_open_requests_and_credentials', async () => {
    const {client, owner, agent, attachment, asked} = await roomWithWork();
    const before = await client.readEvents(owner.roomId, owner.participantCredential, 0);

    expect((await client.prepareMove(owner.roomId, owner.controllerCredential)).until).toBeGreaterThan(Date.now());
    expect(await failure(client.send(owner.roomId, agent.participantCredential, {type: 'message', payload: {text: 'during the move', priority: 'normal'}, idempotencyKey: newId('event')}))).toBe('room_moving');
    expect(await failure(client.prepareMove(owner.roomId, agent.participantCredential))).toBe('unauthorized');

    const records: RoomTransferRecord[] = [];
    for await (const {record} of client.moveTransfer(owner.roomId, owner.controllerCredential)) {
        records.push(record);
    }
    const target = new SqliteRoomStore(join(directory, 'target.sqlite'));
    expect(target.transferIn(records)).toEqual({roomId: owner.roomId, events: before.events.length, files: 1});
    expect(() => target.transferIn(records)).toThrow(/already exists/);
    target.close();

    const moved = await startServer({port: 0, dataFile: join(directory, 'target.sqlite')});
    running.push(moved);
    await client.commitMove(owner.roomId, owner.controllerCredential, {serverUrl: moved.url, roomId: owner.roomId});
    const closed = await client.snapshot(owner.roomId, owner.participantCredential);
    expect(closed).toMatchObject({lifecycle: 'closed', closeReason: 'moved', movedTo: {serverUrl: moved.url, roomId: owner.roomId}});
    expect(await failure(client.send(owner.roomId, agent.participantCredential, {type: 'message', payload: {text: 'too late', priority: 'normal'}, idempotencyKey: newId('event')}))).toBe('room_closed');

    // The new relay knows everyone by their old credentials and still has the request waiting on the agent.
    const there = new PairLobbyClient(moved.url);
    expect((await there.readEvents(owner.roomId, agent.participantCredential, 0)).events.map((event) => event.eventId)).toEqual(before.events.map((event) => event.eventId));
    expect(new TextDecoder().decode(await there.downloadFile(owner.roomId, agent.participantCredential, attachment.fileId))).toBe('the cache key misses on restart');
    expect((await there.requests(owner.roomId, agent.participantCredential)).requests.map((request) => request.eventId)).toEqual([asked.event.eventId]);
    await there.send(owner.roomId, agent.participantCredential, {type: 'message.received', payload: {eventId: asked.event.eventId}, idempotencyKey: newId('event')});
    await there.send(owner.roomId, agent.participantCredential, {type: 'message', payload: {text: 'Done: the key includes the boot id.', priority: 'normal'}, recipientId: owner.participantId, replyTo: asked.event.eventId, idempotencyKey: newId('event')});
    expect((await there.requests(owner.roomId, agent.participantCredential)).requests).toEqual([]);
    expect((await there.snapshot(owner.roomId, owner.controllerCredential)).lifecycle).toBe('open');
});

test('a move preserves file deadlines and confirmations and removes ephemeral source copies', async () => {
    const client = new PairLobbyClient(source.url);
    const owner = await client.createRoom('retained move', {displayName: 'owner', kind: 'human'});
    const first = await client.redeemInvite(owner.invite.code, {displayName: 'first', kind: 'agent'});
    const second = await client.redeemInvite((await client.mintInvite(owner.roomId, owner.controllerCredential)).code, {displayName: 'second', kind: 'agent'});
    const receiptFile = await client.uploadFile(owner.roomId, owner.participantCredential, 'receipt.txt', new TextEncoder().encode('keep locally'), 'text/plain', {mode: 'until-received'});
    const temporary = await client.uploadFile(owner.roomId, owner.participantCredential, 'temporary.txt', new TextEncoder().encode('deadline'), 'text/plain', {mode: 'temporary', ttlMs: 60000});
    await client.send(owner.roomId, owner.participantCredential, {type: 'message', payload: {text: 'files', priority: 'normal', attachments: [receiptFile, temporary]}, idempotencyKey: newId('event')});
    await client.confirmFileReceipt(owner.roomId, first.participantCredential, receiptFile.fileId, receiptFile);
    await client.prepareMove(owner.roomId, owner.controllerCredential);
    const records: RoomTransferRecord[] = [];
    for await (const {record} of client.moveTransfer(owner.roomId, owner.controllerCredential)) {
        records.push(record);
    }
    const path = join(directory, 'retained-target.sqlite');
    expect(records.filter((record) => record.kind === 'file-retention')).toHaveLength(2);
    const target = new SqliteRoomStore(path);
    target.transferIn(records);
    target.close();
    const moved = await startServer({port: 0, dataFile: path});
    running.push(moved);
    await client.commitMove(owner.roomId, owner.controllerCredential, {serverUrl: moved.url, roomId: owner.roomId});
    expect((await client.fileList(owner.roomId, owner.participantCredential)).usage?.usedBytes).toBe(0);
    const destination = new PairLobbyClient(moved.url);
    const files = await destination.files(owner.roomId, owner.participantCredential);
    expect(files.find((file) => file.fileId === temporary.fileId)?.retention).toEqual(temporary.retention);
    expect(files.find((file) => file.fileId === receiptFile.fileId)?.receivedBy).toEqual([first.participantId]);
    expect(await destination.confirmFileReceipt(owner.roomId, second.participantCredential, receiptFile.fileId, receiptFile)).toMatchObject({available: false});
    expect((await destination.fileList(owner.roomId, owner.participantCredential)).usage?.usedBytes).toBe(temporary.size);
});

test('test_an_aborted_move_takes_writes_again_and_a_transfer_needs_the_lease', async () => {
    const {client, owner, agent} = await roomWithWork();
    expect(await failure((async () => {
        for await (const _ of client.moveTransfer(owner.roomId, owner.controllerCredential)) {
            // Reading the first record is enough to be refused.
        }
    })())).toBe('invalid_request');
    await client.prepareMove(owner.roomId, owner.controllerCredential);
    await client.abortMove(owner.roomId, owner.controllerCredential);
    await client.send(owner.roomId, agent.participantCredential, {type: 'message', payload: {text: 'back to work', priority: 'normal'}, idempotencyKey: newId('event')});
    expect(await failure(client.commitMove(owner.roomId, owner.controllerCredential, {serverUrl: 'https://pairlobby.com/relay/ws/team', roomId: owner.roomId}))).toBe('invalid_request');
    expect((await client.snapshot(owner.roomId, owner.participantCredential)).moveSupported).toBe(true);
});

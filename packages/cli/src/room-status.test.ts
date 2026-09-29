import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, expect, test, vi} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import type {TurnEntry} from '@pairlobby/protocol';
import {newId} from '@pairlobby/protocol';
import {formatRoomStatus, loadRoomStatus, roomStatusRows} from './room-status.js';

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-status-'));
let server: RunningServer;
let client: PairLobbyClient;
beforeAll(async () => {
    server = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
    client = new PairLobbyClient(server.url);
});
afterAll(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

test('status counts messages separately from control events and does not write receipts', async () => {
    const room = await client.createRoom('Status check', {displayName: 'owner', kind: 'human'});
    const agent = await client.redeemInvite(room.invite.code, {displayName: 'agent', kind: 'agent'});
    const extra = await client.mintInvite(room.roomId, room.participantCredential, 'guest');
    const observer = await client.redeemInvite(extra.code, {displayName: 'observer', kind: 'human'});
    const message = await client.send(room.roomId, agent.participantCredential, {type: 'message', payload: {text: 'hello', priority: 'normal'}, idempotencyKey: newId('event')});
    await client.acknowledgeMessage(room.roomId, room.participantCredential, message.event.eventId);
    const before = await client.snapshot(room.roomId, room.participantCredential);
    const result = await loadRoomStatus({client, roomId: room.roomId, credential: room.participantCredential});
    expect(result.messages.count).toBe(1);
    expect(result.messages.lastAt).toBe(message.event.at);
    expect(Object.fromEntries(roomStatusRows(result).map((row) => [row.id, row.value]))).toMatchObject({joined: '3', agents: '1', humans: '1', observers: '1'});
    expect(formatRoomStatus(result)).toContain('MEMBERS');
    expect((await client.snapshot(room.roomId, room.participantCredential)).latestSeq).toBe(before.latestSeq);
    // Observers can inspect the room without acquiring write privileges.
    expect((await loadRoomStatus({client, roomId: room.roomId, credential: observer.participantCredential})).messages.count).toBe(1);
    await client.leave(room.roomId, agent.participantCredential);
    const after = await loadRoomStatus({client, roomId: room.roomId, credential: room.participantCredential});
    expect(Object.fromEntries(roomStatusRows(after).map((row) => [row.id, row.value]))).toMatchObject({joined: '2', agents: '0', humans: '1', observers: '1'});
});

test('pagination counts retained history to a fixed boundary and ignores newer events', async () => {
    const room = await client.createRoom('Page test', {displayName: 'owner', kind: 'human'});
    const sample = await client.send(room.roomId, room.participantCredential, {type: 'message', payload: {text: 'sample', priority: 'normal'}, idempotencyKey: newId('event')});
    const snapshot = {...await client.snapshot(room.roomId, room.participantCredential), earliestSeq: 20, latestSeq: 620};
    const readEvents = vi.fn(async (_room: string, _credential: string, after: number, limit = 500) => ({events: Array.from({length: Math.min(limit, 621 - after)}, (_, index) => ({...sample.event, seq: after + index + 1})), earliestSeq: 20, latestSeq: 621, hasMore: after + limit < 621}));
    const reader = {snapshot: async () => snapshot, readEvents, turnQueue: async () => ({mode: 'parallel' as const, entries: []})};
    const result = await loadRoomStatus({client: reader, roomId: room.roomId, credential: 'test'});
    expect(result.messages.count).toBe(601);
    expect(readEvents.mock.calls.map((call) => call.slice(2))).toEqual([[19, 500], [519, 101]]);
    expect(roomStatusRows(result).find((row) => row.id === 'messages')).toMatchObject({value: '601', hint: 'Older history was removed; this is the retained count.'});
    readEvents.mockResolvedValueOnce({events: [], earliestSeq: 20, latestSeq: 620, hasMore: false});
    await expect(loadRoomStatus({client: reader, roomId: room.roomId, credential: 'test'})).rejects.toThrow('completely');
    readEvents.mockResolvedValueOnce({events: [], earliestSeq: 21, latestSeq: 620, hasMore: false});
    await expect(loadRoomStatus({client: reader, roomId: room.roomId, credential: 'test'})).rejects.toThrow('History changed');
});

test('working is per agent, requires a live declaration, and excludes former members', async () => {
    const created = await client.createRoom('Activity', {displayName: 'owner', kind: 'human'});
    const agent = await client.redeemInvite(created.invite.code, {displayName: 'agent', kind: 'agent'});
    const status = await loadRoomStatus({client, roomId: created.roomId, credential: created.participantCredential});
    expect(roomStatusRows(status).find((row) => row.id === 'messages')?.value).toBe('0');
    expect(roomStatusRows(status).find((row) => row.id === 'latest')?.value).toBe('None retained');
    const entry: TurnEntry = {requestId: 'one', conversationId: 'one', participantId: agent.participantId, name: 'agent', state: 'answering', expiresAt: status.at + 10000, workingAt: status.at};
    status.turns = {mode: 'parallel', entries: [entry, {...entry, requestId: 'two'}, {...entry, participantId: 'former'}]};
    expect(roomStatusRows(status).find((row) => row.id === 'working')?.value).toBe('1');
    status.turns.entries = [{...entry, expiresAt: status.at - 1}];
    expect(roomStatusRows(status).find((row) => row.id === 'working')?.value).toBe('0');
    status.turns = null;
    expect(formatRoomStatus(status)).toContain('Unavailable on this relay');
});

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';
import {closeListedRoom, leaveListedSession, loadRoomList, roomListJson, roomRows, sessionRows, sortListRows} from './room-list.js';
import type {ListRow} from './room-list.js';

test('sorts numeric counts and dates numerically, keeps unknown last, and resolves ties by identity', () => {
    const row = (id: string, value: number | null): ListRow => ({id, roomId: id, values: {}, sortValues: {agents: value}});
    const rows = [row('ten', 10), row('unknown', null), row('two', 2), row('zero', 0)];
    expect(sortListRows(rows, {key: 'agents', descending: false}).map((entry) => entry.id)).toEqual(['zero', 'two', 'ten', 'unknown']);
    expect(sortListRows(rows, {key: 'agents', descending: true}).map((entry) => entry.id)).toEqual(['ten', 'two', 'zero', 'unknown']);
    expect(sortListRows([row('b', 1), row('a', 1)], {key: 'agents', descending: true}).map((entry) => entry.id)).toEqual(['a', 'b']);
});

test('listing is read-only, JSON retains saved sessions without credentials, and lifecycle actions target exact IDs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-list-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const store = new LocalStore(join(directory, 'device'));
    try {
        const created = await client.createRoom('Room 10', {displayName: 'Owner', kind: 'human'});
        const member = await client.redeemInvite(created.invite.code, {displayName: 'Member', kind: 'human'});
        const ownerSession = newId('session');
        const memberSession = newId('session');
        store.upsertRoom({roomId: created.roomId, name: 'Old saved name', serverUrl: relay.url, createdAt: created.room.createdAt, expiresAt: null, controls: true, sessions: []});
        for (const person of [{sessionId: ownerSession, participantId: created.participantId, displayName: 'Owner', credential: created.participantCredential}, {sessionId: memberSession, participantId: member.participantId, displayName: 'Member', credential: member.participantCredential}]) {
            store.addSession(created.roomId, {sessionId: person.sessionId, participantId: person.participantId, displayName: person.displayName, kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory});
            store.putCredential(created.roomId, person.sessionId, person.credential);
        }
        const before = await client.snapshot(created.roomId, created.participantCredential);
        const entries = await loadRoomList(store);
        const json = roomListJson(store, entries, {key: 'name', descending: false});
        expect(json).toMatchObject({count: 1, rooms: [{name: 'Room 10', reachable: true, error: null, sessions: [{state: 'Joined'}, {state: 'Joined'}]}]});
        expect(JSON.stringify(json)).not.toContain(created.participantCredential);
        expect(JSON.stringify(json)).not.toContain(member.participantCredential);
        expect((await client.snapshot(created.roomId, created.participantCredential)).latestSeq).toBe(before.latestSeq);
        expect(store.room(created.roomId)!.sessions.every((session) => session.lastReadSeq === 0)).toBe(true);
        expect(roomRows(entries)[0]!.sortValues['people']).toBe(2);
        await expect(closeListedRoom(store, created.roomId)).rejects.toThrow('owner or admin');
        await leaveListedSession(store, created.roomId, memberSession);
        const after = await client.snapshot(created.roomId, created.participantCredential);
        expect(after.participants.find((person) => person.participantId === member.participantId)?.left).toBe(true);
        expect(after.participants.find((person) => person.participantId === created.participantId)?.left).toBe(false);
        expect(store.credential(created.roomId, memberSession)).toBe(member.participantCredential);
        expect(sessionRows(store, (await loadRoomList(store))[0]!).find((row) => row.id === memberSession)?.values['state']).toBe('Left');
        await client.rejoin(created.roomId, member.participantCredential);
        store.putCredential(created.roomId, 'controller', created.controllerCredential);
        await closeListedRoom(store, created.roomId);
        expect((await client.snapshot(created.roomId, created.participantCredential)).lifecycle).toBe('closed');
        expect(await leaveListedSession(store, created.roomId, memberSession)).toContain('Room is closed');
    } finally {
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test('missing credentials and unreachable rooms are unknown, never zero-member evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-list-offline-'));
    const store = new LocalStore(directory);
    try {
        store.upsertRoom({roomId: newId('room'), name: 'No access', serverUrl: 'http://127.0.0.1:1', createdAt: 1, expiresAt: null, controls: false, sessions: []});
        const entries = await loadRoomList(store);
        expect(roomRows(entries)[0]!.values).toMatchObject({state: 'no credential', agents: 'Unknown', people: 'Unknown'});
        expect(roomListJson(store, entries, {key: 'name', descending: false}).rooms[0]).toMatchObject({reachable: false, live: null, error: 'no_saved_credential'});
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test('network rooms are listed as not joined, with only what the relay tells before joining', async () => {
    const {networkRows} = await import('./room-list.js');
    const [row] = networkRows([{url: 'http://100.111.208.123:8790', label: 'desktop', room: {roomId: 'rm_A', name: 'tower-test', createdAt: 0, participantCount: 3}}]);
    expect(row).toMatchObject({id: 'rm_A', roomId: 'rm_A'});
    expect(row!.values).toMatchObject({name: 'tower-test', state: 'on network', people: '3 in room', sessions: 'Not joined', relay: 'http://100.111.208.123:8790 (desktop)'});
    expect(row!.sessionId).toBeUndefined();
});

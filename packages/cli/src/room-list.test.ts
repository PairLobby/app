import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';
import {closeListedRoom, deleteListedRoom, forgetListedRoom, administersListedRoom, leaveListedSession, loadRoomList, roomListJson, roomRows, sessionRows, sortListRows} from './room-list.js';
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

test('invitations are listed as invited, with who asked and nothing from inside the room', async () => {
    const {invitationRows} = await import('./room-list.js');
    const [row] = invitationRows([{id: 'i1', roomId: 'rm_A', roomName: 'Design review', invitedBy: '@maria', role: 'member', agents: 1, createdAt: 0, expiresAt: Date.UTC(2026, 9, 12)}]);
    expect(row).toMatchObject({id: 'rm_A', roomId: 'rm_A'});
    expect(row!.values).toMatchObject({name: 'Design review', state: 'invited', people: 'by @maria', sessions: 'Not joined', agents: 'Unknown', relay: 'answer by 2026-10-12'});
    expect(row!.sessionId).toBeUndefined();
});

test('test_deleting_a_listed_room_needs_its_owner_and_removing_one_leaves_the_room_alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-room-delete-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    let stopped = false;
    try {
        const save = (store: LocalStore, roomId: string, name: string, sessionId: string, participantId: string, credential: string) => {
            store.upsertRoom({roomId, name, serverUrl: relay.url, createdAt: Date.now(), expiresAt: null, controls: false, sessions: []});
            store.addSession(roomId, {sessionId, participantId, displayName: name, kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory});
            store.putCredential(roomId, sessionId, credential);
        };
        const created = await client.createRoom('Shared', {displayName: 'Owner', kind: 'human'});
        const member = await client.redeemInvite(created.invite.code, {displayName: 'Member', kind: 'human'});
        const owner = new LocalStore(join(directory, 'owner'));
        save(owner, created.roomId, 'Shared', newId('session'), created.participantId, created.participantCredential);
        owner.putCredential(created.roomId, 'controller', created.controllerCredential);
        const guest = new LocalStore(join(directory, 'guest'));
        save(guest, created.roomId, 'Shared', newId('session'), member.participantId, member.participantCredential);

        const listed = async (store: LocalStore) => (await loadRoomList(store)).find((entry) => entry.room.roomId === created.roomId)!;
        expect(administersListedRoom(owner, await listed(owner))).toBe(true);
        expect(administersListedRoom(guest, await listed(guest))).toBe(false);
        await expect(deleteListedRoom(guest, created.roomId)).rejects.toThrow('requires its owner or an admin');
        expect(guest.room(created.roomId)).toBeDefined();

        // An admin on another device may delete too; a muted or demoted one may not.
        const promoted = await client.redeemInvite((await client.mintInvite(created.roomId, created.controllerCredential, 'member', true)).code, {displayName: 'Admin', kind: 'human'});
        const admin = new LocalStore(join(directory, 'admin'));
        save(admin, created.roomId, 'Shared', newId('session'), promoted.participantId, promoted.participantCredential);
        expect(administersListedRoom(admin, await listed(admin))).toBe(false);
        await client.setRole(created.roomId, created.controllerCredential, promoted.participantId, 'controller');
        expect(administersListedRoom(admin, await listed(admin))).toBe(true);
        await client.setRole(created.roomId, created.controllerCredential, promoted.participantId, 'member');
        expect(administersListedRoom(admin, await listed(admin))).toBe(false);
        await expect(deleteListedRoom(admin, created.roomId)).rejects.toThrow('requires its owner or an admin');
        await client.setRole(created.roomId, created.controllerCredential, promoted.participantId, 'controller');

        // Removing it from the member's device leaves the room, and the owner's record, as they were.
        await forgetListedRoom(guest, created.roomId);
        expect(guest.room(created.roomId)).toBeUndefined();
        expect(guest.credential(created.roomId, 'controller')).toBeUndefined();
        const after = await client.snapshot(created.roomId, created.participantCredential);
        expect(after.lifecycle).toBe('open');
        expect(after.participants.find((person) => person.participantId === member.participantId)?.left).toBe(true);
        await expect(forgetListedRoom(guest, created.roomId)).rejects.toThrow('no longer saved');

        expect(await deleteListedRoom(admin, created.roomId)).toBe('deleted');
        expect(admin.room(created.roomId)).toBeUndefined();
        // The owner's own record of a room an admin deleted is simply dropped.
        expect(await deleteListedRoom(owner, created.roomId)).toBe('already_gone');
        expect(owner.room(created.roomId)).toBeUndefined();
        await expect(client.snapshot(created.roomId, created.participantCredential)).rejects.toThrow();

        // A room the relay no longer has is simply dropped; an unreachable relay deletes nothing.
        const second = await client.createRoom('Second', {displayName: 'Owner', kind: 'human'});
        save(owner, second.roomId, 'Second', newId('session'), second.participantId, second.participantCredential);
        owner.putCredential(second.roomId, 'controller', second.controllerCredential);
        await client.delete(second.roomId, second.controllerCredential);
        expect(await deleteListedRoom(owner, second.roomId)).toBe('already_gone');
        const third = await client.createRoom('Third', {displayName: 'Owner', kind: 'human'});
        save(owner, third.roomId, 'Third', newId('session'), third.participantId, third.participantCredential);
        owner.putCredential(third.roomId, 'controller', third.controllerCredential);
        client.closeLive();
        await relay.close();
        stopped = true;
        await expect(deleteListedRoom(owner, third.roomId)).rejects.toThrow(/was not deleted/);
        expect(owner.room(third.roomId)).toBeDefined();
        await forgetListedRoom(owner, third.roomId);
        expect(owner.room(third.roomId)).toBeUndefined();
    } finally {
        client.closeLive();
        if (!stopped) {
            await relay.close();
        }
        rmSync(directory, {recursive: true, force: true});
    }
}, 30_000);

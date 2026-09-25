import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LocalStore} from '@pairlobby/client';
import type {RoomEntry, SessionEntry} from '@pairlobby/client';
import {selectHumanSession} from './human-session.js';
import {resolveSession} from './context.js';

let store: LocalStore;
let room: RoomEntry;

beforeEach(() => {
    store = new LocalStore(mkdtempSync(join(tmpdir(), 'pairlobby-human-')));
    room = {roomId: 'room', name: 'test', serverUrl: 'http://localhost', createdAt: 0, expiresAt: null, controls: false, sessions: []};
    store.upsertRoom(room);
    vi.stubEnv('PAIRLOBBY_SESSION', '');
});

afterEach(() => {
    rmSync(store.directory, {recursive: true, force: true});
    vi.unstubAllEnvs();
});

function add(sessionId: string, kind: 'human' | 'agent', displayName = 'same'): void {
    const session: SessionEntry = {sessionId, participantId: `participant-${sessionId}`, displayName, kind, role: 'member', joinedAt: 0, lastReadSeq: 7, cwd: '/work'};
    store.addSession(room.roomId, session);
    store.putCredential(room.roomId, sessionId, `credential-${sessionId}`);
    room = store.room(room.roomId)!;
}

test('a room-only human chat selects the human while agent commands remain explicit', async () => {
    add('agent', 'agent');
    await expect(selectHumanSession(store, room)).rejects.toThrow('No saved human');
    add('human', 'human');
    store.setProfile({displayName: 'Different name', kind: 'human'});
    const selection = await selectHumanSession(store, room);
    expect(selection.session.sessionId).toBe('human');
    expect(selection.credential).toBe('credential-human');
    expect(() => resolveSession(room)).toThrow('several sessions');
    expect(store.room(room.roomId)!.preferredHumanSessionId).toBeUndefined();
});

test('multiple humans require a choice which survives relaunch, renaming and room refresh', async () => {
    add('first', 'human');
    add('second', 'human');
    add('agent', 'agent');
    await expect(selectHumanSession(store, room)).rejects.toThrow('Several human');
    const choose = vi.fn(async (sessions: SessionEntry[]) => {
        expect(sessions.map((session) => session.sessionId)).toEqual(['first', 'second']);
        return 'second';
    });
    const selected = await selectHumanSession(store, room, choose);
    store.rememberHumanSession(room.roomId, selected.session.sessionId);
    store.updateSessionName(room.roomId, 'second', 'Room alias', 'room');
    const refreshed = {...store.room(room.roomId)!};
    delete refreshed.preferredHumanSessionId;
    store.upsertRoom(refreshed);
    const reopened = new LocalStore(store.directory);
    expect((await selectHumanSession(reopened, reopened.room(room.roomId)!, choose)).session).toMatchObject({sessionId: 'second', displayName: 'Room alias', nameSource: 'room', lastReadSeq: 7});
    expect(choose).toHaveBeenCalledTimes(1);
    expect(() => store.rememberHumanSession(room.roomId, 'agent')).toThrow('human membership');
    expect(store.profile()).toEqual({});
});

test('a missing preferred membership or credential fails instead of switching people', async () => {
    add('first', 'human');
    add('second', 'human');
    store.rememberHumanSession(room.roomId, 'first');
    store.putCredential(room.roomId, 'first', '');
    await expect(selectHumanSession(store, store.room(room.roomId)!)).rejects.toThrow('no credential');
    store.upsertRoom({...store.room(room.roomId)!, sessions: room.sessions.filter((session) => session.sessionId !== 'first')});
    await expect(selectHumanSession(store, store.room(room.roomId)!)).rejects.toThrow('saved human session is missing');
});

test('cancelling the choice leaves the preference unset and cannot select an agent', async () => {
    add('first', 'human');
    add('second', 'human');
    add('agent', 'agent');
    await expect(selectHumanSession(store, room, async () => undefined)).rejects.toThrow('cancelled');
    await expect(selectHumanSession(store, room, async () => 'agent')).rejects.toThrow('saved human sessions');
    expect(store.room(room.roomId)!.preferredHumanSessionId).toBeUndefined();
});

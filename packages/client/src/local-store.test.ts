//! The per-device registry. The property that matters most here is separation:
//! the file that answers "which rooms have my agents joined" must never contain
//! a credential, because that file is what the CLI prints.

import {mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {LocalStore} from './local-store.js';
import type {RoomEntry, SessionEntry} from './local-store.js';

let directory: string;
let store: LocalStore;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-store-'));
    store = new LocalStore(directory);
});

afterEach(() => rmSync(directory, {recursive: true, force: true}));

function room(overrides: Partial<RoomEntry> = {}): RoomEntry {
    return {roomId: 'rm_AAAAAAAAAAAAAAAAAAAAAAAAAA', name: 'my-project', serverUrl: 'http://127.0.0.1:8790', createdAt: 1000, expiresAt: Date.now() + 86_400_000, controls: true, sessions: [], ...overrides};
}

function session(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {participantId: 'pt_AAAAAAAAAAAAAAAAAAAAAAAAAA', sessionId: 'se_AAAAAAAAAAAAAAAAAAAAAAAAAA', displayName: 'claude', kind: 'agent', role: 'member', joinedAt: 1000, lastReadSeq: 0, cwd: '/work', ...overrides};
}

describe('local registry', () => {
    test('test_the_registry_file_never_contains_a_credential', () => {
        store.upsertRoom(room());
        store.addSession(room().roomId, session());
        store.putCredential(room().roomId, 'controller', 'plc_super-secret-controller-token');
        store.putCredential(room().roomId, session().sessionId, 'plp_super-secret-participant-token');

        const registry = readFileSync(join(directory, 'rooms.json'), 'utf8');
        expect(registry).not.toContain('plc_');
        expect(registry).not.toContain('plp_');
        expect(registry).not.toContain('secret');
        expect(JSON.parse(registry)).toHaveLength(1);
    });

    test('test_both_files_are_written_owner_readable_only', () => {
        store.upsertRoom(room());
        store.putCredential(room().roomId, 'controller', 'plc_token');
        for (const file of ['rooms.json', 'credentials.json']) {
            expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
        }
    });

    test('test_credentials_are_scoped_to_a_session', () => {
        store.upsertRoom(room());
        store.putCredential(room().roomId, 'se_one', 'plp_one');
        store.putCredential(room().roomId, 'se_two', 'plp_two');
        expect(store.credential(room().roomId, 'se_one')).toBe('plp_one');
        expect(store.credential(room().roomId, 'se_two')).toBe('plp_two');
        expect(store.credential(room().roomId, 'se_missing')).toBeUndefined();
    });

    test('test_a_room_resolves_by_id_name_or_unique_prefix', () => {
        store.upsertRoom(room());
        expect(store.resolveRoom('my-project')).toMatchObject({room: {name: 'my-project'}});
        expect(store.resolveRoom(room().roomId)).toMatchObject({room: {name: 'my-project'}});
        expect(store.resolveRoom('my-pro')).toMatchObject({room: {name: 'my-project'}});
        expect(store.resolveRoom('nothing')).toEqual({missing: true});
    });

    test('test_an_ambiguous_prefix_returns_every_match_rather_than_guessing', () => {
        store.upsertRoom(room({roomId: 'rm_AAAAAAAAAAAAAAAAAAAAAAAAAA', name: 'api-work'}));
        store.upsertRoom(room({roomId: 'rm_BBBBBBBBBBBBBBBBBBBBBBBBBB', name: 'api-review'}));
        const resolved = store.resolveRoom('api');
        expect('ambiguous' in resolved).toBe(true);
        expect((resolved as {ambiguous: RoomEntry[]}).ambiguous).toHaveLength(2);
    });

    test('test_the_sole_room_is_only_sole_while_it_is_unexpired', () => {
        store.upsertRoom(room());
        expect(store.soleRoom()).not.toBeNull();
        store.upsertRoom(room({roomId: 'rm_BBBBBBBBBBBBBBBBBBBBBBBBBB', name: 'other', expiresAt: 1}));
        expect(store.soleRoom()?.name).toBe('my-project');
        store.upsertRoom(room({roomId: 'rm_CCCCCCCCCCCCCCCCCCCCCCCCCC', name: 'third'}));
        expect(store.soleRoom()).toBeNull();
    });

    test('test_two_sessions_in_one_room_keep_separate_cursors', () => {
        store.upsertRoom(room());
        store.addSession(room().roomId, session({sessionId: 'se_one', participantId: 'pt_one'}));
        store.addSession(room().roomId, session({sessionId: 'se_two', participantId: 'pt_two'}));
        store.updateCursor(room().roomId, 'se_one', 12);

        const sessions = store.room(room().roomId)!.sessions;
        expect(sessions.find((candidate) => candidate.sessionId === 'se_one')!.lastReadSeq).toBe(12);
        expect(sessions.find((candidate) => candidate.sessionId === 'se_two')!.lastReadSeq).toBe(0);
    });

    test('test_rejoining_with_one_session_id_replaces_rather_than_duplicates', () => {
        store.upsertRoom(room());
        store.addSession(room().roomId, session({lastReadSeq: 4}));
        store.addSession(room().roomId, session({lastReadSeq: 0}));
        expect(store.room(room().roomId)!.sessions).toHaveLength(1);
    });

    test('test_forgetting_a_room_removes_its_credentials_too', () => {
        store.upsertRoom(room());
        store.putCredential(room().roomId, 'controller', 'plc_token');
        store.upsertRoom(room({roomId: 'rm_BBBBBBBBBBBBBBBBBBBBBBBBBB', name: 'keep'}));
        store.putCredential('rm_BBBBBBBBBBBBBBBBBBBBBBBBBB', 'controller', 'plc_keep');

        store.forgetRoom(room().roomId);
        expect(store.rooms()).toHaveLength(1);
        expect(store.credential(room().roomId, 'controller')).toBeUndefined();
        expect(store.credential('rm_BBBBBBBBBBBBBBBBBBBBBBBBBB', 'controller')).toBe('plc_keep');
    });

    test('test_a_corrupt_registry_reads_as_empty_rather_than_throwing', () => {
        store.upsertRoom(room());
        rmSync(join(directory, 'rooms.json'));
        expect(store.rooms()).toEqual([]);
    });
});

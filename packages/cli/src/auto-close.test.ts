import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';
import {applyAutoCloseToRooms, describeAutoClose, formatAutoClose, parseAutoClose, summarizeBulk} from './auto-close.js';

let directory: string;
let server: RunningServer;
let store: LocalStore;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-auto-close-'));
    server = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    store = new LocalStore(join(directory, 'client'));
});

afterEach(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

/** Saves a room the way `create` does, with or without this device holding owner access. */
async function saveRoom(name: string, owned: boolean, serverUrl = server.url): Promise<string> {
    const client = new PairLobbyClient(server.url);
    const sessionId = newId('session');
    const created = await client.createRoom(name, {displayName: 'owner', kind: 'human', sessionId});
    store.upsertRoom({roomId: created.roomId, name, serverUrl, createdAt: created.room.createdAt, expiresAt: null, controls: owned, sessions: []});
    if (owned) {
        store.putCredential(created.roomId, 'controller', created.controllerCredential);
    }
    store.putCredential(created.roomId, sessionId, created.participantCredential);
    store.addSession(created.roomId, {participantId: created.participantId, sessionId, displayName: 'owner', kind: 'human', role: 'member', joinedAt: created.room.createdAt, lastReadSeq: 0, cwd: directory});
    return created.roomId;
}

test('test_specs_round_trip_and_read_as_sentences', () => {
    expect(parseAutoClose('idle:2h')).toEqual({mode: 'inactivity', afterMs: 7_200_000});
    expect(parseAutoClose('AGE:7d')).toEqual({mode: 'age', afterMs: 604_800_000});
    expect(parseAutoClose('agents-and-guests-left')).toEqual({mode: 'agents_and_guests_left'});
    expect(parseAutoClose('never')).toEqual({mode: 'off'});
    expect(formatAutoClose(parseAutoClose('idle:90m'))).toBe('idle:90m');
    expect(formatAutoClose(parseAutoClose('age:48h'))).toBe('age:2d');
    expect(() => parseAutoClose('idle:10s')).toThrow('one minute');
    expect(() => parseAutoClose('sometimes')).toThrow('auto-close takes');
    expect(describeAutoClose(undefined)).toBe('Off');
    expect(describeAutoClose({mode: 'agents_and_guests_left'})).toBe('When all agents and guests have left');
});

test('test_bulk_apply_reports_every_room_instead_of_a_total', async () => {
    const owned = await saveRoom('owned', true);
    const second = await saveRoom('second', true);
    await saveRoom('not mine', false);
    await saveRoom('gone', true, 'http://127.0.0.1:9');
    await new PairLobbyClient(server.url).setAutoClose(second, store.credential(second, 'controller')!, {mode: 'age', afterMs: 86_400_000});
    const outcomes = await applyAutoCloseToRooms(store, {mode: 'age', afterMs: 86_400_000});
    const byName = Object.fromEntries(outcomes.map((outcome) => [outcome.name, outcome.result]));
    expect(byName).toEqual({owned: 'updated', second: 'unchanged', 'not mine': 'skipped', gone: 'unreachable'});
    expect(summarizeBulk(outcomes)).toBe('1 updated, 1 unchanged, 1 skipped, 1 unreachable');
    const snapshot = await new PairLobbyClient(server.url).snapshot(owned, store.credential(owned, 'controller')!);
    expect(snapshot.policy.autoClose).toEqual({mode: 'age', afterMs: 86_400_000});
});

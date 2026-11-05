//! `pairlobby delete` on a room this device owns: deleted for everyone when no one else is in it,
//! only taken off this device's rooms while someone, person or agent, still is. Both follow settings.

import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {DEFAULT_SETTINGS, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import type {ParticipantView} from '@pairlobby/protocol';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {namesOf} from '../src/room-list.js';

type CreatedJson = {roomId: string; sessionId: string; invite: {code: string}};
type DeletedJson = {roomId: string; deleted: boolean; left?: boolean; others?: number};

const execute = promisify(execFile);
let directory: string;
let server: RunningServer;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-delete-occupied-'));
    server = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
});

afterEach(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(args: string[]): Promise<string> {
    const environment: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1'};
    for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_ROOM', 'PAIRLOBBY_SESSION']) {
        delete environment[variable];
    }
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: environment, timeout: 15_000});
    return stdout;
}

async function create(name: string): Promise<CreatedJson> {
    return JSON.parse(await cli(['create', '--name', name, '--as', 'owner', '--human', '--server', server.url, '--json'])) as CreatedJson;
}

async function remove(room: CreatedJson): Promise<DeletedJson> {
    return JSON.parse(await cli(['delete', room.roomId, '--json'])) as DeletedJson;
}

test('test_names_read_as_a_sentence', () => {
    const people = ['Ana', 'Bo', 'Cy', 'Di', 'Ed'].map((displayName) => ({displayName}) as ParticipantView);
    expect(namesOf(people.slice(0, 1))).toBe('Ana');
    expect(namesOf(people.slice(0, 2))).toBe('Ana and Bo');
    expect(namesOf(people.slice(0, 3))).toBe('Ana, Bo and Cy');
    expect(namesOf(people)).toBe('Ana, Bo, Cy and 2 others');
    expect(DEFAULT_SETTINGS).toMatchObject({leaveOccupiedRooms: true, deleteEmptyRooms: true});
});

test('test_delete_leaves_a_room_others_are_in_and_deletes_one_no_one_else_is_in', async () => {
    const client = new PairLobbyClient(server.url);
    try {
        const shared = await create('shared');
        const agent = await client.redeemInvite(shared.invite.code, {displayName: 'helper', kind: 'agent'});
        expect(await remove(shared)).toEqual({roomId: shared.roomId, deleted: false, left: true, others: 1});
        expect((await client.snapshot(shared.roomId, agent.participantCredential)).lifecycle).toBe('open');
        expect(await cli(['list', '--json'])).not.toContain(shared.roomId);

        const alone = await create('alone');
        expect(await remove(alone)).toEqual({roomId: alone.roomId, deleted: true});

        await cli(['settings', 'leave-occupied-rooms', 'off']);
        const crowded = await create('crowded');
        const ana = await client.redeemInvite(crowded.invite.code, {displayName: 'Ana', kind: 'human'});
        expect(await remove(crowded)).toEqual({roomId: crowded.roomId, deleted: true});
        await expect(client.snapshot(crowded.roomId, ana.participantCredential)).rejects.toThrow();

        await cli(['settings', 'delete-empty-rooms', 'off']);
        const kept = await create('kept');
        expect(await remove(kept)).toEqual({roomId: kept.roomId, deleted: false, left: true, others: 0});
        expect(await cli(['list', '--json'])).not.toContain(kept.roomId);
    } finally {
        client.closeLive();
    }
}, 60_000);

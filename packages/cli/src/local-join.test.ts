import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {afterEach, beforeEach, expect, test} from 'vitest';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

type CreatedJson = {roomId: string; localJoin?: boolean};

type JoinedJson = {roomId: string; role: string; serverUrl: string};

const execute = promisify(execFile);
let directory: string;
let relay: RunningServer;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-local-join-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(device: string, args: string[]): Promise<string> {
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: {...process.env, PAIRLOBBY_DATA_DIR: join(directory, device), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_SERVER: ''}, timeout: 15_000});
    return stdout;
}

test('test_a_room_created_open_local_is_joined_by_name_from_another_device', async () => {
    const created = JSON.parse(await cli('mac', ['create', '--name', 'tower test', '--as', 'hugo', '--human', '--open-local', '--server', relay.url, '--json'])) as CreatedJson;
    expect(created.localJoin).toBe(true);
    const joined = JSON.parse(await cli('tower', ['join', 'tower test', '--server', relay.url, '--as', 'tower', '--human', '--json'])) as JoinedJson;
    expect(joined).toMatchObject({roomId: created.roomId, role: 'member', serverUrl: relay.url});
});

test('test_open_local_can_be_turned_off_and_then_refuses_joins_by_name', async () => {
    const created = JSON.parse(await cli('mac', ['create', '--name', 'closing', '--as', 'hugo', '--human', '--server', relay.url, '--json'])) as CreatedJson;
    expect(created.localJoin).toBeUndefined();
    expect(JSON.parse(await cli('mac', ['open-local', created.roomId, '--json']))).toEqual({roomId: created.roomId, localJoin: true});
    expect(JSON.parse(await cli('mac', ['open-local', created.roomId, '--off', '--json']))).toEqual({roomId: created.roomId, localJoin: false});
    await expect(cli('tower', ['join', 'local', 'closing', '--server', relay.url, '--as', 'tower', '--human', '--json'])).rejects.toThrow(/no room named "closing"/);
});

test('test_open_local_is_refused_for_online_rooms', async () => {
    await expect(cli('mac', ['create', 'online', '--name', 'x', '--open-local'])).rejects.toThrow(/--open-local applies to rooms on your own relay/);
});

test('test_a_relay_lists_every_room_open_to_the_local_network_and_the_room_list_joins_one_by_id', async () => {
    const open = JSON.parse(await cli('mac', ['create', '--name', 'open one', '--as', 'hugo', '--human', '--open-local', '--server', relay.url, '--json'])) as CreatedJson;
    await cli('mac', ['create', '--name', 'invite only', '--as', 'hugo', '--human', '--server', relay.url, '--json']);
    const {PairLobbyClient} = await import('@pairlobby/client');
    const listed = await new PairLobbyClient(relay.url).localRooms();
    expect(listed?.map((room) => [room.roomId, room.name, room.participantCount])).toEqual([[open.roomId, 'open one', 1]]);
    const {listLocalRooms} = await import('./relay-discovery.js');
    const lookup = (url: string, name?: string) => new PairLobbyClient(url).localRooms(name);
    const deps = {local: relay.url, lan: async () => [], tailnet: async () => [], lookup};
    expect((await listLocalRooms(new Set(), deps)).map((match) => match.room.roomId)).toEqual([open.roomId]);
    expect(await listLocalRooms(new Set([open.roomId]), deps)).toEqual([]);
    // What the room list runs for a selected network room.
    const joined = JSON.parse(await cli('tower', ['join', 'local', open.roomId, '--server', relay.url, '--human', '--json'])) as JoinedJson;
    expect(joined).toMatchObject({roomId: open.roomId, role: 'member', serverUrl: relay.url});
    const saved = JSON.parse(await cli('tower', ['list', '--json'])) as {rooms: {roomId: string}[]};
    expect(saved.rooms.map((room) => room.roomId)).toEqual([open.roomId]);
});

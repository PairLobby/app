import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import type {RoomSnapshot} from '@pairlobby/protocol';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {publicRoomHold} from '../src/public-room.js';
import type {PublicRoomDeps} from '../src/public-room.js';

type Joined = {roomId: string; sessionId: string; receiver: unknown; publicRoom?: {reason: string; command: string}};

const execute = promisify(execFile);
let directory: string;
let relay: RunningServer;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-public-room-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

function room(type: 'public' | 'private'): RoomSnapshot {
    return {name: 'town square', policy: {type, joinPolicy: 'invite_only', localJoin: type === 'public'}} as RoomSnapshot;
}

function deps(agent: boolean, interactive: boolean, answer = ''): PublicRoomDeps {
    return {agent, interactive, ask: async () => answer};
}

test('test_a_person_decides_whether_an_agent_listens_in_a_public_room_and_an_agent_never_does', async () => {
    const check = {roomId: 'rm_1', sessionId: 'se_1', yes: false, json: false};
    expect(await publicRoomHold({...check, room: room('private')}, deps(true, false))).toBeNull();
    const byAgent = await publicRoomHold({...check, yes: true, room: room('public')}, deps(true, false));
    expect(byAgent?.reason).toContain('An agent does not decide this for itself');
    expect(byAgent?.command).toBe('pairlobby receiver start --room rm_1 --session se_1 --yes');
    expect(await publicRoomHold({...check, yes: true, room: room('public')}, deps(false, false))).toBeNull();
    expect((await publicRoomHold({...check, room: room('public')}, deps(false, false)))?.reason).toContain('town square is a public room: anyone the relay admits joins it as a member');
    expect(await publicRoomHold({...check, room: room('public')}, deps(false, true, 'y'))).toBeNull();
    expect((await publicRoomHold({...check, room: room('public')}, deps(false, true, 'n')))?.reason).toBe('The receiver was not started.');
});

test('test_an_agent_joining_a_public_room_by_itself_is_joined_but_its_receiver_waits_for_its_user', async () => {
    const owner = await new PairLobbyClient(relay.url).createRoom('town square', {displayName: 'hugo', kind: 'human'}, undefined, undefined, 'public');
    const environment: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_SERVER: '', CODEX_THREAD_ID: 'thread-1'};
    const cli = async (args: string[]) => (await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: environment, timeout: 15_000})).stdout;
    const joined = JSON.parse(await cli(['join', owner.invite.code, '--server', relay.url, '--runtime', 'claude', '--as', 'helper', '--workdir', directory, '--json'])) as Joined;
    expect(joined.receiver).toBeNull();
    expect(joined.publicRoom).toMatchObject({reason: expect.stringContaining('An agent does not decide this for itself'), command: `pairlobby receiver start --room ${joined.roomId} --session ${joined.sessionId} --yes`});
    await expect(cli(['receiver', 'start', '--room', joined.roomId, '--session', joined.sessionId, '--yes'])).rejects.toThrow('An agent does not decide this for itself');
}, 60_000);

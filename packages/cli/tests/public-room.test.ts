import {execFile} from 'node:child_process';
import {chmodSync, copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import type {RoomSnapshot} from '@pairlobby/protocol';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {publicRoomNotice} from '../src/public-room.js';

type Joined = {roomId: string; sessionId: string; receiver: unknown; publicRoomWarning?: string};

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

test('test_the_warning_names_a_public_room_and_nothing_else', () => {
    expect(publicRoomNotice(room('private'))).toBeNull();
    expect(publicRoomNotice(room('public'))).toContain('town square is a public room: anyone the relay admits joins it as a member');
});

test('test_an_agent_joining_a_public_room_by_itself_listens_at_once_and_is_told_what_that_means', async () => {
    const executable = join(directory, 'claude');
    copyFileSync(resolve('scripts/fixtures/claude-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const owner = await new PairLobbyClient(relay.url).createRoom('town square', {displayName: 'hugo', kind: 'human'}, undefined, undefined, 'public');
    const environment: NodeJS.ProcessEnv = {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_SERVER: '', CODEX_THREAD_ID: 'thread-1'};
    const cli = async (args: string[]) => (await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: environment, timeout: 15_000})).stdout;
    const joined = JSON.parse(await cli(['join', owner.invite.code, '--server', relay.url, '--runtime', 'claude', '--as', 'helper', '--workdir', directory, '--json'])) as Joined;
    try {
        expect(joined.receiver).toMatchObject({state: expect.stringMatching(/^(available|waiting|starting)$/)});
        expect(joined.publicRoomWarning).toContain('town square is a public room');
    } finally {
        await cli(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);
    }
}, 60_000);

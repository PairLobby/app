import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {afterEach, beforeEach, expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

import {accountRows, ACCOUNT_STATE} from '../src/room-list.js';
import {startFakeAccountService} from './fake-account-service.js';
import type {FakeAccountService} from './fake-account-service.js';

type CliResult = {stdout: string; stderr: string};
type ListJson = {count: number; rooms: {roomId: string}[]; account: {roomId: string; name: string}[] | null; accountError: string | null};

const execute = promisify(execFile);
const TOKEN = 'test-account-token';
let directory: string;
let relay: RunningServer;
let service: FakeAccountService;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-account-list-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    service = await startFakeAccountService(relay, TOKEN);
});

afterEach(async () => {
    await service.close();
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(args: string[], token = TOKEN): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_NO_NETWORK_SEARCH: '1', PAIRLOBBY_ONLINE_ORIGIN: service.origin, PAIRLOBBY_SERVER: relay.url};
    for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_SESSION', 'PAIRLOBBY_ROOM', 'PAIRLOBBY_ACCOUNT_TOKEN']) {
        delete env[variable];
    }
    if (token) {
        env['PAIRLOBBY_ACCOUNT_TOKEN'] = token;
    }
    return execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env, timeout: 15_000});
}

test('test_the_room_list_includes_account_rooms_this_device_has_not_joined', async () => {
    const owner = await new PairLobbyClient(relay.url).createRoom('Made on another computer', {displayName: 'maria', kind: 'human'});
    service.accepted.set(owner.roomId, {name: 'Made on another computer', controllerCredential: owner.controllerCredential});

    const listed = JSON.parse((await cli(['list', '--json'])).stdout) as ListJson;
    expect(listed.count).toBe(0);
    expect(listed.account?.map((room) => [room.roomId, room.name])).toEqual([[owner.roomId, 'Made on another computer']]);
    const plain = (await cli(['list'])).stdout;
    expect(plain).toContain('1 more on your account, not joined from this device');
    expect(plain).toContain(`pairlobby join online ${owner.roomId}`);

    // Once joined here it is an ordinary saved room, listed once.
    await cli(['join', 'online', owner.roomId, '--human', '--as', 'hugo', '--json']);
    const after = JSON.parse((await cli(['list', '--json'])).stdout) as ListJson;
    expect(after.rooms.map((room) => room.roomId)).toEqual([owner.roomId]);
    expect(after.account).toEqual([]);
});

test('test_a_device_that_is_not_logged_in_lists_only_its_own_rooms', async () => {
    const listed = JSON.parse((await cli(['list', '--json'], '')).stdout) as ListJson;
    expect(listed).toMatchObject({count: 0, account: [], accountError: null});
    expect(service.calls.some((call) => call.request.includes('/api/online/rooms'))).toBe(false);
});

test('test_account_rows_mark_rooms_to_join_and_their_lifecycle', () => {
    const room = {roomId: 'rm_A', name: 'design', createdAt: 0, expiresAt: null, lifecycle: 'open', private: true, owner: true, participants: [{displayName: 'hugo', kind: 'human'}, {displayName: 'codex', kind: 'agent'}], latestSeq: 3, server: 'https://pairlobby.com/relay/ws/team'};
    const [open] = accountRows([room]);
    expect(open!.values).toMatchObject({state: ACCOUNT_STATE, type: 'private', people: '1', agents: '1', expires: 'Never'});
    expect(accountRows([{...room, lifecycle: 'closed'}])[0]!.values['state']).toBe(`closed, ${ACCOUNT_STATE}`);
});

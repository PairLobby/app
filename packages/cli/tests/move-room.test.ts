import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {afterEach, beforeEach, expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {SqliteRoomStore, startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

import {startFakeAccountService} from './fake-account-service.js';
import type {FakeAccountService} from './fake-account-service.js';

type CliResult = {stdout: string; stderr: string};

const execute = promisify(execFile);
const TOKEN = 'test-account-token';
let directory: string;
let device: RunningServer;
let hosted: RunningServer;
let service: FakeAccountService;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-move-room-'));
    device = await startServer({port: 0, dataFile: join(directory, 'device.sqlite')});
    hosted = await startServer({port: 0, dataFile: join(directory, 'hosted.sqlite')});
    service = await startFakeAccountService(hosted, TOKEN);
});

afterEach(async () => {
    await service.close();
    await device.close();
    await hosted.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(args: string[]): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'cli'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_NO_NETWORK_SEARCH: '1', PAIRLOBBY_ONLINE_ORIGIN: service.origin, PAIRLOBBY_ACCOUNT_TOKEN: TOKEN, PAIRLOBBY_SERVER: device.url};
    for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_SESSION', 'PAIRLOBBY_ROOM']) {
        delete env[variable];
    }
    return execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env, timeout: 30_000});
}

/** Plays the account service's side: the copy lands in the hosted relay's database, which then serves it. */
function acceptImports(): void {
    service.importInto = async (records) => {
        await hosted.close();
        const store = new SqliteRoomStore(join(directory, 'hosted.sqlite'));
        try {
            store.transferIn(records);
        } finally {
            store.close();
        }
        hosted = await startServer({port: 0, dataFile: join(directory, 'hosted.sqlite')});
        service.relayUrl = hosted.url;
    };
}

test('test_a_local_room_moves_online_and_this_device_follows_it', async () => {
    acceptImports();
    const created = JSON.parse((await cli(['create', '--name', 'kv-cache-debugger', '--human', '--as', 'ana', '--json'])).stdout) as {roomId: string};
    await cli(['send', 'before the move', '--room', created.roomId]);

    const moved = JSON.parse((await cli(['move', 'kv-cache-debugger', 'online', '--yes', '--json'])).stdout) as {roomId: string; serverUrl: string; events: number};
    expect(moved).toMatchObject({roomId: created.roomId, serverUrl: service.server});
    expect(moved.events).toBeGreaterThan(1);

    const store = new LocalStore(join(directory, 'cli'));
    expect(store.room(created.roomId)?.serverUrl).toBe(service.server);
    const left = await new PairLobbyClient(device.url).snapshot(created.roomId, store.credential(created.roomId, 'controller')!);
    expect(left).toMatchObject({lifecycle: 'closed', closeReason: 'moved', movedTo: {serverUrl: service.server, roomId: created.roomId}});

    // The same saved session now talks to the online copy, history included.
    await cli(['send', 'after the move', '--room', created.roomId]);
    const read = JSON.parse((await cli(['read', '--room', created.roomId, '--all', '--json'])).stdout) as {events: {type: string; payload: {text?: string}}[]};
    expect(read.events.filter((event) => event.type === 'message').map((event) => event.payload.text)).toEqual(['before the move', 'after the move']);
});

test('test_a_room_the_account_cannot_take_stays_open_here', async () => {
    const created = JSON.parse((await cli(['create', '--name', 'too-big', '--human', '--as', 'ana', '--json'])).stdout) as {roomId: string};
    await expect(cli(['move', 'too-big', 'online', '--yes', '--json'])).rejects.toThrow(/your account has 0.0 MB free/);
    const store = new LocalStore(join(directory, 'cli'));
    expect(store.room(created.roomId)?.serverUrl).toBe(device.url);
    await cli(['send', 'still here', '--room', created.roomId]);
    expect((await new PairLobbyClient(device.url).snapshot(created.roomId, store.credential(created.roomId, 'controller')!)).lifecycle).toBe('open');
});

test('the CLI counts retained-file transfer records and preserves their original expiry', async () => {
    acceptImports();
    const created = JSON.parse((await cli(['create', '--name', 'temporary-move', '--human', '--as', 'ana', '--json'])).stdout) as {roomId: string};
    const path = join(directory, 'temporary.txt');
    writeFileSync(path, 'temporary transfer');
    await cli(['send', '--file', path, '--file-retention', '1h', '--room', created.roomId]);
    const local = new LocalStore(join(directory, 'cli'));
    const credential = local.credential(created.roomId, local.room(created.roomId)!.sessions[0]!.sessionId)!;
    const original = (await new PairLobbyClient(device.url).files(created.roomId, credential))[0]!;
    const moved = JSON.parse((await cli(['move', 'temporary-move', 'online', '--yes', '--json'])).stdout) as {files: number; serverUrl: string};
    expect(moved.files).toBe(1);
    expect((await new PairLobbyClient(moved.serverUrl).files(created.roomId, credential))[0]!.retention).toEqual(original.retention);
    expect(await new PairLobbyClient(device.url).files(created.roomId, credential)).toEqual([]);
});

test('test_another_device_follows_the_room_when_it_lists_its_rooms', async () => {
    acceptImports();
    const created = JSON.parse((await cli(['create', '--name', 'shared-work', '--human', '--as', 'ana', '--json'])).stdout) as {roomId: string};
    const other = new LocalStore(join(directory, 'other'));
    const invite = await new PairLobbyClient(device.url).mintInvite(created.roomId, new LocalStore(join(directory, 'cli')).credential(created.roomId, 'controller')!, 'member');
    const joined = await new PairLobbyClient(device.url).redeemInvite(invite.code, {displayName: 'bo', kind: 'human'});
    other.upsertRoom({roomId: created.roomId, name: 'shared-work', serverUrl: device.url, createdAt: Date.now(), expiresAt: null, controls: false, sessions: [{sessionId: 'se_OTHER0000000000000000000000', participantId: joined.participantId, displayName: 'bo', kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory}]});
    other.putCredential(created.roomId, 'se_OTHER0000000000000000000000', joined.participantCredential);

    await cli(['move', 'shared-work', 'online', '--yes', '--json']);
    const env: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'other'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_NO_NETWORK_SEARCH: '1', PAIRLOBBY_ONLINE_ORIGIN: service.origin, PAIRLOBBY_ACCOUNT_TOKEN: TOKEN};
    const listed = JSON.parse((await execute(process.execPath, [resolve('packages/cli/dist/main.js'), 'list', '--json'], {env, timeout: 30_000})).stdout) as {rooms: {roomId: string; serverUrl: string; live: {lifecycle: string} | null}[]};
    expect(listed.rooms).toMatchObject([{roomId: created.roomId, serverUrl: service.server, live: {lifecycle: 'open'}}]);
    expect(new LocalStore(join(directory, 'other')).room(created.roomId)?.serverUrl).toBe(service.server);
});

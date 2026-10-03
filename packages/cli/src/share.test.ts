import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {networkInterfaces, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {joinCommand, localOnlyNote, parseJoinLink, shareTarget} from './share.js';

type CreatedJson = {roomId: string; invite: {code: string}; shareServerUrl: string | null; joinCommand: string};

type JoinedJson = {roomId: string; serverUrl: string; participants: {displayName: string}[]};

const execute = promisify(execFile);
let directory: string;
let servers: RunningServer[];

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-share-'));
    servers = [];
});

afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    rmSync(directory, {recursive: true, force: true});
});

async function serve(host: string, publicUrl?: string): Promise<RunningServer> {
    const server = await startServer({host, port: 0, dataFile: join(directory, `${servers.length}.sqlite`), ...(publicUrl ? {publicUrl} : {})});
    servers.push(server);
    return server;
}

function networkAddresses(): string[] {
    return Object.values(networkInterfaces()).flatMap((addresses) => (addresses ?? []).filter((address) => address.family === 'IPv4' && !address.internal).map((address) => address.address));
}

async function cli(device: string, args: string[]): Promise<string> {
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: {...process.env, PAIRLOBBY_DATA_DIR: join(directory, device), PAIRLOBBY_SERVER: ''}, timeout: 15_000});
    return stdout;
}

test('test_parse_join_link_reads_server_and_code', () => {
    expect(parseJoinLink('http://10.0.0.5:8790#K7MP-4QWX')).toEqual({serverUrl: 'http://10.0.0.5:8790', code: 'K7MP-4QWX'});
    expect(parseJoinLink('https://laptop.tailnet.example/#K7MP-4QWX')).toEqual({serverUrl: 'https://laptop.tailnet.example', code: 'K7MP-4QWX'});
    expect(parseJoinLink('K7MP-4QWX')).toBeNull();
    expect(() => parseJoinLink('http://10.0.0.5:8790')).toThrow(/invite code after #/);
});

test('test_loopback_only_server_is_reported_as_local_only', async () => {
    const server = await serve('127.0.0.1');
    expect(await shareTarget(server.url)).toEqual({serverUrl: server.url, localOnly: true});
    expect(localOnlyNote({serverUrl: server.url, localOnly: true})).toMatch(/network-sharing/);
    expect((await joinCommand(server.url, 'K7MP-4QWX')).command).toBe(`pairlobby join K7MP-4QWX --server ${server.url}`);
});

test('test_loopback_relay_without_server_info_is_not_told_to_use_lan', async () => {
    const relay = createServer((_request, response) => {
        response.writeHead(404, {'content-type': 'application/json'});
        response.end(JSON.stringify({error: {code: 'invalid_request', message: 'unknown path'}}));
    });
    await new Promise<void>((done) => relay.listen(0, '127.0.0.1', done));
    try {
        const url = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
        const target = await shareTarget(url);
        expect(target).toEqual({serverUrl: url, localOnly: true, otherRelay: true});
        expect(localOnlyNote(target)).not.toMatch(/network-sharing/);
    } finally {
        await new Promise((done) => relay.close(done));
    }
});

test('test_public_url_replaces_loopback_in_join_command', async () => {
    const server = await serve('127.0.0.1', 'https://laptop.tailnet.example');
    const share = await joinCommand(server.url, 'K7MP-4QWX');
    expect(share.target).toEqual({serverUrl: 'https://laptop.tailnet.example', localOnly: false});
    expect(share.command).toBe('pairlobby join K7MP-4QWX --server https://laptop.tailnet.example');
});

test('test_non_loopback_and_hosted_rooms_keep_their_address', async () => {
    expect(await shareTarget('http://10.0.0.5:8790')).toEqual({serverUrl: 'http://10.0.0.5:8790', localOnly: false});
    const hosted = 'https://pairlobby.com/relay/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000';
    expect((await joinCommand(hosted, 'ABCD-EFGH-JKMN')).command).toBe('pairlobby join online ABCD-EFGH-JKMN');
});

test.skipIf(networkAddresses().length === 0)('test_a_second_device_joins_through_the_shared_network_address', async () => {
    const server = await serve('0.0.0.0');
    const created = JSON.parse(await cli('device-a', ['create', '--name', 'lan-room', '--as', 'alice', '--human', '--server', server.url, '--json'])) as CreatedJson;
    expect(created.shareServerUrl).toBe(server.shareUrls[0]);
    expect(created.joinCommand).toBe(`pairlobby join ${created.invite.code} --server ${server.shareUrls[0]}`);

    const joined = JSON.parse(await cli('device-b', ['join', `${created.shareServerUrl}#${created.invite.code}`, '--as', 'bob', '--human', '--json'])) as JoinedJson;
    expect(joined.roomId).toBe(created.roomId);
    expect(joined.serverUrl).toBe(server.shareUrls[0]);
    expect(joined.participants.map((participant) => participant.displayName).sort()).toEqual(['alice', 'bob']);
});

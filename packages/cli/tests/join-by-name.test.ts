//! Joining by name reaches the saved endpoint's relay too, with its login, so a relay behind a
//! proxy that knows people by their personal token works like one on the local network.

import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {PairLobbyClient} from '@pairlobby/client';
import {issueMemberToken, startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {findLocalRoom, listLocalRooms} from '../src/relay-discovery.js';
import {relayLocalRooms} from '../src/relay-probe.js';

const execute = promisify(execFile);
let directory: string;
let relay: RunningServer;
let token: string;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-join-by-name-cli-'));
    const maria = await issueMemberToken('maria');
    token = maria.token;
    const members = join(directory, 'members.jsonl');
    writeFileSync(members, `${JSON.stringify(maria.line)}\n`);
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite'), trustedProxyHeader: 'x-forwarded-for', members: {file: members}, discovery: {loginMode: 'token', name: 'Example Corp PairLobby'}});
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
    const environment: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_SERVER: '', ...extra};
    // This test may run inside an agent, whose variables would make the CLI refuse setup.
    for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_ACCOUNT_TOKEN', 'PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', 'PAIRLOBBY_ROOM', 'PAIRLOBBY_SESSION']) {
        if (!(variable in extra)) {
            delete environment[variable];
        }
    }
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: environment, timeout: 15_000});
    return stdout;
}

test('test_the_saved_relay_is_asked_with_its_login_alongside_the_network', async () => {
    const room = await new PairLobbyClient(relay.url, token).createRoom('town square', {displayName: 'maria', kind: 'human'}, undefined, undefined, 'public');
    const unreachable = 'http://127.0.0.1:1';
    const deps = {local: unreachable, lan: async () => [], tailnet: async () => [], saved: [{url: relay.url, label: 'team'}], lookup: (url: string, name?: string) => relayLocalRooms(url, name, undefined, url === relay.url ? token : undefined)};
    expect(await findLocalRoom('Town Square', deps)).toMatchObject({url: relay.url, label: 'team', room: {roomId: room.roomId, type: 'public'}});
    // Without the login the relay behind its proxy lists nothing, and the room is not found.
    await expect(findLocalRoom('town square', {...deps, lookup: (url: string, name?: string) => relayLocalRooms(url, name)})).rejects.toThrow();
});

test('test_a_hosted_account_relay_is_asked_once_the_service_names_it', async () => {
    const room = await new PairLobbyClient(relay.url, token).createRoom('office hours', {displayName: 'maria', kind: 'human'}, undefined, undefined, 'protected');
    const deps = {local: 'http://127.0.0.1:1', lan: async () => [], tailnet: async () => [], account: async () => [{url: relay.url, label: 'pairlobby.com'}], lookup: (url: string, name?: string) => relayLocalRooms(url, name, undefined, url === relay.url ? token : undefined)};
    expect(await findLocalRoom('Office Hours', deps)).toMatchObject({url: relay.url, label: 'pairlobby.com', room: {roomId: room.roomId, type: 'protected'}});
    expect((await listLocalRooms(new Set(), deps)).map((match) => match.room.roomId)).toEqual([room.roomId]);
    // Without a login there is no account relay to ask.
    await expect(findLocalRoom('office hours', {...deps, account: async () => []})).rejects.toThrow();
});

test('test_a_logged_in_device_joins_by_name_on_its_saved_relay', async () => {
    const owner = new PairLobbyClient(relay.url, token);
    const room = await owner.createRoom('lecture', {displayName: 'maria', kind: 'human'}, undefined, undefined, 'protected');
    await cli(['setup', relay.url, '--name', 'team', '--yes']);
    await cli(['login'], {PAIRLOBBY_ACCOUNT_TOKEN: token, PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN: relay.url});
    const joined = JSON.parse(await cli(['join', 'local', 'lecture', '--server', relay.url, '--as', 'student', '--human', '--json'])) as {roomId: string; role: string};
    expect(joined).toMatchObject({roomId: room.roomId, role: 'guest'});
    const student = (await owner.snapshot(room.roomId, room.participantCredential)).participants.find((person) => person.displayName === 'student');
    expect(student).toMatchObject({role: 'guest', member: 'maria'});
});

test('test_a_logged_in_owner_sets_a_default_and_a_room_visibility_and_is_told_who_no_longer_sees_it', async () => {
    await cli(['setup', relay.url, '--name', 'team', '--yes']);
    await cli(['login'], {PAIRLOBBY_ACCOUNT_TOKEN: token, PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN: relay.url});
    expect(JSON.parse(await cli(['visibility', '--default', '@zoe,@omar', '--server', relay.url, '--json']))).toEqual({visibility: {handles: ['zoe', 'omar']}});
    const created = JSON.parse(await cli(['create', '--name', 'plans', '--type', 'public', '--visible-to', 'everyone', '--server', relay.url, '--as', 'maria', '--human', '--json'])) as {roomId: string};
    expect(JSON.parse(await cli(['visibility', created.roomId, '--json']))).toEqual({roomId: created.roomId, owner: 'maria', visibility: 'everyone'});

    // A guest let in with the owner's code, without a login, is no one the relay can name.
    const owner = new PairLobbyClient(relay.url);
    const guest = await owner.redeemInvite((JSON.parse(await cli(['invite', created.roomId, '--json'])) as {code: string}).code, {displayName: 'guest', kind: 'human'});
    const narrowed = JSON.parse(await cli(['visibility', created.roomId, 'default', '--json'])) as {visibility: string; outside: {participantId: string; displayName: string}[]};
    expect(narrowed).toEqual({roomId: created.roomId, visibility: 'default', outside: [{participantId: guest.participantId, displayName: 'guest'}]});
    expect(JSON.parse(await cli(['visibility', created.roomId, '--json']))).toEqual({roomId: created.roomId, owner: 'maria', visibility: 'default', resolved: {handles: ['zoe', 'omar']}});
});

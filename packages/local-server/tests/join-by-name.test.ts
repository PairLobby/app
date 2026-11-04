//! Finding and joining rooms by name on a relay behind a proxy: by personal token on a relay
//! with members, or for everyone when the proxy is the access gate, and counted per caller.

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {PairLobbyClient} from '@pairlobby/client';
import {newCredential} from '@pairlobby/protocol';
import type {LocalRoom, RoomType} from '@pairlobby/protocol';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {issueMemberToken} from '../src/members.js';
import {startServer} from '../src/server.js';
import type {RunningServer} from '../src/server.js';

type Joined = {role?: string; error?: {code: string; message: string}};

let directory: string;
let relay: RunningServer | undefined;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-join-by-name-'));
});

afterEach(async () => {
    await relay?.close();
    relay = undefined;
    rmSync(directory, {recursive: true, force: true});
});

function lookup(name: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${relay!.url}/v1/rooms/local?name=${encodeURIComponent(name)}`, {headers});
}

async function joinByName(roomId: string, headers: Record<string, string> = {}): Promise<{status: number; body: Joined}> {
    const response = await fetch(`${relay!.url}/v1/rooms/${roomId}/local-join`, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify({displayName: 'colleague', kind: 'human', participantCredential: newCredential('participant')})});
    return {status: response.status, body: (await response.json()) as Joined};
}

test('test_on_a_relay_with_members_a_personal_token_finds_and_joins_public_and_protected_rooms', async () => {
    const damien = await issueMemberToken('damien');
    const maria = await issueMemberToken('maria');
    const members = join(directory, 'members.jsonl');
    writeFileSync(members, `${JSON.stringify(damien.line)}\n${JSON.stringify(maria.line)}\n`);
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite'), trustedProxyHeader: 'x-forwarded-for', members: {file: members}, discovery: {loginMode: 'token', name: 'Example Corp PairLobby'}});
    const owner = new PairLobbyClient(relay.url, damien.token);
    const create = (name: string, type: RoomType) => owner.createRoom(name, {displayName: 'damien', kind: 'human'}, undefined, undefined, type);
    const open = await create('town square', 'public');
    const lecture = await create('lecture', 'protected');
    await create('secret', 'private');
    expect((await owner.describe(true))?.features).toContain('local-join');

    // Behind a proxy the connection proves nothing, so without a token nobody finds anything.
    const anonymous = await lookup('town square');
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).toContain('needs your personal token: pairlobby login');

    const asMaria = {'x-pairlobby-account-token': maria.token};
    expect(((await (await lookup('Town Square', asMaria)).json()) as {rooms: LocalRoom[]}).rooms).toEqual([expect.objectContaining({roomId: open.roomId, type: 'public'})]);
    expect(((await (await lookup('lecture', asMaria)).json()) as {rooms: LocalRoom[]}).rooms).toEqual([expect.objectContaining({roomId: lecture.roomId, type: 'protected'})]);
    expect(((await (await lookup('secret', asMaria)).json()) as {rooms: LocalRoom[]}).rooms).toEqual([]);

    const joined = await joinByName(open.roomId, asMaria);
    expect(joined).toMatchObject({status: 200, body: {role: 'member'}});
    const snapshot = await owner.snapshot(open.roomId, open.participantCredential);
    expect(snapshot.participants.find((person) => person.displayName === 'colleague')?.member).toBe('maria');
    expect((await joinByName(lecture.roomId, asMaria)).body.role).toBe('guest');
    expect((await joinByName(open.roomId)).status).toBe(401);
});

test('test_behind_a_proxy_that_is_the_access_gate_joins_by_name_are_counted_per_forwarded_address', async () => {
    relay = await startServer({port: 0, dataFile: join(directory, 'gated.sqlite'), trustedProxyHeader: 'x-forwarded-for', proxyIsAccessGate: true, limits: {redeemPerMinutePerAddress: 1}});
    const room = await new PairLobbyClient(relay.url).createRoom('town square', {displayName: 'hugo', kind: 'human'}, undefined, undefined, 'public');
    expect((await joinByName(room.roomId, {'x-forwarded-for': '10.1.1.1'})).status).toBe(200);
    expect((await joinByName(room.roomId, {'x-forwarded-for': '10.1.1.1'})).body.error?.code).toBe('rate_limited');
    expect((await joinByName(room.roomId, {'x-forwarded-for': '10.2.2.2'})).status).toBe(200);
});

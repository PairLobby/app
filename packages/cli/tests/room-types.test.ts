import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {PairLobbyClient} from '@pairlobby/client';
import type {CreatedRoom} from '@pairlobby/client';
import {SqliteRoomStore, startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {newCredential, roomPermissions, roomType} from '@pairlobby/protocol';
import type {RoomType} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import {afterEach, beforeEach, expect, test} from 'vitest';

type TypeJson = {roomId: string; type: RoomType; typed?: boolean; membersMayInvite: boolean};

const execute = promisify(execFile);
let directory: string;
let relay: RunningServer;
let client: PairLobbyClient;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-room-types-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    client = new PairLobbyClient(relay.url);
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(args: string[]): Promise<string> {
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_SERVER: ''}, timeout: 15_000});
    return stdout;
}

function create(type?: RoomType): Promise<CreatedRoom> {
    return client.createRoom('typed', {displayName: 'owner', kind: 'human'}, undefined, undefined, type);
}

async function member(room: CreatedRoom, name: string): Promise<string> {
    const invite = await client.mintInvite(room.roomId, room.controllerCredential, 'member', false);
    return (await client.redeemInvite(invite.code, {displayName: name, kind: 'human'})).participantCredential;
}

test('test_a_room_without_a_type_reads_as_the_type_its_switches_amount_to', () => {
    expect(roomType({joinPolicy: 'invite_only'})).toBe('private');
    expect(roomType({joinPolicy: 'open_to_guests'})).toBe('protected');
    expect(roomType({joinPolicy: 'invite_only', localJoin: true})).toBe('public');
    expect(roomType({type: 'personal', joinPolicy: 'invite_only'})).toBe('personal');
    expect(roomPermissions(undefined)['invite']).toBe(true);
    expect(roomPermissions(undefined, 'public')['invite']).toBe(true);
    expect(roomPermissions(undefined, 'private')['invite']).toBe(false);
    expect(roomPermissions({invite: true}, 'protected')['invite']).toBe(true);
    expect(roomPermissions({invite: true}, 'personal')['invite']).toBe(false);
});

test('test_a_typed_room_sets_its_switches_and_keeps_them_until_its_type_changes', async () => {
    const room = await create('protected');
    expect(room.room.policy).toMatchObject({type: 'protected', joinPolicy: 'open_to_guests', localJoin: false});
    expect((await client.joinAsGuest(room.roomId, {displayName: 'reader', kind: 'human'})).role).toBe('guest');
    await expect(client.setJoinPolicy(room.roomId, room.controllerCredential, 'invite_only')).rejects.toThrow('this is a protected room; make it private instead');
    await expect(client.setLocalJoin(room.roomId, room.controllerCredential, true)).rejects.toThrow('this is a protected room; make it public instead');

    const changed = await client.setRoomType(room.roomId, room.controllerCredential, 'public');
    expect(changed.event).toMatchObject({type: 'room.type_changed', payload: {type: 'public', previous: 'protected'}});
    expect((await client.snapshot(room.roomId, room.participantCredential)).policy).toMatchObject({type: 'public', joinPolicy: 'invite_only', localJoin: true});
    await expect(client.setRoomType(room.roomId, room.controllerCredential, 'public')).rejects.toThrow('this room is already public');
    await expect(client.setRoomType(room.roomId, await member(room, 'maria'), 'private')).rejects.toMatchObject({code: 'unauthorized'});

    const untyped = await create();
    await client.setLocalJoin(untyped.roomId, untyped.controllerCredential, true);
    expect((await client.setRoomType(untyped.roomId, untyped.controllerCredential, 'private')).event).toMatchObject({payload: {type: 'private', previous: 'public'}});
});

test('test_members_invite_only_where_the_room_allows_it_and_never_in_a_personal_room', async () => {
    const untyped = await create();
    await expect(client.mintInvite(untyped.roomId, await member(untyped, 'maria'), 'member')).resolves.toMatchObject({code: expect.any(String)});
    const open = await create('public');
    await expect(client.mintInvite(open.roomId, await member(open, 'maria'), 'member')).resolves.toMatchObject({code: expect.any(String)});

    const room = await create('private');
    const maria = await member(room, 'maria');
    await expect(client.mintInvite(room.roomId, maria, 'member')).rejects.toThrow('this room does not let you create invites');
    await client.setRoomPermissions(room.roomId, room.controllerCredential, {invite: true});
    await expect(client.mintInvite(room.roomId, maria, 'member')).resolves.toMatchObject({code: expect.any(String)});
    await client.setRoomType(room.roomId, room.controllerCredential, 'personal');
    await expect(client.mintInvite(room.roomId, maria, 'member')).rejects.toThrow('this room does not let you create invites');
});

test('test_a_personal_room_admits_only_codes_from_its_owner', async () => {
    const room = await create('private');
    await client.setRoomPermissions(room.roomId, room.controllerCredential, {invite: true});
    const fromMember = await client.mintInvite(room.roomId, await member(room, 'maria'), 'member');
    const before = await client.mintInvite(room.roomId, room.controllerCredential, 'member');
    await client.setRoomType(room.roomId, room.controllerCredential, 'personal');
    await expect(client.redeemInvite(fromMember.code, {displayName: 'stranger', kind: 'human'})).rejects.toThrow('this is a personal room: only codes from its owner admit anyone');
    expect((await client.redeemInvite(before.code, {displayName: 'my agent', kind: 'agent'})).role).toBe('member');
    const after = await client.mintInvite(room.roomId, room.controllerCredential, 'member');
    expect((await client.redeemInvite(after.code, {displayName: 'my other agent', kind: 'agent'})).role).toBe('member');
});

test('test_an_agent_in_a_personal_room_cannot_be_shared', async () => {
    const store = new SqliteRoomStore(join(directory, 'personal.sqlite'));
    try {
        const service = new RoomService(store);
        const participantCredential = newCredential('participant');
        const created = await service.createRoom({name: 'mine', displayName: 'agent', kind: 'agent', controllerCredential: newCredential('controller'), participantCredential, type: 'personal'});
        await expect(service.listingSubject(created.roomId, participantCredential, 'damien')).rejects.toThrow('agents in a personal room cannot be shared');
        expect(await service.listable(created.roomId, created.participantId)).toBe(false);
    } finally {
        store.close();
    }
});

test('test_the_cli_creates_typed_rooms_and_shows_and_changes_their_type', async () => {
    const created = JSON.parse(await cli(['create', '--name', 'workshop', '--as', 'hugo', '--human', '--server', relay.url, '--json'])) as {roomId: string};
    expect(JSON.parse(await cli(['room', created.roomId, 'type', '--json']))).toEqual({roomId: created.roomId, type: 'private', typed: true, membersMayInvite: false});
    expect(JSON.parse(await cli(['room', created.roomId, 'invite-policy', 'members', '--json']))).toEqual({roomId: created.roomId, membersMayInvite: true});
    expect(JSON.parse(await cli(['room', created.roomId, 'type', 'protected', '--json']))).toEqual({roomId: created.roomId, type: 'protected', membersMayInvite: true});
    // `open-local` on a typed room changes its type, and `--off` makes it private again.
    await cli(['open-local', created.roomId, '--json']);
    expect(JSON.parse(await cli(['room', created.roomId, 'type', '--json']))).toMatchObject({type: 'public'});
    await cli(['open-local', created.roomId, '--off', '--json']);
    expect(JSON.parse(await cli(['room', created.roomId, 'type', '--json']))).toMatchObject({type: 'private'});
    expect(await cli(['room', created.roomId, 'type'])).toContain('workshop is private: only people with an invite code can join. Members may invite.');

    const personal = JSON.parse(await cli(['create', '--name', 'notes', '--as', 'hugo', '--human', '--type', 'personal', '--server', relay.url, '--json'])) as {roomId: string};
    expect(JSON.parse(await cli(['room', personal.roomId, 'type', '--json']))).toMatchObject({type: 'personal', membersMayInvite: false});
    await expect(cli(['room', personal.roomId, 'invite-policy', 'members'])).rejects.toThrow('members never invite in a personal room');
    await expect(cli(['create', '--name', 'bad', '--as', 'hugo', '--human', '--type', 'secret', '--server', relay.url])).rejects.toThrow('room type must be public, protected, private, personal');
});
